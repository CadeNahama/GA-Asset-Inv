/**
 * DeviceDB — frontend. Talks to the server's JSON API over fetch (no
 * Electron IPC — the same code runs in any browser and inside a future
 * Electron shell). Virtualized grid, detail/edit modal, CSV import/export
 * via browser upload/download, light/dark theme.
 */
'use strict';

const ROW_H = 36;
const PAGE = 200; // rows fetched per windowed query

const state = {
  columns: [],       // [{pos, name, role}]
  search: '',
  // Search covers Name + DNS + IP. Set to true to widen it to all 39
  // columns (the old "All columns" toggle; the API still supports it).
  allCols: false,
  sortPos: 0,        // 0 = id order
  sortDir: 'ASC',
  total: 0,
  loaded: false,     // has at least one query come back? (drives the empty state)
  activeId: null,    // row highlighted for Info / copy-row
  activeRow: null,
  activeIndex: null, // its position in the current sort/filter order
  anchorIndex: null, // where a shift-click / shift-arrow range starts
  pages: new Map(),  // pageIndex -> rows[]
  pending: new Set(),
  selected: new Map(), // id -> true
  meta: null,
};

const $ = (id) => document.getElementById(id);
const colId = (pos) => 'c' + String(pos).padStart(2, '0');

/* ----------------------------------------------------------- api layer */

async function apiFetch(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, opts);
  } catch (_) {
    throw new Error('Cannot reach the DeviceDB server. Is it still running?');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || (data.errors || []).join('\n') || `Request failed (${res.status})`);
  return data;
}

const api = {
  meta: () => apiFetch('/api/meta'),
  columns: () => apiFetch('/api/columns'),
  query: ({ search = '', allColumns = false, sortPos = 0, sortDir = 'ASC', offset = 0, limit = PAGE }) =>
    apiFetch(`/api/devices?raw=1&q=${encodeURIComponent(search)}&all=${allColumns ? 1 : 0}` +
             `&sort=${sortPos}&dir=${sortDir}&offset=${offset}&limit=${limit}`)
      .then((d) => ({ total: d.total, rows: d.results })),
  get: (id) => apiFetch(`/api/devices/${id}?raw=1`),
  save: (id, values) => id
    ? apiFetch(`/api/devices/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) })
    : apiFetch('/api/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) }),
  remove: (ids) => apiFetch('/api/devices/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }),
  renameColumn: (pos, name) => apiFetch(`/api/columns/${pos}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }),
  setRole: (pos, role) => apiFetch(`/api/columns/${pos}/role`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) }),
  analyzeImport: (text) => apiFetch('/api/import?dryRun=1', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: text }),
  importCsv: (text, mode) => apiFetch(`/api/import?mode=${mode}`, { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: text }),
};

/* -------------------------------------------------------------- toasts */

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 3500);
}

/** Run an api call; on failure show a toast and rethrow. */
async function invoke(promise) {
  try { return await promise; }
  catch (e) { toast(e.message, 'error'); throw e; }
}

/* ---------------------------------------------------------------- copy */

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    // Fallback for non-secure contexts where the async clipboard is blocked.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (__) { toast('Could not copy', 'error'); ta.remove(); return; }
    ta.remove();
  }
  toast(label, 'success');
}

/* ---------------------------------------------------------------- grid */

