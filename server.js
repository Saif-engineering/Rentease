// RentEase server: serves /public and a tiny JSON API. No framework needed.
// Storage: Postgres when DATABASE_URL is set (Render), otherwise a local data.json file (for testing).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SECRET || 'dev-secret-change-me';
const PUB = path.join(__dirname, 'public');

let store;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false }
  });
  store = {
    async init() { await pool.query('create table if not exists kv(k text primary key, v jsonb not null)'); },
    async get(k) { const r = await pool.query('select v from kv where k=$1', [k]); return r.rows[0] ? r.rows[0].v : null; },
    async insertOnce(k, v) {
      const r = await pool.query('insert into kv(k,v) values($1,$2) on conflict do nothing', [k, JSON.stringify(v)]);
      return r.rowCount === 1;
    },
    async casState(expected, val) {
      if (expected === 0) return this.insertOnce('state', val);
      const r = await pool.query("update kv set v=$1 where k='state' and (v->>'version')::int=$2", [JSON.stringify(val), expected]);
      return r.rowCount === 1;
    }
  };
} else {
  const F = path.join(__dirname, 'data.json'); let M = {};
  try { M = JSON.parse(fs.readFileSync(F, 'utf8')); } catch (e) {}
  const flush = () => fs.writeFileSync(F, JSON.stringify(M));
  store = {
    async init() {},
    async get(k) { return M[k] || null; },
    async insertOnce(k, v) { if (M[k]) return false; M[k] = v; flush(); return true; },
    async casState(expected, val) { const cur = M.state ? M.state.version : 0; if (cur !== expected) return false; M.state = val; flush(); return true; }
  };
}

const b64 = b => Buffer.from(b).toString('base64url');
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const makeToken = u => { const p = b64(JSON.stringify({ u, exp: Date.now() + 30 * 864e5 })); return p + '.' + sign(p); };
function checkToken(t) {
  try {
    const [p, s] = (t || '').split('.'); if (!p || !s) return null;
    const a = Buffer.from(sign(p)), b = Buffer.from(s);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.exp > Date.now() ? o : null;
  } catch (e) { return null; }
}
const hash = (p, salt) => crypto.scryptSync(p, salt, 32).toString('hex');
const fails = new Map();
const limited = ip => { const f = fails.get(ip); return f && f.n >= 8 && Date.now() - f.t < 10 * 60 * 1000; };
const noteFail = ip => { const f = fails.get(ip) || { n: 0, t: 0 }; f.n = Date.now() - f.t > 10 * 60 * 1000 ? 1 : f.n + 1; f.t = Date.now(); fails.set(ip, f); };

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const body = req => new Promise((ok, no) => {
  let d = ''; req.on('data', c => { d += c; if (d.length > 3e6) { no(new Error('too big')); req.destroy(); } });
  req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch (e) { no(e); } });
});

async function api(req, res, url) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const r = url.pathname;
  if (r === '/api/status') { const a = await store.get('admin'); return send(res, 200, { setup: !!a }); }
  if (r === '/api/setup' && req.method === 'POST') {
    const { u, p } = await body(req);
    if (!u || !p || String(p).length < 4) return send(res, 400, { error: 'Enter an ID and a password of at least 4 characters' });
    const salt = crypto.randomBytes(16).toString('hex');
    const ok = await store.insertOnce('admin', { u: String(u).trim(), salt, h: hash(String(p), salt) });
    if (!ok) return send(res, 403, { error: 'Admin already exists. Please log in.' });
    return send(res, 200, { token: makeToken(String(u).trim()) });
  }
  if (r === '/api/login' && req.method === 'POST') {
    if (limited(ip)) return send(res, 429, { error: 'Too many attempts. Try again in 10 minutes.' });
    const { u, p } = await body(req); const a = await store.get('admin');
    const good = a && String(u).trim() === a.u && crypto.timingSafeEqual(Buffer.from(hash(String(p || ''), a.salt)), Buffer.from(a.h));
    if (!good) { noteFail(ip); return send(res, 401, { error: 'Wrong ID or password' }); }
    return send(res, 200, { token: makeToken(a.u) });
  }
  const auth = checkToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!auth) return send(res, 401, { error: 'Please log in' });
  if (r === '/api/state' && req.method === 'GET') {
    const s = await store.get('state'); return send(res, 200, s || { version: 0, data: null });
  }
  if (r === '/api/state' && req.method === 'PUT') {
    const { version, data } = await body(req);
    if (typeof version !== 'number' || !data || typeof data !== 'object') return send(res, 400, { error: 'Bad request' });
    const next = { version: version + 1, data };
    const ok = await store.casState(version, next);
    return ok ? send(res, 200, { version: next.version }) : send(res, 409, { error: 'Out of date' });
  }
  return send(res, 404, { error: 'Not found' });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res, url) {
  let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[\/\\])+/, '');
  let fp = path.join(PUB, p);
  if (!fp.startsWith(PUB) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) fp = path.join(PUB, 'index.html');
  const h = { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' };
  if (/sw\.js$|index\.html$/.test(fp)) h['Cache-Control'] = 'no-cache';
  res.writeHead(200, h); fs.createReadStream(fp).pipe(res);
}

store.init().then(() => {
  http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      serveStatic(req, res, url);
    } catch (e) { console.error(e); try { send(res, 500, { error: 'Server error' }); } catch (_) {} }
  }).listen(PORT, () => console.log('RentEase running on ' + PORT));
}).catch(e => { console.error('DB init failed', e); process.exit(1); });
