/**
 * DeviceDB — SQLite data layer built on node:sqlite (built into Node 22.5+).
 * Zero external dependencies: no native compilation, nothing to npm-install.
 *
 * Design notes:
 *  - 39 user-facing columns stored as physical columns c01..c39 (TEXT).
 *    Display names live in the `columns` table so renames are shared by
 *    every user pointing at the same database file.
 *  - Two columns carry a "role": 'dns' and 'ip'. Those drive the primary
 *    lookup and get dedicated indexes.
 *  - journal_mode stays DELETE (not WAL) on purpose: WAL does not work
 *    reliably on SMB/network shares, and a shared DB file on a network
 *    share is a possible future deployment. busy_timeout handles
 *    concurrent writers gracefully.
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const { COLUMNS, slugify } = require('./columns');

const NUM_COLS = 39;
const COL_IDS = Array.from({ length: NUM_COLS }, (_, i) =>
  'c' + String(i + 1).padStart(2, '0')
);

// Display names come from the canonical schema in ./columns.js.
// They stay renameable in Settings; the API `key` never changes.
const DEFAULT_NAMES = COLUMNS.map((c) => c.name);

let db = null;
let currentPath = null;

/* ---------------------------------------------------------------- open */

function open(dbPath) {
  close();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = DELETE'); // network-share safe
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  currentPath = dbPath;
  migrate();
  return true;
}

function close() {
  if (db) { try { db.close(); } catch (_) { /* noop */ } }
  db = null;
  currentPath = null;
}

function getPath() { return currentPath; }