function buildHeader() {
  const h = $('gridHeader');
  h.innerHTML = '';

  const chk = document.createElement('div');
  chk.className = 'cell chk';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.title = 'Select / clear all rows in current view';
  cb.addEventListener('change', () => toggleSelectAll(cb.checked));
  chk.appendChild(cb);
  h.appendChild(chk);

  for (const c of state.columns) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.textContent = c.name;
    if (c.role === 'dns') cell.innerHTML += ' <span class="badge-role">DNS</span>';
    if (c.role === 'ip') cell.innerHTML += ' <span class="badge-role">IP</span>';
    if (state.sortPos === c.pos) {
      cell.innerHTML += `<span class="arrow">${state.sortDir === 'ASC' ? '▲' : '▼'}</span>`;
    }
    // Three-state sort, like a spreadsheet:
    //   1st click → ascending   2nd → descending   3rd → back to default order
    const sortedByThis = state.sortPos === c.pos;
    cell.title = !sortedByThis
      ? `Sort by ${c.name} (A→Z)`
      : state.sortDir === 'ASC'
        ? `Sort by ${c.name} (Z→A)`
        : 'Click again to clear sorting and restore the default order';

    cell.addEventListener('click', () => {
      if (state.sortPos !== c.pos) {
        state.sortPos = c.pos; state.sortDir = 'ASC';       // 1st
      } else if (state.sortDir === 'ASC') {
        state.sortDir = 'DESC';                             // 2nd
      } else {
        state.sortPos = 0; state.sortDir = 'ASC';           // 3rd → default
      }
      $('gridScroll').scrollTop = 0;
      invalidate();
      updateStatus();
    });
    h.appendChild(cell);
  }
}

async function fetchPage(idx) {
  if (state.pages.has(idx) || state.pending.has(idx)) return;
  state.pending.add(idx);
  try {
    const { total, rows } = await invoke(api.query({
      search: state.search, allColumns: state.allCols,
      sortPos: state.sortPos, sortDir: state.sortDir,
      offset: idx * PAGE, limit: PAGE,
    }));
    state.total = total;
    state.loaded = true;
    state.pages.set(idx, rows);
    renderRows();
    updateStatus();
  } finally {
    state.pending.delete(idx);
  }
}

function renderRows() {
  const scroll = $('gridScroll');
  const inner = $('gridInner');
  inner.style.height = state.total * ROW_H + 'px';

  const first = Math.max(0, Math.floor(scroll.scrollTop / ROW_H) - 10);
  const last = Math.min(state.total - 1, Math.ceil((scroll.scrollTop + scroll.clientHeight) / ROW_H) + 10);

  // Request any pages covering the window. Page 0 is always requested: on a
  // cold render state.total is still 0, so the window below would be empty —
  // and total only becomes known once a page comes back.
  fetchPage(0);
  for (let p = Math.floor(first / PAGE); p <= Math.floor(last / PAGE); p++) fetchPage(p);

  const frag = document.createDocumentFragment();
  for (let i = first; i <= last; i++) {
    const page = state.pages.get(Math.floor(i / PAGE));
    const row = page ? page[i % PAGE] : null;
    const div = document.createElement('div');
    div.className = 'gridrow';
    div.style.top = i * ROW_H + 'px';
    if (row) {
      if (state.selected.has(row.id)) div.classList.add('selected');
      if (state.activeId === row.id) div.classList.add('active');

      const chk = document.createElement('div');
      chk.className = 'cell chk';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.selected.has(row.id);
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', (e) => {
        // Shift-tick extends from the last row you touched, like Excel.
        if (e.shiftKey && state.anchorIndex !== null && cb.checked) {
          selectRange(state.anchorIndex, i);
          return;
        }
        if (cb.checked) state.selected.set(row.id, true);
        else state.selected.delete(row.id);
        state.anchorIndex = i;
        renderRows(); updateStatus();
      });
      chk.appendChild(cb);
      div.appendChild(chk);

      for (const c of state.columns) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        const v = row[colId(c.pos)] || '';
        cell.textContent = v;
        cell.title = v ? `${v}\n\nDouble-click to copy` : '';
        // Copy a single value without opening the record.
        cell.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          if (!v) return;
          copyText(v, `Copied ${c.name}: ${v}`);
          cell.classList.add('copied');
          setTimeout(() => cell.classList.remove('copied'), 450);
        });
        div.appendChild(cell);
      }
      // Stop the browser from text-selecting across rows on a shift-click.
      div.addEventListener('mousedown', (e) => { if (e.shiftKey) e.preventDefault(); });

      // Plain click highlights the row (text stays selectable) and sets the
      // range anchor; shift-click selects everything between. The Info
      // button — or Enter — opens the full record.
      div.addEventListener('click', (e) => {
        if (e.shiftKey) {
          window.getSelection()?.removeAllRanges();
          const anchor = state.anchorIndex === null ? i : state.anchorIndex;
          setActive(row, i, false);
          state.anchorIndex = anchor;
          selectRange(anchor, i);
          return;
        }
        setActive(row, i, true);
      });
    } else {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.textContent = '…';
      div.appendChild(cell);
    }
    frag.appendChild(div);
  }
  inner.replaceChildren(frag);

  // Only claim "nothing here" once a query has actually come back.
  $('emptyState').hidden = state.total !== 0 || !state.loaded;
  $('emptyHint').textContent = state.search
    ? 'Nothing matches your search. Use “Reset view” to go back to the full list.'
    : 'Import a CSV or click “＋ Add Device” to get started.';
}

