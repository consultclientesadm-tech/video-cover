// Letra automática: manda a voz separada do cantor original para a IA de transcrição (função /api/transcribe)
// e recebe cada palavra com o tempo em que é cantada. Depois monta as linhas do karaokê.
const SR = 16000;
const MAX_SEC = 125; // ~4 MB por pedaço (WAV 16 kHz, 16 bits): o limite do Vercel é 4,5 MB

// voz (estéreo, Float32) → mono 16 kHz, com reamostragem de qualidade do próprio navegador
async function toMono16k(voice, sr) {
  const len = voice[0].length;
  const ctx = new OfflineAudioContext(1, Math.ceil(len * SR / sr), SR);
  const b = ctx.createBuffer(1, len, sr), d = b.getChannelData(0), L = voice[0], R = voice[1] || voice[0];
  for (let i = 0; i < len; i++) d[i] = (L[i] + R[i]) * 0.5;
  const src = ctx.createBufferSource(); src.buffer = b; src.connect(ctx.destination); src.start();
  return (await ctx.startRendering()).getChannelData(0);
}

function wav16(pcm) {
  const n = pcm.length, b = new DataView(new ArrayBuffer(44 + n * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) b.setUint8(o + i, s.charCodeAt(i)); };
  // normaliza o volume (voz separada costuma vir baixa)
  let pk = 1e-6; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(pcm[i]));
  const g = Math.min(8, 0.9 / pk);
  w(0, 'RIFF'); b.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true); b.setUint32(24, SR, true);
  b.setUint32(28, SR * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); w(36, 'data'); b.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) b.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i] * g)) * 32767, true);
  return new Blob([b], { type: 'audio/wav' });
}

// Corta em pedaços de até MAX_SEC, sempre num intervalo sem canto (para não cortar palavra no meio)
function cuts(totalSec, seg) {
  const out = []; let a = 0;
  while (totalSec - a > MAX_SEC) {
    const lim = a + MAX_SEC;
    let best = lim - 20; // sem pausa boa: corta 20 s antes do limite
    for (let i = 0; i + 1 < seg.length; i++) {
      const gapA = seg[i][1], gapB = seg[i + 1][0];
      const mid = (gapA + gapB) / 2;
      if (mid > a + 30 && mid < lim) best = mid;
    }
    out.push([a, best]); a = best;
  }
  out.push([a, totalSec]);
  return out;
}

export class SemChave extends Error {}

// Frases que o Whisper costuma inventar em introdução/instrumental (vêm de legendas de vídeos)
const JUNK = /amara\.org|legendas? (pela|por|de)|legendado|tradução|transcri[çc]|inscreva-se|se inscreva|deixe seu like|ative o sininho|obrigad[oa] por assistir|subtitles? by|thanks for watching|please subscribe|♪/i;

// Fica só com palavras cantadas: dentro de um trecho em que o cantor original canta (a IA de separação
// mostra onde) e sem marcações como [Música], (Refrão), ♪ ou "Título - Artista".
function clean(words, seg) {
  const near = (w) => !seg?.length || seg.some(([x, y]) => w.e > x - 0.4 && w.s < y + 0.4);
  let out = words.filter((w) => near(w) && !/^[\[(♪*#]|[\])]$|^♪+$/.test(w.w));
  out = out.map((w) => ({ ...w, w: w.w.replace(/[♪*#]/g, '').trim() })).filter((w) => w.w && !/^[-–—_.,:;!?]+$/.test(w.w));
  return out;
}

// Devolve as linhas do karaokê: [{ inicio, fim, texto, palavras: [{ w, s, e }] }] (tempo da música original)
export async function transcribe(voice, sr, seg, { onProgress = () => {} } = {}) {
  const pcm = await toMono16k(voice, sr);
  const total = pcm.length / SR;
  const parts = cuts(total, seg || []);
  let done = 0;
  const results = await Promise.all(parts.map(async ([a, b]) => {
    const body = wav16(pcm.subarray(Math.floor(a * SR), Math.min(pcm.length, Math.ceil(b * SR))));
    const r = await fetch('api/transcribe', { method: 'POST', body, headers: { 'Content-Type': 'audio/wav' } });
    const j = await r.json().catch(() => ({}));
    if (r.status === 503 && j.erro === 'sem_chave') throw new SemChave(j.msg);
    if (!r.ok) throw new Error(j.msg || `transcrição ${r.status}`);
    onProgress(++done / parts.length);
    // tira trechos que a IA inventa (créditos de legenda, "inscreva-se", títulos) antes de juntar
    const bad = (j.segments || []).filter((g) => JUNK.test(g.t || '')).map((g) => [g.s, g.e]);
    return (j.words || []).map((w) => ({ w: String(w.w).trim(), s: w.s + a, e: w.e + a }))
      .filter((w) => w.w && !bad.some(([x, y]) => w.s + 0.01 >= x + a && w.e - 0.01 <= y + a));
  }));
  return toLines(clean(results.flat().sort((x, y) => x.s - y.s), seg));
}

// Palavras → linhas: quebra numa pausa de respiração, depois de pontuação ou a cada ~8 palavras
export function toLines(words) {
  const lines = []; let cur = [];
  const flush = () => {
    if (!cur.length) return;
    lines.push({ inicio: cur[0].s, fim: cur[cur.length - 1].e, texto: cur.map((w) => w.w).join(' '), palavras: cur });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i], prev = cur[cur.length - 1];
    const len = cur.reduce((n, x) => n + x.w.length + 1, 0) + w.w.length;
    // linha curta (cabe numa linha só no celular): quebra na respiração, na pontuação ou passando de ~30 letras
    if (prev && (w.s - prev.e > 0.7 || cur.length >= 7 || len > 30 || (/[.,!?;:]$/.test(prev.w) && cur.length >= 3))) flush();
    cur.push(w);
  }
  flush();
  // cada linha fica na tela até a próxima começar (no máximo 1,5 s depois de acabar)
  for (let i = 0; i < lines.length; i++) {
    const nx = lines[i + 1];
    lines[i].fim = nx ? Math.min(nx.inicio, lines[i].fim + 1.5) : lines[i].fim + 1.5;
  }
  return lines;
}
