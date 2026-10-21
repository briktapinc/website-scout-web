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
    if (filters.leadId != null && filters.leadId !== '' && Number(filters.leadId) > 0) {
      where.push('id = ?');
      params.push(Number(filters.leadId));
    }
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
function designPending(workspaceId, args = {}) {
  return withDb(workspaceId, (db) => designJobs().pendingAgentSummary(db, {
    previewLimit: 15,
    leadId: args.leadId,
  }));
}
function designNext(workspaceId) {
  return withDb(workspaceId, (db) => designJobs().claimNextAgentJob(db) || null);
}
function ensureExportSlug(db, siteId) {
  try {
    const cols = db.prepare('PRAGMA table_info(websites)').all();
    if (!cols.some((c) => c && c.name === 'export_slug')) {
      db.exec('ALTER TABLE websites ADD COLUMN export_slug TEXT');
    }
  } catch { /* */ }
  const row = db.prepare('SELECT export_slug FROM websites WHERE id = ?').get(siteId);
  if (row && row.export_slug && String(row.export_slug).trim()) {
    return String(row.export_slug).trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  }
  const slug = require('crypto').randomBytes(9).toString('hex');
  try {
    db.prepare('UPDATE websites SET export_slug = ? WHERE id = ?').run(slug, siteId);
  } catch { /* */ }
  return slug;
}

/** Canonical on-disk export folder for a workspace site (includes export_slug). */
function siteExportFolder(db, workspaceId, siteId) {
  const exportSlug = ensureExportSlug(db, siteId);
  return `ws-${workspaceId}-site-${siteId}-${exportSlug}`;
}

/**
 * Resolve export folder name from preview_path, else canonical slug folder.
 * Used by portal image/logo writers so uploads land where rematerialize publishes.
 */
function resolveSiteExportFolder(workspaceId, site, db = null) {
  if (site && site.preview_path && String(site.preview_path).trim()) {
    const p = String(site.preview_path).replace(/\\/g, '/');
    const m = p.match(/website-scout-exports\/([^/]+)/i);
    if (m && m[1]) return m[1];
  }
  if (db && site && site.id != null) {
    return siteExportFolder(db, workspaceId, site.id);
  }
  if (site && site.export_slug) {
    const slug = String(site.export_slug).trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
    if (slug) return `ws-${workspaceId}-site-${site.id}-${slug}`;
  }
  return `ws-${workspaceId}-site-${site && site.id != null ? site.id : '0'}`;
}

function materializeWebsiteExport(db, workspaceId, siteId, opts = {}) {
  const engine = websiteEngine();
  const openPreview = require('../src/openPreview');
  const site = engine.getWebsite(db, siteId);
  const beforePages = site && site.pages != null ? String(site.pages) : '';
  const beforeTheme = site && site.theme != null ? String(site.theme) : '';
  // Keep published portal form + module embeds in sync before writing static HTML.
  try {
    const forms = require('./contactForms');
    if (site && site.lead_id) forms.prepareSitePagesForExport(db, site.lead_id);
  } catch { /* optional */ }
  try {
    if (site && site.lead_id) {
      require('./siteModules').syncPublishedModules(db, site.lead_id);
    }
  } catch { /* optional */ }
  // Re-read AFTER form/module sync so publish never ships the previous version's HTML.
  const fresh = engine.getWebsite(db, siteId);
  let pages = parseJsonField(fresh.pages, 'pages');
  const theme = parseJsonField(fresh.theme, 'theme');
  pages = engine.normalizePagesNavLinks(pages);

  // Atomic publish: snapshot a version when sync mutates pages; else reuse edit's version.
  let versionRow = null;
  const afterPages = fresh.pages != null ? String(fresh.pages) : JSON.stringify(pages);
  const afterTheme = fresh.theme != null ? String(fresh.theme) : JSON.stringify(theme);
  const mutated = afterPages !== beforePages || afterTheme !== beforeTheme;
  const normalizedJson = JSON.stringify(pages);
  if (normalizedJson !== afterPages) {
    try {
      db.prepare("UPDATE websites SET pages = ?, updated_at = datetime('now') WHERE id = ?")
        .run(normalizedJson, siteId);
    } catch { /* optional */ }
  }
  if (mutated || normalizedJson !== afterPages) {
    try {
      versionRow = engine.saveVersion(db, siteId, 'pre-publish sync');
    } catch (e) {
      console.warn('[domain] pinVersion snapshot:', e.message || e);
    }
  }
  if (!versionRow) {
    try {
      versionRow = db.prepare(
        'SELECT * FROM website_versions WHERE website_id = ? ORDER BY version_no DESC LIMIT 1'
      ).get(siteId);
    } catch { /* optional */ }
  }
  if (!versionRow && opts.pinVersion) {
    try {
      versionRow = engine.saveVersion(db, siteId, opts.note || 'publish export');
    } catch { /* optional */ }
  }

  const folder = siteExportFolder(db, workspaceId, siteId);
  const images = engine.imagesForWebsite(db, siteId);
  // websiteId lets writeStaticPages merge site-{id}/assets into the CF Pages payload.
  // Without this, /assets/* on pages.dev falls through to HTML (broken photos/fonts).
  const exported = openPreview.exportPages(pages, theme, folder, { images, websiteId: siteId });
  try {
    const recovered = engine.recoverMissingExportAssets(pages, theme, exported.dir, { websiteId: siteId });
    if (recovered.length && Array.isArray(exported.files)) {
      for (const rel of recovered) {
        if (!exported.files.includes(rel)) exported.files.push(rel);
      }
    }
  } catch (e) {
    console.warn('[domain] recoverMissingExportAssets:', e.message);
  }
  // Copy app-storage site-{id}/images + assets into the publish folder (same-origin for Pages).
  try {
    const fs = require('fs');
    const pathMod = require('path');
    for (const sub of ['images', 'assets']) {
      const srcDir = pathMod.join(openPreview.exportRoot(), `site-${siteId}`, sub);
      const destDir = pathMod.join(exported.dir, sub);
      if (!fs.existsSync(srcDir)) continue;
      fs.mkdirSync(destDir, { recursive: true });
      for (const name of fs.readdirSync(srcDir)) {
        const from = pathMod.join(srcDir, name);
        const to = pathMod.join(destDir, name);
        if (fs.statSync(from).isFile()) {
          fs.copyFileSync(from, to);
          const rel = `${sub}/${name}`;
          if (Array.isArray(exported.files) && !exported.files.includes(rel)) exported.files.push(rel);
        }
      }
    }
  } catch (e) {
    console.warn('[domain] copy site images/assets:', e.message);
  }
  // Keep preview_path aligned with EXPORT_ROOT (not a stale /root/… path).
  try {
    const indexPath = exported && exported.path
      ? exported.path
      : require('path').join(exported.dir || '', 'index.html');
    db.prepare(
      "UPDATE websites SET preview_path = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(indexPath, siteId);
  } catch { /* optional */ }
  exported.versionNo = versionRow ? Number(versionRow.version_no) : null;
  exported.versionId = versionRow ? Number(versionRow.id) : null;
  exported.versionNote = versionRow ? versionRow.note : null;

  // Cookie footer bar on every preview/publish export (now + going forward).
  try {
    if (exported.dir) {
      const previewChrome = require('../src/previewChrome');
      const cookieInj = previewChrome.injectCookieBarIntoExport(exported.dir);
      exported.cookieBarInjected = cookieInj && cookieInj.injected ? cookieInj.injected : 0;
    }
  } catch (e) {
    console.warn('[domain] cookie bar inject:', e.message || e);
  }

  // Opt-in analytics belongs to the exported site, never the portal editor.
  // Fail an enabled export rather than silently publish a site without its tracking controls.
  if (exported.dir) exported.analyticsFiles = require('./siteAnalytics').inject(db, siteId, exported.dir);

  // Preview claim popup (Yes/No) when the lead has not shown positive intent yet.
  try {
    const leadId = fresh && fresh.lead_id != null ? Number(fresh.lead_id) : 0;
    if (Number.isInteger(leadId) && leadId > 0 && exported.dir) {
      const claimKit = require('../src/claimKit');
      const inj = claimKit.injectClaimPreviewIntoExport(exported.dir, workspaceId, leadId);
      exported.claimPreviewInjected = inj && inj.injected ? inj.injected : 0;
    }
  } catch (e) {
    console.warn('[domain] claim preview inject:', e.message || e);
  }

  return exported;
}

/**
 * Optimize images in a materialized export folder (same filenames; no WebP rename).
 * Awaited by preview/publish/export so CF Pages ships compressed assets.
 */
async function optimizeExportImages(exported, opts = {}) {
  if (!exported || !exported.dir) return null;
  try {
    const pathMod = require('path');
    const imageOptimize = require('../src/imageOptimize');
    const imgDir = pathMod.join(exported.dir, 'images');
    const opt = await imageOptimize.optimizeDirectory(imgDir, {
      preferWebp: opts.preferWebp === true,
      force: !!opts.force,
    });
    if (opt && Array.isArray(exported.files)) {
      for (const f of opt.files || []) {
        if (!f || !f.path) continue;
        const rel = `images/${pathMod.basename(f.path)}`;
        if (!exported.files.includes(rel)) exported.files.push(rel);
      }
    }
    exported.imageOptimize = {
      changed: opt.changed,
      bytesBefore: opt.bytesBefore,
      bytesAfter: opt.bytesAfter,
      savedBytes: Math.max(0, (opt.bytesBefore || 0) - (opt.bytesAfter || 0)),
    };
    return opt;
  } catch (e) {
    console.warn('[domain] optimizeExportImages:', e.message || e);
    return null;
  }
}

async function designDeliver(workspaceId, id, payload, claims, extra = {}) {
  const job = await withDb(workspaceId, async (db) => {
    let deliverPayload = payload;
    let pageWarnings = [];
    if (payload && Array.isArray(payload.pages)) {
      validatePages(payload.pages);
      deliverPayload = {
        ...payload,
        pages: websiteEngine().normalizePagesNavLinks(payload.pages),
      };
      // Download Pexels/Unsplash hotlinks into EXPORT_ROOT/design-{id}/images.
      try {
        deliverPayload = await designJobs().localizePayloadRemoteImages(id, deliverPayload);
      } catch (e) {
        console.warn('[domain] localizePayloadRemoteImages:', e.message || e);
      }
      try {
        const jobRow = db.prepare('SELECT lead_id FROM design_jobs WHERE id = ?').get(Number(id));
        const leadId = jobRow && jobRow.lead_id;
        if (leadId && Array.isArray(deliverPayload.pages)) {
          const forms = require('./contactForms');
          const sanitized = forms.sanitizeAgentPages(db, leadId, deliverPayload.pages, {
            workspaceId,
            appUrl: (() => { try { return require('./stripeClient').appUrl(); } catch { return ''; } })(),
          });
          deliverPayload = Object.assign({}, deliverPayload, { pages: sanitized.pages });
          pageWarnings = sanitized.warnings || [];
        }
      } catch (e) {
        console.warn('[domain] sanitizeAgentPages on deliver:', e.message || e);
      }
    }
    const row = await designJobs().deliverJob(db, id, deliverPayload, claims, extra);
    if (row && pageWarnings.length) row.warnings = pageWarnings;
    if (row && row.website_id) {
      try {
        const site = websiteEngine().getWebsite(db, row.website_id);
        if (site && site.lead_id) {
          require('./contactForms').ensureSiteForms(db, site.lead_id, {
            workspaceId,
            pages: parseJsonField(site.pages, 'pages'),
            missingOnly: true,
          });
          try {
            require('./siteModules').syncPublishedModules(db, site.lead_id);
          } catch (modErr) {
            console.warn('[domain] syncPublishedModules on deliver:', modErr.message);
          }
        }
      } catch (e) {
        console.warn('[domain] ensureSiteForms on deliver:', e.message);
      }
      try { materializeWebsiteExport(db, workspaceId, row.website_id); } catch { /* preview can retry */ }
    }
    return row;
  });
  if (job && job.website_id) {
    let previewUrl = null;
    try {
      const preview = await sitesPreview(workspaceId, job.website_id, { force: true });
      previewUrl = preview && (preview.url || preview.indexUrl) || null;
    } catch (e) {
      console.warn('[domain] force preview after deliver:', e.message);
    }
    if (previewUrl) {
      try {
        require('../src/siteScreenshots').scheduleCaptureAfterPreview(workspaceId, job.website_id, {
          previewUrl,
          designJobId: job.id,
          leadId: job.lead_id,
        });
      } catch (e) {
        console.warn('[domain] schedule screenshot capture:', e.message);
      }
    }
  }
  return job;
}
function designAsk(workspaceId, id, question) {
  return withDb(workspaceId, (db) => designJobs().askQuestion(db, id, question));
}
function designAnswer(workspaceId, questionId, answer, fromEmail) {
  return withDb(workspaceId, (db) => designJobs().answerQuestion(db, questionId, answer, fromEmail));
}
async function designReview(workspaceId, id, opts = {}) {
  return withDb(workspaceId, (db) =>
    designJobs().reviewJob(db, id, { ...opts, skipScreenshots: true })
  );
}
async function designRedesign(workspaceId, id, opts) {
  return withDb(workspaceId, (db) => designJobs().redesignJob(db, id, { ...opts, skipScreenshots: true }));
}
async function designImprove(workspaceId, id, opts) {
  return withDb(workspaceId, (db) => designJobs().improveJob(db, id, { ...opts, skipScreenshots: true }));
}
async function designPreviewUrl(workspaceId, id, open = false) {
  const jobId = Number(id);
  return withDb(workspaceId, async (db) => {
    const design = designJobs();
    const row = typeof design.getJob === 'function'
      ? design.getJob(db, jobId)
      : db.prepare('SELECT * FROM design_jobs WHERE id = ?').get(jobId);
    if (!row) {
      const e = new Error('Design job not found.');
      e.code = 'NOT_FOUND';
      throw e;
    }
    if (row.website_id) {
      const preview = await sitesPreview(workspaceId, row.website_id, { force: true });
      return { id: jobId, websiteId: row.website_id, ...preview, opened: !!open };
    }
    // Delivered site not linked to websites row — export + APP_URL / Cloudflare project design-{id}.
    const payload = typeof row.deliverable === 'string' ? JSON.parse(row.deliverable || 'null') : row.deliverable;
    if (!payload || !Array.isArray(payload.pages) || !payload.pages.length) {
      const e = new Error('The agent has not delivered a website yet.');
      e.code = 'NO_DELIVERY';
      throw e;
    }
    const openPreview = require('../src/openPreview');
    const folder = `ws-${workspaceId}-design-${jobId}`;
    const exported = openPreview.exportPages(payload.pages, payload.theme || {}, folder, {
      images: Array.isArray(payload.images) ? payload.images : [],
    });
    const base = appBaseUrl();
    if (!base) {
      const e = new Error('APP_URL must be set for design preview without a linked website.');
      e.code = 'PREVIEW_NOT_CONFIGURED';
      throw e;
    }
    const url = `${base}/site-previews/${folder}/`;
    return {
      id: jobId,
      url,
      indexUrl: url,
      path: exported.path,
      folder: exported.folder,
      via: 'app_url',
      opened: !!open,
    };
  });
}
async function designAddImages(workspaceId, id, args) {
  return withDb(workspaceId, (db) => designJobs().addImages(db, id, args));
}
async function designGenerateImages(workspaceId, id, args) {
  return withDb(workspaceId, async (db) => {
    const result = await designJobs().generateJobImages(db, id, args);
    const job = designJobs().getJob(db, Number(id));
    if (job && job.website_id) {
      try { materializeWebsiteExport(db, workspaceId, job.website_id); } catch { /* preview can retry */ }
    }
    return result;
  });
}

/**
 * Generate a header logo via OpenAI Images, process to transparent PNG, and
 * attach it to the design job + linked website theme (logoMode=image).
 */
async function designGenerateLogo(workspaceId, id, args = {}) {
  const result = await withDb(workspaceId, async (db) =>
    designJobs().generateJobLogo(db, Number(id), args || {})
  );

  let siteLogo = null;
  const siteId = result.websiteId || (args && args.websiteId) || null;
  if (siteId && result.buffer) {
    siteLogo = await sitesSetLogo(workspaceId, siteId, {
      mode: 'image',
      buffer: result.buffer,
      brandName: args && args.brandName,
      note: `MCP design.generateLogo job #${id}`,
    });
  } else if (result.leadId && result.buffer && !siteId) {
    try {
      siteLogo = await sitesSetLogo(workspaceId, null, {
        leadId: result.leadId,
        mode: 'image',
        buffer: result.buffer,
        brandName: args && args.brandName,
        note: `MCP design.generateLogo job #${id}`,
      });
    } catch { /* no site yet — logo stays on the job deliverable */ }
  }

  return {
    id: result.id,
    websiteId: (siteLogo && siteLogo.siteId) || result.websiteId || null,
    model: result.model,
    prompt: result.prompt,
    logoUrl: (siteLogo && siteLogo.logoUrl) || result.logoUrl,
    publicUrl: siteLogo ? siteLogo.publicUrl : null,
    path: result.path,
    mode: 'image',
    appliedToSite: !!siteLogo,
  };
}
function designDefaultInstructions() {
  const assets = require('../src/designAssets');
  return {
    website: designJobs().defaultWebsiteInstructions(),
    assets: assets.listDesignAssets().map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      description: a.description,
      marker: a.marker,
      usage: a.usage,
    })),
  };
}
function designAssets(id) {
  const assets = require('../src/designAssets');
  if (id != null && String(id).trim()) {
    const one = assets.getDesignAsset(id);
    if (!one) {
      const e = new Error(`Unknown design asset: ${id}`);
      e.code = 'NOT_FOUND';
      e.status = 404;
      throw e;
    }
    return { asset: one };
  }
  return { assets: assets.listDesignAssets() };
}
function designListAnswers(workspaceId, id) {
  return withDb(workspaceId, (db) => ({ id: Number(id), questions: designJobs().listAnswers(db, Number(id)) }));
}
function designSetContact(workspaceId, id, emailOrBody, phone) {
  const body = (emailOrBody != null && typeof emailOrBody === 'object' && !Array.isArray(emailOrBody))
    ? emailOrBody
    : { email: emailOrBody, phone };
  return withDb(workspaceId, (db) => designJobs().setContact(db, Number(id), body));
}
async function designEmailQuestions(workspaceId, id) {
  return withDb(workspaceId, (db) => designJobs().emailQuestions(db, Number(id), { workspaceId }));
}
async function designEmailDelivery(workspaceId, id) {
  return withDb(workspaceId, (db) => designJobs().emailDelivery(db, Number(id), { workspaceId }));
}
function designClientFormLink(workspaceId, id) {
  return withDb(workspaceId, (db) => {
    const token = designJobs().ensureClientFormToken(db, Number(id));
    return {
      jobId: Number(id),
      token,
      url: designJobs().clientFormUrl(workspaceId, token),
    };
  });
}
function designClientFormGet(workspaceId, token) {
  return withDb(workspaceId, (db) => designJobs().getJobByFormToken(db, token));
}
async function designClientFormSubmit(workspaceId, token, body) {
  return withDb(workspaceId, (db) => designJobs().submitClientForm(db, token, body || {}));
}
function designRecordReply(workspaceId, id, reply, fromEmail) {
  return withDb(workspaceId, (db) => designJobs().recordEmailReply(db, Number(id), reply, fromEmail));
}
function designSaveWebsite(workspaceId, id, pages, theme) {
  return withDb(workspaceId, (db) => {
    let nextPages = pages;
    let warnings = [];
    try {
      const jobRow = db.prepare('SELECT lead_id FROM design_jobs WHERE id = ?').get(Number(id));
      if (jobRow && jobRow.lead_id && Array.isArray(pages)) {
        const forms = require('./contactForms');
        const sanitized = forms.sanitizeAgentPages(db, jobRow.lead_id, pages, {
          workspaceId,
          appUrl: (() => { try { return require('./stripeClient').appUrl(); } catch { return ''; } })(),
        });
        nextPages = sanitized.pages;
        warnings = sanitized.warnings || [];
      }
    } catch (e) {
      console.warn('[domain] sanitizeAgentPages on designSaveWebsite:', e.message || e);
    }
    const job = designJobs().saveWebsiteEdit(db, Number(id), nextPages, theme);
    if (job && warnings.length) job.warnings = warnings;
    if (job && job.website_id) {
      try {
        const site = websiteEngine().getWebsite(db, job.website_id);
        if (site && site.lead_id) {
          require('./contactForms').ensureSiteForms(db, site.lead_id, {
            workspaceId,
            pages: nextPages || parseJsonField(site.pages, 'pages'),
            missingOnly: true,
          });
          try { require('./siteModules').syncPublishedModules(db, site.lead_id); } catch { /* */ }
        }
      } catch (e) {
        console.warn('[domain] ensureSiteForms on designSaveWebsite:', e.message);
      }
      try { materializeWebsiteExport(db, workspaceId, job.website_id); } catch { /* preview can retry */ }
    }
    return job;
  });
}
function designRemoveDelivery(workspaceId, id, itemPath) {
  return withDb(workspaceId, (db) => designJobs().removeDeliveryItem(db, Number(id), itemPath));
}
async function designAssetBase(workspaceId, id) {
  return withDb(workspaceId, (db) => designJobs().assetBaseUrl(db, Number(id)));
}
/** Prefer linked website pages/theme so Delivery preview matches the live site. */
function hydrateDesignRenderFromWebsite(db, engine, job, pages, theme) {
  let nextPages = pages;
  let nextTheme = theme && typeof theme === 'object' ? Object.assign({}, theme) : {};
  const websiteId = job && job.website_id != null ? Number(job.website_id) : null;
  if (!websiteId) return { pages: nextPages, theme: nextTheme };
  try {
    const site = engine.getWebsite(db, websiteId);
    const sitePages = parseJsonField(site.pages, 'pages');
    const siteTheme = parseJsonField(site.theme, 'theme');
    if (Array.isArray(sitePages) && sitePages.length) nextPages = sitePages;
    if (siteTheme && typeof siteTheme === 'object') {
      const siteCssLen = typeof siteTheme.customCss === 'string' ? siteTheme.customCss.trim().length : 0;
      const themeCssLen = typeof nextTheme.customCss === 'string' ? nextTheme.customCss.trim().length : 0;
      // Live site theme wins when it has freestyle CSS the deliverable lost.
      if (siteCssLen && siteCssLen >= themeCssLen) nextTheme = Object.assign({}, siteTheme);
      else nextTheme = designJobs().mergeThemePreferCss(nextTheme, siteTheme);
    }
  } catch { /* site optional */ }
  return { pages: nextPages, theme: nextTheme };
}