function invalidate() {
  state.pages.clear();
  state.pending.clear();
  state.loaded = false;
  // Row positions are only meaningful for one sort/filter; drop the anchor
  // so a later shift-click can't span a range that no longer exists.
  state.activeIndex = null;
  state.anchorIndex = null;
  buildHeader();
  renderRows(); // always kicks off page 0, which establishes state.total
}

/* --------------------------------------------------- active row + copy */

function setActive(row, index = null, moveAnchor = true) {
  state.activeId = row ? row.id : null;
  state.activeRow = row || null;
  state.activeIndex = index;
  if (moveAnchor) state.anchorIndex = index;
  renderRows();
  updateStatus();
}

function clearActive() {
  state.activeId = null;
  state.activeRow = null;
  state.activeIndex = null;
  state.anchorIndex = null;
}

/** Row at an absolute position, if its page happens to be cached. */
function rowAtIndex(i) {
  const page = state.pages.get(Math.floor(i / PAGE));
  return page ? page[i % PAGE] || null : null;
}

/**
 * Excel-style range select. The grid is virtualized, so rows between the
 * anchor and the target may never have been rendered — anything not in the
 * page cache is fetched from the server (1,000 at a time, the API cap).
 */
async function selectRange(a, b) {
  const start = Math.max(0, Math.min(a, b));
  const end = Math.min(state.total - 1, Math.max(a, b));

  const ids = [];
  let complete = true;
  for (let i = start; i <= end; i++) {
    const r = rowAtIndex(i);
    if (!r) { complete = false; break; }
    ids.push(r.id);
  }

  if (!complete) {
    ids.length = 0;
    for (let off = start; off <= end; off += 1000) {
      const { rows } = await invoke(api.query({
        search: state.search, allColumns: state.allCols,
        sortPos: state.sortPos, sortDir: state.sortDir,
        offset: off, limit: Math.min(1000, end - off + 1),
      }));
      rows.forEach((r) => ids.push(r.id));
    }
  }

  ids.forEach((id) => state.selected.set(id, true));
  renderRows();
  updateStatus();
}

/** Keep a row index visible in the scroller (accounts for the sticky header). */
function scrollIndexIntoView(i) {
  const s = $('gridScroll');
  const HEADER = 38;
  const top = i * ROW_H;
  const viewTop = s.scrollTop;
  const viewH = s.clientHeight - HEADER;
  if (top < viewTop) s.scrollTop = top;
  else if (top + ROW_H > viewTop + viewH) s.scrollTop = top + ROW_H - viewH;
}

