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
    { name: 'email.compose', description: 'Compose from template. Pass queue:true to persist as a queued message (returns messageId for email.send).', inputSchema: { type: 'object', properties: { leadId: { type: 'integer' }, templateId: { type: 'integer' }, queue: { type: 'boolean' } }, required: ['leadId', 'templateId'] } },
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
    ...parityToolDefs(),
  ];
}

const ID = { type: 'integer', minimum: 1 };
const STR = { type: 'string' };
function schema(properties = {}, required = []) {
  return required.length ? { type: 'object', properties, required } : { type: 'object', properties };
}

/** Tools added for Electron IPC / stdio-MCP parity. */
function parityToolDefs() {
  return [
    { name: 'lead.addFact', description: 'Add a business fact to a lead (claim_class e.g. VERIFIED / OWNER_PROVIDED / INFERRED).', inputSchema: schema({ id: ID, fact_key: STR, value: STR, source: STR, source_url: STR, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, claim_class: STR }, ['id', 'fact_key', 'value', 'source', 'claim_class']) },
    { name: 'lead.timeline', description: 'Merged lead/prospect/email event timeline for a lead.', inputSchema: schema({ id: ID, limit: { type: 'integer' } }, ['id']) },
    { name: 'prospect.score', description: "Lead's score with Hot/Qualified/Cold label from current thresholds.", inputSchema: schema({ leadId: ID }, ['leadId']) },

    { name: 'website.create', description: 'Open a website design job for the agent (default). Pass mode "template" to generate a template site immediately.', inputSchema: schema({ leadId: ID, site_shape: { type: 'string', enum: ['landing', 'multipage'] }, siteShape: { type: 'string', enum: ['landing', 'multipage'] }, mode: { type: 'string', enum: ['agent', 'template'] }, instructions: STR, force: { type: 'boolean' } }, ['leadId']) },
    { name: 'website.preview', description: 'Export a website and return a localhost preview URL + path.', inputSchema: schema({ id: ID, open: { type: 'boolean' } }, ['id']) },
    { name: 'website.edit', description: 'Edit a website. Pass pages (+theme, note) for a full validated save, or instruction for a safe structural edit (primary colour, rename, add section, phone).', inputSchema: schema({ id: ID, pages: { type: 'array' }, theme: { type: 'object' }, note: STR, instruction: STR }, ['id']) },
    { name: 'website.forLead', description: 'Get the website for a lead (or null).', inputSchema: schema({ leadId: ID }, ['leadId']) },
    { name: 'website.addImages', description: 'Attach Pexels photos to a website.', inputSchema: schema({ id: ID, query: STR, count: { type: 'integer', minimum: 1, maximum: 6 } }, ['id']) },
    { name: 'website.versions', description: 'List saved versions of a website.', inputSchema: schema({ id: ID, page: { type: 'integer' }, pageSize: { type: 'integer' } }, ['id']) },
    { name: 'website.restore', description: 'Restore a website version.', inputSchema: schema({ versionId: ID }, ['versionId']) },
    { name: 'website.render', description: 'Render website (by id) or supplied pages/theme to HTML.', inputSchema: schema({ id: ID, pages: { type: 'array' }, theme: { type: 'object' }, pageSlug: STR, pageIndex: { type: 'integer' }, editable: { type: 'boolean' } }) },

    { name: 'design.answers', description: 'Read questions and user answers for a design job.', inputSchema: schema({ id: ID }, ['id']) },
    { name: 'design.emailQuestions', description: 'Queue unanswered questions for one design job as an email. Does not send mail.', inputSchema: schema({ id: ID, jobId: ID }) },
    { name: 'design.emailDelivery', description: 'Queue the delivery email for a design job. Does not send mail.', inputSchema: schema({ id: ID, jobId: ID }) },
    { name: 'design.setContact', description: 'Set the contact email on a design job.', inputSchema: schema({ id: ID, email: STR }, ['id', 'email']) },
    { name: 'design.recordReply', description: 'Record a customer email reply on a design job (answers open questions).', inputSchema: schema({ id: ID, jobId: ID, reply: STR, fromEmail: STR }, ['reply']) },
    { name: 'design.images', description: 'Attach Pexels photos to a delivered design website.', inputSchema: schema({ id: ID, query: STR, count: { type: 'integer', minimum: 1, maximum: 6 } }, ['id']) },
    { name: 'design.generateImage', description: 'Generate images via OpenAI Images API and attach to a design job.', inputSchema: schema({ id: ID, prompt: STR, n: { type: 'integer', minimum: 1, maximum: 4 }, size: STR, quality: STR, model: STR }, ['id']) },
    { name: 'design.openPreview', description: 'Export a delivered website and return its localhost preview url + path (server never opens a browser unless open:true).', inputSchema: schema({ id: ID, open: { type: 'boolean' } }, ['id']) },
    { name: 'design.emailRedesign', description: 'Inbound email redesign/improvement requests: list|get|ingest|submit|dismiss|scan.', inputSchema: schema({ action: { type: 'string', enum: ['list', 'get', 'ingest', 'submit', 'dismiss', 'scan'] }, id: ID, requestId: ID, jobId: ID, designJobId: ID, leadId: ID, fromEmail: STR, subject: STR, body: STR, reply: STR, requestKind: STR, force: { type: 'boolean' }, instructions: STR, status: STR, pendingOnly: { type: 'boolean' }, includeAll: { type: 'boolean' }, limit: { type: 'integer' } }, ['action']) },
    { name: 'design.lessons', description: 'Design learning: status|list|playbook|clear|distill.', inputSchema: schema({ action: { type: 'string', enum: ['status', 'list', 'playbook', 'clear', 'distill'] }, what: { type: 'string', enum: ['all', 'playbook', 'events'] }, jobId: ID, eventType: STR, limit: { type: 'integer', minimum: 1, maximum: 200 }, force: { type: 'boolean' } }) },
    { name: 'design.saveWebsite', description: 'Save an edited pages/theme payload onto a delivered design website.', inputSchema: schema({ id: ID, pages: { type: 'array' }, theme: { type: 'object' } }, ['id', 'pages']) },
    { name: 'design.removeDeliveryItem', description: 'Remove one delivered file/item (by path) from a design job.', inputSchema: schema({ id: ID, jobId: ID, path: STR }, ['path']) },
    { name: 'design.defaultInstructions', description: 'Default website design instructions.', inputSchema: schema({}) },

    { name: 'email.send', description: 'Send a queued message now. Respects suppression list, automation pause, and daily outreach cap.', inputSchema: schema({ messageId: ID }, ['messageId']) },
    { name: 'outreach.suppression', description: 'Suppression list: list|add|remove.', inputSchema: schema({ action: { type: 'string', enum: ['list', 'add', 'remove'] }, email: STR, reason: STR, id: ID, page: { type: 'integer' }, pageSize: { type: 'integer' } }, ['action']) },
    { name: 'outreach.intent', description: 'Prospect intent: get|record.', inputSchema: schema({ action: { type: 'string', enum: ['get', 'record'] }, leadId: ID, event: STR, note: STR }, ['action', 'leadId']) },

    { name: 'ai.usage', description: 'AI spend: today, month, by task and recent calls.', inputSchema: schema({ days: { type: 'integer', minimum: 1, maximum: 365 } }) },
    { name: 'prompts.list', description: 'List editable AI prompts.', inputSchema: schema({}) },
    { name: 'prompts.save', description: 'Save an AI prompt body, or restore the seed default with reset:true.', inputSchema: schema({ key: STR, body: STR, reset: { type: 'boolean' } }, ['key']) },
    { name: 'activity.recent', description: 'Recent activity log.', inputSchema: schema({ limit: { type: 'integer' }, page: { type: 'integer' }, pageSize: { type: 'integer' } }) },
  ];
}

