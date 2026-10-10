'use strict';

/**
 * Optional auto-trigger when a design job becomes waiting_on_agent.
 * Never throws into the caller — redesign / improvements / assign must keep
 * working if notifications, trigger files, or shell commands fail.
 *
 * meta.reason vocabulary (watchers can filter):
 *   assigned | redesign | improvements | questions_answered | refreshed | queue
 *
 * Settings (all optional):
 *   design.agent_notify          — "1" (default) / "0" desktop Notification
 *   design.agent_trigger_command — shell command; placeholders {{job_id}},
 *                                  {{reason}}, {{status}}, {{message}}
 *   design.agent_trigger_file    — override path for the JSON trigger file
 *                                  (default: <db-dir>/design-agent-trigger.json)
 *   design.agent_webhook_url     — http(s) URL; POSTed only for redesign|
 *                                  improvements submissions (empty = skip)
 *   design.agent_webhook_secret  — optional; sent as Authorization: Bearer and
 *                                  X-Webhook-Secret when non-empty
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const WEBHOOK_REASONS = new Set(['redesign', 'improvements']);
const WEBHOOK_TIMEOUT_MS = 8000;

function getSetting(db, key, def = '') {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (row && row.value != null && String(row.value) !== '') return String(row.value);
  } catch { /* ignore */ }
  return def;
}

function logActivity(db, message) {
  try {
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
      'design',
      String(message).slice(0, 2000)
    );
  } catch { /* logging must not break triggers */ }
}

function resolveDbDir() {
  try {
    if (process.env.WS_DB_PATH) return path.dirname(path.resolve(process.env.WS_DB_PATH));
  } catch { /* ignore */ }
  try {
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.getPath === 'function') {
      return electron.app.getPath('userData');
    }
  } catch { /* MCP / plain Node */ }
  return process.cwd();
}

function expandPlaceholders(template, vars) {
  return String(template).replace(/\{\{(job_id|reason|status|message)\}\}/g, (_, key) => {
    const v = vars[key];
    return v == null ? '' : String(v);
  });
}

function resolveTriggerFilePath(db) {
  const custom = getSetting(db, 'design.agent_trigger_file', '').trim();
  return custom || path.join(resolveDbDir(), 'design-agent-trigger.json');
}

function writeTriggerFile(db, payload) {
  const filePath = resolveTriggerFilePath(db);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
}

function lookupJobTitle(db, jobId) {
  if (jobId == null || !db) return null;
  try {
    const row = db.prepare('SELECT title FROM design_jobs WHERE id = ?').get(jobId);
    const t = row && row.title != null ? String(row.title).trim() : '';
    return t ? t.slice(0, 300) : null;
  } catch {
    return null;
  }
}

/** JSON body for redesign/improvements webhook POSTs. */
function buildWebhookPayload(meta = {}) {
  const reason = String(meta.reason || '').slice(0, 80);
  const jobId = meta.jobId != null && Number.isFinite(Number(meta.jobId))
    ? Number(meta.jobId)
    : (meta.job_id != null && Number.isFinite(Number(meta.job_id)) ? Number(meta.job_id) : null);
  const status = String(meta.status || 'waiting_on_agent');
  const title = meta.title != null && String(meta.title).trim()
    ? String(meta.title).trim().slice(0, 300)
    : null;
  return {
    job_id: jobId,
    request_kind: (reason === 'redesign' || reason === 'improvements') ? reason : null,
    reason: reason || null,
    status,
    title,
    timestamp: meta.timestamp || new Date().toISOString(),
  };
}

