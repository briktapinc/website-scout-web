'use strict';

/**
 * Meta Muse Model API agent loop for Hands-off mode.
 * OpenAI-compatible chat/completions + tools → server/mcp.js callTool (workspace scope).
 */

const platform = require('./platform');
const crypto = require('node:crypto');
const { defaultWebsiteInstructions } = require('../src/defaultDesignInstructions');

const MAX_STEPS = 36;
const MAX_PORTAL_STEPS = 20;
const REQUEST_TIMEOUT_MS = 180000;

/** Mutating client tools — after any of these, portal chat refreshes the preview. */
const PORTAL_MUTATE_TOOLS = new Set([
  'site.editText',
  'site.editListItem',
  'site.replaceImage',
  'site.generateImage',
  'site.setLogo',
  'theme.set',
  'pages.structure.update',
  'modules.attach',
  'modules.detach',
  'modules.uploadImage',
  'site.publish',
  'site.canvasBlock',
  'website.addModule',
]);

/** Tools Muse must not call in Hands-off (destructive / meta / job control). */
const DENY_TOOLS = new Set([
  'lead.delete',
  'website.delete',
  'jobs.delete',
  'jobs.create',
  'jobs.update',
  'jobs.runNow',
  'automation.pause',
  'automation.resume',
  'settings.set',
  'prompts.save',
  'handsOff.runNow',
  'handsOff.status',
]);

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function getDbSetting(db, key, def = '') {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row && row.value != null ? String(row.value) : def;
  } catch {
    return def;
  }
}

async function resolveMuseConfig(db) {
  let apiKey = '';
  let baseUrl = 'https://api.meta.ai/v1';
  let model = 'muse-spark-1.3';
  try {
    apiKey = String(await platform.getPlatformSetting('muse.model_api_key', '') || '').trim();
    baseUrl = String(await platform.getPlatformSetting('muse.model_base_url', baseUrl) || baseUrl).trim();
    model = String(await platform.getPlatformSetting('muse.model_default', model) || model).trim();
  } catch { /* platform DB unavailable — fall through to workspace */ }
  if (!apiKey && db) {
    apiKey = String(getDbSetting(db, 'muse.model_api_key', '') || '').trim();
    const b = String(getDbSetting(db, 'muse.model_base_url', '') || '').trim();
    const m = String(getDbSetting(db, 'muse.model_default', '') || '').trim();
    if (b) baseUrl = b;
    if (m) model = m;
  }
  baseUrl = baseUrl.replace(/\/+$/, '');
  return { apiKey, baseUrl, model };
}

function museConfigured(config) {
  return !!(config && config.apiKey && /^https?:\/\//i.test(config.baseUrl));
}

function todaySpendUsd(db) {
  try {
    const row = db.prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM ai_usage WHERE date(at) = date('now')"
    ).get();
    return Number(row.spent) || 0;
  } catch {
    return 0;
  }
}

