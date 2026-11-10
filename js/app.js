import * as store from './store.js';
import { parseAmount } from './receipt-parser.js';
import { readReceipt, loadImage, drawScaled, warmUp } from './ocr.js';
import { makeBundle, parseImport, encodeLink, decodeLink, shareFile, shareLink } from './share.js';

const APP_VERSION = '2.0.0';
const $ = s => document.querySelector(s);

/* ---------- State ---------- */
let state = { budget: 0, tx: [], cats: [] };
const imgCache = new Map();
const catById = id => state.cats.find(c => c.id === id) || state.cats[state.cats.length - 1] || { id: 'other', name: 'Other', e: '📦' };

/* ---------- Helpers ---------- */
const fmt = n => (Math.round(n * 1000) / 1000).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const plain = n => fmt(n).replace(/,/g, '');
const isoDay = d => { d = new Date(d); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const todayISO = () => isoDay(new Date());
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let toastT;
function toast(msg, ms = 2400) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}
function armed(btn, label, armedLabel, fn) {
  let on = false, timer;
  btn.onclick = () => {
    if (!on) { on = true; btn.textContent = armedLabel; clearTimeout(timer); timer = setTimeout(() => { on = false; btn.textContent = label; }, 3000); return; }
    on = false; btn.textContent = label; fn();
  };
}

/* ---------- Load / seed ---------- */
async function loadState() {
  state.budget = (await store.getMeta('budget')) ?? 0;
  state.cats = (await store.getMeta('categories')) || [];
  state.tx = await store.allTx();
}

// First run: pre-fill from data/seed.json (taken from Tunisia_cash_budget_v1.1.html).
// Also brings across data from the older single-file app if it ran on this same site.
async function seedIfNeeded() {
  if (await store.getMeta('seeded')) return;
  const seed = await (await fetch('data/seed.json')).json();
  await store.setMeta('categories', seed.categories);
  await store.importData({ budget: seed.budget, tx: seed.tx || [] }, 'replace');
  try {
    const legacy = JSON.parse(localStorage.getItem('cashbudget.v1') || 'null');
    if (legacy && Array.isArray(legacy.tx) && legacy.tx.length) {
      const imgs = {};
      legacy.tx.forEach(t => { const im = localStorage.getItem('cashbudget.img.' + t.id); if (im) imgs[t.id] = im; });
      await store.importData({ budget: legacy.budget, tx: legacy.tx, imgs }, 'replace');
    }
  } catch (e) { /* no legacy data */ }
  await store.setMeta('seeded', { at: new Date().toISOString(), from: seed.source, seedVersion: seed.seedVersion });
}

