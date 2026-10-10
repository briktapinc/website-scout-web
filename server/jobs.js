'use strict';

const { query, withConnection } = require('./db');
const { getSetting, logActivity } = require('./workspace');

const JOB_TYPES = ['discovery', 'outreach_process', 'design_poll_notify', 'imap_poll', 'custom'];

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function computeNextRun(job, from = new Date()) {
  if (job.interval_minutes && Number(job.interval_minutes) > 0) {
    return addMinutes(from, Number(job.interval_minutes));
  }
  // Simple daily HH:MM stored in cron_expr as "daily:HH:MM"
  if (job.cron_expr && String(job.cron_expr).startsWith('daily:')) {
    const time = String(job.cron_expr).slice(6);
    const [hh, mm] = time.split(':').map(Number);
    const next = new Date(from);
    next.setUTCHours(hh || 9, mm || 0, 0, 0);
    if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }
  // default: every 6 hours
  return addMinutes(from, 360);
}

function toMysqlDatetime(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

async function listJobs(workspaceId) {
  return query(
    `SELECT * FROM scheduled_jobs WHERE workspace_id = :workspaceId ORDER BY id DESC`,
    { workspaceId }
  );
}

async function getJob(workspaceId, id) {
  const rows = await query(
    'SELECT * FROM scheduled_jobs WHERE id = :id AND workspace_id = :workspaceId LIMIT 1',
    { id, workspaceId }
  );
  return rows[0] || null;
}

async function createJob(workspaceId, input) {
  const name = String(input.name || '').trim();
  const type = String(input.type || '').trim();
  if (!name) throw Object.assign(new Error('name required'), { code: 'INVALID' });
  if (!JOB_TYPES.includes(type)) throw Object.assign(new Error(`type must be one of ${JOB_TYPES.join(', ')}`), { code: 'INVALID' });

  const interval = input.interval_minutes != null ? Number(input.interval_minutes) : null;
  const cron_expr = input.cron_expr || input.cron || null;
  const payload = JSON.stringify(input.payload || {});
  const enabled = input.enabled === false || input.enabled === 0 ? 0 : 1;
  const next = enabled ? toMysqlDatetime(computeNextRun({ interval_minutes: interval, cron_expr })) : null;

  await query(
    `INSERT INTO scheduled_jobs (
      workspace_id, name, type, cron_expr, interval_minutes, payload, enabled, next_run_at
    ) VALUES (
      :workspaceId, :name, :type, :cron_expr, :interval_minutes, CAST(:payload AS JSON), :enabled, :next_run_at
    )`,
    {
      workspaceId,
      name,
      type,
      cron_expr,
      interval_minutes: interval,
      payload,
      enabled,
      next_run_at: next,
    }
  );
  const job = (await query(
    'SELECT * FROM scheduled_jobs WHERE workspace_id = :workspaceId ORDER BY id DESC LIMIT 1',
    { workspaceId }
  ))[0];
  await logActivity(workspaceId, 'jobs', `Job created #${job.id}: ${name}`);
  return job;
}

async function updateJob(workspaceId, id, patch) {
  const job = await getJob(workspaceId, id);
  if (!job) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });

  const name = patch.name != null ? String(patch.name).trim() : job.name;
  const enabled = patch.enabled != null ? (patch.enabled ? 1 : 0) : job.enabled;
  const interval_minutes = patch.interval_minutes != null ? Number(patch.interval_minutes) : job.interval_minutes;
  const cron_expr = patch.cron_expr != null || patch.cron != null
    ? (patch.cron_expr || patch.cron)
    : job.cron_expr;
  const payload = patch.payload != null ? JSON.stringify(patch.payload) : null;

  let next_run_at = job.next_run_at;
  if (enabled) {
    next_run_at = toMysqlDatetime(computeNextRun({ interval_minutes, cron_expr }));
  } else {
    next_run_at = null;
  }

  await query(
    `UPDATE scheduled_jobs SET
      name = :name,
      enabled = :enabled,
      interval_minutes = :interval_minutes,
      cron_expr = :cron_expr,
      payload = COALESCE(CAST(:payload AS JSON), payload),
      next_run_at = :next_run_at
     WHERE id = :id AND workspace_id = :workspaceId`,
    {
      id,
      workspaceId,
      name,
      enabled,
      interval_minutes,
      cron_expr,
      payload,
      next_run_at,
    }
  );
  return getJob(workspaceId, id);
}

