'use strict';

const { query } = require('./db');
const { getSetting, setSetting, logActivity, createWorkspaceToken } = require('./workspace');
const { SECRET_KEYS, SETTABLE_KEYS } = require('./settingsKeys');
const jobs = require('./jobs');

const SERVER_INFO = { name: 'website-scout-web-mcp', version: '0.1.0' };
const PROTOCOL_VERSION = '2025-11-25';

function toolDefs() {
  return [
    { name: 'lead.search', description: 'Search leads in this workspace.', inputSchema: { type: 'object', properties: { q: { type: 'string' }, status: { type: 'string' }, limit: { type: 'integer' } } } },
    { name: 'lead.get', description: 'Get one lead by id.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'lead.create', description: 'Create a lead.', inputSchema: { type: 'object', properties: { business_name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, city: { type: 'string' }, category: { type: 'string' }, website: { type: 'string' }, status: { type: 'string' }, notes: { type: 'string' } }, required: ['business_name'] } },
    { name: 'lead.qualify', description: 'Mark lead qualified.', inputSchema: { type: 'object', properties: { id: { type: 'integer' }, note: { type: 'string' } }, required: ['id'] } },
    { name: 'lead.score', description: 'Score a lead.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'design.pending', description: 'Design jobs waiting on agent.', inputSchema: { type: 'object', properties: {} } },
    { name: 'design.next', description: 'Claim next waiting_on_agent job.', inputSchema: { type: 'object', properties: {} } },
    { name: 'design.create', description: 'Create a design job.', inputSchema: { type: 'object', properties: { type: { type: 'string' }, title: { type: 'string' }, instructions: { type: 'string' }, leadId: { type: 'integer' } }, required: ['title', 'instructions'] } },
    { name: 'design.deliver', description: 'Deliver design payload.', inputSchema: { type: 'object', properties: { id: { type: 'integer' }, payload: { type: 'object' } }, required: ['id', 'payload'] } },
    { name: 'settings.get', description: 'Read workspace settings (secrets redacted).', inputSchema: { type: 'object', properties: {} } },
    { name: 'settings.set', description: 'Set a non-secret setting.', inputSchema: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] } },
    { name: 'automation.pause', description: 'Pause automation.', inputSchema: { type: 'object', properties: {} } },
    { name: 'automation.resume', description: 'Resume automation.', inputSchema: { type: 'object', properties: {} } },
    { name: 'analytics.get', description: 'Dashboard stats.', inputSchema: { type: 'object', properties: {} } },
    { name: 'jobs.list', description: 'List scheduled jobs.', inputSchema: { type: 'object', properties: {} } },
    { name: 'jobs.create', description: 'Create a scheduled job (discovery, outreach_process, design_poll_notify, custom).', inputSchema: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' }, interval_minutes: { type: 'integer' }, cron_expr: { type: 'string' }, payload: { type: 'object' }, enabled: { type: 'boolean' } }, required: ['name', 'type'] } },
    { name: 'jobs.update', description: 'Update a scheduled job.', inputSchema: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, enabled: { type: 'boolean' }, interval_minutes: { type: 'integer' }, payload: { type: 'object' } }, required: ['id'] } },
    { name: 'jobs.delete', description: 'Delete a scheduled job.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'jobs.runNow', description: 'Run a scheduled job immediately.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
  ];
}

