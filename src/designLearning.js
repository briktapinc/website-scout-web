'use strict';

/**
 * Design learning loop: observe reviews, screenshots, change requests, and
 * inbound email messages; distill a compact playbook the agent sees on briefs.
 *
 * Settings:
 *   design.learning.enabled   — "1" (default) / "0"
 *   design.learning.playbook  — JSON array of { id, category, lesson, hits, at }
 *   design.learning.last_learned_at — ISO timestamp of last observe/distill
 *   design.learning.max_playbook — max distilled lessons (default 24)
 */

const ai = require('./ai');

const PLAYBOOK_KEY = 'design.learning.playbook';
const ENABLED_KEY = 'design.learning.enabled';
const LAST_AT_KEY = 'design.learning.last_learned_at';
const MAX_PLAYBOOK_KEY = 'design.learning.max_playbook';
const MAX_EVENTS_KEEP = 400;
const MAX_BRIEF_LESSONS = 12;

const CATEGORY_HINTS = [
  { re: /\b(mobile|viewport|responsive|tap target|phone size)\b/i, cat: 'mobile' },
  { re: /\b(cta|call now|call-to-action|button|conversion)\b/i, cat: 'cta' },
  { re: /\b(image|photo|imagery|gallery|pexels|placeholder|hero)\b/i, cat: 'imagery' },
  { re: /\b(nav|ia|sitemap|page|section|layout|hierarchy)\b/i, cat: 'ia' },
  { re: /\b(copy|wording|headline|text|typo|readable)\b/i, cat: 'copy' },
  { re: /\b(email|client said|customer asked|from:)\b/i, cat: 'email' },
];

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function getSetting(db, key, def = '') {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (row && row.value != null && String(row.value) !== '') return String(row.value);
  } catch { /* ignore */ }
  return def;
}

function setSetting(db, key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

function learningEnabled(db) {
  return getSetting(db, ENABLED_KEY, '1') !== '0';
}

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS design_learning_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      design_job_id INTEGER,
      lead_id INTEGER,
      request_kind TEXT,
      category TEXT,
      summary TEXT,
      payload TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_design_learning_job
      ON design_learning_events(design_job_id);
    CREATE INDEX IF NOT EXISTS idx_design_learning_type
      ON design_learning_events(event_type);
  `);
  try {
    const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    ins.run(ENABLED_KEY, '1');
    ins.run(PLAYBOOK_KEY, '[]');
    ins.run(LAST_AT_KEY, '');
    ins.run(MAX_PLAYBOOK_KEY, '24');
  } catch { /* settings may be mid-migrate */ }
}

function guessCategory(text) {
  const s = String(text || '');
  for (const h of CATEGORY_HINTS) {
    if (h.re.test(s)) return h.cat;
  }
  return 'general';
}

function loadPlaybook(db) {
  try {
    const raw = getSetting(db, PLAYBOOK_KEY, '[]');
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function maxPlaybook(db) {
  const n = Number(getSetting(db, MAX_PLAYBOOK_KEY, '24'));
  if (!Number.isFinite(n)) return 24;
  return Math.min(60, Math.max(4, Math.floor(n)));
}

function savePlaybook(db, items) {
  const list = (items || []).slice(0, maxPlaybook(db));
  setSetting(db, PLAYBOOK_KEY, JSON.stringify(list));
  setSetting(db, LAST_AT_KEY, new Date().toISOString());
}

function pruneEvents(db) {
  try {
    const n = db.prepare('SELECT COUNT(*) AS c FROM design_learning_events').get().c;
    if (n <= MAX_EVENTS_KEEP) return;
    const cut = n - MAX_EVENTS_KEEP;
    db.prepare(
      `DELETE FROM design_learning_events WHERE id IN (
         SELECT id FROM design_learning_events ORDER BY id ASC LIMIT ?
       )`
    ).run(cut);
  } catch { /* ignore */ }
}

/**
 * Record a learning signal. Never throws to callers.
 */
function observe(db, event = {}) {
  try {
    if (!db || !learningEnabled(db)) return null;
    ensureTables(db);
    const eventType = String(event.event_type || event.type || '').trim().slice(0, 60);
    if (!eventType) return null;
    const summary = String(event.summary || '').trim().slice(0, 2000);
    if (!summary) return null;
    const category = String(event.category || guessCategory(summary)).slice(0, 40);
    const requestKind = event.request_kind != null
      ? String(event.request_kind).slice(0, 40)
      : null;
    const payload = event.payload != null
      ? JSON.stringify(event.payload).slice(0, 12000)
      : null;
    const info = db.prepare(
      `INSERT INTO design_learning_events
         (event_type, design_job_id, lead_id, request_kind, category, summary, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      eventType,
      event.design_job_id != null ? Number(event.design_job_id) : null,
      event.lead_id != null ? Number(event.lead_id) : null,
      requestKind,
      category,
      summary,
      payload
    );
    setSetting(db, LAST_AT_KEY, new Date().toISOString());
    pruneEvents(db);
    // Heuristic distill immediately (cheap); skip low-signal deliver ticks.
    if (eventType !== 'deliver') {
      distillHeuristic(db, { category, summary, event_type: eventType });
    }
    return { id: Number(info.lastInsertRowid) };
  } catch {
    return null;
  }
}