/* ---------- Render ---------- */
function totals() {
  let spent = 0, added = 0;
  state.tx.forEach(t => t.type === 'income' ? added += t.amount : spent += t.amount);
  return { spent, added, available: state.budget + added, remaining: state.budget + added - spent };
}
function render() {
  const { spent, available, remaining } = totals();
  $('#remaining').innerHTML = esc(fmt(remaining)) + '<small>TND</small>';
  $('#remaining').style.color = remaining < 0 ? '#ff9d8c' : '';
  $('#budgetVal').textContent = fmt(available);
  $('#spentVal').textContent = fmt(spent);
  const pct = available > 0 ? spent / available * 100 : (spent > 0 ? 100 : 0);
  $('#pctVal').textContent = Math.round(pct) + '%';
  const bar = $('#bar'); bar.firstElementChild.style.width = Math.min(100, pct) + '%';
  bar.className = 'bar' + (pct >= 100 ? ' over' : pct >= 80 ? ' warn' : '');

  const by = {};
  state.tx.filter(t => t.type !== 'income').forEach(t => by[t.cat] = (by[t.cat] || 0) + t.amount);
  const rows = Object.entries(by).sort((a, b) => b[1] - a[1]);
  $('#catSection').hidden = !rows.length;
  $('#catCount').textContent = rows.length + (rows.length === 1 ? ' category' : ' categories');
  $('#cats').innerHTML = rows.map(([id, v]) => {
    const c = catById(id), w = spent ? v / spent * 100 : 0;
    return `<div class="cat-row"><div class="emoji">${c.e}</div><div>${esc(c.name)}<div class="mini"><i style="width:${w}%"></i></div></div><div class="mono">${fmt(v)}</div></div>`;
  }).join('');

  const list = [...state.tx].sort((a, b) => (b.date + b.created).localeCompare(a.date + a.created));
  $('#txCount').textContent = list.length ? list.length + ' total' : '';
  if (!list.length) {
    $('#list').innerHTML = `<div class="card empty">No cash spent yet.<br>Take a photo of a receipt or tap <b>Add cash expense</b>.</div>`;
    return;
  }
  const groups = {};
  list.forEach(t => (groups[t.date] = groups[t.date] || []).push(t));
  const today = todayISO(), yest = isoDay(Date.now() - 864e5);
  $('#list').innerHTML = Object.entries(groups).map(([day, items]) => {
    const label = day === today ? 'Today' : day === yest ? 'Yesterday' : new Date(day + 'T12:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const dayTotal = items.filter(t => t.type !== 'income').reduce((s, t) => s + t.amount, 0);
    return `<div class="day">${label}${dayTotal ? ` · ${fmt(dayTotal)} TND` : ''}</div><div class="card">` + items.map(t => {
      const c = catById(t.cat);
      const title = t.note || (t.type === 'income' ? 'Cash added' : c.name);
      const sub = t.type === 'income' ? 'Top-up' : c.name + (t.hasImg ? ' · receipt' : '');
      return `<div class="tx ${t.type === 'income' ? 'income' : ''}" data-id="${esc(t.id)}">
        <div class="ic">${t.type === 'income' ? '💰' : c.e}</div>
        <div><div class="t">${esc(title)}</div><div class="s">${esc(sub)}</div></div>
        <div class="amt mono">${t.type === 'income' ? '+' : '−'}${fmt(t.amount)}</div></div>`;
    }).join('') + `</div>`;
  }).join('');
  // Load receipt thumbnails after the list is on screen
  list.filter(t => t.hasImg).forEach(async t => {
    let src = imgCache.get(t.id);
    if (!src) { src = await store.getImg(t.id); if (src) imgCache.set(t.id, src); }
    const ic = src && document.querySelector(`.tx[data-id="${CSS.escape(t.id)}"] .ic`);
    if (ic) ic.innerHTML = `<img src="${src}" alt="">`;
  });
}

/* ---------- Sheets ---------- */
function openSheet(id) { $('#backdrop').classList.add('show'); $(id).classList.add('show'); }
function closeSheets() {
  $('#backdrop').classList.remove('show');
  document.querySelectorAll('.sheet').forEach(s => s.classList.remove('show'));
  if (draft) draft.token = null;
}
$('#backdrop').onclick = closeSheets;
document.querySelectorAll('[data-close]').forEach(b => b.onclick = closeSheets);

let draft = null; // {id?, type, cat, img, token}
function setType(type) {
  draft.type = type;
  document.querySelectorAll('#typeSeg button').forEach(b => b.classList.toggle('on', b.dataset.type === type));
  $('#catField').hidden = type === 'income';
  $('#entryTitle').textContent = draft.id ? (type === 'income' ? 'Edit top-up' : 'Edit expense') : (type === 'income' ? 'Add cash' : 'New expense');
}
document.querySelectorAll('#typeSeg button').forEach(b => b.onclick = () => setType(b.dataset.type));
function renderCatChips() {
  $('#catChips').innerHTML = state.cats.map(c => `<button class="chip ${draft.cat === c.id ? 'on' : ''}" data-cat="${c.id}">${c.e} ${esc(c.name)}</button>`).join('');
  $('#catChips').querySelectorAll('.chip').forEach(b => b.onclick = () => { draft.cat = b.dataset.cat; renderCatChips(); });
}
async function openEntry(tx) {
  draft = tx ? { id: tx.id, type: tx.type, cat: tx.cat, img: undefined }
             : { type: 'expense', cat: 'groceries', img: null };
  $('#fAmount').value = tx ? plain(tx.amount) : '';
  $('#fNote').value = tx ? (tx.note || '') : '';
  $('#fDate').value = tx ? tx.date : todayISO();
  $('#deleteEntry').hidden = !tx;
  $('#receiptBox').innerHTML = '';
  setType(draft.type); renderCatChips();
  openSheet('#entrySheet');
  if (tx && tx.hasImg) {
    const src = imgCache.get(tx.id) || await store.getImg(tx.id);
    if (src && draft.id === tx.id) {
      $('#receiptBox').innerHTML = `<div class="receipt"><img src="${src}" alt="Receipt"><div class="info"><div class="status">Receipt attached</div><div class="note">Tap to enlarge.</div></div></div>`;
      bindReceiptZoom();
    }
  }
}
function bindReceiptZoom() {
  const im = $('#receiptBox img');
  if (im) im.onclick = () => { $('#viewer img').src = im.src; $('#viewer').classList.add('show'); };
}
$('#viewer').onclick = () => $('#viewer').classList.remove('show');
$('#addBtn').onclick = () => openEntry(null);
$('#cancelEntry').onclick = closeSheets;
$('#list').onclick = e => {
  const el = e.target.closest('.tx');
  if (el) { const t = state.tx.find(x => x.id === el.dataset.id); if (t) openEntry(t); }
};

$('#saveEntry').onclick = async () => {
  const amount = parseAmount($('#fAmount').value);
  if (!(amount > 0)) { toast('Enter an amount'); $('#fAmount').focus(); return; }
  const old = draft.id ? state.tx.find(t => t.id === draft.id) : null;
  const now = new Date().toISOString();
  const rec = {
    id: draft.id || uid(),
    type: draft.type,
    amount: Math.round(amount * 1000) / 1000,
    cat: draft.type === 'income' ? 'income' : draft.cat,
    note: $('#fNote').value.trim(),
    date: $('#fDate').value || todayISO(),
    created: old ? old.created : now,
    updated: now,
    hasImg: draft.img ? true : !!(old && old.hasImg)
  };
  try {
    await store.putTx(rec, draft.img || undefined);
  } catch (e) {
    if (draft.img) { // most likely out of space: keep the entry, drop the photo
      rec.hasImg = !!(old && old.hasImg);
      await store.putTx(rec);
      toast('Saved, but storage is full, so the receipt photo was not kept');
    } else { toast('Could not save: ' + e.message); return; }
  }
  if (draft.img) imgCache.set(rec.id, draft.img);
  const i = state.tx.findIndex(t => t.id === rec.id);
  if (i > -1) state.tx[i] = rec; else state.tx.push(rec);
  closeSheets(); render();
  toast(rec.type === 'income' ? 'Cash added' : `−${fmt(rec.amount)} TND saved`);
};
armed($('#deleteEntry'), 'Delete', 'Tap again to delete', async () => {
  await store.deleteTx(draft.id);
  imgCache.delete(draft.id);
  state.tx = state.tx.filter(t => t.id !== draft.id);
  closeSheets(); render(); toast('Deleted');
});

/* ---------- Receipt photo → amount ---------- */
async function handleReceipt(file) {
  if (!file) return;
  let loaded;
  try { loaded = await loadImage(file); } catch (e) { toast(e.message); return; }
  await openEntry(null);
  const thumb = drawScaled(loaded.img, 1000).toDataURL('image/jpeg', 0.6);
  draft.img = thumb;
  const token = draft.token = {};
  const live = () => draft && draft.token === token;
  $('#receiptBox').innerHTML = `<div class="receipt"><img src="${thumb}" alt="Receipt"><div class="info">
    <div class="status" id="ocrStatus">Starting text reader…</div>
    <div class="progress busy"><i></i></div>
    <div class="note" id="ocrNote">Runs on your phone, no internet needed.</div>
    <div class="cand" id="ocrCand"></div><div id="ocrRaw"></div></div></div>`;
  bindReceiptZoom();
  const setStatus = (s, n) => {
    if (!live()) return;
    $('#ocrStatus').textContent = s;
    if (n != null) $('#ocrNote').textContent = n;
  };
  const done = () => { const p = $('#receiptBox .progress'); if (p) { p.classList.remove('busy'); p.firstElementChild.style.width = '100%'; } };
  try {
    const r = await readReceipt(loaded.img, s => setStatus(s));
    URL.revokeObjectURL(loaded.url);
    if (!live()) return;
    done();
    $('#ocrRaw').innerHTML = `<details><summary>See scanned text</summary><pre>${esc(r.text.trim() || '(nothing found)')}</pre></details>`;
    if (!$('#fNote').value && r.shop) $('#fNote').value = r.shop;
    if (r.cat && state.cats.some(c => c.id === r.cat)) { draft.cat = r.cat; renderCatChips(); }
    if (!r.candidates.length) {
      setStatus('Couldn’t find a total', 'Type the amount. Tap the photo to zoom in.');
      $('#fAmount').focus();
      return;
    }
    $('#fAmount').value = plain(r.candidates[0]);
    $('#receiptBox').dataset.total = r.candidates[0];
    setStatus(`Total found: ${fmt(r.candidates[0])} TND`, r.candidates.length > 1 ? 'Not right? Tap another amount or type it.' : 'Check it matches, then save.');
    const box = $('#ocrCand');
    box.innerHTML = r.candidates.map((v, i) => `<button class="${i === 0 ? 'best' : ''}" data-v="${v}">${fmt(v)}</button>`).join('');
    box.querySelectorAll('button').forEach(b => b.onclick = () => {
      $('#fAmount').value = plain(+b.dataset.v);
      box.querySelectorAll('button').forEach(x => x.classList.toggle('best', x === b));
    });
  } catch (e) {
    console.error(e);
    done();
    setStatus('Couldn’t read this receipt', (e && e.message) || 'Type the amount instead.');
  }
}
for (const id of ['#camInput', '#rollInput']) {
  $(id).onchange = e => { const f = e.target.files[0]; e.target.value = ''; handleReceipt(f); };
}

/* ---------- Sharing ---------- */
async function bundle(withPhotos) {
  let name = '';
  try { name = localStorage.getItem('cashbudget.name') || ''; } catch (e) { /* ignore */ }
  return makeBundle({ budget: state.budget, tx: state.tx, imgs: withPhotos ? await store.allImgs() : {}, from: name });
}
function rememberName() {
  try { localStorage.setItem('cashbudget.name', $('#shareName').value.trim()); } catch (e) { /* ignore */ }
}
$('#shareBtn').onclick = () => {
  try { $('#shareName').value = localStorage.getItem('cashbudget.name') || ''; } catch (e) { /* ignore */ }
  openSheet('#shareSheet');
};
$('#shareFileBtn').onclick = async () => {
  rememberName();
  const b = await bundle($('#incPhotos').checked);
  const blob = new Blob([JSON.stringify(b)], { type: 'application/json' });
  const r = await shareFile(blob, `cash-budget-${todayISO()}.json`, 'Cash Budget');
  if (r === 'saved') toast(`File saved (${(blob.size / 1048576).toFixed(1)} MB). Send it to them`);
  if (r !== 'cancelled') closeSheets();
};
$('#shareLinkBtn').onclick = async () => {
  rememberName();
  const url = await encodeLink(await bundle(false), location.href);
  if (url.length > 60000) { toast('Too many entries for a link. Use "Share as file"'); return; }
  const r = await shareLink(url, 'Cash Budget', 'My cash budget. Open to import it:');
  if (r === 'copied') toast('Link copied. Paste it into a message');
  if (r === 'failed') toast('Could not share the link on this browser');
  if (r !== 'cancelled') closeSheets();
};
$('#shareTextBtn').onclick = async () => {
  const { spent, available, remaining } = totals();
  const by = {};
  state.tx.filter(t => t.type !== 'income').forEach(t => by[t.cat] = (by[t.cat] || 0) + t.amount);
  const lines = [
    `💵 Cash budget, ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`,
    `Budget: ${fmt(available)} TND`, `Spent: ${fmt(spent)} TND`, `Left: ${fmt(remaining)} TND`, '',
    ...Object.entries(by).sort((a, b) => b[1] - a[1]).map(([id, v]) => `${catById(id).e} ${catById(id).name}: ${fmt(v)} TND`)
  ];
  const text = lines.join('\n');
  try {
    if (navigator.share) await navigator.share({ title: 'Cash budget', text });
    else { await navigator.clipboard.writeText(text); toast('Summary copied'); }
    closeSheets();
  } catch (e) { if (!(e && e.name === 'AbortError')) toast('Could not share'); }
};

/* ---------- Import (files and links) ---------- */
function offerImport(data, sourceLabel) {
  const b = $('#importBanner');
  const n = data.tx.length, who = data.from ? ` from <b>${esc(data.from)}</b>` : '';
  const photos = Object.keys(data.imgs || {}).length;
  b.innerHTML = `<b>${esc(sourceLabel)}</b>${who}: ${n} ${n === 1 ? 'entry' : 'entries'}${data.budget != null ? `, budget ${fmt(data.budget)} TND` : ''}${photos ? `, ${photos} receipt photos` : ''}.
    ${state.tx.length ? 'Add them to yours, or replace yours?' : ''}
    <div class="row2">${state.tx.length ? '<button class="btn" id="impMerge">Add to mine</button><button class="btn secondary" id="impReplace">Replace mine</button>' : '<button class="btn" id="impReplace">Import</button><span></span>'}</div>
    <div style="text-align:right;margin-top:6px"><button class="linkbtn" id="impCancel">Ignore</button></div>`;
  b.hidden = false;
  window.scrollTo(0, 0); // banner sits under the summary card
  const finish = async mode => {
    const r = await store.importData(data, mode);
    imgCache.clear();
    await loadState(); render();
    b.hidden = true;
    toast(mode === 'replace' ? `Imported ${r.added} entries` : `Added ${r.added} new, updated ${r.updated}`);
  };
  if ($('#impMerge')) $('#impMerge').onclick = () => finish('merge');
  $('#impReplace').onclick = () => finish('replace');
  $('#impCancel').onclick = () => { b.hidden = true; };
}
$('#importInput').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const data = parseImport(await f.text());
    closeSheets();
    offerImport(data, 'Shared file');
  } catch (err) { toast(err.message && err.message.length < 80 ? err.message : 'That file is not a Cash Budget backup'); }
};
async function checkLinkImport() {
  if (!/share=/.test(location.hash)) return;
  try {
    const data = await decodeLink(location.hash);
    history.replaceState(null, '', location.pathname + location.search);
    if (data) offerImport(data, 'Shared link');
  } catch (e) { toast('That share link is damaged'); }
}

