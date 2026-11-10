// Share data with other people, and read data they shared with you.
//  - Share file: a .json file with everything (optionally receipt photos), sent
//    through the iPhone share sheet (Messages, WhatsApp, AirDrop, Mail, Files…).
//  - Share link: a link to this app with the data packed into it (no photos).
//    Opening it shows an "Import" banner. Nothing is uploaded anywhere: the
//    data travels inside the link itself.
//  - Import accepts this app's files, links, and the older single-file app's
//    backups and shared .html copies.

export const APP_ID = 'tunisia-cash-budget';

export function makeBundle({ budget, tx, imgs, from }) {
  return {
    app: APP_ID,
    version: 2,
    exportedAt: new Date().toISOString(),
    from: from || '',
    budget,
    tx: tx.map(({ hasImg, ...t }) => t),
    imgs: imgs || {}
  };
}

/** Accepts any supported format and returns {budget, tx, imgs} or throws. */
export function parseImport(text) {
  text = String(text || '').trim();
  let data;
  if (/^<!doctype html|^<html/i.test(text)) {
    // Shared copy of the older single-file app: data sits in <script id="seedData">
    const m = text.match(/<script type="application\/json" id="seedData">([\s\S]*?)<\/script>/);
    if (!m) throw new Error('That HTML file has no budget data in it');
    data = JSON.parse(m[1]);
    if (!data) throw new Error('That HTML file has no saved entries (it is an empty copy)');
  } else {
    data = JSON.parse(text);
  }
  if (!data || !Array.isArray(data.tx)) throw new Error('This file is not a Cash Budget backup');
  return { budget: data.budget != null ? Number(data.budget) || 0 : null, tx: data.tx, imgs: data.imgs || {}, from: data.from || '' };
}

const b64url = bytes => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = s => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
};
async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

export async function encodeLink(bundle, baseUrl) {
  const json = new TextEncoder().encode(JSON.stringify({ ...bundle, imgs: {} }));
  let payload;
  if (typeof CompressionStream !== 'undefined') {
    try { payload = 'z.' + b64url(await pipe(json, new CompressionStream('deflate-raw'))); } catch (e) { /* fall through */ }
  }
  if (!payload) payload = 'j.' + b64url(json);
  return baseUrl.split('#')[0] + '#share=' + payload;
}

export async function decodeLink(hash) {
  const m = /share=([zj])\.([A-Za-z0-9_-]+)/.exec(hash || '');
  if (!m) return null;
  let bytes = unb64url(m[2]);
  if (m[1] === 'z') bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
  return parseImport(new TextDecoder().decode(bytes));
}

/** Share a file via the share sheet, or download it if sharing isn't available. Returns 'shared'|'saved'|'cancelled'. */
export async function shareFile(blob, name, title) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return 'saved';
}

export async function shareLink(url, title, text) {
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return 'shared'; }
    catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
  }
  try { await navigator.clipboard.writeText(url); return 'copied'; } catch (e) { return 'failed'; }
}
