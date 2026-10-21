'use strict';

/**
 * Platform "Did you know?" upsell tips for Free (basic) portal users.
 * Admin CRUD; portal picks the next eligible tip and shows Upgrade CTA.
 */

const { query, driver } = require('./db');
const { getPlan, normalizePlanId, PLAN_FREE } = require('./plans');

const FEATURE_OPTIONS = [
  { key: 'chatbot', label: 'AI site chatbot', minPlan: 'standard' },
  { key: 'siteModules', label: 'Site modules (blog, bookings, …)', minPlan: 'standard' },
  { key: 'formInbox', label: 'Form submissions inbox', minPlan: 'standard' },
  { key: 'formMcp', label: 'Forms via MCP + Muse', minPlan: 'premium' },
  { key: 'socialMcpSchedule', label: 'MCP social scheduling', minPlan: 'premium' },
  { key: 'support', label: 'Included support', minPlan: 'standard' },
  { key: 'socialImagesIncluded', label: 'Social images included', minPlan: 'premium' },
];

const DEFAULT_TIPS = [
  {
    title: 'Did you know?',
    body: 'Standard and Premium include an AI site chatbot that answers visitors from your knowledge files and captures leads when you can’t reply live.',
    feature_key: 'chatbot',
    frequency_hours: 72,
    weight: 2,
    sort_order: 10,
  },
  {
    title: 'Did you know?',
    body: 'Upgrade to unlock site modules — bookings, blog, gallery, FAQ, and more — managed from your portal without rebuilding the site.',
    feature_key: 'siteModules',
    frequency_hours: 72,
    weight: 2,
    sort_order: 20,
  },
  {
    title: 'Did you know?',
    body: 'On Free, form results are emailed only. Standard keeps every submission in your portal inbox so nothing gets lost.',
    feature_key: 'formInbox',
    frequency_hours: 96,
    weight: 1,
    sort_order: 30,
  },
  {
    title: 'Did you know?',
    body: 'Paid plans include regular support so you’re not alone after launch — Standard monthly, Premium weekly.',
    feature_key: 'support',
    frequency_hours: 120,
    weight: 1,
    sort_order: 40,
  },
];

let _ensured = false;