/** Run fn inside a transaction (node:sqlite has no .transaction helper). */
function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* noop */ }
    throw e;
  }
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS columns (
      pos  INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT
    );
    CREATE TABLE IF NOT EXISTS deletions (
      device_id  INTEGER PRIMARY KEY,
      deleted_at TEXT NOT NULL,
      deleted_by TEXT NOT NULL DEFAULT '',
      dns        TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ${COL_IDS.map((c) => `${c} TEXT NOT NULL DEFAULT ''`).join(',\n      ')},
      updated_at TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT ''
    );
  `);

  // Add the immutable API key column to databases created before it existed.
  const hasKey = db.prepare("PRAGMA table_info(columns)").all()
    .some((c) => c.name === 'key');
  if (!hasKey) db.exec('ALTER TABLE columns ADD COLUMN key TEXT');

  // Seed column definitions on first run.
  const count = db.prepare('SELECT COUNT(*) AS n FROM columns').get().n;
  if (count === 0) {
    const ins = db.prepare('INSERT INTO columns (pos, name, key, role) VALUES (?, ?, ?, ?)');
    tx(() => {
      for (const c of COLUMNS) ins.run(c.pos, c.name, c.key, c.role);
    });
  } else {
    // Backfill keys for pre-existing databases, deriving them from whatever
    // the column is currently called. Existing keys are never touched.
    const missing = db.prepare("SELECT pos, name FROM columns WHERE key IS NULL OR key = ''").all();
    if (missing.length) {
      const taken = new Set(
        db.prepare("SELECT key FROM columns WHERE key IS NOT NULL AND key != ''").all().map((r) => r.key)
      );
      const upd = db.prepare('UPDATE columns SET key = ? WHERE pos = ?');
      tx(() => {
        for (const m of missing) {
          let k = slugify(m.name);
          let n = 2;
          while (taken.has(k)) k = `${slugify(m.name)}_${n++}`; // guarantee uniqueness
          taken.add(k);
          upd.run(k, m.pos);
        }
      });
    }
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_columns_key ON columns (key)');
  rebuildRoleIndexes();
}

/* ------------------------------------------------------------- columns */

function getColumns() {
  return db.prepare('SELECT pos, name, key, role FROM columns ORDER BY pos').all();
}

/** Resolve an API key (or a position number) to its physical c-column. */
function colIdForKey(keyOrPos) {
  const k = String(keyOrPos).trim();
  if (/^\d+$/.test(k)) {
    const pos = Number(k);
    return pos >= 1 && pos <= NUM_COLS ? COL_IDS[pos - 1] : null;
  }
  const row = db.prepare('SELECT pos FROM columns WHERE key = ? COLLATE NOCASE').get(k);
  return row ? COL_IDS[row.pos - 1] : null;
}

function columnByKey(keyOrPos) {
  const k = String(keyOrPos).trim();
  if (/^\d+$/.test(k)) return db.prepare('SELECT pos, name, key, role FROM columns WHERE pos = ?').get(Number(k)) || null;
  return db.prepare('SELECT pos, name, key, role FROM columns WHERE key = ? COLLATE NOCASE').get(k) || null;
}

/**
 * Apply a whole schema at once: [{pos, name, key, role}].
 *
 * Done in two phases inside one transaction because the new layout is often
 * a PERMUTATION of the old one — setting column 1 to "Type" while column 4
 * is still called "Type" would trip the uniqueness checks. So every column
 * is parked on a temporary unique value first, then given its final one.
 *
 * Device data is never touched; only the labels above it.
 */
function applySchema(defs, { keys = false } = {}) {
  const names = new Set();
  const keySet = new Set();
  for (const d of defs) {
    const n = String(d.name || '').trim().toLowerCase();
    if (!n) throw new Error(`Column ${d.pos} has an empty name.`);
    if (names.has(n)) throw new Error(`Duplicate column name "${d.name}".`);
    names.add(n);
    if (keys) {
      const k = slugify(d.key || d.name);
      if (keySet.has(k)) throw new Error(`Duplicate column key "${k}".`);
      keySet.add(k);
    }
  }

  const park = db.prepare('UPDATE columns SET name = ?, key = ?, role = NULL WHERE pos = ?');
  const setName = db.prepare('UPDATE columns SET name = ? WHERE pos = ?');
  const setKey = db.prepare('UPDATE columns SET key = ? WHERE pos = ?');
  const setRoleQ = db.prepare('UPDATE columns SET role = ? WHERE pos = ?');

  tx(() => {
    // Phase 1 — park everything on collision-proof temporaries.
    for (const d of defs) park.run(`__tmp_name_${d.pos}`, `__tmp_key_${d.pos}`, d.pos);
    // Phase 2 — final values.
    for (const d of defs) {
      setName.run(String(d.name).trim(), d.pos);
      if (keys) setKey.run(slugify(d.key || d.name), d.pos);
      if (d.role) setRoleQ.run(d.role, d.pos);
    }
  });

  // Keys parked as temporaries must not survive when not resetting keys.
  if (!keys) {
    const stale = db.prepare("SELECT pos, name FROM columns WHERE key LIKE '__tmp_key_%'").all();
    for (const s of stale) setKey.run(slugify(s.name), s.pos);
  }

  rebuildRoleIndexes();
  return getColumns();
}

/**
 * Change a column's API key. Deliberately separate from renaming: keys are
 * contracts with ServiceNow/connectors, so changing one is an explicit act.
 */
function setColumnKey(pos, key) {
  const k = slugify(key);
  if (!k) throw new Error('Key cannot be empty.');
  const clash = db.prepare('SELECT pos FROM columns WHERE key = ? AND pos != ?').get(k, pos);
  if (clash) throw new Error(`Another column already uses the key "${k}".`);
  db.prepare('UPDATE columns SET key = ? WHERE pos = ?').run(k, pos);
  return getColumns();
}

function renameColumn(pos, name) {
  name = String(name || '').trim();
  if (!name) throw new Error('Column name cannot be empty.');
  const clash = db
    .prepare('SELECT pos FROM columns WHERE LOWER(name) = LOWER(?) AND pos != ?')
    .get(name, pos);
  if (clash) throw new Error(`Another column is already named "${name}".`);
  db.prepare('UPDATE columns SET name = ? WHERE pos = ?').run(name, pos);
  return getColumns();
}

function setRole(pos, role) {
  if (role !== 'dns' && role !== 'ip') throw new Error('Role must be dns or ip.');
  tx(() => {
    db.prepare('UPDATE columns SET role = NULL WHERE role = ?').run(role);
    db.prepare('UPDATE columns SET role = ? WHERE pos = ?').run(role, pos);
  });
  rebuildRoleIndexes();
  return getColumns();
}

function roleCol(role) {
  const row = db.prepare('SELECT pos FROM columns WHERE role = ?').get(role);
  return row ? COL_IDS[row.pos - 1] : null;
}

function rebuildRoleIndexes() {
  db.exec('DROP INDEX IF EXISTS idx_dns; DROP INDEX IF EXISTS idx_ip;');
  const dns = roleCol('dns');
  const ip = roleCol('ip');
  if (dns) db.exec(`CREATE INDEX idx_dns ON devices (${dns} COLLATE NOCASE)`);
  if (ip) db.exec(`CREATE INDEX idx_ip ON devices (${ip} COLLATE NOCASE)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_name ON devices (c01 COLLATE NOCASE)`);
}

/* --------------------------------------------------------------- query */

/**
 * Every distinct value currently in a column, with counts — powers the
 * Excel-style "select one, several, or all" filter dropdown. Blanks sort
 * last rather than first so the real values are what the user sees up top.
 */
function distinctValues(pos) {
  if (!(pos >= 1 && pos <= NUM_COLS)) return [];
  const col = COL_IDS[pos - 1];
  return db.prepare(
    `SELECT ${col} AS value, COUNT(*) AS count FROM devices
     GROUP BY ${col} ORDER BY (${col} = '') ASC, ${col} COLLATE NOCASE ASC`
  ).all();
}

/**
 * Build a `col IN (...)` clause per filtered column, ANDed together.
 * filters: { [pos]: string[] } — an entry only exists for columns the user
 * has actually narrowed; a column with everything checked simply has no
 * entry, same as an Excel filter with "(Select All)" ticked.
 */
function buildFilterClause(filters) {
  const parts = [];
  const params = [];
  if (filters && typeof filters === 'object') {
    for (const key of Object.keys(filters)) {
      const pos = Number(key);
      const values = filters[key];
      if (!(pos >= 1 && pos <= NUM_COLS)) continue;
      if (!Array.isArray(values) || !values.length) continue;
      const col = COL_IDS[pos - 1];
      parts.push(`${col} COLLATE NOCASE IN (${values.map(() => '?').join(',')})`);
      params.push(...values.map(String));
    }
  }
  return { clause: parts.join(' AND '), params };
}

/**
 * Windowed query for the virtualized table.
 * opts: { search, allColumns, sortPos, sortDir, offset, limit, filters }
 * Search matches Name + DNS + IP columns by default (case-insensitive
 * substring); allColumns=true widens it to every column. filters narrows
 * specific columns to a fixed set of values (see buildFilterClause).
 */
function query(opts = {}) {
  const { search = '', allColumns = false, sortPos = 0, sortDir = 'ASC',
          offset = 0, limit = 100, filters = null } = opts;

  const whereParts = [];
  const params = [];

  const q = String(search).trim();
  if (q) {
    const like = `%${q}%`;
    let targets;
    if (allColumns) {
      targets = COL_IDS;
    } else {
      targets = ['c01'];
      const dns = roleCol('dns'); const ip = roleCol('ip');
      if (dns) targets.push(dns);
      if (ip) targets.push(ip);
    }
    whereParts.push('(' + targets.map((c) => `${c} LIKE ? COLLATE NOCASE`).join(' OR ') + ')');
    targets.forEach(() => params.push(like));
  }

  const { clause: filterClause, params: filterParams } = buildFilterClause(filters);
  if (filterClause) { whereParts.push(filterClause); params.push(...filterParams); }

  const where = whereParts.length ? 'WHERE ' + whereParts.join(' AND ') : '';

  const sortCol = sortPos >= 1 && sortPos <= NUM_COLS ? COL_IDS[sortPos - 1] : 'id';
  const dir = String(sortDir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM devices ${where}`).get(...params).n;
  const rows = db.prepare(
    `SELECT * FROM devices ${where}
     ORDER BY ${sortCol} COLLATE NOCASE ${dir}, id ${dir}
     LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  return { total, rows };
}

/**
 * Lookup by hostname or IP address (the headline feature).
 *
 * Exact match first — that hits the indexes and covers the normal case.
 * If nothing matches, fall back to token matching, because the address
 * column may legitimately hold several values in one cell
 * ("10.1.2.3, 10.1.2.4" / semicolon / space / newline separated). The
 * fallback only runs when the fast path found nothing, so the common
 * case pays no cost.
 */
function lookup(term) {
  const t = String(term).trim();
  if (!t) return [];
  const dns = roleCol('dns'); const ip = roleCol('ip');

  const parts = []; const params = [];
  if (dns) { parts.push(`${dns} = ? COLLATE NOCASE`); params.push(t); }
  if (ip) { parts.push(`${ip} = ? COLLATE NOCASE`); params.push(t); }
  if (!parts.length) return [];

  const exact = db.prepare(`SELECT * FROM devices WHERE ${parts.join(' OR ')}`).all(...params);
  if (exact.length) return exact;

  // Token fallback: narrow with LIKE (so SQLite can still skip most rows),
  // then confirm in JS that the term is a whole delimited value, not a
  // coincidental substring — otherwise "10.1.2.3" would match "10.1.2.30".
  const like = `%${t}%`;
  const cand = [];
  if (ip) cand.push(...db.prepare(`SELECT * FROM devices WHERE ${ip} LIKE ? COLLATE NOCASE`).all(like));
  if (dns) cand.push(...db.prepare(`SELECT * FROM devices WHERE ${dns} LIKE ? COLLATE NOCASE`).all(like));

  const wanted = t.toLowerCase();
  const seen = new Set();
  return cand.filter((r) => {
    if (seen.has(r.id)) return false;
    const fields = [ip && r[ip], dns && r[dns]].filter(Boolean);
    const hit = fields.some((v) =>
      String(v).split(/[,;|\s]+/).some((tok) => tok.trim().toLowerCase() === wanted)
    );
    if (hit) { seen.add(r.id); return true; }
    return false;
  });
}

function getDevice(id) {
  return db.prepare('SELECT * FROM devices WHERE id = ?').get(id) || null;
}

/* ---------------------------------------------------------------- CRUD */

function saveDevice(id, values, user) {
  const now = new Date().toISOString();
  const vals = COL_IDS.map((c) => String(values[c] ?? ''));
  if (id) {
    db.prepare(
      `UPDATE devices SET ${COL_IDS.map((c) => `${c} = ?`).join(', ')},
       updated_at = ?, updated_by = ? WHERE id = ?`
    ).run(...vals, now, user || '', id);
    return getDevice(id);
  }
  const info = db.prepare(
    `INSERT INTO devices (${COL_IDS.join(', ')}, updated_at, updated_by)
     VALUES (${COL_IDS.map(() => '?').join(', ')}, ?, ?)`
  ).run(...vals, now, user || '');
  return getDevice(Number(info.lastInsertRowid));
}

/**
 * Delete devices, recording a tombstone for each.
 *
 * The tombstone is what lets a downstream sync (ServiceNow, Orion) learn
 * that a device went away. Without it, decommissioned kit would linger in
 * external dashboards forever, because a pull-based sync only ever sees
 * rows that still exist.
 */
function deleteDevices(ids, user = '') {
  const dnsCol = roleCol('dns');
  const get = db.prepare('SELECT * FROM devices WHERE id = ?');
  const del = db.prepare('DELETE FROM devices WHERE id = ?');
  const tomb = db.prepare(
    `INSERT INTO deletions (device_id, deleted_at, deleted_by, dns)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET deleted_at = excluded.deleted_at,
       deleted_by = excluded.deleted_by, dns = excluded.dns`
  );
  const now = new Date().toISOString();
  tx(() => {
    for (const id of ids) {
      const row = get.get(id);
      tomb.run(id, now, user || '', row && dnsCol ? String(row[dnsCol] || '') : '');
      del.run(id);
    }
  });
  return ids.length;
}

/** Devices deleted since an ISO timestamp — for incremental external syncs. */
function deletionsSince(iso) {
  if (iso) {
    return db.prepare(
      'SELECT device_id AS id, deleted_at, deleted_by, dns FROM deletions WHERE deleted_at > ? ORDER BY deleted_at'
    ).all(String(iso));
  }
  return db.prepare(
    'SELECT device_id AS id, deleted_at, deleted_by, dns FROM deletions ORDER BY deleted_at'
  ).all();
}

/** A device id reappearing (re-imported) should clear its tombstone. */
function clearTombstones(ids) {
  if (!ids || !ids.length) return 0;
  const del = db.prepare('DELETE FROM deletions WHERE device_id = ?');
  tx(() => { ids.forEach((id) => del.run(id)); });
  return ids.length;
}

/** Bulk insert used by CSV import / seeding. rowsOfArrays: string[39][] */
function insertMany(rowsOfArrays, user) {
  const now = new Date().toISOString();
  const ins = db.prepare(
    `INSERT INTO devices (${COL_IDS.join(', ')}, updated_at, updated_by)
     VALUES (${COL_IDS.map(() => '?').join(', ')}, ?, ?)`
  );
  tx(() => {
    for (const r of rowsOfArrays) ins.run(...r, now, user || '');
  });
  return rowsOfArrays.length;
}

/* -------------------------------------------------------------- import */

/**
 * Which column identifies "the same device" on import?
 * The DNS-role column, since that's the natural unique key for an asset
 * inventory. Falls back to column 1 (Name) if no DNS role is configured.
 */
function matchColumn() {
  return roleCol('dns') || COL_IDS[0];
}

function matchColumnName() {
  const row = db.prepare("SELECT name FROM columns WHERE role = 'dns'").get()
    || db.prepare('SELECT name FROM columns WHERE pos = 1').get();
  return row ? row.name : 'Name';
}

/** Map of lowercased match-key → existing device id. */
function existingKeyMap() {
  const col = matchColumn();
  const map = new Map();
  for (const r of db.prepare(`SELECT id, ${col} AS k FROM devices`).all()) {
    const k = String(r.k ?? '').trim().toLowerCase();
    if (k) map.set(k, r.id);
  }
  return map;
}

/**
 * Dry run: how would this file land? Counts new vs. already-present rows
 * without writing anything, so the UI can ask the user what to do.
 */
function analyzeImport(rowsOfArrays) {
  const idx = COL_IDS.indexOf(matchColumn());
  const map = existingKeyMap();
  const seen = new Set();
  let newCount = 0, dupCount = 0, dupInFile = 0, blankKey = 0;
  const examples = [];

  for (const r of rowsOfArrays) {
    const raw = String(r[idx] ?? '').trim();
    const k = raw.toLowerCase();
    if (!k) { blankKey++; newCount++; continue; }   // no key → always a new row
    if (seen.has(k)) { dupInFile++; continue; }     // repeated within the file
    seen.add(k);
    if (map.has(k)) {
      dupCount++;
      if (examples.length < 5) examples.push(raw);
    } else {
      newCount++;
    }
  }
  return {
    total: rowsOfArrays.length,
    newCount, dupCount, dupInFile, blankKey,
    matchColumn: matchColumnName(),
    examples,
  };
}

/**
 * Apply an import.
 *   mode 'skip'   → insert new rows only; leave existing devices untouched
 *   mode 'update' → insert new rows AND overwrite existing ones (upsert)
 *   mode 'reject' → refuse the whole file if any duplicate exists
 * Always all-or-nothing: one transaction, nothing partial.
 * Never deletes: rows already in the database that aren't in the file stay.
 */
function importRows(rowsOfArrays, mode = 'skip', user = '') {
  if (!['skip', 'update', 'reject'].includes(mode)) {
    throw new Error(`Unknown import mode "${mode}".`);
  }
  const idx = COL_IDS.indexOf(matchColumn());
  const map = existingKeyMap();
  const now = new Date().toISOString();

  if (mode === 'reject') {
    const a = analyzeImport(rowsOfArrays);
    if (a.dupCount || a.dupInFile) {
      const errs = [];
      if (a.dupCount) {
        errs.push(`${a.dupCount} row(s) match devices already in the database ` +
          `(by ${a.matchColumn}): ${a.examples.join(', ')}${a.dupCount > a.examples.length ? ', …' : ''}`);
      }
      if (a.dupInFile) {
        errs.push(`${a.dupInFile} row(s) are duplicated within the file itself.`);
      }
      errs.push('Nothing was imported. Re-run the import and choose “update” or “skip”.');
      return { ok: false, errors: errs, inserted: 0, updated: 0, skipped: 0, matchColumn: a.matchColumn };
    }
  }

  const ins = db.prepare(
    `INSERT INTO devices (${COL_IDS.join(', ')}, updated_at, updated_by)
     VALUES (${COL_IDS.map(() => '?').join(', ')}, ?, ?)`
  );
  const upd = db.prepare(
    `UPDATE devices SET ${COL_IDS.map((c) => `${c} = ?`).join(', ')},
     updated_at = ?, updated_by = ? WHERE id = ?`
  );

  let inserted = 0, updated = 0, skipped = 0;
  tx(() => {
    for (const r of rowsOfArrays) {
      const k = String(r[idx] ?? '').trim().toLowerCase();
      const existingId = k ? map.get(k) : undefined;
      if (existingId !== undefined) {
        if (mode === 'update') { upd.run(...r, now, user || '', existingId); updated++; }
        else { skipped++; }
      } else {
        const info = ins.run(...r, now, user || '');
        inserted++;
        // Track it so later rows in the same file matching this key are
        // treated as duplicates too, rather than inserted twice.
        if (k) map.set(k, Number(info.lastInsertRowid));
      }
    }
  });
  return { ok: true, errors: [], inserted, updated, skipped, matchColumn: matchColumnName() };
}

/** Remove every device row (used by seed --wipe). */
function wipeDevices() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM devices').get().n;
  db.exec('DELETE FROM devices');
  return n;
}

/* -------------------------------------------------------------- export */

/** All matching rows (no paging) for CSV export. ids limits to selection. */
function exportRows({ search = '', allColumns = false, ids = null, filters = null } = {}) {
  if (ids && ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM devices WHERE id IN (${placeholders}) ORDER BY id`).all(...ids);
  }
  const { rows } = query({ search, allColumns, filters, offset: 0, limit: 100000000 });
  return rows;
}

/* --------------------------------------------------------------- stats */

/** Simple stats for the REST API / future ServiceNow dashboards. */
function stats(groupPos) {
  const total = db.prepare('SELECT COUNT(*) AS n FROM devices').get().n;
  const out = { total, generatedAt: new Date().toISOString() };
  const pos = Number(groupPos);
  if (pos >= 1 && pos <= NUM_COLS) {
    const col = COL_IDS[pos - 1];
    out.groupBy = db.prepare('SELECT name FROM columns WHERE pos = ?').get(pos).name;
    out.groups = db.prepare(
      `SELECT ${col} AS value, COUNT(*) AS count FROM devices
       GROUP BY ${col} ORDER BY count DESC LIMIT 100`
    ).all();
  }
  return out;
}

module.exports = {
  NUM_COLS, COL_IDS, DEFAULT_NAMES,
  open, close, getPath,
  getColumns, renameColumn, setRole,
  colIdForKey, columnByKey, setColumnKey, applySchema,
  deletionsSince, clearTombstones, distinctValues,
  query, lookup, getDevice,
  saveDevice, deleteDevices, insertMany, wipeDevices,
  analyzeImport, importRows, matchColumnName,
  exportRows, stats,
};