/** Render a design job's delivered website (or supplied pages/theme) to HTML — no file I/O. */
function designRenderHtml(workspaceId, args = {}) {
  return withDb(workspaceId, (db) => {
    const engine = websiteEngine();
    let pages = args.pages;
    let theme = args.theme || {};
    let job = null;
    const clientSuppliedPages = Array.isArray(pages) && pages.length > 0;
    if (!clientSuppliedPages) {
      job = designJobs().getJob(db, Number(args.id));
      const payload = job.deliverable;
      if (!payload || !Array.isArray(payload.pages)) {
        throw Object.assign(new Error('No website delivery yet.'), { code: 'NO_DELIVERY' });
      }
      pages = payload.pages;
      theme = payload.theme || {};
      // Source of truth for Delivery preview: linked website (has customCss after setTheme/edit).
      ({ pages, theme } = hydrateDesignRenderFromWebsite(db, engine, job, pages, theme));
    } else if (args.id != null) {
      try { job = designJobs().getJob(db, Number(args.id)); } catch { /* optional */ }
      // Client sent pages (e.g. live edits) — still fill missing freestyle CSS from the site.
      if (job && job.website_id) {
        try {
          const site = engine.getWebsite(db, Number(job.website_id));
          const siteTheme = parseJsonField(site.theme, 'theme');
          if (siteTheme) theme = designJobs().mergeThemePreferCss(theme, siteTheme);
        } catch { /* optional */ }
      }
    }
    const opts = {
      editable: !!args.editable,
      preview: true,
      pageSlug: args.pageSlug,
      pageIndex: Number.isInteger(args.pageIndex) ? args.pageIndex : (args.pageIndex != null ? Number(args.pageIndex) : undefined),
    };
    const list = pages.map((p) => ({ slug: p.slug, title: p.title }));
    let html = (opts.pageSlug != null || Number.isInteger(opts.pageIndex))
      ? engine.renderPageAt(pages, theme, opts)
      : engine.renderSite(pages, theme, opts);

    // Prefer linked site export (has logo); else design-{id} folder.
    try {
      const base = appBaseUrl();
      let folder = null;
      const websiteId = job && job.website_id != null ? Number(job.website_id) : null;
      if (websiteId) {
        try { materializeWebsiteExport(db, workspaceId, websiteId); } catch { /* */ }
        const site = engine.getWebsite(db, websiteId);
        folder = resolveSiteExportFolder(workspaceId, site, db);
      } else if (job && job.id) {
        folder = `design-${job.id}`;
      } else if (args.id != null) {
        folder = `design-${Number(args.id)}`;
      }
      if (base && folder) {
        html = engine.injectPreviewBaseHref(html, `${base}/site-previews/${folder}/`);
      }
    } catch { /* */ }

    return { html, pages: list };
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
    const clauses = [];
    const params = [];
    if (args.status) { clauses.push('w.status = ?'); params.push(String(args.status)); }
    if (args.leadId != null && args.leadId !== '' && Number(args.leadId) > 0) {
      clauses.push('w.lead_id = ?');
      params.push(Number(args.leadId));
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
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
  return withDb(workspaceId, (db) => {
    websiteEngine().ensureTables(db);
    const row = siteRow(db, id);
    const latest = db.prepare(
      'SELECT version_no, note, author, created_at FROM website_versions WHERE website_id = ? ORDER BY version_no DESC LIMIT 1'
    ).get(id);
    row.version_note = latest && latest.note != null ? latest.note : null;
    row.version_no = latest ? latest.version_no : null;
    row.version_author = latest && latest.author != null ? latest.author : null;
    row.version_saved_at = latest ? latest.created_at : null;
    try {
      row.formsUnembedded = require('./contactForms').listUnembeddedForms(db, row.lead_id);
    } catch {
      row.formsUnembedded = [];
    }
    return row;
  });
}
/**
 * Delete a website record and purge its EXPORT_ROOT folders / screenshots.
 * Scoped to this workspace — does not wipe other workspaces' site folders.
 */
function sitesDelete(workspaceId, id) {
  return withDb(workspaceId, (db) => websiteEngine().deleteWebsite(db, Number(id), {
    workspaceId: Number(workspaceId),
  }));
}
async function sitesGenerate(workspaceId, leadId, opts) {
  return withDb(workspaceId, async (db) => {
    const generated = await websiteEngine().generateSite(db, leadId, Object.assign({}, opts || {}, {
      workspaceId: Number(workspaceId),
    }));
    try {
      const lid = Number(leadId);
      const siteId = generated && generated.id ? Number(generated.id) : null;
      require('./contactForms').ensureSiteForms(db, lid, {
        workspaceId,
        pages: null, // load from DB after generate
        missingOnly: true,
      });
      try {
        require('./siteModules').syncPublishedModules(db, lid);
      } catch (modErr) {
        console.warn('[domain] syncPublishedModules on generate:', modErr.message);
      }
      if (siteId) {
        try {
          const exported = materializeWebsiteExport(db, workspaceId, siteId);
          await optimizeExportImages(exported);
        } catch { /* preview can retry */ }
      }
    } catch (e) {
      console.warn('[domain] ensureSiteForms on generate:', e.message);
    }
    return generated;
  });
}
async function sitesQa(workspaceId, id) {
  return withDb(workspaceId, (db) => websiteEngine().qaSite(db, id));
}
async function sitesExport(workspaceId, id) {
  return withDb(workspaceId, async (db) => {
    const exported = materializeWebsiteExport(db, workspaceId, Number(id));
    const opt = await optimizeExportImages(exported);
    return {
      path: exported.dir || exported.path,
      folder: exported.folder,
      files: exported.files || [],
      imageOptimize: exported.imageOptimize || (opt && {
        changed: opt.changed,
        bytesBefore: opt.bytesBefore,
        bytesAfter: opt.bytesAfter,
        savedBytes: Math.max(0, (opt.bytesBefore || 0) - (opt.bytesAfter || 0)),
      }) || null,
    };
  });
}

function sanitizeZipBasename(name, fallback) {
  const raw = String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return raw || fallback;
}

/**
 * Rematerialize the site export folder, then zip HTML + CSS + images for download.
 * @returns {{ buffer: Buffer, filename: string, folder: string, files: string[], bytes: number }}
 */
async function sitesExportZip(workspaceId, id) {
  return withDb(workspaceId, async (db) => {
    const siteId = Number(id);
    const site = websiteEngine().getWebsite(db, siteId);
    const exported = materializeWebsiteExport(db, workspaceId, siteId);
    await optimizeExportImages(exported);
    const dir = exported.dir || (exported.path ? require('path').dirname(exported.path) : null);
    if (!dir) {
      const e = siteErr('EXPORT_MISSING', 'Could not materialize site export folder.');
      e.status = 500;
      throw e;
    }
    const fs = require('fs');
    if (!fs.existsSync(dir)) {
      const e = siteErr('EXPORT_MISSING', 'Export folder missing after materialize.');
      e.status = 500;
      throw e;
    }
    const base = sanitizeZipBasename(
      site && (site.name || site.export_slug),
      `website-${siteId}`
    );
    const { zipFolder } = require('../src/zipFolder');
    const zipped = zipFolder(dir, { rootName: base });
    return {
      buffer: zipped.buffer,
      filename: `${base}.zip`,
      folder: exported.folder || require('path').basename(dir),
      files: zipped.files,
      bytes: zipped.bytes,
      imageOptimize: exported.imageOptimize || null,
    };
  });
}
async function sitesAddImages(workspaceId, id, args) {
  return withDb(workspaceId, (db) => websiteEngine().attachPexelsImages(db, id, args));
}

/**
 * Compress / resize site images (app storage + export folder). Optional WebP
 * conversion when safe; rewrites pages/theme when filenames change.
 * Pass id (website), or leadId / websiteId aliases.
 */
async function sitesOptimizeImages(workspaceId, siteId, opts = {}) {
  return withDb(workspaceId, async (db) => {
    let resolvedId = siteId != null ? Number(siteId) : null;
    if (!resolvedId && opts.websiteId != null) resolvedId = Number(opts.websiteId);
    if (!resolvedId && opts.id != null) resolvedId = Number(opts.id);
    if (!resolvedId && opts.leadId != null) {
      const row = db.prepare(
        'SELECT id FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
      ).get(Number(opts.leadId));
      if (!row) throw siteErr('NO_SITE', 'No website is available for this lead');
      resolvedId = row.id;
    }
    if (!Number.isInteger(resolvedId) || resolvedId < 1) {
      throw siteErr('INVALID_ID', 'id, websiteId, or leadId is required.');
    }
    const imageOptimize = require('../src/imageOptimize');
    // Rematerialize first so export folder exists, then optimize both dirs.
    let exported = null;
    try {
      exported = materializeWebsiteExport(db, workspaceId, resolvedId);
    } catch (e) {
      console.warn('[domain] materialize before optimizeImages:', e.message || e);
    }
    const result = await imageOptimize.optimizeWebsiteImages(db, resolvedId, {
      workspaceId: Number(workspaceId),
      force: !!(opts.force || opts.recompress),
      preferWebp: opts.preferWebp !== false,
      savePages: opts.savePages !== false,
      note: opts.note || 'MCP/API optimize images',
    });
    // Re-copy optimized app images into export folder + rewrite HTML if renamed.
    if (exported && exported.dir) {
      try {
        const fs = require('fs');
        const pathMod = require('path');
        const srcDir = pathMod.join(require('../src/openPreview').exportRoot(), `site-${resolvedId}`, 'images');
        const destDir = pathMod.join(exported.dir, 'images');
        if (fs.existsSync(srcDir)) {
          fs.mkdirSync(destDir, { recursive: true });
          for (const name of fs.readdirSync(srcDir)) {
            const from = pathMod.join(srcDir, name);
            const to = pathMod.join(destDir, name);
            if (fs.statSync(from).isFile()) fs.copyFileSync(from, to);
          }
        }
        if (result.renamed && result.renamed.length) {
          imageOptimize.rewriteExportHtmlFiles(exported.dir, result.renamed);
        }
        await optimizeExportImages(exported, {
          force: !!(opts.force || opts.recompress),
          preferWebp: false,
        });
      } catch (e) {
        console.warn('[domain] sync export after optimizeImages:', e.message || e);
      }
    }
    return result;
  });
}
function sitesVersions(workspaceId, id, args) {
  return withDb(workspaceId, (db) => {
    websiteEngine().ensureTables(db);
    websiteEngine().getWebsite(db, id);
    const { pageArgs, pageResult } = require('../src/paginate');
    const { page, pageSize, offset } = pageArgs(args || {}, { pageSize: 20, maxSize: 100 });
    const total = db.prepare('SELECT COUNT(*) AS c FROM website_versions WHERE website_id = ?').get(id).c;
    const versions = db.prepare(
      'SELECT id, version_no, note, author, created_at FROM website_versions WHERE website_id = ? ORDER BY version_no DESC LIMIT ? OFFSET ?'
    ).all(id, pageSize, offset);
    return Object.assign({ versions }, pageResult(versions, total, page, pageSize));
  });
}

function parseVersionPagesTheme(versionRow) {
  const pages = parseJsonField(versionRow.pages, 'pages');
  const theme = parseJsonField(versionRow.theme, 'theme');
  return { pages: Array.isArray(pages) ? pages : [], theme: theme && typeof theme === 'object' ? theme : {} };
}

function sectionTypeCountsForPages(pages) {
  const bySlug = {};
  for (const p of pages) {
    if (!p || typeof p.slug !== 'string') continue;
    const counts = {};
    if (Array.isArray(p.sections)) {
      for (const s of p.sections) {
        const t = s && s.type ? String(s.type) : 'unknown';
        counts[t] = (counts[t] || 0) + 1;
      }
    }
    bySlug[p.slug] = counts;
  }
  return bySlug;
}

function pageContentFingerprint(page) {
  if (!page || typeof page !== 'object') return '';
  const slim = {
    title: page.title,
    html: typeof page.html === 'string' ? page.html.length : 0,
    sections: Array.isArray(page.sections)
      ? page.sections.map((s) => ({ type: s && s.type, content: s && s.content }))
      : [],
    description: page.description,
    customJs: page.customJs,
  };
  return JSON.stringify(slim);
}

function diffThemeKeys(fromTheme, toTheme) {
  const keys = new Set([
    ...Object.keys(fromTheme || {}),
    ...Object.keys(toTheme || {}),
  ]);
  const changed = [];
  for (const k of keys) {
    const a = fromTheme ? fromTheme[k] : undefined;
    const b = toTheme ? toTheme[k] : undefined;
    if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(k);
  }
  changed.sort();
  return changed;
}

function sitesDiff(workspaceId, id, args = {}) {
  return withDb(workspaceId, (db) => {
    websiteEngine().ensureTables(db);
    const websiteId = Number(id);
    websiteEngine().getWebsite(db, websiteId);
    if (args.from == null || args.to == null) {
      throw siteErr('INVALID_ARGS', 'from and to are required (version_no or version row id).');
    }
    const resolveVersion = (ref) => {
      const n = Number(ref);
      if (!Number.isInteger(n) || n < 1) {
        throw siteErr('INVALID_ARGS', 'from and to must be positive integers (version_no or version id).');
      }
      let v = db.prepare(
        'SELECT * FROM website_versions WHERE website_id = ? AND version_no = ?'
      ).get(websiteId, n);
      if (!v) {
        v = db.prepare(
          'SELECT * FROM website_versions WHERE id = ? AND website_id = ?'
        ).get(n, websiteId);
      }
      if (!v) throw siteErr('NOT_FOUND', `Version ${ref} not found for website ${websiteId}.`);
      return v;
    };
    const fromV = resolveVersion(args.from);
    const toV = resolveVersion(args.to);
    const from = parseVersionPagesTheme(fromV);
    const to = parseVersionPagesTheme(toV);
    const fromSlugs = new Set(from.pages.map((p) => p.slug).filter(Boolean));
    const toSlugs = new Set(to.pages.map((p) => p.slug).filter(Boolean));
    const pagesAdded = [...toSlugs].filter((s) => !fromSlugs.has(s)).sort();
    const pagesRemoved = [...fromSlugs].filter((s) => !toSlugs.has(s)).sort();
    const pagesChanged = [];
    for (const slug of [...fromSlugs].filter((s) => toSlugs.has(s))) {
      const fp = from.pages.find((p) => p.slug === slug);
      const tp = to.pages.find((p) => p.slug === slug);
      if (pageContentFingerprint(fp) !== pageContentFingerprint(tp)) pagesChanged.push(slug);
    }
    pagesChanged.sort();
    const fromCounts = sectionTypeCountsForPages(from.pages);
    const toCounts = sectionTypeCountsForPages(to.pages);
    const sectionTypes = {};
    const allSlugs = new Set([...Object.keys(fromCounts), ...Object.keys(toCounts)]);
    for (const slug of allSlugs) {
      const a = fromCounts[slug] || {};
      const b = toCounts[slug] || {};
      const types = new Set([...Object.keys(a), ...Object.keys(b)]);
      const delta = {};
      for (const t of types) {
        const d = (b[t] || 0) - (a[t] || 0);
        if (d !== 0) delta[t] = d;
      }
      if (Object.keys(delta).length) sectionTypes[slug] = delta;
    }
    return {
      websiteId,
      from: { version_no: fromV.version_no, version_id: fromV.id, note: fromV.note, author: fromV.author || null },
      to: { version_no: toV.version_no, version_id: toV.id, note: toV.note, author: toV.author || null },
      pagesAdded,
      pagesRemoved,
      pagesChanged,
      sectionTypeCounts: sectionTypes,
      themeKeysChanged: diffThemeKeys(from.theme, to.theme),
    };
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
  assertNoSectionScripts(pages);
  return pages;
}

const PAGE_TOP_KEYS = new Set([
  'slug', 'title', 'sections', 'html', 'description', 'ogImage', 'canonical', 'customJs', 'customHead',
  'chromeOverride', 'navVisible', 'nav_visible', 'hiddenInNav', 'hidden_in_nav', 'menuParent', 'menu_parent',
]);
const SECTION_TOP_KEYS = new Set(['type', 'content', 'cols', 'cells']);
const THEME_TOP_KEYS = new Set([
  'primary', 'secondary', 'bg', 'text', 'font', 'headingFont', 'customCss', 'customJs', 'customHead', 'favicon',
  'logoMode', 'logoUrl', 'brandName', 'partials', 'colors', 'baseCss',
]);

/** Author <script> inside section HTML is not a sanctioned channel — use customJs/customHead. */
function assertNoSectionScripts(pages) {
  if (!Array.isArray(pages)) return;
  const scriptRe = /<script\b/i;
  const managedRe = /data-bitpype-[a-z0-9_-]+-script|\/js\/[a-z0-9_-]+-embed\.js/i;
  const stripManaged = (html) => String(html || '')
    .replace(/<script\b[^>]*data-bitpype-[a-z0-9_-]+-script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*\/js\/[a-z0-9_-]+-embed\.js[^>]*>[\s\S]*?<\/script>/gi, '');
  pages.forEach((p, i) => {
    if (!p || typeof p !== 'object') return;
    const slug = p.slug || i;
    if (Array.isArray(p.sections)) {
      p.sections.forEach((s, j) => {
        if (!s || typeof s !== 'object') return;
        const walk = (val, path) => {
          if (typeof val === 'string' && scriptRe.test(val)) {
            const rest = stripManaged(val);
            if (scriptRe.test(rest) && !managedRe.test(val)) {
              const e = siteErr(
                'SECTION_SCRIPT',
                `pages[${i}] (${slug}) sections[${j}]${path} contains <script>. Use theme.customJs / page.customJs or theme.customHead / page.customHead instead — scripts inside section HTML are rejected.`
              );
              e.status = 422;
              throw e;
            }
            // Managed embed loaders only — still reject any leftover author script.
            if (scriptRe.test(rest)) {
              const e = siteErr(
                'SECTION_SCRIPT',
                `pages[${i}] (${slug}) sections[${j}]${path} contains a non-managed <script>. Use customJs/customHead.`
              );
              e.status = 422;
              throw e;
            }
          }
          if (val && typeof val === 'object') {
            if (Array.isArray(val)) val.forEach((v, k) => walk(v, `${path}[${k}]`));
            else Object.keys(val).forEach((k) => walk(val[k], `${path}.${k}`));
          }
        };
        walk(s.content, '.content');
        if (Array.isArray(s.cells)) walk(s.cells, '.cells');
      });
    }
  });
}

function collectSaveShapeWarnings(pages, theme) {
  const warnings = [];
  if (Array.isArray(pages)) {
    pages.forEach((p, i) => {
      if (!p || typeof p !== 'object') return;
      for (const k of Object.keys(p)) {
        if (!PAGE_TOP_KEYS.has(k)) {
          warnings.push(
            `pages[${i}] has unknown key "${k}" — use slug, title, sections[] (type + content object), html, description, ogImage, canonical, customJs, customHead, chromeOverride.`
          );
        }
      }
      if (Array.isArray(p.sections)) {
        p.sections.forEach((s, j) => {
          if (!s || typeof s !== 'object') return;
          for (const sk of Object.keys(s)) {
            if (!SECTION_TOP_KEYS.has(sk)) {
              warnings.push(
                `pages[${i}].sections[${j}] has unknown key "${sk}" — use type, content, cols, cells (columns layout).`
              );
            }
          }
        });
      }
    });
  }
  if (theme && typeof theme === 'object' && !Array.isArray(theme)) {
    for (const k of Object.keys(theme)) {
      if (!THEME_TOP_KEYS.has(k)) {
        warnings.push(
          `theme has unknown key "${k}" — use primary, secondary, bg, text, font, headingFont, customCss, customJs, customHead, favicon, partials.{headerHtml,footerHtml}, logoMode, logoUrl.`
        );
      }
    }
  }
  return warnings;
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
    preview_url: site.preview_url || null,
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
    const engine = websiteEngine();
    let pages = validatePages(parseJsonField(args.pages, 'pages'));
    pages = engine.normalizePagesNavLinks(pages);
    try {
      pages = require('../src/siteStructure').syncFreeformNavOrder(pages);
    } catch { /* optional */ }
    let warnings = collectSaveShapeWarnings(pages, args.theme && typeof args.theme === 'object' ? args.theme : null);
    try {
      const existing = engine.getWebsite(db, siteId);
      if (existing && existing.lead_id) {
        const forms = require('./contactForms');
        const sanitized = forms.sanitizeAgentPages(db, existing.lead_id, pages, {
          workspaceId,
          appUrl: (() => { try { return require('./stripeClient').appUrl(); } catch { return ''; } })(),
        });
        pages = sanitized.pages;
        for (const w of sanitized.warnings || []) {
          if (!warnings.includes(w)) warnings.push(w);
        }
        try {
          const moduleFit = require('./moduleFit');
          for (const w of moduleFit.warningsForPages(pages)) {
            if (!warnings.includes(w)) warnings.push(w);
          }
        } catch { /* optional */ }
      }
    } catch (e) {
      console.warn('[domain] sanitizeAgentPages on sitesSave:', e.message);
    }
    let theme = args.theme;
    if (theme == null || theme === '') {
      const existing = engine.getWebsite(db, siteId);
      theme = parseJsonField(existing.theme, 'theme') || {};
    } else {
      theme = parseJsonField(theme, 'theme');
    }
    if (!theme || typeof theme !== 'object' || Array.isArray(theme)) {
      throw siteErr('INVALID_THEME', 'theme must be an object.');
    }
    for (const w of collectSaveShapeWarnings([], theme)) {
      if (!warnings.includes(w)) warnings.push(w);
    }
    let note = args.note;
    if (note != null && typeof note !== 'string') throw siteErr('INVALID_NOTE', 'note must be a string.');
    if (typeof note === 'string') note = note.slice(0, 500);
    const version = engine.saveSite(db, siteId, pages, theme, note, args.author || args.versionAuthor || null);
    try {
      const site = websiteEngine().getWebsite(db, siteId);
      if (site && site.lead_id) {
        require('./contactForms').ensureSiteForms(db, site.lead_id, {
          workspaceId,
          pages,
          missingOnly: true,
        });
        try { require('./siteModules').syncPublishedModules(db, site.lead_id); } catch { /* */ }
        // Keep Design Delivery preview in sync — website.edit/setTheme used to
        // update websites only, leaving deliverable.theme without customCss.
        try {
          const job = db.prepare(
            `SELECT id, deliverable FROM design_jobs
             WHERE (website_id = ? OR lead_id = ?)
             ORDER BY CASE WHEN website_id = ? THEN 0 ELSE 1 END, id DESC LIMIT 1`
          ).get(siteId, site.lead_id, siteId);
          if (job && job.deliverable) {
            const payloadJob = typeof job.deliverable === 'string'
              ? JSON.parse(job.deliverable || 'null')
              : job.deliverable;
            if (payloadJob && typeof payloadJob === 'object') {
              payloadJob.pages = pages;
              payloadJob.theme = theme;
              db.prepare(
                `UPDATE design_jobs SET deliverable = ?, website_id = ?, updated_at = datetime('now') WHERE id = ?`
              ).run(JSON.stringify(payloadJob), siteId, job.id);
            }
          }
        } catch (syncErr) {
          console.warn('[domain] design deliverable sync on sitesSave:', syncErr.message || syncErr);
        }
      }
    } catch (e) {
      console.warn('[domain] ensureSiteForms on sitesSave:', e.message);
    }
    try { materializeWebsiteExport(db, workspaceId, siteId); } catch { /* preview can retry */ }
    logActivity(db, 'websites', `Website #${siteId} saved (version ${version.version_no}).`);
    return {
      id: siteId,
      version: { id: version.id, version_no: version.version_no },
      warnings,
    };
  });
}

async function sitesScreenshotsList(workspaceId, opts = {}) {
  return withDb(workspaceId, async (db) => {
    const shots = require('../src/siteScreenshots');
    shots.ensureTables(db);
    const rows = shots.listScreenshots(db, {
      websiteId: opts.websiteId != null ? opts.websiteId : opts.id,
      leadId: opts.leadId,
      currentOnly: opts.currentOnly !== false,
      kind: opts.kind,
    });
    if (opts.checkReady) {
      return { screenshots: await shots.enrichReady(rows) };
    }
    return { screenshots: rows };
  });
}

async function sitesScreenshotsCapture(workspaceId, id, opts = {}) {
  const siteId = Number(id);
  if (!Number.isInteger(siteId) || siteId <= 0) throw siteErr('INVALID_ID', 'id must be an integer.');
  // Ensure a live preview URL exists before capturing.
  let previewUrl = opts.previewUrl || null;
  if (!previewUrl || opts.forcePreview) {
    try {
      const preview = await sitesPreview(workspaceId, siteId, { force: !!opts.forcePreview });
      previewUrl = preview && (preview.url || preview.indexUrl) || previewUrl;
    } catch (e) {
      if (!previewUrl) throw e;
    }
  }
  return withDb(workspaceId, async (db) => {
    const shots = require('../src/siteScreenshots');
    const site = websiteEngine().getWebsite(db, siteId);
    return shots.captureWebsiteScreenshots(db, siteId, {
      previewUrl: previewUrl || site.preview_url,
      leadId: opts.leadId != null ? opts.leadId : site.lead_id,
      designJobId: opts.designJobId,
    });
  });
}

/** Visual menu + section summary (WordPress-style one-level submenus via menuParent). */
function sitesGetStructure(workspaceId, id) {
  const structure = require('../src/siteStructure');
  return withDb(workspaceId, (db) => {
    const siteId = Number(id);
    if (!Number.isInteger(siteId)) throw siteErr('INVALID_ID', 'id must be an integer.');
    const engine = websiteEngine();
    const site = engine.getWebsite(db, siteId);
    let pages = parseJsonField(site.pages, 'pages');
    if (!Array.isArray(pages)) pages = [];
    const summary = structure.summarizeStructure(pages);
    return { siteId: site.id, menu: summary.menu, pages: summary.pages };
  });
}

/**
 * Reorder menu (pages[]) or page sections. Banner/hero/nav stay pinned.
 * body: { scope: 'menu'|'sections', pageIndex?, fromIndex, direction?: -1|1,
 *         action?: 'move'|'nest'|'unnest' }
 */
function sitesReorderStructure(workspaceId, id, body = {}) {
  const structure = require('../src/siteStructure');
  const scope = String(body.scope || '').toLowerCase();
  const fromIndex = Number(body.fromIndex);
  const action = String(body.action || 'move').toLowerCase();
  const isNest = action === 'nest' || action === 'indent';
  const isUnnest = action === 'unnest' || action === 'outdent';
  const isToggleNav = action === 'togglenav' || action === 'toggle-nav' || action === 'toggle_nav';
  if (scope !== 'menu' && scope !== 'sections') {
    throw Object.assign(new Error('scope must be menu or sections'), { code: 'INVALID' });
  }
  if (!Number.isInteger(fromIndex) || fromIndex < 0) {
    throw Object.assign(new Error('Invalid fromIndex'), { code: 'INVALID' });
  }
  if (scope === 'sections' || (!isNest && !isUnnest && !isToggleNav)) {
    const direction = Number(body.direction);
    if (direction !== 1 && direction !== -1) {
      throw Object.assign(new Error('direction must be 1 or -1'), { code: 'INVALID' });
    }
  }

  const prepared = withDb(workspaceId, (db) => {
    const siteId = Number(id);
    if (!Number.isInteger(siteId)) throw siteErr('INVALID_ID', 'id must be an integer.');
    const engine = websiteEngine();
    const site = engine.getWebsite(db, siteId);
    let pages = parseJsonField(site.pages, 'pages');
    if (!Array.isArray(pages) || !pages.length) {
      throw Object.assign(new Error('No pages on this website'), { code: 'NO_SITE' });
    }
    let result;
    if (scope === 'menu') {
      result = structure.applyMenuAction(pages, {
        action: isToggleNav ? 'toggleNav' : (isNest ? 'nest' : (isUnnest ? 'unnest' : 'move')),
        fromIndex,
        direction: body.direction,
      });
    } else {
      const pageIndex = Number(body.pageIndex);
      if (!Number.isInteger(pageIndex) || pageIndex < 0) {
        throw Object.assign(new Error('Invalid pageIndex'), { code: 'INVALID' });
      }
      result = structure.reorderSections(pages, pageIndex, fromIndex, Number(body.direction));
    }
    if (!result.changed) {
      throw Object.assign(new Error('Cannot move that item'), { code: 'NO_MOVE' });
    }
    const theme = parseJsonField(site.theme, 'theme') || {};
    return { siteId, pages: result.pages, theme };
  });

  const note = scope === 'menu'
    ? (isToggleNav ? 'Menu visibility updated'
      : (isNest ? 'Nested menu item' : (isUnnest ? 'Unnested menu item' : 'Reordered menu')))
    : 'Reordered sections';
  const saved = sitesSave(workspaceId, prepared.siteId, {
    pages: prepared.pages,
    theme: prepared.theme,
    note,
  });
  const summary = structure.summarizeStructure(prepared.pages);
  return {
    siteId: prepared.siteId,
    scope,
    version: saved.version,
    pages: prepared.pages,
    menu: summary.menu,
    structurePages: summary.pages,
  };
}

/**
 * Insert a page section (Page → Section → Block).
 * body: { pageIndex, afterIndex, sectionType?, cols?, html? }
 * sectionType "section" (default) = empty ws-page-section container.
 */
function sitesInsertSection(workspaceId, id, body = {}) {
  const structure = require('../src/siteStructure');
  const pageIndex = Number(body.pageIndex);
  const afterIndex = Number(body.afterIndex);
  const sectionType = String(body.sectionType || body.section_type || body.type || 'section').trim().toLowerCase() || 'section';
  const cols = body.cols != null ? Number(body.cols) : undefined;
  const html = body.html != null ? String(body.html) : undefined;
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw Object.assign(new Error('Invalid pageIndex'), { code: 'INVALID' });
  }
  if (!Number.isInteger(afterIndex) || afterIndex < -1) {
    throw Object.assign(new Error('Invalid afterIndex'), { code: 'INVALID' });
  }

  const prepared = withDb(workspaceId, (db) => {
    const siteId = Number(id);
    if (!Number.isInteger(siteId)) throw siteErr('INVALID_ID', 'id must be an integer.');
    const engine = websiteEngine();
    const site = engine.getWebsite(db, siteId);
    let pages = parseJsonField(site.pages, 'pages');
    if (!Array.isArray(pages) || !pages.length) {
      throw Object.assign(new Error('No pages on this website'), { code: 'NO_SITE' });
    }
    const result = structure.insertContentSection(pages, pageIndex, afterIndex, sectionType, { cols, html });
    if (!result.changed) {
      throw Object.assign(
        new Error(result.reason === 'no_sections'
          ? 'Page has no modular sections'
          : 'Cannot insert that section type'),
        { code: 'NO_MOVE' }
      );
    }
    const theme = parseJsonField(site.theme, 'theme') || {};
    return { siteId, pages: result.pages, theme, sectionIndex: result.sectionIndex };
  });

  const saved = sitesSave(workspaceId, prepared.siteId, {
    pages: prepared.pages,
    theme: prepared.theme,
    note: `Inserted ${sectionType} section`,
  });
  const summary = structure.summarizeStructure(prepared.pages);
  return {
    siteId: prepared.siteId,
    version: saved.version,
    sectionType,
    sectionIndex: prepared.sectionIndex,
    pages: prepared.pages,
    menu: summary.menu,
    structurePages: summary.pages,
  };
}

/**
 * Add a block into an existing section (or columns cell).
 * body: { pageIndex, sectionIndex, blockType, cols?, cellIndex?, moduleType?, formId?, formToken?, html?, content? }
 */
function sitesAddBlock(workspaceId, id, body = {}) {
  const structure = require('../src/siteStructure');
  const modules = require('./siteModules');
  const forms = require('./contactForms');
  const pageIndex = Number(body.pageIndex);
  const sectionIndex = Number(body.sectionIndex);
  let blockType = String(body.blockType || body.type || '').trim().toLowerCase();
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw Object.assign(new Error('Invalid pageIndex'), { code: 'INVALID' });
  }
  if (!Number.isInteger(sectionIndex) || sectionIndex < 0) {
    throw Object.assign(new Error('Invalid sectionIndex'), { code: 'INVALID' });
  }
  if (!blockType) {
    throw Object.assign(new Error('blockType is required'), { code: 'INVALID' });
  }

  const prepared = withDb(workspaceId, (db) => {
    const siteId = Number(id);
    if (!Number.isInteger(siteId)) throw siteErr('INVALID_ID', 'id must be an integer.');
    const engine = websiteEngine();
    const site = engine.getWebsite(db, siteId);
    let pages = parseJsonField(site.pages, 'pages');
    if (!Array.isArray(pages) || !pages.length) {
      throw Object.assign(new Error('No pages on this website'), { code: 'NO_SITE' });
    }
    const cols = body.cols != null ? Number(body.cols) : undefined;
    const cellIndex = body.cellIndex != null ? Number(body.cellIndex) : undefined;
    let html = body.html != null ? String(body.html) : undefined;
    let content = body.content && typeof body.content === 'object' ? body.content : undefined;
    let widget = undefined;
    const intoCell = Number.isInteger(cellIndex) && cellIndex >= 0;
    const leadId = site.lead_id;

    if (blockType === 'module' || blockType === 'site_module' || blockType === 'widget') {
      const moduleType = String(body.moduleType || body.module_type || body.module || '').trim().toLowerCase();
      if (!moduleType) throw Object.assign(new Error('moduleType is required'), { code: 'INVALID' });
      if (!leadId) throw Object.assign(new Error('Website has no lead'), { code: 'NO_SITE' });
      modules.ensureTables(db);
      const attached = modules.attachModule(db, Number(leadId), moduleType, {
        workspaceId,
        embed_enabled: 1,
        toSite: false,
      });
      const embed = attached && attached.embed;
      if (!embed || !embed.public_token) {
        throw Object.assign(new Error('Could not enable module embed'), { code: 'INVALID' });
      }
      html = modules.embedBlockHtml(embed, undefined);
      if (intoCell) {
        widget = {
          type: 'site_module',
          public_token: embed.public_token,
          module_type: moduleType,
          html,
        };
        content = widget;
      } else {
        blockType = 'html';
        content = undefined;
      }
    } else if (blockType === 'form' || blockType === 'bitpype_form') {
      if (!leadId) throw Object.assign(new Error('Website has no lead'), { code: 'NO_SITE' });
      forms.ensureTables(db);
      let row = null;
      if (body.formId != null) row = forms.getFormRowById(db, Number(leadId), Number(body.formId));
      if (!row && (body.formToken || body.form_token)) {
        row = db.prepare(
          'SELECT * FROM contact_forms WHERE lead_id = ? AND public_token = ?'
        ).get(Number(leadId), String(body.formToken || body.form_token));
      }
      if (!row) {
        const list = forms.listFormRows(db, Number(leadId));
        row = (list || [])[0] || null;
      }
      if (!row || !row.public_token) {
        throw Object.assign(new Error('No form available'), { code: 'NOT_FOUND' });
      }
      db.prepare(
        `UPDATE contact_forms SET published = 1, embed_enabled = 1, updated_at = datetime('now') WHERE id = ?`
      ).run(row.id);
      html = forms.embedBlockHtml(forms.publicForm(row, []), undefined);
      if (intoCell) {
        widget = {
          type: 'form',
          form_token: row.public_token,
          formId: row.id,
          html,
        };
        content = widget;
      } else {
        blockType = 'html';
        content = undefined;
      }
    }

    const result = structure.insertBlockIntoSection(pages, pageIndex, sectionIndex, blockType, {
      cols,
      cellIndex,
      html,
      content,
      widget,
    });
    if (!result.changed) {
      throw Object.assign(
        new Error(result.reason === 'no_sections'
          ? 'Page has no modular sections'
          : (result.reason || 'Cannot insert that block')),
        { code: 'NO_MOVE' }
      );
    }
    const theme = parseJsonField(site.theme, 'theme') || {};
    return {
      siteId,
      pages: result.pages,
      theme,
      blockType,
      sectionIndex: result.sectionIndex,
      cellIndex: result.cellIndex,
    };
  });

  const saved = sitesSave(workspaceId, prepared.siteId, {
    pages: prepared.pages,
    theme: prepared.theme,
    note: `Added block ${prepared.blockType}`,
  });
  const summary = structure.summarizeStructure(prepared.pages);
  const warnings = Array.isArray(saved.warnings) ? saved.warnings.slice() : [];
  const bt = String(prepared.blockType || body.blockType || body.type || '').toLowerCase();
  if (bt === 'form' || bt === 'bitpype_form' || bt === 'contact_form' || bt === 'html') {
    try {
      const moduleFit = require('./moduleFit');
      const w = moduleFit.formOnAppointmentPageWarning(prepared.pages, Number(body.pageIndex));
      if (w && !warnings.includes(w)) warnings.push(w);
    } catch { /* optional */ }
  }
  return {
    siteId: prepared.siteId,
    version: saved.version,
    blockType: prepared.blockType,
    sectionIndex: prepared.sectionIndex,
    cellIndex: prepared.cellIndex,
    pages: prepared.pages,
    menu: summary.menu,
    structurePages: summary.pages,
    warnings,
  };
}

/**
 * Set site logo mode/image. Pass siteId, or leadId to resolve the client's site.
 * opts: { mode: 'text'|'image', buffer?, brandName?, note?, leadId? }
 */
const MAX_SITE_IMAGE_BYTES = Math.floor(5.5 * 1024 * 1024);

async function sitesSetLogo(workspaceId, siteId, opts = {}) {
  const fs = require('fs');
  const path = require('path');
  const openPreview = require('../src/openPreview');
  const logoProcess = require('../src/logoProcess');

  const mode = String(opts.mode || (opts.buffer ? 'image' : 'text')).trim().toLowerCase();
  const brandName = opts.brandName != null ? String(opts.brandName).trim().slice(0, 120) : undefined;

  let resolvedId = siteId != null ? Number(siteId) : null;
  const prepared = await withDb(workspaceId, async (db) => {
    if (!resolvedId && opts.leadId != null) {
      const row = db.prepare(
        'SELECT id FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
      ).get(Number(opts.leadId));
      if (!row) {
        const e = new Error('No website is available for this lead');
        e.code = 'NO_SITE';
        throw e;
      }
      resolvedId = row.id;
    }
    if (!Number.isInteger(resolvedId) || resolvedId < 1) {
      throw siteErr('INVALID_ID', 'id must be an integer.');
    }

    const engine = websiteEngine();
    const site = engine.getWebsite(db, resolvedId);
    let pages = parseJsonField(site.pages, 'pages') || [];
    const theme = Object.assign({}, parseJsonField(site.theme, 'theme') || {});
    if (brandName !== undefined) theme.brandName = brandName;

    let logoRel = null;
    let pngBuffer = null;

    if (mode === 'text') {
      theme.logoMode = 'text';
      theme.logoUrl = '';
      pages = logoProcess.clearLogoMarkupFromPages(pages);
    } else {
      if (!Buffer.isBuffer(opts.buffer) || !opts.buffer.length) {
        const e = new Error('Logo image data is required for image mode');
        e.code = 'EMPTY';
        throw e;
      }
      if (opts.buffer.length > MAX_SITE_IMAGE_BYTES) {
        const e = new Error(`Logo image must be at most ${MAX_SITE_IMAGE_BYTES} bytes`);
        e.code = 'TOO_LARGE';
        throw e;
      }
      const processed = await logoProcess.processLogoBuffer(opts.buffer);
      pngBuffer = processed.buffer;
      logoRel = 'images/logo.png';

      const folder = resolveSiteExportFolder(workspaceId, {
        id: resolvedId,
        preview_path: site.preview_path,
        export_slug: site.export_slug,
      }, db);
      const imgDir = path.join(openPreview.exportRoot(), folder, 'images');
      fs.mkdirSync(imgDir, { recursive: true });
      fs.writeFileSync(path.join(imgDir, 'logo.png'), pngBuffer);

      theme.logoMode = 'image';
      theme.logoUrl = logoRel;
      const label = theme.brandName || site.name || 'Logo';
      pages = logoProcess.applyLogoMarkupToPages(pages, logoRel, label);

      try {
        const job = db.prepare(
          `SELECT id, deliverable FROM design_jobs
           WHERE (website_id = ? OR lead_id = ?)
           ORDER BY CASE WHEN website_id = ? THEN 0 ELSE 1 END, id DESC LIMIT 1`
        ).get(resolvedId, site.lead_id, resolvedId);
        if (job && job.deliverable) {
          const payloadJob = typeof job.deliverable === 'string'
            ? JSON.parse(job.deliverable || 'null')
            : job.deliverable;
          if (payloadJob && typeof payloadJob === 'object') {
            if (Array.isArray(payloadJob.pages)) payloadJob.pages = pages;
            payloadJob.theme = theme;
            if (!Array.isArray(payloadJob.images)) payloadJob.images = [];
            payloadJob.images.push({
              name: 'logo.png',
              path: path.join(imgDir, 'logo.png'),
              url: logoRel,
              source: 'logo',
              role: 'logo',
            });
            db.prepare(
              `UPDATE design_jobs SET deliverable = ?, updated_at = datetime('now') WHERE id = ?`
            ).run(JSON.stringify(payloadJob), job.id);
          }
        }
      } catch { /* optional */ }
    }

    return {
      siteId: resolvedId,
      pages,
      theme,
      logoRel,
      pngBuffer,
      leadId: site.lead_id,
    };
  });

  const saved = sitesSave(workspaceId, prepared.siteId, {
    pages: prepared.pages,
    theme: prepared.theme,
    note: opts.note || (mode === 'text' ? 'Logo mode: text' : 'Logo upload'),
  });

  // Rematerialize can rebuild images/; ensure logo.png survives on the slug folder.
  if (prepared.pngBuffer) {
    try {
      const previewRow = withDb(workspaceId, (db) =>
        db.prepare('SELECT preview_url, preview_path, export_slug FROM websites WHERE id = ?').get(prepared.siteId)
      );
      const folder = resolveSiteExportFolder(workspaceId, {
        id: prepared.siteId,
        preview_path: previewRow && previewRow.preview_path,
        export_slug: previewRow && previewRow.export_slug,
      });
      const dest = path.join(openPreview.exportRoot(), folder, 'images', 'logo.png');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, prepared.pngBuffer);
    } catch { /* best effort */ }
  }

  const previewRow = withDb(workspaceId, (db) =>
    db.prepare('SELECT preview_url, preview_path, export_slug FROM websites WHERE id = ?').get(prepared.siteId)
  );
  const previewUrl = previewRow && (previewRow.preview_url || null);
  const assetBase = (() => {
    try {
      const portal = require('./clientPortal');
      return portal.resolveExportPreviewBase(workspaceId, {
        id: prepared.siteId,
        preview_url: previewUrl,
        preview_path: previewRow && previewRow.preview_path,
        export_slug: previewRow && previewRow.export_slug,
      });
    } catch {
      return null;
    }
  })();

  const publicUrl = prepared.logoRel && assetBase
    ? `${String(assetBase).replace(/\/+$/, '')}/${prepared.logoRel}`
    : null;

  return {
    siteId: prepared.siteId,
    mode: mode === 'text' ? 'text' : 'image',
    logoUrl: prepared.logoRel,
    publicUrl,
    brandName: prepared.theme.brandName || null,
    version: saved.version,
    previewUrl,
  };
}

