// Router fast-engine: /s/<website>/<path> -> file dari Supabase Storage
const SB = process.env.SB_URL || 'https://mvfmnkucaqasipmvtmxx.supabase.co';
const KEY = process.env.SB_KEY || 'sb_publishable_xuWYX3LZ_pPFWlxsptfmgg_gMT_x98t';
const BIG = 4000000; // batas respons function ~6 MB (base64 menambah 33%)

// Halaman pelanggan berjalan satu alamat dengan dashboard. "sandbox" tanpa allow-same-origin
// membuat script mereka tidak bisa membaca sesi login (localStorage) milik dashboard.
const SAFE = {
  'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-top-navigation-by-user-activation',
  'Access-Control-Allow-Origin': '*', // halaman yang di-sandbox perlu CORS untuk memuat file sendiri
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex',
};

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const page = (code, title, text) => ({
  statusCode: code,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
  body: `<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#14213d;background:#f5f3ee"><div style="text-align:center;padding:24px"><h1>${esc(title)}</h1><p>${esc(text)}</p></div>`,
});

// Netlify bisa mengirim alamat asli (/s/...) atau alamat function; dukung keduanya.
function route(e) {
  const cands = [];
  try { cands.push(new URL(e.rawUrl).pathname); } catch (_) {}
  if (e.path) cands.push(e.path);
  for (const c of cands) {
    const m = c.match(/^(?:\/s|\/\.netlify\/functions\/serve)\/([a-z0-9-]{3,63})(\/.*)?$/i);
    if (m) return { sub: m[1].toLowerCase(), rest: m[2] || '' };
  }
  return null;
}
const query = e => { try { return new URL(e.rawUrl).search; } catch (_) { return ''; } };

async function lookup(sub, p) {
  const r = await fetch(`${SB}/rest/v1/rpc/get_site_file`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_sub: sub, p_path: p }),
  });
  if (!r.ok) throw new Error('lookup ' + r.status);
  return r.json();
}

exports.handler = async (e) => {
  const rt = route(e);
  if (!rt) return page(404, 'Halaman tidak ditemukan', 'Alamat website tidak valid.');
  const { sub, rest } = rt, qs = query(e);
  if (!rest) return { statusCode: 301, headers: { Location: `/s/${sub}/${qs}` } };

  let p;
  try { p = decodeURIComponent(rest).replace(/^\/+/, ''); } catch (_) { return page(400, 'Alamat salah', 'Alamat file tidak bisa dibaca.'); }
  if (!p || p.endsWith('/')) p += 'index.html';

  let rows;
  try {
    rows = await lookup(sub, p);
    // /folder tanpa garis miring: arahkan ke /folder/ agar alamat relatif di dalamnya benar
    if (!rows.length && !/\.[^/]+$/.test(p)) {
      const d = await lookup(sub, p + '/index.html');
      if (d.length) return { statusCode: 301, headers: { Location: `/s/${sub}/${rest.replace(/^\/+/, '')}/${qs}` } };
    }
  } catch (_) {
    return page(503, 'Layanan sedang sibuk', 'Coba muat ulang beberapa saat lagi.');
  }
  if (!rows.length) return page(404, 'Halaman tidak ditemukan', 'Website atau file ini tidak ada, atau sedang tidak aktif.');

  const url = `${SB}/storage/v1/object/public/sites/${rows[0].storage_key}`;
  let f;
  try { f = await fetch(url); } catch (_) { return page(503, 'Layanan sedang sibuk', 'Coba muat ulang beberapa saat lagi.'); }
  if (!f.ok) return page(404, 'File tidak ditemukan', 'File ini belum tersedia.');
  // file besar dikirim langsung dari Supabase; ukuran dibaca dari header sebelum isinya diunduh
  const toStorage = { statusCode: 302, headers: { Location: url, 'Cache-Control': 'public, max-age=60', ...SAFE } };
  const len = Number(f.headers && f.headers.get && f.headers.get('content-length')) || 0;
  if (len > BIG) { try { await f.body.cancel(); } catch (_) {} return toStorage; }
  let buf = Buffer.from(await f.arrayBuffer());
  if (buf.length > BIG) return toStorage;

  let mime = rows[0].mime || 'application/octet-stream';
  const base = `/s/${sub}/`;
  const isHtml = /^text\/html/i.test(mime), isCss = /^text\/css/i.test(mime);
  let charset = 'utf-8';
  if (isHtml || isCss) {
    // latin1 menjaga byte asli tetap utuh; pola yang diganti hanya ASCII
    let s = buf.toString('latin1');
    if (isHtml) {
      const cs = s.slice(0, 2048).match(/<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i);
      if (cs) charset = cs[1].toLowerCase();
      s = s.replace(/(\b(?:src|href|action|poster|data-src|srcset)\s*=\s*["'])\/(?!\/)/gi, `$1${base}`);
    }
    s = s.replace(/url\(\s*(["']?)\/(?!\/)/gi, `url($1${base}`);
    buf = Buffer.from(s, 'latin1');
  }
  mime = mime.replace(/;.*$/, '');
  if (isHtml || /^text\//i.test(mime) || /^application\/(json|javascript|xml)$/i.test(mime)) mime += `; charset=${charset}`;

  return {
    statusCode: 200,
    isBase64Encoded: true,
    body: buf.toString('base64'),
    headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=60', ...SAFE },
  };
};
