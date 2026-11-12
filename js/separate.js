// Tira a voz do cantor de uma música que o artista tem no celular, com a IA Spleeter (Deezer, código aberto).
// Roda no próprio aparelho, num "ajudante" (Worker) que é desligado no fim para devolver toda a memória.
// Nada é enviado para servidor. O modelo (~40 MB) é baixado uma vez e fica guardado no aparelho.
// Adaptado da separação leve do Studio Cover.
const MODEL_CACHE = 'video-cover-ia-v1';
const PARTS = ['vocals', 'accompaniment'].map((n) => new URL(`../assets/ai/spleeter-${n}.bin`, import.meta.url).href);
const TOTAL = 19681017 + 19681024;
const tick = () => new Promise((r) => setTimeout(r, 0));

async function fetchPart(url, onBytes) {
  let cache = null;
  try { cache = await caches.open(MODEL_CACHE); } catch { /* sem Cache Storage */ }
  const hit = cache && (await cache.match(url));
  if (hit) { const b = await hit.arrayBuffer(); onBytes(b.byteLength); return b; }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`modelo ${res.status}`);
  if (cache) {
    const put = cache.put(url, res.clone());
    const reader = res.body.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; onBytes(value.length); }
    try { await put; const again = await cache.match(url); if (again) return again.arrayBuffer(); } catch { /* sem espaço */ }
    return (await fetch(url)).arrayBuffer();
  }
  const reader = res.body.getReader();
  const chunks = []; let n = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); n += value.length; onBytes(value.length); }
  const out = new Uint8Array(n); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}

let ortP = null;
async function loadOrt() {
  if (ortP) return ortP;
  ortP = (async () => {
    const ort = await import('./vendor/ort/ort.wasm.min.js');
    ort.env.wasm.wasmPaths = {
      mjs: new URL('./vendor/ort/ort-wasm-simd-threaded.js', import.meta.url).href,
      wasm: new URL('./vendor/ort/ort-wasm-simd-threaded.wasm', import.meta.url).href,
    };
    ort.env.wasm.numThreads = 1;
    return ort;
  })();
  return ortP;
}

// Uma rede por vez (voz, depois acompanhamento): o pico de memória é o de uma rede só.
async function loadPart(ort, i, onBytes) {
  const buf = await fetchPart(PARTS[i], onBytes);
  return ort.InferenceSession.create(new Uint8Array(buf), { executionProviders: ['wasm'], graphOptimizationLevel: 'basic', enableCpuMemArena: false, enableMemPattern: false });
}

