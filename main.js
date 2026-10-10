'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const { db, closeDb } = require('./src/db.js');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

function loadIpcModules() {
  const ipcDir = path.join(__dirname, 'src', 'ipc');
  let files = [];
  try {
    files = fs.readdirSync(ipcDir).filter((f) => f.endsWith('.js'));
  } catch (err) {
    // Missing dir is tolerated: the app still boots with core functionality absent.
    console.warn('[website-scout] ipc dir not found, skipping IPC registration:', err.message);
    return;
  }
  for (const file of files) {
    try {
      const mod = require(path.join(ipcDir, file));
      if (mod && typeof mod.register === 'function') {
        mod.register(ipcMain, db);
      } else {
        console.warn(`[website-scout] ipc module ${file} has no register() export, skipped.`);
      }
    } catch (err) {
      console.error(`[website-scout] failed to load ipc module ${file}:`, err.message);
    }
  }
}

app.whenReady().then(() => {
  loadIpcModules();
  try {
    const discoverySchedule = require('./src/discoverySchedule');
    discoverySchedule.start(db);
  } catch (err) {
    console.warn('[website-scout] discovery schedule failed to start:', err.message);
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Close the DB cleanly before quit (avoids native teardown issues).
app.on('before-quit', () => {
  try {
    const discoverySchedule = require('./src/discoverySchedule');
    discoverySchedule.stop();
  } catch { /* ignore */ }
  try { closeDb(); } catch (err) {
    console.warn('[website-scout] db close failed:', err.message);
  }
});