function normalizeLesson(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);
}

function distillHeuristic(db, { category, summary, event_type }) {
  const lesson = normalizeLesson(summary);
  if (lesson.length < 24) return;
  // Prefer durable "do/don't" phrasing from email + review signals.
  let bullet = lesson;
  if (event_type === 'email_message' || event_type === 'email_submit') {
    bullet = `Client email feedback: ${lesson}`;
  } else if (event_type === 'review') {
    bullet = `From review: ${lesson}`;
  } else if (event_type === 'change_request') {
    bullet = `Requested ${category === 'email' ? 'via email' : 'edit'}: ${lesson}`;
  }
  bullet = normalizeLesson(bullet);
  const playbook = loadPlaybook(db);
  const key = bullet.toLowerCase().slice(0, 120);
  const existing = playbook.find((p) => String(p.lesson || '').toLowerCase().slice(0, 120) === key);
  if (existing) {
    existing.hits = Number(existing.hits || 1) + 1;
    existing.at = new Date().toISOString();
    if (category && category !== 'general') existing.category = category;
  } else {
    playbook.unshift({
      id: `L${Date.now().toString(36)}${Math.floor(Math.random() * 1e3)}`,
      category: category || 'general',
      lesson: bullet,
      hits: 1,
      at: new Date().toISOString(),
      source: event_type || 'observe',
    });
  }
  playbook.sort((a, b) => (Number(b.hits) || 0) - (Number(a.hits) || 0));
  savePlaybook(db, playbook);
}

/**
 * Optional AI pass: fold recent events into playbook bullets.
 */