const THEME_COLOR_KEYS = ['primary', 'secondary', 'bg', 'text'];

function normalizeThemeHex(value) {
  let s = String(value == null ? '' : value).trim();
  if (!s) return null;
  if (s[0] !== '#') s = `#${s}`;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) return null;
  return s.toLowerCase();
}

function rewriteThemeHexInCss(css, oldTheme, newTheme) {
  let out = String(css || '');
  if (!out) return out;
  for (const key of THEME_COLOR_KEYS) {
    const prev = oldTheme[key];
    const next = newTheme[key];
    if (!prev || !next || String(prev).toLowerCase() === String(next).toLowerCase()) continue;
    const re = new RegExp(String(prev).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, next);
  }
  return out;
}

/**
 * Set website theme colors (primary/secondary/bg/text). Rewrites matching hexes
 * in theme.customCss. Pass id (website) or leadId. Same color model as the client portal.
 */
async function sitesSetTheme(workspaceId, siteId, opts = {}) {
  const colors = opts.colors && typeof opts.colors === 'object' ? opts.colors : opts;
  const patch = {};
  for (const key of THEME_COLOR_KEYS) {
    if (colors[key] == null || colors[key] === '') continue;
    const hex = normalizeThemeHex(colors[key]);
    if (!hex) throw siteErr('INVALID_COLOR', `Invalid ${key} color (use #RRGGBB)`);
    patch[key] = hex;
  }
  try {
    const googleFonts = require('../public/js/fonts.js');
    if (opts.font != null && String(opts.font).trim()) {
      patch.font = googleFonts.safeStack(opts.font);
    } else if (colors.font != null && String(colors.font).trim()) {
      patch.font = googleFonts.safeStack(colors.font);
    }
    if (opts.headingFont != null) {
      const heading = String(opts.headingFont).trim();
      patch.headingFont = heading ? googleFonts.safeStack(heading) : '';
    } else if (colors.headingFont != null) {
      const heading = String(colors.headingFont).trim();
      patch.headingFont = heading ? googleFonts.safeStack(heading) : '';
    }
  } catch { /* fonts module optional */ }
  if (opts.customCss != null) patch.customCss = String(opts.customCss);
  if (opts.customJs != null) patch.customJs = String(opts.customJs);
  if (opts.customHead != null) patch.customHead = String(opts.customHead);
  if (opts.custom_head != null && opts.customHead == null) patch.customHead = String(opts.custom_head);
  if (opts.favicon != null) patch.favicon = String(opts.favicon).trim();
  if (opts.baseCss != null) patch.baseCss = !!opts.baseCss;
  if (opts.partials && typeof opts.partials === 'object') {
    patch.partials = {
      headerHtml: opts.partials.headerHtml != null
        ? String(opts.partials.headerHtml)
        : (opts.partials.header != null ? String(opts.partials.header) : undefined),
      footerHtml: opts.partials.footerHtml != null
        ? String(opts.partials.footerHtml)
        : (opts.partials.footer != null ? String(opts.partials.footer) : undefined),
    };
  }
  if (!Object.keys(patch).length) {
    throw siteErr('EMPTY', 'Provide at least one theme field (colors, fonts, customCss/Js, favicon, partials).');
  }

  let resolvedId = siteId != null ? Number(siteId) : null;
  const prepared = withDb(workspaceId, (db) => {
    if (!resolvedId && opts.leadId != null) {
      const row = db.prepare(
        'SELECT id FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
      ).get(Number(opts.leadId));
      if (!row) throw siteErr('NO_SITE', 'No website is available for this lead');
      resolvedId = row.id;
    }
    if (!Number.isInteger(resolvedId) || resolvedId < 1) {
      throw siteErr('INVALID_ID', 'id must be an integer.');
    }
    const engine = websiteEngine();
    const site = engine.getWebsite(db, resolvedId);
    const pages = parseJsonField(site.pages, 'pages') || [];
    const oldTheme = parseJsonField(site.theme, 'theme') || {};
    const themePalette = require('../src/themePalette');
    const oldNorm = engine.normalizeTheme(oldTheme);
    const map = themePalette.buildReplacementMap(oldNorm, patch, opts.replacements || colors.replacements || []);
    const theme = Object.assign({}, oldTheme, patch);
    if (typeof theme.customCss === 'string' && theme.customCss && Object.keys(map).length) {
      theme.customCss = themePalette.rewriteHexMap(theme.customCss, map);
    }
    let nextPages = pages;
    if (Object.keys(map).length) {
      nextPages = themePalette.applyHexMapToPages(pages, map).pages;
    }
    const normalized = engine.normalizeTheme(theme);
    const { palette } = themePalette.extractPalette(nextPages, normalized);
    return {
      siteId: resolvedId,
      pages: nextPages,
      theme,
      fontsPatched: !!(patch.font || patch.headingFont),
      colors: {
        primary: normalized.primary,
        secondary: normalized.secondary,
        bg: normalized.bg,
        text: normalized.text,
        font: normalized.font,
        headingFont: normalized.headingFont || '',
        palette,
      },
    };
  });

  const saved = sitesSave(workspaceId, prepared.siteId, {
    pages: prepared.pages,
    theme: prepared.theme,
    note: opts.note
      || (prepared.fontsPatched ? 'MCP website.setTheme fonts' : 'MCP website.setTheme'),
  });
  return {
    siteId: prepared.siteId,
    colors: prepared.colors,
    version: saved.version,
  };
}