/** Throws if automation kill switch is engaged (for AI / external-cost tools). */
function ensureNotPaused(workspaceId) {
  if (domain.withDb(workspaceId, (db) => domain.getSetting(db, 'automation_paused', '0')) === '1') {
    throw new Error('Automation is paused (kill switch). Resume it before running this tool.');
  }
}

function need(value, what) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${what} must be a positive integer.`);
  return n;
}

async function callParityTool(ws, name, a) {
  switch (name) {
    case 'lead.addFact': {
      const fact = domain.leadsAddFact(ws, need(a.id, 'id'), {
        fact_key: a.fact_key, value: a.value, source: a.source,
        source_url: a.source_url, confidence: a.confidence, claim_class: a.claim_class,
      });
      return { fact };
    }
    case 'lead.timeline': return { timeline: domain.leadsTimeline(ws, need(a.id, 'id'), { limit: a.limit }) };
    case 'prospect.score': return domain.prospectScore(ws, need(a.leadId, 'leadId'));

    case 'website.create': {
      const leadId = need(a.leadId, 'leadId');
      if (a.mode === 'template') return domain.sitesGenerate(ws, leadId, { force: !!a.force });
      const shape = a.site_shape != null ? a.site_shape : a.siteShape;
      const lead = domain.leadsGet(ws, leadId);
      if (!lead) throw new Error(`Lead ${leadId} not found.`);
      const job = domain.designCreate(ws, {
        type: 'website',
        leadId,
        site_shape: shape,
        title: `${lead.lead.business_name || 'Business'} website`,
        instructions: (a.instructions && String(a.instructions).trim()) || domain.designDefaultInstructions().website,
      });
      domain.withDb(ws, (db) => db.prepare('INSERT INTO lead_events (lead_id, type, detail) VALUES (?, ?, ?)')
        .run(leadId, 'site_assigned', `Design job #${job.id} assigned via MCP (agent-owned design, ${job.site_shape || 'multipage'})`));
      return { jobId: job.id, status: job.status, type: 'website', site_shape: job.site_shape };
    }
    case 'website.preview': return domain.sitesPreview(ws, need(a.id, 'id'), { open: !!a.open });
    case 'website.edit': {
      const id = need(a.id, 'id');
      if (a.pages != null) return domain.sitesSave(ws, id, { pages: a.pages, theme: a.theme, note: a.note });
      if (a.instruction != null) return domain.sitesApplyInstruction(ws, id, a.instruction);
      throw new Error('Provide pages (+theme) for a full save, or instruction for a safe structural edit.');
    }
    case 'website.forLead': return domain.sitesForLead(ws, need(a.leadId, 'leadId'));
    case 'website.addImages': return domain.sitesAddImages(ws, need(a.id, 'id'), { query: a.query, count: a.count });
    case 'website.versions': return domain.sitesVersions(ws, need(a.id, 'id'), a);
    case 'website.restore': return { site: domain.sitesRestore(ws, need(a.versionId, 'versionId')) };
    case 'website.render': return domain.sitesRenderHtml(ws, a.id != null ? need(a.id, 'id') : null, a);

    case 'design.answers': return domain.designListAnswers(ws, need(a.id, 'id'));
    case 'design.emailQuestions': return domain.designEmailQuestions(ws, need(a.jobId != null ? a.jobId : a.id, 'jobId'));
    case 'design.emailDelivery': return domain.designEmailDelivery(ws, need(a.jobId != null ? a.jobId : a.id, 'jobId'));
    case 'design.setContact': return { job: domain.designSetContact(ws, need(a.id, 'id'), a.email) };
    case 'design.recordReply': return { job: domain.designRecordReply(ws, need(a.id != null ? a.id : a.jobId, 'id'), a.reply, a.fromEmail) };
    case 'design.images': {
      ensureNotPaused(ws);
      return domain.designAddImages(ws, need(a.id, 'id'), { query: a.query, count: a.count });
    }
    case 'design.generateImage': {
      ensureNotPaused(ws);
      const r = await domain.designGenerateImages(ws, need(a.id, 'id'), { prompt: a.prompt, n: a.n, size: a.size, quality: a.quality, model: a.model });
      return { id: r.id, count: r.count, model: r.model, prompt: r.prompt, paths: r.paths };
    }
    case 'design.openPreview': return domain.designOpenPreview(ws, need(a.id, 'id'), { open: !!a.open });
    case 'design.emailRedesign': {
      const action = String(a.action || '').trim().toLowerCase();
      const reqId = a.id != null ? a.id : a.requestId;
      if (action === 'list') return domain.emailRedesignList(ws, { limit: a.limit, status: a.status, jobId: a.jobId, pendingOnly: a.pendingOnly, includeAll: a.includeAll });
      if (action === 'get') return domain.emailRedesignGet(ws, need(reqId, 'id'));
      if (action === 'ingest') {
        if (a.body == null && a.reply == null) throw new Error('body is required for ingest.');
        return domain.emailRedesignIngest(ws, { ...a, source: a.source || 'mcp' });
      }
      if (action === 'submit') return domain.emailRedesignSubmit(ws, need(reqId, 'id'), a);
      if (action === 'dismiss') return domain.emailRedesignDismiss(ws, need(reqId, 'id'));
      if (action === 'scan') return domain.emailRedesignScan(ws);
      throw new Error('action must be list, get, ingest, submit, dismiss, or scan.');
    }
    case 'design.lessons': {
      const action = String(a.action || 'status').trim().toLowerCase();
      if (action === 'status') return domain.learningStatus(ws);
      if (action === 'list') return domain.learningEvents(ws, { jobId: a.jobId, eventType: a.eventType, limit: a.limit });
      if (action === 'playbook') return domain.learningPlaybook(ws);
      if (action === 'clear') return domain.learningClear(ws, a.what || 'playbook');
      if (action === 'distill') return domain.learningDistill(ws, { force: !!a.force });
      throw new Error('action must be status, list, playbook, clear, or distill.');
    }
    case 'design.saveWebsite': return { job: domain.designSaveWebsite(ws, need(a.id, 'id'), a.pages, a.theme) };
    case 'design.removeDeliveryItem': return { job: domain.designRemoveDelivery(ws, need(a.id != null ? a.id : a.jobId, 'id'), a.path) };
    case 'design.defaultInstructions': return domain.designDefaultInstructions();

    case 'email.send': {
      ensureNotPaused(ws);
      return domain.emailSend(ws, need(a.messageId, 'messageId'));
    }
    case 'outreach.suppression': {
      if (a.action === 'list') return domain.suppressionList(ws, a);
      if (a.action === 'add') return domain.suppressionAdd(ws, a.email, a.reason);
      if (a.action === 'remove') return domain.suppressionRemove(ws, need(a.id, 'id'));
      throw new Error('Unknown suppression action (list|add|remove).');
    }
    case 'outreach.intent': {
      const leadId = need(a.leadId, 'leadId');
      if (a.action === 'get') return domain.intentGet(ws, leadId);
      if (a.action === 'record') return domain.intentRecord(ws, leadId, a.event, a.note);
      throw new Error('Unknown intent action (get|record).');
    }

    case 'ai.usage': return domain.aiUsage(ws, a.days != null ? Math.min(365, Math.max(1, Number(a.days) || 30)) : 30);
    case 'prompts.list': return { prompts: domain.promptsList(ws) };
    case 'prompts.save': {
      if (a.reset) return domain.promptsReset(ws, a.key);
      return domain.promptsSave(ws, a.key, a.body);
    }
    case 'activity.recent': return domain.activityRecent(ws, a);
    default: return undefined;
  }
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
    if (name === 'design.list') return { ok: true, data: domain.designList(ws, a) };
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
    if (name === 'email.compose') return { ok: true, data: domain.emailCompose(ws, a.leadId, a.templateId, { queue: !!a.queue }) };

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

    const parity = await callParityTool(ws, name, a);
    if (parity !== undefined) return { ok: true, data: parity };

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
