/**
 * DeviceDB — sample data generator.
 *
 *   node scripts/seed.js                 → add 8,000 realistic fake devices
 *   node scripts/seed.js --count=500     → add a custom number
 *   node scripts/seed.js --wipe          → delete ALL devices (then exit)
 *   node scripts/seed.js --wipe --count=8000  → wipe, then seed fresh
 *
 * Uses the same DB module and path resolution as the server, so run it
 * with the server stopped or running — SQLite handles it either way.
 */
'use strict';

const path = require('path');
const db = require('../src/db');

/* ------------------------------------------------------------- config */

const args = process.argv.slice(2);
const WIPE = args.includes('--wipe');
const countArg = args.find((a) => a.startsWith('--count='));
const COUNT = countArg ? Number(countArg.split('=')[1]) : (WIPE && !countArg && args.length === 1 ? 0 : 8000);

let file = {};
try { file = require('../config.json'); } catch (_) { /* optional */ }
const DB_PATH = process.env.DB_PATH || file.dbPath ||
  path.join(__dirname, '..', 'data', 'devicedb.sqlite');

/* ---------------------------------------------------------- generators */

let seedVal = 42;
function rnd() { // deterministic PRNG so runs are reproducible
  seedVal = (seedVal * 1103515245 + 12345) & 0x7fffffff;
  return seedVal / 0x7fffffff;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const chance = (p) => rnd() < p;

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const rndStr = (chars, n) => Array.from({ length: n }, () => chars[Math.floor(rnd() * chars.length)]).join('');

const TYPES = ['Server', 'Server', 'Server', 'VM', 'VM', 'VM', 'VM', 'Appliance', 'Application', 'Network Device', 'Storage Array'];
const STATUS = ['Active', 'Active', 'Active', 'Active', 'Active', 'Maintenance', 'Retired', 'Decommissioned', 'Provisioning'];
const APPS = ['Payroll', 'ERP', 'Email Gateway', 'File Services', 'CAD/PLM', 'HR Portal', 'Backup', 'Domain Services',
  'Web Hosting', 'Database Services', 'CI/CD', 'Monitoring', 'VDI', 'SharePoint', 'ServiceNow MID', 'Print Services',
  'Badge/Access Control', 'Telemetry Ingest', 'License Server', 'DNS/DHCP'];
const ENVS = ['Production', 'Production', 'Production', 'Development', 'Test', 'QA', 'DR', 'Staging'];
const LOCATIONS = ['San Diego, CA', 'Poway, CA', 'Palmdale, CA', 'Tupelo, MS', 'Huntsville, AL', 'Remote/Colo'];
const DATACENTERS = ['SD-DC1', 'SD-DC2', 'PWY-DC1', 'PMD-DC1', 'TUP-DC1', 'HSV-DC1', 'AWS-GovCloud'];
const OSES = [
  ['Windows Server', ['2016', '2019', '2022', '2025']],
  ['Windows Server', ['2019', '2022']],
  ['RHEL', ['7.9', '8.9', '8.10', '9.4', '9.5']],
  ['Ubuntu Server', ['20.04 LTS', '22.04 LTS', '24.04 LTS']],
  ['VMware ESXi', ['7.0 U3', '8.0 U2', '8.0 U3']],
  ['Cisco IOS', ['15.2', '17.3', '17.9']],
  ['Appliance OS', ['4.2', '5.1', '6.0']],
];
const MANUFACTURERS = ['Dell', 'HPE', 'Cisco', 'Supermicro', 'Lenovo', 'NetApp', 'Palo Alto', 'F5', 'VMware'];
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
const OWNERS = ['J. Martinez', 'K. Chen', 'T. Nguyen', 'R. Patel', 'S. Johnson', 'M. Williams', 'D. Kim', 'A. Garcia',
  'L. Brown', 'C. Davis', 'P. Anderson', 'B. Thomas', 'E. Robinson', 'N. Clark', 'H. Lewis'];
const GROUPS = ['ITS-Infrastructure', 'ITS-Network', 'ITS-AppSupport', 'ITS-Security', 'ITS-Storage', 'ITS-Virtualization', 'ITS-EndUser'];
const BUSINESS_UNITS = ['ASI', 'EMS', 'Corporate', 'GA-ASI Flight Ops', 'Engineering', 'Manufacturing', 'Finance', 'HR'];
const CRITICALITY = ['Critical', 'High', 'High', 'Medium', 'Medium', 'Medium', 'Low', 'Low'];
const COMPLIANCE = ['Compliant', 'Compliant', 'Compliant', 'Non-Compliant', 'Exception Filed', 'Pending Review'];
const BACKUP = ['Nightly', 'Nightly', 'Weekly', 'Continuous', 'None', 'N/A'];
const MONITORING = ['SolarWinds', 'SolarWinds', 'Zabbix', 'SCOM', 'None'];
const NOTES = ['', '', '', '', 'Scheduled for refresh FY27', 'Pending decom ticket', 'Migrated from legacy DC',
  'Owned by program office', 'Do not reboot without approval', 'Cluster member — see cluster notes', ''];

function isoDate(daysAgoMax) {
  const d = new Date(Date.now() - int(0, daysAgoMax) * 86400000);
  return d.toISOString().slice(0, 10);
}
function futureDate(daysMax) {
  const d = new Date(Date.now() + int(30, daysMax) * 86400000);
  return d.toISOString().slice(0, 10);
}
function mac() {
  return Array.from({ length: 6 }, () =>
    int(0, 255).toString(16).padStart(2, '0').toUpperCase()).join(':');
}

function makeDevice(i) {
  const type = pick(TYPES);
  const app = pick(APPS);
  const env = pick(ENVS);
  const loc = pick(LOCATIONS);
  const dc = pick(DATACENTERS);
  const virtual = type === 'VM' || (type === 'Application' && chance(0.8));

  // Mix of naming styles: structured GA hostnames + opaque legacy names.
  const short = chance(0.75)
    ? `ga-${app.toLowerCase().replace(/[^a-z]+/g, '').slice(0, 6)}-${String(int(1, 999)).padStart(3, '0')}${pick(['a', 'b', 'p', 'd', ''])}`
    : rndStr(LETTERS, int(4, 8)) + rndStr(ALNUM, int(3, 6));
  const dns = `${short}.ga.local`;

  const subnetB = int(1, 12) * 8;
  const subnetC = int(0, 250);
  const ip = `10.${subnetB}.${subnetC}.${int(2, 254)}`;

  const [osName, versions] = virtual && chance(0.5) ? OSES[int(0, 3)] : pick(OSES);
  const manufacturer = virtual ? 'VMware' : pick(MANUFACTURERS);
  const cores = pick([2, 4, 4, 8, 8, 16, 16, 32, 64]);
  const mem = pick([8, 16, 16, 32, 32, 64, 128, 256, 512]);
  const storage = pick([100, 250, 500, 500, 1000, 2000, 4000, 8000, 16000]);
  const owner = pick(OWNERS);

  return [
    short.toUpperCase(),                    // 01 Name
    dns,                                    // 02 DNS Name
    ip,                                     // 03 IP Address
    type,                                   // 04 Type
    pick(STATUS),                           // 05 Status
    app,                                    // 06 Application Service
    env,                                    // 07 Environment
    loc,                                    // 08 Location
    dc,                                     // 09 Datacenter
    virtual ? '' : `${pick(['A', 'B', 'C', 'D'])}${int(1, 24)}-U${int(1, 42)}`, // 10 Rack
    osName,                                 // 11 Operating System
    pick(versions),                         // 12 OS Version
    manufacturer,                           // 13 Manufacturer
    pick(MODELS[manufacturer] || ['—']),    // 14 Model
    rndStr(LETTERS, 3) + rndStr('0123456789', 7), // 15 Serial Number
    'GA-' + String(100000 + i),             // 16 Asset Tag
    owner,                                  // 17 Owner
    pick(GROUPS),                           // 18 Owner Group
    pick(GROUPS),                           // 19 Support Group
    pick(BUSINESS_UNITS),                   // 20 Business Unit
    pick(CRITICALITY),                      // 21 Criticality
    String(cores),                          // 22 CPU Cores
    String(mem),                            // 23 Memory (GB)
    String(storage),                        // 24 Storage (GB)
    virtual ? 'Virtual' : 'Physical',       // 25 Virtual/Physical
    virtual ? `${dc.toLowerCase()}-clu${int(1, 8)}` : '', // 26 Cluster
    'ga.local',                             // 27 Domain
    `10.${subnetB}.${subnetC}.0/24`,        // 28 Subnet
    String(int(10, 900)),                   // 29 VLAN
    mac(),                                  // 30 MAC Address
    isoDate(90),                            // 31 Last Patched
    isoDate(2500),                          // 32 Install Date
    chance(0.85) ? futureDate(1400) : isoDate(300), // 33 Warranty Expiration
    'CC-' + int(1000, 9999),                // 34 Cost Center
    pick(COMPLIANCE),                       // 35 Compliance Status
    pick(BACKUP),                           // 36 Backup Status
    pick(MONITORING),                       // 37 Monitoring
    pick(NOTES),                            // 38 Notes
    owner,                                  // 39 Last Updated By
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
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone: ${COUNT.toLocaleString()} devices in ${secs}s → ${DB_PATH}`);
  console.log('Try looking one up in the app, e.g. search for "ga-" or an IP like "10.16."');
}

db.close();
