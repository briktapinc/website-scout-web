'use strict';

const domain = require('./domain');
const jobs = require('./jobs');
const { createWorkspaceToken } = require('./workspace');

const SERVER_INFO = { name: 'website-scout-web-mcp', version: '0.2.0' };
const PROTOCOL_VERSION = '2025-11-25';

function toolDefs() {
  return [
    { name: 'lead.search', description: 'Search leads.', inputSchema: { type: 'object', properties: { q: { type: 'string' }, status: { type: 'string' }, minScore: { type: 'integer' }, limit: { type: 'integer' } } } },
    { name: 'lead.get', description: 'Get one lead with facts/scores.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'lead.create', description: 'Create a lead.', inputSchema: { type: 'object', properties: { business_name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, city: { type: 'string' }, category: { type: 'string' }, website: { type: 'string' }, status: { type: 'string' }, notes: { type: 'string' } }, required: ['business_name'] } },
    { name: 'lead.update', description: 'Update a lead.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'lead.delete', description: 'Delete a lead.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'lead.qualify', description: 'Qualify a lead.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'lead.score', description: 'Score a lead.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'lead.research', description: 'Research a lead.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'lead.discover', description: 'Discover leads via providers.', inputSchema: { type: 'object', properties: { category: { type: 'string' }, location: { type: 'string' }, limit: { type: 'integer' }, provider: { type: 'string' }, group: { type: 'string' } } } },
    { name: 'lead.importCsv', description: 'Import CSV text.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, group: { type: 'string' } }, required: ['text'] } },
    { name: 'lead.merge', description: 'Merge duplicate leads.', inputSchema: { type: 'object', properties: { keepId: { type: 'integer' }, dropIds: { type: 'array', items: { type: 'integer' } } }, required: ['keepId', 'dropIds'] } },
    { name: 'lead.duplicates', description: 'Find duplicates for a lead.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'lead.facets', description: 'Lead filter facets.', inputSchema: { type: 'object', properties: {} } },
    { name: 'lead.bulk', description: 'Bulk lead actions.', inputSchema: { type: 'object', properties: { action: { type: 'string' }, ids: { type: 'array', items: { type: 'integer' } }, value: { type: 'string' } }, required: ['action', 'ids'] } },
    { name: 'design.pending', description: 'Jobs waiting on agent.', inputSchema: { type: 'object', properties: {} } },
    { name: 'design.next', description: 'Claim next waiting_on_agent job.', inputSchema: { type: 'object', properties: {} } },
    { name: 'design.list', description: 'List design jobs.', inputSchema: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'integer' } } } },
    { name: 'design.get', description: 'Get design job.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'design.create', description: 'Create design job.', inputSchema: { type: 'object', properties: { type: { type: 'string' }, title: { type: 'string' }, instructions: { type: 'string' }, leadId: { type: 'integer' } }, required: ['title', 'instructions'] } },
    { name: 'design.deliver', description: 'Deliver design payload.', inputSchema: { type: 'object', properties: { id: { type: 'integer' }, payload: { type: 'object' }, claims: { type: 'array' } }, required: ['id', 'payload'] } },
    { name: 'design.ask', description: 'Ask clarifying question.', inputSchema: { type: 'object', properties: { id: { type: 'integer' }, question: { type: 'string' } }, required: ['id', 'question'] } },
    { name: 'design.review', description: 'Review delivered website (no screenshots on web).', inputSchema: { type: 'object', properties: { id: { type: 'integer' }, skipAi: { type: 'boolean' } }, required: ['id'] } },
    { name: 'design.redesign', description: 'Queue full redesign.', inputSchema: { type: 'object', properties: { id: { type: 'integer' }, instructions: { type: 'string' } }, required: ['id'] } },
    { name: 'design.improve', description: 'Queue incremental improvements.', inputSchema: { type: 'object', properties: { id: { type: 'integer' }, instructions: { type: 'string' } }, required: ['id'] } },
    { name: 'design.previewUrl', description: 'HTTP preview URL for delivered site.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'website.list', description: 'List websites.', inputSchema: { type: 'object', properties: { status: { type: 'string' } } } },
    { name: 'website.get', description: 'Get website.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'website.generate', description: 'Generate template website for lead.', inputSchema: { type: 'object', properties: { leadId: { type: 'integer' }, force: { type: 'boolean' } }, required: ['leadId'] } },
    { name: 'website.qa', description: 'QA a website.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'website.export', description: 'Export website HTML.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'outreach.campaigns', description: 'Campaign admin list|create|setStatus|messages.', inputSchema: { type: 'object', properties: { action: { type: 'string' }, id: { type: 'integer' }, name: { type: 'string' }, templateId: { type: 'integer' }, leadIds: { type: 'array', items: { type: 'integer' } }, status: { type: 'string' } }, required: ['action'] } },
    { name: 'outreach.templates', description: 'Template list|save|delete.', inputSchema: { type: 'object', properties: { action: { type: 'string' }, id: { type: 'integer' }, name: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['action'] } },
    { name: 'outreach.processQueue', description: 'Process email queue.', inputSchema: { type: 'object', properties: {} } },
    { name: 'outreach.stats', description: 'Outreach stats.', inputSchema: { type: 'object', properties: {} } },
    { name: 'outreach.pipeline', description: 'Pipeline board.', inputSchema: { type: 'object', properties: {} } },
    { name: 'email.compose', description: 'Compose from template.', inputSchema: { type: 'object', properties: { leadId: { type: 'integer' }, templateId: { type: 'integer' } }, required: ['leadId', 'templateId'] } },
    { name: 'settings.get', description: 'Read settings (secrets redacted).', inputSchema: { type: 'object', properties: {} } },
    { name: 'settings.set', description: 'Set non-secret setting.', inputSchema: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] } },
    { name: 'automation.pause', description: 'Pause automation.', inputSchema: { type: 'object', properties: {} } },
    { name: 'automation.resume', description: 'Resume automation.', inputSchema: { type: 'object', properties: {} } },
    { name: 'analytics.get', description: 'Dashboard stats.', inputSchema: { type: 'object', properties: {} } },
    { name: 'discovery.schedule', description: 'get|set|runNow discovery schedule.', inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } },
    { name: 'cloudflare.publish', description: 'Publish site to Cloudflare Pages.', inputSchema: { type: 'object', properties: { websiteId: { type: 'integer' } }, required: ['websiteId'] } },
    { name: 'cloudflare.test', description: 'Test Cloudflare credentials.', inputSchema: { type: 'object', properties: {} } },
    { name: 'jobs.list', description: 'List scheduled jobs.', inputSchema: { type: 'object', properties: {} } },
    { name: 'jobs.create', description: 'Create scheduled job.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' }, interval_minutes: { type: 'integer' }, payload: { type: 'object' } }, required: ['name', 'type'] } },
    { name: 'jobs.update', description: 'Update job.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'jobs.delete', description: 'Delete job.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'jobs.runNow', description: 'Run job now.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
  ];
}

