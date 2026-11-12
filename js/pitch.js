// Muda o tom da base inteira sem mudar a velocidade (motor Signalsmith Stretch, código aberto, licença MIT).
// Roda no próprio celular, uma vez por tom escolhido; o resultado fica guardado enquanto a música está aberta.
let factory = null;
const tick = () => new Promise((r) => setTimeout(r, 0));

export async function transpose(ctx, buffer, semis, onProgress = () => {}) {
  if (!semis) return buffer;
  if (!factory) factory = (await import('./vendor/stretch.js')).default;
  const m = await factory();
  m._main();
  const nc = buffer.numberOfChannels, len = buffer.length, sr = buffer.sampleRate;
  m._presetDefault(nc, sr);
  m._setTransposeSemitones(semis, 8000 / sr);
  const lat = m._inputLatency() + m._outputLatency();
  const B = 1024;
  const ptr = m._setBuffers(nc, B);
  const input = [...Array(nc)].map((_, c) => buffer.getChannelData(c));
  const out = [...Array(nc)].map(() => new Float32Array(len + lat + B));
  for (let i = 0, k = 0; i < len + lat; i += B, k++) {
    const mem = m.HEAP8.buffer;
    for (let c = 0; c < nc; c++) {
      const inb = new Float32Array(mem, ptr + B * 4 * c, B);
      inb.fill(0);
      if (i < len) inb.set(input[c].subarray(i, Math.min(len, i + B)));
    }
    m._process(B, B);
    const mem2 = m.HEAP8.buffer;
    for (let c = 0; c < nc; c++) out[c].set(new Float32Array(mem2, ptr + B * 4 * (c + nc), B), i);
    if (k % 60 === 0) { onProgress(i / (len + lat)); await tick(); }
  }
  const res = ctx.createBuffer(nc, len, sr);
  for (let c = 0; c < nc; c++) res.copyToChannel(out[c].subarray(lat, lat + len), c);
  onProgress(1);
  return res;
}
