# Video Cover

O artista abre o site no celular, escolhe uma base (playback), ajusta o tom, segue a letra estilo karaokê
e grava o vídeo cantando. A base toca no alto-falante ou no fone para ele cantar no tempo, mas no vídeo
entra a base limpa, direto do arquivo, misturada com a voz. Depois oferecemos o Studio Cover para afinar
e masterizar.

## Fluxo atual (teste)

O artista sobe a música dele (com ou sem voz), toca em **Separar voz (IA)**, cola a letra no **teleprompter**
(velocidade de rolagem 1–20, atraso do início em segundos, arrastar para ajustar, tocar para pausar; fica salvo
por música no aparelho) e grava: a música começa sozinha depois da contagem. O catálogo de bases de teste
continua no código (`?musica=ciranda`), fora da tela inicial.

## Como funciona

- `index.html`, `css/app.css`, `js/app.js`: o app (sem servidor, roda todo no navegador).
- Câmera frontal + microfone pelo navegador. Sem fone, o cancelamento de eco do celular fica ligado;
  com fone ("Estou de fone"), fica desligado para a voz sair natural.
- Contagem de 5 segundos, a base começa e a letra aparece no topo, perto da câmera frontal
  (o olhar do artista fica na lente).
- Tom: −6 a +6 semitons, e andamento de 75% a 125% (mostra o BPM), um sem mexer no outro
  (`js/pitch.js`, motor Signalsmith Stretch, MIT). A letra acompanha o andamento.
- Marcação de entrada: antes da primeira linha (e depois de pausas) aparecem setas, uma por tempo do
  compasso, acendendo no ritmo; quando todas ficam verdes é hora de cantar. Precisa de `bpm` e `compasso` no catálogo.
- Vídeo final: câmera + voz + base limpa (atrasada o mesmo tanto que a voz leva para entrar, para casar),
  com limitador para não estourar. "Baixar só a voz" entrega a voz crua alinhada com a base (WAV).
- `bases/`: bases de TESTE geradas por `tools/gerar_bases.py` (músicas de domínio público, instrumental
  sintetizado), com a letra sincronizada em `bases/catalogo.json`. Antes de lançar, entram as bases licenciadas.
- "Usar música do meu celular": abre qualquer áudio do aparelho (sem letra). Botão "Tirar a voz do cantor (IA)":
  a IA Spleeter (Deezer, MIT) roda no próprio celular, num Worker (`js/separate.js`, `js/sep-worker.js`), e a base
  vira música − voz. Modelo de ~40 MB em `assets/ai/`, baixado uma vez e guardado no aparelho. Nada vai para servidor.

## Rodar no computador

```
python3 -m http.server 8080   # http://localhost:8080
```

Câmera e microfone só funcionam em `https://` ou `localhost`.
