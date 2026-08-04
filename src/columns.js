/**
 * DeviceDB — canonical column definitions. SINGLE SOURCE OF TRUTH.
 *
 * Each of the 39 user-facing fields has three parts:
 *
 *   name  — the display label shown in the grid. Editable in Settings.
 *   key   — the STABLE API identifier. Generated once, then frozen.
 *           External consumers (ServiceNow transform maps, Orion connectors,
 *           dashboards, scripts) reference this and nothing else, so renaming
 *           a display label never breaks an integration.
 *   role  — optional: 'dns' marks the hostname column, 'ip' the address
 *           column. These two drive the indexed lookup and CSV import dedup.
 *
 * Physically the values live in generic SQLite columns c01..c39; position in
 * this array determines which. Reordering this array would remap existing
 * data — don't. Add new meaning by renaming, not by moving.
 */
'use strict';

/**
 * Turn a display name into a stable snake_case key.
 * "Application Service" → application_service
 * "MaintSLA"            → maint_sla
 * "dcLoc"               → dc_loc
 * "ITS 1"               → its_1
 */
function slugify(name) {
  return String(name)
    .trim()
    // split camelCase / acronym boundaries: "MaintSLA" → "Maint SLA"
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, '_')   // spaces, punctuation, parens → _
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    || 'field';
}

// Display names in grid order, positions 1..39.
const NAMES = [
  'Type',                // 1
  'Status',              // 2
  'Name',                // 3   ← hostname (dns role)
  'Application Service', // 4
  'Env',                 // 5
  'Metal',               // 6
  'Mgmt',                // 7
  'Netcolor',            // 8
  'Security',            // 9
  'Alias',               // 10
  'OS',                  // 11
  'dcLoc',               // 12
  'LoC',                 // 13
  'Format',              // 14
  'Serial',              // 15
  'Mfg',                 // 16
  'Mdl',                 // 17
  'IPs',                 // 18  ← address(es) (ip role); may hold a list
  'eaLic',               // 19
  'itsGroup',            // 20
  'impUsers',            // 21
  'ITS 1',               // 22
  'ITS 2',               // 23
  'Shadow 1',            // 24
  'Shadow 2',            // 25
  'Business 1',          // 26
  'Business 2',          // 27
  'Purchased',           // 28
  'PoNo',                // 29
  'AFE',                 // 30
  'SAP',                 // 31
  'MaintVndr',           // 32
  'ContractNo',          // 33
  'MaintStart',          // 34
  'MaintExp',            // 35
  'MaintSLA',            // 36
  'Verified',            // 37
  'Verf By',             // 38
  'Updated',             // 39
];

const ROLES = { 3: 'dns', 18: 'ip' };

/**
 * Explicit keys for names the camelCase splitter gets wrong — mixed-case
 * abbreviations like "IPs" and "LoC" would otherwise become i_ps / lo_c.
 * Keyed by position so it stays unambiguous.
 */
const KEY_OVERRIDES = {
  13: 'loc',   // LoC
  18: 'ips',   // IPs
};

/** [{ pos, name, key, role }] — the canonical schema. */
const COLUMNS = NAMES.map((name, i) => ({
  pos: i + 1,
  name,
  key: KEY_OVERRIDES[i + 1] || slugify(name),
  role: ROLES[i + 1] || null,
}));

// Fail loudly at startup rather than shipping ambiguous API field names.
const seen = new Map();
for (const c of COLUMNS) {
  if (seen.has(c.key)) {
    throw new Error(
      `Duplicate column key "${c.key}" from "${c.name}" (pos ${c.pos}) and ` +
      `"${seen.get(c.key)}". Keys must be unique — rename one of them.`
    );
  }
  seen.set(c.key, c.name);
}

module.exports = { COLUMNS, NAMES, ROLES, slugify };