/**
 * POST design.agent_webhook_url for redesign|improvements only.
 * Empty URL → no-op. Failures never throw; caller logs via return value.
 * @param {object} db
 * @param {{ jobId?: number, reason?: string, status?: string, title?: string|null }} meta
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 */
async function fireAgentWebhook(db, meta = {}, opts = {}) {
  const reason = String(meta.reason || '').slice(0, 80);
  if (!WEBHOOK_REASONS.has(reason)) {
    return { skipped: true, why: 'reason' };
  }

  const url = getSetting(db, 'design.agent_webhook_url', '').trim();
  if (!url) return { skipped: true, why: 'empty_url' };

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'invalid webhook URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'webhook URL must be http(s)' };
  }

  const title = meta.title !== undefined
    ? (meta.title != null && String(meta.title).trim() ? String(meta.title).trim().slice(0, 300) : null)
    : lookupJobTitle(db, meta.jobId != null ? meta.jobId : meta.job_id);

  const body = buildWebhookPayload({
    jobId: meta.jobId != null ? meta.jobId : meta.job_id,
    reason,
    status: meta.status || 'waiting_on_agent',
    title,
    timestamp: meta.timestamp,
  });

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'User-Agent': 'WebsiteScout-DesignAgentWebhook/1',
  };
  const secret = getSetting(db, 'design.agent_webhook_secret', '').trim();
  if (secret) {
    headers.Authorization = `Bearer ${secret}`;
    headers['X-Webhook-Secret'] = secret;
  }

  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return { ok: false, error: 'fetch is not available' };
  }

  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : WEBHOOK_TIMEOUT_MS;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, status: res.status, payload: body };
    }
    return { ok: true, status: res.status, payload: body };
  } catch (e) {
    return { ok: false, error: e.message || String(e), payload: body };
  }
}

/** Read-only status for MCP / Settings — does not fire a trigger. */
function agentTriggerStatus(db) {
  const filePath = resolveTriggerFilePath(db);
  const notifyEnabled = getSetting(db, 'design.agent_notify', '1') !== '0';
  const command = getSetting(db, 'design.agent_trigger_command', '').trim();
  const webhookUrl = getSetting(db, 'design.agent_webhook_url', '').trim();
  const webhookSecret = getSetting(db, 'design.agent_webhook_secret', '').trim();
  let lastPayload = null;
  let fileExists = false;
  try {
    if (fs.existsSync(filePath)) {
      fileExists = true;
      const raw = fs.readFileSync(filePath, 'utf8');
      try { lastPayload = JSON.parse(raw); } catch { lastPayload = { raw: String(raw).slice(0, 500) }; }
    }
  } catch { /* ignore */ }
  return {
    triggerFilePath: filePath,
    fileExists,
    notifyEnabled,
    commandConfigured: !!command,
    webhookConfigured: !!webhookUrl,
    webhookSecretConfigured: !!webhookSecret,
    lastPayload,
    hint: 'Queuing waiting_on_agent (assign, redesign, improve, email submit, questions answered) writes this file and may desktop-notify / run the configured command. Redesign/improvements also POST design.agent_webhook_url when set. Claim work with design.next — no separate fire tool.',
  };
}

function showDesktopNotification(payload) {
  try {
    const electron = require('electron');
    const Notification = electron && electron.Notification;
    if (!Notification || typeof Notification.isSupported !== 'function' || !Notification.isSupported()) {
      return false;
    }
    const jobBit = payload.job_id != null ? `#${payload.job_id}` : 'job';
    const n = new Notification({
      title: 'Website Scout — design agent needed',
      body: `${jobBit} is waiting_on_agent (${payload.reason}). Claim with MCP design.next.`,
    });
    n.show();
    return true;
  } catch {
    return false;
  }
}

