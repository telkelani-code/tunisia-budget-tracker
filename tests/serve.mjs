// Tiny static server for local testing. Usage: node tests/serve.mjs [port]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm',
  '.traineddata': 'application/octet-stream', '.svg': 'image/svg+xml' };

export function serve(port = 8080) {
  const server = createServer(async (req, res) => {
    let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p.endsWith('/')) p += 'index.html';
    const file = join(root, p);
    try {
      if (!(await stat(file)).isFile()) throw 0;
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(await readFile(file));
    } catch { res.writeHead(404); res.end('Not found'); }
  });
  return new Promise(r => server.listen(port, () => r(server)));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = +process.argv[2] || 8080;
  await serve(port);
  console.log(`Cash Budget on http://localhost:${port}`);
}
