# Gera bases instrumentais de teste (músicas de domínio público) + letra sincronizada.
# python3 tools/gerar_bases.py  ->  bases/*.mp3 e bases/catalogo.json
import numpy as np, json, subprocess, os, wave
SR = 44100
rng = np.random.default_rng(7)
NOTE = {'C':0,'C#':1,'Db':1,'D':2,'Eb':3,'E':4,'F':5,'F#':6,'Gb':6,'G':7,'Ab':8,'A':9,'Bb':10,'B':11}
def chord_notes(name):
    r = name[0] + (name[1] if len(name) > 1 and name[1] in '#b' else '')
    q = name[len(r):]
    root = NOTE[r]
    iv = [0, 3, 7] if q.startswith('m') and not q.startswith('maj') else [0, 4, 7]
    if '7' in q: iv = iv + [10]
    return root, iv
def hz(m): return 440.0 * 2 ** ((m - 69) / 12)

def ks(freq, dur, bright=0.5, decay=0.996, amp=1.0):
    """Corda dedilhada (Karplus-Strong), vetorizada por período."""
    n = int(dur * SR); N = max(2, int(SR / freq))
    buf = rng.uniform(-1, 1, N)
    # pluck mais macio: suaviza o ruído inicial
    for _ in range(int(3 * (1 - bright)) + 1): buf = 0.5 * (buf + np.roll(buf, 1))
    out = np.zeros(n + N + 1); out[:N] = buf
    i = N
    while i < n:
        j = min(i + N, n)
        prev = out[i - N:j - N]; prev2 = out[i - N - 1:j - N - 1] if i - N - 1 >= 0 else np.concatenate([[0], out[i - N:j - N - 1]])
        out[i:j] = decay * 0.5 * (prev + prev2)
        i = j
    out = out[:n]
    env = np.minimum(1, np.arange(n) / (0.002 * SR))
    return out * env * amp

def piano(freq, dur, amp=1.0):
    n = int(dur * SR); t = np.arange(n) / SR
    s = sum(a * np.sin(2 * np.pi * freq * k * t) * np.exp(-t * (1.2 + 1.6 * k)) for k, a in [(1, 1), (2, .45), (3, .22), (4, .1), (5, .05)])
    att = np.minimum(1, t / 0.004)
    rel = np.minimum(1, (dur - t) / 0.08).clip(0)
    return s * att * rel * amp

def pad(freqs, dur, amp=1.0):
    n = int(dur * SR); t = np.arange(n) / SR
    s = np.zeros(n)
    for f in freqs:
        for det in (-0.12, 0.12):
            ff = f * 2 ** (det / 12)
            s += np.sin(2 * np.pi * ff * t) + 0.3 * np.sin(4 * np.pi * ff * t)
    env = np.minimum(1, t / 0.35) * np.minimum(1, (dur - t) / 0.3).clip(0)
    return s / len(freqs) * env * amp

def kick(amp=1.0):
    n = int(0.35 * SR); t = np.arange(n) / SR
    f = 50 + 90 * np.exp(-t * 30)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9) * amp
def snare(amp=1.0):
    n = int(0.25 * SR); t = np.arange(n) / SR
    nz = rng.uniform(-1, 1, n); nz = nz - np.concatenate([[0], nz[:-1]]) * 0.6
    return (0.7 * nz * np.exp(-t * 18) + 0.4 * np.sin(2 * np.pi * 190 * t) * np.exp(-t * 25)) * amp
def hat(amp=1.0):
    n = int(0.06 * SR); t = np.arange(n) / SR
    nz = rng.uniform(-1, 1, n); nz = nz - np.concatenate([[0], nz[:-1]])
    return nz * np.exp(-t * 70) * amp
def shaker(amp=1.0):
    n = int(0.09 * SR); t = np.arange(n) / SR
    nz = rng.uniform(-1, 1, n); nz = nz - np.concatenate([[0], nz[:-1]])
    return nz * np.sin(np.pi * t / t[-1]) * amp

def put(track, sig, at, pan=0.0):
    i = int(at * SR)
    if i >= track.shape[1]: return
    j = min(track.shape[1], i + len(sig))
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    track[0, i:j] += sig[:j - i] * l * 1.41
    track[1, i:j] += sig[:j - i] * r * 1.41

def voicing(root, iv, low=52, high=67):
    notes = []
    for x in iv:
        m = 48 + (root + x) % 12
        while m < low: m += 12
        notes.append(m)
    return sorted(notes)