async function callTool(workspaceId, name, args = {}) {
  const a = args || {};
  const ws = workspaceId;

  try {
    if (name === 'lead.search') return { ok: true, data: domain.leadsList(ws, a) };
    if (name === 'lead.get') {
      const data = domain.leadsGet(ws, a.id);
      if (!data) return { ok: false, error: 'NOT_FOUND' };
      return { ok: true, data };
    }
    if (name === 'lead.create') return { ok: true, data: { lead: domain.leadsCreate(ws, a) } };
    if (name === 'lead.update') {
      const { id, ...patch } = a;
      return { ok: true, data: { lead: domain.leadsUpdate(ws, id, patch) } };
    }
    if (name === 'lead.delete') { domain.leadsDelete(ws, a.id); return { ok: true, data: { id: a.id } }; }
    if (name === 'lead.qualify') return { ok: true, data: { lead: domain.leadsQualify(ws, a.id) } };
    if (name === 'lead.score') return { ok: true, data: domain.leadsScore(ws, a.id) };
    if (name === 'lead.research') return { ok: true, data: await domain.leadsResearch(ws, a.id) };
    if (name === 'lead.discover') return { ok: true, data: await domain.leadsDiscover(ws, a) };
    if (name === 'lead.importCsv') return { ok: true, data: domain.leadsImportCsv(ws, a.text, a) };
    if (name === 'lead.merge') return { ok: true, data: { lead: domain.leadsMerge(ws, a.keepId, a.dropIds) } };
    if (name === 'lead.duplicates') return { ok: true, data: { duplicates: domain.leadsDuplicates(ws, a.id) } };
    if (name === 'lead.facets') return { ok: true, data: { facets: domain.leadsFacets(ws) } };
    if (name === 'lead.bulk') return { ok: true, data: { bulk: await domain.leadsBulk(ws, a) } };

    if (name === 'design.pending') return { ok: true, data: domain.designPending(ws) };
    if (name === 'design.next') return { ok: true, data: { job: domain.designNext(ws) } };
    if (name === 'design.list') return { ok: true, data: { jobs: domain.designList(ws, a) } };
    if (name === 'design.get') return { ok: true, data: { job: domain.designGet(ws, a.id) } };
    if (name === 'design.create') return { ok: true, data: { job: domain.designCreate(ws, a) } };
    if (name === 'design.deliver') return { ok: true, data: { job: domain.designDeliver(ws, a.id, a.payload, a.claims, a) } };
    if (name === 'design.ask') return { ok: true, data: domain.designAsk(ws, a.id, a.question) };
    if (name === 'design.review') return { ok: true, data: await domain.designReview(ws, a.id, a) };
    if (name === 'design.redesign') return { ok: true, data: await domain.designRedesign(ws, a.id, a) };
    if (name === 'design.improve') return { ok: true, data: await domain.designImprove(ws, a.id, a) };
    if (name === 'design.previewUrl') return { ok: true, data: await domain.designPreviewUrl(ws, a.id, false) };

    if (name === 'website.list') return { ok: true, data: domain.sitesList(ws, a) };
    if (name === 'website.get') return { ok: true, data: { site: domain.sitesGet(ws, a.id) } };
    if (name === 'website.generate') return { ok: true, data: await domain.sitesGenerate(ws, a.leadId, a) };
    if (name === 'website.qa') return { ok: true, data: await domain.sitesQa(ws, a.id) };
    if (name === 'website.export') return { ok: true, data: domain.sitesExport(ws, a.id) };

    if (name === 'outreach.campaigns') {
      if (a.action === 'list') return { ok: true, data: domain.campaignsList(ws, a) };
      if (a.action === 'create') return { ok: true, data: domain.campaignsCreate(ws, a) };
      if (a.action === 'setStatus') return { ok: true, data: domain.campaignsSetStatus(ws, a.id, a.status) };
      if (a.action === 'messages') return { ok: true, data: domain.campaignsMessages(ws, a.id, a) };
      return { ok: false, error: 'Unknown campaigns action' };
    }
    if (name === 'outreach.templates') {
      if (a.action === 'list') return { ok: true, data: { templates: domain.templatesList(ws) } };
      if (a.action === 'save') return { ok: true, data: domain.templatesSave(ws, a) };
      if (a.action === 'delete') return { ok: true, data: domain.templatesDelete(ws, a.id) };
      return { ok: false, error: 'Unknown templates action' };
    }
    if (name === 'outreach.processQueue') return { ok: true, data: await domain.outreachProcessQueue(ws) };
    if (name === 'outreach.stats') return { ok: true, data: domain.outreachStats(ws) };
    if (name === 'outreach.pipeline') return { ok: true, data: domain.pipelineBoard(ws, a) };
    if (name === 'email.compose') return { ok: true, data: domain.emailCompose(ws, a.leadId, a.templateId) };

    if (name === 'settings.get') return { ok: true, data: { settings: domain.settingsGetAll(ws) } };
    if (name === 'settings.set') return { ok: true, data: domain.settingsSet(ws, a.key, a.value) };
    if (name === 'automation.pause') return { ok: true, data: domain.automationSet(ws, true) };
    if (name === 'automation.resume') return { ok: true, data: domain.automationSet(ws, false) };
    if (name === 'analytics.get') return { ok: true, data: domain.dashboardStats(ws) };

    if (name === 'discovery.schedule') {
      if (a.action === 'get') return { ok: true, data: domain.discoveryGet(ws) };
      if (a.action === 'set') return { ok: true, data: { schedule: domain.discoverySet(ws, a) } };
      if (a.action === 'runNow') return { ok: true, data: await domain.discoveryRunNow(ws) };
      return { ok: false, error: 'Unknown discovery action' };
    }
    if (name === 'cloudflare.publish') return { ok: true, data: await domain.cfPublish(ws, a.websiteId, a.dir) };
    if (name === 'cloudflare.test') return { ok: true, data: await domain.cfTest(ws) };

    if (name === 'jobs.list') return { ok: true, data: { jobs: await jobs.listJobs(ws), types: jobs.JOB_TYPES } };
    if (name === 'jobs.create') return { ok: true, data: { job: await jobs.createJob(ws, a) } };
    if (name === 'jobs.update') return { ok: true, data: { job: await jobs.updateJob(ws, a.id, a) } };
    if (name === 'jobs.delete') return { ok: true, data: await jobs.deleteJob(ws, a.id) };
    if (name === 'jobs.runNow') return { ok: true, data: await jobs.executeJob(ws, a.id, { force: true }) };

    return { ok: false, error: `Unknown tool: ${name}` };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
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
      return reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    if (req.method === 'notifications/initialized' || req.method === 'initialized') return null;
    if (req.method === 'ping') return reply({});
    if (req.method === 'tools/list') {
      return reply({ tools: toolDefs().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    }
    if (req.method === 'tools/call') {
      const outcome = await callTool(workspaceId, req.params && req.params.name, (req.params && req.params.arguments) || {});
      return reply({ content: [{ type: 'text', text: JSON.stringify(outcome) }], isError: !outcome.ok });
    }
    return reply(null, { code: -32601, message: `Method not found: ${req.method}` });
  } catch (e) {
    return reply(null, { code: -32000, message: e.message || String(e) });
  }
}

module.exports = { handleJsonRpc, callTool, toolDefs, SERVER_INFO, createWorkspaceToken };
