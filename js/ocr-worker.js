/* Offline receipt reader. Runs Tesseract (WebAssembly) in a background thread.
   All files are served from this app and cached by the service worker,
   so it works with no internet connection. */
/* global TesseractCore */
importScripts('../vendor/tesseract/tesseract-core.js');

const BASE = '../vendor/tesseract/';
let ready = null, M = null, api = null;

async function bytes(name) {
  const r = await fetch(BASE + name);
  if (!r.ok) throw new Error('Missing reader file ' + name + ' (open the app once while online)');
  return new Uint8Array(await r.arrayBuffer());
}

function init() {
  if (ready) return ready;
  ready = (async () => {
    const [wasm, eng, fra] = await Promise.all([
      bytes('tesseract-core.wasm'), bytes('eng.traineddata'), bytes('fra.traineddata')
    ]);
    M = await TesseractCore({ wasmBinary: wasm });
    M.FS.writeFile('eng.traineddata', eng);
    M.FS.writeFile('fra.traineddata', fra);
    api = new M.TessBaseAPI();
    if (api.Init(null, 'eng+fra') !== 0) throw new Error('Text reader failed to start');
  })();
  ready.catch(() => { ready = null; });
  return ready;
}

function recognize(img, psm) {
  M.FS.writeFile('/input', img);
  api.SetPageSegMode(psm);
  api.SetImageFile();
  const text = api.GetUTF8Text();
  const conf = api.MeanTextConf();
  return { text, conf };
}

self.onmessage = async e => {
  const d = e.data;
  try {
    await init();
    if (d.type === 'init') return self.postMessage({ id: d.id, ok: true });
    // PSM 6 = one uniform block of text. On receipts it keeps each label on the
    // same line as its price (automatic layout tends to drop the price column).
    // PSM 4 (single column) is used by the page as a second opinion.
    const psm = d.psm == null ? 6 : d.psm;
    self.postMessage({ id: d.id, ok: true, ...recognize(d.bytes, psm) });
  } catch (err) {
    self.postMessage({ id: d.id, ok: false, error: String((err && err.message) || err) });
  }
};
