'use strict';

/**
 * Thin facade over Electron domain modules, scoped to a workspace SQLite DB.
 */

const path = require('path');
const os = require('os');
const { openWorkspaceDb } = require('./workspaceDb');

function withDb(workspaceId, fn) {
  const db = openWorkspaceDb(workspaceId);
  // Many engines read settings via ai.setDb
  try {
    const ai = require('../src/ai');
    if (typeof ai.setDb === 'function') ai.setDb(db);
  } catch { /* ignore */ }
  return fn(db);
}

function getSetting(db, key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value == null ? '' : String(value));
}

function logActivity(db, area, message) {
  db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(area, message);
}

// ---------- Dashboard ----------
function dashboardStats(workspaceId) {
  return withDb(workspaceId, (db) => {
    const byStatus = {};
    for (const r of db.prepare('SELECT status, COUNT(*) AS c FROM leads GROUP BY status').all()) {
      byStatus[r.status] = r.c;
    }
    const leadsTotal = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const websites = db.prepare('SELECT COUNT(*) AS c FROM websites').get().c;
    let designWaiting = 0;
    let designQuestions = 0;
    try {
      designWaiting = db.prepare("SELECT COUNT(*) AS c FROM design_jobs WHERE status = 'waiting_on_agent'").get().c;
      designQuestions = db.prepare("SELECT COUNT(*) AS c FROM design_jobs WHERE status = 'questions_pending'").get().c;
    } catch { /* no table yet */ }
    const outreachToday = db.prepare(
      "SELECT COUNT(*) AS c FROM campaign_messages WHERE status = 'sent' AND date(sent_at) = date('now','localtime')"
    ).get().c;
    const aiToday = db.prepare(
      "SELECT ROUND(COALESCE(SUM(cost_usd),0),4) AS c FROM ai_usage WHERE date(at) = date('now','localtime')"
    ).get().c;
    const activity = db.prepare(
      'SELECT id, area, message, at FROM activity_log ORDER BY id DESC LIMIT 20'
    ).all();
    return {
      leadsTotal,
      byStatus,
      websites,
      designJobsWaitingOnAgent: designWaiting,
      designJobsQuestionsPending: designQuestions,
      outreachSentToday: outreachToday,
      aiSpendTodayUsd: aiToday,
      automationPaused: getSetting(db, 'automation_paused', '0') === '1',
      activity,
    };
  });
}

// ---------- Leads ----------
const leadEngine = () => require('../src/leadEngine');