/** Move the highlight to a row index, optionally extending the selection. */
async function focusIndex(next, extend) {
  if (!state.total) return;
  next = Math.max(0, Math.min(state.total - 1, next));
  scrollIndexIntoView(next);

  let row = rowAtIndex(next);
  if (!row) {
    await fetchPage(Math.floor(next / PAGE));
    row = rowAtIndex(next);
    if (!row) return;
  }

  if (extend) {
    if (state.anchorIndex === null) state.anchorIndex = next;
    const anchor = state.anchorIndex;
    setActive(row, next, false);
    await selectRange(anchor, next);
  } else {
    setActive(row, next, true);
  }
}

/** Copy the highlighted row as tab-separated values (pastes into Excel). */
function copyActiveRow() {
  const row = state.activeRow;
  if (!row) return;
  const values = state.columns.map((c) => row[colId(c.pos)] || '');
  copyText(values.join('\t'), `Copied row: ${values[0] || 'device'} (${values.length} fields)`);
}

// Cmd/Ctrl+C copies the highlighted row — unless the user has actually
// highlighted text, in which case let the browser do its normal thing.
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
    if (typing || String(window.getSelection() || '')) return;
    if (state.activeRow) { e.preventDefault(); copyActiveRow(); }
    return;
  }
  const modalOpen = $('detailOverlay').classList.contains('open') ||
                    $('importOverlay').classList.contains('open') ||
                    $('settingsOverlay').classList.contains('open');

  // Arrow keys move the highlight; hold Shift to extend the selection.
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !typing && !modalOpen) {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    const from = state.activeIndex === null ? (step > 0 ? -1 : 1) : state.activeIndex;
    focusIndex(from + step, e.shiftKey);
    return;
  }

  if (e.key === 'Enter' && !typing && state.activeId && !modalOpen) {
    openDetail(state.activeId);
  }
  if (e.key === 'Escape') {
    if ($('detailOverlay').classList.contains('open')) closeDetail();
    else if ($('importOverlay').classList.contains('open')) closeImport();
  }
});

function updateStatus() {
  const n = state.total;
  $('statCount').textContent = state.search
    ? `${n.toLocaleString()} match${n === 1 ? '' : 'es'}`
    : `${n.toLocaleString()} device${n === 1 ? '' : 's'}`;
  const sel = state.selected.size;
  $('statSelected').textContent = sel ? `${sel.toLocaleString()} selected` : '';
  $('deleteBtn').disabled = sel === 0;
  $('exportSelected').disabled = sel === 0;
  $('exportFiltered').disabled = !state.search;

  const active = state.activeRow;
  $('infoBtn').disabled = !active;
  $('infoBtn').title = active
    ? `Open the full record for ${active[colId(state.columns[0].pos)] || 'this device'} (or press Enter)`
    : 'Select a row first, then open its full record';
}

function toggleSelectAll(checked) {
  if (!checked) { state.selected.clear(); renderRows(); updateStatus(); return; }
  // Select everything matching the current filter (ids only, cheap).
  invoke(api.query({
    search: state.search, allColumns: state.allCols,
    offset: 0, limit: 1000,
  })).then(async ({ total, rows }) => {
    rows.forEach((r) => state.selected.set(r.id, true));
    // Page through the rest if the filter matches more than one API page.
    for (let off = 1000; off < total; off += 1000) {
      const more = await invoke(api.query({
        search: state.search, allColumns: state.allCols, offset: off, limit: 1000,
      }));
      more.rows.forEach((r) => state.selected.set(r.id, true));
    }
    renderRows(); updateStatus();
  });
}

/* -------------------------------------------------------------- search */

let searchTimer = null;
$('search').addEventListener('input', () => {
  $('clearSearch').style.display = $('search').value ? 'block' : 'none';
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = $('search').value;
    clearActive();
    $('gridScroll').scrollTop = 0;
    invalidate();
    updateStatus();
  }, 200);
});
$('clearSearch').addEventListener('click', () => {
  $('search').value = '';
  $('clearSearch').style.display = 'none';
  state.search = '';
  invalidate();
});
/** Reset view — back to the full, unsorted, unfiltered list. */
$('resetBtn').addEventListener('click', () => {
  $('search').value = '';
  $('clearSearch').style.display = 'none';
  state.search = '';
  state.sortPos = 0;
  state.sortDir = 'ASC';
  state.selected.clear();
  clearActive();
  $('gridScroll').scrollTop = 0;
  $('gridScroll').scrollLeft = 0;
  invalidate();
  updateStatus();
  toast('View reset — showing all devices', 'success');
});

