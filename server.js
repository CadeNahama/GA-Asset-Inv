/**
 * DeviceDB — web server. THE entry point for the app.
 *
 *   node server.js            → http://localhost:8422
 *
 * Serves the UI (renderer/) and a full read/write JSON API. Zero external
 * dependencies — plain node:http + node:sqlite (Node 22.5+ required).
 *
 * Deploy as a web app: run this process and point browsers (and later
 * ServiceNow) at the same host/port. One server, one API, one UI.
 *
 * Config (optional, all overridable by env vars):
 *   config.json next to this file: { "port": 8422, "host": "127.0.0.1", "dbPath": "" }
 *   env: PORT, HOST, DB_PATH
 *
 * API (JSON unless noted):
 *   GET    /api/health                          → { ok, app, version }
 *   GET    /api/meta                            → dbPath, user, version, counts
 *   GET    /api/columns                         → configured column names/roles
 *   PUT    /api/columns/:pos                    → { name } rename column
 *   PUT    /api/columns/:pos/role               → { role: 'dns'|'ip' }
 *   GET    /api/columns/:pos/values             → distinct values + counts (filter dropdown)
 *   GET    /api/devices?q=&all=&sort=&dir=&limit=&offset=&filters=   → paged list
 *   GET    /api/devices/:id                     → single device (raw c01..c39)
 *   POST   /api/devices                         → { values } create
 *   PUT    /api/devices/:id                     → { values } update
 *   POST   /api/devices/delete                  → { ids: [] } bulk delete
 *   GET    /api/lookup?term=host-or-ip          → exact DNS/IP lookup (friendly names)
 *   GET    /api/stats?groupBy=<pos>             → totals + group counts (metrics)
 *   POST   /api/import  (text/csv body)         → strict validate + insert (all-or-nothing)
 *   GET    /api/export?mode=all|filtered|selected&q=&all=&ids=&filters=   → CSV download
 *   GET    /api/template                        → blank CSV template download
 *
 * filters= is a JSON-encoded { "<colPos>": ["value1", "value2", ...] } map —
 * an Excel-style "narrow this column to these values" filter, ANDed with q=.
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`DeviceDB needs Node 22.5 or newer (you have ${process.versions.node}).`);
  console.error('Install the current LTS from https://nodejs.org and try again.');
  process.exit(1);
}

const db = require('./src/db');
const csv = require('./src/csv');

const VERSION = require('./package.json').version;
const ROOT = __dirname;
const STATIC_DIR = path.join(ROOT, 'renderer');

/* -------------------------------------------------------------- config */

function loadConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); }
  catch (_) { /* optional */ }
  return {
    port: Number(process.env.PORT || file.port || 8422),
    host: process.env.HOST || file.host || '127.0.0.1',
    dbPath: process.env.DB_PATH || file.dbPath ||
            path.join(ROOT, 'data', 'devicedb.sqlite'),
  };
}

const config = loadConfig();
const currentUser = () => os.userInfo().username || 'unknown';

