// Ajudante: muda o tom/andamento de um pedaço da música (roda num núcleo separado do celular)
import { stretchArrays } from './pitch.js';
self.onmessage = async (e) => {
  const { chs, sr, semis, speed } = e.data;
  try {
    const out = await stretchArrays(chs, sr, semis, speed, (p) => self.postMessage({ t: 'p', p }));
    self.postMessage({ t: 'done', out }, out.map((c) => c.buffer));
  } catch (err) { self.postMessage({ t: 'err', m: String(err?.message || err) }); }
};