/* ------------------------------------------------------------ info btn */

$('infoBtn').addEventListener('click', () => {
  if (state.activeId) openDetail(state.activeId);
});

$('gridScroll').addEventListener('scroll', () => renderRows());
window.addEventListener('resize', () => renderRows());

/* ------------------------------------------------------- detail / edit */

let detailId = null;
let editMode = false;

async function openDetail(id, startEditing = false) {
  detailId = id;
  editMode = startEditing;
  let row = null;
  if (id) {
    try { row = await api.get(id); }
    catch (_) { toast('Device no longer exists (deleted by another user?)', 'error'); return; }
  }
  if (!id) editMode = true;

  $('detailTitle').textContent = id
    ? (row[colId(state.columns[0].pos)] || 'Device')
    : 'New Device';
  $('detailDelete').hidden = !id;
  renderDetail(row);
  $('detailOverlay').classList.add('open');
}

function renderDetail(row) {
  const grid = $('detailGrid');
  grid.innerHTML = '';
  for (const c of state.columns) {
    const f = document.createElement('div');
    f.className = 'field';
    const label = document.createElement('label');
    label.textContent = c.name + (c.role ? ` (${c.role.toUpperCase()})` : '');
    f.appendChild(label);
    const v = row ? row[colId(c.pos)] || '' : '';
    if (editMode) {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = v;
      input.dataset.pos = c.pos;
      f.appendChild(input);
    } else {
      const val = document.createElement('div');
      val.className = 'val';
      val.textContent = v || '—';
      f.appendChild(val);
    }
    grid.appendChild(f);
  }
  $('detailMeta').textContent = row && row.updated_at
    ? `Last updated ${new Date(row.updated_at).toLocaleString()}${row.updated_by ? ' by ' + row.updated_by : ''}`
    : '';
  $('detailEdit').hidden = editMode;
  $('detailSave').hidden = !editMode;
  $('detailCancel').hidden = !editMode;
}

$('detailEdit').addEventListener('click', async () => {
  editMode = true;
  renderDetail(detailId ? await invoke(api.get(detailId)) : null);
});
$('detailCancel').addEventListener('click', async () => {
  if (!detailId) { closeDetail(); return; }
  editMode = false;
  renderDetail(await invoke(api.get(detailId)));
});
$('detailSave').addEventListener('click', async () => {
  const values = {};
  $('detailGrid').querySelectorAll('input[data-pos]').forEach((inp) => {
    values[colId(Number(inp.dataset.pos))] = inp.value.trim();
  });
  const saved = await invoke(api.save(detailId, values));
  toast(detailId ? 'Device updated' : 'Device added', 'success');
  detailId = saved.id;
  editMode = false;
  renderDetail(saved);
  $('detailTitle').textContent = saved[colId(state.columns[0].pos)] || 'Device';
  $('detailDelete').hidden = false;
  invalidate();
});
$('detailDelete').addEventListener('click', async () => {
  if (!detailId) return;
  if (!confirm('Delete this device? This cannot be undone.')) return;
  await invoke(api.remove([detailId]));
  state.selected.delete(detailId);
  if (state.activeId === detailId) clearActive();
  toast('Device deleted', 'success');
  closeDetail();
  invalidate();
  updateStatus();
});

function closeDetail() { $('detailOverlay').classList.remove('open'); detailId = null; }
$('detailClose').addEventListener('click', closeDetail);
$('detailOverlay').addEventListener('click', (e) => {
  if (e.target === $('detailOverlay')) closeDetail();
});

