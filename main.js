/**
 * DeviceDB — OPTIONAL Electron shell (dormant for now).
 *
 * The real app is server.js + renderer/. This file exists only so the
 * future Windows desktop build stays a packaging step, not a rewrite:
 * it starts the same local server and opens a window pointed at it.
 *
 * To use (later, when packaging for Windows):
 *   npm install --save-dev electron electron-builder
 *   npx electron .
 *
 * Note: requires an Electron version whose bundled Node is >= 22.5
 * (Electron 37+), since the data layer uses the built-in node:sqlite.
 */
'use strict';

let electron;
try {
  electron = require('electron');
} catch (_) {
  console.error('Electron is not installed. For the browser app, run:  node server.js');
  console.error('To use the desktop shell:  npm install --save-dev electron  then  npx electron .');
  process.exit(1);
}

const { app, BrowserWindow } = electron;
const { start } = require('./server');

app.whenReady().then(async () => {
  // Port 0 = pick any free port; the shell owns its own private server.
  const { url } = await start({ port: 0, host: '127.0.0.1' });

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: 'DeviceDB',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(url);
});

app.on('window-all-closed', () => app.quit());
