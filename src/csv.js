/**
 * DeviceDB — CSV parse/serialize (RFC 4180). No external dependencies.
 * Handles quoted fields, embedded commas/quotes/newlines, CRLF, and BOM.
 */
'use strict';

/** Parse CSV text into string[][]. */
function parse(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  // trailing field/row
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  // drop fully blank trailing rows
  while (rows.length && rows[rows.length - 1].every((f) => f.trim() === '')) rows.pop();
  return rows;
}

function escapeField(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Serialize header + rows to CSV text (CRLF, with BOM for Excel). */
function serialize(header, rows) {
  const lines = [header.map(escapeField).join(',')];
  for (const r of rows) lines.push(r.map(escapeField).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/**
 * Validate an imported CSV against the configured column names.
 * Returns { ok, errors: string[], rows: string[39][] }.
 * Header must contain exactly the 39 configured names, in order,
 * matched case-insensitively with surrounding whitespace ignored.
 */
function validateImport(text, columnNames) {
  const errors = [];
  let parsed;
  try {
    parsed = parse(text);
  } catch (e) {
    return { ok: false, errors: ['File could not be parsed as CSV: ' + e.message], rows: [] };
  }
  if (!parsed.length) return { ok: false, errors: ['File is empty.'], rows: [] };

  const norm = (s) => String(s).trim().toLowerCase();
  const header = parsed[0].map(norm);
  const expected = columnNames.map(norm);

  if (header.length !== expected.length) {
    errors.push(
      `Header has ${header.length} column(s) but ${expected.length} are required. ` +
      `Export the CSV template from DeviceDB to get the exact format.`
    );
  } else {
    for (let i = 0; i < expected.length; i++) {
      if (header[i] !== expected[i]) {
        errors.push(
          `Column ${i + 1} is "${parsed[0][i]}" but should be "${columnNames[i]}".`
        );
        if (errors.length >= 10) { errors.push('…more header mismatches omitted.'); break; }
      }
    }
  }
  if (errors.length) return { ok: false, errors, rows: [] };

  const dataRows = [];
  for (let r = 1; r < parsed.length; r++) {
    const row = parsed[r];
    if (row.every((f) => f.trim() === '')) continue; // skip blank lines
    if (row.length !== expected.length) {
      errors.push(`Row ${r + 1} has ${row.length} value(s); expected ${expected.length}.`);
      if (errors.length >= 10) { errors.push('…more row errors omitted.'); break; }
      continue;
    }
    dataRows.push(row.map((f) => f.trim()));
  }
  if (errors.length) return { ok: false, errors, rows: [] };
  if (!dataRows.length) return { ok: false, errors: ['No data rows found below the header.'], rows: [] };
  return { ok: true, errors: [], rows: dataRows };
}

module.exports = { parse, serialize, validateImport };