// Devolve só a voz (estéreo). A base é música − voz.
export async function separateVoice(channels, { onDownload = () => {}, onProgress = () => {} } = {}) {
  const ort = await loadOrt();
  const { fft, ifft, getHannWindow } = await import('./vendor/fft/fft.js');
  const N = 4096, H = 1024, BINS = 1024, FULL = N / 2 + 1, F = 512;
  const L = channels[0].length, P = N;
  const src = [channels[0], channels[1] || channels[0]];
  const Lp = L + 2 * P;
  const nf = Math.floor((Lp - N) / H) + 1;
  const win = getHannWindow(N);
  const frIn = new Float32Array(N), re = new Float32Array(N), im = new Float32Array(N), oRe = new Float32Array(N), oIm = new Float32Array(N);
  const chunks = Math.ceil(nf / F);
  let got = 0;
  const dl = (b) => { got += b; onDownload(Math.min(1, got / TOTAL)); };
  const frame = (c, fi) => {
    const st = fi * H - P;
    for (let i = 0; i < N; i++) { const t = st + i; frIn[i] = t >= 0 && t < L ? src[c][t] * win[i] : 0; }
    fft(re, im, frIn, N);
  };
  const feed = (k) => {
    const f0 = k * F, n = Math.min(F, nf - f0), x = new Float32Array(2 * F * BINS);
    for (let c = 0; c < 2; c++) for (let j = 0; j < n; j++) {
      frame(c, f0 + j);
      const xo = (c * F + j) * BINS;
      for (let b = 0; b < BINS; b++) x[xo + b] = Math.hypot(re[b], im[b]);
    }
    return new ort.Tensor('float32', x, [2, 1, F, BINS]);
  };
  // Passo 1: rede da voz (energia guardada comprimida em 16 bits)
  const Q = 1500, lo = -24;
  const V = new Uint16Array(2 * nf * BINS);
  let net = await loadPart(ort, 0, dl);
  for (let k = 0; k < chunks; k++) {
    const f0 = k * F, n = Math.min(F, nf - f0);
    const out = await net.run({ x: feed(k) });
    const v = out.y.data;
    for (let c = 0; c < 2; c++) for (let j = 0; j < n; j++) {
      const xo = (c * F + j) * BINS, vo = (c * nf + f0 + j) * BINS;
      for (let b = 0; b < BINS; b++) { const e = Math.log(v[xo + b] * v[xo + b] + 1e-11) - lo; V[vo + b] = e <= 0 ? 0 : Math.min(65535, Math.round(e * Q)); }
    }
    out.y.dispose?.();
    onProgress(0.5 * (k + 1) / chunks);
    await tick();
  }
  await net.release(); net = null;
  // Passo 2: rede do acompanhamento, máscara e volta para o som
  net = await loadPart(ort, 1, dl);
  const outS = [new Float32Array(Lp), new Float32Array(Lp)];
  for (let k = 0; k < chunks; k++) {
    const f0 = k * F, n = Math.min(F, nf - f0);
    const out = await net.run({ x: feed(k) });
    const a = out.y.data;
    for (let c = 0; c < 2; c++) for (let j = 0; j < n; j++) {
      frame(c, f0 + j);
      const xo = (c * F + j) * BINS, vo = (c * nf + f0 + j) * BINS;
      let hi = 0;
      for (let b = 0; b < BINS; b++) {
        const q = V[vo + b], vv = q ? Math.exp(q / Q + lo) : 0, aa = a[xo + b] * a[xo + b];
        const m = (vv + 5e-11) / (vv + aa + 1e-10);
        if (b >= 960) hi += m;
        re[b] *= m; im[b] *= m;
      }
      hi /= BINS - 960;
      for (let b = BINS; b < FULL; b++) { re[b] *= hi; im[b] *= hi; }
      for (let b = 1; b < N / 2; b++) { re[N - b] = re[b]; im[N - b] = -im[b]; }
      ifft(oRe, oIm, re, im, N);
      const st = (f0 + j) * H, o = outS[c];
      for (let i = 0; i < N; i++) o[st + i] += oRe[i] * win[i];
    }
    out.y.dispose?.();
    onProgress(0.5 + 0.5 * (k + 1) / chunks);
    await tick();
  }
  await net.release(); net = null;
  const voice = outS.map((o) => o.subarray(P, P + L));
  for (const v of voice) for (let i = 0; i < L; i++) v[i] /= 1.5; // soma das janelas de Hann (passo 1/4)
  return voice;
}

// No app: roda no ajudante e devolve a BASE (música sem a voz) como AudioBuffer
export function removeVoice(ctx, buffer, { onDownload = () => {}, onProgress = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const L = buffer.getChannelData(0).slice();
    const R = (buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : buffer.getChannelData(0)).slice();
    const w = new Worker(new URL('./sep-worker.js', import.meta.url), { type: 'module' });
    let last = Date.now();
    const guard = setInterval(() => { if (Date.now() - last > 120000) fail(new Error('a IA parou de responder')); }, 5000);
    const end = () => { clearInterval(guard); w.terminate(); };
    const fail = (e) => { end(); reject(e); };
    w.onmessage = (e) => {
      const m = e.data; last = Date.now();
      if (m.t === 'ready') w.postMessage({ L, R }, [L.buffer, R.buffer]);
      else if (m.t === 'd') onDownload(m.p);
      else if (m.t === 'p') onProgress(m.p);
      else if (m.t === 'err') fail(new Error(m.m));
      else if (m.t === 'done') {
        end();
        const src = [m.L, m.R], out = ctx.createBuffer(2, src[0].length, buffer.sampleRate);
        for (let c = 0; c < 2; c++) {
          const v = new Float32Array(m.voice[c].b, m.voice[c].o, m.voice[c].n), s = src[c], b = new Float32Array(s.length);
          for (let i = 0; i < s.length; i++) b[i] = s[i] - v[i];
          out.copyToChannel(b, c);
        }
        resolve(out);
      }
    };
    w.onerror = (e) => { e.preventDefault?.(); fail(new Error(e.message || 'a IA não abriu')); };
  });
}
