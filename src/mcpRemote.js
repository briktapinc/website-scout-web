'use strict';

// Starts/stops the Tailscale-facing HTTP MCP child process from Electron.

const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const tailscale = require('./tailscale');

const DEFAULT_PORT = 8742;
let child = null;
let lastMeta = null;

function getSetting(db, key, fallback = '') {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row && row.value != null ? String(row.value) : fallback;
  } catch {
    return fallback;
  }
}

function setSetting(db, key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

function ensureToken(db) {
  let token = getSetting(db, 'mcp.http_token', '').trim();
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    setSetting(db, 'mcp.http_token', token);
  }
  return token;
}

function isRunning() {
  return !!(child && child.exitCode == null);
}

function status(db) {
  const port = Math.min(65535, Math.max(1, Number(getSetting(db, 'mcp.http_port', String(DEFAULT_PORT))) || DEFAULT_PORT));
  const token = getSetting(db, 'mcp.http_token', '');
  const publicUrl = getSetting(db, 'mcp.public_url', '').trim();
  return {
    running: isRunning(),
    pid: isRunning() ? child.pid : null,
    port,
    publicUrl,
    tokenSet: !!String(token).trim(),
    token: String(token).trim(),
    startedAt: lastMeta && lastMeta.startedAt || null,
    lastExit: lastMeta && lastMeta.lastExit || null,
  };
}

/**
 * Resolve the client-facing Tailscale/public URLs.
 * mcp.public_url may be a base (http://host:8742 or https://host.ts.net)
 * or a full MCP endpoint ending in /ws (or legacy /mcp).
 */
function resolvePublicUrls(db, ts, port) {
  const custom = getSetting(db, 'mcp.public_url', '').trim();
  const detectedHost = (ts && (ts.dnsName || ts.ipv4)) || '';
  const detectedBase = detectedHost ? `http://${detectedHost}:${port}` : `http://TAILSCALE-HOST:${port}`;

  if (!custom) {
    return {
      base: detectedBase,
      mcp: `${detectedBase}/ws`,
      mcpAlias: `${detectedBase}/mcp`,
      sse: `${detectedBase}/sse`,
      health: `${detectedBase}/health`,
      localMcp: `http://127.0.0.1:${port}/mcp`,
      localWs: `http://127.0.0.1:${port}/ws`,
      custom: false,
      publicUrlSetting: '',
      detectedBase,
    };
  }

  let raw = custom.replace(/\/+$/, '');
  // Allow host-only shorthand: "mybox.tailnet.ts.net" or "100.x.x.x"
  if (!/^https?:\/\//i.test(raw)) {
    raw = `http://${raw}`;
  }
  let base;
  let mcpUrl;
  if (/\/(ws|mcp)$/i.test(raw)) {
    mcpUrl = raw.replace(/\/mcp$/i, '/ws');
    base = raw.replace(/\/(ws|mcp)$/i, '');
  } else {
    base = raw;
    mcpUrl = `${base}/ws`;
  }
  return {
    base,
    mcp: mcpUrl,
    mcpAlias: `${base}/mcp`,
    sse: `${base}/sse`,
    health: `${base}/health`,
    localMcp: `http://127.0.0.1:${port}/mcp`,
    localWs: `http://127.0.0.1:${port}/ws`,
    custom: true,
    publicUrlSetting: custom,
    detectedBase,
  };
}

function normalizePublicUrl(raw) {
  const value = raw == null ? '' : String(raw).trim();
  if (!value) return { ok: true, value: '' };
  if (value.length > 500) return { ok: false, error: 'URL must be 500 characters or fewer.' };
  let candidate = value.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(candidate)) {
    // host or host:port
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(candidate.split('/')[0])) {
      return { ok: false, error: 'Use an http(s) URL, MagicDNS name, or Tailscale IP.' };
    }
    candidate = `http://${candidate}`;
  }
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, error: 'URL must be http or https.' };
    }
  } catch {
    return { ok: false, error: 'Not a valid URL.' };
  }
  return { ok: true, value: value.replace(/\/+$/, '') };
}

function setPublicUrl(db, raw) {
  const n = normalizePublicUrl(raw);
  if (!n.ok) throw Object.assign(new Error(n.error), { code: 'INVALID_URL' });
  setSetting(db, 'mcp.public_url', n.value);
  try {
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
      'mcp',
      n.value ? `MCP public URL set to ${n.value}` : 'MCP public URL cleared (using detected Tailscale host).'
    );
  } catch { /* ignore */ }
  return { publicUrl: n.value };
}

async function setListenPort(db, raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw Object.assign(new Error('Port must be an integer from 1 to 65535.'), { code: 'INVALID_PORT' });
  }
  const was = isRunning();
  setSetting(db, 'mcp.http_port', String(n));
  if (was) {
    stop();
    await start(db);
  }
  return { port: n, restarted: was };
}

function suggestedPublicBase(ts, port) {
  if (ts && ts.dnsName) return `http://${ts.dnsName}:${port}`;
  if (ts && ts.ipv4) return `http://${ts.ipv4}:${port}`;
  return '';
}