function runTriggerCommand(db, payload) {
  const cmd = getSetting(db, 'design.agent_trigger_command', '').trim();
  if (!cmd) return { skipped: true };

  const expanded = expandPlaceholders(cmd, {
    job_id: payload.job_id != null ? String(payload.job_id) : '',
    reason: payload.reason || '',
    status: payload.status || '',
    message: String(payload.message || '').slice(0, 500),
  });

  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn(expanded, {
        shell: true,
        // Keep attached long enough for short scripts; long-running agents
        // should daemonize themselves inside the user command.
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...process.env,
          WS_DESIGN_JOB_ID: payload.job_id != null ? String(payload.job_id) : '',
          WS_DESIGN_REASON: String(payload.reason || ''),
          WS_DESIGN_STATUS: String(payload.status || ''),
          WS_DESIGN_MESSAGE: String(payload.message || '').slice(0, 500),
        },
      });
    } catch (e) {
      done({ ok: false, error: e.message || String(e) });
      return;
    }

    child.on('error', (e) => done({ ok: false, error: e.message || String(e) }));
    // Treat successful spawn as success; do not wait for exit (may be long-lived).
    try { child.unref(); } catch { /* ignore */ }
    setTimeout(() => done({ ok: true, command: expanded.slice(0, 200) }), 80);
  });
}

/**
 * Fire-and-forget side effects after a job enters waiting_on_agent.
 * @param {object} db
 * @param {{ jobId?: number, reason?: string, status?: string, message?: string }} meta
 */
function fireAgentTriggers(db, meta = {}) {
  if (!db) return;
  const status = String(meta.status || 'waiting_on_agent');
  if (status !== 'waiting_on_agent') return;

  const reason = String(meta.reason || 'queue').slice(0, 80);
  const payload = {
    at: new Date().toISOString(),
    job_id: meta.jobId != null && Number.isFinite(Number(meta.jobId)) ? Number(meta.jobId) : null,
    reason,
    // Same vocabulary as design_jobs.request_kind when reason is redesign|improvements
    request_kind: (reason === 'redesign' || reason === 'improvements') ? reason : null,
    status,
    message: String(meta.message || '').slice(0, 500),
    mcp_hint: 'Call design.next or design.pending',
  };

  setImmediate(() => {
    (async () => {
      try {
        const filePath = writeTriggerFile(db, payload);
        logActivity(db, `Agent trigger file written (${payload.reason}, job #${payload.job_id ?? '?'}): ${filePath}`);
      } catch (e) {
        logActivity(db, `Agent trigger file failed: ${e.message || e}`);
      }

      try {
        const notifyOn = getSetting(db, 'design.agent_notify', '1') !== '0';
        if (notifyOn) {
          const shown = showDesktopNotification(payload);
          if (shown) {
            logActivity(db, `Agent desktop notification shown (job #${payload.job_id ?? '?'}, ${payload.reason}).`);
          }
        }
      } catch (e) {
        logActivity(db, `Agent desktop notification failed: ${e.message || e}`);
      }

      try {
        const result = await runTriggerCommand(db, payload);
        if (result && !result.skipped) {
          if (result.ok) {
            logActivity(db, `Agent trigger command launched (job #${payload.job_id ?? '?'}, ${payload.reason}).`);
          } else {
            logActivity(db, `Agent trigger command failed: ${(result && result.error) || 'unknown'}`);
          }
        }
      } catch (e) {
        logActivity(db, `Agent trigger command failed: ${e.message || e}`);
      }

      // Webhook: redesign | improvements submissions only (not assign / Q&A / refresh).
      try {
        const wh = await fireAgentWebhook(db, {
          jobId: payload.job_id,
          reason: payload.reason,
          status: payload.status,
        });
        if (wh && wh.skipped) {
          /* empty URL or non-redesign/improvements reason */
        } else if (wh && wh.ok) {
          logActivity(db, `Agent webhook posted (job #${payload.job_id ?? '?'}, ${payload.reason}).`);
        } else {
          logActivity(db, `Agent webhook failed: ${(wh && wh.error) || 'unknown'}`);
        }
      } catch (e) {
        logActivity(db, `Agent webhook failed: ${e.message || e}`);
      }
    })().catch(() => { /* never surface */ });
  });
}

module.exports = {
  fireAgentTriggers,
  fireAgentWebhook,
  buildWebhookPayload,
  expandPlaceholders,
  resolveDbDir,
  resolveTriggerFilePath,
  agentTriggerStatus,
  WEBHOOK_REASONS,
  WEBHOOK_TIMEOUT_MS,
};
