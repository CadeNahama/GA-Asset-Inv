/**
 * DeviceDB — export a CSV shaped for the ServiceNow import table.
 *
 *   node scripts/export-servicenow.js              → sample (500) + full files
 *   node scripts/export-servicenow.js --count=2000 → custom sample size
 *
 * Why this exists instead of using the app's normal CSV export:
 *
 * ServiceNow's "Load Data → Create table" builds the staging table's column
 * names from the CSV header row, by lowercasing and replacing punctuation.
 * Those generated names must match the TARGET table's column names for
 * "Auto map matching fields" to work.
 *
 * The target table was built by hand in the PDI, and ServiceNow's own
 * camelCase handling there was inconsistent (MaintSLA → u_maint_sla, but
 * MaintExp → u_maintexp). So rather than fight it, this script emits headers
 * that are already the exact target column names minus the `u_` prefix.
 * Sanitising an already-snake_case string is a no-op, so what ServiceNow
 * generates is guaranteed to equal what's in the target table.
 *
 * If the PDI table ever changes, update SN_HEADERS below — nothing else.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const db = require('../src/db');
const csv = require('../src/csv');

/**
 * appKey → ServiceNow staging header (target column name without `u_`).
 * Order here is the column order in the output file.
 */
const SN_HEADERS = [
  ['name',                'name'],
  ['type',                'type'],
  ['status',              'status'],
  ['application_service', 'application_service'],
  ['env',                 'env'],
  ['security',            'security'],
  ['netcolor',            'netcolor'],
  ['dc_loc',              'dcloc'],        // target is u_dcloc
  ['loc',                 'loc'],
  ['os',                  'os'],
  ['ips',                 'ips'],
  ['its_group',           'itsgroup'],     // target is u_itsgroup
  ['its_1',               'its_1'],
  ['maint_vndr',          'maint_vndr'],
  ['maint_exp',           'maintexp'],     // target is u_maintexp
  ['maint_sla',           'maint_sla'],
  ['verified',            'verified'],
  ['imp_users',           'impusers'],     // target is u_impusers
];

/**
 * Headers whose target column in ServiceNow is a Date / Date-Time field.
 *
 * ServiceNow parses imported dates with the system DATE-TIME format string
 * (`yyyy-MM-dd HH:mm:ss`), even for Date fields. A bare `2026-10-08` fails
 * with "Unable to format ... using format string yyyy-MM-dd HH:mm:ss", so we
 * append a midnight time component. A Date field discards the time; a
 * Date/Time field keeps it. Either way it parses.
 */
const DATE_FIELDS = new Set(['maintexp', 'verified']);

/** '2026-10-08' → '2026-10-08 00:00:00'; blanks stay blank. */
function asDateTime(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s} 00:00:00` : s;
}

const args = process.argv.slice(2);
const countArg = args.find((a) => a.startsWith('--count='));
const SAMPLE = countArg ? Number(countArg.split('=')[1]) : 500;

let file = {};
try { file = require('../config.json'); } catch (_) { /* optional */ }
const DB_PATH = process.env.DB_PATH || file.dbPath ||
  path.join(__dirname, '..', 'data', 'devicedb.sqlite');

db.open(DB_PATH);

// Resolve each app key to its physical c-column, failing loudly if the
// schema drifted rather than silently exporting blank columns.
const cols = db.getColumns();
const resolved = SN_HEADERS.map(([appKey, snHeader]) => {
  const col = cols.find((c) => c.key === appKey);
  if (!col) {
    console.error(`ERROR: no column with key "${appKey}" in the database.`);
    console.error('Available keys:', cols.map((c) => c.key).join(', '));
    process.exit(1);
  }
  return {
    snHeader,
    cid: db.COL_IDS[col.pos - 1],
    label: col.name,
    isDate: DATE_FIELDS.has(snHeader),
  };
});

const header = resolved.map((r) => r.snHeader);
const all = db.exportRows({});
const rows = all.map((r) =>
  resolved.map((x) => (x.isDate ? asDateTime(r[x.cid]) : r[x.cid]))
);

const outDir = path.join(__dirname, '..');
const fullPath = path.join(outDir, 'servicenow-import-full.csv');
const samplePath = path.join(outDir, 'servicenow-import-sample.csv');

// bom:false is REQUIRED — ServiceNow does not strip a UTF-8 BOM, and would
// create the first column as "u_<BOM>name" instead of "u_name".
fs.writeFileSync(fullPath, csv.serialize(header, rows, { bom: false }));
fs.writeFileSync(samplePath, csv.serialize(header, rows.slice(0, SAMPLE), { bom: false }));

console.log(`Columns (${header.length}):`);
for (const r of resolved) {
  const flag = r.snHeader === r.label.toLowerCase().replace(/[^a-z0-9]+/g, '_') ? '' : '  ← remapped';
  console.log(`  ${r.label.padEnd(21)} → u_${r.snHeader}${flag}`);
}
console.log('');
console.log(`sample : ${Math.min(SAMPLE, rows.length).toLocaleString()} rows → ${samplePath}`);
console.log(`full   : ${rows.length.toLocaleString()} rows → ${fullPath}`);

db.close();
