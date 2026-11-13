// Muda o tom e o andamento da base sem um mexer no outro (motor Signalsmith Stretch, código aberto, licença MIT).
// semis: semitons (−6 a +6). speed: andamento (1 = original, 1.1 = 10% mais rápido).
// Para ser rápido, a música é dividida em pedaços processados ao mesmo tempo (um "ajudante" por núcleo
// do celular) e emendados com uma transição suave. O resultado fica guardado enquanto a música está aberta.
let factory = null;
const tick = () => new Promise((r) => setTimeout(r, 0));

// Núcleo: processa canais crus (Float32Array) e devolve os canais novos, já sem o atraso do motor
export async function stretchArrays(input, sr, semis, speed = 1, onProgress = () => {}) {
  if (!factory) factory = (await import('./vendor/stretch.js')).default;
  const m = await factory();
  m._main();
  const nc = input.length, len = input[0].length;
  m._presetDefault(nc, sr);
  m._setTransposeSemitones(semis, 8000 / sr);
  const OUT = 1024;                       // amostras de saída por bloco
  const MAXIN = Math.ceil(OUT * speed) + 2; // amostras de entrada por bloco (mais rápido = consome mais)
  const SIZE = Math.max(OUT, MAXIN);
  const ptr = m._setBuffers(nc, SIZE);
  // atraso do motor: a entrada conta no tempo da música, a saída no tempo novo
  const lat = Math.round(m._outputLatency() + m._inputLatency() / speed);
  const outLen = Math.round(len / speed);
  const out = [...Array(nc)].map(() => new Float32Array(outLen + lat + OUT));
  let inPos = 0, acc = 0;
  for (let o = 0, k = 0; o < outLen + lat; o += OUT, k++) {
    acc += OUT * speed;
    const n = Math.floor(acc - inPos);  // quantas amostras de entrada este bloco consome
    const mem = m.HEAP8.buffer;
    for (let c = 0; c < nc; c++) {
      const inb = new Float32Array(mem, ptr + SIZE * 4 * c, SIZE);
      inb.fill(0);
      if (inPos < len) inb.set(input[c].subarray(inPos, Math.min(len, inPos + n)));
    }
    m._process(n, OUT);
    inPos += n;
    const mem2 = m.HEAP8.buffer;
    for (let c = 0; c < nc; c++) out[c].set(new Float32Array(mem2, ptr + SIZE * 4 * (c + nc), OUT), o);
    if (k % 60 === 0) { onProgress(o / (outLen + lat)); await tick(); }
  }
  onProgress(1);
  return out.map((c) => c.slice(lat, lat + outLen));
}

function runWorker(chs, sr, semis, speed, onProgress) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./pitch-worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const m = e.data;
      if (m.t === 'p') onProgress(m.p);
      else if (m.t === 'err') { w.terminate(); reject(new Error(m.m)); }
      else if (m.t === 'done') { w.terminate(); resolve(m.out); }
    };
    w.onerror = (e) => { e.preventDefault?.(); w.terminate(); reject(new Error(e.message || 'ajudante do tom não abriu')); };
    w.postMessage({ chs, sr, semis, speed }, chs.map((c) => c.buffer));
  });
}

export async function transpose(ctx, buffer, semis, speed = 1, onProgress = () => {}) {
  if (!semis && speed === 1) return buffer;
  const nc = buffer.numberOfChannels, len = buffer.length, sr = buffer.sampleRate;
  const outLen = Math.round(len / speed);
  const cores = navigator.hardwareConcurrency || 2;
  const K = Math.max(1, Math.min(6, cores - 1, Math.floor(len / sr / 15)));
  let chans;
  try {
    if (K < 2 || typeof Worker === 'undefined') throw new Error('sem paralelo');
    // pedaços com sobra de 1 s de cada lado (o motor precisa de "contexto"), emendados no meio da sobra
    const PAD = Math.round(1.5 * sr), X = Math.round(0.03 * sr);
    const seg = Math.ceil(len / K), prog = new Array(K).fill(0);
    const parts = await Promise.all([...Array(K)].map((_, k) => {
      const a = Math.max(0, k * seg - PAD), b = Math.min(len, (k + 1) * seg + PAD);
      const chs = [...Array(nc)].map((_, c) => buffer.getChannelData(c).slice(a, b));
      return runWorker(chs, sr, semis, speed, (p) => { prog[k] = p; onProgress(prog.reduce((x, y) => x + y, 0) / K); }).then((out) => ({ a, out }));
    }));
    chans = [...Array(nc)].map(() => new Float32Array(outLen));
    // Cada pedaço sai com a "fase" um pouco diferente: antes de emendar, desloca o pedaço seguinte
    // alguns milissegundos até ele casar com o anterior (sem isso o som afunda na emenda).
    const shift = new Array(K).fill(0), LAG = Math.round(0.012 * sr), WIN = Math.round(0.05 * sr);
    const at = (k, c, i) => { const { a, out } = parts[k]; const j = i - Math.round(a / speed) + shift[k]; return j >= 0 && j < out[c].length ? out[c][j] : 0; };
    for (let k = 1; k < K; k++) {
      const cut = Math.round(k * seg / speed);
      let best = 0, bestV = -Infinity;
      for (let L = -LAG; L <= LAG; L++) {
        shift[k] = L; let v = 0, e = 1e-9;
        for (let i = cut - WIN; i < cut + WIN; i += 2) for (let c = 0; c < nc; c++) { const y = at(k, c, i); v += at(k - 1, c, i) * y; e += y * y; }
        v /= Math.sqrt(e);
        if (v > bestV) { bestV = v; best = L; }
      }
      shift[k] = best;
    }
    for (let k = 0; k < K; k++) {
      const cut0 = Math.round(k * seg / speed), cut1 = Math.min(outLen, Math.round((k + 1) * seg / speed));
      const from = k === 0 ? 0 : cut0 - X / 2, to = k === K - 1 ? outLen : cut1 + X / 2;
      for (let i = Math.max(0, Math.floor(from)); i < Math.min(outLen, Math.ceil(to)); i++) {
        let w = 1;
        if (k > 0 && i < cut0 + X / 2) w = (i - (cut0 - X / 2)) / X;
        if (k < K - 1 && i > cut1 - X / 2) w = Math.min(w, ((cut1 + X / 2) - i) / X);
        w = Math.max(0, Math.min(1, w));
        for (let c = 0; c < nc; c++) chans[c][i] += at(k, c, i) * w;
      }
    }
  } catch (e) {
    if (e.message !== 'sem paralelo') console.warn('tom em paralelo falhou, fazendo em sequência', e);
    chans = await stretchArrays([...Array(nc)].map((_, c) => buffer.getChannelData(c)), sr, semis, speed, onProgress);
  }
  const res = ctx.createBuffer(nc, outLen, sr);
  for (let c = 0; c < nc; c++) res.copyToChannel(chans[c], c);
  onProgress(1);
  return res;
}