/** Full streamable-HTTP MCP endpoint (for Cursor / remote clients). */
function suggestedPublicUrl(ts, port) {
  const base = suggestedPublicBase(ts, port);
  return base ? `${base}/ws` : '';
}

function stop() {
  if (!child) return { stopped: true, wasRunning: false };
  const proc = child;
  child = null;
  try { proc.kill(); } catch { /* ignore */ }
  return { stopped: true, wasRunning: true };
}

async function start(db) {
  if (isRunning()) return Object.assign({ ok: true, already: true }, status(db));
  const token = ensureToken(db);
  const port = Math.min(65535, Math.max(1, Number(getSetting(db, 'mcp.http_port', String(DEFAULT_PORT))) || DEFAULT_PORT));
  setSetting(db, 'mcp.http_port', String(port));

  const existingHealth = await healthCheck(port);
  if (existingHealth.ok) {
    const auth = await verifyMcpAuth(port, token);
    if (auth.ok) {
      return Object.assign({ ok: true, already: false, adopted: true }, status(db));
    }
  }

  const script = path.resolve(__dirname, 'mcpHttp.js');
  const dbPath = db && typeof db.name === 'string' && db.name ? path.resolve(db.name) : '';
  const env = Object.assign({}, process.env, {
    WS_DB_PATH: dbPath,
    WS_MCP_TOKEN: token,
    WS_MCP_PORT: String(port),
    WS_MCP_HOST: '0.0.0.0',
  });
  // Electron's process.execPath is electron.exe — always spawn system node for the HTTP server.
  child = spawn('node', [script], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  lastMeta = { startedAt: new Date().toISOString(), lastExit: null };
  let errBuf = '';
  child.stderr.on('data', (buf) => {
    errBuf += String(buf);
    if (errBuf.length > 4000) errBuf = errBuf.slice(-2000);
  });
  child.on('exit', (code, signal) => {
    lastMeta.lastExit = { code, signal, at: new Date().toISOString(), log: errBuf.slice(-500) };
    child = null;
  });
  child.on('error', (e) => {
    lastMeta.lastExit = { code: null, signal: null, at: new Date().toISOString(), log: e.message };
    child = null;
  });

  const ready = await waitForHealth(port);
  if (!ready.ok) {
    const adopted = await healthCheck(port);
    if (adopted.ok) {
      const auth = await verifyMcpAuth(port, token);
      if (auth.ok) {
        return Object.assign({ ok: true, already: false, adopted: true }, status(db));
      }
    }
    const exit = lastMeta && lastMeta.lastExit;
    const hint = (exit && exit.log) || ready.error || 'Health check failed after start.';
    return Object.assign({ ok: false, error: hint }, status(db));
  }

  try {
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
      'mcp',
      `HTTP MCP started on port ${port} (Tailscale-ready).`
    );
  } catch { /* ignore */ }
  return Object.assign({ ok: true, already: false, adopted: false }, status(db));
}

async function rotateToken(db) {
  const token = crypto.randomBytes(24).toString('hex');
  setSetting(db, 'mcp.http_token', token);
  const was = isRunning();
  if (was) {
    stop();
    await start(db);
  }
  return { token, restarted: was };
}

function healthCheck(port, token) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/health',
      method: 'GET',
      timeout: 1500,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve({ ok: res.statusCode === 200, body: JSON.parse(raw) }); }
        catch { resolve({ ok: false, body: raw }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.end();
    void token;
  });
}

function verifyMcpAuth(port, token) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'website-scout-probe', version: '0' },
      },
    });
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/ws',
      method: 'POST',
      timeout: 2500,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        const ok = res.statusCode === 200 && /"result"/.test(raw) && !/"error"/.test(raw);
        resolve({ ok, statusCode: res.statusCode, body: raw.slice(0, 300) });
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(port, attempts = 25, delayMs = 160) {
  for (let i = 0; i < attempts; i++) {
    const h = await healthCheck(port);
    if (h.ok) return h;
    await delay(delayMs);
  }
  return { ok: false, error: 'timeout' };
}

