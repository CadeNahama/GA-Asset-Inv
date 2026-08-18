/**
 * DeviceDB — sample data generator (matches the canonical 39-column schema).
 *
 *   node scripts/seed.js                 → add 8,000 realistic fake devices
 *   node scripts/seed.js --count=500     → add a custom number
 *   node scripts/seed.js --wipe          → delete ALL devices (then exit)
 *   node scripts/seed.js --wipe --count=8000  → wipe, then seed fresh
 *
 * Values are plausible-looking placeholders for shape and volume testing —
 * they are NOT real GA inventory. Deterministic: the same flags always
 * produce the same data.
 */
'use strict';

const path = require('path');
const db = require('../src/db');

/* ------------------------------------------------------------- config */

const args = process.argv.slice(2);
const WIPE = args.includes('--wipe');
const countArg = args.find((a) => a.startsWith('--count='));
const COUNT = countArg ? Number(countArg.split('=')[1]) : (WIPE && args.length === 1 ? 0 : 8000);

let file = {};
try { file = require('../config.json'); } catch (_) { /* optional */ }
const DB_PATH = process.env.DB_PATH || file.dbPath ||
  path.join(__dirname, '..', 'data', 'devicedb.sqlite');

/* ---------------------------------------------------------- generators */

/**
 * Deterministic PRNG (mulberry32) so runs are reproducible.
 *
 * NOT a plain LCG: `seed * 1103515245` exceeds Number.MAX_SAFE_INTEGER, so
 * the low bits are lost to float rounding before the bitwise mask sees them.
 * That collapses the effective period — the previous implementation produced
 * only ~300 distinct devices no matter how many rows were requested.
 * mulberry32 uses Math.imul, which is exact 32-bit multiplication.
 */
