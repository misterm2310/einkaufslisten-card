Texterkennung (OCR) für „Text aus Foto“ – läuft komplett im Browser, nichts wird ins Internet geschickt.

- tesseract.min.js, worker.min.js   : tesseract.js 7.0.0 (Apache-2.0, siehe LICENSE-tesseract.js.md)
- tesseract-core-simd-lstm.wasm.js  : tesseract.js-core 7.0.0 (Apache-2.0)
- deu.traineddata.gz                : Tesseract „tessdata_best_int“ Deutsch (Apache-2.0), aus @tesseract.js-data/deu 1.0.0

Die Dateien werden nur geladen, wenn jemand „Text aus Foto“ benutzt.
