// Main-thread side of the offline receipt reader.
import { findTotals, guessShop } from './receipt-parser.js';

let worker = null, seq = 0, readyP = null;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./ocr-worker.js', import.meta.url));
  worker.onmessage = e => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    e.data.ok ? p.res(e.data) : p.rej(new Error(e.data.error));
  };
  worker.onerror = ev => {
    pending.forEach(p => p.rej(new Error(ev.message || 'Text reader crashed')));
    pending.clear(); worker = null; readyP = null;
  };
  return worker;
}
function call(msg, transfer) {
  return new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    getWorker().postMessage({ ...msg, id }, transfer || []);
  });
}

/** Load the engine in the background so the first scan is quicker. */
export function warmUp() {
  if (!readyP) {
    readyP = call({ type: 'init' });
    readyP.catch(() => { readyP = null; });
  }
  return readyP;
}

export function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => res({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not open that image')); };
    img.src = url;
  });
}
export function drawScaled(img, maxSide) {
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const s = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}
// Grayscale + contrast stretch: helps faded thermal paper and dim photos
export function preprocess(img) {
  const c = drawScaled(img, 2000), ctx = c.getContext('2d', { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, c.width, c.height), p = d.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < p.length; i += 4) {
    const g = (0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]) | 0;
    p[i] = g; hist[g]++;
  }
  // Ignore the darkest/brightest 1% so a dark table edge doesn't ruin the stretch
  const n = p.length / 4; let lo = 0, hi = 255, acc = 0;
  for (; lo < 255 && (acc += hist[lo]) < n * 0.01; lo++);
  acc = 0; for (; hi > 0 && (acc += hist[hi]) < n * 0.01; hi--);
  const r = Math.max(1, hi - lo);
  for (let i = 0; i < p.length; i += 4) {
    const g = Math.max(0, Math.min(255, (p[i] - lo) / r * 255));
    p[i] = p[i + 1] = p[i + 2] = g;
  }
  ctx.putImageData(d, 0, 0);
  return c;
}
const toBytes = c => new Promise((res, rej) => c.toBlob(
  b => b ? b.arrayBuffer().then(ab => res(new Uint8Array(ab)), rej) : rej(new Error('Could not process image')),
  'image/png'));

/**
 * Read a receipt image. Returns {text, candidates, shop, cat}.
 * onStage(label) is called as work progresses.
 */
export async function readReceipt(img, onStage = () => {}) {
  onStage('Starting text reader…');
  await warmUp();
  onStage('Reading receipt…');
  const canvas = preprocess(img);
  const bytes = await toBytes(canvas);
  let { text } = await call({ type: 'recognize', bytes: bytes.slice(), psm: 6 }, []);
  let candidates = findTotals(text);
  if (!candidates.length) {
    onStage('Looking again…');
    const second = await call({ type: 'recognize', bytes, psm: 4 }, [bytes.buffer]);
    text = text + '\n' + second.text;
    candidates = findTotals(second.text);
  }
  const { shop, cat } = guessShop(text);
  return { text, candidates, shop, cat };
}