async function callTool(workspaceId, name, args = {}) {
  const a = args || {};

  if (name === 'lead.search') {
    const limit = Math.min(100, Math.max(1, Number(a.limit) || 20));
    const params = { workspaceId };
    let where = 'workspace_id = :workspaceId';
    if (a.status) { where += ' AND status = :status'; params.status = a.status; }
    if (a.q) { where += ' AND (business_name LIKE :q OR email LIKE :q OR city LIKE :q)'; params.q = `%${a.q}%`; }
    const leads = await query(`SELECT id, business_name, category, city, email, status, score, updated_at FROM leads WHERE ${where} ORDER BY updated_at DESC LIMIT ${limit}`, params);
    return { ok: true, data: { leads } };
  }

  if (name === 'lead.get') {
    const lead = (await query('SELECT * FROM leads WHERE id = :id AND workspace_id = :workspaceId', { id: a.id, workspaceId }))[0];
    if (!lead) return { ok: false, error: 'NOT_FOUND' };
    return { ok: true, data: { lead } };
  }

  if (name === 'lead.create') {
    await query(
      `INSERT INTO leads (workspace_id, business_name, category, phone, email, website, city, status, notes, source)
       VALUES (:workspaceId, :business_name, :category, :phone, :email, :website, :city, :status, :notes, 'mcp')`,
      {
        workspaceId,
        business_name: a.business_name,
        category: a.category || null,
        phone: a.phone || null,
        email: a.email || null,
        website: a.website || null,
        city: a.city || null,
        status: a.status || 'new',
        notes: a.notes || null,
      }
    );
    const lead = (await query('SELECT * FROM leads WHERE workspace_id = :workspaceId ORDER BY id DESC LIMIT 1', { workspaceId }))[0];
    return { ok: true, data: { lead } };
  }

  if (name === 'lead.qualify') {
    await query(
      `UPDATE leads SET qualified = 1, status = 'qualified', qualification_note = :note
       WHERE id = :id AND workspace_id = :workspaceId`,
      { id: a.id, workspaceId, note: a.note || null }
    );
    return { ok: true, data: { id: a.id, qualified: true } };
  }

  if (name === 'lead.score') {
    // reuse scoring via HTTP route logic would be cleaner; inline simple score
    const lead = (await query('SELECT * FROM leads WHERE id = :id AND workspace_id = :workspaceId', { id: a.id, workspaceId }))[0];
    if (!lead) return { ok: false, error: 'NOT_FOUND' };
    let score = 20;
    if (lead.email) score += 15;
    if (lead.phone) score += 10;
    if (lead.website) score += 10;
    if (lead.city) score += 5;
    score = Math.min(100, score);
    await query('UPDATE leads SET score = :score WHERE id = :id AND workspace_id = :workspaceId', { score, id: a.id, workspaceId });
    return { ok: true, data: { id: a.id, score } };
  }

  if (name === 'design.pending') {
    const waiting = await query(
      `SELECT id, type, title, status, updated_at FROM design_jobs
       WHERE workspace_id = :workspaceId AND status IN ('waiting_on_agent','questions_pending')
       ORDER BY updated_at ASC LIMIT 50`,
      { workspaceId }
    );
    return {
      ok: true,
      data: {
        total: waiting.length,
        counts: {
          waiting_on_agent: waiting.filter((j) => j.status === 'waiting_on_agent').length,
          questions_pending: waiting.filter((j) => j.status === 'questions_pending').length,
        },
        preview: waiting.slice(0, 10),
      },
    };
  }

  if (name === 'design.next') {
    const rows = await query(
      `SELECT * FROM design_jobs WHERE workspace_id = :workspaceId AND status = 'waiting_on_agent' ORDER BY updated_at ASC LIMIT 1`,
      { workspaceId }
    );
    if (!rows[0]) return { ok: true, data: { job: null } };
    await query(`UPDATE design_jobs SET status = 'in_progress' WHERE id = :id AND workspace_id = :workspaceId`, { id: rows[0].id, workspaceId });
    rows[0].status = 'in_progress';
    return { ok: true, data: { job: rows[0] } };
  }

  if (name === 'design.create') {
    await query(
      `INSERT INTO design_jobs (workspace_id, lead_id, type, title, instructions, status)
       VALUES (:workspaceId, :leadId, :type, :title, :instructions, 'waiting_on_agent')`,
      {
        workspaceId,
        leadId: a.leadId || null,
        type: a.type || 'website',
        title: a.title,
        instructions: a.instructions,
      }
    );
    const job = (await query('SELECT * FROM design_jobs WHERE workspace_id = :workspaceId ORDER BY id DESC LIMIT 1', { workspaceId }))[0];
    return { ok: true, data: { job } };
  }

  if (name === 'design.deliver') {
    await query(
      `UPDATE design_jobs SET status = 'delivered', delivery = CAST(:delivery AS JSON)
       WHERE id = :id AND workspace_id = :workspaceId`,
      { id: a.id, workspaceId, delivery: JSON.stringify(a.payload) }
    );
    return { ok: true, data: { id: a.id, status: 'delivered' } };
  }

  if (name === 'settings.get') {
    const rows = await query('SELECT `key`, value FROM workspace_settings WHERE workspace_id = :workspaceId', { workspaceId });
    const settings = {};
    for (const r of rows) settings[r.key] = SECRET_KEYS.includes(r.key) && r.value ? '***' : r.value;
    return { ok: true, data: { settings } };
  }

  if (name === 'settings.set') {
    if (!SETTABLE_KEYS.includes(a.key)) return { ok: false, error: 'KEY_NOT_SETTABLE' };
    await setSetting(workspaceId, a.key, a.value);
    return { ok: true, data: { key: a.key, value: a.value } };
  }

  if (name === 'automation.pause') {
    await setSetting(workspaceId, 'automation_paused', '1');
    await logActivity(workspaceId, 'automation', 'Automation PAUSED via MCP');
    return { ok: true, data: { paused: true } };
  }

  if (name === 'automation.resume') {
    await setSetting(workspaceId, 'automation_paused', '0');
    await logActivity(workspaceId, 'automation', 'Automation RESUMED via MCP');
    return { ok: true, data: { paused: false } };
  }

  if (name === 'analytics.get') {
    const leadsTotal = (await query('SELECT COUNT(*) AS c FROM leads WHERE workspace_id = :workspaceId', { workspaceId }))[0].c;
    const waiting = (await query(`SELECT COUNT(*) AS c FROM design_jobs WHERE workspace_id = :workspaceId AND status = 'waiting_on_agent'`, { workspaceId }))[0].c;
    const jobsEnabled = (await query('SELECT COUNT(*) AS c FROM scheduled_jobs WHERE workspace_id = :workspaceId AND enabled = 1', { workspaceId }))[0].c;
    return {
      ok: true,
      data: {
        leadsTotal: Number(leadsTotal),
        designJobsWaitingOnAgent: Number(waiting),
        jobsEnabled: Number(jobsEnabled),
        automationPaused: (await getSetting(workspaceId, 'automation_paused', '0')) === '1',
      },
    };
  }

  if (name === 'jobs.list') {
    return { ok: true, data: { jobs: await jobs.listJobs(workspaceId), types: jobs.JOB_TYPES } };
  }
  if (name === 'jobs.create') {
    return { ok: true, data: { job: await jobs.createJob(workspaceId, a) } };
  }
  if (name === 'jobs.update') {
    return { ok: true, data: { job: await jobs.updateJob(workspaceId, a.id, a) } };
  }
  if (name === 'jobs.delete') {
    return { ok: true, data: await jobs.deleteJob(workspaceId, a.id) };
  }
  if (name === 'jobs.runNow') {
    return { ok: true, data: await jobs.executeJob(workspaceId, a.id, { force: true }) };
  }

  return { ok: false, error: `Unknown tool: ${name}` };
}

