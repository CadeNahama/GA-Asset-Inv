/**
 * DeviceDB — apply the canonical column schema to an existing database.
 *
 *   node scripts/apply-columns.js            → show what would change (dry run)
 *   node scripts/apply-columns.js --apply    → write the changes
 *   node scripts/apply-columns.js --apply --keys   → also reset API keys
 *
 * Renames the 39 display labels and sets the dns/ip roles from
 * src/columns.js. Device DATA is never touched — values stay in the same
 * physical columns; only the labels above them change.
 *
 * API keys are left alone by default, because external systems reference
 * them. Pass --keys to force them back to canonical (safe before anything
 * has been integrated; disruptive afterwards).
 */
'use strict';

const path = require('path');
const db = require('../src/db');
const { COLUMNS } = require('../src/columns');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const RESET_KEYS = args.includes('--keys');

let file = {};
try { file = require('../config.json'); } catch (_) { /* optional */ }
const DB_PATH = process.env.DB_PATH || file.dbPath ||
  path.join(__dirname, '..', 'data', 'devicedb.sqlite');

db.open(DB_PATH);

const current = db.getColumns();
const changes = [];

for (const want of COLUMNS) {
  const have = current.find((c) => c.pos === want.pos);
  if (!have) continue;
  const row = { pos: want.pos, name: null, key: null, role: null };
  if (have.name !== want.name) row.name = [have.name, want.name];
  if (RESET_KEYS && have.key !== want.key) row.key = [have.key, want.key];
  if ((have.role || null) !== (want.role || null)) row.role = [have.role, want.role];
  if (row.name || row.key || row.role) changes.push(row);
}

const total = db.stats().total;
console.log(`Database : ${DB_PATH}`);
console.log(`Devices  : ${total.toLocaleString()} (data is not modified by this script)`);
console.log('');

if (!changes.length) {
  console.log('Nothing to change — the database already matches src/columns.js.');
  db.close();
  process.exit(0);
}

console.log(`${changes.length} column(s) differ from the canonical schema:\n`);
for (const c of changes) {
  const bits = [];
  if (c.name) bits.push(`name "${c.name[0]}" → "${c.name[1]}"`);
  if (c.key) bits.push(`key "${c.key[0]}" → "${c.key[1]}"`);
  if (c.role) bits.push(`role ${c.role[0] || 'none'} → ${c.role[1] || 'none'}`);
  console.log(`  ${String(c.pos).padStart(2)}  ${bits.join(', ')}`);
}
console.log('');

if (!APPLY) {
  console.log('Dry run — nothing written. Re-run with --apply to make these changes.');
  if (!RESET_KEYS) console.log('(API keys left as-is. Add --keys to reset those too.)');
  db.close();
  process.exit(0);
}

try {
  db.applySchema(COLUMNS, { keys: RESET_KEYS });
} catch (e) {
  console.error('FAILED — nothing was changed:', e.message);
  db.close();
  process.exit(1);
}

console.log('Applied. Current schema:\n');
for (const c of db.getColumns()) {
  console.log(`  ${String(c.pos).padStart(2)}  ${c.name.padEnd(21)} → ${c.key}${c.role ? '   [' + c.role.toUpperCase() + ']' : ''}`);
}
db.close();