$('addBtn').addEventListener('click', () => openDetail(null, true));

/* ------------------------------------------------------ delete selected */

$('deleteBtn').addEventListener('click', async () => {
  const ids = [...state.selected.keys()];
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} selected device(s)? This cannot be undone.`)) return;
  await invoke(api.remove(ids));
  state.selected.clear();
  if (ids.includes(state.activeId)) clearActive();
  toast(`${ids.length} device(s) deleted`, 'success');
  invalidate();
  updateStatus();
});

/* ------------------------------------------------------------ refresh */

$('refreshBtn').addEventListener('click', () => {
  state.selected.clear();
  clearActive();
  invalidate();
  updateStatus();
  toast('Updated', 'success');
});

/* ------------------------------------------------------------- export */

$('exportBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('exportMenu').classList.toggle('open');
});
document.addEventListener('click', () => $('exportMenu').classList.remove('open'));

function download(url) {
  const a = document.createElement('a');
  a.href = url;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

$('exportMenu').addEventListener('click', (e) => {
  const mode = e.target.dataset?.mode;
  if (!mode) return;
  $('exportMenu').classList.remove('open');

  if (mode === 'template') {
    download('/api/template');
    toast('Template downloading — fill it in and use Import CSV', 'success');
    return;
  }
  const params = new URLSearchParams({ mode });
  if (mode === 'filtered') {
    params.set('q', state.search);
    params.set('all', state.allCols ? '1' : '0');
  }
  if (mode === 'selected') params.set('ids', [...state.selected.keys()].join(','));
  download('/api/export?' + params.toString());
  toast('Export downloading as CSV', 'success');
});

/* ------------------------------------------------------------- import */

let pendingImportText = null;

$('importBtn').addEventListener('click', () => $('importFile').click());

$('importFile').addEventListener('change', async () => {
  const file = $('importFile').files[0];
  $('importFile').value = ''; // allow re-selecting the same file
  if (!file) return;
  const text = await file.text();

  // Dry run first: validate the format and find out what would happen.
  let a;
  try {
    a = await api.analyzeImport(text);
  } catch (e) {
    toast('Import rejected — file is not in the correct format:\n• ' +
      e.message.split('\n').join('\n• '), 'error');
    return;
  }

  // Nothing conflicts → just import, no need to ask.
  if (!a.dupCount && !a.dupInFile) {
    await runImport(text, 'skip');
    return;
  }

  pendingImportText = text;
  $('importStats').innerHTML = `
    <div class="card new"><div class="n">${a.newCount.toLocaleString()}</div><div class="l">new device${a.newCount === 1 ? '' : 's'} to add</div></div>
    <div class="card dup"><div class="n">${a.dupCount.toLocaleString()}</div><div class="l">already in the database</div></div>
    <div class="card"><div class="n">${a.total.toLocaleString()}</div><div class="l">rows in file</div></div>`;
  $('importMatchNote').innerHTML =
    `Devices are matched on <b>${a.matchColumn}</b> (case-insensitive).` +
    (a.dupInFile ? ` <b>${a.dupInFile}</b> row(s) are also duplicated within the file itself.` : '') +
    (a.blankKey ? ` ${a.blankKey} row(s) have a blank ${a.matchColumn} and will always be added as new.` : '');
  $('importExamples').hidden = !a.examples.length;
  $('importExamples').textContent = a.examples.length
    ? 'Already present: ' + a.examples.join(', ') + (a.dupCount > a.examples.length ? ', …' : '')
    : '';
  $('importOverlay').classList.add('open');
});

async function runImport(text, mode) {
  try {
    const res = await api.importCsv(text, mode);
    const bits = [];
    if (res.inserted) bits.push(`${res.inserted.toLocaleString()} added`);
    if (res.updated) bits.push(`${res.updated.toLocaleString()} updated`);
    if (res.skipped) bits.push(`${res.skipped.toLocaleString()} skipped`);
    toast(bits.length ? 'Import complete — ' + bits.join(', ') : 'Nothing to import', 'success');
    invalidate();
  } catch (e) {
    toast('Import rejected:\n• ' + e.message.split('\n').join('\n• '), 'error');
  }
}

function closeImport() {
  $('importOverlay').classList.remove('open');
  pendingImportText = null;
}
$('importClose').addEventListener('click', closeImport);
$('importCancel').addEventListener('click', closeImport);
$('importOverlay').addEventListener('click', (e) => {
  if (e.target === $('importOverlay')) closeImport();
});
$('importConfirm').addEventListener('click', async () => {
  const mode = document.querySelector('input[name="importMode"]:checked')?.value || 'skip';
  const text = pendingImportText;
  closeImport();
  if (text) await runImport(text, mode);
});

/* ----------------------------------------------------------- settings */

function openSettings() {
  const m = state.meta || {};
  $('infoDbPath').textContent = m.dbPath || '—';
  $('infoApiUrl').textContent = location.origin + '/api';
  $('infoVersion').textContent = m.version || '—';

  const tbody = $('colTableBody');
  tbody.innerHTML = '';
  for (const c of state.columns) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${c.pos}</td>
      <td><input type="text" data-pos="${c.pos}" /></td>
      <td><input type="radio" name="dnsRole" value="${c.pos}" ${c.role === 'dns' ? 'checked' : ''}/></td>
      <td><input type="radio" name="ipRole" value="${c.pos}" ${c.role === 'ip' ? 'checked' : ''}/></td>`;
    tr.querySelector('input[type="text"]').value = c.name;
    tbody.appendChild(tr);
  }
  $('settingsOverlay').classList.add('open');
}