/**
 * Replace a site image by src path: upload base64 (data) or AI-generate from prompt.
 * AI path spends workspace credits unless the plan includes socialImagesIncluded.
 * Pass id (website) or leadId. replaceSrc is required (e.g. images/hero.jpg).
 */
async function sitesReplaceImage(workspaceId, siteId, opts = {}) {
  const portal = require('./clientPortal');
  let resolvedId = siteId != null ? Number(siteId) : null;
  const leadId = withDb(workspaceId, (db) => {
    if (!resolvedId && opts.leadId != null) {
      const row = db.prepare(
        'SELECT id, lead_id FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
      ).get(Number(opts.leadId));
      if (!row) throw siteErr('NO_SITE', 'No website is available for this lead');
      resolvedId = row.id;
      return Number(row.lead_id);
    }
    if (!Number.isInteger(resolvedId) || resolvedId < 1) {
      throw siteErr('INVALID_ID', 'id must be an integer.');
    }
    const site = websiteEngine().getWebsite(db, resolvedId);
    if (!site || !site.lead_id) throw siteErr('NO_LEAD', 'Website has no linked lead');
    return Number(site.lead_id);
  });

  const replaceSrc = String(opts.replaceSrc || opts.src || '').trim();
  if (!replaceSrc) throw siteErr('EMPTY', 'replaceSrc is required (e.g. images/hero.jpg)');

  const dataB64 = String(opts.data || opts.base64 || '')
    .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
    .replace(/\s+/g, '');
  const prompt = String(opts.prompt || opts.description || '').trim();

  if (dataB64) {
    if (dataB64.length > Math.ceil(MAX_SITE_IMAGE_BYTES * 4 / 3) + 256) {
      throw siteErr('TOO_LARGE', `Image must be at most ${MAX_SITE_IMAGE_BYTES} bytes`);
    }
    const result = await portal.applyClientImageUpload(workspaceId, leadId, {
      replaceSrc,
      data: dataB64,
      mimeType: opts.mimeType || opts.mime,
    });
    if (opts.crop && typeof opts.crop === 'object' && result && result.url) {
      try {
        await applyCropToSiteImage(workspaceId, resolvedId, result.url, opts.crop);
        result.crop = opts.crop;
      } catch (e) {
        console.warn('[domain] replaceImage crop skip:', e.message || e);
      }
    }
    return result;
  }
  if (prompt) {
    const result = await portal.generateClientSiteImage(workspaceId, leadId, {
      prompt,
      replaceSrc,
      size: opts.size,
      quality: opts.quality,
    }, opts.actorEmail || '');
    if (opts.crop && typeof opts.crop === 'object' && result && result.url) {
      try {
        await applyCropToSiteImage(workspaceId, resolvedId, result.url, opts.crop);
        result.crop = opts.crop;
      } catch (e) {
        console.warn('[domain] replaceImage crop skip:', e.message || e);
      }
    }
    return result;
  }
  throw siteErr('EMPTY', 'Provide data (base64 image) or prompt (AI replace).');
}

