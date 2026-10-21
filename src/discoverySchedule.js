'use strict';

/**
 * Scheduled lead discovery (main process).
 *
 * Runs while the Electron app is open (setInterval tick). Does not register
 * a Windows Task Scheduler job. Respects automation_paused and never overlaps
 * concurrent discovery runs. Reuses leadEngine.discoverLeads.
 */

const TICK_MS = 60 * 1000;
const KEYS = {
  enabled: 'discovery.schedule.enabled',
  mode: 'discovery.schedule.mode',
  intervalHours: 'discovery.schedule.interval_hours',
  dailyTime: 'discovery.schedule.daily_time',
  provider: 'discovery.schedule.provider',
  category: 'discovery.schedule.category',
  location: 'discovery.schedule.location',
  limit: 'discovery.schedule.limit',
  score: 'discovery.schedule.score',
  group: 'discovery.schedule.group',
  websitePresence: 'discovery.schedule.website_presence',
  lastRun: 'discovery.schedule.last_run',
  nextRun: 'discovery.schedule.next_run',
  lastStatus: 'discovery.schedule.last_status',
  lastError: 'discovery.schedule.last_error',
  lastResult: 'discovery.schedule.last_result',
};

const DEFAULTS = {
  enabled: '0',
  mode: 'interval',
  interval_hours: '6',
  daily_time: '09:00',
  provider: 'tavily',
  category: 'Plumber',
  location: 'Springfield',
  limit: '8',
  score: '1',
  group: '',
  website_presence: '',
  last_run: '',
  next_run: '',
  last_status: '',
  last_error: '',
  last_result: '',
};

let timer = null;
let running = false;
let boundDb = null;

function getSetting(db, key, fallback = '') {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row && row.value != null ? String(row.value) : fallback;
  } catch {
    return fallback;
  }
}

function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value == null ? '' : String(value));
}

function ensureDefaults(db) {
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  insert.run(KEYS.enabled, DEFAULTS.enabled);
  insert.run(KEYS.mode, DEFAULTS.mode);
  insert.run(KEYS.intervalHours, DEFAULTS.interval_hours);
  insert.run(KEYS.dailyTime, DEFAULTS.daily_time);
  insert.run(KEYS.provider, DEFAULTS.provider);
  insert.run(KEYS.category, DEFAULTS.category);
  insert.run(KEYS.location, DEFAULTS.location);
  insert.run(KEYS.limit, DEFAULTS.limit);
  insert.run(KEYS.score, DEFAULTS.score);
  insert.run(KEYS.group, DEFAULTS.group);
  insert.run(KEYS.websitePresence, DEFAULTS.website_presence);
  insert.run(KEYS.lastRun, DEFAULTS.last_run);
  insert.run(KEYS.nextRun, DEFAULTS.next_run);
  insert.run(KEYS.lastStatus, DEFAULTS.last_status);
  insert.run(KEYS.lastError, DEFAULTS.last_error);
  insert.run(KEYS.lastResult, DEFAULTS.last_result);
}

