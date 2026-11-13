# Bibliotecas de terceiros (código aberto)

- `stretch.js` — Signalsmith Stretch 1.3.2 (Geraint Luff, licença MIT). Muda tom e andamento.
- `ort/` — ONNX Runtime Web 1.24.3 (Microsoft, licença MIT), versão só-CPU (WebAssembly). Roda a IA no navegador.
- `fft/fft.js` — FFT do demucs-web 1.0.2 (timcsy, licença MIT, ver `fft/LICENSE`).
- `../../assets/ai/spleeter-*.bin` — Spleeter 2 faixas (Deezer, licença MIT), convertido para ONNX (pesos fp16)
  pelo projeto sherpa-onnx (k2-fsa, Apache-2.0): `vocals.fp16.onnx` e `accompaniment.fp16.onnx` renomeados.
- `mediabunny/` — Mediabunny 1.60.0 e @mediabunny/aac-encoder 1.60.0 (Vanilagy, licença MPL-2.0, ver `mediabunny/LICENSE`;
  o codificador AAC usa o libavcodec do FFmpeg, LGPL). Junta o vídeo gravado com o áudio final, sem recomprimir a imagem.
  Única mudança: o import `mediabunny` do codificador aponta para o arquivo local.
