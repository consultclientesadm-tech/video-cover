# Video Cover

O artista abre o site no celular, escolhe uma base (playback), ajusta o tom, segue a letra estilo karaokê
e grava o vídeo cantando. A base toca no alto-falante ou no fone para ele cantar no tempo, mas no vídeo
entra a base limpa, direto do arquivo, misturada com a voz. Depois oferecemos o Studio Cover para afinar
e masterizar.

## Como funciona

- `index.html`, `css/app.css`, `js/app.js`: o app (sem servidor, roda todo no navegador).
- Câmera frontal + microfone pelo navegador. Sem fone, o cancelamento de eco do celular fica ligado;
  com fone ("Estou de fone"), fica desligado para a voz sair natural.
- Contagem de 5 segundos, a base começa e a letra aparece no topo, perto da câmera frontal
  (o olhar do artista fica na lente).
- Tom: −6 a +6 semitons, sem mudar a velocidade (`js/pitch.js`, motor Signalsmith Stretch, MIT).
- Vídeo final: câmera + voz + base limpa (atrasada o mesmo tanto que a voz leva para entrar, para casar),
  com limitador para não estourar. "Baixar só a voz" entrega a voz crua alinhada com a base (WAV).
- `bases/`: bases de TESTE geradas por `tools/gerar_bases.py` (músicas de domínio público, instrumental
  sintetizado), com a letra sincronizada em `bases/catalogo.json`. Antes de lançar, entram as bases licenciadas.
- "Usar minha base": abre qualquer áudio do celular (sem letra).

## Rodar no computador

```
python3 -m http.server 8080   # http://localhost:8080
```

Câmera e microfone só funcionam em `https://` ou `localhost`.