function logUsage(db, { task, model, promptTokens, completionTokens, costUsd, leadId, note }) {
  try {
    db.prepare(
      `INSERT INTO ai_usage (task, model, prompt_tokens, completion_tokens, cost_usd, lead_id, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      task || 'hands_off',
      model || '',
      promptTokens || 0,
      completionTokens || 0,
      costUsd || 0,
      leadId || null,
      note ? String(note).slice(0, 500) : null
    );
  } catch (e) {
    console.warn('[museAgent] ai_usage log failed:', e.message);
  }
}

function mcpToolsToOpenAi(toolDefs) {
  const toolNames = new Map();
  const tools = (toolDefs || []).filter(t => t && t.name && !DENY_TOOLS.has(t.name)).map(t => {
    // Providers have different namespace rules. Keep wire names portable, short,
    // and unambiguous; dispatch only through this advertised catalog map.
    const name = String(t.name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)
      + '_' + crypto.createHash('sha256').update(t.name).digest('hex').slice(0, 12);
    if (toolNames.has(name)) throw fail('TOOL_CATALOG_INVALID', 'Duplicate AI tool alias');
    toolNames.set(name, t.name);
    return { type: 'function', function: {
      name,
      description: String(t.description || '').slice(0, 1024),
      parameters: t.inputSchema && typeof t.inputSchema === 'object'
        ? t.inputSchema : { type: 'object', properties: {} },
    }};
  });
  return { tools, toolNames };
}

function buildSystemPrompt(job) {
  const brief = job && job.brief
    ? (typeof job.brief === 'string' ? job.brief : JSON.stringify(job.brief, null, 0))
    : '';
  const parts = [
    defaultWebsiteInstructions(),
    '',
    '═══ HANDS-OFF SESSION ═══',
    'You are running unattended inside BitPype Hands-off. Use only the tools provided.',
    'Claim/work this design job, deliver a complete modular site with design.deliver, then website.preview or cloudflare.publish.',
    'Do not ask the human; use design.ask only if a missing fact blocks an accurate build — then stop.',
    `Job id: ${job && job.id != null ? job.id : '(unknown)'}`,
    `Title: ${job && job.title ? job.title : ''}`,
    job && job.lead_id != null ? `Lead id: ${job.lead_id}` : '',
    job && job.instructions ? `Job instructions:\n${String(job.instructions).slice(0, 8000)}` : '',
    brief ? `Brief JSON:\n${String(brief).slice(0, 12000)}` : '',
  ];
  return parts.filter(Boolean).join('\n');
}

function deliveredOk(toolName, outcome) {
  if (toolName !== 'design.deliver') return false;
  if (!outcome || outcome.ok === false) return false;
  const data = outcome.data;
  if (!data) return true;
  const job = data.job || data;
  if (job && job.status === 'delivered') return true;
  if (data.status === 'delivered') return true;
  return outcome.ok === true;
}

async function chatCompletions(config, body) {
  const url = `${config.baseUrl}/chat/completions`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw fail('MUSE_NETWORK', `Muse request failed: ${e.message || 'network error'}`);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    throw fail('MUSE_BAD_RESPONSE', `Muse returned non-JSON (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const providerMsg = data && data.error && data.error.message
      ? String(data.error.message).slice(0, 200)
      : `HTTP ${res.status}`;
    throw fail('MUSE_REQUEST_FAILED', `Muse request failed: ${providerMsg}`);
  }
  return data;
}

/**
 * Run the Muse tool loop for one design job.
 * @returns {{ ok, delivered, steps, toolCalls, error?, costUsd, model }}
 */
async function runJobLoop(workspaceId, job, { db, maxSteps = MAX_STEPS } = {}) {
  if (!job || job.id == null) throw fail('INVALID_JOB', 'design job required');
  const domain = require('./domain');
  const mcp = require('./mcp');

  if (domain.withDb(workspaceId, (d) => domain.getSetting(d, 'automation_paused', '0')) === '1') {
    return { ok: false, delivered: false, steps: 0, toolCalls: 0, error: 'automation_paused', costUsd: 0 };
  }

  const config = await resolveMuseConfig(db);
  if (!museConfigured(config)) {
    return { ok: false, delivered: false, steps: 0, toolCalls: 0, error: 'muse_not_configured', costUsd: 0 };
  }

  const budget = parseFloat(getDbSetting(db, 'cost.daily_budget_usd', '10')) || 0;
  if (budget > 0 && todaySpendUsd(db) >= budget) {
    return { ok: false, delivered: false, steps: 0, toolCalls: 0, error: 'budget_exceeded', costUsd: 0 };
  }

  const { tools, toolNames } = mcpToolsToOpenAi(mcp.toolDefs({ clientScoped: false }));
  const messages = [
    { role: 'system', content: buildSystemPrompt(job) },
    {
      role: 'user',
      content: `Build and deliver design job #${job.id} for this business. Use tools only. Call design.next if needed, then design.get, then design.deliver, then publish/preview.`,
    },
  ];

  let steps = 0;
  let toolCalls = 0;
  let totalCost = 0;
  let delivered = false;
  let lastError = null;
  const consecutiveToolErrors = { n: 0 };

  while (steps < maxSteps) {
    if (domain.withDb(workspaceId, (d) => domain.getSetting(d, 'automation_paused', '0')) === '1') {
      return {
        ok: false, delivered, steps, toolCalls, error: 'automation_paused', costUsd: totalCost, model: config.model,
      };
    }
    if (budget > 0 && todaySpendUsd(db) >= budget) {
      return {
        ok: false, delivered, steps, toolCalls, error: 'budget_exceeded', costUsd: totalCost, model: config.model,
      };
    }

    steps++;
    let data;
    try {
      data = await chatCompletions(config, {
        model: config.model,
        messages,
        tools,
        tool_choice: 'auto',
        max_tokens: 4096,
      });
    } catch (e) {
      lastError = e.code || 'MUSE_REQUEST_FAILED';
      break;
    }

    const usage = (data && data.usage) || {};
    const promptTokens = Number(usage.prompt_tokens) || 0;
    const completionTokens = Number(usage.completion_tokens) || 0;
    const per1kPrompt = parseFloat(getDbSetting(db, 'cost.per_1k_prompt', '0.0015')) || 0;
    const per1kCompletion = parseFloat(getDbSetting(db, 'cost.per_1k_completion', '0.002')) || 0;
    const costUsd = (promptTokens / 1000) * per1kPrompt + (completionTokens / 1000) * per1kCompletion;
    totalCost += costUsd;
    logUsage(db, {
      task: 'hands_off',
      model: config.model,
      promptTokens,
      completionTokens,
      costUsd,
      leadId: job.lead_id || null,
      note: `muse job #${job.id} step ${steps}`,
    });

    const choice = data.choices && data.choices[0];
    const msg = (choice && choice.message) || {};
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

    if (!calls.length) {
      messages.push({
        role: 'assistant',
        content: msg.content != null ? String(msg.content) : '',
      });
      // Model stopped without tools — if not delivered, nudge once then exit
      if (!delivered && steps < maxSteps) {
        messages.push({
          role: 'user',
          content: 'Continue with tools. You must call design.deliver (then publish) to finish. If blocked, explain the gap in one short sentence and stop.',
        });
        continue;
      }
      break;
    }

    messages.push({
      role: 'assistant',
      content: msg.content != null ? msg.content : null,
      tool_calls: calls,
    });

    for (const tc of calls) {
      const wireName = String((tc.function && tc.function.name) || '').trim();
      const name = toolNames.get(wireName);
      let args = {};
      try {
        args = JSON.parse((tc.function && tc.function.arguments) || '{}');
      } catch {
        args = {};
      }
      if (!name || DENY_TOOLS.has(name)) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ ok: false, error: `Tool ${name} is not allowed in Hands-off.` }),
        });
        consecutiveToolErrors.n++;
        continue;
      }

      toolCalls++;
      let outcome;
      try {
        outcome = await mcp.callTool(workspaceId, name, args, {});
      } catch (e) {
        outcome = { ok: false, error: e.message || String(e) };
      }

      if (!outcome || outcome.ok === false) {
        consecutiveToolErrors.n++;
      } else {
        consecutiveToolErrors.n = 0;
      }

      if (deliveredOk(name, outcome)) {
        delivered = true;
      }

      const compact = JSON.stringify(outcome);
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: compact.length > 24000 ? compact.slice(0, 24000) + '…[truncated]' : compact,
      });
    }

    if (delivered) break;
    if (consecutiveToolErrors.n >= 8) {
      lastError = 'repeated_tool_errors';
      break;
    }
  }

  return {
    ok: delivered,
    delivered,
    steps,
    toolCalls,
    error: delivered ? null : (lastError || (steps >= maxSteps ? 'max_steps' : 'not_delivered')),
    costUsd: totalCost,
    model: config.model,
    jobId: job.id,
  };
}

