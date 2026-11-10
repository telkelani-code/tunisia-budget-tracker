// Draws the app icons. Usage: node tests/make-icons.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" fill="#14231c"/>
<circle cx="420" cy="80" r="150" fill="none" stroke="rgba(255,255,255,.05)" stroke-width="50"/>
<rect x="96" y="166" width="320" height="180" rx="22" fill="#7fd1a5"/>
<rect x="116" y="186" width="280" height="140" rx="12" fill="none" stroke="#1f6b4a" stroke-width="8"/>
<circle cx="256" cy="256" r="44" fill="#1f6b4a"/>
<text x="256" y="276" font-family="Georgia,serif" font-size="58" font-weight="700" fill="#7fd1a5" text-anchor="middle">د</text>
</svg>`;
const b = await chromium.launch(); const p = await b.newPage();
for (const [name, size] of [['icon-512', 512], ['icon-192', 192], ['apple-touch-icon', 180]]) {
  await p.setViewportSize({ width: size, height: size });
  await p.setContent(`<body style="margin:0">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`);
  await p.screenshot({ path: `icons/${name}.png` });
}
await b.close(); console.log('icons written');
