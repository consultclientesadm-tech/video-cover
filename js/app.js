// Video Cover: o artista escolhe a base, ajusta o tom, segue a letra e grava o vídeo cantando.
// A base sai no alto-falante (ou no fone) para ele cantar no tempo, mas no vídeo entra a base LIMPA,
// direto do arquivo, misturada com a voz do microfone. Assim o vazamento da caixa fica escondido.
import { transpose } from './pitch.js';
import { removeVoice, prefetchModel } from './separate.js';
import { transcribe, SemChave } from './lyricsai.js';

const $ = (id) => document.getElementById(id);
const app = $('app');
const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const COUNT = 5; // segundos de contagem antes da base

const S = {
  catalog: [], song: null, semis: 0, speed: 1,
  ctx: null, original: null, buffers: new Map(), // 'semitons|andamento' -> AudioBuffer já pronto
  cam: null, mic: null, micNode: null, voiceGain: null, baseMixGain: null, dest: null, delay: null, tap: null,
  phones: false, recording: false, previewing: null, recorder: null, chunks: [], voice: [], voiceStartFrame: 0,
  baseStart: 0, raf: 0, blob: null, ext: 'mp4', mime: '',
  // teleprompter: texto colado, velocidade (1–20), atraso do início (s), posição atual (px), pausado
  pr: { text: '', speed: 5, delay: 0, pos: 0, paused: false, last: 0, auto: false, off: 0 },
  sing: null, // trechos em que o cantor original canta: { seg: [[ini, fim], ...] (s), total }
};

// ---------- Telas ----------
function show(screen) {
  app.dataset.screen = screen;
  $('back').hidden = screen === 'home';
  $('topinfo').textContent = S.song && screen !== 'home' ? S.song.titulo : '';
}
$('close').onclick = () => { stopAll(); closeCamera(); show('home'); };
$('back').onclick = () => {
  if (app.dataset.screen === 'result') return toStudio();
  stopAll(); closeCamera(); show('home');
};

// ---------- Catálogo ----------
async function loadCatalog() {
  const r = await fetch('bases/catalogo.json');
  S.catalog = await r.json();
  const ul = $('songs');
  ul.innerHTML = '';
  for (const s of S.catalog) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.innerHTML = `<span class="play"></span><span><b></b><small></small></span><span class="meta">Tom <b></b><br></span>`;
    b.querySelector('span > b').textContent = s.titulo;
    b.querySelector('small').textContent = s.artista;
    b.querySelector('.meta b').textContent = s.tom;
    b.querySelector('.meta').append(fmt(s.duracao));
    b.onclick = () => openSong(s);
    li.append(b); ul.append(li);
  }
}
$('ownFile').onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  openSong({ id: 'minha-base', titulo: f.name.replace(/\.[^.]+$/, ''), artista: 'Minha base', tom: null, file: f, letra: [] });
  e.target.value = '';
};

const fmt = (t) => { t = Math.max(0, t | 0); return String((t / 60) | 0).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };

// ---------- Abrir a música: áudio + câmera ----------
async function openSong(song) {
  S.song = song; S.semis = 0; S.speed = 1; S.buffers.clear(); S.original = null;
  show('studio');
  setupPrompter(song);
  setTone(); setSpeed(); renderLyrics(0);
  $('recBtn').disabled = true; $('listen').disabled = true;
  busy('Carregando a base…');
  ensureAudio();
  try {
    const data = song.file ? await song.file.arrayBuffer() : await (await fetch(song.arquivo)).arrayBuffer();
    S.original = await S.ctx.decodeAudioData(data);
    S.buffers.set('0|1', S.original);
    if (!song.duracao) song.duracao = S.original.duration;
  } catch (e) {
    busy('Não consegui abrir esse áudio. Tente um MP3.'); return;
  }
  busy('');
  const rv = $('removeVoice');
  rv.hidden = !song.file; rv.disabled = false; rv.textContent = 'Separar voz (IA)';
  if (song.file) prefetchModel().catch(() => {}); // já deixa a IA baixada enquanto ele se prepara
  await openCamera();
  $('listen').disabled = false;
  $('recBtn').disabled = !S.cam;
}

function ensureAudio() {
  if (S.ctx) { S.ctx.resume(); return; }
  // iPhone: deixa o som sair alto pelo alto-falante enquanto o microfone grava
  try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch {}
  S.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  S.ctx.resume();
}

