// Ajudante da IA: tira a voz aqui e depois é desligado, devolvendo toda a memória ao celular.
import { separateVoice } from './separate.js';
onmessage = async (e) => {
  try {
    const { L, R } = e.data;
    const voice = await separateVoice([L, R], { onDownload: (p) => postMessage({ t: 'd', p }), onProgress: (p) => postMessage({ t: 'p', p }) });
    const v = voice.map((x) => ({ b: x.buffer, o: x.byteOffset, n: x.length }));
    postMessage({ t: 'done', voice: v, L, R }, [...new Set([...v.map((x) => x.b), L.buffer, R.buffer])]);
  } catch (err) { postMessage({ t: 'err', m: err.message || String(err) }); }
};
postMessage({ t: 'ready' });