def reverb(x, secs=1.6, mix=0.18):
    n = int(secs * SR); t = np.arange(n) / SR
    ir = np.stack([rng.uniform(-1, 1, n), rng.uniform(-1, 1, n)]) * np.exp(-t * 6.9 / secs)
    ir[:, :int(0.01 * SR)] *= np.linspace(0, 1, int(0.01 * SR))
    L = x.shape[1] + n
    F = 1 << (L - 1).bit_length()
    wet = np.stack([np.fft.irfft(np.fft.rfft(x[c], F) * np.fft.rfft(ir[c], F), F)[:x.shape[1]] for c in range(2)])
    wet /= np.max(np.abs(wet)) + 1e-9
    return x + wet * mix * np.max(np.abs(x))

def render(song):
    bpm, beats = song['bpm'], song['compasso']
    spb = 60 / bpm; bar = spb * beats
    bars = []  # (chord, label)
    for sec in song['estrutura']: bars += sec
    total = len(bars) * bar + 3.5
    tr = np.zeros((2, int(total * SR)))
    style = song['estilo']
    for bi, ch in enumerate(bars):
        t0 = bi * bar
        if ch in ('-', None): continue
        root, iv = chord_notes(ch)
        bass = 36 + root if 36 + root >= 40 else 48 + root
        bass = 36 + root
        if bass < 38: bass += 12
        vo = voicing(root, iv)
        last = bi == len(bars) - 1
        if style == 'valsa':
            put(tr, piano(hz(bass), bar if last else spb * 1.5, .55), t0, -0.1)
            put(tr, pad([hz(m) for m in vo], bar + (2.5 if last else 0.05), .16), t0, 0.0)
            if not last:
                for b in (1, 2):
                    for k, m in enumerate(vo): put(tr, piano(hz(m + 12), spb * .95, .14), t0 + b * spb + k * 0.012, 0.25)
            else:
                for k, m in enumerate(vo): put(tr, piano(hz(m + 12), 3.0, .18), t0 + k * 0.03, 0.25)
        else:  # violão + baixo + percussão leve
            if last:
                put(tr, ks(hz(bass), 3.0, .3, .9985, .7), t0, -0.05)
                for k, m in enumerate(vo + [vo[0] + 12]): put(tr, ks(hz(m), 3.0, .6, .998, .3), t0 + k * 0.018, 0.3)
                put(tr, kick(.7), t0)
                continue
            # baixo nos tempos 1 e 3 (fundamental e quinta)
            put(tr, ks(hz(bass), spb * 1.9, .2, .9985, .75), t0, -0.05)
            if beats == 4: put(tr, ks(hz(bass + 7 - (12 if bass + 7 > 52 else 0)), spb * 1.9, .2, .9985, .65), t0 + 2 * spb, -0.05)
            # batida de violão: B . b c b c (baixo-cima)
            pattern = [(0.0, 'd', .32), (1.0, 'd', .26), (1.5, 'u', .18), (2.0, 'd', .3), (2.5, 'u', .16), (3.0, 'd', .26), (3.5, 'u', .18)]
            for pos, d, a in pattern:
                if pos >= beats: continue
                strings = vo + [vo[0] + 12] if d == 'd' else (vo + [vo[0] + 12])[::-1][:3]
                for k, m in enumerate(strings):
                    put(tr, ks(hz(m), spb * .9, .55, .997, a), t0 + pos * spb + k * 0.011, 0.3 if d == 'd' else 0.35)
            # percussão
            for b in range(beats):
                if b % 2 == 0: put(tr, kick(.55), t0 + b * spb)
                else: put(tr, snare(.22), t0 + b * spb, 0.1)
                put(tr, shaker(.07), t0 + b * spb, -0.4); put(tr, shaker(.05), t0 + (b + .5) * spb, -0.4)
    tr = reverb(tr, 1.4 if style != 'valsa' else 2.2, 0.16 if style != 'valsa' else 0.25)
    tr = np.tanh(tr / np.max(np.abs(tr)) * 1.2) * 0.89
    tr /= np.max(np.abs(tr)) / 0.89
    # letra: cada linha começa no compasso indicado (com anacruse opcional, em tempos)
    linhas = []
    for ln in song['letra']:
        s = ln['compasso'] * bar - ln.get('anacruse', 0) * spb
        e = s + ln['compassos'] * bar
        linhas.append({'inicio': round(s, 3), 'fim': round(e, 3), 'texto': ln['texto']})
    return tr, linhas, total