async function handleJsonRpc(workspaceId, body) {
  const req = typeof body === 'string' ? JSON.parse(body) : body;
  const id = Object.prototype.hasOwnProperty.call(req, 'id') ? req.id : undefined;
  const isNotification = id === undefined;

  const reply = (result, error) => {
    if (isNotification) return null;
    if (error) return { jsonrpc: '2.0', id, error };
    return { jsonrpc: '2.0', id, result };
  };

  try {
    if (req.method === 'initialize') {
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    if (req.method === 'notifications/initialized' || req.method === 'initialized') {
      return null;
    }
    if (req.method === 'ping') return reply({});
    if (req.method === 'tools/list') {
      return reply({ tools: toolDefs().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    }
    if (req.method === 'tools/call') {
      const name = req.params && req.params.name;
      const args = (req.params && req.params.arguments) || {};
      const outcome = await callTool(workspaceId, name, args);
      const text = JSON.stringify(outcome);
      return reply({
        content: [{ type: 'text', text }],
        isError: !outcome.ok,
      });
    }
    return reply(null, { code: -32601, message: `Method not found: ${req.method}` });
  } catch (e) {
    return reply(null, { code: -32000, message: e.message || String(e) });
  }
}

module.exports = { handleJsonRpc, callTool, toolDefs, SERVER_INFO, createWorkspaceToken };