function buildPortalSystemPrompt(leadId, pageSlug) {
  const pageHint = pageSlug
    ? `Focus on page slug "${String(pageSlug).slice(0, 80)}" when using site.render / edits unless the user asks for another page.`
    : 'Use site.render to inspect the current page before editing.';
  return [
    'You are BitPype’s site co-pilot inside the client portal.',
    'The business owner describes improvements in plain language. You apply them with tools only — no admin/workspace tools.',
    `Lead id is ${Number(leadId)}. Always pass leadId on tools that accept it.`,
    pageHint,
    'Workflow: site.get → site.render (includeHtml false unless you need HTML) → mutate with site.editText / theme.set / pages.structure.update / etc. → site.publish so the preview updates.',
    'For text changes, use exact ids from site.render textTargets. Never invent edit ids. If the target is absent, inspect site.render with includeHtml:true. Tool wire aliases must be used exactly as advertised.',
    'Prefer small, accurate edits. Do not invent phone/email/address. Do not delete the whole site.',
    'When finished, stop calling tools and reply in 1–3 short plain-English sentences summarizing what you changed (or why you could not).',
  ].join('\n');
}

function normalizePortalHistory(history, userMessage) {
  const out = [];
  const list = Array.isArray(history) ? history.slice(-10) : [];
  for (const row of list) {
    if (!row || (row.role !== 'user' && row.role !== 'assistant')) continue;
    const content = String(row.content || '').trim();
    if (!content) continue;
    out.push({ role: row.role, content: content.slice(0, 4000) });
  }
  const msg = String(userMessage || '').trim();
  if (!msg) throw fail('EMPTY', 'Message is required.');
  if (msg.length > 4000) throw fail('TOO_LONG', 'Message is too long (max 4000 characters).');
  out.push({ role: 'user', content: msg });
  return out;
}