/** Apply focal crop to an images/ or assets/ file and stamp crop meta on pages. */
async function applyCropToSiteImage(workspaceId, siteId, imageUrl, cropOpts) {
  const fs = require('fs');
  const imageCrop = require('../src/imageCrop');
  const openPreview = require('../src/openPreview');
  const rel = String(imageUrl || '').replace(/^\.?\//, '');
  if (!/^(?:images|assets)\//i.test(rel)) return null;
  const abs = path.join(openPreview.exportRoot(), `site-${siteId}`, rel);
  if (!fs.existsSync(abs)) {
    // Also try slug export folder images/
    return null;
  }
  const input = fs.readFileSync(abs);
  const cropped = await imageCrop.cropBuffer(input, cropOpts);
  fs.writeFileSync(abs, cropped.buffer);
  const cropMeta = imageCrop.cropMetaFromResult(cropped, cropOpts);
  withDb(workspaceId, (db) => {
    const engine = websiteEngine();
    const site = engine.getWebsite(db, siteId);
    let pages = parseJsonField(site.pages, 'pages') || [];
    const theme = parseJsonField(site.theme, 'theme') || {};
    const stamp = (node) => {
      if (!node || typeof node !== 'object') return;
      if (typeof node.url === 'string' && (node.url === rel || node.url.endsWith('/' + path.basename(rel)))) {
        node.crop = Object.assign({}, cropMeta);
      }
      if (Array.isArray(node)) node.forEach(stamp);
      else Object.values(node).forEach(stamp);
    };
    stamp(pages);
    engine.saveSite(db, siteId, pages, theme, `Crop ${rel}`);
  });
  return cropMeta;
}

/**
 * Upload a stable asset to assets/<filename> (never renamed by optimize).
 */
function sitesUploadAsset(workspaceId, siteId, opts = {}) {
  const fs = require('fs');
  const openPreview = require('../src/openPreview');
  let resolvedId = siteId != null ? Number(siteId) : null;
  return withDb(workspaceId, (db) => {
    if (!resolvedId && opts.websiteId != null) resolvedId = Number(opts.websiteId);
    if (!resolvedId && opts.leadId != null) {
      const row = db.prepare(
        'SELECT id FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
      ).get(Number(opts.leadId));
      if (!row) throw siteErr('NO_SITE', 'No website is available for this lead');
      resolvedId = row.id;
    }
    if (!Number.isInteger(resolvedId) || resolvedId < 1) {
      throw siteErr('INVALID_ID', 'id must be an integer.');
    }
    let filename = String(opts.filename || opts.name || '').trim();
    filename = path.basename(filename).replace(/[^\w.\-()+ ]+/g, '_');
    if (!filename || filename === '.' || filename === '..') {
      throw siteErr('EMPTY', 'filename is required');
    }
    if (!/\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|mp4|webm)$/i.test(filename)) {
      throw siteErr('INVALID', 'Unsupported filename extension');
    }
    const dataB64 = String(opts.data || '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
    const maxBytes = /\.(mp4|webm)$/i.test(filename) ? 25 * 1024 * 1024 : 8 * 1024 * 1024;
    if (dataB64.length > Math.ceil(maxBytes * 4 / 3) + 256) {
      throw siteErr('TOO_LARGE', `Asset too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)`);
    }
    const buffer = Buffer.from(dataB64, 'base64');
    if (!buffer.length) throw siteErr('EMPTY', 'Empty asset data');
    const assetsDir = path.join(openPreview.exportRoot(), `site-${resolvedId}`, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    const dest = path.join(assetsDir, filename);
    fs.writeFileSync(dest, buffer);
    const url = `assets/${filename}`;
    if (opts.setFavicon) {
      const engine = websiteEngine();
      const site = engine.getWebsite(db, resolvedId);
      const pages = parseJsonField(site.pages, 'pages') || [];
      const theme = Object.assign({}, parseJsonField(site.theme, 'theme') || {}, { favicon: url });
      engine.saveSite(db, resolvedId, pages, theme, `uploadAsset favicon ${url}`);
    }
    // Rematerialize so /assets/* is in the publish folder before the next CF deploy.
    try { materializeWebsiteExport(db, workspaceId, resolvedId); } catch { /* preview can retry */ }
    return {
      siteId: resolvedId,
      url,
      path: dest,
      filename,
      bytes: buffer.length,
      mimeType: opts.mimeType || opts.mime || null,
      favicon: opts.setFavicon ? url : undefined,
    };
  });
}

/** Single viewport PNG screenshot for agents (website.screenshot). */
async function sitesScreenshot(workspaceId, siteId, opts = {}) {
  const siteIdNum = siteId != null ? Number(siteId) : (opts.websiteId != null ? Number(opts.websiteId) : null);
  if (!Number.isInteger(siteIdNum) || siteIdNum < 1) {
    throw siteErr('INVALID_ID', 'id must be an integer.');
  }
  return withDb(workspaceId, async (db) => {
    const shots = require('../src/siteScreenshots');
    shots.ensureTables(db);
    return shots.captureOneScreenshot(db, siteIdNum, {
      path: opts.path != null ? String(opts.path) : 'index.html',
      width: opts.width,
      height: opts.height,
      previewUrl: opts.previewUrl,
    });
  });
}

function formsAppUrl() {
  try { return require('./stripeClient').appUrl(); } catch { return String(process.env.APP_URL || '').replace(/\/$/, ''); }
}

/** MCP: list custom forms for a lead (or the lead attached to a site). */
function formsList(workspaceId, { leadId, websiteId, siteId } = {}) {
  return withDb(workspaceId, (db) => {
    const forms = require('./contactForms');
    let lid = leadId != null ? Number(leadId) : null;
    const wid = websiteId != null ? Number(websiteId) : (siteId != null ? Number(siteId) : null);
    if (!lid && wid) {
      const site = websiteEngine().getWebsite(db, wid);
      if (!site) throw siteErr('NOT_FOUND', 'Website not found');
      lid = Number(site.lead_id);
    }
    if (!lid) throw siteErr('INVALID_ID', 'leadId or websiteId required');
    forms.ensureTables(db);
    const list = forms.listFormsForLead(db, lid);
    const base = formsAppUrl();
    return {
      leadId: lid,
      forms: list.map((form) => ({ form, embed: forms.embedSnippet(form, base) })),
      pages: forms.listSitePages(db, lid),
    };
  });
}

/** MCP: get one form by id (or first form for lead). */
function formsGet(workspaceId, { leadId, formId, id, websiteId } = {}) {
  return withDb(workspaceId, (db) => {
    const forms = require('./contactForms');
    let lid = leadId != null ? Number(leadId) : null;
    if (!lid && websiteId != null) {
      const site = websiteEngine().getWebsite(db, Number(websiteId));
      if (!site) throw siteErr('NOT_FOUND', 'Website not found');
      lid = Number(site.lead_id);
    }
    if (!lid) throw siteErr('INVALID_ID', 'leadId required');
    const fid = formId != null ? Number(formId) : (id != null ? Number(id) : null);
    const form = fid != null
      ? forms.getFormById(db, lid, fid)
      : forms.getFormForLead(db, lid);
    const base = formsAppUrl();
    return { leadId: lid, form, embed: forms.embedSnippet(form, base) };
  });
}

/**
 * MCP: create a custom form, publish it, return id + managed embed snippet.
 * fields[]: { label, type|field_type: text|email|phone|tel|textarea|select|date|checkbox, required, options? }
 */
function formsCreate(workspaceId, body = {}) {
  return withDb(workspaceId, (db) => {
    const forms = require('./contactForms');
    const leadId = Number(body.leadId != null ? body.leadId : body.lead_id);
    if (!Number.isInteger(leadId) || leadId < 1) throw siteErr('INVALID_ID', 'leadId is required');
    const purpose = forms.normalizePurpose(body.purpose);
    const hasName = !!(body.name && String(body.name).trim()) || !!(body.title && String(body.title).trim());
    if (!hasName && !purpose) throw siteErr('INVALID_ARGS', 'name or purpose is required');
    const fields = Array.isArray(body.fields)
      ? body.fields.map((f, i) => forms.normalizeFieldInput(f, i))
      : undefined;
    // purpose alone is enough — name defaults from purpose meta
    const created = forms.createForm(db, leadId, {
      name: body.name,
      title: body.title || body.name,
      intro: body.intro,
      submit_label: body.submit_label != null ? body.submit_label : body.submitLabel,
      success_message: body.success_message != null ? body.success_message : body.successMessage,
      notify_email: body.notify_email != null ? body.notify_email : body.notifyEmail,
      fields,
      purpose: purpose || undefined,
      embed_enabled: body.embed_enabled != null ? body.embed_enabled
        : (body.embed_on_page != null ? body.embed_on_page : true),
      add_to_nav: body.add_to_nav != null ? body.add_to_nav
        : (body.nav_visible != null ? body.nav_visible : false),
      target_page_slug: body.target_page_slug || body.targetPageSlug || body.pageSlug,
      form_kind: body.form_kind || body.formKind || null,
    });
    const published = forms.publishForm(db, leadId, created.id, {
      workspaceId: Number(workspaceId),
      embed_enabled: body.embed_enabled != null ? body.embed_enabled
        : (body.embed_on_page != null ? body.embed_on_page : true),
      toSite: body.toSite === true,
      target_page_slug: body.target_page_slug || body.targetPageSlug,
    });
    const base = formsAppUrl();
    const embed = forms.embedSnippet(published, base);
    const warnings = [];
    try {
      const moduleFit = require('./moduleFit');
      const site = db.prepare(
        'SELECT pages FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
      ).get(leadId);
      const pages = site ? JSON.parse(site.pages || '[]') : [];
      const target = published.target_page_slug || body.target_page_slug || body.targetPageSlug;
      const w = moduleFit.formOnAppointmentPageWarning(pages, target);
      if (w && (purpose === 'general_inquiry' || purpose === 'appointment_request' || !purpose)) {
        warnings.push(w);
      }
    } catch { /* optional */ }
    return {
      leadId,
      form: published,
      formId: published.id,
      purpose: purpose || null,
      embed,
      sectionHint: {
        type: 'bitpype_form',
        content: { formId: published.id, form_token: published.public_token },
      },
      warnings,
      note: purpose === 'appointment_request'
        ? 'Typed appointment_request form created. Prefer website.addModule(bookings) for real availability; use this form only for waitlist-style requests. Place with website.addBlock (form) or bitpype_form section.'
        : 'Place with website.addBlock (blockType form + formId) or a bitpype_form/form section in pages. Wrap in a themed card/section; style via theme.customCss: section[data-ws-section-type="bitpype_form|contact_form"] and .bitpype-form-embed. INTENT: appointments with availability → bookings module; structured requests → purpose=…; general inquiries → contact form.',
    };
  });
}

/** MCP: suggest typed fields for a purpose without creating a form. */
function formsSuggestFields(workspaceId, body = {}) {
  return withDb(workspaceId, (db) => {
    const forms = require('./contactForms');
    const leadId = Number(body.leadId != null ? body.leadId : body.lead_id);
    if (!Number.isInteger(leadId) || leadId < 1) throw siteErr('INVALID_ID', 'leadId is required');
    const purpose = forms.normalizePurpose(body.purpose);
    if (!purpose) {
      throw siteErr(
        'INVALID',
        `purpose is required (${forms.FORM_PURPOSES.join('|')})`
      );
    }
    const suggested = forms.suggestFieldsForPurpose(db, leadId, purpose);
    return { leadId, ...suggested };
  });
}

/** MCP: update a form. */
function formsUpdate(workspaceId, body = {}) {
  return withDb(workspaceId, (db) => {
    const forms = require('./contactForms');
    const leadId = Number(body.leadId != null ? body.leadId : body.lead_id);
    const formId = Number(body.formId != null ? body.formId : body.id);
    if (!Number.isInteger(leadId) || leadId < 1) throw siteErr('INVALID_ID', 'leadId is required');
    if (!Number.isInteger(formId) || formId < 1) throw siteErr('INVALID_ID', 'formId is required');
    const patch = Object.assign({}, body);
    delete patch.leadId;
    delete patch.lead_id;
    delete patch.formId;
    delete patch.id;
    if (Array.isArray(body.fields)) {
      patch.fields = body.fields.map((f, i) => forms.normalizeFieldInput(f, i));
    }
    if (body.submitLabel != null && patch.submit_label == null) patch.submit_label = body.submitLabel;
    if (body.successMessage != null && patch.success_message == null) patch.success_message = body.successMessage;
    if (body.notifyEmail != null && patch.notify_email == null) patch.notify_email = body.notifyEmail;
    const form = forms.saveForm(db, leadId, formId, patch);
    const base = formsAppUrl();
    try {
      const site = db.prepare(
        'SELECT id FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
      ).get(leadId);
      if (site && form.published) materializeWebsiteExport(db, workspaceId, site.id);
    } catch { /* optional */ }
    return { leadId, form, embed: forms.embedSnippet(form, base) };
  });
}

/** MCP: delete a form (keeps at least one). */
function formsDelete(workspaceId, { leadId, formId, id } = {}) {
  return withDb(workspaceId, (db) => {
    const forms = require('./contactForms');
    const lid = Number(leadId);
    const fid = Number(formId != null ? formId : id);
    if (!Number.isInteger(lid) || lid < 1) throw siteErr('INVALID_ID', 'leadId is required');
    if (!Number.isInteger(fid) || fid < 1) throw siteErr('INVALID_ID', 'formId is required');
    const result = forms.deleteForm(db, lid, fid);
    try {
      const site = db.prepare(
        'SELECT id FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
      ).get(lid);
      if (site) materializeWebsiteExport(db, workspaceId, site.id);
    } catch { /* optional */ }
    return result;
  });
}

/** MCP / API: ensure contact/quote/appointment forms for a lead's site. */
function formsEnsureForSite(workspaceId, { leadId, websiteId } = {}) {
  return withDb(workspaceId, (db) => {
    let lid = leadId != null ? Number(leadId) : null;
    let pages = null;
    if (websiteId != null) {
      const site = websiteEngine().getWebsite(db, Number(websiteId));
      if (!site) throw siteErr('NOT_FOUND', 'Website not found');
      lid = lid || Number(site.lead_id);
      pages = parseJsonField(site.pages, 'pages');
    }
    if (!lid) throw siteErr('INVALID_ID', 'leadId or websiteId required');
    const result = require('./contactForms').ensureSiteForms(db, lid, {
      workspaceId,
      pages,
      missingOnly: true,
    });
    try { require('./siteModules').syncPublishedModules(db, lid); } catch { /* */ }
    const siteRow = db.prepare(
      'SELECT id FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
    ).get(lid);
    if (siteRow) {
      try { materializeWebsiteExport(db, workspaceId, siteRow.id); } catch { /* */ }
    }
    return result;
  });
}

/** MCP: attach / manage site modules (blog, ecommerce, courses, gallery, directory). */
function modulesAttach(workspaceId, leadId, moduleType, opts = {}) {
  return withDb(workspaceId, (db) => {
    const modules = require('./siteModules');
    const targetSlug = opts.target_page_slug || opts.pageSlug || opts.page;
    const result = modules.attachModule(db, Number(leadId), moduleType, {
      workspaceId: Number(workspaceId),
      title: opts.title,
      target_page_slug: targetSlug,
      embed_enabled: opts.embed_enabled != null ? opts.embed_enabled : opts.toSite !== false,
      appUrl: opts.appUrl,
      show_request_form: opts.show_request_form != null
        ? opts.show_request_form
        : (opts.settings && opts.settings.show_request_form),
      settings: opts.settings,
      dryRun: !!opts.dryRun,
      authorMode: opts.authorMode,
      forceInject: !!opts.forceInject,
    });
    const siteRow = db.prepare(
      'SELECT id, pages FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
    ).get(Number(leadId));
    if (siteRow && !opts.dryRun && !(result && result.skippedInject)) {
      try { materializeWebsiteExport(db, workspaceId, siteRow.id); } catch { /* */ }
    }
    const warnings = [];
    try {
      const moduleFit = require('./moduleFit');
      let pages = [];
      try { pages = siteRow ? JSON.parse(siteRow.pages || '[]') : []; } catch { pages = []; }
      const w = moduleFit.addModuleAppointmentWarning(pages, moduleType, targetSlug);
      if (w) warnings.push(w);
    } catch { /* optional */ }
    const isBookings = String(moduleType || '').toLowerCase() === 'bookings';
    return Object.assign({}, result, {
      warnings,
      note: result && result.skippedInject
        ? `Author mode: skipped inject (${result.skipReason || 'purpose_served'}). See wouldInject.`
        : (isBookings
          ? 'Bookings mounted — ensure ≥1 published service (bookings.createService) and hours (bookings.setHours). Do not use a contact form for appointment pages with availability. Style .bitpype-module-embed.'
          : 'Module mount is bare — wrap in a themed card/section; or place via website.addBlock({cellIndex}). Style .bitpype-module-embed. INTENT: appointments with availability → bookings module (never a form).'),
    });
  });
}

function modulesDetach(workspaceId, leadId, moduleType) {
  return withDb(workspaceId, (db) => {
    const modules = require('./siteModules');
    const result = modules.detachModule(db, Number(leadId), moduleType);
    const siteRow = db.prepare(
      'SELECT id FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
    ).get(Number(leadId));
    if (siteRow) {
      try { materializeWebsiteExport(db, workspaceId, siteRow.id); } catch { /* */ }
    }
    return result;
  });
}

function modulesSummary(workspaceId, leadId) {
  return withDb(workspaceId, (db) => {
    const modules = require('./siteModules');
    return modules.portalSummary(db, Number(leadId), { siteModules: true });
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
      preview: true,
      pageSlug: args.pageSlug,
      pageIndex: Number.isInteger(args.pageIndex) ? args.pageIndex : (args.pageIndex != null ? Number(args.pageIndex) : undefined),
    };
    let pages;
    let theme;
    let siteRow = null;
    if (Array.isArray(args.pages)) {
      pages = args.pages;
      theme = args.theme && typeof args.theme === 'object' ? args.theme : {};
    } else {
      const siteId = Number(id != null ? id : args.id);
      if (!Number.isInteger(siteId)) throw siteErr('INVALID_ID', 'id must be an integer.');
      const site = engine.getWebsite(db, siteId);
      siteRow = site;
      pages = parseJsonField(site.pages, 'pages');
      theme = parseJsonField(site.theme, 'theme');
      if (args.editable === undefined) opts.editable = true;
    }
    const list = pages.map((p) => ({ slug: p.slug, title: p.title }));
    let html = (opts.pageSlug != null || Number.isInteger(opts.pageIndex))
      ? engine.renderPageAt(pages, theme, opts)
      : engine.renderSite(pages, theme, opts);

    // srcdoc iframes need <base href> so relative images/… resolve under /site-previews/.
    try {
      const siteId = siteRow && siteRow.id != null
        ? Number(siteRow.id)
        : Number(id != null ? id : args.id);
      if (Number.isInteger(siteId) && siteId > 0) {
        // Ensure export folder exists so /site-previews can serve assets.
        try { materializeWebsiteExport(db, workspaceId, siteId); } catch { /* best effort */ }
        const folder = resolveSiteExportFolder(workspaceId, {
          id: siteId,
          preview_path: siteRow && siteRow.preview_path,
          export_slug: siteRow && siteRow.export_slug,
        }, db);
        const base = appBaseUrl();
        if (base && folder) {
          html = engine.injectPreviewBaseHref(html, `${base}/site-previews/${folder}/`);
        }
      }
    } catch { /* preview still returns HTML */ }

    return { html, pages: list };
  });
}
function appBaseUrl() {
  return String(process.env.APP_URL || '').replace(/\/+$/, '');
}

/** APP_URL /site-previews/… fallback — not a Cloudflare Pages URL. */
function isAppSitePreviewUrl(url) {
  return /\/site-previews\//i.test(String(url || ''));
}

function isLocalPreviewUrl(url) {
  try {
    return require('../src/cloudflare').isLocalPreviewUrl(url);
  } catch {
    if (typeof url !== 'string' || !url.trim()) return true;
    return /127\.0\.0\.1|localhost|::1/i.test(url);
  }
}

async function urlLooksHealthyOnce(url) {
  if (!url || isLocalPreviewUrl(url)) return false;
  // Pages often needs a trailing slash; try both.
  const candidates = [url];
  if (!/\/$/.test(url) && !/\.[a-z0-9]+$/i.test(url.split('?')[0])) {
    candidates.push(url + '/');
  }
  for (const candidate of candidates) {
    try {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 10000) : null;
      const res = await fetch(candidate, {
        method: 'GET',
        redirect: 'follow',
        signal: ctrl ? ctrl.signal : undefined,
        headers: { Accept: 'text/html' },
      });
      if (timer) clearTimeout(timer);
      if (!res.ok) continue;
      const html = await res.text();
      // Reject empty / error shells; require real markup (and prefer themed CSS).
      if (!html || html.length < 200) continue;
      if (!/<html[\s>]|<!doctype\s+html/i.test(html)) continue;
      return true;
    } catch {
      /* try next candidate */
    }
  }
  return false;
}

/** Retry — Pages Direct Upload can take 15–40s before HTML is live (large image uploads). */
async function urlLooksHealthy(url, opts = {}) {
  const attempts = Math.max(1, Number(opts.attempts) || 12);
  const delayMs = Math.max(100, Number(opts.delayMs) || 2500);
  for (let i = 0; i < attempts; i++) {
    if (await urlLooksHealthyOnce(url)) return true;
    if (i + 1 < attempts) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

/**
 * Export a stored website and return a public preview URL.
 * Prefer a healthy Cloudflare Pages URL when available; otherwise APP_URL
 * /site-previews/… (never Electron localhost:8755).
 */
async function sitesPreview(workspaceId, id, opts = {}) {
  const siteId = Number(id);
  if (!Number.isInteger(siteId)) throw siteErr('INVALID_ID', 'id must be an integer.');
  const force = !!(opts && (opts.force || opts.republish || opts.refresh));

  return withDb(workspaceId, async (db) => {
    const cf = require('../src/cloudflare');
    cf.ensureColumn(db);
    const engine = websiteEngine();
    const site = engine.getWebsite(db, siteId);
    const existing = site.preview_url || null;
    if (!force && existing && !isLocalPreviewUrl(existing) && await urlLooksHealthy(existing)) {
      return {
        id: siteId,
        url: existing,
        indexUrl: existing,
        via: 'stored',
        opened: false,
      };
    }

    // Store any Pexels/Unsplash hotlinks in EXPORT_ROOT/site-{id}/images first.
    try {
      await engine.localizeWebsiteRemoteImages(db, siteId);
    } catch (e) {
      console.warn('[domain] localizeWebsiteRemoteImages:', e.message || e);
    }

    const exported = materializeWebsiteExport(db, workspaceId, siteId);
    await optimizeExportImages(exported);
    const base = appBaseUrl();
    const appUrl = base ? `${base}/site-previews/${exported.folder}/` : null;

    // Block publish when multipage nav would ship broken hash links.
    try {
      const navCheck = engine.validateExportNavLinks(
        parseJsonField((engine.getWebsite(db, siteId) || {}).pages, 'pages'),
        exported.dir
      );
      if (!navCheck.ok && force) {
        const navMiss = [...(navCheck.danglingHashes || []), ...(navCheck.missing || [])];
        const e = siteErr(
          'NAV_EXPORT_FAILED',
          `Broken multipage nav (${navMiss.length}): ${navMiss.slice(0, 8).join(', ')}`
        );
        e.status = 422;
        throw e;
      }
    } catch (e) {
      if (e.code === 'NAV_EXPORT_FAILED') throw e;
    }

    let cfError = null;
    let cfResult = null;
    const creds = await cf.resolveCfCredentials(db);
    if (creds.via !== 'none') {
      try {
        // Publish the full export folder (HTML + images/).
        cfResult = await cf.publishDirectory(db, {
          websiteId: siteId,
          workspaceId: Number(workspaceId),
          dir: exported.dir,
        });
        if (cfResult && cfResult.ok && cfResult.url && !isLocalPreviewUrl(cfResult.url)) {
          // Prefer the deployment URL first. Only probe the project production alias
          // for per-site projects — a shared Pages project alias serves whatever
          // was last deployed for any site (wrong content if hashed URL is slow).
          const cfCandidates = [cfResult.url];
          if (cfResult.project && !cfResult.sharedProject) {
            cfCandidates.push(`https://${cfResult.project}.pages.dev`);
          }
          let healthyUrl = null;
          for (const candidate of cfCandidates) {
            if (!candidate || isLocalPreviewUrl(candidate)) continue;
            // Large sites with images/ need longer propagation after Direct Upload.
            if (await urlLooksHealthy(candidate, { attempts: 12, delayMs: 2500 })) {
              healthyUrl = candidate.replace(/\/+$/, '') + '/';
              break;
            }
          }
          if (healthyUrl) {
            cf.ensureColumn(db);
            db.prepare("UPDATE websites SET preview_url = ?, preview_path = ?, updated_at = datetime('now') WHERE id = ?")
              .run(healthyUrl, exported.path, siteId);
            return {
              id: siteId,
              url: healthyUrl,
              indexUrl: healthyUrl,
              project: cfResult.project || null,
              deploymentId: cfResult.deploymentId || null,
              via: 'cloudflare',
              path: exported.path,
              folder: exported.folder,
              files: exported.files || [],
              opened: false,
            };
          }
          // Deploy succeeded but health probes timed out — keep a known-good CF URL
          // (or the new deployment URL) instead of demoting preview_url to APP_URL.
          cfError = {
            ok: false,
            error: 'CF_URL_UNHEALTHY',
            hint: `Cloudflare returned ${cfResult.url} but it is not serving HTML yet.`,
            url: cfResult.url,
            cause: 'Health check timed out after a successful upload. Asset hashes must be blake3(base64(content)+ext). Incomplete uploads also cause HTTP 500.',
          };
          const keepCfUrl = (() => {
            const prior = existing && !isLocalPreviewUrl(existing) && !isAppSitePreviewUrl(existing)
              ? String(existing).replace(/\/+$/, '') + '/'
              : null;
            if (prior) return prior;
            const fresh = String(cfResult.url || '').replace(/\/+$/, '');
            return fresh && !isLocalPreviewUrl(fresh) ? `${fresh}/` : null;
          })();
          if (keepCfUrl) {
            cf.ensureColumn(db);
            db.prepare("UPDATE websites SET preview_url = ?, preview_path = ?, updated_at = datetime('now') WHERE id = ?")
              .run(keepCfUrl, exported.path, siteId);
            logActivity(
              db,
              'websites',
              `Kept CF preview URL for website #${siteId} after unhealthy probe: ${keepCfUrl}`
            );
            return {
              id: siteId,
              url: keepCfUrl,
              indexUrl: keepCfUrl,
              project: cfResult.project || null,
              deploymentId: cfResult.deploymentId || null,
              via: 'cloudflare_pending_health',
              path: exported.path,
              folder: exported.folder,
              files: exported.files || [],
              cloudflare: cfError,
              opened: false,
            };
          }
        } else if (cfResult && cfResult.ok === false) {
          cfError = cfResult;
        } else if (!cfResult || (typeof cfResult === 'object' && !cfResult.url && cfResult.ok !== true)) {
          // Never treat an empty/ambiguous CF result as success.
          cfError = {
            ok: false,
            error: 'CF_EMPTY_RESULT',
            hint: 'cloudflare.publish returned an empty or ambiguous result — deploy did not confirm a URL.',
            detail: cfResult == null ? null : cfResult,
          };
        }
      } catch (e) {
        cfError = { ok: false, error: 'CF_PUBLISH_EXCEPTION', detail: e.message || String(e) };
      }
    }

    if (!appUrl) {
      const err = new Error(
        (cfError && (cfError.hint || cfError.error))
          || 'Preview hosting is not configured (Cloudflare + APP_URL).'
      );
      err.code = 'PREVIEW_NOT_CONFIGURED';
      err.detail = cfError || null;
      throw err;
    }

    // Only demote to APP_URL /site-previews when CF upload failed (or was skipped).
    cf.ensureColumn(db);
    db.prepare("UPDATE websites SET preview_url = ?, preview_path = ?, updated_at = datetime('now') WHERE id = ?")
      .run(appUrl, exported.path, siteId);
    logActivity(db, 'websites', `App preview URL for website #${siteId}: ${appUrl}`);
    return {
      id: siteId,
      url: appUrl,
      indexUrl: appUrl,
      path: exported.path,
      folder: exported.folder,
      files: exported.files || [],
      via: 'app_url',
      cloudflare: cfError || (cfResult && cfResult.url ? { url: cfResult.url, skipped: 'unhealthy' } : null),
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
    try { materializeWebsiteExport(db, workspaceId, siteId); } catch { /* preview can retry */ }
    return { id: siteId, applied: true, summary: applied, version: { id: version.id, version_no: version.version_no } };
  });
}
async function designOpenPreview(workspaceId, id, opts = {}) {
  return designPreviewUrl(workspaceId, id, !!(opts && opts.open));
}

// ---------- Outreach ----------
const outreach = () => require('../src/outreach');

function campaignsList(workspaceId, args) {
  return withDb(workspaceId, (db) => outreach().listCampaigns(db, args));
}
function campaignsCreate(workspaceId, args) {
  return withDb(workspaceId, (db) => outreach().createCampaign(db, { ...args, workspaceId }));
}
function campaignsSetStatus(workspaceId, id, status) {
  return withDb(workspaceId, (db) => outreach().setCampaignStatus(db, id, status));
}
function campaignsCancel(workspaceId, id) {
  return withDb(workspaceId, (db) => outreach().cancelCampaign(db, id));
}
function campaignsDelete(workspaceId, id) {
  return withDb(workspaceId, (db) => outreach().deleteCampaign(db, id));
}
function campaignsMessages(workspaceId, id, opts) {
  return withDb(workspaceId, (db) => outreach().listMessages(db, id, null, opts));
}
function templatesList(workspaceId, opts = {}) {
  return withDb(workspaceId, (db) => outreach().listTemplates(db, opts));
}

/**
 * Queue a freeform SMS body for a lead (companion draft / one-off text).
 * Personalizes {{website_link}} etc. Requires a phone on the lead.
 */
function smsQueue(workspaceId, args = {}) {
  return withDb(workspaceId, (db) => {
    const o = outreach();
    o.ensureTables(db);
    if (o.isAutomationPaused(db)) {
      throw Object.assign(new Error('Automation is paused (kill switch). Resume it before queuing SMS.'), { code: 'AUTOMATION_PAUSED' });
    }
    const leadId = Number(args.leadId);
    if (!Number.isInteger(leadId) || leadId <= 0) throw new Error('leadId is required');
    const lead = leadEngine().getLead(db, leadId);
    if (!lead) throw new Error('Lead not found');
    const phone = o.normalizePhone(lead.phone);
    if (!phone) {
      throw Object.assign(new Error(`Lead ${leadId} has no phone number for SMS.`), { code: 'NO_PHONE' });
    }
    const sms = require('../src/sms');
    const email = require('../src/email');
    const rawBody = String(args.body || args.sms_body || '');
    if (rawBody.length > 1600) throw new Error('SMS body is too long (max 1600 characters).');
    let body = sms.plainSmsBody(rawBody);
    if (!body) throw new Error('SMS body is required');
    const fromName = getSetting(db, 'smtp.from_name', '') || getSetting(db, 'app.name', '');
    const facts = db.prepare('SELECT * FROM business_facts WHERE lead_id = ?').all(leadId);
    const personalized = email.personalize(
      { subject: '(SMS)', body },
      lead, facts,
      o.personalizeExtras(db, leadId, fromName, { workspaceId })
    );
    body = sms.plainSmsBody(personalized.body);
    const websiteLink = o.resolveWebsiteLink(db, leadId);
    if (websiteLink && !body.includes(websiteLink) && !/https?:\/\//i.test(body)) {
      body = `${body} ${websiteLink}`.trim().slice(0, 320);
    }
    let campaign = db.prepare("SELECT id FROM campaigns WHERE name = ? AND status = 'draft'").get('Compose SMS');
    if (!campaign) {
      campaign = { id: db.prepare('INSERT INTO campaigns (name, template_id, status) VALUES (?, ?, ?)').run('Compose SMS', null, 'draft').lastInsertRowid };
    }
    const r = db.prepare(
      `INSERT INTO campaign_messages
         (campaign_id, lead_id, to_email, subject, body, status, channel, to_phone)
       VALUES (?, ?, ?, '(SMS)', ?, 'queued', 'sms', ?)`
    ).run(Number(campaign.id), leadId, phone, body, phone);
    return {
      messageId: Number(r.lastInsertRowid),
      to: phone,
      to_phone: phone,
      body,
      channel: 'sms',
      queued: true,
      website_link: websiteLink || null,
    };
  });
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
    const o = outreach();
    o.ensureTables(db);
    if (opts && opts.queue && o.isAutomationPaused(db)) {
      throw Object.assign(new Error('Automation is paused (kill switch). Resume it before queuing.'), { code: 'AUTOMATION_PAUSED' });
    }
    const channelOpt = opts && opts.channel;
    const rendered = emailComposeRender(db, leadId, templateId, workspaceId, channelOpt);
    if (!(opts && opts.queue)) return rendered;
    const lead = leadEngine().getLead(db, Number(leadId));
    const channel = rendered.channel || 'email';
    const campaignName = channel === 'sms' ? 'Compose SMS' : 'Compose';
    let campaign = db.prepare("SELECT id FROM campaigns WHERE name = ? AND status = 'draft'").get(campaignName);
    if (!campaign) {
      campaign = { id: db.prepare('INSERT INTO campaigns (name, template_id, status) VALUES (?, ?, ?)').run(campaignName, Number(templateId), 'draft').lastInsertRowid };
    }

    if (channel === 'sms') {
      const phone = outreach().normalizePhone(lead.phone);
      if (!phone) {
        throw Object.assign(new Error(`Lead ${leadId} has no phone number for SMS.`), { code: 'NO_PHONE' });
      }
      const sms = require('../src/sms');
      const body = sms.plainSmsBody(rendered.body);
      const r = db.prepare(
        `INSERT INTO campaign_messages
           (campaign_id, lead_id, to_email, subject, body, status, channel, to_phone)
         VALUES (?, ?, ?, ?, ?, ?, 'sms', ?)`
      ).run(Number(campaign.id), Number(leadId), phone, rendered.subject || '(SMS)', body, 'queued', phone);
      return {
        ...rendered, body, messageId: Number(r.lastInsertRowid),
        to: phone, to_phone: phone, channel: 'sms', queued: true,
      };
    }

    if (!lead.email) throw new Error(`Lead ${leadId} has no email address.`);
    const footer = getSetting(db, 'mail.footer', '');
    const body = rendered.body + (footer ? `\n\n--\n${footer}` : '');
    const r = db.prepare(
      `INSERT INTO campaign_messages
         (campaign_id, lead_id, to_email, subject, body, status, channel)
       VALUES (?, ?, ?, ?, ?, 'queued', 'email')`
    ).run(Number(campaign.id), Number(leadId), lead.email, rendered.subject, body);
    return { ...rendered, body, messageId: Number(r.lastInsertRowid), to: lead.email, channel: 'email', queued: true };
  });
}
function emailComposeRender(db, leadId, templateId, workspaceId, channelOpt) {
  const o = outreach();
  o.ensureTables(db);
  const template = db.prepare('SELECT * FROM email_templates WHERE id = ?').get(Number(templateId));
  if (!template) throw new Error('Template not found');
  let channel = String(channelOpt || '').toLowerCase() === 'sms' ? 'sms' : 'email';
  // Legacy SMS-only rows (pre-migration) default compose to SMS when no channel passed.
  if (!channelOpt && String(template.channel || '').toLowerCase() === 'sms' && !o.templateHasEmail(template)) {
    channel = 'sms';
  }
  if (channel === 'sms' && !o.templateHasSms(template)) {
    throw new Error('This template has no SMS body');
  }
  if (channel === 'email' && !o.templateHasEmail(template)) {
    throw new Error('This template has no email body');
  }
  const lead = leadEngine().getLead(db, Number(leadId));
  if (!lead) throw new Error('Lead not found');
  const facts = db.prepare('SELECT * FROM business_facts WHERE lead_id = ?').all(Number(leadId));
  const email = require('../src/email');
  const fromName = getSetting(db, 'smtp.from_name', '') || getSetting(db, 'app.name', '');
  const source = channel === 'sms'
    ? { subject: '(SMS)', body: o.templateSmsText(template) }
    : { subject: template.subject, body: template.body };
  const personalized = email.personalize(
    source, lead, facts,
    o.personalizeExtras(db, Number(leadId), fromName, { workspaceId })
  );
  if (channel === 'sms') {
    const sms = require('../src/sms');
    personalized.body = sms.plainSmsBody(personalized.body);
    personalized.subject = personalized.subject || '(SMS)';
  }
  return {
    ...personalized,
    channel,
    sms_body: o.templateSmsText(template) || null,
    to_phone: channel === 'sms' ? o.normalizePhone(lead.phone) || null : null,
    phone: lead.phone || null,
    email: lead.email || null,
  };
}

/**
 * Public (no session) handler for {{interested}} / {{uninterested}} tracking links.
 * Token is HMAC-signed (workspace + lead + action). Claim tokens are rejected here.
 */
function outreachInterestResponse(token) {
  const o = outreach();
  const { workspaceId, leadId, action } = o.verifyInterestToken(token);
  if (action === 'claim') {
    throw Object.assign(new Error('Use the claim page for this link'), { code: 'INVALID_TOKEN' });
  }
  return withDb(workspaceId, (db) => o.applyInterestResponse(db, leadId, action));
}

/** Public claim-page meta (business name, site URL, prior intent). */
function outreachClaimMeta(token) {
  const claimKit = require('../src/claimKit');
  const { workspaceId, leadId } = claimKit.verifyClaimToken(token);
  return withDb(workspaceId, (db) => claimKit.claimPageMeta(db, workspaceId, leadId));
}

/** Public claim Yes / No / Later → applyClaimResponse (engaged / lost / deferred). */
function outreachClaimDecide(token, action) {
  const claimKit = require('../src/claimKit');
  const { workspaceId, leadId } = claimKit.verifyClaimToken(token);
  return withDb(workspaceId, (db) => outreach().applyClaimResponse(db, leadId, action));
}

/**
 * Auth'd claim kit: site URL, claim URL, QR data-URLs (no PDF).
 * Works even when automation is paused.
 */
async function sitesClaimKit(workspaceId, websiteId) {
  const claimKit = require('../src/claimKit');
  return withDb(workspaceId, async (db) => {
    websiteEngine().ensureTables(db);
    const site = siteRow(db, Number(websiteId));
    const leadId = Number(site.lead_id);
    if (!Number.isInteger(leadId) || leadId <= 0) {
      throw Object.assign(new Error('Website has no lead'), { code: 'NO_LEAD' });
    }
    return claimKit.buildClaimKit(db, workspaceId, {
      leadId,
      websiteId: Number(websiteId),
      includePdf: false,
    });
  });
}

/** Auth'd postcard PDF buffer + metadata for a website. */
async function sitesPostcard(workspaceId, websiteId) {
  const claimKit = require('../src/claimKit');
  return withDb(workspaceId, async (db) => {
    websiteEngine().ensureTables(db);
    const site = siteRow(db, Number(websiteId));
    const leadId = Number(site.lead_id);
    if (!Number.isInteger(leadId) || leadId <= 0) {
      throw Object.assign(new Error('Website has no lead'), { code: 'NO_LEAD' });
    }
    return claimKit.buildClaimKit(db, workspaceId, {
      leadId,
      websiteId: Number(websiteId),
      includePdf: true,
    });
  });
}

/** Auth'd claim kit by lead (latest website when present). */
async function leadsClaimKit(workspaceId, leadId, opts = {}) {
  const claimKit = require('../src/claimKit');
  return withDb(workspaceId, async (db) => {
    return claimKit.buildClaimKit(db, workspaceId, {
      leadId: Number(leadId),
      websiteId: opts.websiteId,
      includePdf: !!opts.includePdf,
    });
  });
}

/**
 * Draft subject+body for an outreach template via the existing AI chat pipeline
 * (task=email) and the write_outreach prompt. Optional leadId supplies context;
 * optional prompt steers the draft. Returns HTML body suitable for the editor.
 */
async function emailDraft(workspaceId, args = {}) {
  return withDb(workspaceId, async (db) => {
    const o = outreach();
    if (o.isAutomationPaused(db)) {
      throw Object.assign(new Error('Automation is paused (kill switch). Resume it before drafting.'), { code: 'AUTOMATION_PAUSED' });
    }
    const { chat, aiConfigured } = require('../src/ai');
    if (!aiConfigured(db)) {
      throw Object.assign(new Error('AI is not configured: set ai.api_key in Settings.'), { code: 'AI_NOT_CONFIGURED' });
    }
    if (args.prompt != null && String(args.prompt).length > 4000) {
      throw new Error('prompt is too long (max 4000 characters).');
    }
    const promptRow = db.prepare('SELECT body FROM prompts WHERE key = ?').get('write_outreach');
    const systemSeed = (promptRow && promptRow.body)
      || 'Write a short personal outreach email. Return JSON: { "subject": "...", "body": "..." }.';

    const leadId = args.leadId != null && args.leadId !== '' ? Number(args.leadId) : null;
    const fromName = getSetting(db, 'smtp.from_name', '') || getSetting(db, 'app.name', '') || 'Bitpype';
    const mailFooter = getSetting(db, 'mail.footer', '') || '';
    let lead = null;
    let websiteLink = '';
    let factsSummary = '';
    if (leadId != null) {
      if (!Number.isInteger(leadId) || leadId <= 0) throw new Error('leadId must be a positive integer.');
      lead = leadEngine().getLead(db, leadId);
      if (!lead) throw new Error('Lead not found');
      websiteLink = outreach().resolveWebsiteLink(db, leadId);
      try {
        const facts = db.prepare(
          `SELECT fact_key, value FROM business_facts
           WHERE lead_id = ? AND claim_class IN ('VERIFIED','OWNER_PROVIDED') LIMIT 20`
        ).all(leadId);
        factsSummary = facts.map((f) => `${f.fact_key}: ${f.value}`).join('; ');
      } catch { /* optional */ }
    }

    const fill = (text, vars) => String(text || '').replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, k) => {
      const v = vars[k];
      return v == null ? '' : String(v);
    });

    const vars = {
      sequence_step: '1',
      owner_name: (lead && (lead.owner_name || lead.contact_name)) || 'there',
      business_name: (lead && lead.business_name) || '',
      category: (lead && lead.category) || '',
      city: (lead && lead.city) || '',
      state: (lead && lead.state) || '',
      observation: String(args.prompt || '').trim()
        || (lead ? `Their online presence could use a cleaner website${lead.city ? ` for ${lead.city}` : ''}.` : 'A local business that needs a better website.'),
      preview_url: websiteLink,
      website_link: websiteLink,
      from_name: fromName,
      mail_footer: mailFooter,
    };

    const system = fill(systemSeed, vars)
      + '\n\nImportant: Return ONLY valid JSON: {"subject":"...","body":"...","sms_body":"..."}. '
      + 'Body may use simple HTML (<p>, <b>, <a>, <ul><li>) or plain text. '
      + 'Prefer merge variables like {{business_name}}, {{website_link}}, {{interested}}, and {{uninterested}} when the value will vary per lead. '
      + '{{interested}} and {{uninterested}} become clickable response links — include them when asking the recipient to reply with interest. '
      + 'Also write sms_body: a concise plain-text SMS (ideal ≤160 chars, hard max 280) that MUST include {{website_link}} (or the concrete URL if provided). No HTML in sms_body. '
      + 'Do not invent facts. Do not wrap the JSON in markdown fences.';

    const userBits = [
      String(args.prompt || '').trim()
        ? `Writer brief: ${String(args.prompt).trim()}`
        : 'Draft a short cold outreach email offering a free website preview.',
      lead ? `Lead context: ${lead.business_name || ''} | ${lead.category || ''} | ${[lead.city, lead.state].filter(Boolean).join(', ')} | email=${lead.email || 'n/a'} | phone=${lead.phone || 'n/a'}` : 'No specific lead selected — write a reusable template.',
      websiteLink ? `Active website URL (also available as {{website_link}}): ${websiteLink}` : 'No published website URL yet — use {{website_link}} as a placeholder if needed.',
      'Also produce a companion SMS (sms_body) that includes the website link.',
      factsSummary ? `Verified facts: ${factsSummary}` : '',
      args.existingSubject ? `Current subject (revise or replace): ${String(args.existingSubject).slice(0, 200)}` : '',
      args.existingBody ? `Current body (revise or replace):\n${String(args.existingBody).slice(0, 2000)}` : '',
    ].filter(Boolean);

    const result = await chat({
      task: 'email',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userBits.join('\n') },
      ],
      maxTokens: 1200,
      leadId: leadId || null,
      note: 'outreach template draft',
      db,
    });

    const email = require('../src/email');
    const sms = require('../src/sms');
    let subject = '';
    let body = '';
    let smsBody = '';
    const raw = String(result.text || '').trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        subject = String(parsed.subject || '').trim();
        body = String(parsed.body || '').trim();
        smsBody = String(parsed.sms_body || parsed.sms || '').trim();
      } catch { /* fall through */ }
    }
    if (!subject && !body) {
      // Fallback: treat whole response as body
      body = raw;
      subject = lead && lead.business_name ? `Quick idea for ${lead.business_name}` : 'Quick idea for your website';
    }
    if (body && !email.looksLikeHtml(body)) {
      body = body
        .split(/\n{2,}/)
        .map((block) => `<p>${String(block).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`)
        .join('\n');
    } else if (body) {
      body = email.sanitizeEmailHtml(body);
    }

    smsBody = sms.plainSmsBody(smsBody);
    const linkToken = websiteLink || '{{website_link}}';
    if (!smsBody || (!smsBody.includes(linkToken) && !smsBody.includes('{{website_link}}') && !/https?:\/\//i.test(smsBody))) {
      smsBody = sms.companionSmsDraft({
        businessName: (lead && lead.business_name) || '{{business_name}}',
        websiteLink: linkToken,
        fromName,
      });
    } else if (websiteLink && smsBody.includes('{{website_link}}')) {
      // Keep merge var for reusable templates; leave as-is.
    } else if (!smsBody.includes('{{website_link}}') && websiteLink && !smsBody.includes(websiteLink)) {
      smsBody = `${smsBody} ${websiteLink}`.trim().slice(0, 320);
    }

    return {
      subject,
      body,
      sms_body: smsBody,
      model: result.model,
      website_link: websiteLink || null,
      leadId: leadId || null,
      lead_phone: lead && lead.phone ? lead.phone : null,
      has_phone: Boolean(lead && outreach().normalizePhone(lead.phone)),
    };
  });
}

