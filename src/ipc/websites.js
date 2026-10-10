'use strict';

/**
 * IPC: websites (Workstream 3 — Website Engine).
 *
 * Channels:
 *  sites:list {status}            -> {ok, sites:[...]}
 *  sites:get id                   -> {ok, site} (includes claim manifest + business name)
 *  sites:generate leadId          -> {ok, id, industry, aiUsed, reused}
 *  sites:save {id, pages, theme, note} -> {ok, id, version}  (validates JSON shape)
 *  sites:versions id              -> {ok, versions:[...]}
 *  sites:restore versionId        -> {ok, site}
 *  sites:qa id                    -> {ok, pass, checks:[...]}
 *  sites:export id                -> {ok, path} (~/website-scout-exports/<slug>/)
 *  sites:forLead leadId           -> {ok, site|null}
 *  sites:renderHtml {id}          -> {ok, html} (iframe preview)
 */

const os = require('os');
const path = require('path');
const engine = require('../websiteEngine');
const ai = require('../ai');

function slugify(s) {
  return String(s || 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'site';
}

function ok(data) { return Object.assign({ ok: true }, data); }
function fail(e) {
  return { ok: false, error: e && e.message ? e.message : String(e), code: (e && e.code) || 'ERROR' };
}

/** Strict validation of the pages JSON shape. Throws on any violation. */
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
    if (!hasHtml && !hasSections) {
      throw siteErr('INVALID_PAGES', `pages[${i}] needs sections or html.`);
    }
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

function siteErr(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function parseJsonField(value, what) {
  if (typeof value === 'string') {
    try { return JSON.parse(value); }
    catch (e) { throw siteErr('INVALID_JSON', `${what} is not valid JSON.`); }
  }
  return value;
}

function siteRow(db, id) {
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
    preview_path: site.preview_path,
    created_at: site.created_at,
    updated_at: site.updated_at,
    business_name: lead ? lead.business_name : site.name,
    category: lead ? lead.category : null,
    manifest: engine.getManifest(db, site.id),
  };
}

function register(ipcMain, db) {
  ai.setDb(db);
  engine.ensureTables(db);

  const wrap = (fn) => async (_event, args) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };

  ipcMain.handle('sites:list', wrap((args = {}) => {
    const { pageArgs, pageResult } = require('../paginate');
    const { page, pageSize, offset } = pageArgs(args || {}, { pageSize: 25, maxSize: 100 });
    let where = '';
    const params = [];
    if (args && args.status) { where = ' WHERE w.status = ?'; params.push(args.status); }
    const total = db.prepare(`SELECT COUNT(*) AS c FROM websites w${where}`).get(...params).c;
    const rows = db.prepare(
      `SELECT w.*, l.business_name, l.category,
         (SELECT COUNT(*) FROM website_versions v WHERE v.website_id = w.id) AS version_count
       FROM websites w LEFT JOIN leads l ON l.id = w.lead_id
       ${where}
       ORDER BY w.updated_at DESC
       LIMIT ? OFFSET ?`
    ).all(...params, pageSize, offset);
    const sites = rows.map(r => ({
      id: r.id, lead_id: r.lead_id, name: r.name, industry: r.industry,
      status: r.status, preview_path: r.preview_path, origin: r.origin,
      created_at: r.created_at, updated_at: r.updated_at,
      business_name: r.business_name, category: r.category,
      version_count: r.version_count,
    }));
    return Object.assign({ sites }, pageResult(sites, total, page, pageSize));
  }));

  ipcMain.handle('sites:get', wrap((id) => {
    if (!Number.isInteger(Number(id))) throw siteErr('INVALID_ID', 'id must be an integer.');
    return { site: siteRow(db, Number(id)) };
  }));

  ipcMain.handle('sites:generate', wrap(async (args) => {
    // Assign-to-agent is design:create. This channel is the explicit template fallback.
    const leadId = Number(args && typeof args === 'object' ? args.leadId : args);
    const force = !!(args && typeof args === 'object' && args.force);
    const fallback = !!(args && typeof args === 'object' && args.fallback);
    if (!Number.isInteger(leadId)) throw siteErr('INVALID_ID', 'leadId must be an integer.');
    engine.ensureTables(db);
    const existing = db.prepare('SELECT id, origin FROM websites WHERE lead_id = ?').get(leadId);
    if (existing && existing.origin === 'agent' && !fallback) {
      throw siteErr('AGENT_SITE', 'An agent already delivered this website. Template fallback replaces it only when you confirm that overwrite.');
    }
    return await engine.generateSite(db, leadId, { force: fallback ? true : force });
  }));

  ipcMain.handle('sites:save', wrap((args = {}) => {
    const id = Number(args.id);
    if (!Number.isInteger(id)) throw siteErr('INVALID_ID', 'id must be an integer.');
    const pages = validatePages(parseJsonField(args.pages, 'pages'));
    const theme = parseJsonField(args.theme, 'theme');
    if (!theme || typeof theme !== 'object' || Array.isArray(theme)) {
      throw siteErr('INVALID_THEME', 'theme must be an object.');
    }
    const version = engine.saveSite(db, id, pages, theme, args.note);
    return { id, version: { id: version.id, version_no: version.version_no } };
  }));

  ipcMain.handle('sites:versions', wrap((args) => {
    const { pageArgs, pageResult } = require('../paginate');
    const id = Number(args && typeof args === 'object' && args.id != null ? args.id : args);
    if (!Number.isInteger(id)) throw siteErr('INVALID_ID', 'id must be an integer.');
    engine.getWebsite(db, id);
    const { page, pageSize, offset } = pageArgs(args && typeof args === 'object' ? args : {}, { pageSize: 20, maxSize: 100 });
    const total = db.prepare('SELECT COUNT(*) AS c FROM website_versions WHERE website_id = ?').get(id).c;
    const versions = db.prepare(
      'SELECT id, version_no, note, created_at FROM website_versions WHERE website_id = ? ORDER BY version_no DESC LIMIT ? OFFSET ?'
    ).all(id, pageSize, offset);
    return Object.assign({ versions }, pageResult(versions, total, page, pageSize));
  }));

  ipcMain.handle('sites:restore', wrap((versionId) => {
    if (!Number.isInteger(Number(versionId))) throw siteErr('INVALID_ID', 'versionId must be an integer.');
    const site = engine.restoreVersion(db, Number(versionId));
    return { site: siteRow(db, site.id) };
  }));

  ipcMain.handle('sites:qa', wrap(async (id) => {
    if (!Number.isInteger(Number(id))) throw siteErr('INVALID_ID', 'id must be an integer.');
    return await engine.qaSite(db, Number(id));
  }));

  ipcMain.handle('sites:export', wrap((id) => {
    if (!Number.isInteger(Number(id))) throw siteErr('INVALID_ID', 'id must be an integer.');
    const site = engine.getWebsite(db, Number(id));
    const dir = path.join(os.homedir(), 'website-scout-exports', `${slugify(site.name)}-${site.id}`);
    const out = engine.exportStatic(db, Number(id), dir);
    return { path: out };
  }));

  ipcMain.handle('sites:forLead', wrap((leadId) => {
    if (!Number.isInteger(Number(leadId))) throw siteErr('INVALID_ID', 'leadId must be an integer.');
    const row = db.prepare('SELECT id FROM websites WHERE lead_id = ?').get(Number(leadId));
    return { site: row ? siteRow(db, row.id) : null };
  }));

  ipcMain.handle('sites:renderHtml', wrap((args) => {
    const opts = {
      editable: !!(args && args.editable),
      pageSlug: args && args.pageSlug,
      pageIndex: args && (Number.isInteger(args.pageIndex) ? args.pageIndex : (args.pageIndex != null ? Number(args.pageIndex) : undefined)),
    };
    let pages;
    let theme;
    if (args && Array.isArray(args.pages)) {
      pages = args.pages;
      theme = args.theme && typeof args.theme === 'object' ? args.theme : {};
    } else {
      const id = Number(args && args.id !== undefined ? args.id : args);
      if (!Number.isInteger(id)) throw siteErr('INVALID_ID', 'id must be an integer.');
      const site = engine.getWebsite(db, id);
      pages = parseJsonField(site.pages, 'pages');
      theme = parseJsonField(site.theme, 'theme');
      opts.editable = true;
    }
    const list = pages.map((p) => ({ slug: p.slug, title: p.title }));
    if (opts.pageSlug != null || Number.isInteger(opts.pageIndex)) {
      return { html: engine.renderPageAt(pages, theme, opts), pages: list };
    }
    return { html: engine.renderSite(pages, theme, opts), pages: list };
  }));

  ipcMain.handle('sites:openPreview', wrap(async (id) => {
    const websiteId = Number(id && id.id !== undefined ? id.id : id);
    if (!Number.isInteger(websiteId)) throw siteErr('INVALID_ID', 'id must be an integer.');
    const openPreview = require('../openPreview');
    const opened = await openPreview.openWebsiteFile(db, websiteId);
    return { path: opened.path };
  }));

  ipcMain.handle('sites:addImages', wrap(async (args = {}) => {
    const id = Number(args.id);
    if (!Number.isInteger(id)) throw siteErr('INVALID_ID', 'id must be an integer.');
    return await engine.attachPexelsImages(db, id, { query: args.query, count: args.count });
  }));
}

module.exports = { register, validatePages };