function leadsList(workspaceId, filters = {}) {
  return withDb(workspaceId, (db) => {
    const q = filters.q ? String(filters.q).trim() : '';
    const status = filters.status ? String(filters.status).trim() : '';
    const minScore = filters.minScore != null && filters.minScore !== '' ? Number(filters.minScore) : null;
    const page = Math.max(1, Number(filters.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(filters.pageSize) || Number(filters.limit) || 50));
    const offset = (page - 1) * pageSize;
    const where = [];
    const params = [];
    if (q) {
      where.push('(business_name LIKE ? OR city LIKE ? OR category LIKE ? OR email LIKE ? OR lead_group LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like, like, like);
    }
    if (status) { where.push('status = ?'); params.push(status); }
    if (minScore != null && !Number.isNaN(minScore)) { where.push('score >= ?'); params.push(minScore); }
    if (filters.category) { where.push('category = ?'); params.push(String(filters.category)); }
    if (filters.group) { where.push('lead_group = ?'); params.push(String(filters.group)); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM leads ${whereSql}`).get(...params).c;
    const rows = db.prepare(
      `SELECT * FROM leads ${whereSql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
    ).all(...params, pageSize, offset).map((r) => ({
      ...r,
      tags: (() => { try { return JSON.parse(r.tags || '[]'); } catch { return []; } })(),
      qualified: Boolean(r.qualified),
    }));
    return { leads: rows, rows, total, page, pageSize };
  });
}
function leadsFacets(workspaceId) {
  return withDb(workspaceId, (db) => leadEngine().listLeadFacets(db));
}
function leadsGet(workspaceId, id) {
  return withDb(workspaceId, (db) => {
    const lead = leadEngine().getLead(db, id);
    if (!lead) return null;
    const facts = db.prepare('SELECT * FROM business_facts WHERE lead_id = ? ORDER BY id DESC LIMIT 100').all(id);
    const scores = db.prepare('SELECT * FROM lead_scores WHERE lead_id = ? ORDER BY id DESC LIMIT 5').all(id);
    const events = db.prepare('SELECT * FROM lead_events WHERE lead_id = ? ORDER BY id DESC LIMIT 50').all(id);
    return { lead, facts, scores, events };
  });
}
function leadsCreate(workspaceId, obj) {
  return withDb(workspaceId, (db) => leadEngine().createLead(db, obj));
}
function leadsUpdate(workspaceId, id, patch) {
  return withDb(workspaceId, (db) => leadEngine().updateLead(db, id, patch));
}
function leadsDelete(workspaceId, id) {
  return withDb(workspaceId, (db) => leadEngine().deleteLead(db, id));
}
function leadsScore(workspaceId, id) {
  return withDb(workspaceId, (db) => leadEngine().scoreLead(db, id));
}
function leadsQualify(workspaceId, id, note) {
  return withDb(workspaceId, (db) => leadEngine().qualifyLead(db, id, note));
}
function leadsMerge(workspaceId, keepId, dropIds) {
  return withDb(workspaceId, (db) => leadEngine().mergeLeads(db, keepId, dropIds));
}
function leadsImportCsv(workspaceId, text, opts) {
  return withDb(workspaceId, (db) => leadEngine().importCsv(db, text, opts));
}
async function leadsResearch(workspaceId, id) {
  return withDb(workspaceId, (db) => leadEngine().researchLead(db, id));
}
async function leadsDiscover(workspaceId, opts) {
  return withDb(workspaceId, (db) => leadEngine().discoverLeads(db, opts));
}
function leadsDuplicates(workspaceId, id) {
  return withDb(workspaceId, (db) => {
    const lead = leadEngine().getLead(db, id);
    if (!lead) return [];
    return leadEngine().findDuplicates(db, lead);
  });
}
function leadsAddFact(workspaceId, leadId, fact) {
  return withDb(workspaceId, (db) => {
    const id = Number(leadId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('leadId must be a positive integer.');
    return leadEngine().addFact(db, id, fact || {});
  });
}
function leadsTimeline(workspaceId, leadId, opts = {}) {
  return withDb(workspaceId, (db) => outreach().getTimeline(db, Number(leadId), { limit: opts && opts.limit }));
}
/** Lead score + Hot/Qualified/Cold label from current thresholds (MCP prospect.score). */
function prospectScore(workspaceId, leadId) {
  return withDb(workspaceId, (db) => {
    const id = Number(leadId);
    const lead = db.prepare('SELECT id, business_name, score, qualified FROM leads WHERE id = ?').get(id);
    if (!lead) throw new Error(`Lead ${id} not found.`);
    const latest = db.prepare('SELECT score, breakdown, at FROM lead_scores WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(id) || null;
    const q = parseInt(getSetting(db, 'score.threshold_qualified', ''), 10) || 50;
    const h = parseInt(getSetting(db, 'score.threshold_hot', ''), 10) || 70;
    const score = Number(lead.score) || 0;
    const label = score >= h ? 'Hot' : (score >= q ? 'Qualified' : 'Cold');
    return { leadId: id, score: lead.score, label, qualified: !!lead.qualified, latest };
  });
}
async function leadsBulk(workspaceId, payload) {
  return withDb(workspaceId, async (db) => {
    const engine = leadEngine();
    const action = String(payload.action || '');
    const ids = (payload.ids || []).map(Number);
    const value = payload.value;
    const results = { action, processed: 0, failed: 0, errors: [] };
    for (const id of ids) {
      try {
        if (action === 'delete') engine.deleteLead(db, id);
        else if (action === 'status') engine.updateLead(db, id, { status: value });
        else if (action === 'set_group') engine.updateLead(db, id, { lead_group: engine.normalizeGroupName(value) });
        else if (action === 'set_category') engine.updateLead(db, id, { category: value });
        else if (action === 'tag' || action === 'untag') {
          const lead = engine.getLead(db, id);
          const tags = new Set(lead.tags || []);
          if (action === 'tag') tags.add(value); else tags.delete(value);
          engine.updateLead(db, id, { tags: [...tags] });
        } else if (action === 'research') await engine.researchLead(db, id);
        else throw new Error(`unsupported: ${action}`);
        results.processed++;
      } catch (e) {
        results.failed++;
        results.errors.push({ id, error: e.message });
      }
    }
    return results;
  });
}

// ---------- Providers / discovery ----------
function providersList(workspaceId) {
  return withDb(workspaceId, (db) => {
    const providers = require('../src/providers');
    providers.configureFromSettings(db);
    return providers.listProviders();
  });
}
async function providersSearch(workspaceId, payload) {
  return withDb(workspaceId, async (db) => {
    const providers = require('../src/providers');
    providers.configureFromSettings(db);
    const name = String((payload && payload.provider) || 'tavily');
    const provider = providers.getProvider(name);
    if (!provider) throw new Error(`unknown provider: ${name}`);
    const limit = payload.limit == null ? 10 : Number(payload.limit);
    const results = await provider.search({ ...payload, limit });
    return { results, provider: name };
  });
}
function discoveryGet(workspaceId) {
  return withDb(workspaceId, (db) => require('../src/discoverySchedule').readSchedule(db));
}
function discoverySet(workspaceId, patch) {
  return withDb(workspaceId, (db) => require('../src/discoverySchedule').writeSchedule(db, patch));
}
async function discoveryRunNow(workspaceId) {
  return withDb(workspaceId, (db) => require('../src/discoverySchedule').runDiscoveryJob(db, { force: true, source: 'web' }));
}

// ---------- Design ----------
const designJobs = () => require('../src/designJobs');

function designList(workspaceId, args) {
  return withDb(workspaceId, (db) => designJobs().listJobs(db, args || {}));
}
function designGet(workspaceId, id) {
  return withDb(workspaceId, (db) => designJobs().getJob(db, id));
}
function designCreate(workspaceId, args) {
  return withDb(workspaceId, (db) => designJobs().createJob(db, args));
}
function designUpdate(workspaceId, id, patch) {
  return withDb(workspaceId, (db) => designJobs().updateJob(db, id, patch));
}
function designDelete(workspaceId, id) {
  return withDb(workspaceId, (db) => designJobs().deleteJob(db, id));
}
function designPending(workspaceId) {
  return withDb(workspaceId, (db) => designJobs().pendingAgentSummary(db, { previewLimit: 15 }));
}
function designNext(workspaceId) {
  return withDb(workspaceId, (db) => designJobs().claimNextAgentJob(db) || null);
}
function designDeliver(workspaceId, id, payload, claims, extra = {}) {
  return withDb(workspaceId, (db) => designJobs().deliverJob(db, id, payload, claims, extra));
}
function designAsk(workspaceId, id, question) {
  return withDb(workspaceId, (db) => designJobs().askQuestion(db, id, question));
}
function designAnswer(workspaceId, questionId, answer, fromEmail) {
  return withDb(workspaceId, (db) => designJobs().answerQuestion(db, questionId, answer, fromEmail));
}
async function designReview(workspaceId, id, opts = {}) {
  return withDb(workspaceId, (db) =>
    require('../src/designReview').reviewJob(db, id, { ...opts, skipScreenshots: true })
  );
}
async function designRedesign(workspaceId, id, opts) {
  return withDb(workspaceId, (db) => designJobs().redesignJob(db, id, { ...opts, skipScreenshots: true }));
}
async function designImprove(workspaceId, id, opts) {
  return withDb(workspaceId, (db) => designJobs().improveJob(db, id, { ...opts, skipScreenshots: true }));
}
async function designPreviewUrl(workspaceId, id, open = false) {
  return withDb(workspaceId, async (db) => {
    const design = designJobs();
    if (typeof design.previewUrl === 'function') return design.previewUrl(db, id, { open });
    const openPreview = require('../src/openPreview');
    return openPreview.openDesignJob(db, id, { openBrowser: open });
  });
}
async function designAddImages(workspaceId, id, args) {
  return withDb(workspaceId, (db) => designJobs().addImages(db, id, args));
}
async function designGenerateImages(workspaceId, id, args) {
  return withDb(workspaceId, (db) => designJobs().generateJobImages(db, id, args));
}
function designDefaultInstructions() {
  return { website: designJobs().defaultWebsiteInstructions() };
}
function designListAnswers(workspaceId, id) {
  return withDb(workspaceId, (db) => ({ id: Number(id), questions: designJobs().listAnswers(db, Number(id)) }));
}
function designSetContact(workspaceId, id, email) {
  return withDb(workspaceId, (db) => designJobs().setContactEmail(db, Number(id), email));
}
function designEmailQuestions(workspaceId, id) {
  return withDb(workspaceId, (db) => designJobs().emailQuestions(db, Number(id)));
}
function designEmailDelivery(workspaceId, id) {
  return withDb(workspaceId, (db) => designJobs().emailDelivery(db, Number(id)));
}
function designRecordReply(workspaceId, id, reply, fromEmail) {
  return withDb(workspaceId, (db) => designJobs().recordEmailReply(db, Number(id), reply, fromEmail));
}
function designSaveWebsite(workspaceId, id, pages, theme) {
  return withDb(workspaceId, (db) => designJobs().saveWebsiteEdit(db, Number(id), pages, theme));
}
function designRemoveDelivery(workspaceId, id, itemPath) {
  return withDb(workspaceId, (db) => designJobs().removeDeliveryItem(db, Number(id), itemPath));
}
async function designAssetBase(workspaceId, id) {
  return withDb(workspaceId, (db) => designJobs().assetBaseUrl(db, Number(id)));
}
/** Render a design job's delivered website (or supplied pages/theme) to HTML — no file I/O. */
function designRenderHtml(workspaceId, args = {}) {
  return withDb(workspaceId, (db) => {
    const engine = websiteEngine();
    let pages = args.pages;
    let theme = args.theme || {};
    if (!Array.isArray(pages) || !pages.length) {
      const job = designJobs().getJob(db, Number(args.id));
      const payload = job.deliverable;
      if (!payload || !Array.isArray(payload.pages)) {
        throw Object.assign(new Error('No website delivery yet.'), { code: 'NO_DELIVERY' });
      }
      pages = payload.pages;
      theme = payload.theme || {};
    }
    const opts = {
      editable: !!args.editable,
      pageSlug: args.pageSlug,
      pageIndex: Number.isInteger(args.pageIndex) ? args.pageIndex : (args.pageIndex != null ? Number(args.pageIndex) : undefined),
    };
    const list = pages.map((p) => ({ slug: p.slug, title: p.title }));
    if (opts.pageSlug != null || Number.isInteger(opts.pageIndex)) {
      return { html: engine.renderPageAt(pages, theme, opts), pages: list };
    }
    return { html: engine.renderSite(pages, theme, opts), pages: list };
  });
}

// ---------- Email redesign (inbound change requests) ----------
const emailRedesign = () => require('../src/emailRedesign');

function emailRedesignList(workspaceId, args = {}) {
  return withDb(workspaceId, (db) => {
    const er = emailRedesign();
    er.ensureTables(db);
    return { requests: er.listEmailRedesigns(db, args || {}), dropDir: er.resolveDropDir(db) };
  });
}
function emailRedesignGet(workspaceId, id) {
  return withDb(workspaceId, (db) => {
    const er = emailRedesign();
    er.ensureTables(db);
    return { request: er.getEmailRedesign(db, Number(id)) };
  });
}
function emailRedesignIngest(workspaceId, args = {}) {
  return withDb(workspaceId, (db) => {
    const er = emailRedesign();
    er.ensureTables(db);
    const designJobId = args.designJobId != null ? args.designJobId : (args.jobId != null ? args.jobId : args.id);
    const result = er.ingestInboundEmail(db, {
      fromEmail: args.fromEmail,
      subject: args.subject,
      body: args.body != null ? args.body : args.reply,
      designJobId: designJobId != null && designJobId !== '' ? Number(designJobId) : undefined,
      leadId: args.leadId != null && args.leadId !== '' ? Number(args.leadId) : undefined,
      source: args.source || 'api',
      force: args.force !== false,
      requestKind: args.requestKind || args.request_kind,
    });
    if (result.skipped) {
      return { skipped: true, reason: result.reason || 'not_a_redesign_request', error: 'Not detected as a redesign/improvements request.' };
    }
    return {
      skipped: false,
      request: result.request,
      job: designJobId != null && designJobId !== '' ? designJobs().getJob(db, Number(designJobId)) : null,
    };
  });
}
async function emailRedesignSubmit(workspaceId, id, args = {}) {
  return withDb(workspaceId, async (db) => {
    const er = emailRedesign();
    er.ensureTables(db);
    return er.submitEmailRedesign(db, Number(id), {
      designJobId: args.designJobId,
      instructions: args.instructions,
      requestKind: args.requestKind || args.request_kind,
    });
  });
}
function emailRedesignDismiss(workspaceId, id) {
  return withDb(workspaceId, (db) => {
    const er = emailRedesign();
    er.ensureTables(db);
    return { request: er.dismissEmailRedesign(db, Number(id)) };
  });
}
function emailRedesignScan(workspaceId) {
  return withDb(workspaceId, (db) => {
    const er = emailRedesign();
    er.ensureTables(db);
    return er.scanDropFolder(db);
  });
}

async function imapPoll(workspaceId, opts = {}) {
  return withDb(workspaceId, async (db) => {
    if (getSetting(db, 'automation_paused', '0') === '1' && !opts.force) {
      return { skipped: true, reason: 'automation_paused' };
    }
    const imap = require('../src/imapInbound');
    return imap.pollMailbox(db, opts);
  });
}

// ---------- Design learning ----------
const designLearning = () => require('../src/designLearning');

function learningStatus(workspaceId) {
  return withDb(workspaceId, (db) => {
    designLearning().ensureTables(db);
    return designLearning().getStatus(db);
  });
}
function learningPlaybook(workspaceId) {
  return withDb(workspaceId, (db) => {
    const dl = designLearning();
    dl.ensureTables(db);
    return { playbook: dl.getPlaybook(db), status: dl.getStatus(db) };
  });
}
function learningEvents(workspaceId, args = {}) {
  return withDb(workspaceId, (db) => {
    const dl = designLearning();
    dl.ensureTables(db);
    const opts = {};
    if (args.limit != null && args.limit !== '') opts.limit = Number(args.limit);
    if (args.eventType) opts.eventType = String(args.eventType);
    if (args.jobId != null && args.jobId !== '') opts.jobId = Number(args.jobId);
    return { events: dl.listEvents(db, opts), status: dl.getStatus(db) };
  });
}
function learningClear(workspaceId, what = 'all') {
  return withDb(workspaceId, (db) => {
    const dl = designLearning();
    dl.ensureTables(db);
    const w = String(what || 'all').toLowerCase();
    if (w === 'playbook') return dl.clearPlaybook(db);
    if (w === 'events') return dl.clearEvents(db);
    return dl.clearAll(db);
  });
}
async function learningDistill(workspaceId, args = {}) {
  return withDb(workspaceId, async (db) => {
    designLearning().ensureTables(db);
    return designLearning().maybeDistill(db, { force: !!(args && args.force) });
  });
}

// ---------- Websites ----------
const websiteEngine = () => require('../src/websiteEngine');

function sitesList(workspaceId, args = {}) {
  return withDb(workspaceId, (db) => {
    const { pageArgs, pageResult } = require('../src/paginate');
    const { page, pageSize, offset } = pageArgs(args, { pageSize: 25, maxSize: 100 });
    let where = '';
    const params = [];
    if (args.status) { where = ' WHERE w.status = ?'; params.push(String(args.status)); }
    const total = db.prepare(`SELECT COUNT(*) AS c FROM websites w${where}`).get(...params).c;
    const rows = db.prepare(
      `SELECT w.id, w.lead_id, w.name, w.industry, w.status, w.origin, w.updated_at,
              l.business_name, l.category
       FROM websites w LEFT JOIN leads l ON l.id = w.lead_id
       ${where}
       ORDER BY w.updated_at DESC LIMIT ? OFFSET ?`
    ).all(...params, pageSize, offset);
    return Object.assign({ sites: rows }, pageResult(rows, total, page, pageSize));
  });
}
function sitesGet(workspaceId, id) {
  return withDb(workspaceId, (db) => websiteEngine().getWebsite(db, id));
}
async function sitesGenerate(workspaceId, leadId, opts) {
  return withDb(workspaceId, (db) => websiteEngine().generateSite(db, leadId, opts));
}
async function sitesQa(workspaceId, id) {
  return withDb(workspaceId, (db) => websiteEngine().qaSite(db, id));
}
function sitesExport(workspaceId, id) {
  return withDb(workspaceId, (db) => {
    const site = websiteEngine().getWebsite(db, id);
    const slug = String(site.name || 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'site';
    const dir = path.join(os.homedir(), 'website-scout-exports', `ws-${workspaceId}`, `${slug}-${site.id}`);
    return { path: websiteEngine().exportStatic(db, id, dir) };
  });
}
async function sitesAddImages(workspaceId, id, args) {
  return withDb(workspaceId, (db) => websiteEngine().attachPexelsImages(db, id, args));
}
function sitesVersions(workspaceId, id, args) {
  return withDb(workspaceId, (db) => {
    websiteEngine().getWebsite(db, id);
    const { pageArgs, pageResult } = require('../src/paginate');
    const { page, pageSize, offset } = pageArgs(args || {}, { pageSize: 20, maxSize: 100 });
    const total = db.prepare('SELECT COUNT(*) AS c FROM website_versions WHERE website_id = ?').get(id).c;
    const versions = db.prepare(
      'SELECT id, version_no, note, created_at FROM website_versions WHERE website_id = ? ORDER BY version_no DESC LIMIT ? OFFSET ?'
    ).all(id, pageSize, offset);
    return Object.assign({ versions }, pageResult(versions, total, page, pageSize));
  });
}
function sitesRestore(workspaceId, versionId) {
  return withDb(workspaceId, (db) => websiteEngine().restoreVersion(db, versionId));
}

function siteErr(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}
function parseJsonField(value, what) {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { throw siteErr('INVALID_JSON', `${what} is not valid JSON.`); }
  }
  return value;
}
/** Same strict shape validation as Electron sites:save (src/ipc/websites.js). */
function validatePages(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw siteErr('INVALID_PAGES', 'pages must be a non-empty array.');
  }
  pages.forEach((p, i) => {
    if (!p || typeof p !== 'object') throw siteErr('INVALID_PAGES', `pages[${i}] must be an object.`);
    if (typeof p.slug !== 'string' || !String(p.slug).trim()) {
      throw siteErr('INVALID_PAGES', `pages[${i}].slug must be a non-empty string.`);
    }
    if (typeof p.title !== 'string' || !p.title.trim()) {
      throw siteErr('INVALID_PAGES', `pages[${i}].title must be a non-empty string.`);
    }
    const hasHtml = typeof p.html === 'string' && p.html.trim();
    const hasSections = Array.isArray(p.sections) && p.sections.length > 0;
    if (!hasHtml && !hasSections) throw siteErr('INVALID_PAGES', `pages[${i}] needs sections or html.`);
    if (hasSections) {
      p.sections.forEach((s, j) => {
        if (!s || typeof s !== 'object') throw siteErr('INVALID_PAGES', `pages[${i}].sections[${j}] must be an object.`);
        if (typeof s.type !== 'string' || !s.type.trim()) {
          throw siteErr('INVALID_PAGES', `pages[${i}].sections[${j}].type must be a non-empty string.`);
        }
        if (!s.content || typeof s.content !== 'object' || Array.isArray(s.content)) {
          throw siteErr('INVALID_PAGES', `pages[${i}].sections[${j}].content must be an object.`);
        }
      });
    }
  });
  return pages;
}
/** Website row with parsed pages/theme, claim manifest and lead name (Electron siteRow). */
function siteRow(db, id) {
  const engine = websiteEngine();
  const site = engine.getWebsite(db, id);
  const lead = db.prepare('SELECT business_name, category FROM leads WHERE id = ?').get(site.lead_id);
  return {
    id: site.id,
    lead_id: site.lead_id,
    name: site.name,
    industry: site.industry,
    theme: parseJsonField(site.theme, 'theme'),
    pages: parseJsonField(site.pages, 'pages'),
    status: site.status,
    origin: site.origin,
    preview_path: site.preview_path,
    created_at: site.created_at,
    updated_at: site.updated_at,
    business_name: lead ? lead.business_name : site.name,
    category: lead ? lead.category : null,
    manifest: engine.getManifest(db, site.id),
  };
}
function sitesSave(workspaceId, id, args = {}) {
  return withDb(workspaceId, (db) => {
    const siteId = Number(id);
    if (!Number.isInteger(siteId)) throw siteErr('INVALID_ID', 'id must be an integer.');
    const pages = validatePages(parseJsonField(args.pages, 'pages'));
    const theme = parseJsonField(args.theme, 'theme');
    if (!theme || typeof theme !== 'object' || Array.isArray(theme)) {
      throw siteErr('INVALID_THEME', 'theme must be an object.');
    }
    let note = args.note;
    if (note != null && typeof note !== 'string') throw siteErr('INVALID_NOTE', 'note must be a string.');
    if (typeof note === 'string') note = note.slice(0, 500);
    const version = websiteEngine().saveSite(db, siteId, pages, theme, note);
    logActivity(db, 'websites', `Website #${siteId} saved (version ${version.version_no}).`);
    return { id: siteId, version: { id: version.id, version_no: version.version_no } };
  });
}
function sitesForLead(workspaceId, leadId) {
  return withDb(workspaceId, (db) => {
    const lid = Number(leadId);
    if (!Number.isInteger(lid)) throw siteErr('INVALID_ID', 'leadId must be an integer.');
    const row = db.prepare('SELECT id FROM websites WHERE lead_id = ?').get(lid);
    return { site: row ? siteRow(db, row.id) : null };
  });
}
/** Render a stored website (by id) or supplied pages/theme to HTML. */
function sitesRenderHtml(workspaceId, id, args = {}) {
  return withDb(workspaceId, (db) => {
    const engine = websiteEngine();
    const opts = {
      editable: !!args.editable,
      pageSlug: args.pageSlug,
      pageIndex: Number.isInteger(args.pageIndex) ? args.pageIndex : (args.pageIndex != null ? Number(args.pageIndex) : undefined),
    };
    let pages;
    let theme;
    if (Array.isArray(args.pages)) {
      pages = args.pages;
      theme = args.theme && typeof args.theme === 'object' ? args.theme : {};
    } else {
      const siteId = Number(id != null ? id : args.id);
      if (!Number.isInteger(siteId)) throw siteErr('INVALID_ID', 'id must be an integer.');
      const site = engine.getWebsite(db, siteId);
      pages = parseJsonField(site.pages, 'pages');
      theme = parseJsonField(site.theme, 'theme');
      if (args.editable === undefined) opts.editable = true;
    }
    const list = pages.map((p) => ({ slug: p.slug, title: p.title }));
    if (opts.pageSlug != null || Number.isInteger(opts.pageIndex)) {
      return { html: engine.renderPageAt(pages, theme, opts), pages: list };
    }
    return { html: engine.renderSite(pages, theme, opts), pages: list };
  });
}
/** Export a stored website and return a localhost preview URL. Does not open a browser unless opts.open. */
async function sitesPreview(workspaceId, id, opts = {}) {
  return withDb(workspaceId, async (db) => {
    const siteId = Number(id);
    if (!Number.isInteger(siteId)) throw siteErr('INVALID_ID', 'id must be an integer.');
    const site = websiteEngine().getWebsite(db, siteId);
    const pages = parseJsonField(site.pages, 'pages');
    const theme = parseJsonField(site.theme, 'theme');
    const openPreview = require('../src/openPreview');
    if (opts && opts.open) {
      const opened = await openPreview.openPagesFile(pages, theme, `site-${siteId}`);
      return { id: siteId, url: opened.url || null, path: opened.path, folder: opened.folder, opened: true };
    }
    const preview = await openPreview.previewUrlForPages(pages, theme, `site-${siteId}`);
    return {
      id: siteId,
      url: preview.url,
      indexUrl: preview.indexUrl,
      path: preview.path,
      folder: preview.folder,
      files: preview.files || [],
      port: preview.port,
      opened: false,
    };
  });
}
/**
 * Safe structural edit from a natural-language instruction (theme colour, rename,
 * add section, phone). Mirrors the stdio MCP website.edit; saved through saveSite
 * so a version snapshot is created.
 */
function sitesApplyInstruction(workspaceId, id, instruction) {
  return withDb(workspaceId, (db) => {
    const siteId = Number(id);
    const text = String(instruction || '').trim();
    if (!text) throw new Error('instruction must be a non-empty string.');
    if (text.length > 2000) throw new Error('instruction is too long (max 2000 chars).');
    const engine = websiteEngine();
    const site = engine.getWebsite(db, siteId);
    const theme = parseJsonField(site.theme, 'theme') || {};
    const pages = parseJsonField(site.pages, 'pages') || [];
    let applied = null;
    const colorMatch = text.match(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/);
    if (/primary\s*colou?r|theme\s*colou?r|brand\s*colou?r/i.test(text) && colorMatch) {
      theme.primary = colorMatch[0];
      applied = `Set primary theme color to ${colorMatch[0]}.`;
    } else if (/business name|rename/i.test(text)) {
      const m = text.match(/(?:to|as)\s+["']?([^"']{1,120})["']?$/i);
      if (!m) throw new Error('Could not parse the new business name. Try: "rename business to Acme Plumbing".');
      db.prepare("UPDATE websites SET name = ?, updated_at = datetime('now') WHERE id = ?").run(m[1].trim(), siteId);
      applied = `Renamed website to "${m[1].trim()}".`;
    } else if (/add (a |an )?section/i.test(text)) {
      const m = text.match(/section[:\s]+(.{1,1000})$/is);
      if (!m) throw new Error('Could not parse the section text. Try: "add section: We offer 24/7 emergency repairs".');
      const home = pages.find((p) => p.slug === 'home') || pages[0];
      if (!home) throw new Error('Website has no pages to edit.');
      home.sections = home.sections || [];
      home.sections.push({ type: 'custom', heading: '', body: m[1].trim(), content: { heading: '', body: m[1].trim() } });
      applied = 'Added a custom section to the home page.';
    } else if (/phone/i.test(text)) {
      const m = text.match(/(\+?[\d][\d\s().-]{6,20})/);
      if (!m) throw new Error('Could not parse a phone number from the instruction.');
      const contact = ((pages.find((p) => p.slug === 'home') || pages[0] || {}).sections || []).find((s) => s.type === 'contact');
      if (contact) { contact.body = m[1].trim(); if (contact.content) contact.content.phone = m[1].trim(); }
      applied = `Set contact phone to ${m[1].trim()}.`;
    }
    if (!applied) {
      logActivity(db, 'mcp', `website.edit queued (no safe structural edit matched): site=${siteId} instruction="${text.slice(0, 200)}"`);
      return { id: siteId, applied: false, queued: true, note: 'Instruction did not match a safe structural edit; pass pages/theme for a full edit.' };
    }
    const version = engine.saveSite(db, siteId, pages, theme, `MCP edit: ${text.slice(0, 200)}`);
    return { id: siteId, applied: true, summary: applied, version: { id: version.id, version_no: version.version_no } };
  });
}
async function designOpenPreview(workspaceId, id, opts = {}) {
  return withDb(workspaceId, (db) => designJobs().previewUrl(db, Number(id), { open: !!(opts && opts.open) }));
}

// ---------- Outreach ----------
const outreach = () => require('../src/outreach');

function campaignsList(workspaceId, args) {
  return withDb(workspaceId, (db) => outreach().listCampaigns(db, args));
}
function campaignsCreate(workspaceId, args) {
  return withDb(workspaceId, (db) => outreach().createCampaign(db, args));
}
function campaignsSetStatus(workspaceId, id, status) {
  return withDb(workspaceId, (db) => outreach().setCampaignStatus(db, id, status));
}
function campaignsMessages(workspaceId, id, opts) {
  return withDb(workspaceId, (db) => outreach().listMessages(db, id, null, opts));
}
function templatesList(workspaceId) {
  return withDb(workspaceId, (db) => outreach().listTemplates(db));
}
function templatesSave(workspaceId, args) {
  return withDb(workspaceId, (db) => outreach().saveTemplate(db, args));
}
function templatesDelete(workspaceId, id) {
  return withDb(workspaceId, (db) => outreach().deleteTemplate(db, id));
}
async function outreachProcessQueue(workspaceId) {
  return withDb(workspaceId, (db) => outreach().processQueue(db));
}
function outreachStats(workspaceId) {
  return withDb(workspaceId, (db) => outreach().getOutreachStats(db));
}
function suppressionList(workspaceId, args) {
  return withDb(workspaceId, (db) => outreach().listSuppressions(db, args));
}
function suppressionAdd(workspaceId, email, reason) {
  return withDb(workspaceId, (db) => outreach().addSuppression(db, email, reason));
}
function suppressionRemove(workspaceId, id) {
  return withDb(workspaceId, (db) => outreach().removeSuppression(db, id));
}
function pipelineBoard(workspaceId, args) {
  return withDb(workspaceId, (db) => outreach().pipelineBoard(db, args));
}
function intentGet(workspaceId, leadId) {
  return withDb(workspaceId, (db) => outreach().getIntent(db, leadId));
}
function intentRecord(workspaceId, leadId, event, note) {
  return withDb(workspaceId, (db) => outreach().recordIntent(db, leadId, event, note));
}
function emailCompose(workspaceId, leadId, templateId, opts = {}) {
  return withDb(workspaceId, (db) => {
    const rendered = emailComposeRender(db, leadId, templateId);
    if (!(opts && opts.queue)) return rendered;
    // queue:true — persist as a 'queued' message in the draft "Compose" campaign so email.send can deliver it.
    const lead = leadEngine().getLead(db, Number(leadId));
    if (!lead.email) throw new Error(`Lead ${leadId} has no email address.`);
    const footer = getSetting(db, 'mail.footer', '');
    const body = rendered.body + (footer ? `\n\n--\n${footer}` : '');
    let campaign = db.prepare("SELECT id FROM campaigns WHERE name = ? AND status = 'draft'").get('Compose');
    if (!campaign) {
      campaign = { id: db.prepare('INSERT INTO campaigns (name, template_id, status) VALUES (?, ?, ?)').run('Compose', Number(templateId), 'draft').lastInsertRowid };
    }
    const r = db.prepare(
      'INSERT INTO campaign_messages (campaign_id, lead_id, to_email, subject, body, status) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(Number(campaign.id), Number(leadId), lead.email, rendered.subject, body, 'queued');
    return { ...rendered, body, messageId: Number(r.lastInsertRowid), to: lead.email, queued: true };
  });
}
function emailComposeRender(db, leadId, templateId) {
  const template = db.prepare('SELECT * FROM email_templates WHERE id = ?').get(Number(templateId));
  if (!template) throw new Error('Template not found');
  const lead = leadEngine().getLead(db, Number(leadId));
  if (!lead) throw new Error('Lead not found');
  const facts = db.prepare('SELECT * FROM business_facts WHERE lead_id = ?').all(Number(leadId));
  const email = require('../src/email');
  return email.personalize(template, lead, facts, {});
}
/**
 * Send ONE queued campaign message now (outside the campaign queue).
 * Respects automation pause, suppression list and the daily outreach cap.
 */
async function emailSend(workspaceId, messageId) {
  return withDb(workspaceId, async (db) => {
    const o = outreach();
    const id = Number(messageId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('messageId must be a positive integer.');
    if (o.isAutomationPaused(db)) {
      throw Object.assign(new Error('Automation is paused (kill switch). Resume it before sending.'), { code: 'AUTOMATION_PAUSED' });
    }
    const msg = db.prepare('SELECT * FROM campaign_messages WHERE id = ?').get(id);
    if (!msg) throw Object.assign(new Error(`Message ${id} not found.`), { code: 404 });
    if (msg.status !== 'queued') throw new Error(`Message ${id} is not queued (status: ${msg.status}).`);

    const suppressed = o.isSuppressed(db, msg.to_email);
    if (suppressed) {
      db.prepare("UPDATE campaign_messages SET status = 'suppressed', error = ? WHERE id = ?")
        .run(`suppressed at send time: ${suppressed.reason}`, id);
      db.prepare('INSERT INTO email_events (message_id, type, detail) VALUES (?, ?, ?)')
        .run(id, 'unsubscribed', `suppressed: ${suppressed.reason}`);
      return { messageId: id, sent: false, suppressed: true, reason: suppressed.reason };
    }

    const settings = o.readSettings(db);
    const cap = Math.max(1, Number(settings['cost.max_outreach_per_day']) || 200);
    if (o.sentTodayCount(db) >= cap) {
      throw Object.assign(new Error(`Daily outreach cap reached (${cap}). Message left queued.`), { code: 'CAP_REACHED' });
    }

    const provider = require('../src/email').getProvider(settings, db);
    try {
      await provider.send({ to: msg.to_email, subject: msg.subject, html: msg.body });
    } catch (err) {
      const text = String((err && err.message) || err);
      db.prepare("UPDATE campaign_messages SET status = 'failed', error = ? WHERE id = ?").run(text.slice(0, 1000), id);
      db.prepare('INSERT INTO email_events (message_id, type, detail) VALUES (?, ?, ?)').run(id, 'failed', text.slice(0, 500));
      throw Object.assign(new Error(`Send failed: ${text}`), { code: 'SEND_FAILED' });
    }
    db.prepare("UPDATE campaign_messages SET status = 'sent', sent_at = ?, error = NULL WHERE id = ?")
      .run(new Date().toISOString().slice(0, 19).replace('T', ' '), id);
    db.prepare('INSERT INTO email_events (message_id, type, detail) VALUES (?, ?, ?)').run(id, 'sent', `via ${provider.name}`);
    if (msg.lead_id) {
      try {
        db.prepare(
          `UPDATE leads SET status = 'contacted', updated_at = datetime('now')
           WHERE id = ? AND status NOT IN ('engaged','claimed','trial','customer','lost')`
        ).run(msg.lead_id);
        db.prepare('INSERT INTO prospect_events (lead_id, type, detail) VALUES (?, ?, ?)')
          .run(msg.lead_id, 'email.sent', 'single send');
      } catch { /* non-fatal */ }
    }
    logActivity(db, 'outreach', `Message #${id} sent to ${msg.to_email} (provider: ${provider.name})`);
    return { messageId: id, sent: true, to: msg.to_email, provider: provider.name };
  });
}

// ---------- Settings / prompts / AI ----------
function settingsGetAll(workspaceId) {
  return withDb(workspaceId, (db) => {
    const { SECRET_KEYS } = require('../src/ipc/system');
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const out = {};
    for (const r of rows) out[r.key] = SECRET_KEYS.includes(r.key) && r.value ? '***' : r.value;
    return out;
  });
}
function settingsSet(workspaceId, key, value) {
  return withDb(workspaceId, (db) => {
    const { SETTABLE_KEYS } = require('../src/ipc/system');
    if (!SETTABLE_KEYS.includes(key)) throw new Error(`Setting "${key}" is not writable`);
    setSetting(db, key, value);
    logActivity(db, 'settings', `Setting updated: ${key}`);
    return { key, value };
  });
}
function settingsSetSecret(workspaceId, key, value) {
  return withDb(workspaceId, (db) => {
    const { SECRET_KEYS } = require('../src/ipc/system');
    if (!SECRET_KEYS.includes(key)) throw new Error(`"${key}" is not a secret`);
    setSetting(db, key, value);
    logActivity(db, 'settings', `Secret updated: ${key}`);
    return { key, set: !!value };
  });
}
function automationSet(workspaceId, paused) {
  return withDb(workspaceId, (db) => {
    setSetting(db, 'automation_paused', paused ? '1' : '0');
    logActivity(db, 'automation', paused ? 'Automation PAUSED' : 'Automation RESUMED');
    return { paused: !!paused };
  });
}
function promptsList(workspaceId) {
  return withDb(workspaceId, (db) => db.prepare('SELECT key, name, body, updated_at FROM prompts ORDER BY key').all());
}
function promptsSave(workspaceId, key, body) {
  return withDb(workspaceId, (db) => {
    const text = body == null ? '' : String(body);
    if (text.trim() === '') throw new Error('Prompt body may not be empty.');
    if (text.length > 20000) throw new Error('Prompt body is too long (max 20000 chars).');
    const info = db.prepare("UPDATE prompts SET body = ?, updated_at = datetime('now') WHERE key = ?").run(text, key);
    if (!info.changes) throw new Error(`Unknown prompt key: ${key}`);
    logActivity(db, 'prompts', `Prompt saved: ${key}`);
    return { key };
  });
}
function promptsReset(workspaceId, key) {
  return withDb(workspaceId, (db) => {
    const { PROMPT_SEEDS } = require('../src/seed');
    const k = String(key || '');
    const seed = PROMPT_SEEDS.find((p) => p.key === k);
    if (!seed) throw new Error(`Unknown prompt key "${k}".`);
    // Row may be missing if workspace pre-dates the prompt; upsert from the seed.
    db.prepare(
      `INSERT INTO prompts (key, name, body, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET body = excluded.body, updated_at = datetime('now')`
    ).run(seed.key, seed.name, seed.body);
    logActivity(db, 'prompts', `Prompt restored to seed default: ${k}`);
    return { key: k, body: seed.body };
  });
}
function activityRecent(workspaceId, args = {}) {
  return withDb(workspaceId, (db) => {
    const { pageArgs, pageResult } = require('../src/paginate');
    const opts = args || {};
    const paging = pageArgs(
      { page: opts.page || 1, pageSize: opts.pageSize != null ? opts.pageSize : (opts.limit || 50) },
      { pageSize: 50, maxSize: 200 }
    );
    const total = db.prepare('SELECT COUNT(*) AS c FROM activity_log').get().c;
    const rows = db.prepare(
      'SELECT id, area, message, at FROM activity_log ORDER BY id DESC LIMIT ? OFFSET ?'
    ).all(paging.pageSize, paging.offset);
    return Object.assign({ rows }, pageResult(rows, total, paging.page, paging.pageSize));
  });
}
function aiUsage(workspaceId, days = 30) {
  return withDb(workspaceId, (db) => {
    const today = db.prepare(
      "SELECT ROUND(COALESCE(SUM(cost_usd),0),4) AS c FROM ai_usage WHERE date(at) = date('now','localtime')"
    ).get().c;
    const month = db.prepare(
      "SELECT ROUND(COALESCE(SUM(cost_usd),0),4) AS c FROM ai_usage WHERE strftime('%Y-%m', at) = strftime('%Y-%m','now','localtime')"
    ).get().c;
    const recent = db.prepare(
      "SELECT id, task, model, prompt_tokens, completion_tokens, cost_usd, lead_id, note, at FROM ai_usage WHERE at >= datetime('now', ?) ORDER BY id DESC LIMIT 100"
    ).all(`-${days} days`);
    const byTask = db.prepare(
      `SELECT task, COUNT(*) AS calls, SUM(prompt_tokens) AS prompt_tokens,
              SUM(completion_tokens) AS completion_tokens, ROUND(SUM(cost_usd), 4) AS cost_usd
       FROM ai_usage WHERE at >= datetime('now', ?) GROUP BY task ORDER BY cost_usd DESC`
    ).all(`-${days} days`);
    return { todayUsd: today, monthUsd: month, days, byTask, recent };
  });
}
function aiStatus(workspaceId) {
  return withDb(workspaceId, (db) => {
    try {
      const ai = require('../src/ai');
      if (typeof ai.setDb === 'function') ai.setDb(db);
      return { configured: !!ai.aiConfigured(), model: getSetting(db, 'ai.model.default', '') };
    } catch {
      return { configured: !!getSetting(db, 'ai.api_key'), model: getSetting(db, 'ai.model.default', '') };
    }
  });
}

// ---------- Cloudflare ----------
function cfGetConfig(workspaceId) {
  return withDb(workspaceId, (db) => require('../src/cloudflare').getConfig(db));
}
function cfSaveConfig(workspaceId, cfg) {
  return withDb(workspaceId, (db) => require('../src/cloudflare').saveConfig(db, cfg));
}
async function cfTest(workspaceId) {
  return withDb(workspaceId, (db) => require('../src/cloudflare').testConnection(db));
}
async function cfPublish(workspaceId, websiteId, dir) {
  return withDb(workspaceId, async (db) => {
    const cf = require('../src/cloudflare');
    const engine = websiteEngine();
    let outDir = dir;
    if (!outDir) {
      const site = engine.getWebsite(db, websiteId);
      const slug = String(site.name || 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60) || 'site';
      outDir = path.join(os.homedir(), 'website-scout-exports', `ws-${workspaceId}`, `${slug}-${site.id}`);
      engine.exportStatic(db, websiteId, outDir);
    }
    return cf.publishDirectory(db, { websiteId, dir: outDir });
  });
}

// ---------- Jobs (still MySQL scheduled_jobs) — discovery job runs against workspace SQLite ----------
async function runDiscoveryJobTick(workspaceId, payload = {}) {
  return withDb(workspaceId, async (db) => {
    if (getSetting(db, 'automation_paused', '0') === '1') {
      return { skipped: true, reason: 'automation_paused' };
    }
    return leadEngine().discoverLeads(db, {
      category: payload.category,
      location: payload.location,
      limit: payload.limit,
      provider: payload.provider,
      group: payload.group,
    });
  });
}

async function runOutreachJobTick(workspaceId) {
  return withDb(workspaceId, (db) => {
    if (getSetting(db, 'automation_paused', '0') === '1') {
      return { skipped: true, reason: 'automation_paused' };
    }
    return outreach().processQueue(db);
  });
}

module.exports = {
  withDb,
  openWorkspaceDb,
  dashboardStats,
  leadsList, leadsFacets, leadsGet, leadsCreate, leadsUpdate, leadsDelete,
  leadsScore, leadsQualify, leadsMerge, leadsImportCsv, leadsResearch, leadsDiscover,
  leadsDuplicates, leadsBulk, leadsAddFact, leadsTimeline, prospectScore,
  providersList, providersSearch, discoveryGet, discoverySet, discoveryRunNow,
  designList, designGet, designCreate, designUpdate, designDelete, designPending, designNext,
  designDeliver, designAsk, designAnswer, designReview, designRedesign, designImprove,
  designPreviewUrl, designAddImages, designGenerateImages,
  designDefaultInstructions, designListAnswers, designSetContact, designEmailQuestions, designEmailDelivery,
  designRecordReply, designSaveWebsite, designRemoveDelivery, designAssetBase, designRenderHtml, designOpenPreview,
  emailRedesignList, emailRedesignGet, emailRedesignIngest, emailRedesignSubmit, emailRedesignDismiss, emailRedesignScan,
  imapPoll,
  learningStatus, learningPlaybook, learningEvents, learningClear, learningDistill,
  sitesList, sitesGet, sitesGenerate, sitesQa, sitesExport, sitesAddImages, sitesVersions, sitesRestore,
  sitesSave, sitesForLead, sitesRenderHtml, sitesPreview, sitesApplyInstruction, validatePages,
  campaignsList, campaignsCreate, campaignsSetStatus, campaignsMessages,
  templatesList, templatesSave, templatesDelete,
  outreachProcessQueue, outreachStats, suppressionList, suppressionAdd, suppressionRemove,
  pipelineBoard, intentGet, intentRecord, emailCompose, emailSend,
  settingsGetAll, settingsSet, settingsSetSecret, automationSet, promptsList, promptsSave, promptsReset, activityRecent,
  aiUsage, aiStatus,
  cfGetConfig, cfSaveConfig, cfTest, cfPublish,
  runDiscoveryJobTick, runOutreachJobTick, runImapPollTick: imapPoll,
  getSetting, setSetting,
};
