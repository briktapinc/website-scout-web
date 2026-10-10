'use strict';

/**
 * Localhost static server for website-scout-exports.
 * Gives MCP agents (and Open in browser) an http:// URL so multipage
 * relative links work — file:// often does not.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exportRoot } = require('./openPreview');

const DEFAULT_PORT = Number(process.env.WS_PREVIEW_PORT) || 8755;
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

let server = null;
let listenPort = null;
let starting = null;

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function baseUrl() {
  if (!listenPort) return null;
  return `http://${HOST}:${listenPort}`;
}

function status() {
  return {
    running: !!(server && listenPort),
    host: HOST,
    port: listenPort,
    baseUrl: baseUrl(),
    root: exportRoot(),
  };
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

function safeResolve(urlPath) {
  const root = exportRoot();
  let rel = decodeURIComponent(String(urlPath || '/').split('?')[0]);
  if (rel.includes('\0')) throw fail('PATH_NOT_ALLOWED', 'Invalid path.');
  rel = rel.replace(/^\/+/, '');
  if (!rel) {
    return { kind: 'index', root };
  }
  const candidate = path.resolve(root, rel);
  const rootResolved = path.resolve(root);
  const check = path.relative(rootResolved, candidate);
  if (!check || check.startsWith('..') || path.isAbsolute(check)) {
    throw fail('PATH_NOT_ALLOWED', 'Path outside export folder.');
  }
  return { kind: 'file', root: rootResolved, abs: candidate, rel: check };
}

function send(res, statusCode, headers, body) {
  res.writeHead(statusCode, Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  }, headers || {}));
  res.end(body);
}

function handle(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      send(res, 204, {
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Method not allowed');
      return;
    }

    const u = new URL(req.url || '/', `http://${HOST}`);
    if (u.pathname === '/health') {
      send(res, 200, { 'Content-Type': 'application/json; charset=utf-8' },
        JSON.stringify({ ok: true, ...status() }));
      return;
    }

    const resolved = safeResolve(u.pathname);
    if (resolved.kind === 'index') {
      const listing = fs.readdirSync(resolved.root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .map((name) => `<li><a href="/${encodeURIComponent(name)}/">${name}</a></li>`)
        .join('\n');
      const html = `<!doctype html><meta charset="utf-8"><title>Website Scout previews</title>
<h1>Exported previews</h1><ul>${listing || '<li>(empty)</li>'}</ul>`;
      send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, req.method === 'HEAD' ? '' : html);
      return;
    }

    let target = resolved.abs;
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      if (!u.pathname.endsWith('/')) {
        send(res, 302, { Location: `${u.pathname}/` }, '');
        return;
      }
      target = path.join(target, 'index.html');
    }

    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
      return;
    }

    const rootResolved = path.resolve(exportRoot());
    const realFile = fs.realpathSync(target);
    const realRoot = fs.realpathSync(rootResolved);
    const rel = path.relative(realRoot, realFile);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw fail('PATH_NOT_ALLOWED', 'Path outside export folder.');
    }

    const buf = fs.readFileSync(target);
    send(res, 200, {
      'Content-Type': contentType(target),
      'Content-Length': buf.length,
    }, req.method === 'HEAD' ? '' : buf);
  } catch (e) {
    const code = e && e.code === 'PATH_NOT_ALLOWED' ? 403 : 500;
    send(res, code, { 'Content-Type': 'text/plain; charset=utf-8' }, e.message || 'Error');
  }
}

function ensureListening() {
  if (server && listenPort) {
    return Promise.resolve({ host: HOST, port: listenPort, baseUrl: baseUrl() });
  }
  if (starting) return starting;

  starting = new Promise((resolve, reject) => {
    const root = exportRoot();
    fs.mkdirSync(root, { recursive: true });

    const tryListen = (port, attemptsLeft) => {
      const s = http.createServer(handle);
      s.once('error', (err) => {
        s.close();
        if (err && err.code === 'EADDRINUSE' && attemptsLeft > 0) {
          tryListen(port + 1, attemptsLeft - 1);
          return;
        }
        starting = null;
        reject(fail('PREVIEW_BIND_FAILED', `Could not start preview server (${err.message}).`));
      });
      s.listen(port, HOST, () => {
        server = s;
        listenPort = port;
        starting = null;
        if (typeof s.unref === 'function') s.unref();
        resolve({ host: HOST, port: listenPort, baseUrl: baseUrl() });
      });
    };

    tryListen(DEFAULT_PORT, 20);
  });

  return starting;
}

/**
 * Build an absolute URL for a folder under the export root (e.g. "design-5").
 */
async function urlForExportFolder(folderName) {
  const folder = String(folderName || '').replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 80);
  if (!folder) throw fail('INVALID_ARGS', 'folderName is required.');
  const dir = path.join(exportRoot(), folder);
  if (!fs.existsSync(dir)) {
    throw fail('NOT_FOUND', `Export folder "${folder}" does not exist yet.`);
  }
  const { baseUrl: base } = await ensureListening();
  return {
    url: `${base}/${folder}/`,
    indexUrl: `${base}/${folder}/index.html`,
    folder,
    dir,
    ...status(),
  };
}

function stop() {
  return new Promise((resolve) => {
    if (!server) {
      listenPort = null;
      resolve();
      return;
    }
    server.close(() => {
      server = null;
      listenPort = null;
      resolve();
    });
  });
}

module.exports = {
  DEFAULT_PORT,
  HOST,
  ensureListening,
  urlForExportFolder,
  status,
  stop,
  baseUrl,
};