async function deleteJob(workspaceId, id) {
  const result = await query(
    'DELETE FROM scheduled_jobs WHERE id = :id AND workspace_id = :workspaceId',
    { id, workspaceId }
  );
  if (!result.affectedRows) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  return { id };
}

async function runJobLogic(workspaceId, job) {
  const domain = require('./domain');
  const payload = typeof job.payload === 'string' ? JSON.parse(job.payload || '{}') : (job.payload || {});

  if (job.type === 'discovery') {
    return domain.runDiscoveryJobTick(workspaceId, payload);
  }

  if (job.type === 'outreach_process') {
    return domain.runOutreachJobTick(workspaceId);
  }

  if (job.type === 'design_poll_notify') {
    const pending = domain.designPending(workspaceId);
    return { ok: true, ...pending };
  }

  if (job.type === 'imap_poll') {
    return domain.imapPoll(workspaceId, payload || {});
  }

  if (job.type === 'custom') {
    await logActivity(workspaceId, 'jobs', `Custom job ran: ${job.name}`);
    return { ok: true, payload };
  }

  throw new Error(`Unsupported job type: ${job.type}`);
}

async function executeJob(workspaceId, jobId, { force = false } = {}) {
  const job = await getJob(workspaceId, jobId);
  if (!job) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  if (!job.enabled && !force) throw Object.assign(new Error('Job is disabled'), { code: 'DISABLED' });

  await query(
    `INSERT INTO job_runs (workspace_id, job_id, status) VALUES (:workspaceId, :jobId, 'running')`,
    { workspaceId, jobId }
  );
  const run = (await query(
    'SELECT id FROM job_runs WHERE workspace_id = :workspaceId AND job_id = :jobId ORDER BY id DESC LIMIT 1',
    { workspaceId, jobId }
  ))[0];

  try {
    const result = await runJobLogic(workspaceId, job);
    const next = job.enabled ? toMysqlDatetime(computeNextRun(job)) : null;
    await query(
      `UPDATE scheduled_jobs SET
        last_run_at = UTC_TIMESTAMP(),
        last_status = 'ok',
        last_error = NULL,
        last_result = CAST(:result AS JSON),
        next_run_at = :next
       WHERE id = :jobId AND workspace_id = :workspaceId`,
      { jobId, workspaceId, result: JSON.stringify(result), next }
    );
    await query(
      `UPDATE job_runs SET status = 'ok', result = CAST(:result AS JSON), finished_at = UTC_TIMESTAMP()
       WHERE id = :id`,
      { id: run.id, result: JSON.stringify(result) }
    );
    return { jobId, runId: run.id, result };
  } catch (e) {
    const next = job.enabled ? toMysqlDatetime(computeNextRun(job)) : null;
    await query(
      `UPDATE scheduled_jobs SET
        last_run_at = UTC_TIMESTAMP(),
        last_status = 'error',
        last_error = :err,
        next_run_at = :next
       WHERE id = :jobId AND workspace_id = :workspaceId`,
      { jobId, workspaceId, err: String(e.message || e).slice(0, 2000), next }
    );
    await query(
      `UPDATE job_runs SET status = 'error', error = :err, finished_at = UTC_TIMESTAMP() WHERE id = :id`,
      { id: run.id, err: String(e.message || e).slice(0, 2000) }
    );
    throw e;
  }
}

async function tickDueJobs() {
  const due = await query(
    `SELECT id, workspace_id FROM scheduled_jobs
     WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= UTC_TIMESTAMP()
     ORDER BY next_run_at ASC LIMIT 20`
  );
  const outcomes = [];
  for (const row of due) {
    try {
      const result = await executeJob(row.workspace_id, row.id);
      outcomes.push({ ok: true, ...result });
    } catch (e) {
      outcomes.push({ ok: false, jobId: row.id, error: e.message });
    }
  }
  return outcomes;
}

function startScheduler({ intervalMs = 30000 } = {}) {
  let timer = null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await tickDueJobs();
    } catch (e) {
      console.error('[scheduler]', e.message);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  setTimeout(tick, 2000);
  return () => clearInterval(timer);
}

module.exports = {
  JOB_TYPES,
  listJobs,
  getJob,
  createJob,
  updateJob,
  deleteJob,
  executeJob,
  tickDueJobs,
  startScheduler,
  computeNextRun,
};
