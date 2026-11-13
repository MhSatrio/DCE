'use strict';
/**
 * Dynamic Canvas Engine — desktop shell (Electron).
 *
 * The app itself is the same offline-first web app. This file only:
 *  1. serves the built app from 127.0.0.1:<APP_PORT> (a fixed origin keeps your IndexedDB data in one place);
 *  2. starts the local relay on 127.0.0.1:8788 (Buffer calls + polite reading of the source websites) with no extra command;
 *  3. opens a window, keeps navigation inside the app and sends external links to the normal browser.
 * No remote code is ever loaded, and nothing is sent anywhere except the requests you configure (Buffer, Gemini, and the source websites you add).
 */
const { app, BrowserWindow, Menu, dialog, shell, session } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createRelay } = require('../server/relay-core.cjs');

const APP_PORT = 47625;
const RELAY_PORT = 8788;
const ROOT = path.join(__dirname, '..', 'dist');
const ORIGIN = `http://127.0.0.1:${APP_PORT}`;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

// A readable, stable data folder: %APPDATA%\Dynamic Canvas Engine (tests pass --user-data-dir to stay out of the real one)
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', path.join(app.getPath('appData'), 'Dynamic Canvas Engine'));
app.setName('Dynamic Canvas Engine');

let mainWindow = null;
let appServer = null;
let relayServer = null;

function startStaticServer() {
  return new Promise((resolve, reject) => {
    appServer = http.createServer((req, res) => {
      try {
        const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
        let file = path.normalize(path.join(ROOT, urlPath));
        if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, 'index.html'); // single-page app
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, {
          'content-type': MIME[ext] || 'application/octet-stream',
          'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
          'x-content-type-options': 'nosniff',
        });
        fs.createReadStream(file).pipe(res);
      } catch { res.writeHead(500); res.end('Error'); }
    });
    appServer.once('error', reject);
    appServer.listen(APP_PORT, '127.0.0.1', () => resolve());
  });
}

function startRelay() {
  // If the port is already taken (e.g. `npm run relay` is running) just use that one.
  relayServer = createRelay({ origins: [ORIGIN] });
  relayServer.once('error', () => { relayServer = null; });
  relayServer.listen(RELAY_PORT, '127.0.0.1');
}

function buildMenu() {
  const t = [
    { label: 'File', submenu: [{ role: 'quit', label: 'Exit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
    {
      label: 'Help',
      submenu: [
        { label: 'About Dynamic Canvas Engine', click: () => mainWindow && mainWindow.loadURL(`${ORIGIN}/#/settings`) },
        { label: 'License (MIT) and Terms', click: () => mainWindow && mainWindow.loadURL(`${ORIGIN}/#/settings`) },
        { label: 'Open the data folder', click: () => shell.openPath(app.getPath('userData')) },
      ],
    },
  ];
  if (process.env.DCE_DEBUG) t.push({ label: 'Debug', submenu: [{ role: 'toggleDevTools' }] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(t));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480, height: 920, minWidth: 1000, minHeight: 640, show: false, backgroundColor: '#F6F8FA',
    title: 'Dynamic Canvas Engine', icon: path.join(__dirname, '..', 'build', 'icon.png'), autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });
  mainWindow.on('page-title-updated', (e) => e.preventDefault());
  mainWindow.loadURL(`${ORIGIN}/`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    // only what the app needs: clipboard (spreadsheet copy / paste) and desktop notifications (pipeline alerts) — no camera, microphone, location…
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(['clipboard-read', 'clipboard-sanitized-write', 'fileSystem', 'notifications'].includes(permission)));
    try {
      await startStaticServer();
    } catch (e) {
      dialog.showErrorBox('Dynamic Canvas Engine cannot start', `Port ${APP_PORT} on this computer is already in use by another program, so the app cannot open its private local address.\n\nClose the other program (or another copy of this app) and start again.\n\n${e.message}`);
      return app.quit();
    }
    startRelay();
    buildMenu();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { try { appServer && appServer.close(); relayServer && relayServer.close(); } catch { /* shutting down */ } });
}