/* ------------------------------------------------------------- helpers */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendCsv(res, filename, text) {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req, limitBytes = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('Request body too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const text = await readBody(req);
  try { return text ? JSON.parse(text) : {}; }
  catch (_) { throw new Error('Request body is not valid JSON.'); }
}

/** Parse the filters= query param: JSON { "<colPos>": [values...] }, or null. */
function parseFilters(q) {
  const raw = q.get('filters');
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch (_) { return null; }
}

/** Map raw row (c01..c39) → display-named object for external consumers. */
function friendly(row) {
  const cols = db.getColumns();
  const out = { id: row.id, updatedAt: row.updated_at, updatedBy: row.updated_by };
  for (const c of cols) out[c.name] = row[db.COL_IDS[c.pos - 1]];
  return out;
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(STATIC_DIR, rel));
  if (!file.startsWith(STATIC_DIR)) { // path traversal guard
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ----------------------------------------------------------------- api */

async function handleApi(req, res, u) {
  const parts = u.pathname.split('/').filter(Boolean); // ['api', ...]
  const q = u.searchParams;
  const method = req.method;

  // -------- health / meta
  if (parts[1] === 'health') {
    return sendJson(res, 200, { ok: true, app: 'DeviceDB', version: VERSION });
  }
  if (parts[1] === 'meta' && method === 'GET') {
    return sendJson(res, 200, {
      app: 'DeviceDB', version: VERSION,
      dbPath: db.getPath(), user: currentUser(),
      total: db.stats().total,
      host: config.host, port: config.port,
    });
  }

  // -------- columns
  if (parts[1] === 'columns' && parts.length === 2 && method === 'GET') {
    return sendJson(res, 200, db.getColumns());
  }
  if (parts[1] === 'columns' && parts.length === 3 && method === 'PUT') {
    const { name } = await readJsonBody(req);
    return sendJson(res, 200, db.renameColumn(Number(parts[2]), name));
  }
  if (parts[1] === 'columns' && parts[3] === 'role' && method === 'PUT') {
    const { role } = await readJsonBody(req);
    return sendJson(res, 200, db.setRole(Number(parts[2]), role));
  }
  if (parts[1] === 'columns' && parts[3] === 'values' && method === 'GET') {
    return sendJson(res, 200, db.distinctValues(Number(parts[2])));
  }

  // -------- lookup / stats
  if (parts[1] === 'lookup' && method === 'GET') {
    const term = String(q.get('term') || '');
    const rows = db.lookup(term).map(friendly);
    return sendJson(res, 200, { term, count: rows.length, results: rows });
  }
  if (parts[1] === 'stats' && method === 'GET') {
    return sendJson(res, 200, db.stats(q.get('groupBy')));
  }

  // -------- devices
  if (parts[1] === 'devices' && parts.length === 2 && method === 'GET') {
    const raw = q.get('raw') === '1'; // UI wants raw c01..c39; integrations get names
    const { total, rows } = db.query({
      search: String(q.get('q') || ''),
      allColumns: q.get('all') === '1',
      sortPos: Number(q.get('sort')) || 0,
      sortDir: q.get('dir') || 'ASC',
      offset: Number(q.get('offset')) || 0,
      limit: Math.min(Number(q.get('limit')) || 100, 1000),
      filters: parseFilters(q),
    });
    return sendJson(res, 200, {
      total,
      results: raw ? rows : rows.map(friendly),
    });
  }
  if (parts[1] === 'devices' && parts[2] === 'delete' && method === 'POST') {
    const { ids } = await readJsonBody(req);
    if (!Array.isArray(ids) || !ids.length) throw new Error('ids[] required.');
    return sendJson(res, 200, { deleted: db.deleteDevices(ids.map(Number), currentUser()) });
  }
  if (parts[1] === 'devices' && parts.length === 3 && method === 'GET') {
    const row = db.getDevice(Number(parts[2]));
    if (!row) return sendJson(res, 404, { error: 'Not found' });
    return sendJson(res, 200, q.get('raw') === '1' ? row : friendly(row));
  }
  if (parts[1] === 'devices' && parts.length === 2 && method === 'POST') {
    const { values } = await readJsonBody(req);
    return sendJson(res, 200, db.saveDevice(null, values || {}, currentUser()));
  }
  if (parts[1] === 'devices' && parts.length === 3 && method === 'PUT') {
    const id = Number(parts[2]);
    if (!db.getDevice(id)) return sendJson(res, 404, { error: 'Not found' });
    const { values } = await readJsonBody(req);
    return sendJson(res, 200, db.saveDevice(id, values || {}, currentUser()));
  }

  // -------- CSV import / export / template
  // POST /api/import?dryRun=1        → report new vs. duplicate counts, write nothing
  // POST /api/import?mode=skip       → insert new rows only (default)
  // POST /api/import?mode=update     → insert new + overwrite matching devices
  // POST /api/import?mode=reject     → refuse the file entirely if any duplicate
  // Never deletes: devices absent from the file are always left alone.
  if (parts[1] === 'import' && method === 'POST') {
    const text = await readBody(req);
    const names = db.getColumns().map((c) => c.name);
    const check = csv.validateImport(text, names);
    if (!check.ok) return sendJson(res, 400, { imported: 0, errors: check.errors });

    if (q.get('dryRun') === '1') {
      return sendJson(res, 200, { dryRun: true, ...db.analyzeImport(check.rows) });
    }

    const mode = q.get('mode') || 'skip';
    const r = db.importRows(check.rows, mode, currentUser());
    if (!r.ok) return sendJson(res, 400, { imported: 0, ...r });
    return sendJson(res, 200, {
      imported: r.inserted + r.updated, ...r, mode,
    });
  }
  if (parts[1] === 'export' && method === 'GET') {
    const mode = q.get('mode') || 'all';
    const ids = (q.get('ids') || '').split(',').map(Number).filter(Boolean);
    const rows = db.exportRows(
      mode === 'selected' ? { ids }
      : mode === 'filtered' ? { search: String(q.get('q') || ''), allColumns: q.get('all') === '1', filters: parseFilters(q) }
      : {}
    ).map((r) => db.COL_IDS.map((c) => r[c]));
    const header = db.getColumns().map((c) => c.name);
    const stamp = new Date().toISOString().slice(0, 10);
    return sendCsv(res, `devicedb-${mode}-${stamp}.csv`, csv.serialize(header, rows));
  }
  if (parts[1] === 'template' && method === 'GET') {
    const header = db.getColumns().map((c) => c.name);
    return sendCsv(res, 'devicedb-template.csv', csv.serialize(header, []));
  }

  return sendJson(res, 404, { error: 'Not found' });
}

/* -------------------------------------------------------------- server */

function createServer() {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        return res.end();
      }
      if (u.pathname.startsWith('/api')) return await handleApi(req, res, u);
      if (req.method === 'GET') return serveStatic(req, res, u.pathname);
      res.writeHead(405); res.end('Method not allowed');
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
  });
}

/** Start the HTTP server and open the database. */
function start({ port = config.port, host = config.host, dbPath = config.dbPath } = {}) {
  db.open(dbPath);
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({ server, port: actual, host, url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${actual}` });
    });
  });
}

module.exports = { start, config };

if (require.main === module) {
  start()
    .then(({ url }) => {
      console.log(`DeviceDB running  →  ${url}`);
      console.log(`Database          →  ${db.getPath()}`);
      console.log('Press Ctrl+C to stop.');
    })
    .catch((e) => { console.error('Failed to start:', e.message); process.exit(1); });
}
