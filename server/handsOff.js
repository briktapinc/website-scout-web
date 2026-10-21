'use strict';

/**
 * Hands-off orchestrator: discover → score → design → Muse build → publish →
 * outreach → follow-up → activity + digest. Honors automation_paused every stage.
 */

const jobs = require('./jobs');
const museAgent = require('./museAgent');
const { sendPlatformMail } = require('./mailer');
const platform = require('./platform');

const running = new Set();

function log(workspaceId, message) {
  const domain = require('./domain');
  try {
    domain.withDb(workspaceId, (db) => {
      db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
        'hands_off',
        String(message || '').slice(0, 2000)
      );
    });
  } catch (e) {
    console.warn('[handsOff] activity:', e.message);
  }
}

function readCfg(db, domain) {
  const g = (k, d) => domain.getSetting(db, k, d);
  return {
    enabled: g('hands_off.enabled', '0') === '1',
    minScore: Math.max(0, Math.min(100, parseInt(g('hands_off.min_score', '50'), 10) || 50)),
    maxSites: Math.max(0, Math.min(1000, parseInt(g('hands_off.max_sites_per_day', '5'), 10) || 5)),
    reportEmail: String(g('hands_off.report_email', '') || '').trim(),
    followupDays: Math.max(1, Math.min(90, parseInt(g('hands_off.followup_days', '3'), 10) || 3)),
    templateId: String(g('hands_off.template_id', '') || '').trim(),
    channel: String(g('hands_off.channel', 'both') || 'both').toLowerCase() || 'both',
    lastRunAt: g('hands_off.last_run_at', ''),
    lastDigestAt: g('hands_off.last_digest_at', ''),
    lastResult: g('hands_off.last_result', ''),
    paused: g('automation_paused', '0') === '1',
  };
}

async function syncJobs(workspaceId, enabled) {
  const list = await jobs.listJobs(workspaceId);
  const byType = (t) => list.filter((j) => j.type === t);
  if (enabled) {
    if (!byType('hands_off').length) {
      await jobs.createJob(workspaceId, {
        name: 'Hands-off tick',
        type: 'hands_off',
        interval_minutes: 30,
        enabled: true,
        payload: {},
      });
    } else {
      for (const j of byType('hands_off')) {
        if (!j.enabled) await jobs.updateJob(workspaceId, j.id, { enabled: true });
      }
    }
    if (!byType('hands_off_digest').length) {
      await jobs.createJob(workspaceId, {
        name: 'Hands-off digest',
        type: 'hands_off_digest',
        cron_expr: 'daily:09:00',
        enabled: true,
        payload: {},
      });
    } else {
      for (const j of byType('hands_off_digest')) {
        if (!j.enabled) await jobs.updateJob(workspaceId, j.id, { enabled: true });
      }
    }
  } else {
    for (const j of list.filter((x) => x.type === 'hands_off' || x.type === 'hands_off_digest')) {
      if (j.enabled) await jobs.updateJob(workspaceId, j.id, { enabled: false });
    }
  }
}

async function getStatus(workspaceId) {
  const domain = require('./domain');
  const cfg = domain.withDb(workspaceId, (db) => readCfg(db, domain));
  const museCfg = await domain.withDb(workspaceId, (db) => museAgent.resolveMuseConfig(db));
  const jobList = await jobs.listJobs(workspaceId).catch(() => []);
  return {
    enabled: cfg.enabled,
    automationPaused: cfg.paused,
    minScore: cfg.minScore,
    maxSitesPerDay: cfg.maxSites,
    followupDays: cfg.followupDays,
    channel: cfg.channel,
    templateId: cfg.templateId || null,
    reportEmail: cfg.reportEmail || null,
    lastRunAt: cfg.lastRunAt || null,
    lastDigestAt: cfg.lastDigestAt || null,
    lastResult: cfg.lastResult ? (() => { try { return JSON.parse(cfg.lastResult); } catch { return cfg.lastResult; } })() : null,
    museConfigured: museAgent.museConfigured(museCfg),
    museModel: museCfg.model,
    jobs: jobList.filter((j) => j.type === 'hands_off' || j.type === 'hands_off_digest').map((j) => ({
      id: j.id, name: j.name, type: j.type, enabled: !!j.enabled,
      last_run_at: j.last_run_at, last_status: j.last_status, next_run_at: j.next_run_at,
    })),
    running: running.has(workspaceId),
  };
}

