# DeviceDB

Look up any device (server, VM, appliance, application) by **DNS name or IP address** and get its full 39-column record instantly. Handles 8,000+ rows (312,000+ data points) without breaking a sweat — the grid is virtualized and lookups hit SQLite indexes.

**v2 architecture: local web app, zero dependencies.** The app is a single Node server (`server.js`) that serves the UI and a full JSON API from the same port. No `npm install`, no native modules, no build step — if you have Node, you have the app. The same server is what ServiceNow will call later, and a thin Electron shell (`main.js`, dormant) turns it into a Windows desktop app when that day comes.

## Run it (Mac, today)

Requires **Node.js 22.5+** ([nodejs.org](https://nodejs.org) — current LTS is fine). Check with `node -v`.

```
cd GA-NEW-Asset-Inv
npm run seed     # optional: fill the DB with 8,000 realistic fake devices
npm start        # → http://localhost:8422
```

Open http://localhost:8422 in your browser. That's the whole install.

Sample-data management:

```
npm run seed                          # add 8,000 fake devices
node scripts/seed.js --count=500      # add a custom number
npm run seed:wipe                     # delete ALL devices
node scripts/seed.js --wipe --count=8000   # start fresh
```

## Features

- **Instant lookup** by DNS name or IP (indexed, case-insensitive). The search box matches Name + DNS + IP. Exact-match API endpoint: `/api/lookup?term=…`. (The API also supports searching all 39 columns via `&all=1`; the UI sets `state.allCols` in `renderer/app.js` if you ever want that back.)
- **39 configurable columns** — rename any of them in Settings ⚙; renames are stored in the database so every user sees the same names. Mark which column is DNS and which is IP (those drive the indexed lookup).
- **Copy without opening anything** — cell text is selectable in place. **Double-click a cell** to copy that single value; **Cmd/Ctrl+C** copies the whole highlighted row as tab-separated values (pastes straight into Excel). Highlighting text and pressing Cmd+C still copies just the highlighted text.
- **Row detail & editing** — click a row to highlight it, then hit **Info** in the top bar (or press Enter) for the full record; Edit / Save / Delete. Escape closes. Tracks who last updated each record and when.
- **Three-state column sort** — click a header to sort ascending, again for descending, a third time to clear the sort and restore the original row order. The tooltip always says what the next click will do.
- **Excel-style selection** — click a row, then **shift-click** another (in either direction) to select everything in between, however far apart they are. **Shift+↑/↓** extends the selection a row at a time; plain **↑/↓** just moves the highlight. Shift also works on the checkboxes. Selections feed Delete and "Export selected rows".
- **Reset view** — one button clears the search, sorting, highlight and selection, returning to the full list.
- **CSV export** — entire dataset, current search results, or selected rows; downloads straight from the browser. Excel-friendly (BOM + CRLF).
- **CSV import** — strict validation: the header must match the 39 configured column names exactly (download the blank template from Export ▾). Malformed files are rejected with a clear list of what's wrong; nothing partial is imported.
- **Duplicate handling on import** — devices are matched on the **DNS Name** column (whichever column carries the `dns` role; falls back to column 1). Before writing anything the app does a dry run and, if the file contains devices that already exist, asks what to do:

  | Mode | Behaviour |
  |---|---|
  | **Update** | Overwrite the existing record with the file's values; still adds genuinely new devices. |
  | **Skip** | Leave existing records untouched; add only devices not already in the database. |
  | **Reject** | Import nothing and list the conflicts so the file can be fixed first. |

  A file with no conflicts imports immediately without asking. **Import never deletes:** devices in the database that aren't in the file are always left alone. Rows with a blank DNS Name are always added as new.
- **JSON API** — always on (it's what the UI itself uses):

  | Endpoint | Purpose |
  |---|---|
  | `GET /api/health` | liveness check |
  | `GET /api/lookup?term=<dns-or-ip>` | exact lookup, friendly column names |
  | `GET /api/devices?q=&limit=&offset=` | paged search |
  | `GET /api/devices/:id` | single record |
  | `GET /api/stats?groupBy=<col#>` | totals + group counts (dashboards) |
  | `GET /api/columns` | configured column names/roles |
  | `POST /api/devices` · `PUT /api/devices/:id` · `POST /api/devices/delete` | writes |
  | `POST /api/import?dryRun=1` | preview: how many rows are new vs. already present |
| `POST /api/import?mode=update\|skip\|reject` | apply the import |
| `GET /api/export` · `GET /api/template` | CSV out |

## Configuration

Optional `config.json` next to `server.js` (or env vars `PORT`, `HOST`, `DB_PATH`):

```json
{ "port": 8422, "host": "127.0.0.1", "dbPath": "" }
```

- `dbPath` defaults to `data/devicedb.sqlite` inside the project folder.
- `host: "0.0.0.0"` exposes the app/API to other machines on your network (e.g. to preview from another device, or for ServiceNow to reach it).

## Project layout

```
server.js          the app: HTTP server = UI hosting + JSON API (entry point)
src/db.js          SQLite data layer (built-in node:sqlite; 39 generic cols c01..c39)
src/csv.js         RFC-4180 CSV parse/serialize + strict import validation
renderer/          frontend (vanilla JS/HTML/CSS, virtualized grid, no framework)
renderer/assets/   images (GA logo)
scripts/seed.js    fake-data generator
main.js            dormant Electron shell for the future Windows desktop build
data/              default SQLite database location (created on first run)
```

## Path to Windows / GA deployment (later)

The core is platform-neutral, so the migration is packaging, not rewriting:

1. `npm install --save-dev electron electron-builder` (Electron 37+ — its Node includes `node:sqlite`).
2. `npx electron .` — the shell in `main.js` starts the same server on a private port and opens it in a window.
3. `electron-builder --win` on a Windows machine → NSIS installer + portable .exe (config already in `package.json`).
4. Multi-user options, decided then: shared `.sqlite` on an SMB share (journal_mode is already DELETE, network-share safe), or run `server.js` on one box and point everyone's browser at it — which needs no per-seat install at all.
5. ServiceNow: consume the same JSON API via outbound REST Message / IntegrationHub. Add the bearer-token auth back before exposing beyond localhost.

## Notes

- SQLite `journal_mode=DELETE` + 5s busy timeout are set deliberately so a future shared-file deployment over SMB stays safe (WAL breaks on network shares).
- `node:sqlite` prints an "experimental" warning on Node 22; it's stable API-wise and the warning disappears on Node 24+.