def lines(versos, first_bar, bars_per_line, anac=0):
    out, b = [], first_bar
    for v in versos:
        for t in v:
            out.append({'compasso': b, 'compassos': bars_per_line, 'texto': t, 'anacruse': anac}); b += bars_per_line
    return out

SONGS = []
# 1) Ciranda, cirandinha (tradicional brasileira) — Dó maior, 4/4
v_cir = [["Ciranda, cirandinha", "vamos todos cirandar", "vamos dar a meia volta", "volta e meia vamos dar"],
         ["O anel que tu me deste", "era vidro e se quebrou", "o amor que tu me tinhas", "era pouco e se acabou"],
         ["Por isso, dona Rosa", "entre dentro desta roda", "diga um verso bem bonito", "diga adeus e vá-se embora"]]
estr = [['C', 'G7']] + [['C', 'G7', 'G7', 'C', 'C', 'G7', 'G7', 'C']] * 3 + [['C']]
SONGS.append({'id': 'ciranda', 'titulo': 'Ciranda, Cirandinha', 'artista': 'Domínio público', 'tom': 'C', 'bpm': 104, 'compasso': 4,
              'estilo': 'violao', 'estrutura': estr, 'letra': lines(v_cir, 2, 2)})
# 2) Peixe vivo (tradicional mineira) — Sol maior, 4/4
v_pei = [["Como pode o peixe vivo", "viver fora da água fria?", "Como pode o peixe vivo", "viver fora da água fria?",
          "Como poderei viver,", "como poderei viver", "sem a tua, sem a tua,", "sem a tua companhia?"],
         ["Os pastores desta aldeia", "já me fazem zombaria", "Os pastores desta aldeia", "já me fazem zombaria",
          "por me ver assim chorando,", "por me ver assim chorando", "sem a tua, sem a tua,", "sem a tua companhia"]]
verse_p = ['G', 'D7', 'D7', 'G', 'G', 'D7', 'D7', 'G', 'C', 'G', 'D7', 'G', 'C', 'G', 'D7', 'G']
estr = [['G', 'D7']] + [verse_p] * 2 + [['G']]
SONGS.append({'id': 'peixe-vivo', 'titulo': 'Peixe Vivo', 'artista': 'Domínio público', 'tom': 'G', 'bpm': 96, 'compasso': 4,
              'estilo': 'violao', 'estrutura': estr, 'letra': lines(v_pei, 2, 2)})
# 3) Amazing Grace (hino, John Newton 1779) — Sol maior, 3/4, com anacruse de 1 tempo
v_ama = [["Amazing grace, how sweet the sound", "that saved a wretch like me", "I once was lost, but now am found", "was blind, but now I see"],
         ["'Twas grace that taught my heart to fear", "and grace my fears relieved", "how precious did that grace appear", "the hour I first believed"],
         ["Through many dangers, toils and snares", "I have already come", "'tis grace hath brought me safe thus far", "and grace will lead me home"]]
verse_a = ['G', 'G7', 'C', 'G', 'G', 'G', 'D', 'D', 'G', 'G7', 'C', 'G', 'G', 'D', 'G', 'G']
estr = [['G', 'C', 'G', 'D']] + [verse_a] * 3 + [['G']]
SONGS.append({'id': 'amazing-grace', 'titulo': 'Amazing Grace', 'artista': 'Domínio público (hino)', 'tom': 'G', 'bpm': 84, 'compasso': 3,
              'estilo': 'valsa', 'estrutura': estr, 'letra': lines(v_ama, 4, 4, anac=1)})

here = os.path.dirname(os.path.abspath(__file__)); outdir = os.path.join(here, '..', 'bases')
os.makedirs(outdir, exist_ok=True)
cat = []
for s in SONGS:
    tr, letra, total = render(s)
    wav = os.path.join('/tmp', s['id'] + '.wav')
    with wave.open(wav, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((tr.T * 32767).astype('<i2').tobytes())
    mp3 = os.path.join(outdir, s['id'] + '.mp3')
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', wav, '-b:a', '160k', mp3], check=True)
    cat.append({'id': s['id'], 'titulo': s['titulo'], 'artista': s['artista'], 'tom': s['tom'], 'bpm': s['bpm'],
                'arquivo': 'bases/' + s['id'] + '.mp3', 'duracao': round(total, 2), 'letra': letra})
    print(s['id'], round(total, 1), 's')
with open(os.path.join(outdir, 'catalogo.json'), 'w', encoding='utf-8') as f:
    json.dump(cat, f, ensure_ascii=False, indent=1)
