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
function emailCompose(workspaceId, leadId, templateId) {
  return withDb(workspaceId, (db) => {
    const template = db.prepare('SELECT * FROM email_templates WHERE id = ?').get(Number(templateId));
    if (!template) throw new Error('Template not found');
    const lead = leadEngine().getLead(db, Number(leadId));
    if (!lead) throw new Error('Lead not found');
    const facts = db.prepare('SELECT * FROM business_facts WHERE lead_id = ?').all(Number(leadId));
    const email = require('../src/email');
    return email.personalize(template, lead, facts, {});
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
    const info = db.prepare("UPDATE prompts SET body = ?, updated_at = datetime('now') WHERE key = ?").run(body, key);
    if (!info.changes) throw new Error(`Unknown prompt key: ${key}`);
    return { key };
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
    return { todayUsd: today, monthUsd: month, days, recent };
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
  leadsDuplicates, leadsBulk,
  providersList, providersSearch, discoveryGet, discoverySet, discoveryRunNow,
  designList, designGet, designCreate, designUpdate, designDelete, designPending, designNext,
  designDeliver, designAsk, designAnswer, designReview, designRedesign, designImprove,
  designPreviewUrl, designAddImages, designGenerateImages,
  sitesList, sitesGet, sitesGenerate, sitesQa, sitesExport, sitesAddImages, sitesVersions, sitesRestore,
  campaignsList, campaignsCreate, campaignsSetStatus, campaignsMessages,
  templatesList, templatesSave, templatesDelete,
  outreachProcessQueue, outreachStats, suppressionList, suppressionAdd, suppressionRemove,
  pipelineBoard, intentGet, intentRecord, emailCompose,
  settingsGetAll, settingsSet, settingsSetSecret, automationSet, promptsList, promptsSave, aiUsage, aiStatus,
  cfGetConfig, cfSaveConfig, cfTest, cfPublish,
  runDiscoveryJobTick, runOutreachJobTick,
  getSetting, setSetting,
};
