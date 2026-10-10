'use strict';

/**
 * Leads IPC channels for Website Scout.
 *
 * register(ipcMain, db) attaches all `leads:*` + `providers:*` handlers.
 * Every handler validates its inputs server-side and returns
 * { ok: true, ... } or { ok: false, error }.
 */

const engine = require('../leadEngine');
const { listProviders, getProvider, configureFromSettings } = require('../providers');
const discoverySchedule = require('../discoverySchedule');

/* ---------------- input validation ---------------- */

function reqInt(v, name, { min = 1, max = 1000000, allowNull = false } = {}) {
  if (v === null || v === undefined) {
    if (allowNull) return null;
    throw new Error(`${name} is required`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function optStr(v, max = 2000) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (s.length > max) throw new Error(`value exceeds ${max} characters`);
  return s;
}

const SORT_COLUMNS = {
  name: 'business_name', category: 'category', score: 'score',
  status: 'status', source: 'source', updated: 'updated_at',
  group: 'lead_group',
};

function wrap(handler) {
  return async (_event, ...args) => {
    try {
      const data = await handler(...args);
      return { ok: true, ...(data === undefined ? {} : data) };
    } catch (err) {
      return { ok: false, error: err.message || String(err), code: err.code || null };
    }
  };
}

/* ---------------- registration ---------------- */

function register(ipcMain, db) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('leads IPC: ipcMain.handle is required');
  }
  if (!db) throw new Error('leads IPC: db is required');
  engine.ensureLeadColumns(db);

  // leads:list {q, status, minScore, tag, category, group, sort, page, pageSize}
  ipcMain.handle('leads:list', wrap((filters = {}) => {
    const q = optStr(filters.q, 200);
    const status = filters.status ? optStr(filters.status, 50) : null;
    if (status && !engine.LEAD_STATUSES.includes(status)) throw new Error(`invalid status: ${status}`);
    const minScore = filters.minScore === undefined || filters.minScore === null
      ? null : reqInt(filters.minScore, 'minScore', { min: 0, max: 100 });
    const tag = filters.tag ? optStr(filters.tag, 100) : null;
    const category = filters.category != null && filters.category !== ''
      ? optStr(filters.category, 200) : null;
    const group = filters.group != null && filters.group !== ''
      ? optStr(filters.group, 200) : null;
    const websitePresenceRaw = filters.websitePresence != null && filters.websitePresence !== ''
      ? String(filters.websitePresence).trim().toLowerCase() : '';
    const websitePresence = (websitePresenceRaw === 'has' || websitePresenceRaw === 'no')
      ? websitePresenceRaw : null;
    const sortKey = SORT_COLUMNS[filters.sort] ? filters.sort : 'updated';
    const order = String(filters.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const page = reqInt(filters.page ?? 1, 'page', { min: 1, max: 100000 });
    const pageSize = reqInt(filters.pageSize ?? 25, 'pageSize', { min: 1, max: 200 });
    const offset = (page - 1) * pageSize;

    const where = [];
    const params = [];
    if (q) {
      where.push('(business_name LIKE ? OR city LIKE ? OR category LIKE ? OR lead_group LIKE ? OR tags LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like, like, like);
    }
    if (status) { where.push('status = ?'); params.push(status); }
    if (minScore !== null) { where.push('score >= ?'); params.push(minScore); }
    if (tag) { where.push('tags LIKE ?'); params.push(`%"${tag.replace(/"/g, '')}"%`); }
    if (category === '(uncategorized)') {
      where.push("(category IS NULL OR TRIM(category) = '')");
    } else if (category) {
      where.push('category = ?');
      params.push(category);
    }
    if (group === '(ungrouped)') {
      where.push("(lead_group IS NULL OR TRIM(lead_group) = '')");
    } else if (group) {
      where.push('lead_group = ?');
      params.push(group);
    }
    // Has website = non-empty + valid http(s) URL (approx. of leadEngine.isValidUrl).
    // No website = null/empty/whitespace or not a valid http(s) URL.
    const hasWebsiteSql = `(
      website IS NOT NULL AND TRIM(website) != ''
      AND INSTR(TRIM(website), ' ') = 0
      AND (
        LOWER(TRIM(website)) LIKE 'http://%'
        OR LOWER(TRIM(website)) LIKE 'https://%'
        OR (INSTR(TRIM(website), '://') = 0 AND INSTR(TRIM(website), '.') > 0)
      )
    )`;
    if (websitePresence === 'has') {
      where.push(hasWebsiteSql);
    } else if (websitePresence === 'no') {
      where.push(`NOT ${hasWebsiteSql}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderCol = SORT_COLUMNS[sortKey];
    // When viewing by group/category, keep sections together then apply sort.
    const groupByView = filters.view === 'category' ? 'category' : (filters.view === 'group' ? 'lead_group' : null);
    const orderSql = groupByView
      ? `ORDER BY COALESCE(NULLIF(TRIM(${groupByView}), ''), '~') ASC, ${orderCol} ${order}`
      : `ORDER BY ${orderCol} ${order}`;
    const total = db.prepare(`SELECT COUNT(*) AS c FROM leads ${whereSql}`).get(...params).c;
    const rows = db.prepare(
      `SELECT * FROM leads ${whereSql} ${orderSql} LIMIT ? OFFSET ?`
    ).all(...params, pageSize, offset);

    const parsed = rows.map(r => ({
      ...r,
      tags: (() => { try { return JSON.parse(r.tags || '[]'); } catch { return []; } })(),
      qualified: Boolean(r.qualified),
      lead_group: r.lead_group || '',
    }));
    return { rows: parsed, total, page, pageSize };
  }));

  // leads:facets — distinct groups / categories / tags for filters
  ipcMain.handle('leads:facets', wrap(() => {
    return { facets: engine.listLeadFacets(db) };
  }));

  // leads:get id — includes latest score breakdown for the drawer
  ipcMain.handle('leads:get', wrap((id) => {
    const lead = engine.getLead(db, reqInt(id, 'id'));
    if (!lead) throw new Error(`lead not found: ${id}`);
    let scoreBreakdown = null;
    try {
      const s = db.prepare(
        'SELECT score, breakdown, at FROM lead_scores WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
      ).get(id);
      if (s) {
        scoreBreakdown = { score: s.score, at: s.at };
        try { scoreBreakdown.breakdown = JSON.parse(s.breakdown); } catch { scoreBreakdown.breakdown = {}; }
      }
    } catch { /* scoring history is optional */ }
    return { lead, scoreBreakdown };
  }));

  // leads:create obj
  ipcMain.handle('leads:create', wrap((obj) => {
    if (!obj || typeof obj !== 'object') throw new Error('lead object is required');
    return { lead: engine.createLead(db, obj) };
  }));

  // leads:update {id, obj}
  ipcMain.handle('leads:update', wrap((payload) => {
    if (!payload || typeof payload !== 'object') throw new Error('payload {id, obj} is required');
    const id = reqInt(payload.id, 'id');
    if (!payload.obj || typeof payload.obj !== 'object') throw new Error('obj is required');
    return { lead: engine.updateLead(db, id, payload.obj) };
  }));

  // leads:delete id
  ipcMain.handle('leads:delete', wrap((id) => {
    engine.deleteLead(db, reqInt(id, 'id'));
    return { id };
  }));

  // leads:score id
  ipcMain.handle('leads:score', wrap((id) => {
    const res = engine.scoreLead(db, reqInt(id, 'id'));
    return { result: res };
  }));

  // leads:qualify id
  ipcMain.handle('leads:qualify', wrap((id) => {
    const res = engine.qualifyLead(db, reqInt(id, 'id'));
    return { result: res };
  }));

  // leads:merge {keepId, dropIds}
  ipcMain.handle('leads:merge', wrap((payload) => {
    if (!payload || typeof payload !== 'object') throw new Error('payload {keepId, dropIds} is required');
    const keepId = reqInt(payload.keepId, 'keepId');
    if (!Array.isArray(payload.dropIds) || payload.dropIds.length === 0) {
      throw new Error('dropIds must be a non-empty array');
    }
    if (payload.dropIds.length > 50) throw new Error('cannot merge more than 50 leads at once');
    const dropIds = payload.dropIds.map(d => reqInt(d, 'dropId'));
    return { lead: engine.mergeLeads(db, keepId, dropIds) };
  }));

  // leads:bulk {action, ids, value?}
  // action: tag | untag | status | delete | research | set_group | set_category
  ipcMain.handle('leads:bulk', wrap(async (payload) => {
    if (!payload || typeof payload !== 'object') throw new Error('payload {action, ids} is required');
    const action = optStr(payload.action, 50);
    const valid = ['tag', 'untag', 'status', 'delete', 'research', 'set_group', 'set_category'];
    if (!valid.includes(action)) {
      throw new Error(`unsupported bulk action: ${action} (supported: ${valid.join(', ')})`);
    }
    if (!Array.isArray(payload.ids) || payload.ids.length === 0) throw new Error('ids must be a non-empty array');
    if (payload.ids.length > 200) throw new Error('cannot process more than 200 leads at once');
    const ids = payload.ids.map(d => reqInt(d, 'id'));

    const results = { action, processed: 0, failed: 0, errors: [] };
    if (action === 'delete') {
      for (const id of ids) {
        try { engine.deleteLead(db, id); results.processed++; }
        catch (e) { results.failed++; results.errors.push({ id, error: e.message }); }
      }
      return { bulk: results };
    }
    if (action === 'status') {
      const status = optStr(payload.value, 50);
      if (!engine.LEAD_STATUSES.includes(status)) throw new Error(`invalid status: ${status}`);
      for (const id of ids) {
        try { engine.updateLead(db, id, { status }); results.processed++; }
        catch (e) { results.failed++; results.errors.push({ id, error: e.message }); }
      }
      return { bulk: results };
    }
    if (action === 'set_group') {
      const group = engine.normalizeGroupName(payload.value);
      for (const id of ids) {
        try { engine.updateLead(db, id, { lead_group: group }); results.processed++; }
        catch (e) { results.failed++; results.errors.push({ id, error: e.message }); }
      }
      return { bulk: results };
    }
    if (action === 'set_category') {
      const category = optStr(payload.value, 200);
      if (!category) throw new Error('category value is required');
      for (const id of ids) {
        try { engine.updateLead(db, id, { category }); results.processed++; }
        catch (e) { results.failed++; results.errors.push({ id, error: e.message }); }
      }
      return { bulk: results };
    }
    if (action === 'tag' || action === 'untag') {
      const tag = optStr(payload.value, 100);
      if (!tag) throw new Error('tag value is required');
      for (const id of ids) {
        try {
          const lead = engine.getLead(db, id);
          if (!lead) throw new Error(`lead not found: ${id}`);
          const tags = new Set(lead.tags || []);
          if (action === 'tag') tags.add(tag); else tags.delete(tag);
          engine.updateLead(db, id, { tags: [...tags] });
          results.processed++;
        } catch (e) { results.failed++; results.errors.push({ id, error: e.message }); }
      }
      return { bulk: results };
    }
    if (action === 'research') {
      for (const id of ids) {
        try { await engine.researchLead(db, id); results.processed++; }
        catch (e) { results.failed++; results.errors.push({ id, error: e.message }); }
      }
      return { bulk: results };
    }
    return { bulk: results };
  }));

  // leads:importCsv text | { text, group? }
  ipcMain.handle('leads:importCsv', wrap((payload) => {
    let text = payload;
    let group = null;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      text = payload.text;
      group = optStr(payload.group, 200) || optStr(payload.lead_group, 200);
    }
    if (typeof text !== 'string') throw new Error('CSV text must be a string');
    return { result: engine.importCsv(db, text, { group }) };
  }));

  // leads:research id
  ipcMain.handle('leads:research', wrap(async (id) => {
    return { result: await engine.researchLead(db, reqInt(id, 'id')) };
  }));

  // leads:events id
  ipcMain.handle('leads:events', wrap((id) => {
    const leadId = reqInt(id, 'id');
    const events = db.prepare(
      'SELECT * FROM lead_events WHERE lead_id = ? ORDER BY at DESC, id DESC LIMIT 200'
    ).all(leadId);
    return { events };
  }));

  // leads:facts id
  ipcMain.handle('leads:facts', wrap((id) => {
    const leadId = reqInt(id, 'id');
    return { facts: engine.getFacts(db, leadId) };
  }));

  // leads:duplicates id — candidate duplicates for the merge UI
  ipcMain.handle('leads:duplicates', wrap((id) => {
    const lead = engine.getLead(db, reqInt(id, 'id'));
    if (!lead) throw new Error(`lead not found: ${id}`);
    return { duplicates: engine.findDuplicates(db, lead) };
  }));

  // providers:list
  ipcMain.handle('providers:list', wrap(() => {
    configureFromSettings(db);
    return { providers: listProviders() };
  }));

  // providers:search {provider, ...opts} — small extension point for discovery UI
  ipcMain.handle('providers:search', wrap(async (payload) => {
    configureFromSettings(db);
    if (!payload || typeof payload !== 'object') throw new Error('payload {provider, ...opts} is required');
    const name = optStr(payload.provider, 100);
    const provider = getProvider(name);
    if (!provider) throw new Error(`unknown provider: ${name}`);
    if (provider.configured === false) {
      // Throw through wrap -> { ok:false, code:'PROVIDER_NOT_CONFIGURED' }
      try { await provider.search(payload); }
      catch (e) { throw e; }
    }
    const limit = payload.limit === undefined ? 10 : reqInt(payload.limit, 'limit', { min: 1, max: 50 });
    const results = await provider.search({ ...payload, limit });
    return { results, provider: name };
  }));

  // leads:discover { provider?, category/query, location, limit, score?, websitePresence? }
  ipcMain.handle('leads:discover', wrap(async (payload = {}) => {
    configureFromSettings(db);
    const opts = payload && typeof payload === 'object' ? payload : {};
    const wp = opts.websitePresence != null ? String(opts.websitePresence).trim().toLowerCase() : '';
    return await engine.discoverLeads(db, {
      provider: optStr(opts.provider, 100) || 'tavily',
      query: optStr(opts.query, 200),
      category: optStr(opts.category, 200),
      location: optStr(opts.location, 200),
      group: optStr(opts.group, 200) || optStr(opts.lead_group, 200),
      limit: opts.limit === undefined ? 10 : reqInt(opts.limit, 'limit', { min: 1, max: 50 }),
      score: opts.score !== false,
      websitePresence: (wp === 'has' || wp === 'no') ? wp : undefined,
    });
  }));

  // discovery:getSchedule — current schedule config + last/next run status
  ipcMain.handle('discovery:getSchedule', wrap(() => discoverySchedule.readSchedule(db)));

  // discovery:setSchedule { enabled, mode, interval_hours, daily_time, provider, ... }
  ipcMain.handle('discovery:setSchedule', wrap((payload = {}) => {
    const opts = payload && typeof payload === 'object' ? payload : {};
    return { schedule: discoverySchedule.writeSchedule(db, opts) };
  }));

  // discovery:runNow — fire the scheduled query immediately (same discoverLeads path)
  ipcMain.handle('discovery:runNow', wrap(async () => {
    const res = await discoverySchedule.runDiscoveryJob(db, { force: true });
    if (res.skipped) {
      const err = new Error(
        res.reason === 'busy'
          ? 'A discovery run is already in progress.'
          : 'Discovery was skipped.'
      );
      err.code = res.reason === 'busy' ? 'BUSY' : 'SKIPPED';
      throw err;
    }
    if (!res.ok) {
      const err = new Error(res.error || 'Scheduled discovery failed');
      err.code = res.code || null;
      throw err;
    }
    return { result: res.result, schedule: res.schedule };
  }));

  return [
    'leads:list', 'leads:get', 'leads:create', 'leads:update', 'leads:delete',
    'leads:score', 'leads:qualify', 'leads:merge', 'leads:bulk',
    'leads:importCsv', 'leads:discover', 'leads:research', 'leads:events', 'leads:facts',
    'leads:duplicates', 'leads:facets',
    'providers:list', 'providers:search',
    'discovery:getSchedule', 'discovery:setSchedule', 'discovery:runNow',
  ];
}

module.exports = { register };