async function distillWithAi(db, { limit = 30 } = {}) {
  if (!learningEnabled(db)) return { ok: false, reason: 'disabled' };
  ensureTables(db);
  ai.setDb(db);
  if (!ai.aiConfigured()) return { ok: false, reason: 'ai_not_configured' };
  const rows = db.prepare(
    `SELECT event_type, category, summary, request_kind, created_at
     FROM design_learning_events ORDER BY id DESC LIMIT ?`
  ).all(Math.min(80, Math.max(5, limit)));
  if (!rows.length) return { ok: false, reason: 'no_events' };
  const playbook = loadPlaybook(db);
  try {
    const { text } = await ai.chat({
      task: 'qa',
      messages: [
        {
          role: 'system',
          content: `You distill Website Scout design learnings into durable playbook bullets.
Return ONLY JSON: { "lessons": [ { "category": "mobile|cta|imagery|ia|copy|email|general", "lesson": "imperative tip under 160 chars" } ] }
Focus on reusable craft rules (CTA, mobile, imagery, IA, copy, client email feedback). Never invent business facts, phones, prices, or testimonials.`,
        },
        {
          role: 'user',
          content: [
            `Existing playbook (for merge, not copy verbatim):\n${JSON.stringify(playbook.slice(0, 20))}`,
            `Recent events:\n${JSON.stringify(rows)}`,
          ].join('\n\n'),
        },
      ],
      maxTokens: 900,
      note: 'design learning distill',
    });
    let parsed = null;
    try {
      const s = String(text || '').trim().replace(/^```(?:json)?\s*([\s\S]*?)```$/i, '$1').trim();
      parsed = JSON.parse(s);
    } catch { /* ignore */ }
    const incoming = parsed && Array.isArray(parsed.lessons) ? parsed.lessons : [];
    for (const item of incoming.slice(0, 16)) {
      const lesson = normalizeLesson(item && item.lesson);
      if (lesson.length < 20) continue;
      const category = String((item && item.category) || guessCategory(lesson)).slice(0, 40);
      distillHeuristic(db, { category, summary: lesson, event_type: 'ai_distill' });
    }
    return { ok: true, added: incoming.length, playbook: loadPlaybook(db) };
  } catch (e) {
    return { ok: false, reason: e.code || e.message || 'ai_error' };
  }
}

function lessonsForBrief(db, { limit = MAX_BRIEF_LESSONS } = {}) {
  if (!learningEnabled(db)) return [];
  return loadPlaybook(db)
    .slice(0, limit)
    .map((p) => ({
      category: p.category || 'general',
      lesson: p.lesson,
      hits: p.hits || 1,
    }));
}

/** Attach learned_lessons onto a brief object (mutates + returns). */
function attachToBrief(db, brief, _opts = {}) {
  if (!brief || typeof brief !== 'object') return brief;
  try {
    const learned = lessonsForBrief(db);
    brief.learned_lessons = learned;
    if (learned.length) {
      brief.learned_playbook_text = [
        '=== LEARNED PLAYBOOK (from prior reviews, edits, and client emails) ===',
        'Apply these craft lessons. Do not invent business facts.',
        ...learned.map((l, i) => `${i + 1}. [${l.category}] ${l.lesson}`),
      ].join('\n');
    }
  } catch { /* ignore */ }
  return brief;
}

function attachLessonsToBrief(db, brief, opts) {
  return attachToBrief(db, brief, opts);
}

