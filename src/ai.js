'use strict';

/**
 * Shared AI client (owned by the Website Engine workstream).
 *
 * OpenAI-compatible POST to `<ai.base_url>/chat/completions` using the API key
 * stored in settings (`ai.api_key`). Other workstreams require this module:
 *
 *   const { chat, aiConfigured } = require('../ai');
 *
 * Contract:
 *  - chat({ task, messages, maxTokens=2000, leadId, note, db }) — task is one of
 *    research|generation|scoring|email|qa|editor|followup. Model resolves from
 *    `ai.model.<task>` falling back to `ai.model.default`.
 *  - `db` is required (workspace SQLite). Missing db throws AI_DB_REQUIRED so
 *    concurrent tenants cannot share keys/budget via a module-level handle.
 *  - Throws AI_NOT_CONFIGURED when no key is set (callers fall back to
 *    deterministic template output).
 *  - Throws AUTOMATION_PAUSED when settings.automation_paused = 1.
 *  - Throws BUDGET_EXCEEDED when today's SUM(ai_usage.cost_usd) >=
 *    cost.daily_budget_usd (a budget <= 0 means unlimited).
 *  - Every call is logged to ai_usage with token counts + cost estimate
 *    (cost.per_1k_prompt default 0.0015, cost.per_1k_completion default 0.002).
 *  - aiConfigured(db) — true when an API key is set on that workspace db.
 *  - No key material is ever written to logs or error messages.
 */

function requireDb(db, label = 'db') {
  if (!db || typeof db.prepare !== 'function') {
    throw fail('AI_DB_REQUIRED', `${label} is required — pass the workspace database handle.`);
  }
  return db;
}

function getSetting(key, def, db) {
  requireDb(db, 'db');
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : def;
}

function aiConfigured(db) {
  if (!db || typeof db.prepare !== 'function') return false;
  const key = getSetting('ai.api_key', '', db);
  return !!(key && String(key).trim());
}

function fail(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

function todaySpendUsd(db) {
  const row = db.prepare(
    "SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM ai_usage WHERE date(at) = date('now')"
  ).get();
  return Number(row.spent) || 0;
}

const VALID_TASKS = new Set([
  'research', 'generation', 'scoring', 'email', 'qa', 'editor', 'followup',
]);

/** @deprecated No-op — callers must pass db into chat()/aiConfigured(). Kept for IPC compat. */
function setDb() { /* intentionally empty */ }

async function chat({ task, messages, maxTokens = 2000, leadId = null, note = null, db: dbArg = null } = {}) {
  if (!task || !VALID_TASKS.has(task)) {
    throw fail('INVALID_TASK', `Unknown AI task "${task}".`);
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw fail('INVALID_MESSAGES', 'messages must be a non-empty array.');
  }
  let hasImages = false;
  for (const m of messages) {
    if (!m || typeof m.role !== 'string') {
      throw fail('INVALID_MESSAGES', 'Each message needs a string role and content.');
    }
    if (typeof m.content === 'string') continue;
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (!part || typeof part !== 'object') {
          throw fail('INVALID_MESSAGES', 'Multimodal content parts must be objects.');
        }
        if (part.type === 'image_url' || (part.image_url && part.image_url.url)) hasImages = true;
      }
      continue;
    }
    throw fail('INVALID_MESSAGES', 'Each message content must be a string or multimodal array.');
  }
  const tokens = Number(maxTokens);
  if (!Number.isFinite(tokens) || tokens <= 0) {
    throw fail('INVALID_MAX_TOKENS', 'maxTokens must be a positive number.');
  }

  const db = requireDb(dbArg);

  const apiKey = getSetting('ai.api_key', '', db);
  if (!apiKey || !String(apiKey).trim()) {
    throw fail('AI_NOT_CONFIGURED', 'AI is not configured: set ai.api_key in Settings.');
  }

  if (String(getSetting('automation_paused', '0', db)) === '1') {
    throw fail('AUTOMATION_PAUSED', 'Automation is paused; AI calls are blocked.');
  }

  const budget = parseFloat(getSetting('cost.daily_budget_usd', '10', db));
  if (budget > 0) {
    const spent = todaySpendUsd(db);
    if (spent >= budget) {
      throw fail('BUDGET_EXCEEDED', 'Daily AI budget exceeded.');
    }
  }

  const baseUrl = String(getSetting('ai.base_url', 'https://api.openai.com/v1', db) || '')
    .trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw fail('INVALID_BASE_URL', 'ai.base_url must be an http(s) URL.');
  }

  let model = getSetting(`ai.model.${task}`, '', db);
  if (!model || !String(model).trim()) {
    model = getSetting('ai.model.default', 'gpt-4o-mini', db);
  }
  model = String(model).trim();
  // Vision-capable default when the request includes screenshots / images.
  if (hasImages) {
    const visionModel = getSetting('ai.model.vision', '', db);
    if (visionModel && String(visionModel).trim()) {
      model = String(visionModel).trim();
    } else if (/mini|nano|haiku/i.test(model)) {
      model = 'gpt-4o';
    }
  }

  const url = `${baseUrl}/chat/completions`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Key is only ever placed in the Authorization header, never logged.
        'Authorization': `Bearer ${String(apiKey).trim()}`,
      },
      body: JSON.stringify({
        model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        max_tokens: Math.floor(tokens),
      }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    throw fail('AI_NETWORK_ERROR', `AI request failed to reach the provider (${e.message || 'network error'}).`);
  }

  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    throw fail('AI_BAD_RESPONSE', `AI provider returned a non-JSON response (HTTP ${res.status}).`);
  }

  if (!res.ok) {
    // Never include the key or raw provider payload in the error.
    const providerMsg = data && data.error && data.error.message
      ? String(data.error.message).slice(0, 200)
      : `HTTP ${res.status}`;
    throw fail('AI_REQUEST_FAILED', `AI request failed: ${providerMsg}`, { status: res.status });
  }

  const usage = (data && data.usage) || {};
  const promptTokens = Number(usage.prompt_tokens) || 0;
  const completionTokens = Number(usage.completion_tokens) || 0;
  const per1kPrompt = parseFloat(getSetting('cost.per_1k_prompt', '0.0015', db)) || 0;
  const per1kCompletion = parseFloat(getSetting('cost.per_1k_completion', '0.002', db)) || 0;
  const costUsd = (promptTokens / 1000) * per1kPrompt + (completionTokens / 1000) * per1kCompletion;

  // Log every call. Note/note text never includes key material (callers must
  // keep prompts free of secrets; see credential rules).
  db.prepare(
    `INSERT INTO ai_usage (task, model, prompt_tokens, completion_tokens, cost_usd, lead_id, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(task, model, promptTokens, completionTokens, costUsd, leadId, note ? String(note).slice(0, 500) : null);

  let text = '';
  try {
    const choice = data.choices && data.choices[0];
    text = (choice && choice.message && choice.message.content) || '';
  } catch (e) { /* keep text empty */ }

  return { text: String(text), model, promptTokens, completionTokens, costUsd };
}

module.exports = { chat, aiConfigured, setDb, getSetting };
