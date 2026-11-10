// On-device storage in IndexedDB (survives restarts, holds receipt photos without
// hitting the ~5 MB localStorage limit). Everything stays on the phone.

const DB_NAME = 'cash-budget';
const DB_VERSION = 1;
let dbp = null;

function req2p(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('tx')) db.createObjectStore('tx', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('img')) db.createObjectStore('img');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('Storage is busy — close other tabs of this app'));
  });
  dbp.catch(() => { dbp = null; });
  return dbp;
}
async function run(stores, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(stores, mode);
    let out;
    Promise.resolve(fn(t)).then(v => { out = v; }, rej);
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Storage write cancelled'));
  });
}

export async function getMeta(key) {
  return run(['meta'], 'readonly', t => req2p(t.objectStore('meta').get(key)));
}
export async function setMeta(key, value) {
  return run(['meta'], 'readwrite', t => { t.objectStore('meta').put(value, key); });
}
export async function allTx() {
  return run(['tx'], 'readonly', t => req2p(t.objectStore('tx').getAll()));
}
export async function putTx(tx, img) {
  return run(['tx', 'img', 'meta'], 'readwrite', t => {
    t.objectStore('tx').put(tx);
    if (img !== undefined) {
      if (img) t.objectStore('img').put(img, tx.id); else t.objectStore('img').delete(tx.id);
    }
    t.objectStore('meta').put(Date.now(), 'updatedAt');
  });
}
export async function deleteTx(id) {
  return run(['tx', 'img', 'meta'], 'readwrite', t => {
    t.objectStore('tx').delete(id);
    t.objectStore('img').delete(id);
    t.objectStore('meta').put(Date.now(), 'updatedAt');
  });
}
export async function getImg(id) {
  return run(['img'], 'readonly', t => req2p(t.objectStore('img').get(id)));
}
export async function allImgs() {
  return run(['img'], 'readonly', async t => {
    const s = t.objectStore('img');
    const [keys, vals] = await Promise.all([req2p(s.getAllKeys()), req2p(s.getAll())]);
    const out = {};
    keys.forEach((k, i) => { out[k] = vals[i]; });
    return out;
  });
}

/** Replace or merge a whole dataset {budget?, tx[], imgs{}}. */
export async function importData(data, mode = 'replace') {
  return run(['tx', 'img', 'meta'], 'readwrite', async t => {
    const txs = t.objectStore('tx'), imgs = t.objectStore('img'), meta = t.objectStore('meta');
    const images = data.imgs || {};
    if (mode === 'replace') {
      txs.clear(); imgs.clear();
      if (data.budget != null) meta.put(Number(data.budget) || 0, 'budget');
    }
    let added = 0, updated = 0;
    const existing = mode === 'merge' ? new Map((await req2p(txs.getAll())).map(x => [x.id, x])) : new Map();
    for (const raw of data.tx || []) {
      const tx = normaliseTx(raw);
      if (!tx) continue;
      const old = existing.get(tx.id);
      if (old && (old.updated || old.created || '') >= (tx.updated || tx.created || '')) continue;
      tx.hasImg = !!images[tx.id] || !!(old && old.hasImg);
      txs.put(tx);
      if (images[tx.id]) imgs.put(images[tx.id], tx.id);
      old ? updated++ : added++;
    }
    meta.put(Date.now(), 'updatedAt');
    return { added, updated };
  });
}

export async function clearTx() {
  return run(['tx', 'img', 'meta'], 'readwrite', t => {
    t.objectStore('tx').clear(); t.objectStore('img').clear();
    t.objectStore('meta').put(Date.now(), 'updatedAt');
  });
}

export function normaliseTx(t) {
  if (!t || typeof t !== 'object') return null;
  const amount = Math.round(Number(t.amount) * 1000) / 1000;
  if (!(amount > 0)) return null;
  const type = t.type === 'income' ? 'income' : 'expense';
  return {
    id: String(t.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 7))),
    type,
    amount,
    cat: type === 'income' ? 'income' : String(t.cat || 'other'),
    note: String(t.note || '').slice(0, 200),
    date: /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : new Date().toISOString().slice(0, 10),
    created: t.created || new Date().toISOString(),
    updated: t.updated || t.created || new Date().toISOString(),
    hasImg: !!t.hasImg
  };
}

/** Ask the browser not to evict our data under storage pressure. */
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch (e) { /* not supported */ }
  return false;
}