/**
 * Store an image for use in HTML email templates. Files live under the
 * workspace data dir and are served at /email-assets/{workspaceId}/{file}.
 * Returns an absolute APP_URL URL safe to embed in <img src>.
 */
async function emailUploadAsset(workspaceId, args = {}) {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const { dataRoot } = require('./workspaceDb');
  const { appUrl } = require('./stripeClient');

  const ws = Number(workspaceId);
  if (!Number.isInteger(ws) || ws <= 0) throw new Error('Invalid workspace');

  const dataB64 = String(args.data || args.base64 || '')
    .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
    .replace(/\s+/g, '');
  if (!dataB64) throw new Error('data (base64 image) is required');
  let buffer = Buffer.from(dataB64, 'base64');
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) {
    throw new Error('Image must be between 1 byte and 5 MB');
  }

  let mime = String(args.mimeType || args.mime || '').toLowerCase();
  let ext = 'png';
  const magic = buffer.slice(0, 4).toString('hex');
  if (magic.startsWith('89504e47')) { ext = 'png'; mime = 'image/png'; }
  else if (magic.startsWith('ffd8ff')) { ext = 'jpg'; mime = 'image/jpeg'; }
  else if (magic.startsWith('47494638')) { ext = 'gif'; mime = 'image/gif'; }
  else if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
    ext = 'webp'; mime = 'image/webp';
  } else if (/^image\/(png|jpeg|jpg|gif|webp)$/.test(mime)) {
    ext = mime === 'image/jpeg' || mime === 'image/jpg' ? 'jpg'
      : mime === 'image/webp' ? 'webp'
        : mime === 'image/gif' ? 'gif' : 'png';
  } else {
    throw new Error('Unrecognized image data (png, jpeg, gif, webp only)');
  }

  // Re-encode with sharp when available (strips EXIF, caps dimensions).
  try {
    const sharp = require('sharp');
    const pipeline = sharp(buffer).rotate().resize({
      width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true,
    });
    if (ext === 'jpg') {
      buffer = await pipeline.jpeg({ quality: 85 }).toBuffer();
    } else if (ext === 'webp') {
      buffer = await pipeline.webp({ quality: 85 }).toBuffer();
    } else if (ext === 'gif') {
      buffer = await pipeline.png().toBuffer();
      ext = 'png';
      mime = 'image/png';
    } else {
      buffer = await pipeline.png().toBuffer();
    }
  } catch { /* keep original buffer */ }

  const name = `em-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const dir = path.join(dataRoot(), String(ws), 'email-assets');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), buffer);

  const url = `${appUrl().replace(/\/$/, '')}/email-assets/${ws}/${name}`;
  withDb(ws, (db) => {
    logActivity(db, 'outreach', `Email asset uploaded: ${name}`);
  });
  return { url, name, mimeType: mime, bytes: buffer.length };
}
/**
 * Send ONE queued campaign message now (email or SMS).
 * Respects automation pause, suppression list (email) and the daily outreach cap.
 */
async function emailSend(workspaceId, messageId) {
  return withDb(workspaceId, async (db) => {
    const o = outreach();
    o.ensureTables(db);
    const id = Number(messageId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('messageId must be a positive integer.');
    if (o.isAutomationPaused(db)) {
      throw Object.assign(new Error('Automation is paused (kill switch). Resume it before sending.'), { code: 'AUTOMATION_PAUSED' });
    }
    const msg = db.prepare('SELECT * FROM campaign_messages WHERE id = ?').get(id);
    if (!msg) throw Object.assign(new Error(`Message ${id} not found.`), { code: 404 });
    if (msg.status !== 'queued') throw new Error(`Message ${id} is not queued (status: ${msg.status}).`);

    const channel = String(msg.channel || 'email').toLowerCase() === 'sms' ? 'sms' : 'email';
    const settings = o.readSettings(db);
    const cap = Math.max(1, Number(settings['cost.max_outreach_per_day']) || 200);
    if (o.sentTodayCount(db) >= cap) {
      throw Object.assign(new Error(`Daily outreach cap reached (${cap}). Message left queued.`), { code: 'CAP_REACHED' });
    }

    if (channel === 'sms') {
      const sms = require('../src/sms');
      const lead = msg.lead_id
        ? db.prepare('SELECT id, phone FROM leads WHERE id = ?').get(msg.lead_id)
        : null;
      const phone = sms.normalizePhone(msg.to_phone)
        || (lead && sms.normalizePhone(lead.phone))
        || sms.normalizePhone(msg.to_email);
      if (!phone) {
        db.prepare("UPDATE campaign_messages SET status = 'suppressed', error = ? WHERE id = ?")
          .run('no phone number', id);
        return { messageId: id, sent: false, suppressed: true, reason: 'no phone number', channel: 'sms' };
      }
      const smsSettings = await sms.resolveSmsSettings(settings);
      const provider = sms.getSmsProvider(smsSettings, db);
      try {
        await provider.send({ to: phone, body: sms.plainSmsBody(msg.body) });
      } catch (err) {
        const text = String((err && err.message) || err);
        db.prepare("UPDATE campaign_messages SET status = 'failed', error = ? WHERE id = ?").run(text.slice(0, 1000), id);
        db.prepare('INSERT INTO email_events (message_id, type, detail) VALUES (?, ?, ?)').run(id, 'failed', text.slice(0, 500));
        throw Object.assign(new Error(`SMS send failed: ${text}`), { code: 'SEND_FAILED' });
      }
      db.prepare("UPDATE campaign_messages SET status = 'sent', sent_at = ?, error = NULL WHERE id = ?")
        .run(new Date().toISOString().slice(0, 19).replace('T', ' '), id);
      db.prepare('INSERT INTO email_events (message_id, type, detail) VALUES (?, ?, ?)').run(id, 'sent', `sms via ${provider.name}`);
      if (msg.lead_id) {
        try {
          db.prepare(
            `UPDATE leads SET status = 'contacted', updated_at = datetime('now')
             WHERE id = ? AND status NOT IN ('engaged','claimed','trial','customer','lost')`
          ).run(msg.lead_id);
          db.prepare('INSERT INTO prospect_events (lead_id, type, detail) VALUES (?, ?, ?)')
            .run(msg.lead_id, 'sms.sent', 'single send');
        } catch { /* non-fatal */ }
      }
      logActivity(db, 'outreach', `SMS #${id} sent to ${phone} (provider: ${provider.name})`);
      return { messageId: id, sent: true, to: phone, provider: provider.name, channel: 'sms', stub: provider.name === 'stub' };
    }

    const suppressed = o.isSuppressed(db, msg.to_email);
    if (suppressed) {
      db.prepare("UPDATE campaign_messages SET status = 'suppressed', error = ? WHERE id = ?")
        .run(`suppressed at send time: ${suppressed.reason}`, id);
      db.prepare('INSERT INTO email_events (message_id, type, detail) VALUES (?, ?, ?)')
        .run(id, 'unsubscribed', `suppressed: ${suppressed.reason}`);
      return { messageId: id, sent: false, suppressed: true, reason: suppressed.reason, channel: 'email' };
    }

    const provider = require('../src/email').getProvider(settings, db);
    try {
      const { assertMailjetSenderActive } = require('../src/mailjetSender');
      await assertMailjetSenderActive(settings);
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
    return { messageId: id, sent: true, to: msg.to_email, provider: provider.name, channel: 'email' };
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
  const { SETTABLE_KEYS, validateSetting } = require('../src/ipc/system');
  if (!SETTABLE_KEYS.includes(key)) throw new Error(`Setting "${key}" is not writable`);
  const v = typeof validateSetting === 'function'
    ? validateSetting(String(key), value)
    : { ok: true, value: value == null ? '' : String(value) };
  if (!v.ok) throw new Error(v.error || `Invalid value for ${key}`);
  const out = withDb(workspaceId, (db) => {
    setSetting(db, key, v.value);
    logActivity(db, 'settings', `Setting updated: ${key}`);
    // Runtime source of truth is workspace SQLite only (no async MySQL mirror).
    return { key, value: v.value };
  });
  if (key === 'hands_off.enabled') {
    const enabled = v.value === '1';
    setImmediate(() => {
      require('./handsOff').syncJobs(workspaceId, enabled).catch((e) => {
        console.warn('[handsOff] syncJobs:', e.message);
      });
    });
  }
  return out;
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
async function cfPublish(workspaceId, websiteId, _ignoredDir) {
  return withDb(workspaceId, async (db) => {
    const cf = require('../src/cloudflare');
    const siteId = Number(websiteId);
    // Never trust client-supplied dir — always materialize under the workspace export root.
    // Atomic w.r.t. saved versions: sync → re-read → version snapshot → export that exact JSON.
    const exported = materializeWebsiteExport(db, workspaceId, siteId, { pinVersion: true });
    const deployedVersion = exported.versionNo != null ? Number(exported.versionNo) : null;
    const result = await cf.publishDirectory(db, {
      websiteId: siteId,
      workspaceId: Number(workspaceId),
      dir: exported.dir,
      deployedVersion,
    });
    return Object.assign({}, result, {
      deployedVersion: result.deployedVersion != null ? result.deployedVersion : deployedVersion,
      version: result.version != null ? result.version : deployedVersion,
      versionId: exported.versionId || null,
    });
  });
}

// ---------- Domains (Cloudflare Registrar + Pages custom domains) ----------
async function domainsSearch(workspaceId, query, opts = {}) {
  return withDb(workspaceId, async (db) => {
    const mod = require('../src/cfDomains');
    mod.ensureTables(db);
    const result = await mod.searchDomains(db, query, opts);
    if (opts.leadId != null) mod.recordSearchIntent(db, opts.leadId, query);
    return result;
  });
}
async function domainsCheck(workspaceId, names) {
  return withDb(workspaceId, (db) => require('../src/cfDomains').checkDomains(db, names));
}
async function domainsOwned(workspaceId) {
  return withDb(workspaceId, (db) => require('../src/cfDomains').listOwnedDomains(db));
}
async function domainsRegister(workspaceId, body = {}) {
  return withDb(workspaceId, (db) => require('../src/cfDomains').registerDomain(db, body.domain || body.domainName, {
    years: body.years,
    websiteId: body.websiteId,
    leadId: body.leadId,
  }));
}
async function domainsRegistrationStatus(workspaceId, domainName) {
  return withDb(workspaceId, (db) => require('../src/cfDomains').registrationStatus(db, domainName));
}
function domainsList(workspaceId, opts = {}) {
  return withDb(workspaceId, (db) => {
    const mod = require('../src/cfDomains');
    mod.ensureTables(db);
    return { domains: mod.listLinked(db, opts) };
  });
}
async function domainsLink(workspaceId, body = {}) {
  return withDb(workspaceId, async (db) => {
    const mod = require('../src/cfDomains');
    const cf = require('../src/cloudflare');
    return mod.linkDomainToWebsite(db, {
      domain: body.domain || body.domainName,
      websiteId: body.websiteId,
      leadId: body.leadId,
      project: body.project,
      workspaceId,
      forcePublish: !!body.forcePublish,
      source: body.source || 'link',
      publishFn: async (websiteId, project) => {
        const exported = materializeWebsiteExport(db, workspaceId, Number(websiteId));
        await cf.publishDirectory(db, {
          websiteId: Number(websiteId),
          workspaceId: Number(workspaceId),
          dir: exported.dir,
          project,
        });
      },
    });
  });
}
async function domainsUnlink(workspaceId, body = {}) {
  return withDb(workspaceId, (db) => require('../src/cfDomains').unlinkDomain(db, {
    domain: body.domain || body.domainName,
    project: body.project,
    removeFromPages: body.removeFromPages !== false,
  }));
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

// ---------- Social (Facebook + Instagram) ----------
const social = () => require('../src/socialMedia');

function socialOverview(workspaceId) {
  return withDb(workspaceId, (db) => social().overview(db));
}
function socialAccounts(workspaceId, leadId) {
  return withDb(workspaceId, (db) => social().listAccounts(db, leadId));
}
function socialDisconnect(workspaceId, accountId) {
  return withDb(workspaceId, (db) => social().disconnectAccount(db, accountId));
}
function socialOauthStart(workspaceId, leadId, returnTo) {
  return withDb(workspaceId, (db) => social().oauthStart(db, { workspaceId, leadId, returnTo }));
}
async function socialOauthCallback(workspaceId, code, state) {
  return withDb(workspaceId, (db) => social().oauthCallback(db, { code, state }));
}
function socialCampaigns(workspaceId, q) {
  return withDb(workspaceId, (db) => social().listCampaigns(db, q || {}));
}
function socialCampaignGet(workspaceId, id) {
  return withDb(workspaceId, (db) => social().getCampaign(db, id));
}
async function socialGenerateMonth(workspaceId, body) {
  const creditMod = require('./credits');
  const cfg = await creditMod.packConfig();
  const contentCost = cfg.perContent;
  let spendResult = null;
  if (contentCost > 0) {
    spendResult = await creditMod.spend(workspaceId, contentCost, {
      reason: 'social_content',
      refType: 'social_generate',
      refId: body && body.leadId != null ? String(body.leadId) : null,
      userId: body && body.userId != null ? body.userId : null,
    });
  }
  try {
    const out = await withDb(workspaceId, (db) => social().generateMonth(db, body || {}));
    return {
      ...out,
      credits_charged: contentCost,
      credits_balance: spendResult
        ? spendResult.balance
        : await creditMod.getBalance(workspaceId),
    };
  } catch (e) {
    if (contentCost > 0) {
      try {
        await creditMod.grant(workspaceId, contentCost, {
          reason: 'refund_failed_content',
          refType: 'social_generate',
          refId: body && body.leadId != null ? String(body.leadId) : null,
        });
      } catch (re) {
        console.warn('[credits] refund after failed staff content:', re.message);
      }
    }
    throw e;
  }
}
function socialUpdatePost(workspaceId, postId, patch) {
  return withDb(workspaceId, (db) => social().updatePost(db, postId, patch || {}));
}
function socialSetCampaignStatus(workspaceId, id, status) {
  return withDb(workspaceId, (db) => social().setCampaignStatus(db, id, status));
}
async function socialSendWeekly(workspaceId, campaignId, force) {
  return withDb(workspaceId, (db) => social().sendWeeklyBatch(db, {
    campaignId, force: !!force, workspaceId,
  }));
}
function socialApproveAgency(workspaceId, postIds) {
  return withDb(workspaceId, (db) => social().approvePostsAgency(db, postIds));
}
async function socialPublishPost(workspaceId, postId) {
  return withDb(workspaceId, (db) => social().publishPost(db, postId));
}
async function socialPublishDue(workspaceId, payload) {
  return withDb(workspaceId, (db) => social().publishDue(db, payload || {}));
}
async function socialWeeklyTick(workspaceId) {
  return withDb(workspaceId, (db) => social().weeklyTick(db, { workspaceId }));
}
function socialBatchByToken(workspaceId, token) {
  return withDb(workspaceId, (db) => social().getBatchByToken(db, token));
}
function socialDecideBatch(workspaceId, token, body) {
  return withDb(workspaceId, (db) => social().decideBatch(db, token, body || {}));
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
  designPreviewUrl, designAddImages, designGenerateImages, designGenerateLogo,
  designDefaultInstructions, designAssets, designListAnswers, designSetContact, designEmailQuestions, designEmailDelivery,
  designClientFormLink, designClientFormGet, designClientFormSubmit,
  designRecordReply, designSaveWebsite, designRemoveDelivery, designAssetBase, designRenderHtml, designOpenPreview,
  emailRedesignList, emailRedesignGet, emailRedesignIngest, emailRedesignSubmit, emailRedesignDismiss, emailRedesignScan,
  imapPoll,
  learningStatus, learningPlaybook, learningEvents, learningClear, learningDistill,
  sitesList, sitesGet, sitesDelete, sitesGenerate, sitesQa, sitesExport, sitesExportZip, sitesAddImages, sitesOptimizeImages, sitesVersions, sitesDiff, sitesRestore,
  sitesSave, sitesGetStructure, sitesReorderStructure, sitesInsertSection, sitesAddBlock, sitesSetLogo, sitesSetTheme, sitesReplaceImage, sitesUploadAsset, sitesScreenshot, sitesForLead, sitesRenderHtml, sitesPreview, sitesApplyInstruction, validatePages,
  sitesScreenshotsList, sitesScreenshotsCapture,
  formsEnsureForSite,
  formsList, formsGet, formsCreate, formsSuggestFields, formsUpdate, formsDelete,
  modulesAttach,
  modulesDetach,
  modulesSummary,
  materializeWebsiteExport,
  optimizeExportImages,
  siteExportFolder,
  resolveSiteExportFolder,
  campaignsList, campaignsCreate, campaignsSetStatus, campaignsCancel, campaignsDelete, campaignsMessages,
  templatesList, templatesSave, templatesDelete,
  outreachProcessQueue, outreachStats, suppressionList, suppressionAdd, suppressionRemove,
  pipelineBoard, intentGet, intentRecord, outreachInterestResponse,
  outreachClaimMeta, outreachClaimDecide, sitesClaimKit, sitesPostcard, leadsClaimKit,
  emailCompose, emailSend, emailDraft, emailUploadAsset, smsQueue,
  settingsGetAll, settingsSet, settingsSetSecret, automationSet, promptsList, promptsSave, promptsReset, activityRecent,
  aiUsage, aiStatus,
  cfGetConfig, cfSaveConfig, cfTest, cfPublish,
  domainsSearch, domainsCheck, domainsOwned, domainsRegister, domainsRegistrationStatus,
  domainsList, domainsLink, domainsUnlink,
  runDiscoveryJobTick, runOutreachJobTick, runImapPollTick: imapPoll,
  handsOffStatus: (workspaceId) => require('./handsOff').getStatus(workspaceId),
  handsOffRunNow: (workspaceId, opts) => require('./handsOff').runTick(workspaceId, opts || {}),
  handsOffDigestNow: (workspaceId, opts) => require('./handsOff').sendDigest(workspaceId, opts || {}),
  socialOverview, socialAccounts, socialDisconnect, socialOauthStart, socialOauthCallback,
  socialCampaigns, socialCampaignGet, socialGenerateMonth, socialUpdatePost, socialSetCampaignStatus,
  socialSendWeekly, socialApproveAgency, socialPublishPost, socialPublishDue, socialWeeklyTick,
  socialBatchByToken, socialDecideBatch,
  getSetting, setSetting,
};
