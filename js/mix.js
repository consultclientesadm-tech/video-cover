// Som final do vídeo: a voz gravada passa por um tratamento discreto (limpeza do ruído entre as frases,
// equalização, compressão leve e um pouco de ambiência), é misturada com a base nos volumes que o artista
// escolher e o vídeo é salvo com esse áudio. A imagem não é recomprimida (sai igual à gravação).

// ---- 1. Tratamento da voz ----

// Tira o ruído do ambiente sem mexer na voz: só abaixa o som quando ninguém está cantando
// (entre frases e respirações). Durante o canto a voz fica intacta, então não tem efeito "robótico".
function quietGaps(pcm, sr) {
  const hop = Math.round(sr * 0.01), n = Math.floor(pcm.length / hop);
  const lv = new Float32Array(n);
  for (let f = 0; f < n; f++) { let e = 0; for (let i = f * hop; i < (f + 1) * hop; i++) e += pcm[i] * pcm[i]; lv[f] = Math.sqrt(e / hop) + 1e-7; }
  const sorted = Float32Array.from(lv).sort();
  const floor = sorted[Math.floor(n * 0.15)];          // nível do ruído de fundo
  const open = Math.max(floor * 3.2, sorted[Math.floor(n * 0.5)] * 0.25); // acima disso é voz
  const RANGE = 0.18;                                    // abaixa o ruído em ~15 dB (não zera: soa natural)
  const out = new Float32Array(pcm.length);
  let g = RANGE, hold = 0;
  const att = 1 - Math.exp(-1 / (sr * 0.004)), rel = 1 - Math.exp(-1 / (sr * 0.16));
  for (let f = 0; f < n; f++) {
    let target;
    if (lv[f] >= open) { target = 1; hold = 12; }       // segura aberto 120 ms depois da voz
    else if (hold > 0) { target = 1; hold--; }
    else target = Math.max(RANGE, Math.min(1, ((lv[f] - floor) / (open - floor)) ** 2));
    for (let i = f * hop; i < (f + 1) * hop; i++) { g += (target - g) * (target > g ? att : rel); out[i] = pcm[i] * g; }
  }
  for (let i = n * hop; i < pcm.length; i++) out[i] = pcm[i] * g;
  return out;
}

// Ambiência curta (sala pequena), gerada aqui mesmo
function roomIR(ctx, sr) {
  const len = Math.round(sr * 1.4), ir = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c); let lp = 0;
    for (let i = 0; i < len; i++) { const t = i / sr; lp += (Math.random() * 2 - 1 - lp) * 0.35; d[i] = t < 0.018 ? 0 : lp * Math.exp(-t * 4.2); }
  }
  return ir;
}

const rmsDb = (chs, len) => {
  // volume médio só dos trechos com som (ignora silêncio), em dB
  const hop = 4800, lv = [];
  for (let i = 0; i + hop <= len; i += hop) { let e = 0; for (const d of chs) for (let k = i; k < i + hop; k++) e += d[k] * d[k]; lv.push(e / (hop * chs.length)); }
  lv.sort((a, b) => b - a);
  const top = lv.slice(0, Math.max(1, Math.floor(lv.length * 0.5)));
  return 10 * Math.log10(top.reduce((a, b) => a + b, 0) / top.length + 1e-12);
};