function sitesCreatedToday(db) {
  try {
    return db.prepare(
      "SELECT COUNT(*) AS c FROM websites WHERE date(created_at) = date('now', 'localtime')"
    ).get().c;
  } catch {
    try {
      return db.prepare(
        "SELECT COUNT(*) AS c FROM design_jobs WHERE status = 'delivered' AND date(updated_at) = date('now', 'localtime')"
      ).get().c;
    } catch {
      return 0;
    }
  }
}

function pickTemplateId(db, preferred) {
  const outreach = require('../src/outreach');
  outreach.ensureTables(db);
  const tid = parseInt(preferred, 10);
  if (Number.isInteger(tid) && tid > 0) {
    const row = db.prepare('SELECT id FROM email_templates WHERE id = ?').get(tid);
    if (row) return tid;
  }
  const list = outreach.listTemplates(db) || [];
  const dual = list.find((t) => (t.subject || t.body) && (t.sms_body || t.smsBody));
  if (dual) return Number(dual.id);
  const any = list.find((t) => t.subject || t.body || t.sms_body);
  return any ? Number(any.id) : null;
}

function candidateLeads(db, minScore, limit) {
  return db.prepare(
    `SELECT l.* FROM leads l
     WHERE COALESCE(l.score, 0) >= ?
       AND COALESCE(l.status, '') NOT IN ('won', 'lost', 'unsubscribed', 'do_not_contact', 'archived')
       AND NOT EXISTS (SELECT 1 FROM websites w WHERE w.lead_id = l.id)
       AND NOT EXISTS (
         SELECT 1 FROM design_jobs d
         WHERE d.lead_id = l.id AND d.status != 'delivered'
       )
     ORDER BY COALESCE(l.score, 0) DESC, l.id ASC
     LIMIT ?`
  ).all(minScore, limit);
}

function leadsNeedingScore(db, limit) {
  return db.prepare(
    `SELECT id FROM leads
     WHERE (score IS NULL OR score = 0)
       AND COALESCE(status, '') IN ('new', 'researching', 'qualified', '')
     ORDER BY id DESC LIMIT ?`
  ).all(limit);
}

async function scoreNewLeads(workspaceId, domain, stats) {
  const ids = domain.withDb(workspaceId, (db) => leadsNeedingScore(db, 25).map((r) => r.id));
  for (const id of ids) {
    if (domain.withDb(workspaceId, (db) => domain.getSetting(db, 'automation_paused', '0')) === '1') {
      stats.skipped = 'automation_paused';
      return;
    }
    try {
      const res = domain.leadsScore(workspaceId, id);
      stats.scored++;
      log(workspaceId, `Scored lead #${id}: ${res && res.score != null ? res.score : '?'}`);
    } catch (e) {
      stats.errors.push(`score #${id}: ${e.message}`);
    }
  }
}

async function createDesignJobs(workspaceId, domain, cfg, stats) {
  const createdToday = domain.withDb(workspaceId, (db) => sitesCreatedToday(db));
  const slots = Math.max(0, cfg.maxSites - createdToday);
  if (slots <= 0) {
    stats.capReached = true;
    return [];
  }
  const leads = domain.withDb(workspaceId, (db) => candidateLeads(db, cfg.minScore, slots));
  const created = [];
  for (const lead of leads) {
    if (domain.withDb(workspaceId, (d) => domain.getSetting(d, 'automation_paused', '0')) === '1') break;
    try {
      const title = `Website for ${lead.business_name || ('Lead #' + lead.id)}`;
      const instructions = [
        'TOOLS ONLY. Follow design.defaultInstructions (system prompt). Build and design.deliver a unique modular site for this lead, then publish.',
        `Business: ${lead.business_name || ('Lead #' + lead.id)}`,
        lead.category ? `Category: ${lead.category}` : '',
        lead.city ? `Location: ${[lead.city, lead.state].filter(Boolean).join(', ')}` : '',
        lead.website ? `Existing website: ${lead.website}` : 'No website on file.',
        lead.email ? `Email: ${lead.email}` : '',
        lead.phone ? `Phone: ${lead.phone}` : '',
        lead.score != null ? `Score: ${lead.score}` : '',
      ].filter(Boolean).join('\n');
      const job = domain.designCreate(workspaceId, {
        type: 'website',
        title,
        instructions,
        leadId: lead.id,
      });
      stats.designJobs++;
      created.push(job);
      log(workspaceId, `Design job #${job.id} created for lead #${lead.id} (score ${lead.score})`);
      try { domain.leadsQualify(workspaceId, lead.id); } catch { /* optional */ }
    } catch (e) {
      stats.errors.push(`design lead #${lead.id}: ${e.message}`);
    }
  }
  return created;
}

