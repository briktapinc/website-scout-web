'use strict';
/**
 * One-shot design-queue poll for Website Scout.
 * Updates %APPDATA%/website-scout/design-agent-loop-state.json last_check.
 * Does not claim/deliver — reports claimable jobs for the agent loop to act on.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const design = require('../src/designJobs');

const appData = path.join(process.env.APPDATA || '', 'website-scout');
const dbPath = path.join(appData, 'websitescout.db');
const statePath = path.join(appData, 'design-agent-loop-state.json');
const triggerPath = path.join(appData, 'design-agent-trigger.json');

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function factCount(brief) {
  let b = brief;
  if (typeof b === 'string') {
    try {
      b = JSON.parse(b || '{}');
    } catch {
      b = {};
    }
  }
  b = b || {};
  const facts = b.verified_facts || b.facts || [];
  if (Array.isArray(facts)) return facts.length;
  if (facts && typeof facts === 'object') return Object.keys(facts).length;
  return 0;
}

const db = new Database(dbPath);
design.ensureTables(db);

const summary = design.pendingAgentSummary(db, { previewLimit: 20 });
const inProgress = db
  .prepare(
    `SELECT id, status, request_kind, title, lead_id, updated_at
     FROM design_jobs WHERE status = 'in_progress' ORDER BY id`
  )
  .all();

let state = readJson(statePath, {});
const skipIds = new Set((state.skip_job_ids || []).map(Number));
const trigger = readJson(triggerPath, null);

const waiting = [];
const skipped = [];
const claimable = [];

for (const j of summary.preview || []) {
  if (j.status !== 'waiting_on_agent') continue;
  const facts = factCount(j.brief);
  const row = {
    id: j.id,
    title: j.title,
    request_kind: j.request_kind || null,
    lead_id: j.lead_id ?? null,
    fact_count: facts,
  };
  waiting.push(row.id);

  if (skipIds.has(j.id)) {
    skipped.push({ id: j.id, reason: state.skip_reasons?.[j.id] || 'skip_job_ids' });
    continue;
  }
  if (!j.lead_id || facts === 0) {
    skipped.push({
      id: j.id,
      reason: !j.lead_id && facts === 0 ? 'no_verified_facts_no_lead' : facts === 0 ? 'no_verified_facts' : 'no_lead',
    });
    continue;
  }
  claimable.push(row);
}

const last_check = {
  at: new Date().toISOString(),
  waiting_on_agent: waiting,
  in_progress: inProgress.map((r) => r.id),
  claimable,
  acted: [],
  skipped,
  trigger: trigger
    ? { at: trigger.at, job_id: trigger.job_id, reason: trigger.reason }
    : null,
  note:
    'Poll only. Agent must claim/deliver claimable jobs (redesign vs improvements). Empty no-lead jobs stay skipped until fixed.',
};

state.last_check = last_check;
state.loop_alive = true;
if (!state.sentinel) state.sentinel = 'AGENT_LOOP_TICK_design_queue';
fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

console.log(JSON.stringify({ ok: true, counts: summary.counts, last_check }, null, 2));
db.close();