let seedVal = 42;
function rnd() {
  seedVal = (seedVal + 0x6d2b79f5) | 0;
  let t = Math.imul(seedVal ^ (seedVal >>> 15), 1 | seedVal);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const chance = (p) => rnd() < p;
const maybe = (v, p = 0.75) => (chance(p) ? v : '');

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const rndStr = (chars, n) => Array.from({ length: n }, () => chars[Math.floor(rnd() * chars.length)]).join('');

const TYPES = ['Server', 'Server', 'Server', 'VM', 'VM', 'VM', 'VM', 'Appliance', 'Application', 'Network Device', 'Storage Array'];
const STATUS = ['Active', 'Active', 'Active', 'Active', 'Active', 'Maintenance', 'Retired', 'Decommissioned', 'Provisioning'];
const APPS = ['Payroll', 'ERP', 'Email Gateway', 'File Services', 'CAD/PLM', 'HR Portal', 'Backup', 'Domain Services',
  'Web Hosting', 'Database Services', 'CI/CD', 'Monitoring', 'VDI', 'SharePoint', 'ServiceNow MID', 'Print Services',
  'Badge/Access Control', 'Telemetry Ingest', 'License Server', 'DNS/DHCP'];
const ENVS = ['Prod', 'Prod', 'Prod', 'Dev', 'Test', 'QA', 'DR', 'Stage'];
const METAL = ['Physical', 'Virtual', 'Virtual', 'Virtual', 'Cloud', 'Container'];
const MGMT = ['SCCM', 'Ansible', 'Puppet', 'Manual', 'Intune', 'vCenter'];
const NETCOLOR = ['Green', 'Yellow', 'Red', 'Black', 'Blue'];
const SECURITY = ['CUI', 'Unclassified', 'Confidential', 'ITAR', 'Public', 'Restricted'];
const OSES = ['Windows Server 2019', 'Windows Server 2022', 'Windows Server 2016', 'Windows Server 2025',
  'RHEL 8.10', 'RHEL 9.4', 'RHEL 9.5', 'Ubuntu 22.04 LTS', 'Ubuntu 24.04 LTS',
  'VMware ESXi 8.0 U3', 'VMware ESXi 7.0 U3', 'Cisco IOS 17.9', 'Appliance OS 5.1'];
const DCLOC = ['SD-DC1', 'SD-DC2', 'PWY-DC1', 'PMD-DC1', 'TUP-DC1', 'HSV-DC1', 'AWS-GovCloud'];
const LOC = ['San Diego, CA', 'Poway, CA', 'Palmdale, CA', 'Tupelo, MS', 'Huntsville, AL', 'Remote/Colo'];
const FORMAT = ['1U', '2U', '4U', 'Blade', 'Tower', 'VM', 'Chassis'];
const MFG = ['Dell', 'HPE', 'Cisco', 'Supermicro', 'Lenovo', 'NetApp', 'Palo Alto', 'F5', 'VMware'];
const MODELS = {
  Dell: ['PowerEdge R650', 'PowerEdge R750', 'PowerEdge R760', 'PowerEdge R660'],
  HPE: ['ProLiant DL360 Gen10', 'ProLiant DL380 Gen11', 'Synergy 480'],
  Cisco: ['UCS C220 M6', 'Catalyst 9300', 'Nexus 9336', 'ASA 5516-X'],
  Supermicro: ['SYS-1029U', 'SYS-6019P', 'AS-1114S'],
  Lenovo: ['ThinkSystem SR630', 'ThinkSystem SR650'],
  NetApp: ['AFF A250', 'FAS8300', 'E5760'],
  'Palo Alto': ['PA-3260', 'PA-5220', 'VM-300'],
  F5: ['BIG-IP i5800', 'BIG-IP VE'],
  VMware: ['Virtual Machine'],
};
const EALIC = ['Enterprise', 'Standard', 'Datacenter', 'Per-Core', 'None', 'OEM'];
const ITS_GROUPS = ['ITS-Infrastructure', 'ITS-Network', 'ITS-AppSupport', 'ITS-Security', 'ITS-Storage', 'ITS-Virtualization', 'ITS-EndUser'];
const PEOPLE = ['J. Martinez', 'K. Chen', 'T. Nguyen', 'R. Patel', 'S. Johnson', 'M. Williams', 'D. Kim', 'A. Garcia',
  'L. Brown', 'C. Davis', 'P. Anderson', 'B. Thomas', 'E. Robinson', 'N. Clark', 'H. Lewis'];
const BUSINESS = ['ASI', 'EMS', 'Corporate', 'Flight Ops', 'Engineering', 'Manufacturing', 'Finance', 'HR'];
const VENDORS = ['Dell ProSupport', 'HPE Pointnext', 'Cisco SmartNet', 'NetApp SupportEdge', 'CDW', 'Insight', 'SHI'];
const SLA = ['24x7x4', 'NBD', '8x5', '24x7x2', 'Best Effort'];

function isoDate(daysAgoMax) {
  return new Date(Date.now() - int(0, daysAgoMax) * 86400000).toISOString().slice(0, 10);
}
function futureDate(daysMax) {
  return new Date(Date.now() + int(30, daysMax) * 86400000).toISOString().slice(0, 10);
}

// Hostnames are the dedup / coalesce key everywhere downstream, so they must
// be unique. Collisions are resolved with a numeric suffix rather than left
// to chance.
const usedNames = new Set();
function uniqueName(base) {
  let name = base;
  let n = 2;
  while (usedNames.has(name.toLowerCase())) name = `${base}-${n++}`;
  usedNames.add(name.toLowerCase());
  return name;
}

function makeDevice(i) {
  const type = pick(TYPES);
  const app = pick(APPS);
  const virtual = type === 'VM' || (type === 'Application' && chance(0.8));
  const mfg = virtual ? 'VMware' : pick(MFG);

  // Mix of structured GA-style hostnames and opaque legacy names.
  const host = uniqueName(chance(0.75)
    ? `ga-${app.toLowerCase().replace(/[^a-z]+/g, '').slice(0, 6)}-${String(int(1, 999)).padStart(3, '0')}${pick(['a', 'b', 'p', 'd', ''])}`
    : rndStr(LETTERS, int(4, 8)) + String(int(10, 99)));

  // A minority of devices carry several addresses in one cell, which is
  // exactly the case the lookup token-matching has to survive.
  const subnetB = int(1, 12) * 8;
  const subnetC = int(0, 250);
  const ip1 = `10.${subnetB}.${subnetC}.${int(2, 254)}`;
  const ips = chance(0.18)
    ? `${ip1}, 10.${subnetB}.${int(0, 250)}.${int(2, 254)}`
    : ip1;

  const maintStart = isoDate(1200);
  const owner = pick(PEOPLE);
  const verifier = pick(PEOPLE);

  return [
    type,                                   // 01 Type
    pick(STATUS),                           // 02 Status
    host.toUpperCase(),                     // 03 Name          [DNS]
    app,                                    // 04 Application Service
    pick(ENVS),                             // 05 Env
    virtual ? 'Virtual' : pick(METAL),      // 06 Metal
    pick(MGMT),                             // 07 Mgmt
    pick(NETCOLOR),                         // 08 Netcolor
    pick(SECURITY),                         // 09 Security
    maybe(`${host}-alt.ga.local`, 0.35),    // 10 Alias
    pick(OSES),                             // 11 OS
    pick(DCLOC),                            // 12 dcLoc
    pick(LOC),                              // 13 LoC
    virtual ? 'VM' : pick(FORMAT),          // 14 Format
    virtual ? '' : rndStr(LETTERS, 3) + rndStr('0123456789', 7), // 15 Serial
    mfg,                                    // 16 Mfg
    pick(MODELS[mfg] || ['—']),             // 17 Mdl
    ips,                                    // 18 IPs           [IP]
    pick(EALIC),                            // 19 eaLic
    pick(ITS_GROUPS),                       // 20 itsGroup
    String(int(1, 400)),                    // 21 impUsers
    owner,                                  // 22 ITS 1
    maybe(pick(PEOPLE), 0.6),               // 23 ITS 2
    maybe(pick(PEOPLE), 0.4),               // 24 Shadow 1
    maybe(pick(PEOPLE), 0.25),              // 25 Shadow 2
    pick(BUSINESS),                         // 26 Business 1
    maybe(pick(BUSINESS), 0.3),             // 27 Business 2
    isoDate(2500),                          // 28 Purchased
    maybe('PO-' + int(100000, 999999), 0.8),// 29 PoNo
    maybe('AFE-' + int(1000, 9999), 0.5),   // 30 AFE
    maybe('SAP-' + int(100000, 999999), 0.7),// 31 SAP
    pick(VENDORS),                          // 32 MaintVndr
    maybe('CTR-' + int(10000, 99999), 0.75),// 33 ContractNo
    maintStart,                             // 34 MaintStart
    chance(0.85) ? futureDate(1400) : isoDate(300), // 35 MaintExp
    pick(SLA),                              // 36 MaintSLA
    isoDate(180),                           // 37 Verified
    verifier,                               // 38 Verf By
    isoDate(90),                            // 39 Updated
  ];
}

/* ----------------------------------------------------------------- run */

db.open(DB_PATH);

if (WIPE) {
  const n = db.wipeDevices();
  console.log(`Wiped ${n.toLocaleString()} device(s).`);
}

if (COUNT > 0) {
  const t0 = Date.now();
  const BATCH = 1000;
  let done = 0;
  while (done < COUNT) {
    const batch = [];
    for (let i = done; i < Math.min(done + BATCH, COUNT); i++) batch.push(makeDevice(i));
    db.insertMany(batch, 'seed-script');
    done += batch.length;
    process.stdout.write(`\rSeeding… ${done.toLocaleString()} / ${COUNT.toLocaleString()}`);
  }
  console.log(`\nDone: ${COUNT.toLocaleString()} devices in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${DB_PATH}`);
  console.log('Try a lookup, e.g. search "ga-" or an IP like "10.16."');
}

db.close();