async function buildWithMuse(workspaceId, domain, stats) {
  const job = domain.designNext(workspaceId);
  if (!job) {
    stats.muse = { skipped: 'no_waiting_job' };
    return null;
  }
  log(workspaceId, `Muse claimed design job #${job.id}`);
  const result = await domain.withDb(workspaceId, async (db) => {
    return museAgent.runJobLoop(workspaceId, job, { db });
  });
  stats.muse = result;
  if (result.delivered) {
    stats.delivered++;
    log(workspaceId, `Muse delivered job #${job.id} (${result.steps} steps, $${Number(result.costUsd || 0).toFixed(4)})`);
    // Publish / preview
    try {
      const fresh = domain.designGet(workspaceId, job.id);
      const siteId = fresh && (fresh.website_id || (fresh.website && fresh.website.id));
      if (siteId) {
        const preview = await domain.sitesPreview(workspaceId, siteId, { force: true });
        stats.published++;
        log(workspaceId, `Published site #${siteId}: ${(preview && (preview.url || preview.previewUrl)) || 'ok'}`);
        try {
          await domain.cfPublish(workspaceId, siteId);
        } catch (e) {
          stats.errors.push(`cfPublish #${siteId}: ${e.message}`);
        }
        return { job: fresh, siteId, preview };
      }
    } catch (e) {
      stats.errors.push(`publish job #${job.id}: ${e.message}`);
    }
  } else {
    log(workspaceId, `Muse did not deliver job #${job.id}: ${result.error || 'unknown'}`);
  }
  return { job, result };
}

async function outreachForLead(workspaceId, domain, cfg, leadId, stats) {
  if (!leadId) return;
  return domain.withDb(workspaceId, async (db) => {
    if (domain.getSetting(db, 'automation_paused', '0') === '1') {
      stats.skipped = 'automation_paused';
      return;
    }
    const outreach = require('../src/outreach');
    outreach.ensureTables(db);
    const templateId = pickTemplateId(db, cfg.templateId);
    if (!templateId) {
      stats.errors.push('no_outreach_template');
      log(workspaceId, 'Outreach skipped: no dual-channel template');
      return;
    }
    const already = db.prepare(
      `SELECT COUNT(*) AS c FROM campaign_messages WHERE lead_id = ? AND status IN ('queued','sent','sending')`
    ).get(leadId).c;
    if (already > 0) {
      stats.outreachSkipped = (stats.outreachSkipped || 0) + 1;
    } else {
      try {
        const camp = outreach.createCampaign(db, {
          name: `Hands-off #${leadId}`,
          templateId,
          leadIds: [leadId],
          ratePerHour: 60,
          workspaceId,
          channel: cfg.channel || 'both',
        });
        stats.campaigns = (stats.campaigns || 0) + 1;
        stats.queued = (stats.queued || 0) + (camp.queued || 0);
        log(workspaceId, `Outreach campaign #${camp.id} for lead #${leadId}: ${camp.queued} queued`);
      } catch (e) {
        stats.errors.push(`campaign lead #${leadId}: ${e.message}`);
      }
    }

    // Follow-up if no positive intent and none scheduled in the future
    const intent = outreach.getIntent(db, leadId);
    const hot = intent && (String(intent.label).toLowerCase() === 'hot' || Number(intent.score) >= 40);
    if (!hot) {
      const future = db.prepare(
        `SELECT COUNT(*) AS c FROM campaign_messages
         WHERE lead_id = ? AND status = 'queued'
           AND scheduled_at IS NOT NULL
           AND scheduled_at > datetime('now', 'localtime', '+1 day')`
      ).get(leadId).c;
      if (!future) {
        try {
          const camp = outreach.createCampaign(db, {
            name: `Hands-off follow-up #${leadId}`,
            templateId,
            leadIds: [leadId],
            ratePerHour: 60,
            workspaceId,
            channel: cfg.channel || 'both',
          });
          const days = cfg.followupDays;
          const mod = `+${days} days`;
          db.prepare(
            `UPDATE campaign_messages
             SET scheduled_at = datetime('now', 'localtime', ?)
             WHERE campaign_id = ? AND status = 'queued'`
          ).run(mod, camp.id);
          stats.followups = (stats.followups || 0) + 1;
          log(workspaceId, `Follow-up for lead #${leadId} in ${days} day(s) (campaign #${camp.id})`);
        } catch (e) {
          stats.errors.push(`followup lead #${leadId}: ${e.message}`);
        }
      }
    }

    try {
      const q = await outreach.processQueue(db);
      stats.processQueue = q;
    } catch (e) {
      stats.errors.push(`processQueue: ${e.message}`);
    }
  });
}