function refreshJobBriefLessons(db, jobId) {
  try {
    const row = db.prepare('SELECT id, brief FROM design_jobs WHERE id = ?').get(Number(jobId));
    if (!row) return null;
    let brief = {};
    try { brief = row.brief ? JSON.parse(row.brief) : {}; } catch { brief = {}; }
    attachLessonsToBrief(db, brief, {});
    db.prepare(
      `UPDATE design_jobs SET brief = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(JSON.stringify(brief), row.id);
    return brief.learned_lessons || [];
  } catch {
    return null;
  }
}

function resolveJob(db, jobOrId) {
  if (jobOrId && typeof jobOrId === 'object') return jobOrId;
  const id = Number(jobOrId);
  if (!Number.isFinite(id)) return { id: null, lead_id: null };
  try {
    return db.prepare('SELECT id, lead_id, title, type, request_kind FROM design_jobs WHERE id = ?').get(id)
      || { id, lead_id: null };
  } catch {
    return { id, lead_id: null };
  }
}

function observeReview(db, jobOrId, review) {
  const job = resolveJob(db, jobOrId);
  if (!job || !review) return;
  const issues = (review.issues || []).slice(0, 12).join('; ');
  const summary = [
    review.pass ? 'Review passed' : 'Review needs work',
    review.summary || '',
    issues ? `Issues: ${issues}` : '',
    review.vision_used ? 'Vision screenshots used.' : '',
  ].filter(Boolean).join(' — ').slice(0, 1800);
  const shotPaths = (review.screenshots || [])
    .filter((s) => s && s.path)
    .slice(0, 12)
    .map((s) => ({
      page: s.page || null,
      viewport: s.viewport || null,
      path: s.path,
    }));
  observe(db, {
    event_type: 'review',
    design_job_id: job.id,
    lead_id: job.lead_id,
    category: guessCategory(summary),
    summary,
    payload: {
      pass: !!review.pass,
      vision_used: !!review.vision_used,
      ai_used: !!review.ai_used,
      shot_count: (review.screenshots || []).length,
      screenshot_paths: shotPaths,
      screenshot_dir: review.screenshot_dir || null,
      redesign_instructions: String(review.redesign_instructions || '').slice(0, 1500),
      improvement_instructions: String(review.improvement_instructions || '').slice(0, 1500),
    },
  });
  if (review.redesign_instructions) {
    observe(db, {
      event_type: 'suggested_redesign',
      design_job_id: job.id,
      lead_id: job.lead_id,
      request_kind: 'redesign',
      category: 'ia',
      summary: String(review.redesign_instructions).slice(0, 1800),
    });
  }
  if (review.improvement_instructions) {
    observe(db, {
      event_type: 'suggested_improvements',
      design_job_id: job.id,
      lead_id: job.lead_id,
      request_kind: 'improvements',
      category: guessCategory(review.improvement_instructions),
      summary: String(review.improvement_instructions).slice(0, 1800),
    });
  }
}

/** Compatible: observeChangeRequest(db, jobId, kind, instructions, review?) */
function observeChangeRequest(db, jobOrId, kindOrOpts, instructions, _review) {
  let job;
  let kind;
  let text;
  if (kindOrOpts && typeof kindOrOpts === 'object' && !Array.isArray(kindOrOpts)) {
    job = resolveJob(db, jobOrId);
    kind = kindOrOpts.kind;
    text = kindOrOpts.instructions;
  } else {
    job = resolveJob(db, jobOrId);
    kind = kindOrOpts;
    text = instructions;
  }
  if (!job) return;
  observe(db, {
    event_type: 'change_request',
    design_job_id: job.id,
    lead_id: job.lead_id,
    request_kind: kind || null,
    category: guessCategory(text),
    summary: String(text || '').slice(0, 1800),
    payload: { kind },
  });
}

/**
 * Learn from inbound email messages (paste / drop / hook) — core signal.
 */
function observeEmailMessage(db, request) {
  if (!request) return;
  const body = String(request.body || request.body_excerpt || '').trim();
  const subject = String(request.subject || '').trim();
  if (!body && !subject) return;
  const summary = [
    subject ? `Subject: ${subject}` : '',
    request.from_email ? `From: ${request.from_email}` : '',
    body,
  ].filter(Boolean).join('\n').slice(0, 2000);
  observe(db, {
    event_type: 'email_message',
    design_job_id: request.design_job_id,
    lead_id: request.lead_id,
    request_kind: request.request_kind || null,
    category: 'email',
    summary,
    payload: {
      email_request_id: request.id,
      source: request.source || null,
      from_email: request.from_email || null,
      subject: subject || null,
      status: request.status || 'pending',
    },
  });
}

/**
 * Compatible signatures:
 *   observeEmailSubmit(db, jobId, kind, request)
 *   observeEmailSubmit(db, request, jobId, kind)
 */
function observeEmailSubmit(db, a, b, c) {
  let jobId;
  let kind;
  let request;
  if (a && typeof a === 'object' && (a.body != null || a.body_excerpt != null || a.subject != null)) {
    request = a;
    jobId = b;
    kind = c;
  } else {
    jobId = a;
    kind = b;
    request = c;
  }
  if (!request) return;
  observe(db, {
    event_type: 'email_submit',
    design_job_id: jobId != null ? Number(jobId) : request.design_job_id,
    lead_id: request.lead_id,
    request_kind: kind || request.request_kind || null,
    category: 'email',
    summary: `Submitted email ${kind || 'change'} request: ${String(request.subject || '').trim()} — ${String(request.body || request.body_excerpt || '').slice(0, 1200)}`,
    payload: {
      email_request_id: request.id,
      from_email: request.from_email || null,
      source: request.source || null,
    },
  });
}

/** Compatible: observeDeliver(db, jobId, meta?) or observeDeliver(db, job) */
function observeDeliver(db, jobOrId, meta = {}) {
  const job = resolveJob(db, jobOrId);
  if (!job || job.id == null) return;
  const requestKind = meta.requestKind || meta.request_kind || job.request_kind || null;
  observe(db, {
    event_type: 'deliver',
    design_job_id: job.id,
    lead_id: job.lead_id,
    request_kind: requestKind,
    category: 'general',
    summary: `Delivered ${job.type || 'job'} #${job.id}${requestKind ? ` after ${requestKind}` : ''}: ${job.title || ''}`.slice(0, 500),
    payload: meta && typeof meta === 'object' ? {
      hadPrior: !!meta.hadPrior,
      siteShape: meta.siteShape || null,
      pageCount: meta.pageCount != null ? meta.pageCount : null,
    } : null,
  });
}

