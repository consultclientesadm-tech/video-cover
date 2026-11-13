// Transcreve a voz separada do cantor original, palavra por palavra com o tempo de cada uma.
// Recebe um WAV (mono, 16 kHz) no corpo do pedido e repassa para o Whisper do Groq.
// A chave fica só no Vercel: variável de ambiente GROQ_API_KEY (nunca vai para o navegador).
const MAX = 4.4 * 1024 * 1024; // limite de corpo das funções do Vercel (4,5 MB)

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
  const key = process.env.GROQ_API_KEY;
  if (!key) return send(res, 503, { erro: 'sem_chave', msg: 'A transcrição automática ainda não foi ligada (falta a chave no Vercel).' });
  // só aceita pedidos vindos do próprio app
  const origin = req.headers.origin || '';
  const host = req.headers.host || '';
  if (origin && !origin.endsWith('//' + host)) return send(res, 403, { erro: 'origem' });

  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX) return send(res, 413, { erro: 'grande' }); chunks.push(c); }
  const wav = Buffer.concat(chunks);
  if (wav.length < 1000) return send(res, 400, { erro: 'vazio' });

  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'voz.wav');
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');
  form.append('temperature', '0');
  const lang = (req.headers['x-idioma'] || '').toString().slice(0, 5);
  if (/^[a-z]{2}$/.test(lang)) form.append('language', lang);

  try {
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return send(res, 502, { erro: 'ia', msg: j?.error?.message || `IA respondeu ${r.status}` });
    const words = (j.words || []).map((w) => ({ w: w.word, s: +w.start, e: +w.end }));
    const segments = (j.segments || []).map((s) => ({ t: s.text, s: +s.start, e: +s.end }));
    return send(res, 200, { idioma: j.language, words, segments });
  } catch (e) {
    return send(res, 502, { erro: 'rede', msg: e.message });
  }
};

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}