async function connectionInfo(db) {
  const baseHttp = status(db);
  const health = await healthCheck(baseHttp.port, baseHttp.token);
  const listenerSource = baseHttp.running ? 'app' : (health.ok ? 'external' : null);
  const httpStatus = Object.assign({}, baseHttp, {
    healthOk: !!health.ok,
    listening: !!(baseHttp.running || health.ok),
    listenerSource,
  });
  const ts = await tailscale.getStatus();
  const port = httpStatus.port;
  const token = httpStatus.token || ensureToken(db);
  const urls = resolvePublicUrls(db, ts, port);
  const remoteEntry = {
    url: urls.mcp,
    headers: { Authorization: `Bearer ${token}` },
  };
  // ChatGPT UI often wants a URL ending in /mcp; /ws and /mcp are the same handler.
  const chatgptDirectEntry = {
    url: urls.mcpAlias || urls.mcp,
    headers: { Authorization: `Bearer ${token}` },
  };
  const localMcp = urls.localMcp || `http://127.0.0.1:${port}/mcp`;
  const examples = [
    {
      title: 'Cursor / Muse (Streamable HTTP)',
      note: 'Same HTTP MCP server. Cursor and Muse use url + Bearer — they do not use OpenAI tunnel_id. Paste into ~/.cursor/mcp.json (or project .cursor/mcp.json).',
      body: JSON.stringify({ mcpServers: { 'website-scout': remoteEntry } }, null, 2),
    },
    {
      title: 'ChatGPT — Secure MCP Tunnel (private)',
      note: 'OpenAI-only path. ChatGPT/Codex/Responses use tunnel_id; tunnel-client on this PC forwards to the local HTTP MCP. Cursor/Muse keep using the JSON configs above against the same listener.',
      body: [
        '# 1) Start HTTP MCP in this app (port below).',
        '# 2) Create a tunnel in OpenAI Platform → Tunnel settings; copy tunnel_id.',
        '# 3) Download tunnel-client, then:',
        '',
        'export CONTROL_PLANE_API_KEY="sk-..."   # OpenAI API key with Tunnels Use',
        `tunnel-client init \\`,
        `  --profile website-scout \\`,
        `  --tunnel-id tunnel_YOUR_ID \\`,
        `  --mcp-server-url ${localMcp}`,
        '',
        'tunnel-client doctor --profile website-scout --explain',
        'tunnel-client run --profile website-scout',
        '',
        '# 4) ChatGPT → Plugins → Add custom MCP server → Connection: Tunnel → pick tunnel_id',
        `# Local MCP (what the tunnel forwards to): ${localMcp}`,
        `# Bearer for direct clients (Cursor/Muse/Tailscale): ${token}`,
      ].join('\n'),
    },
    {
      title: 'ChatGPT / Claude — direct HTTPS URL (when public)',
      note: 'Only if this endpoint is reachable over public HTTPS (e.g. Tailscale Funnel / reverse proxy). Prefer /mcp. ChatGPT often expects OAuth for custom connectors; Bearer works in Cursor/Muse/Codex configs.',
      body: JSON.stringify({ mcpServers: { 'website-scout': chatgptDirectEntry } }, null, 2),
    },
    {
      title: 'VS Code (HTTP)',
      note: 'Same Streamable HTTP endpoint.',
      body: JSON.stringify({
        servers: {
          'website-scout': {
            type: 'http',
            url: urls.mcp,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      }, null, 2),
    },
    {
      title: 'curl smoke test',
      note: 'From this machine or any device that can reach the MCP URL.',
      body: [
        `curl -s ${urls.health}`,
        `curl -s -X POST ${urls.mcpAlias || urls.mcp} \\`,
        `  -H "Authorization: Bearer ${token}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -H "Accept: application/json, text/event-stream" \\`,
        `  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}',`,
      ].join('\n'),
    },
    {
      title: 'Optional: Tailscale Serve',
      note: 'Publishes HTTPS on your MagicDNS name. Set the public URL to https://your-machine.ts.net afterward.',
      body: [
        `tailscale serve --bg ${port}`,
        `# then set public URL to: https://${ts.dnsName || 'your-machine.ts.net'}`,
        `# MCP endpoints: https://${ts.dnsName || 'your-machine.ts.net'}/ws  and  .../mcp`,
      ].join('\n'),
    },
  ];
  return {
    http: httpStatus,
    tailscale: ts,
    urls,
    suggestedPublicUrl: suggestedPublicUrl(ts, port),
    suggestedPublicBase: suggestedPublicBase(ts, port),
    examples,
    notes: [
      'One Streamable HTTP listener serves Cursor, Muse, Claude, VS Code, and (via OpenAI tunnel-client) ChatGPT.',
      'Cursor/Muse: url + Authorization Bearer in mcp.json. They do not use OpenAI tunnel_id.',
      'ChatGPT private access: OpenAI Secure MCP Tunnel — tunnel-client on this PC points at http://127.0.0.1:<port>/mcp while HTTP MCP is running.',
      '/ws and /mcp are the same handler; ChatGPT UIs often prefer a URL ending in /mcp.',
      'HTTP MCP is for Tailscale (or another private network). Do not expose this port on the public internet without Tailscale Serve/Funnel and the bearer token.',
      'Authorization: Bearer is required on /ws, /mcp, and /sse. /health is open for liveness checks.',
      'Design jobs: agents poll design.pending / design.next. HTTP SSE also notifies on queue changes.',
    ],
  };
}

module.exports = {
  DEFAULT_PORT,
  start,
  stop,
  status,
  rotateToken,
  ensureToken,
  healthCheck,
  connectionInfo,
  isRunning,
  resolvePublicUrls,
  setPublicUrl,
  setListenPort,
  normalizePublicUrl,
  suggestedPublicUrl,
  suggestedPublicBase,
};