async function openCamera() {
  $('camhint').hidden = false;
  $('camhint').textContent = 'Abrindo a câmera…';
  try {
    if (!S.cam) {
      S.cam = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1080 }, height: { ideal: 1920 }, frameRate: { ideal: 30 } }, audio: false,
      });
    }
    $('preview').srcObject = S.cam;
    await $('preview').play().catch(() => {});
    $('camhint').hidden = true;
    await openMic();
  } catch (e) {
    console.error(e);
    S.cam = null;
    $('camhint').textContent = 'Preciso da câmera e do microfone. Libere o acesso nas configurações do navegador e abra a música de novo.';
  }
}

// Microfone: sem fone ligamos o cancelamento de eco do celular (tira boa parte da base que volta pela caixa);
// com fone desligamos tudo para a voz sair natural.
async function openMic() {
  if (S.mic) S.mic.getTracks().forEach((t) => t.stop());
  S.mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: !S.phones, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
  const ctx = S.ctx;
  if (S.micNode) S.micNode.disconnect();
  S.micNode = ctx.createMediaStreamSource(S.mic);
  if (!S.dest) {
    S.dest = ctx.createMediaStreamDestination();
    S.voiceGain = ctx.createGain();
    S.baseMixGain = ctx.createGain();
    S.delay = ctx.createDelay(1);
    // limitador no fim: voz alta + base nunca estouram no vídeo
    S.limiter = ctx.createDynamicsCompressor();
    S.limiter.threshold.value = -4; S.limiter.knee.value = 2; S.limiter.ratio.value = 20;
    S.limiter.attack.value = 0.003; S.limiter.release.value = 0.12;
    S.limiter.connect(S.dest);
    S.voiceGain.connect(S.limiter);
    S.delay.connect(S.baseMixGain).connect(S.limiter);
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([TAP], { type: 'text/javascript' })));
    S.tap = new AudioWorkletNode(ctx, 'tap', { numberOfInputs: 1, numberOfOutputs: 0 });
    S.tap.port.onmessage = (e) => { if (S.recording) S.voice.push(e.data); };
  }
  S.micNode.connect(S.voiceGain);
  S.micNode.connect(S.tap);
  applyVolumes();
}
// Guarda a voz crua (sem base), amostra por amostra, para baixar separada e mandar para o Studio Cover
const TAP = `class Tap extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0][0]; if (ch) this.port.postMessage({ f: currentFrame, d: ch.slice(0) }); return true; }
}
registerProcessor('tap', Tap);`;

function closeCamera() {
  if (S.cam) S.cam.getTracks().forEach((t) => t.stop());
  if (S.mic) S.mic.getTracks().forEach((t) => t.stop());
  S.cam = null; S.mic = null;
  if (S.micNode) { S.micNode.disconnect(); S.micNode = null; }
}

$('phones').onchange = async (e) => {
  S.phones = e.target.checked;
  $('tip').textContent = S.phones ? 'Voz limpa, volume à vontade.' : 'Com fone o resultado fica melhor.';
  if (S.cam) await openMic();
};
$('baseVol').oninput = applyVolumes;
$('voiceVol').oninput = applyVolumes;
function applyVolumes() {
  if (!S.voiceGain) return;
  S.voiceGain.gain.value = +$('voiceVol').value;
  S.baseMixGain.gain.value = +$('baseVol').value;
}