export async function processVoice(pcm, sr) {
  const clean = quietGaps(pcm, sr);
  const ctx = new OfflineAudioContext(2, clean.length + Math.round(sr * 1.5), sr);
  const src = ctx.createBufferSource();
  const b = ctx.createBuffer(1, clean.length, sr); b.copyToChannel(clean, 0); src.buffer = b;
  const f = (type, freq, gain = 0, Q = 0.7) => { const x = ctx.createBiquadFilter(); x.type = type; x.frequency.value = freq; x.gain.value = gain; x.Q.value = Q; return x; };
  const hp = f('highpass', 85, 0, 0.7);          // tira grave de vento, mesa, trânsito
  const mud = f('peaking', 280, -2.5, 1.0);       // menos "abafado"
  const pres = f('peaking', 3200, 2.5, 0.8);      // presença (a voz fica na frente)
  const air = f('highshelf', 9500, 2);            // brilho
  const comp = ctx.createDynamicsCompressor();    // compressão leve: frases baixas aparecem mais
  comp.threshold.value = -24; comp.knee.value = 8; comp.ratio.value = 3; comp.attack.value = 0.008; comp.release.value = 0.2;
  const dry = ctx.createGain(); dry.gain.value = 1;
  const rev = ctx.createConvolver(); rev.buffer = roomIR(ctx, sr);
  const revHp = f('highpass', 250); const wet = ctx.createGain(); wet.gain.value = 0.1;
  src.connect(hp).connect(mud).connect(pres).connect(air).connect(comp);
  comp.connect(dry).connect(ctx.destination);
  comp.connect(revHp).connect(rev).connect(wet).connect(ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  // nível padrão da voz (−17 dB nos trechos cantados)
  const chs = [out.getChannelData(0), out.getChannelData(1)];
  const k = 10 ** ((-17 - rmsDb(chs, out.length)) / 20);
  for (const d of chs) for (let i = 0; i < d.length; i++) d[i] *= k;
  return out;
}

// Base num nível padrão (−19 dB), para "Voz 100% / Base 80%" soar igual em qualquer música
export function baseGain(buf) {
  const chs = [...Array(buf.numberOfChannels)].map((_, c) => buf.getChannelData(c));
  return 10 ** ((-19 - rmsDb(chs, buf.length)) / 20);
}

// ---- 2. Onde a voz está no vídeo ----
// O áudio gravado junto com a imagem tem a voz no lugar certo (boca sincronizada). Procuramos a voz
// crua dentro dele para saber exatamente em que segundo do vídeo ela começa.
export async function findVoiceInVideo(ctx, videoBlob, voice, sr, guess) {
  let rec;
  try { rec = await ctx.decodeAudioData(await videoBlob.arrayBuffer()); } catch { return null; }
  const R = 4000;
  const down = (d, from) => { const k = from / R, n = Math.floor(d.length / k), o = new Float32Array(n); for (let i = 0; i < n; i++) { let s = 0; const a = Math.floor(i * k), b = Math.floor((i + 1) * k); for (let j = a; j < b; j++) s += d[j]; o[i] = s / (b - a); } return o; };
  const recD = down(rec.getChannelData(0), rec.sampleRate), vD = down(voice, sr);
  // trecho de 6 s da voz com mais energia
  const W = 6 * R; let best = 0, bestE = -1;
  for (let i = 0; i + W <= vD.length; i += R) { let e = 0; for (let k = i; k < i + W; k += 4) e += vD[k] * vD[k]; if (e > bestE) { bestE = e; best = i; } }
  if (vD.length < W) return null;
  const seg = vD.subarray(best, best + W);
  const c0 = Math.round((guess) * R) + best, SPAN = Math.round(1.2 * R);
  let bl = 0, bv = -Infinity, sum = 0, cnt = 0;
  for (let L = c0 - SPAN; L <= c0 + SPAN; L++) {
    if (L < 0 || L + W > recD.length) continue;
    let v = 0, e = 1e-9;
    for (let k = 0; k < W; k += 2) { const y = recD[L + k]; v += seg[k] * y; e += y * y; }
    v /= Math.sqrt(e);
    sum += Math.abs(v); cnt++;
    if (v > bv) { bv = v; bl = L; }
  }
  if (!cnt || bv < (sum / cnt) * 4) return null; // pico fraco: não confia
  return (bl - best) / R;
}

// ---- 3. Mistura final ----
// voiceAt / baseAt: segundo do vídeo em que cada um começa
export async function renderMix({ voice, base, voiceAt, baseAt, gv, gb, duration, sr }) {
  const len = Math.ceil(duration * sr);
  const ctx = new OfflineAudioContext(2, len, sr);
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -2; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.1;
  lim.connect(ctx.destination);
  const put = (buf, at, g) => {
    if (!buf || !g) return;
    const s = ctx.createBufferSource(); s.buffer = buf;
    const gn = ctx.createGain(); gn.gain.value = g;
    s.connect(gn).connect(lim);
    if (at >= 0) s.start(at); else s.start(0, -at);
  };
  put(base, baseAt, gb);
  put(voice, voiceAt, gv);
  const out = await ctx.startRendering();
  // segurança final: o pico nunca passa de −1 dB (sem distorção no celular de ninguém)
  let pk = 0; for (let c = 0; c < 2; c++) { const d = out.getChannelData(c); for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > pk) pk = a; } }
  if (pk > 0.89) { const k = 0.89 / pk; for (let c = 0; c < 2; c++) { const d = out.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= k; } }
  return out;
}

// ---- 4. Salvar: vídeo original + áudio novo ----
let mbP = null;
const loadMB = () => (mbP ||= import('./vendor/mediabunny/mediabunny.min.mjs'));

export async function exportVideo(videoBlob, audio, onProgress = () => {}) {
  const MB = await loadMB();
  const input = new MB.Input({ source: new MB.BlobSource(videoBlob), formats: MB.ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  if (!vt) throw new Error('vídeo sem imagem');
  const vcodec = await vt.getCodec();
  const webm = ['vp8', 'vp9', 'av1'].includes(vcodec);
  let acodec = webm ? 'opus' : 'aac';
  if (acodec === 'aac' && !(await MB.canEncodeAudio('aac'))) {
    const { registerAacEncoder } = await import('./vendor/mediabunny/aac-encoder.min.mjs');
    registerAacEncoder();
  }
  const output = new MB.Output({
    format: webm ? new MB.WebMOutputFormat() : new MB.Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new MB.BufferTarget(),
  });
  const vsrc = new MB.EncodedVideoPacketSource(vcodec);
  output.addVideoTrack(vsrc, { rotation: await vt.getRotation() });
  const asrc = new MB.AudioBufferSource({ codec: acodec, bitrate: 192000 });
  output.addAudioTrack(asrc);
  await output.start();
  const cfg = await vt.getDecoderConfig();
  const total = audio.duration || 1;
  const sink = new MB.EncodedPacketSink(vt);
  const video = (async () => {
    let first = true;
    for await (const p of sink.packets()) {
      await vsrc.add(p, first ? { decoderConfig: cfg } : undefined); first = false;
      onProgress(Math.min(0.95, p.timestamp / total));
    }
    vsrc.close();
  })();
  // áudio em pedaços de 5 s (não trava o celular)
  const sound = (async () => {
    const sr = audio.sampleRate, step = sr * 5;
    for (let i = 0; i < audio.length; i += step) {
      const n = Math.min(step, audio.length - i);
      const b = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: sr });
      for (let c = 0; c < 2; c++) b.copyToChannel(audio.getChannelData(c).subarray(i, i + n), c);
      await asrc.add(b);
    }
    asrc.close();
  })();
  await Promise.all([video, sound]);
  await output.finalize();
  onProgress(1);
  return new Blob([output.target.buffer], { type: webm ? 'video/webm' : 'video/mp4' });
}