function fail(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function isMysql() {
  return driver() === 'mysql';
}

async function ensureTables() {
  if (_ensured) return;
  if (isMysql()) {
    await query(`
      CREATE TABLE IF NOT EXISTS upsell_tips (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        body TEXT NOT NULL,
        feature_key VARCHAR(80) NOT NULL DEFAULT '',
        target_plans VARCHAR(80) NOT NULL DEFAULT 'free',
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        frequency_hours INT NOT NULL DEFAULT 72,
        weight INT NOT NULL DEFAULT 1,
        sort_order INT NOT NULL DEFAULT 0,
        cta_label VARCHAR(80) NOT NULL DEFAULT 'Upgrade',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_upsell_tips_enabled (enabled, sort_order)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS upsell_tip_impressions (
        portal_user_id BIGINT UNSIGNED NOT NULL,
        tip_id BIGINT UNSIGNED NOT NULL,
        last_shown_at DATETIME NOT NULL,
        show_count INT NOT NULL DEFAULT 1,
        PRIMARY KEY (portal_user_id, tip_id),
        KEY idx_upsell_imp_shown (last_shown_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  } else {
    await query(`
      CREATE TABLE IF NOT EXISTS upsell_tips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        feature_key TEXT NOT NULL DEFAULT '',
        target_plans TEXT NOT NULL DEFAULT 'free',
        enabled INTEGER NOT NULL DEFAULT 1,
        frequency_hours INTEGER NOT NULL DEFAULT 72,
        weight INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        cta_label TEXT NOT NULL DEFAULT 'Upgrade',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS upsell_tip_impressions (
        portal_user_id INTEGER NOT NULL,
        tip_id INTEGER NOT NULL,
        last_shown_at TEXT NOT NULL,
        show_count INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (portal_user_id, tip_id)
      )
    `);
  }
  await seedDefaultsIfEmpty();
  _ensured = true;
}

async function seedDefaultsIfEmpty() {
  const rows = await query('SELECT COUNT(*) AS c FROM upsell_tips');
  const count = Number((rows[0] && (rows[0].c ?? rows[0].C)) || 0);
  if (count > 0) return;
  for (const tip of DEFAULT_TIPS) {
    await createTip(tip, { skipEnsure: true });
  }
}

function publicTip(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    title: String(row.title || ''),
    body: String(row.body || ''),
    feature_key: String(row.feature_key || ''),
    target_plans: String(row.target_plans || 'free')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    enabled: !!Number(row.enabled),
    frequency_hours: Math.max(1, Number(row.frequency_hours) || 72),
    weight: Math.max(1, Number(row.weight) || 1),
    sort_order: Number(row.sort_order) || 0,
    cta_label: String(row.cta_label || 'Upgrade').slice(0, 80) || 'Upgrade',
    created_at: row.created_at,
    updated_at: row.updated_at,
    show_count: row.show_count != null ? Number(row.show_count) : undefined,
    last_shown_at: row.last_shown_at || undefined,
  };
}

function planHasFeature(planId, featureKey) {
  const plan = getPlan(planId);
  const ents = plan.entitlements || {};
  if (featureKey === 'support') return String(ents.supportCadence || 'none') !== 'none';
  return !!ents[featureKey];
}

function tipTargetsPlan(tip, planId) {
  const targets = tip.target_plans && tip.target_plans.length
    ? tip.target_plans
    : [PLAN_FREE];
  return targets.includes(normalizePlanId(planId));
}

async function listTips({ includeStats = false } = {}) {
  await ensureTables();
  const rows = await query(
    'SELECT * FROM upsell_tips ORDER BY sort_order ASC, id ASC'
  );
  let stats = {};
  if (includeStats) {
    const imp = await query(`
      SELECT tip_id,
             COUNT(*) AS viewers,
             COALESCE(SUM(show_count), 0) AS shows
      FROM upsell_tip_impressions
      GROUP BY tip_id
    `);
    for (const r of imp) {
      stats[Number(r.tip_id)] = {
        viewers: Number(r.viewers) || 0,
        shows: Number(r.shows) || 0,
      };
    }
  }
  return rows.map((r) => {
    const tip = publicTip(r);
    if (includeStats) {
      tip.stats = stats[tip.id] || { viewers: 0, shows: 0 };
    }
    return tip;
  });
}

async function getTip(id) {
  await ensureTables();
  const rows = await query('SELECT * FROM upsell_tips WHERE id = :id LIMIT 1', { id: Number(id) });
  return publicTip(rows[0]);
}

function normalizeTipInput(body = {}) {
  const title = String(body.title || '').trim().slice(0, 200);
  const tipBody = String(body.body || '').trim().slice(0, 2000);
  if (!title) throw fail('VALIDATION', 'title is required');
  if (!tipBody) throw fail('VALIDATION', 'body is required');
  const feature_key = String(body.feature_key || '').trim().slice(0, 80);
  let target_plans = body.target_plans;
  if (Array.isArray(target_plans)) {
    target_plans = target_plans.map((p) => normalizePlanId(p)).join(',');
  } else {
    target_plans = String(target_plans || 'free')
      .split(',')
      .map((p) => normalizePlanId(p.trim()))
      .filter(Boolean)
      .join(',') || 'free';
  }
  return {
    title,
    body: tipBody,
    feature_key,
    target_plans,
    enabled: body.enabled == null ? 1 : (body.enabled ? 1 : 0),
    frequency_hours: Math.min(8760, Math.max(1, Number(body.frequency_hours) || 72)),
    weight: Math.min(100, Math.max(1, Number(body.weight) || 1)),
    sort_order: Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 0,
    cta_label: String(body.cta_label || 'Upgrade').trim().slice(0, 80) || 'Upgrade',
  };
}

async function createTip(body, { skipEnsure } = {}) {
  if (!skipEnsure) await ensureTables();
  const data = normalizeTipInput(body);
  if (isMysql()) {
    const result = await query(
      `INSERT INTO upsell_tips
        (title, body, feature_key, target_plans, enabled, frequency_hours, weight, sort_order, cta_label)
       VALUES
        (:title, :body, :feature_key, :target_plans, :enabled, :frequency_hours, :weight, :sort_order, :cta_label)`,
      data
    );
    return getTip(result.insertId);
  }
  const result = await query(
    `INSERT INTO upsell_tips
      (title, body, feature_key, target_plans, enabled, frequency_hours, weight, sort_order, cta_label)
     VALUES
      (:title, :body, :feature_key, :target_plans, :enabled, :frequency_hours, :weight, :sort_order, :cta_label)`,
    data
  );
  return getTip(result.lastInsertRowid || result.insertId);
}

async function updateTip(id, body) {
  await ensureTables();
  const existing = await getTip(id);
  if (!existing) throw fail('NOT_FOUND', 'Tip not found', 404);
  const merged = {
    title: body.title != null ? body.title : existing.title,
    body: body.body != null ? body.body : existing.body,
    feature_key: body.feature_key != null ? body.feature_key : existing.feature_key,
    target_plans: body.target_plans != null ? body.target_plans : existing.target_plans,
    enabled: body.enabled != null ? body.enabled : existing.enabled,
    frequency_hours: body.frequency_hours != null ? body.frequency_hours : existing.frequency_hours,
    weight: body.weight != null ? body.weight : existing.weight,
    sort_order: body.sort_order != null ? body.sort_order : existing.sort_order,
    cta_label: body.cta_label != null ? body.cta_label : existing.cta_label,
  };
  const data = { ...normalizeTipInput(merged), id: Number(id) };
  if (isMysql()) {
    await query(
      `UPDATE upsell_tips SET
        title=:title, body=:body, feature_key=:feature_key, target_plans=:target_plans,
        enabled=:enabled, frequency_hours=:frequency_hours, weight=:weight,
        sort_order=:sort_order, cta_label=:cta_label
       WHERE id=:id`,
      data
    );
  } else {
    await query(
      `UPDATE upsell_tips SET
        title=:title, body=:body, feature_key=:feature_key, target_plans=:target_plans,
        enabled=:enabled, frequency_hours=:frequency_hours, weight=:weight,
        sort_order=:sort_order, cta_label=:cta_label,
        updated_at=datetime('now')
       WHERE id=:id`,
      data
    );
  }
  return getTip(id);
}

async function deleteTip(id) {
  await ensureTables();
  const existing = await getTip(id);
  if (!existing) throw fail('NOT_FOUND', 'Tip not found', 404);
  await query('DELETE FROM upsell_tip_impressions WHERE tip_id = :id', { id: Number(id) });
  await query('DELETE FROM upsell_tips WHERE id = :id', { id: Number(id) });
  return { deleted: true, id: Number(id) };
}

function pickWeighted(candidates) {
  if (!candidates.length) return null;
  let total = 0;
  for (const c of candidates) total += Math.max(1, c.weight || 1);
  let r = Math.random() * total;
  for (const c of candidates) {
    r -= Math.max(1, c.weight || 1);
    if (r <= 0) return c;
  }
  return candidates[candidates.length - 1];
}

async function recordImpression(portalUserId, tipId) {
  const uid = Number(portalUserId);
  const tid = Number(tipId);
  if (isMysql()) {
    await query(
      `INSERT INTO upsell_tip_impressions (portal_user_id, tip_id, last_shown_at, show_count)
       VALUES (:uid, :tid, NOW(), 1)
       ON DUPLICATE KEY UPDATE
         last_shown_at = NOW(),
         show_count = show_count + 1`,
      { uid, tid }
    );
  } else {
    const existing = await query(
      'SELECT show_count FROM upsell_tip_impressions WHERE portal_user_id = :uid AND tip_id = :tid',
      { uid, tid }
    );
    if (existing[0]) {
      await query(
        `UPDATE upsell_tip_impressions
         SET last_shown_at = datetime('now'), show_count = show_count + 1
         WHERE portal_user_id = :uid AND tip_id = :tid`,
        { uid, tid }
      );
    } else {
      await query(
        `INSERT INTO upsell_tip_impressions (portal_user_id, tip_id, last_shown_at, show_count)
         VALUES (:uid, :tid, datetime('now'), 1)`,
        { uid, tid }
      );
    }
  }
}

/**
 * Next tip for a portal client on Free (or other targeted plans).
 * Skips tips for features they already have; respects per-tip frequency_hours.
 */
async function nextTipForClient({ portalUserId, planId }) {
  await ensureTables();
  const plan = normalizePlanId(planId);
  if (plan !== PLAN_FREE) {
    // Only Free / basic for now (admin can still target free explicitly).
    const tips = await listTips();
    const anyOther = tips.some((t) => t.enabled && tipTargetsPlan(t, plan));
    if (!anyOther) return { tip: null, reason: 'paid_plan' };
  }

  const tips = await listTips();
  const impressions = await query(
    'SELECT tip_id, last_shown_at, show_count FROM upsell_tip_impressions WHERE portal_user_id = :uid',
    { uid: Number(portalUserId) }
  );
  const byTip = new Map();
  for (const row of impressions) {
    byTip.set(Number(row.tip_id), row);
  }

  const now = Date.now();
  const eligible = [];
  for (const tip of tips) {
    if (!tip.enabled) continue;
    if (!tipTargetsPlan(tip, plan)) continue;
    if (tip.feature_key && planHasFeature(plan, tip.feature_key)) continue;
    const imp = byTip.get(tip.id);
    if (imp && imp.last_shown_at) {
      const last = new Date(imp.last_shown_at).getTime();
      const waitMs = tip.frequency_hours * 3600 * 1000;
      if (Number.isFinite(last) && now - last < waitMs) continue;
    }
    eligible.push(tip);
  }

  // Global soft cooldown: don't show any tip if one was shown in the last 6 hours.
  let latestAny = 0;
  for (const row of impressions) {
    const t = new Date(row.last_shown_at).getTime();
    if (t > latestAny) latestAny = t;
  }
  if (latestAny && now - latestAny < 6 * 3600 * 1000) {
    return { tip: null, reason: 'global_cooldown' };
  }

  const picked = pickWeighted(eligible);
  if (!picked) return { tip: null, reason: 'none_eligible' };

  await recordImpression(portalUserId, picked.id);
  return {
    tip: {
      id: picked.id,
      title: picked.title,
      body: picked.body,
      feature_key: picked.feature_key,
      cta_label: picked.cta_label || 'Upgrade',
    },
    reason: 'ok',
  };
}

module.exports = {
  FEATURE_OPTIONS,
  ensureTables,
  listTips,
  getTip,
  createTip,
  updateTip,
  deleteTip,
  nextTipForClient,
  planHasFeature,
  publicTip,
};