$('settingsBtn').addEventListener('click', openSettings);
$('settingsClose').addEventListener('click', () => $('settingsOverlay').classList.remove('open'));
$('settingsCancel').addEventListener('click', () => $('settingsOverlay').classList.remove('open'));

$('settingsSave').addEventListener('click', async () => {
  try {
    // Column renames
    for (const inp of $('colTableBody').querySelectorAll('input[type="text"]')) {
      const pos = Number(inp.dataset.pos);
      const cur = state.columns.find((c) => c.pos === pos);
      if (cur && inp.value.trim() && inp.value.trim() !== cur.name) {
        state.columns = await invoke(api.renameColumn(pos, inp.value.trim()));
      }
    }
    // Roles
    const dnsPos = Number(document.querySelector('input[name="dnsRole"]:checked')?.value);
    const ipPos = Number(document.querySelector('input[name="ipRole"]:checked')?.value);
    if (dnsPos && ipPos && dnsPos === ipPos) {
      toast('DNS and IP roles must be different columns.', 'error');
      return;
    }
    const curDns = state.columns.find((c) => c.role === 'dns')?.pos;
    const curIp = state.columns.find((c) => c.role === 'ip')?.pos;
    if (dnsPos && dnsPos !== curDns) state.columns = await invoke(api.setRole(dnsPos, 'dns'));
    if (ipPos && ipPos !== curIp) state.columns = await invoke(api.setRole(ipPos, 'ip'));

    $('settingsOverlay').classList.remove('open');
    state.columns = await invoke(api.columns());
    invalidate();
    toast('Settings saved', 'success');
  } catch (_) { /* toasts already shown */ }
});

/* ---------------------------------------------------------------- init */

function applyMetaToStatus() {
  const m = state.meta || {};
  $('statPath').textContent = 'DB: ' + (m.dbPath || '');
  $('statPath').title = m.dbPath || '';
  $('statApiText').textContent = `API ${location.origin}/api`;
}

(async function init() {
  try {
    state.meta = await api.meta();
    state.columns = await api.columns();
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  applyMetaToStatus();
  buildHeader();
  invalidate();
})();