// ---------- Tom ----------
function setTone() {
  const k = S.song?.tom;
  const i = k ? NOTES.indexOf(k.replace('m', '')) : -1;
  $('toneKey').textContent = i < 0 ? (S.semis > 0 ? '+' + S.semis : S.semis || '0') : NOTES[(i + S.semis + 120) % 12] + (k.endsWith('m') ? 'm' : '');
  $('toneSemi').textContent = S.semis === 0 ? 'original' : (S.semis > 0 ? '+' : '') + S.semis + (Math.abs(S.semis) === 1 ? ' semitom' : ' semitons');
  $('toneDown').disabled = S.semis <= -6 || S.recording;
  $('toneUp').disabled = S.semis >= 6 || S.recording;
}
// Andamento: de 75% a 125%, em passos de 5%. Mostra o BPM real quando a música tem BPM no catálogo.
const SPEED_MIN = 0.75, SPEED_MAX = 1.25;
function setSpeed() {
  const pct = Math.round(S.speed * 100);
  $('speedBpm').textContent = S.song?.bpm ? Math.round(S.song.bpm * S.speed) + ' BPM' : pct + '%';
  $('speedPct').textContent = pct === 100 ? 'original' : (pct > 100 ? '+' : '') + (pct - 100) + '%';
  $('speedDown').disabled = S.speed <= SPEED_MIN + 1e-6 || S.recording;
  $('speedUp').disabled = S.speed >= SPEED_MAX - 1e-6 || S.recording;
}
$('speedDown').onclick = () => changeSpeed(-0.05);
$('speedUp').onclick = () => changeSpeed(0.05);
async function changeSpeed(d) {
  S.speed = Math.round(Math.max(SPEED_MIN, Math.min(SPEED_MAX, S.speed + d)) * 100) / 100;
  setSpeed();
  if (S.previewing) stopPreview();
  prepareSoon();
}
$('toneDown').onclick = () => changeTone(-1);
$('toneUp').onclick = () => changeTone(1);
let toneJob = 0;
async function changeTone(d) {
  S.semis = Math.max(-6, Math.min(6, S.semis + d));
  setTone();
  if (S.previewing) stopPreview();
  prepareSoon();
}
// espera o artista parar de clicar (+ + +) para preparar a base uma vez só
let prepTimer = 0;
function prepareSoon() {
  clearTimeout(prepTimer);
  $('recBtn').disabled = true; $('listen').disabled = true;
  busy('Ajustando a base…');
  prepTimer = setTimeout(bufferForTone, 450);
}
async function bufferForTone() {
  const key = S.semis + '|' + S.speed;
  if (S.buffers.has(key)) return S.buffers.get(key);
  const job = ++toneJob, semis = S.semis, speed = S.speed;
  $('recBtn').disabled = true; $('listen').disabled = true;
  busy('Ajustando a base… 0%');
  const buf = await transpose(S.ctx, S.original, semis, speed, (p) => { if (job === toneJob) busy(`Ajustando a base… ${Math.round(p * 100)}%`); });
  S.buffers.set(semis + '|' + speed, buf);
  if (job === toneJob) { busy(''); $('recBtn').disabled = !S.cam; $('listen').disabled = false; }
  return buf;
}
function busy(t) { $('busy').hidden = !t; $('busy').textContent = t; }

// ---------- Tirar a voz do cantor (música do celular) ----------
$('removeVoice').onclick = async () => {
  const rv = $('removeVoice');
  if (S.previewing) stopPreview();
  rv.disabled = true; $('recBtn').disabled = true; $('listen').disabled = true;
  rv.textContent = 'Preparando a IA…';
  try {
    const bed = await removeVoice(S.ctx, S.original, {
      onDownload: (p) => { if (p < 1) rv.textContent = `Baixando a IA (só na 1ª vez)… ${Math.round(p * 100)}%`; },
      onProgress: (p) => { rv.textContent = `Tirando a voz… ${Math.round(p * 100)}%`; },
    });
    S.original = bed; S.buffers.clear(); S.buffers.set('0|1', bed);
    rv.textContent = 'Voz separada ✓';
    findSinging(bed.voice, bed.sampleRate);
    if (S.sing) await autoLyrics(bed.voice, bed.sampleRate, rv);
    if (S.semis || S.speed !== 1) await bufferForTone();
  } catch (e) {
    console.error(e);
    rv.disabled = false; rv.textContent = 'Não deu certo. Tocar para tentar de novo';
  }
  $('recBtn').disabled = !S.cam; $('listen').disabled = false;
};

// ---------- Ouvir a base (sem gravar) ----------
$('listen').onclick = async () => {
  if (S.previewing) return stopPreview();
  ensureAudio();
  const buf = await bufferForTone();
  const src = S.ctx.createBufferSource();
  src.buffer = buf; src.connect(S.ctx.destination);
  S.baseStart = S.ctx.currentTime + 0.05;
  src.start(S.baseStart);
  src.onended = () => { if (S.previewing === src) stopPreview(); };
  S.previewing = src;
  resetPrompter();
  $('listen').textContent = 'Parar';
  loop();
};
function stopPreview() {
  if (!S.previewing) return;
  try { S.previewing.stop(); } catch {}
  S.previewing = null;
  $('listen').textContent = 'Ouvir a base';
  cancelAnimationFrame(S.raf); renderLyrics(0); $('progress').style.width = '0';
  resetPrompter();
}

