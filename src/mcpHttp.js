'use strict';

// Streamable HTTP + legacy SSE transport for Website Scout MCP.
// Intended for Tailscale (or other private network) access:
//   WS_DB_PATH=... WS_MCP_TOKEN=... node src/mcpHttp.js
//   npm run mcp:http
//
// Endpoints:
//   GET  /health          — liveness (no auth)
//   POST /ws              — Streamable HTTP JSON-RPC (Bearer token)
//   GET  /ws              — optional SSE stream (Bearer token)
//   GET  /sse             — legacy SSE handshake (Bearer token)
//   POST /message         — legacy message POST (Bearer token)
//   /mcp is kept as an alias of /ws for older client configs.

const http = require('http');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { handleRequest, DB_PATH, SERVER_INFO } = require('./mcp');
const designJobs = require('./designJobs');

const DESIGN_PENDING_URI = 'website-scout://design/pending';

const DEFAULT_PORT = 8742;
const HOST = String(process.env.WS_MCP_HOST || '0.0.0.0').trim() || '0.0.0.0';
const PORT = Math.min(65535, Math.max(1, Number(process.env.WS_MCP_PORT) || DEFAULT_PORT));
const TOKEN = String(process.env.WS_MCP_TOKEN || '').trim();

const sessions = new Map(); // sessionId -> { res, created }

let pollDb = null;
let designPollTimer = null;
let designPollSig = '';
const designSseClients = new Set();

function getPollDb() {
  if (!pollDb) {
    pollDb = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    pollDb.pragma('journal_mode = WAL');
  }
  return pollDb;
}

function broadcastDesignQueueChange(summary) {
  const queueNote = {
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: {
      level: 'info',
      data: summary.total
        ? `Design queue: ${summary.counts.waiting_on_agent} waiting_on_agent, ${summary.counts.questions_pending} questions_pending. Call design.next or design.pending.`
        : 'Design queue is empty.',
    },
  };
  const resourceNote = {
    jsonrpc: '2.0',
    method: 'notifications/resources/updated',
    params: { uri: DESIGN_PENDING_URI },
  };
  for (const res of designSseClients) {
    try {
      writeSse(res, 'message', queueNote);
      writeSse(res, 'message', resourceNote);
    } catch {
      designSseClients.delete(res);
    }
  }
}

function pollDesignQueue(notify) {
  try {
    const summary = designJobs.pendingAgentSummary(getPollDb(), { previewLimit: 15 });
    const sig = designJobs.pendingSignature(summary);
    if (sig !== designPollSig) {
      const hadBaseline = designPollSig !== '';
      designPollSig = sig;
      if (notify && hadBaseline) broadcastDesignQueueChange(summary);
    }
  } catch (e) {
    process.stderr.write(`[mcp-http] design queue poll: ${e.message}\n`);
  }
}

function attachDesignQueueWatcher(res) {
  designSseClients.add(res);
  if (!designPollTimer) {
    pollDesignQueue(false);
    designPollTimer = setInterval(() => pollDesignQueue(true), 5000);
    if (typeof designPollTimer.unref === 'function') designPollTimer.unref();
  }
}

function detachDesignQueueWatcher(res) {
  designSseClients.delete(res);
  if (!designSseClients.size && designPollTimer) {
    clearInterval(designPollTimer);
    designPollTimer = null;
    designPollSig = '';
  }
}

function json(res, status, body, extraHeaders) {
  const data = JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  }, extraHeaders || {}));
  res.end(data);
}

function unauthorized(res) {
  json(res, 401, { error: 'Unauthorized. Send Authorization: Bearer <token>.' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2_000_000) {
        reject(Object.assign(new Error('Body too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function extractBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams.get('token');
  return q ? String(q).trim() : '';
}

function requireAuth(req, res) {
  if (!TOKEN) {
    json(res, 503, { error: 'WS_MCP_TOKEN is not set. Refusing to serve MCP over HTTP.' });
    return false;
  }
  const got = extractBearer(req);
  if (!got || got !== TOKEN) {
    unauthorized(res);
    return false;
  }
  return true;
}

async function handleJsonRpc(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText || 'null');
  } catch {
    return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
  }
  if (Array.isArray(parsed)) {
    const outs = [];
    for (const item of parsed) {
      const resp = await handleRequest(item);
      if (resp) outs.push(resp);
    }
    return outs;
  }
  return handleRequest(parsed);
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathName = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && pathName === '/health') {
    json(res, 200, {
      ok: true,
      server: SERVER_INFO,
      transport: 'streamable-http',
      db: DB_PATH,
      auth: TOKEN ? 'bearer' : 'missing',
      endpoints: ['/ws', '/mcp', '/sse', '/message', '/health'],
    });
    return;
  }

  if (pathName === '/ws' || pathName === '/mcp') {
    if (!requireAuth(req, res)) return;
    if (req.method === 'GET') {
      openSse(res);
      writeSse(res, 'message', { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'website-scout-mcp sse ready — poll design.pending / design.next; this stream notifies when the design queue changes.' } });
      attachDesignQueueWatcher(res);
      const keep = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25000);
      req.on('close', () => {
        clearInterval(keep);
        detachDesignQueueWatcher(res);
      });
      return;
    }
    if (req.method === 'POST') {
      try {
        const raw = await readBody(req);
        const out = await handleJsonRpc(raw);
        if (out == null) {
          res.writeHead(202, { 'Access-Control-Allow-Origin': '*' });
          res.end();
          return;
        }
        json(res, 200, out, { 'Mcp-Session-Id': crypto.randomUUID() });
      } catch (e) {
        json(res, e.status || 500, { error: e.message || String(e) });
      }
      return;
    }
    json(res, 405, { error: 'Method not allowed.' });
    return;
  }

  // Legacy HTTP+SSE (2024-11-05)
  if (req.method === 'GET' && pathName === '/sse') {
    if (!requireAuth(req, res)) return;
    const sessionId = crypto.randomUUID();
    openSse(res);
    sessions.set(sessionId, { res, created: Date.now() });
    const endpoint = `/message?sessionId=${encodeURIComponent(sessionId)}`;
    writeSse(res, 'endpoint', endpoint);
    attachDesignQueueWatcher(res);
    const keep = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25000);
    req.on('close', () => {
      clearInterval(keep);
      detachDesignQueueWatcher(res);
      sessions.delete(sessionId);
    });
    return;
  }

  if (req.method === 'POST' && pathName === '/message') {
    if (!requireAuth(req, res)) return;
    const sessionId = url.searchParams.get('sessionId');
    const session = sessionId ? sessions.get(sessionId) : null;
    try {
      const raw = await readBody(req);
      const out = await handleJsonRpc(raw);
      if (session && session.res && out != null) {
        writeSse(session.res, 'message', out);
      }
      json(res, 202, { ok: true });
    } catch (e) {
      json(res, e.status || 500, { error: e.message || String(e) });
    }
    return;
  }

  json(res, 404, { error: 'Not found. Use /ws (streamable HTTP) or /sse (legacy).' });
});

server.listen(PORT, HOST, () => {
  process.stderr.write(
    `[mcp-http] ${SERVER_INFO.name} listening on http://${HOST}:${PORT}/ws (db: ${DB_PATH})\n`
  );
  if (!TOKEN) {
    process.stderr.write('[mcp-http] WARNING: WS_MCP_TOKEN is empty — all MCP routes return 503 until set.\n');
  }
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { DEFAULT_PORT, HOST, PORT };