function listEvents(db, { limit = 50, eventType, jobId } = {}) {
  ensureTables(db);
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  let sql = 'SELECT * FROM design_learning_events WHERE 1=1';
  const params = [];
  if (eventType) {
    sql += ' AND event_type = ?';
    params.push(String(eventType));
  }
  if (jobId != null) {
    sql += ' AND design_job_id = ?';
    params.push(Number(jobId));
  }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(lim);
  return db.prepare(sql).all(...params).map((r) => ({
    id: r.id,
    event_type: r.event_type,
    design_job_id: r.design_job_id,
    lead_id: r.lead_id,
    request_kind: r.request_kind,
    category: r.category,
    summary: r.summary,
    created_at: r.created_at,
  }));
}

function status(db) {
  ensureTables(db);
  const count = db.prepare('SELECT COUNT(*) AS c FROM design_learning_events').get().c;
  const emailCount = db.prepare(
    "SELECT COUNT(*) AS c FROM design_learning_events WHERE event_type IN ('email_message','email_submit')"
  ).get().c;
  const playbook = loadPlaybook(db);
  return {
    enabled: learningEnabled(db),
    event_count: count,
    email_event_count: emailCount,
    playbook_count: playbook.length,
    playbook,
    last_at: getSetting(db, LAST_AT_KEY, '') || null,
    last_learned_at: getSetting(db, LAST_AT_KEY, '') || null,
    max_playbook: maxPlaybook(db),
  };
}

function getStatus(db) {
  return status(db);
}

function getPlaybook(db) {
  return loadPlaybook(db);
}

function clearPlaybook(db) {
  savePlaybook(db, []);
  return { ok: true, ...status(db) };
}

function clearEvents(db) {
  ensureTables(db);
  db.prepare('DELETE FROM design_learning_events').run();
  return { ok: true, ...status(db) };
}

function clearAll(db) {
  ensureTables(db);
  db.prepare('DELETE FROM design_learning_events').run();
  savePlaybook(db, []);
  return { ok: true, ...status(db) };
}

async function maybeDistill(db, opts = {}) {
  if (!learningEnabled(db) && !opts.force) {
    return { ok: false, reason: 'disabled', ai_used: false, status: status(db) };
  }
  const result = await distillWithAi(db, { limit: opts.limit });
  const st = status(db);
  return {
    ...result,
    ai_used: !!(result && result.ok),
    playbook_count: st.playbook_count,
    status: st,
  };
}

module.exports = {
  ensureTables,
  learningEnabled,
  observe,
  observeReview,
  observeChangeRequest,
  observeEmailMessage,
  observeEmailSubmit,
  observeDeliver,
  attachToBrief,
  attachLessonsToBrief,
  refreshJobBriefLessons,
  lessonsForBrief,
  distillWithAi,
  maybeDistill,
  listEvents,
  loadPlaybook,
  getPlaybook,
  clearPlaybook,
  clearEvents,
  clearAll,
  status,
  getStatus,
};