/**
 * Muse tool loop for portal Website chat (client-scoped MCP only).
 * @returns {{ ok, reply, steps, toolCalls, mutated, published, error?, costUsd, model }}
 */
async function runPortalImproveLoop(workspaceId, leadId, { db, message, history, pageSlug, maxSteps = MAX_PORTAL_STEPS } = {}) {
  const domain = require('./domain');
  const mcp = require('./mcp');
  const lid = Number(leadId);
  if (!Number.isInteger(lid) || lid < 1) throw fail('INVALID', 'leadId required');

  const config = await domain.withDb(workspaceId, async (d) => resolveMuseConfig(db || d));
  if (!museConfigured(config)) {
    return {
      ok: false,
      reply: '',
      steps: 0,
      toolCalls: 0,
      mutated: false,
      published: false,
      error: 'muse_not_configured',
      costUsd: 0,
      model: config.model,
    };
  }

  const { budget, spent } = domain.withDb(workspaceId, (d) => {
    const use = db || d;
    return {
      budget: parseFloat(getDbSetting(use, 'cost.daily_budget_usd', '10')) || 0,
      spent: todaySpendUsd(use),
    };
  });
  if (budget > 0 && spent >= budget) {
    return {
      ok: false,
      reply: '',
      steps: 0,
      toolCalls: 0,
      mutated: false,
      published: false,
      error: 'budget_exceeded',
      costUsd: 0,
      model: config.model,
    };
  }

  const { tools, toolNames } = mcpToolsToOpenAi(mcp.toolDefs({ clientScoped: true }));
  const messages = [
    { role: 'system', content: buildPortalSystemPrompt(lid, pageSlug) },
    ...normalizePortalHistory(history, message),
  ];

  let steps = 0;
  let toolCalls = 0;
  let totalCost = 0;
  let mutated = false;
  let published = false;
  let lastError = null;
  let finalReply = '';
  const consecutiveToolErrors = { n: 0 };
  let nudged = false;

  const logStep = (promptTokens, completionTokens, step) => {
    domain.withDb(workspaceId, (d) => {
      const use = db || d;
      const per1kPrompt = parseFloat(getDbSetting(use, 'cost.per_1k_prompt', '0.0015')) || 0;
      const per1kCompletion = parseFloat(getDbSetting(use, 'cost.per_1k_completion', '0.002')) || 0;
      const costUsd = (promptTokens / 1000) * per1kPrompt + (completionTokens / 1000) * per1kCompletion;
      totalCost += costUsd;
      logUsage(use, {
        task: 'portal_agent',
        model: config.model,
        promptTokens,
        completionTokens,
        costUsd,
        leadId: lid,
        note: `portal muse step ${step}`,
      });
    });
  };

  while (steps < maxSteps) {
    if (budget > 0) {
      const nowSpent = domain.withDb(workspaceId, (d) => todaySpendUsd(db || d));
      if (nowSpent >= budget) {
        lastError = 'budget_exceeded';
        break;
      }
    }

    steps++;
    let data;
    try {
      data = await chatCompletions(config, {
        model: config.model,
        messages,
        tools,
        tool_choice: 'auto',
        max_tokens: 4096,
      });
    } catch (e) {
      lastError = e.code || 'MUSE_REQUEST_FAILED';
      break;
    }

    const usage = (data && data.usage) || {};
    logStep(Number(usage.prompt_tokens) || 0, Number(usage.completion_tokens) || 0, steps);

    const choice = data.choices && data.choices[0];
    const msg = (choice && choice.message) || {};
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

    if (!calls.length) {
      finalReply = msg.content != null ? String(msg.content).trim() : '';
      messages.push({ role: 'assistant', content: finalReply });
      if (!mutated && !nudged && steps < maxSteps) {
        nudged = true;
        messages.push({
          role: 'user',
          content: 'Use tools to apply the change (or explain briefly if you cannot). Call site.publish after edits.',
        });
        continue;
      }
      break;
    }

    messages.push({
      role: 'assistant',
      content: msg.content != null ? msg.content : null,
      tool_calls: calls,
    });

    for (const tc of calls) {
      const wireName = String((tc.function && tc.function.name) || '').trim();
      const name = toolNames.get(wireName);
      let args = {};
      try {
        args = JSON.parse((tc.function && tc.function.arguments) || '{}');
      } catch {
        args = {};
      }
      if (!args.leadId) args.leadId = lid;
      else args.leadId = lid; // pin to session lead

      if (!name || DENY_TOOLS.has(name)) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ ok: false, error: `Tool ${name} is not allowed in portal chat.` }),
        });
        consecutiveToolErrors.n++;
        continue;
      }

      toolCalls++;
      let outcome;
      try {
        outcome = await mcp.callTool(workspaceId, name, args, { leadId: lid });
      } catch (e) {
        outcome = { ok: false, error: e.message || String(e) };
      }

      if (!outcome || outcome.ok === false) {
        consecutiveToolErrors.n++;
      } else {
        consecutiveToolErrors.n = 0;
        if (PORTAL_MUTATE_TOOLS.has(name)) mutated = true;
        if (name === 'site.publish') published = true;
      }

      const compact = JSON.stringify(outcome);
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: compact.length > 24000 ? compact.slice(0, 24000) + '…[truncated]' : compact,
      });
    }

    if (consecutiveToolErrors.n >= 8) {
      lastError = 'repeated_tool_errors';
      break;
    }
  }

  if (mutated && !published) {
    try {
      const pub = await mcp.callTool(workspaceId, 'site.publish', { leadId: lid }, { leadId: lid });
      if (pub && pub.ok !== false) published = true;
    } catch (e) {
      console.warn('[museAgent] portal auto-publish:', e.message || e);
    }
  }

  if (!finalReply) {
    finalReply = mutated
      ? 'Done — I updated your site. Check the preview on the right.'
      : (lastError
        ? 'I could not finish that change. Try rephrasing, or use Edit for a quick text tweak.'
        : 'I looked at your site but did not apply a change. Try a more specific request.');
  }

  return {
    ok: !lastError || mutated,
    reply: finalReply.slice(0, 4000),
    steps,
    toolCalls,
    mutated,
    published,
    error: lastError,
    costUsd: totalCost,
    model: config.model,
  };
}

module.exports = {
  resolveMuseConfig,
  museConfigured,
  runJobLoop,
  runPortalImproveLoop,
  DENY_TOOLS,
  MAX_STEPS,
  MAX_PORTAL_STEPS,
};