/* ---------- Settings ---------- */
$('#openSettings').onclick = async () => {
  $('#sBudget').value = plain(state.budget);
  $('#versionNote').textContent = `Cash Budget ${APP_VERSION}`;
  openSheet('#settingsSheet'); // open right away; the storage note fills in after
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => false) : false;
  let usage = '';
  try { const est = await navigator.storage.estimate(); usage = ` Using ${(est.usage / 1048576).toFixed(1)} MB.`; } catch (e) { /* ignore */ }
  $('#storageNote').textContent = (persisted
    ? 'Your data is saved on this phone and protected from automatic clean-up.'
    : 'Your data is saved on this phone. Add the app to your Home Screen so iOS keeps it.') + usage + ' Save a backup file now and then.';
};
$('#saveBudget').onclick = async () => {
  const v = parseAmount($('#sBudget').value);
  if (!(v >= 0)) { toast('Enter a valid budget'); return; }
  state.budget = Math.round(v * 1000) / 1000;
  await store.setMeta('budget', state.budget);
  await store.setMeta('updatedAt', Date.now());
  render(); toast('Budget updated');
};
$('#backupBtn').onclick = async () => {
  const b = await bundle(true);
  const r = await shareFile(new Blob([JSON.stringify(b)], { type: 'application/json' }), `cash-budget-backup-${todayISO()}.json`, 'Cash Budget backup');
  if (r === 'saved') toast('Backup saved');
};
armed($('#resetBtn'), 'Start fresh', 'Tap again to clear everything', async () => {
  await store.clearTx(); imgCache.clear(); state.tx = [];
  closeSheets(); render(); toast('Fresh start');
});

/* ---------- iPhone install hint & offline ---------- */
function installHint() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  let dismissed = false;
  try { dismissed = !!localStorage.getItem('cashbudget.installHint'); } catch (e) { /* ignore */ }
  if (ios && !standalone && !dismissed) $('#installBanner').hidden = false;
  $('#dismissInstall').onclick = () => { $('#installBanner').hidden = true; try { localStorage.setItem('cashbudget.installHint', '1'); } catch (e) { /* ignore */ } };
}
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('sw.js');
    const reg = await navigator.serviceWorker.ready;
    if (reg.active) $('#offlinePill').hidden = false;
  } catch (e) { console.warn('Offline mode unavailable', e); }
}

/* ---------- Start ---------- */
(async () => {
  try {
    await seedIfNeeded();
    await loadState();
  } catch (e) {
    console.error(e);
    toast('Storage unavailable: ' + e.message, 6000);
  }
  render();
  installHint();
  checkLinkImport();
  window.addEventListener('hashchange', checkLinkImport);
  store.requestPersistence();
  registerSW();
  setTimeout(() => warmUp().catch(() => {}), 1500);
  document.documentElement.dataset.ready = '1';
})();
