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

const NUM_COLS = 39;
const COL_IDS = Array.from({ length: NUM_COLS }, (_, i) =>
  'c' + String(i + 1).padStart(2, '0')
);

// Sensible defaults; every one of these is renameable in Settings.
const DEFAULT_NAMES = [
  'Name', 'DNS Name', 'IP Address', 'Type', 'Status', 'Application Service',
  'Environment', 'Location', 'Datacenter', 'Rack', 'Operating System',
  'OS Version', 'Manufacturer', 'Model', 'Serial Number', 'Asset Tag',
  'Owner', 'Owner Group', 'Support Group', 'Business Unit', 'Criticality',
  'CPU Cores', 'Memory (GB)', 'Storage (GB)', 'Virtual/Physical',
  'Cluster', 'Domain', 'Subnet', 'VLAN', 'MAC Address',
  'Last Patched', 'Install Date', 'Warranty Expiration', 'Cost Center',
  'Compliance Status', 'Backup Status', 'Monitoring', 'Notes', 'Last Updated By'
];

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
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ${COL_IDS.map((c) => `${c} TEXT NOT NULL DEFAULT ''`).join(',\n      ')},
      updated_at TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT ''
    );
  `);

  // Seed column names on first run.
  const count = db.prepare('SELECT COUNT(*) AS n FROM columns').get().n;
  if (count === 0) {
    const ins = db.prepare('INSERT INTO columns (pos, name, role) VALUES (?, ?, ?)');
    tx(() => {
      for (let i = 0; i < NUM_COLS; i++) {
        const role = i === 1 ? 'dns' : i === 2 ? 'ip' : null;
        ins.run(i + 1, DEFAULT_NAMES[i], role);
      }
    });
  }
  rebuildRoleIndexes();
}

/* ------------------------------------------------------------- columns */

function getColumns() {
  return db.prepare('SELECT pos, name, role FROM columns ORDER BY pos').all();
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
 * Windowed query for the virtualized table.
 * opts: { search, allColumns, sortPos, sortDir, offset, limit }
 * Search matches Name + DNS + IP columns by default (case-insensitive
 * substring); allColumns=true widens it to every column.
 */
function query(opts = {}) {
  const { search = '', allColumns = false, sortPos = 0, sortDir = 'ASC',
          offset = 0, limit = 100 } = opts;

  let where = '';
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
    where = 'WHERE ' + targets.map((c) => `${c} LIKE ? COLLATE NOCASE`).join(' OR ');
    targets.forEach(() => params.push(like));
  }

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

/** Exact lookup by DNS name or IP address (the headline feature). */
function lookup(term) {
  const t = String(term).trim();
  if (!t) return [];
  const dns = roleCol('dns'); const ip = roleCol('ip');
  const parts = []; const params = [];
  if (dns) { parts.push(`${dns} = ? COLLATE NOCASE`); params.push(t); }
  if (ip) { parts.push(`${ip} = ? COLLATE NOCASE`); params.push(t); }
  if (!parts.length) return [];
  return db.prepare(`SELECT * FROM devices WHERE ${parts.join(' OR ')}`).all(...params);
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

function deleteDevices(ids) {
  const del = db.prepare('DELETE FROM devices WHERE id = ?');
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
function exportRows({ search = '', allColumns = false, ids = null } = {}) {
  if (ids && ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM devices WHERE id IN (${placeholders}) ORDER BY id`).all(...ids);
  }
  const { rows } = query({ search, allColumns, offset: 0, limit: 100000000 });
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
  query, lookup, getDevice,
  saveDevice, deleteDevices, insertMany, wipeDevices,
  analyzeImport, importRows, matchColumnName,
  exportRows, stats,
};
