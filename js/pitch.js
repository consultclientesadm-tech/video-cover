// Muda o tom e o andamento da base sem um mexer no outro (motor Signalsmith Stretch, código aberto, licença MIT).
// semis: semitons (−6 a +6). speed: andamento (1 = original, 1.1 = 10% mais rápido).
// Roda no próprio celular, uma vez por combinação escolhida; o resultado fica guardado enquanto a música está aberta.
let factory = null;
const tick = () => new Promise((r) => setTimeout(r, 0));

export async function transpose(ctx, buffer, semis, speed = 1, onProgress = () => {}) {
  if (!semis && speed === 1) return buffer;
  if (!factory) factory = (await import('./vendor/stretch.js')).default;
  const m = await factory();
  m._main();
  const nc = buffer.numberOfChannels, len = buffer.length, sr = buffer.sampleRate;
  m._presetDefault(nc, sr);
  m._setTransposeSemitones(semis, 8000 / sr);
  const OUT = 1024;                       // amostras de saída por bloco
  const MAXIN = Math.ceil(OUT * speed) + 2; // amostras de entrada por bloco (mais rápido = consome mais)
  const SIZE = Math.max(OUT, MAXIN);
  const ptr = m._setBuffers(nc, SIZE);
  // atraso do motor: a entrada conta no tempo da música, a saída no tempo novo
  const lat = Math.round(m._outputLatency() + m._inputLatency() / speed);
  const outLen = Math.round(len / speed);
  const input = [...Array(nc)].map((_, c) => buffer.getChannelData(c));
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
  const res = ctx.createBuffer(nc, outLen, sr);
  for (let c = 0; c < nc; c++) res.copyToChannel(out[c].subarray(lat, lat + outLen), c);
  onProgress(1);
  return res;
}
