// Offline support: everything the app needs (including the 8 MB text reader)
// is cached on first visit, then served from the phone with no network.
const VERSION = 'cash-budget-v2.0.0';
const ASSETS = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/store.js', 'js/ocr.js', 'js/ocr-worker.js', 'js/receipt-parser.js', 'js/share.js',
  'data/seed.json',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/tesseract/tesseract-core.js', 'vendor/tesseract/tesseract-core.wasm',
  'vendor/tesseract/eng.traineddata', 'vendor/tesseract/fra.traineddata'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // Cache first (offline-first); the page itself ignores ?query and #hash
  e.respondWith(
    caches.match(req, { ignoreSearch: req.mode === 'navigate' }).then(hit => hit ||
      fetch(req).then(res => {
        if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => req.mode === 'navigate' ? caches.match('index.html') : Response.error()))
  );
});
