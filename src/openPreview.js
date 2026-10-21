'use strict';

// Open an exported site HTML file in the default browser.
// Callers pass a website id or a design job id. This module builds the path
// itself and refuses anything outside the export folder.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function exportRoot() {
  const fromEnv = String(process.env.EXPORT_ROOT || process.env.WEBSITE_SCOUT_EXPORTS || '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(os.homedir(), 'website-scout-exports');
}

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function assertInsideRoot(filePath, root) {
  if (typeof filePath !== 'string' || /[\0\r\n]/.test(filePath)) {
    throw fail('PATH_NOT_ALLOWED', 'Preview path is not a safe file path.');
  }
  const rootResolved = path.resolve(root || exportRoot());
  const fileResolved = path.resolve(filePath);
  const rel = path.relative(rootResolved, fileResolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw fail('PATH_NOT_ALLOWED', 'Preview path is outside the export folder.');
  }
  if (path.extname(fileResolved).toLowerCase() !== '.html') {
    throw fail('PATH_NOT_ALLOWED', 'Preview must be an HTML file.');
  }
  return fileResolved;
}

function assertRealpathInside(filePath, root) {
  const fileResolved = assertInsideRoot(filePath, root);
  const rootResolved = path.resolve(root || exportRoot());
  const realFile = fs.realpathSync(fileResolved);
  const realRoot = fs.realpathSync(rootResolved);
  const rel = path.relative(realRoot, realFile);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw fail('PATH_NOT_ALLOWED', 'Preview path is outside the export folder.');
  }
  return realFile;
}

function launchSpec(filePath) {
  const file = assertInsideRoot(filePath);
  if (process.platform === 'win32') {
    return { cmd: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', file] };
  }
  if (process.platform === 'darwin') return { cmd: 'open', args: [file] };
  return { cmd: 'xdg-open', args: [file] };
}

function electronShell() {
  try {
    const electron = require('electron');
    if (electron && typeof electron === 'object' && electron.shell && typeof electron.shell.openPath === 'function') {
      return electron.shell;
    }
  } catch { /* plain Node, including the MCP process */ }
  return null;
}

function launchWithDefaultApp(filePath) {
  const spec = launchSpec(filePath);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.cmd, spec.args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => reject(fail('OPEN_FAILED', 'Could not open the preview in a browser.')));
    child.unref();
    setTimeout(resolve, 40);
  });
}

async function launchFile(filePath) {
  const safe = assertRealpathInside(filePath, exportRoot());
  const shell = electronShell();
  if (shell) {
    const result = await shell.openPath(safe);
    if (result) throw fail('OPEN_FAILED', 'Could not open the preview in a browser.');
    return { path: safe, via: 'electron' };
  }
  await launchWithDefaultApp(safe);
  return { path: safe, via: 'spawn' };
}

function slugify(s) {
  return String(s || 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'site';
}

async function openWebsiteFile(db, websiteId) {
  const engine = require('./websiteEngine');
  const site = engine.getWebsite(db, websiteId);
  const root = exportRoot();
  const dir = path.join(root, `${slugify(site.name)}-${site.id}`);
  fs.mkdirSync(dir, { recursive: true });
  engine.exportStatic(db, websiteId, dir);
  const file = path.join(dir, 'index.html');
  const opened = await launchFile(file);
  return { path: opened.path, websiteId: site.id };
}

function exportPages(pages, theme, folderName, opts = {}) {
  const engine = require('./websiteEngine');
  const root = exportRoot();
  const safeFolder = String(folderName || 'preview').replace(/[^a-z0-9-_]/gi, '').slice(0, 40) || 'preview';
  const dir = path.join(root, safeFolder);
  const writeOpts = Object.assign({}, opts || {});
  const written = engine.writeStaticPages(pages, theme || {}, dir, writeOpts);
  const file = path.join(dir, 'index.html');
  return {
    folder: safeFolder,
    dir,
    path: file,
    files: written.files || [],
  };
}

/**
 * Export pages and return a localhost http URL (starts preview server if needed).
 */
async function previewUrlForPages(pages, theme, folderName, opts = {}) {
  const exported = exportPages(pages, theme, folderName, opts);
  const previewServer = require('./previewServer');
  const served = await previewServer.urlForExportFolder(exported.folder);
  return {
    ...exported,
    url: served.url,
    indexUrl: served.indexUrl,
    port: served.port,
  };
}

async function openPagesFile(pages, theme, folderName, opts = {}) {
  const preview = await previewUrlForPages(pages, theme, folderName, opts);
  // Prefer http URL so multipage relative links resolve.
  try {
    const shell = electronShell();
    if (shell && typeof shell.openExternal === 'function') {
      await shell.openExternal(preview.url);
      return { path: preview.path, url: preview.url, via: 'electron-url', folder: preview.folder };
    }
  } catch { /* fall through */ }
  try {
    await launchWithDefaultApp(preview.path);
    return { path: preview.path, url: preview.url, via: 'spawn', folder: preview.folder };
  } catch {
    // Still return the URL even if the OS open failed.
    return { path: preview.path, url: preview.url, via: 'url-only', folder: preview.folder };
  }
}

module.exports = {
  exportRoot,
  assertInsideRoot,
  assertRealpathInside,
  launchSpec,
  launchFile,
  openWebsiteFile,
  openPagesFile,
  exportPages,
  previewUrlForPages,
};
