// End-to-end checks in an emulated iPhone (Playwright + Chromium).
// Usage: node tests/e2e.test.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const receipts = JSON.parse(readFileSync(join(here, 'fixtures/receipts.json'), 'utf8'));
const img = name => join(here, 'fixtures/images', name);
const PORT = 8123, URL0 = `http://localhost:${PORT}/`;
const iPhone = devices['iPhone 13'];

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' (' + extra + ')' : ''}`); };

const server = await serve(PORT);
const browser = await chromium.launch();

// Records what the app hands to the iPhone share sheet
const shareSpy = () => {
  window.__shared = [];
  navigator.canShare = d => !!d;
  navigator.share = async d => {
    const files = await Promise.all((d.files || []).map(async f => ({ name: f.name, type: f.type, text: await f.text() })));
    window.__shared.push({ title: d.title, text: d.text, url: d.url, files });
  };
};

const phones = [];
async function newPhone() {
  const ctx = await browser.newContext({ ...iPhone, permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.addInitScript(shareSpy);
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('  [page error]', e.message));
  await page.goto(URL0);
  await page.waitForSelector('html[data-ready="1"]');
  phones.push(page);
  return { ctx, page };
}
async function scan(page, inputSel, file) {
  await page.setInputFiles(inputSel, file);
  await page.waitForSelector('#entrySheet.show');
  await page.waitForFunction(() => /Total found|Couldn’t/.test(document.querySelector('#ocrStatus')?.textContent || ''), null, { timeout: 120000 });
  return {
    amount: await page.inputValue('#fAmount'),
    status: await page.textContent('#ocrStatus'),
    note: await page.inputValue('#fNote'),
    thumb: await page.locator('#receiptBox img').count()
  };
}

try {
  /* 1. Pre-filled data from Tunisia_cash_budget_v1.1.html */
  const A = await newPhone();
  const p = A.page;
  ok('seed: budget 690.000 TND shown', (await p.textContent('#remaining')).startsWith('690.000'));
  await p.click('#addBtn');
  const chips = await p.$$eval('#catChips .chip', els => els.map(e => e.textContent.trim()));
  ok('seed: 9 categories from the original app', chips.length === 9 && chips[0].includes('Groceries') && chips[8].includes('Other'), chips.join(', '));
  await p.click('#cancelEntry');

  /* 2. Photo inputs work on iPhone */
  const cam = await p.$eval('#camInput', e => ({ accept: e.accept, capture: e.getAttribute('capture'), type: e.type }));
  const roll = await p.$eval('#rollInput', e => ({ accept: e.accept, capture: e.getAttribute('capture') }));
  ok('camera button opens rear camera (capture=environment)', cam.type === 'file' && cam.accept === 'image/*' && cam.capture === 'environment');
  ok('camera roll button opens photo library (no capture)', roll.accept === 'image/*' && roll.capture === null);

  /* 3. Amount extraction, both buttons, clean scans and phone photos */
  const t0 = Date.now();
  let first = true;
  for (const r of receipts) {
    for (const [file, input] of [[r.name + '-photo.jpg', '#camInput'], [r.name + '.png', '#rollInput']]) {
      const res = await scan(p, input, img(file));
      const got = parseFloat(res.amount);
      ok(`extract ${file} via ${input === '#camInput' ? 'camera' : 'camera roll'} → ${r.expected}`, Math.abs(got - r.expected) < 0.0005 && res.thumb === 1, `got ${res.amount}; note "${res.note}"`);
      if (first) { console.log(`  first scan incl. engine start: ${((Date.now() - t0) / 1000).toFixed(1)}s`); first = false; }
      await p.click('#cancelEntry');
    }
  }

  /* 4. Save a scanned receipt; check totals */
  await scan(p, '#camInput', img('carrefour-ttc-photo.jpg'));
  await p.click('#saveEntry');
  await p.waitForSelector('.tx');
  ok('saved expense lowers cash left', (await p.textContent('#remaining')).startsWith('666.550'), await p.textContent('#remaining'));
  ok('receipt photo saved with expense', await p.locator('.tx .ic img').count() === 1);
  // a manual entry
  await p.click('#addBtn');
  await p.fill('#fAmount', '4.500'); await p.click('[data-cat="coffee"]'); await p.fill('#fNote', 'Café');
  await p.click('#saveEntry');
  await p.waitForFunction(() => document.querySelectorAll('.tx').length === 2);

  /* 5. Persistence: reload and still there */
  await p.reload(); await p.waitForSelector('html[data-ready="1"]');
  ok('data persists after reload', await p.locator('.tx').count() === 2 && (await p.textContent('#remaining')).startsWith('662.050'));

  /* 6. Offline: works with no network, including scanning */
  await p.waitForFunction(() => navigator.serviceWorker.controller || navigator.serviceWorker.ready.then(r => !!r.active), null, { timeout: 60000 });
  await p.reload(); await p.waitForSelector('html[data-ready="1"]');
  await p.waitForFunction(async () => (await caches.keys()).length && (await (await caches.open((await caches.keys())[0])).keys()).length >= 18, null, { timeout: 60000 });
  await A.ctx.setOffline(true);
  await p.reload(); await p.waitForSelector('html[data-ready="1"]');
  ok('app opens offline', await p.locator('.tx').count() === 2);
  const off = await scan(p, '#rollInput', img('monoprix-net-a-payer-photo.jpg'));
  ok('receipt scanning works offline', off.amount === '87.320', off.amount);
  await p.click('#cancelEntry');
  await A.ctx.setOffline(false);

  /* 7. Share as file → another person imports it */
  await p.click('#shareBtn');
  await p.fill('#shareName', 'Tester');
  await p.click('#shareFileBtn');
  await p.waitForFunction(() => window.__shared.length === 1);
  const shared = await p.evaluate(() => window.__shared[0]);
  const fileJson = JSON.parse(shared.files[0].text);
  ok('share file goes to iPhone share sheet', shared.files[0].name.endsWith('.json') && fileJson.tx.length === 2 && Object.keys(fileJson.imgs).length === 1);

  const B = await newPhone();
  await B.page.click('#openSettings');
  await B.page.setInputFiles('#importInput', { name: shared.files[0].name, mimeType: 'application/json', buffer: Buffer.from(shared.files[0].text) });
  await B.page.waitForSelector('#importBanner:not([hidden])');
  ok('import banner names who shared', (await B.page.textContent('#importBanner')).includes('Tester'));
  await B.page.click('#impReplace');
  await B.page.waitForFunction(() => document.querySelectorAll('.tx').length === 2);
  ok('recipient sees shared expenses and photo', (await B.page.textContent('#remaining')).startsWith('662.050') && await B.page.locator('.tx .ic img').count() === 1);

  /* 8. Share as link → third person opens it */
  await p.click('#shareBtn');
  await p.click('#shareLinkBtn');
  await p.waitForFunction(() => window.__shared.length === 2);
  const link = (await p.evaluate(() => window.__shared[1])).url;
  ok('share link contains data', /#share=[zj]\./.test(link), link.length + ' chars');
  const C = await newPhone();
  await C.page.click('#addBtn'); await C.page.fill('#fAmount', '10'); await C.page.click('#saveEntry');
  await C.page.waitForSelector('.tx');
  await C.page.goto(link); await C.page.waitForSelector('#importBanner:not([hidden])');
  await C.page.click('#impMerge');
  await C.page.waitForFunction(() => document.querySelectorAll('.tx').length === 3);
  ok('link import merges with existing entries', true);

  /* 9. Old app's backup/shared .html copy can be imported */
  const legacyHtml = '<!DOCTYPE html><html><body><script type="application/json" id="seedData">' +
    JSON.stringify({ budget: 500, tx: [{ id: 'old1', type: 'expense', amount: 12.5, cat: 'food', note: 'Old app', date: '2026-10-01', created: '2026-10-01T10:00:00Z' }], savedAt: 1 }) +
    '</script></body></html>';
  await C.page.click('#openSettings');
  await C.page.setInputFiles('#importInput', { name: 'Cash-Budget-2026-10-01.html', mimeType: 'text/html', buffer: Buffer.from(legacyHtml) });
  await C.page.click('#impReplace');
  await C.page.waitForFunction(() => document.querySelectorAll('.tx').length === 1);
  ok('imports shared copy from old single-file app', (await C.page.textContent('#remaining')).startsWith('487.500'));

} catch (e) {
  fail++; console.log('FAIL exception', String(e).split('\n')[0]);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(here, 'output'), { recursive: true });
  for (const [i, pg] of phones.entries()) {
    await pg.screenshot({ path: join(here, 'output', `failure-phone${i}.png`) }).catch(() => {});
    console.log(`  phone${i}:`, await pg.evaluate(() => JSON.stringify({ url: location.href, toast: document.querySelector('#toast').textContent,
      banner: document.querySelector('#importBanner').hidden, tx: document.querySelectorAll('.tx').length,
      sheets: [...document.querySelectorAll('.sheet.show')].map(s => s.id) })).catch(e => String(e)));
  }
}
await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
