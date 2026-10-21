'use strict';

/**
 * Full product API — mirrors Electron app features (not Electron shell).
 * Muse agents: prefer this surface; MCP is the transport fallback (same core handlers).
 */

const express = require('express');
const domain = require('../domain');
const idempotency = require('../idempotency');
const {
  requireRole,
  requireTokenLeadScope,
  denyLeadScopedToken,
  pinTokenLeadFilter,
} = require('../middleware');

const router = express.Router();
// Workspace auth is applied at mount time in server.js (before paywall).

function ok(res, data) { res.json({ ok: true, data }); }
function fail(res, e, status = 400) {
  const code = e && e.code;
  let http = status;
  if (code === 'INSUFFICIENT_CREDITS') http = 402;
  else if (code === 'NOT_FOUND' || e.message === 'NOT_FOUND') http = 404;
  else if (code === 'FORBIDDEN' || code === 'LEAD_SCOPE') http = 403;
  else if (code === 'VALIDATION' || code === 'INVALID' || code === 'INVALID_PAGES' || code === 'SECTION_SCRIPT') http = 422;
  else if (code === 'CONFLICT' || code === 'FK_CONFLICT' || code === 'IDEMPOTENCY_CONFLICT') http = 409;
  else if (typeof e.status === 'number') http = e.status;
  else if (typeof code === 'number') http = code;
  const msg = (e && (e.message || e.detail)) || String(e);
  // FK / constraint → machine-readable 409 naming the referencing type when available.
  if (/FOREIGN KEY|SQLITE_CONSTRAINT/i.test(msg) && http < 400) http = 409;
  const errCode = typeof code === 'string' && code
    ? code
    : (/FOREIGN KEY/i.test(msg) ? 'FK_CONFLICT' : (http === 404 ? 'NOT_FOUND' : 'ERROR'));
  let message = msg;
  if (errCode === 'FK_CONFLICT' || /FOREIGN KEY/i.test(msg)) {
    const ref = e && e.references ? String(e.references) : null;
    message = ref
      ? `Delete blocked: referenced by ${ref}`
      : (msg.includes('referenced') ? msg : 'Delete blocked by a related record (foreign key)');
  }
  res.status(http >= 400 && http < 600 ? http : 400).json({
    ok: false,
    error: { code: errCode, message },
  });
}

/** Compact deliver receipt — never echo the full payload. */
function deliverReceipt(job) {
  if (!job) return { job_id: null, status: null, website_id: null, qa: { passed: false, checks_failed: [] } };
  const qaRaw = job.qa || job.qa_result || job.qaResult || null;
  let checksFailed = [];
  let passed = true;
  if (qaRaw && typeof qaRaw === 'object') {
    passed = qaRaw.passed !== false && qaRaw.ok !== false;
    const fails = qaRaw.checks_failed || qaRaw.failed || qaRaw.failures || [];
    if (Array.isArray(fails)) {
      checksFailed = fails.map((f) => (typeof f === 'string' ? f : (f && (f.name || f.check || f.message)) || String(f))).slice(0, 40);
    }
  } else if (Array.isArray(job.warnings) && job.warnings.length) {
    passed = true;
    checksFailed = [];
  }
  return {
    job_id: job.id != null ? Number(job.id) : null,
    status: job.status || null,
    website_id: job.website_id != null ? Number(job.website_id) : null,
    qa: { passed: !!passed, checks_failed: checksFailed },
    replayed: !!job._idempotency_replayed,
  };
}

async function withIdempotency(req, operation, body, run) {
  const key = idempotency.extractKey(req);
  if (!key) return run();
  const { openWorkspaceDb } = require('../workspaceDb');
  const db = openWorkspaceDb(req.auth.workspaceId);
  return idempotency.once(db, operation, key, body, run);
}

function numLead(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

const scopeLeadParam = requireTokenLeadScope((req) => numLead(req.params.id));
const scopeLeadIdParam = requireTokenLeadScope((req) => numLead(req.params.leadId));
const scopeBodyLead = requireTokenLeadScope((req) => numLead(req.body && req.body.leadId));
const scopeQueryLead = requireTokenLeadScope((req) => numLead(req.query && req.query.leadId));

function scopeWebsite(req, res, next) {
  if (!req.auth || req.auth.via !== 'token' || !req.auth.leadId) return next();
  try {
    const site = domain.sitesGet(req.auth.workspaceId, Number(req.params.id));
    if (!site || Number(site.lead_id) !== Number(req.auth.leadId)) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'LEAD_SCOPE' });
    }
    return next();
  } catch (e) { return fail(res, e); }
}

function scopeDesign(req, res, next) {
  if (!req.auth || req.auth.via !== 'token' || !req.auth.leadId) return next();
  try {
    const job = domain.designGet(req.auth.workspaceId, Number(req.params.id));
    const leadId = job && (job.lead_id != null ? job.lead_id : job.leadId);
    if (!job || Number(leadId) !== Number(req.auth.leadId)) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'LEAD_SCOPE' });
    }
    return next();
  } catch (e) { return fail(res, e); }
}

function scopeSocialCampaign(req, res, next) {
  if (!req.auth || req.auth.via !== 'token' || !req.auth.leadId) return next();
  try {
    const c = domain.socialCampaignGet(req.auth.workspaceId, Number(req.params.id));
    const leadId = c && (c.lead_id != null ? c.lead_id : c.leadId);
    if (!c || Number(leadId) !== Number(req.auth.leadId)) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'LEAD_SCOPE' });
    }
    return next();
  } catch (e) { return fail(res, e); }
}

function scopeSocialPost(req, res, next) {
  if (!req.auth || req.auth.via !== 'token' || !req.auth.leadId) return next();
  try {
    const db = require('../workspaceDb').openWorkspaceDb(req.auth.workspaceId);
    const row = db.prepare('SELECT lead_id FROM social_posts WHERE id = ?').get(Number(req.params.id));
    if (!row || Number(row.lead_id) !== Number(req.auth.leadId)) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'LEAD_SCOPE' });
    }
    return next();
  } catch (e) { return fail(res, e); }
}