async function resolveReportEmail(workspaceId, cfg) {
  if (cfg.reportEmail) return cfg.reportEmail;
  try {
    const support = String(await platform.getPlatformSetting('support.email', '') || '').trim();
    if (support) return support;
  } catch { /* */ }
  const domain = require('./domain');
  return domain.withDb(workspaceId, (db) => {
    const from = domain.getSetting(db, 'smtp.from_email', '');
    return String(from || '').trim();
  });
}

async function sendDigest(workspaceId, { force = false } = {}) {
  const domain = require('./domain');
  const cfg = domain.withDb(workspaceId, (db) => readCfg(db, domain));
  if (cfg.paused) return { skipped: true, reason: 'automation_paused' };
  if (!cfg.enabled && !force) return { skipped: true, reason: 'hands_off_disabled' };

  const since = cfg.lastDigestAt || domain.withDb(workspaceId, (db) =>
    domain.getSetting(db, 'hands_off.last_run_at', '')
  ) || '';
  const rows = domain.withDb(workspaceId, (db) => {
    if (since) {
      return db.prepare(
        `SELECT id, area, message, at FROM activity_log
         WHERE area = 'hands_off' AND at > ?
         ORDER BY id ASC LIMIT 200`
      ).all(since);
    }
    return db.prepare(
      `SELECT id, area, message, at FROM activity_log
       WHERE area = 'hands_off'
       ORDER BY id DESC LIMIT 80`
    ).all().reverse();
  });

  const to = await resolveReportEmail(workspaceId, cfg);
  if (!to) {
    log(workspaceId, 'Digest skipped: no report email');
    return { skipped: true, reason: 'no_report_email', activityCount: rows.length };
  }

  const lines = rows.length
    ? rows.map((r) => `• ${r.at}: ${r.message}`)
    : ['• No Hands-off activity since the last digest.'];
  const subject = `[BitPype] Hands-off digest (${rows.length} event${rows.length === 1 ? '' : 's'})`;
  try {
    await sendPlatformMail({
      to,
      subject,
      title: 'Hands-off digest',
      paragraphs: [
        `Workspace activity summary.`,
        ...lines.slice(0, 60),
        rows.length > 60 ? `…and ${rows.length - 60} more.` : '',
      ].filter(Boolean),
      text: lines.join('\n'),
    });
  } catch (e) {
    log(workspaceId, `Digest email failed: ${e.message}`);
    return { ok: false, error: e.message, activityCount: rows.length };
  }

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  domain.withDb(workspaceId, (db) => {
    domain.setSetting(db, 'hands_off.last_digest_at', now);
  });
  log(workspaceId, `Digest emailed to ${to} (${rows.length} events)`);
  return { ok: true, to, activityCount: rows.length, at: now };
}

/**
 * One Hands-off tick for a workspace.
 */