// ---------- Gravar ----------
$('recBtn').onclick = () => (S.recording ? finish() : startRecording());

function pickMime() {
  const opts = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return opts.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

// Atraso da base na mistura do vídeo: o som leva um tempo para sair na caixa e a voz leva um tempo para
// entrar pelo microfone. Atrasamos a base limpa nesse mesmo tanto para ela casar com a voz.
function roundTrip() {
  const c = S.ctx;
  const out = (c.outputLatency || 0) + (c.baseLatency || 0);
  const inp = S.mic?.getAudioTracks()[0]?.getSettings?.().latency || 0.01;
  const t = out + inp;
  return Math.min(0.5, t > 0.015 ? t : 0.06); // Safari não informa: usa uma estimativa
}

async function startRecording() {
  stopPreview();
  ensureAudio();
  const buf = await bufferForTone();
  const ctx = S.ctx;
  S.recording = true; setTone(); setSpeed();
  $('recBtn').classList.add('on'); $('listen').disabled = true; $('phones').disabled = true;

  // base: uma fonte para o alto-falante (para cantar junto) e a mesma, atrasada, para o vídeo
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const lat = roundTrip();
  S.delay.delayTime.value = lat;
  src.connect(ctx.destination);
  src.connect(S.delay);
  S.src = src;

  S.mime = pickMime();
  S.ext = S.mime.includes('mp4') ? 'mp4' : 'webm';
  const stream = new MediaStream([S.cam.getVideoTracks()[0], S.dest.stream.getAudioTracks()[0]]);
  S.chunks = []; S.voice = [];
  S.recorder = new MediaRecorder(stream, { mimeType: S.mime || undefined, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 });
  S.recorder.ondataavailable = (e) => e.data.size && S.chunks.push(e.data);
  S.recorder.onstop = done;

  // contagem: 5, 4, 3, 2, 1 com um clique só no alto-falante (não entra no vídeo)
  const t0 = ctx.currentTime + 0.1;
  S.baseStart = t0 + COUNT;
  S.voiceStartFrame = Math.round((S.baseStart + lat) * ctx.sampleRate);
  for (let i = 0; i < COUNT; i++) click(t0 + i, i === COUNT - 1);
  resetPrompter();
  src.start(S.baseStart);
  src.onended = () => { if (S.recording) setTimeout(finish, 1200); };
  const recAt = S.baseStart - 0.4;
  $('count').hidden = false;
  const tick = () => {
    if (!S.recording) return;
    const left = Math.ceil(S.baseStart - ctx.currentTime);
    if (left > 0) { $('count').textContent = left; requestAnimationFrame(tick); }
    else $('count').hidden = true;
    if (S.recorder.state === 'inactive' && ctx.currentTime >= recAt) { S.recorder.start(1000); $('recbadge').hidden = false; }
  };
  tick();
  loop();
}

function click(at, high) {
  const o = S.ctx.createOscillator(), g = S.ctx.createGain();
  o.frequency.value = high ? 1760 : 1320;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(0.4, at + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
  o.connect(g).connect(S.ctx.destination);
  o.start(at); o.stop(at + 0.1);
}

function finish() {
  if (!S.recording) return;
  S.recording = false;
  try { S.src.onended = null; S.src.stop(); } catch {}
  cancelAnimationFrame(S.raf);
  $('count').hidden = true; $('recbadge').hidden = true;
  $('recBtn').classList.remove('on'); $('listen').disabled = false; $('phones').disabled = false;
  setTone(); setSpeed();
  if (S.recorder && S.recorder.state !== 'inactive') S.recorder.stop();
  else { renderLyrics(0); } // parou ainda na contagem: nada gravado
}

function done() {
  S.blob = new Blob(S.chunks, { type: S.mime || 'video/mp4' });
  const v = $('final');
  if (v.src) URL.revokeObjectURL(v.src);
  v.src = URL.createObjectURL(S.blob);
  S.file = new File([S.blob], `video-cover-${S.song.id}.${S.ext}`, { type: S.blob.type }); // pronto antes do toque em Salvar
  show('result');
  requestAnimationFrame(fitResult);
}

function stopAll() { stopPreview(); if (S.recording) { S.recording = false; try { S.src.stop(); } catch {} if (S.recorder?.state !== 'inactive') { S.recorder.onstop = null; S.recorder.stop(); } } cancelAnimationFrame(S.raf); $('count').hidden = true; $('recbadge').hidden = true; $('recBtn').classList.remove('on'); }

function toStudio() { $('final').pause(); show('studio'); renderLyrics(0); resetPrompter(); $('progress').style.width = '0'; if (!S.cam) openCamera(); }
$('again').onclick = toStudio;
// tela final: o vídeo ocupa o que sobra acima dos botões, em qualquer celular (e ao girar)
function fitResult() { document.documentElement.style.setProperty('--rp', document.querySelector('.result .panel').offsetHeight + 'px'); }
addEventListener('resize', () => { if (app.dataset.screen === 'result') fitResult(); });

// ---------- Letra (karaokê) ----------
function loop() {
  const t = S.ctx.currentTime - S.baseStart;
  renderLyrics(t * S.speed); // a letra está marcada no tempo original da música
  const dur = (S.recording ? S.src?.buffer?.duration : S.previewing?.buffer?.duration) || 1;
  $('progress').style.width = Math.max(0, Math.min(100, (t / dur) * 100)) + '%';
  if (S.recording) $('rectime').textContent = fmt(t);
  stepPrompter(t);
  if (S.recording || S.previewing) S.raf = requestAnimationFrame(loop);
}
function renderLyrics(t) {
  const L = S.song?.letra || [];
  const box = $('lyrics');
  renderCue(t, L);
  if (!L.length) {
    box.classList.remove('free');
    $('lyCur').textContent = ''; $('lyCur').style.setProperty('--p', '0%');
    $('lyNext').textContent = S.song?.file ? 'Base própria: cante no tempo da música' : '';
    return;
  }
  let i = L.findIndex((l) => t < l.fim);
  if (i < 0) { $('lyCur').textContent = ''; $('lyNext').textContent = ''; return; }
  const cur = L[i];
  if (t < cur.inicio) {
    // ainda não começou esta linha: mostra ela como a próxima, sem cor
    $('lyCur').textContent = i === 0 && t < cur.inicio - 0.5 ? (t < 0 ? 'Prepare-se…' : '♪') : cur.texto;
    $('lyCur').style.setProperty('--p', '0%');
    $('lyNext').textContent = i === 0 && t < cur.inicio - 0.5 ? cur.texto : (L[i + 1]?.texto || '');
    return;
  }
  // a cor vai preenchendo a linha enquanto ela é cantada (85% do tempo da linha)
  let p = Math.max(0, Math.min(1, (t - cur.inicio) / ((cur.fim - cur.inicio) * 0.85)));
  if (cur.palavras) {
    // letra da IA: a cor anda palavra por palavra, no tempo em que o cantor original canta cada uma
    let tot = 0, done = 0;
    for (const w of cur.palavras) {
      const n = w.w.length + 1; tot += n;
      if (t >= w.e) done += n; else if (t > w.s) done += n * (t - w.s) / Math.max(0.05, w.e - w.s);
    }
    p = tot ? done / tot : p;
  }
  $('lyCur').textContent = cur.texto;
  $('lyCur').style.setProperty('--p', (p * 100).toFixed(1) + '%');
  $('lyNext').textContent = L[i + 1]?.texto || '';
}

// Marcação de entrada: antes da primeira linha (e de toda linha que vem depois de uma pausa), aparecem
// setas, uma por tempo do compasso, acendendo no ritmo da música. Quando a última acende, é hora de cantar.
function renderCue(t, L) {
  // letra da IA não tem BPM: usa 4 setas a cada 0,6 s antes de cada entrada depois de uma pausa
  const cue = $('cue'), bpm = S.song?.bpm || (L[0]?.palavras ? 100 : 0), n = S.song?.compasso || 4;
  if (!bpm || !L.length) { cue.hidden = true; return; }
  const spb = 60 / bpm;
  const i = L.findIndex((l, k) => t < l.inicio + 0.45 && (k === 0 || l.inicio - L[k - 1].fim >= spb));
  const line = L[i];
  const from = line ? line.inicio - (n - 1) * spb - spb * 0.5 : 0;
  if (!line || t < from || (i > 0 && t < L[i - 1].fim)) { cue.hidden = true; return; }
  if (cue.childElementCount !== n) cue.innerHTML = '<i></i>'.repeat(n);
  const lit = Math.floor((t - (line.inicio - (n - 1) * spb)) / spb + 1e-3) + 1; // quantas setas acesas
  [...cue.children].forEach((el, j) => {
    el.classList.toggle('on', j < lit && lit < n);
    el.classList.toggle('go', lit >= n);
  });
  cue.hidden = false;
}

// ---------- Salvar ----------
$('save').onclick = async () => {
  if (!S.blob || saving) return;
  const btn = $('save'), label = btn.textContent;
  saving = true; btn.disabled = true; btn.textContent = 'Abrindo…';
  $('final').pause(); // vídeo tocando + compartilhar ao mesmo tempo é o que trava o celular
  try { await saveVideo(); } finally { saving = false; btn.disabled = false; btn.textContent = label; }
};
let saving = false;
async function saveVideo() {
  const name = `video-cover-${S.song.id}.${S.ext}`;
  const file = S.file || new File([S.blob], name, { type: S.blob.type });
  // no celular, "compartilhar" deixa salvar na galeria ou mandar direto para o Instagram
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Meu cover' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  download(S.blob, name);
}
$('saveVoice').onclick = () => {
  const wav = voiceWav();
  if (wav) download(wav, `video-cover-${S.song.id}-voz.wav`);
};
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
// Voz alinhada com a base: começa no mesmo instante da base (já descontando o atraso do microfone)
function voiceWav() {
  if (!S.voice.length) return null;
  const sr = S.ctx.sampleRate, first = S.voice[0].f;
  const end = S.voice[S.voice.length - 1].f + 128;
  const len = Math.max(0, end - S.voiceStartFrame);
  const pcm = new Float32Array(len);
  for (const c of S.voice) {
    for (let k = 0; k < c.d.length; k++) { const i = c.f + k - S.voiceStartFrame; if (i >= 0 && i < len) pcm[i] = c.d[k]; }
  }
  void first;
  const b = new DataView(new ArrayBuffer(44 + len * 2));
  const w = (o, s) => [...s].forEach((ch, i) => b.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); b.setUint32(4, 36 + len * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true); b.setUint32(24, sr, true);
  b.setUint32(28, sr * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); w(36, 'data'); b.setUint32(40, len * 2, true);
  for (let i = 0; i < len; i++) b.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 32767, true);
  return new Blob([b], { type: 'audio/wav' });
}

// ---------- Letra automática (IA ouve a voz separada) ----------
async function autoLyrics(voice, sr, rv) {
  rv.textContent = 'Lendo a letra…';
  try {
    const lines = await transcribe(voice, sr, S.sing.seg, { onProgress: (p) => { rv.textContent = `Lendo a letra… ${Math.round(p * 100)}%`; } });
    if (!lines.length) { rv.textContent = 'Voz separada ✓ (não consegui ler a letra)'; return; }
    setKaraoke(lines);
    rv.textContent = 'Voz separada ✓ Letra pronta ✓';
  } catch (e) {
    console.warn(e);
    rv.textContent = e instanceof SemChave ? 'Voz separada ✓' : 'Voz separada ✓ (letra automática falhou: cole a letra)';
  }
}
// Modo karaokê: a letra com tempo vira as linhas do topo (com as setas e o preenchimento por palavra)
function setKaraoke(lines) {
  S.song.letra = lines;
  const on = !!lines?.length;
  $('lyrics').hidden = !on; $('prompter').hidden = on; $('prow').hidden = on;
  $('pasteBtn').textContent = on ? 'Corrigir letra' : (S.pr.text.trim() ? 'Editar letra' : 'Colar letra');
  renderLyrics(0);
}

// ---------- Teleprompter ----------
// O artista cola a letra; ela sobe pela tela na velocidade que ele escolher, começando depois do atraso
// (para pular a introdução). Dá para arrastar com o dedo para acertar a posição e tocar para pausar.
const PX = 4; // pixels por segundo para cada ponto de velocidade
const prKey = () => 'vc-pr:' + (S.song?.file ? S.song.file.name + ':' + S.song.file.size : S.song?.id);
function setupPrompter(song) {
  const on = !!song.file;
  $('prompter').hidden = !on; $('prow').hidden = !on; $('pasteBtn').hidden = !on; $('lyrics').hidden = on;
  if (on) song.letra = [];
  S.pr = { text: '', speed: 5, delay: 0, pos: 0, paused: false, last: 0, auto: false, off: 0 };
  S.sing = null;
  if (on) {
    try { Object.assign(S.pr, JSON.parse(localStorage.getItem(prKey()) || '{}')); } catch {}
    S.pr.pos = 0; S.pr.paused = false;
  }
  renderPrompterText(); renderPrompterCtl(); placePrompter(); setAuto(false);
}
function savePrompter() {
  try { localStorage.setItem(prKey(), JSON.stringify({ text: S.pr.text, speed: S.pr.speed, delay: S.pr.delay })); } catch {}
}
function renderPrompterText() {
  $('ptext').textContent = S.pr.text;
  $('pempty').hidden = !!S.pr.text.trim();
  $('pasteBtn').textContent = S.pr.text.trim() ? 'Editar letra' : 'Colar letra';
}
function renderPrompterCtl() {
  $('pSpeed').textContent = S.pr.speed;
  $('pDelay').textContent = String(S.pr.delay).replace('.', ',') + 's';
  $('pSlow').disabled = S.pr.speed <= 1; $('pFast').disabled = S.pr.speed >= 20;
  $('dLess').disabled = S.pr.delay <= 0; $('dMore').disabled = S.pr.delay >= 60;
}
function placePrompter() { $('ptext').style.transform = `translateY(${-Math.round(S.pr.pos)}px)`; $('ppause').hidden = !S.pr.paused; }
function resetPrompter() { S.pr.pos = 0; S.pr.off = 0; S.pr.paused = false; S.pr.last = 0; placePrompter(); }
// chamada a cada quadro enquanto a música toca (t = segundos desde o começo da base)
function stepPrompter(t) {
  if ($('prompter').hidden || !S.pr.text) return;
  const now = performance.now(), dt = S.pr.last ? Math.min(0.1, (now - S.pr.last) / 1000) : 0;
  S.pr.last = now;
  if (S.pr.auto && S.sing) {
    // Automático: a letra anda só enquanto o cantor original canta (parada na introdução e nos solos),
    // num ritmo que faz a última linha chegar junto com o fim do canto. Chega um pouquinho antes (LEAD).
    const target = travel() * sungFraction((t + LEAD) * S.speed) + S.pr.off;
    if (S.pr.paused || drag) S.pr.off = S.pr.pos - (target - S.pr.off); // guarda o ajuste do artista
    else S.pr.pos = Math.max(0, Math.min(maxPos(), target));
  } else if (t >= S.pr.delay && !S.pr.paused && !drag) S.pr.pos = Math.min(maxPos(), S.pr.pos + dt * S.pr.speed * PX);
  placePrompter();
}
const LEAD = 0.5;
// quanto da letra precisa passar pela linha de leitura: o texto todo menos a última linha
function travel() {
  const el = $('ptext'), cs = getComputedStyle(el);
  const h = el.scrollHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  return Math.max(0, h - parseFloat(cs.lineHeight || 30));
}
// fração do canto que já aconteceu até o instante x (tempo da música original)
function sungFraction(x) {
  const { seg, total } = S.sing;
  let done = 0;
  for (const [a, b] of seg) { if (x <= a) break; done += Math.min(x, b) - a; }
  return Math.max(0, Math.min(1, done / total));
}

// Acha os trechos com canto na voz separada: volume em janelas de 50 ms, limiar relativo à própria voz,
// junta respiros curtos (< 0,8 s) e ignora ruídos soltos (< 0,3 s).
function findSinging(voice, sr) {
  const hop = Math.round(sr * 0.05), L = voice[0], R = voice[1] || voice[0], n = Math.floor(L.length / hop);
  const db = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let e = 0;
    for (let i = k * hop, j = i + hop; i < j; i++) { const v = (L[i] + R[i]) * 0.5; e += v * v; }
    db[k] = 10 * Math.log10(e / hop + 1e-12);
  }
  const sorted = Float32Array.from(db).sort();
  const loud = sorted[Math.floor(n * 0.95)];
  const thr = Math.max(-50, loud - 22);
  let seg = [], on = -1;
  for (let k = 0; k <= n; k++) {
    const act = k < n && db[k] > thr;
    if (act && on < 0) on = k;
    if (!act && on >= 0) { seg.push([on * 0.05, k * 0.05]); on = -1; }
  }
  const merged = [];
  for (const g of seg) { const last = merged[merged.length - 1]; if (last && g[0] - last[1] < 0.8) last[1] = g[1]; else merged.push(g.slice()); }
  seg = merged.filter(([a, b]) => b - a >= 0.3);
  const total = seg.reduce((x, [a, b]) => x + b - a, 0);
  if (loud < -45 || total < 5) { S.sing = null; setAuto(false); return; } // sem voz (era só a base): fica no manual
  S.sing = { seg, total };
  // o início da letra também fica certo no modo manual: começa onde o canto começa
  S.pr.delay = Math.max(0, Math.round((seg[0][0] - LEAD) * 2) / 2);
  setAuto(true); renderPrompterCtl();
}
function setAuto(on) {
  S.pr.auto = !!on && !!S.sing; S.pr.off = 0;
  $('autoBtn').setAttribute('aria-pressed', S.pr.auto);
  $('autoBtn').disabled = !S.sing;
}
$('autoBtn').onclick = () => setAuto(!S.pr.auto);
const maxPos = () => Math.max(0, $('ptext').scrollHeight - innerHeight * 0.6 - 40);
$('pSlow').onclick = () => { setAuto(false); S.pr.speed = Math.max(1, S.pr.speed - 1); renderPrompterCtl(); savePrompter(); };
$('pFast').onclick = () => { setAuto(false); S.pr.speed = Math.min(20, S.pr.speed + 1); renderPrompterCtl(); savePrompter(); };
$('dLess').onclick = () => { S.pr.delay = Math.max(0, Math.ceil(S.pr.delay) - 1); renderPrompterCtl(); savePrompter(); };
$('dMore').onclick = () => { S.pr.delay = Math.min(60, Math.floor(S.pr.delay) + 1); renderPrompterCtl(); savePrompter(); };
$('pasteBtn').onclick = () => { $('lyricsText').value = S.song?.letra?.length ? S.song.letra.map((l) => l.texto).join('\n') : S.pr.text; $('sheet').hidden = false; setTimeout(() => $('lyricsText').focus(), 50); };
$('sheetCancel').onclick = () => { $('sheet').hidden = true; };
$('sheetSave').onclick = () => {
  const txt = $('lyricsText').value.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
  if (S.song?.letra?.length) {
    // corrigiu a letra da IA: com o mesmo número de linhas, mantém o tempo de cada linha e troca o texto
    const rows = txt.split('\n').map((x) => x.trim()).filter(Boolean);
    if (rows.length === S.song.letra.length) {
      S.song.letra.forEach((l, i) => { if (l.texto !== rows[i]) { l.texto = rows[i]; delete l.palavras; } });
      $('sheet').hidden = true; renderLyrics(0); return;
    }
    setKaraoke(null); // mudou a quantidade de linhas: volta para o teleprompter automático
  }
  S.pr.text = txt;
  $('sheet').hidden = true; resetPrompter(); renderPrompterText(); savePrompter();
};
// arrastar para ajustar a posição; um toque (sem arrastar) pausa ou continua
let drag = null;
$('prompter').addEventListener('pointerdown', (e) => { drag = { y: e.clientY, pos: S.pr.pos, moved: false }; $('prompter').setPointerCapture(e.pointerId); });
$('prompter').addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dy = e.clientY - drag.y;
  if (Math.abs(dy) > 6) drag.moved = true;
  if (drag.moved) { S.pr.pos = Math.max(0, Math.min(maxPos(), drag.pos - dy)); placePrompter(); }
});
const endDrag = () => {
  if (!drag) return;
  const tap = !drag.moved; drag = null;
  if (tap && (S.recording || S.previewing) && S.pr.text) { S.pr.paused = !S.pr.paused; placePrompter(); }
};
$('prompter').addEventListener('pointerup', endDrag);
$('prompter').addEventListener('pointercancel', endDrag);

// Atalho de teste: ?musica=ciranda abre uma base de teste do catálogo
const q = new URLSearchParams(location.search);
if (q.get('musica')) loadCatalog().then(() => { const s = S.catalog.find((x) => x.id === q.get('musica')); if (s) openSong(s); });
window.__vc = S;
