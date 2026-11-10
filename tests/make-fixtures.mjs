// Renders the receipts in fixtures/receipts.json to images:
//  <name>.png       – clean scan
//  <name>-photo.jpg – phone-photo look: tilted, blurred, uneven light, JPEG
// Usage: node tests/make-fixtures.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // pre-installed globally
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const out = join(dir, 'images');
mkdirSync(out, { recursive: true });
const receipts = JSON.parse(readFileSync(join(dir, 'receipts.json'), 'utf8'));
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 1400 }, deviceScaleFactor: 2 });
for (const r of receipts) {
  const body = r.lines.map(l => `<div>${esc(l) || '&nbsp;'}</div>`).join('');
  const receipt = `<div id="r" style="width:420px;padding:28px 22px;background:#fbfaf6;font:15px/1.45 'DejaVu Sans Mono',monospace;color:#222;white-space:pre">${body}</div>`;
  await page.setContent(`<body style="margin:0;background:#fff">${receipt}</body>`);
  await page.locator('#r').screenshot({ path: join(out, r.name + '.png') });

  await page.setContent(`<body style="margin:0;background:linear-gradient(135deg,#5b4a3a,#3b2f25);display:flex;justify-content:center;align-items:flex-start;padding:60px 0">
    <div style="position:relative;transform:rotate(-2.2deg);filter:blur(0.7px) contrast(.85) brightness(.97);box-shadow:0 12px 30px rgba(0,0,0,.5)">
      ${receipt}
      <div style="position:absolute;inset:0;background:radial-gradient(ellipse at 20% 15%,rgba(255,255,255,0) 30%,rgba(60,50,40,.28) 100%)"></div>
    </div></body>`);
  await page.setViewportSize({ width: 600, height: 300 });
  const h = await page.evaluate(() => Math.ceil(document.body.firstElementChild.getBoundingClientRect().bottom) + 60);
  await page.setViewportSize({ width: 600, height: h });
  await page.screenshot({ path: join(out, r.name + '-photo.jpg'), type: 'jpeg', quality: 62 });
  await page.setViewportSize({ width: 900, height: 1400 });
}
await browser.close();
console.log('wrote', receipts.length * 2, 'images to', out);