function parseDailyTime(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h < 0 || h > 23 || min < 0 || min > 59) {
    return null;
  }
  return { h, min, label: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` };
}

function toLocalIso(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function parseLocalIso(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.trim().match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/
  );
  if (!m) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6] || 0)
  );
}

/**
 * Compute the next run time from `from` (exclusive of a run that just finished).
 * @param {{ mode: string, interval_hours: number, daily_time: string }} cfg
 * @param {Date} [from]
 */
function computeNextRun(cfg, from = new Date()) {
  const base = from instanceof Date ? new Date(from.getTime()) : new Date();
  if (cfg.mode === 'daily') {
    const t = parseDailyTime(cfg.daily_time) || parseDailyTime(DEFAULTS.daily_time);
    const next = new Date(base.getTime());
    next.setSeconds(0, 0);
    next.setHours(t.h, t.min, 0, 0);
    if (next.getTime() <= base.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  }
  const hours = Math.min(168, Math.max(1, Number(cfg.interval_hours) || 6));
  return new Date(base.getTime() + hours * 60 * 60 * 1000);
}

function readSchedule(db) {
  ensureDefaults(db);
  const mode = getSetting(db, KEYS.mode, DEFAULTS.mode) === 'daily' ? 'daily' : 'interval';
  const intervalHours = Math.min(
    168,
    Math.max(1, parseInt(getSetting(db, KEYS.intervalHours, DEFAULTS.interval_hours), 10) || 6)
  );
  const dailyParsed = parseDailyTime(getSetting(db, KEYS.dailyTime, DEFAULTS.daily_time));
  const dailyTime = dailyParsed ? dailyParsed.label : DEFAULTS.daily_time;
  const limit = Math.min(
    50,
    Math.max(1, parseInt(getSetting(db, KEYS.limit, DEFAULTS.limit), 10) || 8)
  );
  return {
    enabled: getSetting(db, KEYS.enabled, DEFAULTS.enabled) === '1',
    mode,
    interval_hours: intervalHours,
    daily_time: dailyTime,
    provider: getSetting(db, KEYS.provider, DEFAULTS.provider) || 'tavily',
    category: getSetting(db, KEYS.category, DEFAULTS.category) || DEFAULTS.category,
    location: getSetting(db, KEYS.location, DEFAULTS.location) || DEFAULTS.location,
    limit,
    score: getSetting(db, KEYS.score, DEFAULTS.score) !== '0',
    group: getSetting(db, KEYS.group, DEFAULTS.group) || '',
    websitePresence: (() => {
      const v = getSetting(db, KEYS.websitePresence, DEFAULTS.website_presence).trim().toLowerCase();
      return (v === 'has' || v === 'no') ? v : '';
    })(),
    last_run: getSetting(db, KEYS.lastRun, '') || '',
    next_run: getSetting(db, KEYS.nextRun, '') || '',
    last_status: getSetting(db, KEYS.lastStatus, '') || '',
    last_error: getSetting(db, KEYS.lastError, '') || '',
    last_result: getSetting(db, KEYS.lastResult, '') || '',
    running,
    runs_while_app_open: true,
  };
}

function validatePatch(patch = {}) {
  const out = {};
  if (patch.enabled !== undefined) {
    out.enabled = patch.enabled === true || patch.enabled === 1 || patch.enabled === '1' ? '1' : '0';
  }
  if (patch.mode !== undefined) {
    const m = String(patch.mode).trim();
    if (m !== 'interval' && m !== 'daily') throw new Error('mode must be "interval" or "daily"');
    out.mode = m;
  }
  if (patch.interval_hours !== undefined) {
    const n = Number(patch.interval_hours);
    if (!Number.isInteger(n) || n < 1 || n > 168) {
      throw new Error('interval_hours must be an integer between 1 and 168');
    }
    out.interval_hours = String(n);
  }
  if (patch.daily_time !== undefined) {
    const t = parseDailyTime(patch.daily_time);
    if (!t) throw new Error('daily_time must be HH:MM (24h)');
    out.daily_time = t.label;
  }
  if (patch.provider !== undefined) {
    const p = String(patch.provider || '').trim();
    if (!p || p.length > 100) throw new Error('provider is required (max 100 chars)');
    out.provider = p;
  }
  if (patch.category !== undefined) {
    const c = String(patch.category || '').trim();
    // "*" / "any" = no niche filter (search local businesses broadly).
    if (!c || c.length > 200) throw new Error('category is required (max 200 chars); use * for any');
    out.category = c;
  }
  if (patch.location !== undefined) {
    const loc = String(patch.location || '').trim();
    if (!loc || loc.length > 200) throw new Error('location is required (max 200 chars)');
    out.location = loc;
  }
  if (patch.limit !== undefined) {
    const n = Number(patch.limit);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      throw new Error('limit must be an integer between 1 and 50');
    }
    out.limit = String(n);
  }
  if (patch.score !== undefined) {
    out.score = patch.score === false || patch.score === 0 || patch.score === '0' ? '0' : '1';
  }
  if (patch.group !== undefined) {
    const g = String(patch.group == null ? '' : patch.group).trim();
    if (g.length > 200) throw new Error('group must be 200 chars or fewer');
    out.group = g;
  }
  if (patch.websitePresence !== undefined) {
    const v = String(patch.websitePresence == null ? '' : patch.websitePresence).trim().toLowerCase();
    if (v && v !== 'has' && v !== 'no') {
      throw new Error('websitePresence must be "", "has", or "no"');
    }
    out.websitePresence = v;
  }
  return out;
}

function writeSchedule(db, patch = {}) {
  ensureDefaults(db);
  const norm = validatePatch(patch);
  const map = {
    enabled: KEYS.enabled,
    mode: KEYS.mode,
    interval_hours: KEYS.intervalHours,
    daily_time: KEYS.dailyTime,
    provider: KEYS.provider,
    category: KEYS.category,
    location: KEYS.location,
    limit: KEYS.limit,
    score: KEYS.score,
    group: KEYS.group,
    websitePresence: KEYS.websitePresence,
  };
  for (const [k, v] of Object.entries(norm)) {
    if (map[k]) setSetting(db, map[k], v);
  }

  const schedule = readSchedule(db);
  if (schedule.enabled) {
    // Recalculate from now so frequency edits take effect immediately.
    const next = computeNextRun(schedule, new Date());
    setSetting(db, KEYS.nextRun, toLocalIso(next));
  }
  return readSchedule(db);
}

function isAutomationPaused(db) {
  return getSetting(db, 'automation_paused', '0') === '1';
}

function isDue(schedule, now = new Date()) {
  if (!schedule.enabled) return false;
  if (!schedule.next_run) return true;
  const next = parseLocalIso(schedule.next_run);
  if (!next) return true;
  return next.getTime() <= now.getTime();
}

async function executeDiscovery(db, schedule) {
  const { configureFromSettings } = require('./providers');
  const { discoverLeads } = require('./leadEngine');
  configureFromSettings(db);
  return discoverLeads(db, {
    provider: schedule.provider || 'tavily',
    category: schedule.category,
    query: schedule.category,
    location: schedule.location,
    limit: schedule.limit,
    score: schedule.score !== false,
    group: schedule.group || undefined,
    websitePresence: schedule.websitePresence || undefined,
  });
}

/**
 * @param {object} db
 * @param {{ force?: boolean }} [opts]
 */
async function runDiscoveryJob(db, opts = {}) {
  const force = Boolean(opts.force);
  if (running) {
    return { ok: false, skipped: true, reason: 'busy', schedule: readSchedule(db) };
  }
  if (!force && isAutomationPaused(db)) {
    setSetting(db, KEYS.lastStatus, 'skipped_paused');
    setSetting(db, KEYS.lastError, 'Automation is paused');
    return { ok: false, skipped: true, reason: 'paused', schedule: readSchedule(db) };
  }
  if (force && isAutomationPaused(db)) {
    const err = new Error('Automation is paused. Resume it before running discovery.');
    err.code = 'AUTOMATION_PAUSED';
    throw err;
  }

  const schedule = readSchedule(db);
  running = true;
  const started = new Date();
  let outcome;
  try {
    const result = await executeDiscovery(db, schedule);
    const summary = {
      provider: result.provider,
      created: result.created,
      skipped: result.skipped,
      scored: result.scored,
      queried: result.queried,
      group: result.group,
    };
    setSetting(db, KEYS.lastRun, toLocalIso(started));
    setSetting(db, KEYS.lastStatus, 'ok');
    setSetting(db, KEYS.lastError, '');
    setSetting(db, KEYS.lastResult, JSON.stringify(summary));
    const next = computeNextRun(readSchedule(db), started);
    setSetting(db, KEYS.nextRun, toLocalIso(next));
    try {
      db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
        'leads',
        `Scheduled discovery: ${summary.created} created, ${summary.skipped} skipped (${summary.provider}).`
      );
    } catch { /* ignore */ }
    outcome = { ok: true, result: summary };
  } catch (e) {
    setSetting(db, KEYS.lastRun, toLocalIso(started));
    setSetting(db, KEYS.lastStatus, 'error');
    setSetting(db, KEYS.lastError, String(e.message || e).slice(0, 500));
    const next = computeNextRun(readSchedule(db), started);
    setSetting(db, KEYS.nextRun, toLocalIso(next));
    try {
      db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
        'leads',
        `Scheduled discovery failed: ${String(e.message || e).slice(0, 300)}`
      );
    } catch { /* ignore */ }
    outcome = {
      ok: false,
      error: String(e.message || e),
      code: e.code || null,
    };
  } finally {
    running = false;
  }
  outcome.schedule = readSchedule(db);
  return outcome;
}

async function tick(db) {
  if (!db || running) return;
  const schedule = readSchedule(db);
  if (!isDue(schedule)) return;
  if (isAutomationPaused(db)) {
    setSetting(db, KEYS.lastStatus, 'skipped_paused');
    setSetting(db, KEYS.lastError, 'Automation is paused');
    return;
  }
  await runDiscoveryJob(db, { force: false });
}

function start(db) {
  if (!db) throw new Error('discoverySchedule.start requires db');
  boundDb = db;
  ensureDefaults(db);
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    tick(boundDb).catch((e) => {
      console.warn('[website-scout] discovery schedule tick failed:', e.message);
    });
  }, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  // Catch up soon after boot without waiting a full minute.
  setTimeout(() => {
    tick(boundDb).catch((e) => {
      console.warn('[website-scout] discovery schedule boot tick failed:', e.message);
    });
  }, 5000).unref?.();
  return readSchedule(db);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  boundDb = null;
}

module.exports = {
  KEYS,
  DEFAULTS,
  TICK_MS,
  ensureDefaults,
  readSchedule,
  writeSchedule,
  computeNextRun,
  parseDailyTime,
  parseLocalIso,
  toLocalIso,
  isDue,
  isAutomationPaused,
  runDiscoveryJob,
  tick,
  start,
  stop,
  get running() { return running; },
};