async function runTick(workspaceId, { force = false } = {}) {
  const domain = require('./domain');
  if (running.has(workspaceId)) {
    return { skipped: true, reason: 'busy' };
  }
  running.add(workspaceId);
  const stats = {
    discovered: 0,
    scored: 0,
    designJobs: 0,
    delivered: 0,
    published: 0,
    campaigns: 0,
    queued: 0,
    followups: 0,
    errors: [],
  };

  try {
    const cfg = domain.withDb(workspaceId, (db) => readCfg(db, domain));
    if (cfg.paused) {
      log(workspaceId, 'Tick skipped: automation_paused');
      return { skipped: true, reason: 'automation_paused' };
    }
    if (!cfg.enabled && !force) {
      return { skipped: true, reason: 'hands_off_disabled' };
    }

    const museCfg = await domain.withDb(workspaceId, (db) => museAgent.resolveMuseConfig(db));
    if (!museAgent.museConfigured(museCfg)) {
      log(workspaceId, 'Tick skipped: muse.model_api_key not configured');
      return { skipped: true, reason: 'muse_not_configured' };
    }

    await syncJobs(workspaceId, true);

    // 1) Discover (same path as Electron schedule / discovery.runNow)
    try {
      const disc = await domain.discoveryRunNow(workspaceId);
      if (disc && disc.skipped) {
        stats.discoverSkipped = disc.reason;
      } else {
        const result = (disc && disc.result) || disc || {};
        stats.discovered = Number(result.created) || 0;
        log(workspaceId, `Discovery: created ${stats.discovered}, skipped ${result.skipped || 0}`);
      }
    } catch (e) {
      stats.errors.push(`discover: ${e.message}`);
      log(workspaceId, `Discovery error: ${e.message}`);
    }

    if (domain.withDb(workspaceId, (db) => domain.getSetting(db, 'automation_paused', '0')) === '1') {
      return { skipped: true, reason: 'automation_paused', ...stats };
    }

    // 2) Score
    await scoreNewLeads(workspaceId, domain, stats);

    // 3) Design jobs for high-scoring leads under daily cap
    const createdJobs = await createDesignJobs(workspaceId, domain, cfg, stats);

    // 4) Muse build (one job per tick to bound cost/time)
    const build = await buildWithMuse(workspaceId, domain, stats);
    const leadId = build && build.job && (build.job.lead_id || build.job.leadId);

    // 5–6) Outreach + follow-up + process queue
    if (leadId && stats.delivered) {
      await outreachForLead(workspaceId, domain, cfg, leadId, stats);
    } else if (createdJobs.length && !stats.delivered) {
      // Still process any due queue
      try {
        stats.processQueue = await domain.outreachProcessQueue(workspaceId);
      } catch (e) {
        stats.errors.push(`processQueue: ${e.message}`);
      }
    } else {
      try {
        stats.processQueue = await domain.outreachProcessQueue(workspaceId);
      } catch (e) {
        stats.errors.push(`processQueue: ${e.message}`);
      }
    }

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const summary = {
      at: now,
      discovered: stats.discovered,
      scored: stats.scored,
      designJobs: stats.designJobs,
      delivered: stats.delivered,
      published: stats.published,
      campaigns: stats.campaigns || 0,
      queued: stats.queued || 0,
      followups: stats.followups || 0,
      muse: stats.muse || null,
      errors: stats.errors.slice(0, 20),
    };
    domain.withDb(workspaceId, (db) => {
      domain.setSetting(db, 'hands_off.last_run_at', now);
      domain.setSetting(db, 'hands_off.last_result', JSON.stringify(summary));
    });
    log(workspaceId, `Tick done: discovered=${summary.discovered} scored=${summary.scored} jobs=${summary.designJobs} delivered=${summary.delivered} published=${summary.published}`);

    // Optional end-of-batch digest when something meaningful happened
    if (summary.delivered || summary.discovered || summary.campaigns) {
      try {
        summary.digest = await sendDigest(workspaceId, { force: true });
      } catch (e) {
        summary.errors.push(`digest: ${e.message}`);
      }
    }

    return { ok: true, ...summary };
  } finally {
    running.delete(workspaceId);
  }
}

module.exports = {
  runTick,
  sendDigest,
  getStatus,
  syncJobs,
  readCfg,
};