function scopeSocialAccount(req, res, next) {
  if (!req.auth || req.auth.via !== 'token' || !req.auth.leadId) return next();
  try {
    const db = require('../workspaceDb').openWorkspaceDb(req.auth.workspaceId);
    const row = db.prepare('SELECT lead_id FROM social_accounts WHERE id = ?').get(Number(req.params.id));
    if (!row || Number(row.lead_id) !== Number(req.auth.leadId)) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'LEAD_SCOPE' });
    }
    return next();
  } catch (e) { return fail(res, e); }
}

// Dashboard
router.get('/dashboard/stats', denyLeadScopedToken, (req, res) => {
  try {
    const stats = domain.dashboardStats(req.auth.workspaceId);
    ok(res, {
      ...stats,
      workspace: {
        id: req.auth.workspaceId,
        name: req.auth.workspace.name,
        slug: req.auth.workspace.slug,
        role: req.auth.role,
      },
    });
  } catch (e) { fail(res, e, 500); }
});

// Leads
router.get('/leads', pinTokenLeadFilter, (req, res) => { try { ok(res, domain.leadsList(req.auth.workspaceId, req.query)); } catch (e) { fail(res, e); } });
router.get('/leads/facets', denyLeadScopedToken, (req, res) => { try { ok(res, { facets: domain.leadsFacets(req.auth.workspaceId) }); } catch (e) { fail(res, e); } });
router.get('/leads/:id', scopeLeadParam, (req, res) => {
  try {
    const data = domain.leadsGet(req.auth.workspaceId, Number(req.params.id));
    if (!data) return fail(res, Object.assign(new Error('NOT_FOUND'), { code: 404 }), 404);
    ok(res, data);
  } catch (e) { fail(res, e); }
});
router.post('/leads', denyLeadScopedToken, async (req, res) => {
  try {
    const body = req.body || {};
    const data = await withIdempotency(req, 'leads.create', body, async () => ({
      lead: domain.leadsCreate(req.auth.workspaceId, body),
    }));
    ok(res, data);
  } catch (e) { fail(res, e); }
});
router.patch('/leads/:id', scopeLeadParam, (req, res) => { try { ok(res, { lead: domain.leadsUpdate(req.auth.workspaceId, Number(req.params.id), req.body || {}) }); } catch (e) { fail(res, e); } });
router.delete('/leads/:id', scopeLeadParam, (req, res) => {
  try {
    domain.leadsDelete(req.auth.workspaceId, Number(req.params.id));
    ok(res, { id: Number(req.params.id) });
  } catch (e) {
    if (/FOREIGN KEY|SQLITE_CONSTRAINT/i.test(String(e && e.message || ''))) {
      e.code = e.code || 'FK_CONFLICT';
      e.status = 409;
      e.references = e.references || 'websites_or_design_jobs';
    }
    fail(res, e);
  }
});
router.post('/leads/:id/score', scopeLeadParam, (req, res) => { try { ok(res, domain.leadsScore(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e); } });
router.post('/leads/:id/qualify', scopeLeadParam, (req, res) => { try { ok(res, { lead: domain.leadsQualify(req.auth.workspaceId, Number(req.params.id), req.body && req.body.note) }); } catch (e) { fail(res, e); } });
router.post('/leads/:id/research', scopeLeadParam, async (req, res) => { try { ok(res, await domain.leadsResearch(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e, 500); } });
router.post('/leads/:id/facts', scopeLeadParam, (req, res) => { try { ok(res, { fact: domain.leadsAddFact(req.auth.workspaceId, Number(req.params.id), req.body || {}) }); } catch (e) { fail(res, e); } });
router.get('/leads/:id/timeline', scopeLeadParam, (req, res) => { try { ok(res, { timeline: domain.leadsTimeline(req.auth.workspaceId, Number(req.params.id), { limit: req.query.limit }) }); } catch (e) { fail(res, e); } });
router.get('/leads/:id/prospect-score', scopeLeadParam, (req, res) => { try { ok(res, domain.prospectScore(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e); } });
router.get('/leads/:id/duplicates', scopeLeadParam, (req, res) => { try { ok(res, { duplicates: domain.leadsDuplicates(req.auth.workspaceId, Number(req.params.id)) }); } catch (e) { fail(res, e); } });
/** Lead claim kit (URLs + QR). Pass ?pdf=1 to download postcard PDF when a site URL exists. */
router.get('/leads/:id/claim-kit', scopeLeadParam, async (req, res) => {
  try {
    const wantPdf = String(req.query.pdf || '') === '1' || String(req.query.pdf || '').toLowerCase() === 'true';
    const kit = await domain.leadsClaimKit(req.auth.workspaceId, Number(req.params.id), {
      websiteId: req.query.websiteId ? Number(req.query.websiteId) : undefined,
      includePdf: wantPdf,
    });
    if (wantPdf && kit.pdf) {
      const safeName = String(kit.filename || 'bitpype-postcard.pdf').replace(/[^\w.\-]+/g, '_');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      res.setHeader('Content-Length', String(kit.pdf.length));
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).end(kit.pdf);
    }
    const { pdf, ...rest } = kit;
    ok(res, rest);
  } catch (e) { fail(res, e, 500); }
});
router.post('/leads/merge', denyLeadScopedToken, (req, res) => { try { ok(res, { lead: domain.leadsMerge(req.auth.workspaceId, req.body.keepId, req.body.dropIds) }); } catch (e) { fail(res, e); } });
router.post('/leads/import', denyLeadScopedToken, (req, res) => { try { ok(res, domain.leadsImportCsv(req.auth.workspaceId, req.body.text, req.body)); } catch (e) { fail(res, e); } });
router.post('/leads/bulk', denyLeadScopedToken, async (req, res) => { try { ok(res, { bulk: await domain.leadsBulk(req.auth.workspaceId, req.body || {}) }); } catch (e) { fail(res, e); } });
router.post('/leads/discover', denyLeadScopedToken, async (req, res) => { try { ok(res, await domain.leadsDiscover(req.auth.workspaceId, req.body || {})); } catch (e) { fail(res, e, 500); } });

// Providers / discovery schedule
router.get('/providers', denyLeadScopedToken, (req, res) => { try { ok(res, { providers: domain.providersList(req.auth.workspaceId) }); } catch (e) { fail(res, e); } });
router.post('/providers/search', denyLeadScopedToken, async (req, res) => { try { ok(res, await domain.providersSearch(req.auth.workspaceId, req.body || {})); } catch (e) { fail(res, e, 500); } });
router.get('/discovery/schedule', denyLeadScopedToken, (req, res) => { try { ok(res, domain.discoveryGet(req.auth.workspaceId)); } catch (e) { fail(res, e); } });
router.put('/discovery/schedule', requireRole('owner', 'admin'), (req, res) => { try { ok(res, { schedule: domain.discoverySet(req.auth.workspaceId, req.body || {}) }); } catch (e) { fail(res, e); } });
router.post('/discovery/run', requireRole('owner', 'admin', 'member'), denyLeadScopedToken, async (req, res) => { try { ok(res, await domain.discoveryRunNow(req.auth.workspaceId)); } catch (e) { fail(res, e, 500); } });

// Hands-off Muse mode
router.get('/hands-off', denyLeadScopedToken, async (req, res) => {
  try { ok(res, await domain.handsOffStatus(req.auth.workspaceId)); } catch (e) { fail(res, e, 500); }
});
router.post('/hands-off/run', requireRole('owner', 'admin'), denyLeadScopedToken, async (req, res) => {
  try {
    const paused = domain.withDb(req.auth.workspaceId, (db) => domain.getSetting(db, 'automation_paused', '0')) === '1';
    if (paused) return ok(res, { skipped: true, reason: 'automation_paused' });
    ok(res, await domain.handsOffRunNow(req.auth.workspaceId, { force: !!(req.body && req.body.force) }));
  } catch (e) { fail(res, e, 500); }
});
router.post('/hands-off/digest', requireRole('owner', 'admin'), denyLeadScopedToken, async (req, res) => {
  try {
    ok(res, await domain.handsOffDigestNow(req.auth.workspaceId, { force: !!(req.body && req.body.force) }));
  } catch (e) { fail(res, e, 500); }
});

// Design
router.get('/design/pending', pinTokenLeadFilter, (req, res) => { try { ok(res, domain.designPending(req.auth.workspaceId, req.query)); } catch (e) { fail(res, e); } });
router.get('/design', pinTokenLeadFilter, (req, res) => { try { ok(res, domain.designList(req.auth.workspaceId, req.query)); } catch (e) { fail(res, e); } });
router.get('/design/default-instructions', (req, res) => { try { ok(res, domain.designDefaultInstructions()); } catch (e) { fail(res, e); } });

// Muse aliases: /design/jobs* (same handlers as /design*)
router.get('/design/jobs', pinTokenLeadFilter, (req, res) => { try { ok(res, domain.designList(req.auth.workspaceId, req.query)); } catch (e) { fail(res, e); } });
router.post('/design/jobs', pinTokenLeadFilter, scopeBodyLead, async (req, res) => {
  try {
    const body = req.body || {};
    const data = await withIdempotency(req, 'design.jobs.create', body, async () => ({
      job: domain.designCreate(req.auth.workspaceId, body),
    }));
    ok(res, data);
  } catch (e) { fail(res, e); }
});
router.get('/design/jobs/:id', scopeDesign, (req, res) => {
  try { ok(res, { job: domain.designGet(req.auth.workspaceId, Number(req.params.id)) }); }
  catch (e) { fail(res, e); }
});
router.post('/design/jobs/:id/deliver', scopeDesign, async (req, res) => {
  try {
    const b = req.body || {};
    const idemBody = { id: Number(req.params.id), payload: b.payload, claims: b.claims };
    const receipt = await withIdempotency(req, 'design.deliver', idemBody, async () => {
      const job = await domain.designDeliver(req.auth.workspaceId, Number(req.params.id), b.payload, b.claims, b);
      return deliverReceipt(job);
    });
    ok(res, receipt);
  } catch (e) { fail(res, e); }
});

// Design — inbound email redesign requests (also mounted at /email-redesign)
const ER = ['/design/email-redesign', '/email-redesign'];
const erPaths = (suffix = '') => ER.map((p) => `${p}${suffix}`);
router.get(erPaths(), denyLeadScopedToken, (req, res) => {
  try {
    const args = { ...req.query };
    if (args.pendingOnly != null) args.pendingOnly = args.pendingOnly === '1' || args.pendingOnly === 'true';
    if (args.includeAll != null) args.includeAll = args.includeAll === '1' || args.includeAll === 'true';
    ok(res, domain.emailRedesignList(req.auth.workspaceId, args));
  } catch (e) { fail(res, e); }
});
router.post(erPaths('/ingest'), denyLeadScopedToken, (req, res) => { try { ok(res, domain.emailRedesignIngest(req.auth.workspaceId, req.body || {})); } catch (e) { fail(res, e); } });
router.post(erPaths('/scan'), denyLeadScopedToken, (req, res) => { try { ok(res, domain.emailRedesignScan(req.auth.workspaceId)); } catch (e) { fail(res, e); } });
router.post(erPaths('/imap-poll'), denyLeadScopedToken, async (req, res) => {
  try { ok(res, await domain.imapPoll(req.auth.workspaceId, { force: true, ...(req.body || {}) })); }
  catch (e) { fail(res, e, 500); }
});
router.get(erPaths('/:id'), denyLeadScopedToken, (req, res) => { try { ok(res, domain.emailRedesignGet(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e); } });
router.post(erPaths('/:id/submit'), denyLeadScopedToken, async (req, res) => { try { ok(res, await domain.emailRedesignSubmit(req.auth.workspaceId, Number(req.params.id), req.body || {})); } catch (e) { fail(res, e, 500); } });
router.post(erPaths('/:id/dismiss'), denyLeadScopedToken, (req, res) => { try { ok(res, domain.emailRedesignDismiss(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e); } });

// Design — learning playbook (also mounted at /design-learning)
const DL = ['/design/learning', '/design-learning'];
const dlPaths = (suffix = '') => DL.map((p) => `${p}${suffix}`);
router.get(dlPaths('/status'), denyLeadScopedToken, (req, res) => { try { ok(res, domain.learningStatus(req.auth.workspaceId)); } catch (e) { fail(res, e); } });
router.get(dlPaths('/playbook'), denyLeadScopedToken, (req, res) => { try { ok(res, domain.learningPlaybook(req.auth.workspaceId)); } catch (e) { fail(res, e); } });
router.get(dlPaths('/events'), denyLeadScopedToken, (req, res) => { try { ok(res, domain.learningEvents(req.auth.workspaceId, req.query)); } catch (e) { fail(res, e); } });
router.post(dlPaths('/clear'), requireRole('owner', 'admin'), (req, res) => { try { ok(res, domain.learningClear(req.auth.workspaceId, (req.body && req.body.what) || 'all')); } catch (e) { fail(res, e); } });
router.post(dlPaths('/distill'), denyLeadScopedToken, async (req, res) => { try { ok(res, await domain.learningDistill(req.auth.workspaceId, req.body || {})); } catch (e) { fail(res, e, 500); } });

router.post('/design/render', denyLeadScopedToken, (req, res) => { try { ok(res, domain.designRenderHtml(req.auth.workspaceId, req.body || {})); } catch (e) { fail(res, e); } });
router.get('/design/:id/answers', scopeDesign, (req, res) => { try { ok(res, domain.designListAnswers(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e); } });
router.post('/design/:id/contact', scopeDesign, (req, res) => {
  try {
    ok(res, { job: domain.designSetContact(req.auth.workspaceId, Number(req.params.id), req.body || {}) });
  } catch (e) { fail(res, e); }
});
router.post('/design/:id/email-questions', scopeDesign, async (req, res) => {
  try { ok(res, await domain.designEmailQuestions(req.auth.workspaceId, Number(req.params.id))); }
  catch (e) { fail(res, e, e.code === 'SEND_FAILED' ? 502 : 400); }
});
router.post('/design/:id/email-delivery', scopeDesign, async (req, res) => {
  try { ok(res, await domain.designEmailDelivery(req.auth.workspaceId, Number(req.params.id))); }
  catch (e) { fail(res, e, e.code === 'SEND_FAILED' ? 502 : 400); }
});
router.get('/design/:id/client-form', scopeDesign, (req, res) => {
  try { ok(res, domain.designClientFormLink(req.auth.workspaceId, Number(req.params.id))); }
  catch (e) { fail(res, e); }
});
router.post('/design/:id/reply', scopeDesign, (req, res) => { try { ok(res, { job: domain.designRecordReply(req.auth.workspaceId, Number(req.params.id), req.body && req.body.reply, req.body && req.body.fromEmail) }); } catch (e) { fail(res, e); } });
router.put('/design/:id/website', scopeDesign, (req, res) => { try { ok(res, { job: domain.designSaveWebsite(req.auth.workspaceId, Number(req.params.id), req.body && req.body.pages, req.body && req.body.theme) }); } catch (e) { fail(res, e); } });
router.post('/design/:id/render', scopeDesign, (req, res) => { try { ok(res, domain.designRenderHtml(req.auth.workspaceId, { ...(req.body || {}), id: Number(req.params.id) })); } catch (e) { fail(res, e); } });
router.get('/design/:id/asset-base', scopeDesign, async (req, res) => { try { ok(res, await domain.designAssetBase(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e, 500); } });
router.post('/design/:id/remove-delivery', scopeDesign, (req, res) => { try { ok(res, { job: domain.designRemoveDelivery(req.auth.workspaceId, Number(req.params.id), req.body && req.body.path) }); } catch (e) { fail(res, e); } });
router.delete('/design/:id/delivery', scopeDesign, (req, res) => { try { ok(res, { job: domain.designRemoveDelivery(req.auth.workspaceId, Number(req.params.id), (req.body && req.body.path) || req.query.path) }); } catch (e) { fail(res, e); } });
router.get('/design/:id', scopeDesign, (req, res) => { try { ok(res, { job: domain.designGet(req.auth.workspaceId, Number(req.params.id)) }); } catch (e) { fail(res, e); } });
router.post('/design', pinTokenLeadFilter, scopeBodyLead, async (req, res) => {
  try {
    const body = req.body || {};
    const data = await withIdempotency(req, 'design.jobs.create', body, async () => ({
      job: domain.designCreate(req.auth.workspaceId, body),
    }));
    ok(res, data);
  } catch (e) { fail(res, e); }
});
router.patch('/design/:id', scopeDesign, (req, res) => { try { ok(res, { job: domain.designUpdate(req.auth.workspaceId, Number(req.params.id), req.body || {}) }); } catch (e) { fail(res, e); } });
router.delete('/design/:id', scopeDesign, (req, res) => { try { ok(res, domain.designDelete(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e); } });
router.post('/design/next', denyLeadScopedToken, (req, res) => { try { ok(res, { job: domain.designNext(req.auth.workspaceId) }); } catch (e) { fail(res, e); } });
router.post('/design/:id/deliver', scopeDesign, async (req, res) => {
  try {
    const b = req.body || {};
    const idemBody = { id: Number(req.params.id), payload: b.payload, claims: b.claims };
    const receipt = await withIdempotency(req, 'design.deliver', idemBody, async () => {
      const job = await domain.designDeliver(req.auth.workspaceId, Number(req.params.id), b.payload, b.claims, b);
      return deliverReceipt(job);
    });
    ok(res, receipt);
  } catch (e) { fail(res, e); }
});
router.post('/design/:id/ask', scopeDesign, (req, res) => { try { ok(res, domain.designAsk(req.auth.workspaceId, Number(req.params.id), req.body.question)); } catch (e) { fail(res, e); } });
router.post('/design/answer', denyLeadScopedToken, (req, res) => { try { ok(res, { job: domain.designAnswer(req.auth.workspaceId, req.body.questionId || req.body.id, req.body.answer, req.body.fromEmail) }); } catch (e) { fail(res, e); } });
router.post('/design/:id/review', scopeDesign, async (req, res) => { try { ok(res, await domain.designReview(req.auth.workspaceId, Number(req.params.id), req.body || {})); } catch (e) { fail(res, e, 500); } });
router.post('/design/:id/redesign', scopeDesign, async (req, res) => { try { ok(res, await domain.designRedesign(req.auth.workspaceId, Number(req.params.id), req.body || {})); } catch (e) { fail(res, e, 500); } });
router.post('/design/:id/improve', scopeDesign, async (req, res) => { try { ok(res, await domain.designImprove(req.auth.workspaceId, Number(req.params.id), req.body || {})); } catch (e) { fail(res, e, 500); } });
router.post('/design/:id/preview', scopeDesign, async (req, res) => { try { ok(res, await domain.designPreviewUrl(req.auth.workspaceId, Number(req.params.id), !!(req.body && req.body.open))); } catch (e) { fail(res, e, 500); } });
router.post('/design/:id/images', scopeDesign, async (req, res) => { try { ok(res, await domain.designAddImages(req.auth.workspaceId, Number(req.params.id), req.body || {})); } catch (e) { fail(res, e, 500); } });
router.post('/design/:id/generate-images', scopeDesign, async (req, res) => { try { ok(res, await domain.designGenerateImages(req.auth.workspaceId, Number(req.params.id), req.body || {})); } catch (e) { fail(res, e, 500); } });
router.post('/design/:id/generate-logo', scopeDesign, async (req, res) => { try { ok(res, await domain.designGenerateLogo(req.auth.workspaceId, Number(req.params.id), req.body || {})); } catch (e) { fail(res, e, 500); } });

// Websites
router.get('/websites', pinTokenLeadFilter, (req, res) => { try { ok(res, domain.sitesList(req.auth.workspaceId, req.query)); } catch (e) { fail(res, e); } });
router.get('/websites/by-lead/:leadId', scopeLeadIdParam, (req, res) => { try { ok(res, domain.sitesForLead(req.auth.workspaceId, Number(req.params.leadId))); } catch (e) { fail(res, e); } });
router.post('/websites/render', denyLeadScopedToken, (req, res) => { try { ok(res, domain.sitesRenderHtml(req.auth.workspaceId, null, req.body || {})); } catch (e) { fail(res, e); } });
router.put('/websites/:id', scopeWebsite, (req, res) => { try { ok(res, domain.sitesSave(req.auth.workspaceId, Number(req.params.id), req.body || {})); } catch (e) { fail(res, e); } });
router.post('/websites/:id/structure', scopeWebsite, (req, res) => {
  try { ok(res, domain.sitesReorderStructure(req.auth.workspaceId, Number(req.params.id), req.body || {})); }
  catch (e) { fail(res, e); }
});
router.get('/websites/:id/structure', scopeWebsite, (req, res) => {
  try { ok(res, domain.sitesGetStructure(req.auth.workspaceId, Number(req.params.id))); }
  catch (e) { fail(res, e); }
});
router.post('/websites/:id/render', scopeWebsite, (req, res) => { try { ok(res, domain.sitesRenderHtml(req.auth.workspaceId, Number(req.params.id), req.body || {})); } catch (e) { fail(res, e); } });
router.get('/websites/:id/screenshots', scopeWebsite, async (req, res) => {
  try {
    ok(res, await domain.sitesScreenshotsList(req.auth.workspaceId, {
      websiteId: Number(req.params.id),
      currentOnly: req.query.current !== '0',
      checkReady: req.query.ready === '1',
      kind: req.query.kind || undefined,
    }));
  } catch (e) { fail(res, e); }
});
router.get('/screenshots', denyLeadScopedToken, async (req, res) => {
  try {
    ok(res, await domain.sitesScreenshotsList(req.auth.workspaceId, {
      websiteId: req.query.websiteId ? Number(req.query.websiteId) : undefined,
      leadId: req.query.leadId ? Number(req.query.leadId) : undefined,
      currentOnly: req.query.current !== '0',
      checkReady: req.query.ready === '1',
      kind: req.query.kind || undefined,
    }));
  } catch (e) { fail(res, e); }
});
router.post('/websites/:id/screenshots/capture', scopeWebsite, async (req, res) => {
  try {
    ok(res, await domain.sitesScreenshotsCapture(
      req.auth.workspaceId,
      Number(req.params.id),
      Object.assign({}, req.body || {}, { forcePreview: !!(req.body && req.body.forcePreview) })
    ));
  } catch (e) { fail(res, e, 500); }
});
router.post('/websites/:id/preview', scopeWebsite, async (req, res) => {
  try {
    ok(res, await domain.sitesPreview(req.auth.workspaceId, Number(req.params.id), req.body || {}));
  } catch (e) {
    fail(res, e, e.code === 'PREVIEW_NOT_CONFIGURED' ? 400 : 500);
  }
});
router.get('/websites/:id', scopeWebsite, (req, res) => { try { ok(res, { site: domain.sitesGet(req.auth.workspaceId, Number(req.params.id)) }); } catch (e) { fail(res, e); } });
router.delete('/websites/:id', scopeWebsite, (req, res) => {
  try { ok(res, domain.sitesDelete(req.auth.workspaceId, Number(req.params.id))); }
  catch (e) { fail(res, e); }
});
router.post('/websites/generate', pinTokenLeadFilter, scopeBodyLead, async (req, res) => { try { ok(res, await domain.sitesGenerate(req.auth.workspaceId, Number(req.body.leadId), req.body || {})); } catch (e) { fail(res, e, 500); } });
router.post('/websites/:id/qa', scopeWebsite, async (req, res) => { try { ok(res, await domain.sitesQa(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e, 500); } });
router.post('/websites/:id/export', scopeWebsite, async (req, res) => { try { ok(res, await domain.sitesExport(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e); } });
router.get('/websites/:id/export-zip', scopeWebsite, async (req, res) => {
  try {
    const zipped = await domain.sitesExportZip(req.auth.workspaceId, Number(req.params.id));
    const safeName = String(zipped.filename || 'website.zip').replace(/[^\w.\-]+/g, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Length', String(zipped.buffer.length));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).end(zipped.buffer);
  } catch (e) { fail(res, e, 500); }
});
router.post('/websites/:id/export-zip', scopeWebsite, async (req, res) => {
  try {
    const zipped = await domain.sitesExportZip(req.auth.workspaceId, Number(req.params.id));
    const safeName = String(zipped.filename || 'website.zip').replace(/[^\w.\-]+/g, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Length', String(zipped.buffer.length));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).end(zipped.buffer);
  } catch (e) { fail(res, e, 500); }
});
/** Site + claim URLs with QR data-URLs (JSON). Works while automation is paused. */
router.get('/websites/:id/claim-kit', scopeWebsite, async (req, res) => {
  try {
    ok(res, await domain.sitesClaimKit(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) { fail(res, e, 500); }
});
/** Postcard PDF (4×6) with site + claim QRs. */
router.get('/websites/:id/postcard', scopeWebsite, async (req, res) => {
  try {
    const kit = await domain.sitesPostcard(req.auth.workspaceId, Number(req.params.id));
    const safeName = String(kit.filename || 'bitpype-postcard.pdf').replace(/[^\w.\-]+/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Length', String(kit.pdf.length));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).end(kit.pdf);
  } catch (e) { fail(res, e, 500); }
});
router.post('/websites/:id/optimize-images', scopeWebsite, async (req, res) => {
  try {
    ok(res, await domain.sitesOptimizeImages(req.auth.workspaceId, Number(req.params.id), req.body || {}));
  } catch (e) { fail(res, e, 500); }
});
router.post('/websites/:id/images', scopeWebsite, async (req, res) => { try { ok(res, await domain.sitesAddImages(req.auth.workspaceId, Number(req.params.id), req.body || {})); } catch (e) { fail(res, e, 500); } });
router.post('/websites/:id/logo', scopeWebsite, async (req, res) => {
  try {
    const body = req.body || {};
    const mode = String(body.mode || (body.data ? 'image' : 'text')).toLowerCase();
    if (mode === 'text') {
      ok(res, await domain.sitesSetLogo(req.auth.workspaceId, Number(req.params.id), {
        mode: 'text',
        brandName: body.brandName,
        note: 'Staff logo → text',
      }));
      return;
    }
    const dataB64 = String(body.data || body.base64 || '')
      .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
      .replace(/\s+/g, '');
    if (!dataB64) {
      const e = new Error('data (base64 image) is required for image logos');
      e.code = 'EMPTY';
      throw e;
    }
    ok(res, await domain.sitesSetLogo(req.auth.workspaceId, Number(req.params.id), {
      mode: 'image',
      buffer: Buffer.from(dataB64, 'base64'),
      brandName: body.brandName,
      note: 'Staff logo upload',
    }));
  } catch (e) { fail(res, e, 500); }
});
router.get('/websites/:id/versions', scopeWebsite, (req, res) => { try { ok(res, domain.sitesVersions(req.auth.workspaceId, Number(req.params.id), req.query)); } catch (e) { fail(res, e); } });
router.post('/websites/restore', denyLeadScopedToken, (req, res) => { try { ok(res, { site: domain.sitesRestore(req.auth.workspaceId, Number(req.body.versionId)) }); } catch (e) { fail(res, e); } });

// Outreach
router.get('/campaigns', denyLeadScopedToken, (req, res) => { try { ok(res, domain.campaignsList(req.auth.workspaceId, req.query)); } catch (e) { fail(res, e); } });
router.post('/campaigns', denyLeadScopedToken, (req, res) => { try { ok(res, domain.campaignsCreate(req.auth.workspaceId, req.body || {})); } catch (e) { fail(res, e); } });
router.post('/campaigns/:id/status', denyLeadScopedToken, (req, res) => { try { ok(res, domain.campaignsSetStatus(req.auth.workspaceId, Number(req.params.id), req.body.status)); } catch (e) { fail(res, e); } });
router.post('/campaigns/:id/cancel', denyLeadScopedToken, (req, res) => { try { ok(res, domain.campaignsCancel(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e); } });
router.delete('/campaigns/:id', denyLeadScopedToken, (req, res) => { try { ok(res, domain.campaignsDelete(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e); } });
router.get('/campaigns/:id/messages', denyLeadScopedToken, (req, res) => { try { ok(res, domain.campaignsMessages(req.auth.workspaceId, Number(req.params.id), req.query)); } catch (e) { fail(res, e); } });
router.get('/templates', denyLeadScopedToken, (req, res) => { try { ok(res, { templates: domain.templatesList(req.auth.workspaceId, req.query || {}) }); } catch (e) { fail(res, e); } });
router.post('/templates', denyLeadScopedToken, (req, res) => { try { ok(res, domain.templatesSave(req.auth.workspaceId, req.body || {})); } catch (e) { fail(res, e); } });
router.delete('/templates/:id', denyLeadScopedToken, (req, res) => { try { ok(res, domain.templatesDelete(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e); } });
router.post('/outreach/process', requireRole('owner', 'admin'), async (req, res) => { try { ok(res, await domain.outreachProcessQueue(req.auth.workspaceId)); } catch (e) { fail(res, e, 500); } });
router.get('/outreach/stats', denyLeadScopedToken, (req, res) => { try { ok(res, domain.outreachStats(req.auth.workspaceId)); } catch (e) { fail(res, e); } });
router.get('/suppression', denyLeadScopedToken, (req, res) => { try { ok(res, domain.suppressionList(req.auth.workspaceId, req.query)); } catch (e) { fail(res, e); } });
router.post('/suppression', denyLeadScopedToken, (req, res) => { try { ok(res, domain.suppressionAdd(req.auth.workspaceId, req.body.email, req.body.reason)); } catch (e) { fail(res, e); } });
router.delete('/suppression/:id', denyLeadScopedToken, (req, res) => { try { ok(res, domain.suppressionRemove(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e); } });
router.get('/pipeline', denyLeadScopedToken, (req, res) => { try { ok(res, domain.pipelineBoard(req.auth.workspaceId, req.query)); } catch (e) { fail(res, e); } });
router.get('/intent/:leadId', scopeLeadIdParam, (req, res) => { try { ok(res, domain.intentGet(req.auth.workspaceId, Number(req.params.leadId))); } catch (e) { fail(res, e); } });
router.post('/intent/:leadId', scopeLeadIdParam, (req, res) => { try { ok(res, domain.intentRecord(req.auth.workspaceId, Number(req.params.leadId), req.body.event, req.body.note)); } catch (e) { fail(res, e); } });
router.post('/email/compose', pinTokenLeadFilter, scopeBodyLead, (req, res) => {
  try {
    ok(res, domain.emailCompose(req.auth.workspaceId, req.body.leadId, req.body.templateId, {
      queue: !!req.body.queue,
      channel: req.body.channel,
    }));
  } catch (e) { fail(res, e); }
});
router.post('/email/send', requireRole('owner', 'admin'), async (req, res) => { try { ok(res, await domain.emailSend(req.auth.workspaceId, Number(req.body && req.body.messageId))); } catch (e) { fail(res, e, e.code === 'SEND_FAILED' ? 502 : 400); } });
router.post('/sms/queue', pinTokenLeadFilter, (req, res) => {
  try { ok(res, domain.smsQueue(req.auth.workspaceId, req.body || {})); }
  catch (e) { fail(res, e); }
});
router.post('/email/draft', pinTokenLeadFilter, async (req, res) => {
  try { ok(res, await domain.emailDraft(req.auth.workspaceId, req.body || {})); }
  catch (e) { fail(res, e, e.code === 'AI_NOT_CONFIGURED' || e.code === 'AUTOMATION_PAUSED' || e.code === 'BUDGET_EXCEEDED' ? 400 : 500); }
});
router.post('/email/assets', denyLeadScopedToken, async (req, res) => {
  try { ok(res, await domain.emailUploadAsset(req.auth.workspaceId, req.body || {})); }
  catch (e) { fail(res, e); }
});

// Settings (workspace SQLite — same keys as desktop)
router.get('/settings', denyLeadScopedToken, (req, res) => { try { ok(res, { settings: domain.settingsGetAll(req.auth.workspaceId) }); } catch (e) { fail(res, e); } });
router.put('/settings', requireRole('owner', 'admin'), (req, res) => { try { ok(res, domain.settingsSet(req.auth.workspaceId, req.body.key, req.body.value)); } catch (e) { fail(res, e); } });
router.put('/settings/secret', requireRole('owner', 'admin'), (req, res) => { try { ok(res, domain.settingsSetSecret(req.auth.workspaceId, req.body.key, req.body.value)); } catch (e) { fail(res, e); } });
router.post('/settings/automation', requireRole('owner', 'admin'), (req, res) => { try { ok(res, domain.automationSet(req.auth.workspaceId, !!(req.body && req.body.paused))); } catch (e) { fail(res, e); } });
router.get('/prompts', denyLeadScopedToken, (req, res) => { try { ok(res, { prompts: domain.promptsList(req.auth.workspaceId) }); } catch (e) { fail(res, e); } });
router.put('/prompts/:key', requireRole('owner', 'admin'), (req, res) => { try { ok(res, domain.promptsSave(req.auth.workspaceId, req.params.key, req.body.body)); } catch (e) { fail(res, e); } });
router.post('/prompts/:key/reset', requireRole('owner', 'admin'), (req, res) => { try { ok(res, domain.promptsReset(req.auth.workspaceId, req.params.key)); } catch (e) { fail(res, e); } });
router.get('/activity', denyLeadScopedToken, (req, res) => { try { ok(res, domain.activityRecent(req.auth.workspaceId, req.query)); } catch (e) { fail(res, e); } });
router.get('/ai/usage', denyLeadScopedToken, (req, res) => { try { ok(res, domain.aiUsage(req.auth.workspaceId, Number(req.query.days) || 30)); } catch (e) { fail(res, e); } });
router.get('/ai/status', denyLeadScopedToken, (req, res) => { try { ok(res, domain.aiStatus(req.auth.workspaceId)); } catch (e) { fail(res, e); } });

// Cloudflare
router.get('/cloudflare', denyLeadScopedToken, (req, res) => { try { ok(res, domain.cfGetConfig(req.auth.workspaceId)); } catch (e) { fail(res, e); } });
router.put('/cloudflare', requireRole('owner', 'admin'), (req, res) => { try { ok(res, domain.cfSaveConfig(req.auth.workspaceId, req.body || {})); } catch (e) { fail(res, e); } });
router.post('/cloudflare/test', requireRole('owner', 'admin'), async (req, res) => { try { ok(res, await domain.cfTest(req.auth.workspaceId)); } catch (e) { fail(res, e, 500); } });
router.post('/cloudflare/publish', requireRole('owner', 'admin'), async (req, res) => {
  try { ok(res, await domain.cfPublish(req.auth.workspaceId, Number(req.body.websiteId))); }
  catch (e) { fail(res, e, 500); }
});

// Domains — Cloudflare Registrar search/purchase + Pages custom-domain link
router.get('/domains', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.domainsList(req.auth.workspaceId, {
      websiteId: req.query.websiteId ? Number(req.query.websiteId) : undefined,
      leadId: req.query.leadId ? Number(req.query.leadId) : undefined,
      status: req.query.status || undefined,
    }));
  } catch (e) { fail(res, e); }
});
router.get('/domains/owned', denyLeadScopedToken, async (req, res) => {
  try { ok(res, await domain.domainsOwned(req.auth.workspaceId)); }
  catch (e) { fail(res, e, 500); }
});
router.get('/domains/search', denyLeadScopedToken, async (req, res) => {
  try {
    ok(res, await domain.domainsSearch(req.auth.workspaceId, req.query.q || req.query.query, {
      leadId: req.query.leadId ? Number(req.query.leadId) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (e) { fail(res, e, 500); }
});
router.post('/domains/check', denyLeadScopedToken, async (req, res) => {
  try {
    const names = (req.body && (req.body.domains || req.body.names)) || [req.body && req.body.domain];
    ok(res, await domain.domainsCheck(req.auth.workspaceId, names));
  } catch (e) { fail(res, e, 500); }
});
router.post('/domains/register', requireRole('owner', 'admin', 'member'), denyLeadScopedToken, async (req, res) => {
  try { ok(res, await domain.domainsRegister(req.auth.workspaceId, req.body || {})); }
  catch (e) { fail(res, e, 500); }
});
router.get('/domains/:domain/status', denyLeadScopedToken, async (req, res) => {
  try { ok(res, await domain.domainsRegistrationStatus(req.auth.workspaceId, req.params.domain)); }
  catch (e) { fail(res, e, 500); }
});
router.post('/domains/link', requireRole('owner', 'admin', 'member'), denyLeadScopedToken, async (req, res) => {
  try { ok(res, await domain.domainsLink(req.auth.workspaceId, req.body || {})); }
  catch (e) { fail(res, e, 500); }
});
router.post('/domains/unlink', requireRole('owner', 'admin', 'member'), denyLeadScopedToken, async (req, res) => {
  try { ok(res, await domain.domainsUnlink(req.auth.workspaceId, req.body || {})); }
  catch (e) { fail(res, e, 500); }
});

// Social — Facebook + Instagram (images optional)
router.get('/social/overview', denyLeadScopedToken, (req, res) => { try { ok(res, domain.socialOverview(req.auth.workspaceId)); } catch (e) { fail(res, e); } });
router.get('/social/accounts/:leadId', scopeLeadIdParam, (req, res) => { try { ok(res, domain.socialAccounts(req.auth.workspaceId, Number(req.params.leadId))); } catch (e) { fail(res, e); } });
router.delete('/social/accounts/:id', requireRole('owner', 'admin', 'member'), scopeSocialAccount, (req, res) => {
  try { ok(res, domain.socialDisconnect(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e); }
});
router.get('/social/oauth/start', pinTokenLeadFilter, scopeQueryLead, (req, res) => {
  try { ok(res, domain.socialOauthStart(req.auth.workspaceId, Number(req.query.leadId), req.query.returnTo)); }
  catch (e) { fail(res, e); }
});
router.get('/social/campaigns', pinTokenLeadFilter, (req, res) => {
  try { ok(res, domain.socialCampaigns(req.auth.workspaceId, { leadId: req.query.leadId ? Number(req.query.leadId) : null })); }
  catch (e) { fail(res, e); }
});
router.get('/social/campaigns/:id', scopeSocialCampaign, (req, res) => { try { ok(res, domain.socialCampaignGet(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e); } });
router.post('/social/campaigns/generate', pinTokenLeadFilter, scopeBodyLead, async (req, res) => {
  try { ok(res, await domain.socialGenerateMonth(req.auth.workspaceId, req.body || {})); }
  catch (e) { fail(res, e, 500); }
});
router.post('/social/campaigns/:id/status', scopeSocialCampaign, (req, res) => {
  try { ok(res, domain.socialSetCampaignStatus(req.auth.workspaceId, Number(req.params.id), req.body && req.body.status)); }
  catch (e) { fail(res, e); }
});
router.post('/social/campaigns/:id/send-week', scopeSocialCampaign, async (req, res) => {
  try { ok(res, await domain.socialSendWeekly(req.auth.workspaceId, Number(req.params.id), !!(req.body && req.body.force))); }
  catch (e) { fail(res, e, 500); }
});
router.patch('/social/posts/:id', scopeSocialPost, (req, res) => {
  try { ok(res, { post: domain.socialUpdatePost(req.auth.workspaceId, Number(req.params.id), req.body || {}) }); }
  catch (e) { fail(res, e); }
});
router.post('/social/posts/approve', denyLeadScopedToken, (req, res) => {
  try { ok(res, domain.socialApproveAgency(req.auth.workspaceId, (req.body && req.body.postIds) || [])); }
  catch (e) { fail(res, e); }
});
router.post('/social/posts/:id/publish', requireRole('owner', 'admin'), async (req, res) => {
  try { ok(res, await domain.socialPublishPost(req.auth.workspaceId, Number(req.params.id))); }
  catch (e) { fail(res, e, 500); }
});
router.post('/social/publish-due', requireRole('owner', 'admin'), async (req, res) => {
  try { ok(res, await domain.socialPublishDue(req.auth.workspaceId, req.body || {})); }
  catch (e) { fail(res, e, 500); }
});
router.post('/social/weekly-tick', requireRole('owner', 'admin'), async (req, res) => {
  try { ok(res, await domain.socialWeeklyTick(req.auth.workspaceId)); }
  catch (e) { fail(res, e, 500); }
});

module.exports = router;
