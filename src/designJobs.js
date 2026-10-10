'use strict';

// Design jobs: the desktop app assigns work, an MCP agent may ask questions,
// and the agent submits the deliverable. The app stores that payload as sent.
// Website deliveries are rendered from the agent's pages. They are not passed
// through the prompt library or industry templates.

const engine = require('./websiteEngine');
const pexels = require('./pexels');
const {
  DEFAULT_WEBSITE_DESIGN_INSTRUCTIONS,
  defaultWebsiteInstructions,
} = require('./defaultDesignInstructions');

const SUGGESTED_TYPES = ['website', 'logo', 'social', 'flyer', 'brand', 'other'];
const STATUSES = ['draft', 'waiting_on_agent', 'questions_pending', 'in_progress', 'delivered'];
const CLAIM_CLASSES = new Set(['VERIFIED', 'AI_COPY', 'OWNER_PROVIDED', 'UNKNOWN']);
/** Delivery shape for website jobs: single landing vs multi-page IA. */
const SITE_SHAPES = ['landing', 'multipage'];
/** recommended_pages at or above this count default to multipage. */
const MANY_PAGES_THRESHOLD = 3;

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function normalizeSiteShape(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim().toLowerCase().replace(/[_-]/g, '');
  if (s === 'landing' || s === 'land' || s === 'single' || s === 'singlepage') return 'landing';
  if (s === 'multipage' || s === 'multi' || s === 'multipages') return 'multipage';
  return null;
}

function recommendedPageCount(siteMap, content) {
  const fromMap = siteMap && Array.isArray(siteMap.recommended_pages) ? siteMap.recommended_pages.length : 0;
  if (fromMap) return fromMap;
  const fromContent = content && Array.isArray(content.recommended_pages) ? content.recommended_pages.length : 0;
  return fromContent;
}

function inferSiteShapeFromPageCount(count) {
  return Number(count) >= MANY_PAGES_THRESHOLD ? 'multipage' : 'landing';
}

/** Peek lead research for default site_shape when the caller did not set one. */
function peekRecommendedPageCount(db, leadId) {
  if (!leadId) return 0;
  const mapRow = db.prepare(
    "SELECT value FROM business_facts WHERE lead_id = ? AND fact_key = 'site.map' ORDER BY id DESC LIMIT 1"
  ).get(leadId);
  if (mapRow) {
    try {
      const map = JSON.parse(mapRow.value);
      const n = recommendedPageCount(map, null);
      if (n) return n;
    } catch { /* ignore */ }
  }
  const snapRow = db.prepare(
    "SELECT value FROM business_facts WHERE lead_id = ? AND fact_key = 'site.snapshot' ORDER BY id DESC LIMIT 1"
  ).get(leadId);
  if (snapRow) {
    try {
      const snap = JSON.parse(snapRow.value);
      return recommendedPageCount(snap && snap.site_map, null);
    } catch { /* ignore */ }
  }
  return 0;
}

function defaultSiteShape(db, leadId, type) {
  if (type !== 'website') return null;
  return inferSiteShapeFromPageCount(peekRecommendedPageCount(db, leadId));
}

/**
 * Resolve stored shape. Missing/null on old rows → multipage (backward compat),
 * unless brief already recorded a shape.
 */
function resolveSiteShape(row, brief) {
  const fromCol = normalizeSiteShape(row && row.site_shape);
  if (fromCol) return fromCol;
  const fromBrief = normalizeSiteShape(brief && brief.site_shape);
  if (fromBrief) return fromBrief;
  return 'multipage';
}

function websiteShapeConstraints(siteShape) {
  if (siteShape === 'landing') {
    return [
      'site_shape is landing: deliver one focused marketing page (single primary page in pages[]). Collapse site_map.recommended_pages into scroll sections (hero, services, areas, FAQ, about, contact) — do not ship a multi-page IA.',
      'Still reuse research copy/services/FAQ/contact from source_structure / content / site_map; do not invent a new service menu. Prefer page.html + theme.customCss (baseCss:false).',
    ];
  }
  return [
    'site_shape is multipage: Payload { name, theme, pages }. Prefer page.html + theme.customCss (baseCss:false). Map source_structure roles/sections onto multipage freeform HTML.',
    'When site_map.recommended_pages is present, deliver that full IA (home, services index, each service page, areas, FAQ, about, contact) — do not stop at a 3–4 page stub.',
    'Use site_map.services / areas for the service menu and service-area coverage. Reuse site_map.faq answers. Geo matrix URLs collapse to one page per service plus one areas page.',
  ];
}

function ensureTables(db) {
  engine.ensureTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS design_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      instructions TEXT NOT NULL,
      lead_id INTEGER,
      status TEXT NOT NULL DEFAULT 'waiting_on_agent',
      brief TEXT,
      deliverable TEXT,
      claims TEXT,
      website_id INTEGER,
      built_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS design_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES design_jobs(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      answer TEXT,
      from_email TEXT,
      asked_at TEXT DEFAULT (datetime('now')),
      answered_at TEXT
    );
    CREATE TABLE IF NOT EXISTS design_question_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      to_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      message_id INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS design_delivery_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      to_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      message_id INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  const addCol = (table, name, type) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (cols.length && !cols.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  };
  addCol('design_jobs', 'contact_email', 'TEXT');
  addCol('design_jobs', 'questions_emailed_at', 'TEXT');
  addCol('design_jobs', 'delivery_emailed_at', 'TEXT');
  addCol('design_jobs', 'site_shape', 'TEXT');
  addCol('design_jobs', 'review', 'TEXT');
  // Last queued agent change: 'redesign' | 'improvements' (null for fresh assigns).
  addCol('design_jobs', 'request_kind', 'TEXT');
  addCol('design_questions', 'from_email', 'TEXT');
  try {
    require('./emailRedesign').ensureTables(db);
  } catch { /* optional module */ }
  try {
    require('./designLearning').ensureTables(db);
  } catch { /* optional module */ }
}

function logActivity(db, message) {
  try {
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run('design', String(message).slice(0, 2000));
  } catch { /* logging must not break the job */ }
}

function parseJson(text, fallback) {
  if (text == null || text === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

function questionsFor(db, jobId) {
  return db.prepare(
    'SELECT id, job_id, question, answer, from_email, asked_at, answered_at FROM design_questions WHERE job_id = ? ORDER BY id'
  ).all(jobId);
}

function pendingCount(db, jobId) {
  return db.prepare('SELECT COUNT(*) AS c FROM design_questions WHERE job_id = ? AND answer IS NULL').get(jobId).c;
}

function publicJob(db, row, { withDeliverable = true } = {}) {
  if (!row) return null;
  const questions = questionsFor(db, row.id);
  const brief = parseJson(row.brief, null);
  const out = {
    id: row.id,
    type: row.type,
    title: row.title,
    instructions: row.instructions,
    lead_id: row.lead_id,
    contact_email: row.contact_email || '',
    questions_emailed_at: row.questions_emailed_at || null,
    delivery_emailed_at: row.delivery_emailed_at || null,
    site_shape: resolveSiteShape(row, brief),
    request_kind: row.request_kind || (brief && brief.request_kind) || null,
    status: row.status,
    brief,
    website_id: row.website_id,
    built_by: row.built_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    questions,
    pending_questions: questions.filter((q) => q.answer == null).length,
  };
  if (withDeliverable) {
    out.deliverable = parseJson(row.deliverable, null);
    out.claims = parseJson(row.claims, []);
  } else {
    out.has_delivery = !!row.deliverable;
  }
  out.review = parseJson(row.review, null);
  try {
    const emailRedesign = require('./emailRedesign');
    out.email_redesigns = emailRedesign.listEmailRedesigns(db, { jobId: row.id, pendingOnly: true, limit: 20 });
    out.pending_email_redesigns = out.email_redesigns.length;
  } catch {
    out.email_redesigns = [];
    out.pending_email_redesigns = 0;
  }
  return out;
}

async function reviewJob(db, id, opts = {}) {
  const designReview = require('./designReview');
  return designReview.reviewDesignJob(db, id, opts);
}

async function redesignJob(db, id, opts = {}) {
  const designReview = require('./designReview');
  return designReview.requestRedesign(db, id, opts);
}

async function improveJob(db, id, opts = {}) {
  const designReview = require('./designReview');
  return designReview.requestImprovements(db, id, opts);
}

function getRow(db, id) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM design_jobs WHERE id = ?').get(id);
  if (!row) throw fail('JOB_NOT_FOUND', `Design job #${id} not found.`);
  return row;
}

function buildBrief(db, leadId, instructions, type, siteShape) {
  const shape = type === 'website'
    ? (normalizeSiteShape(siteShape) || 'multipage')
    : normalizeSiteShape(siteShape);
  const constraints = [
    'Reuse the old site’s information architecture and wording from source_structure / content.copy_blocks / site_snapshot — same pages, headings, services, and body copy wherever provided.',
    'You may lightly edit for clarity, but do not invent a new service menu, about story, or contact details. Missing bits → design.ask or leave out.',
    'Restyle visually: new composition, type, motion. Do not ship generic card/hero template kits and do not clone the old CSS grid.',
    'When style_guide is present, use palette, fonts, and logo as brand cues (theme.primary = style_guide.primary when set).',
    'verified_facts / content contact fields may be labeled VERIFIED. Reused on-site copy is VERIFIED when taken from source_structure. Fresh marketing glue is AI_COPY.',
    'candidate_facts are unconfirmed — soft inspiration or design.ask only; never label them VERIFIED.',
    'Ask clarifying questions with design.ask if you want. Submit with design.deliver.',
  ];
  if (type === 'website') {
    constraints.push(...websiteShapeConstraints(shape));
    constraints.push('Prefer content.images_enhanced (AI) over content.images / site_snapshot.images; use style_guide.logo when present. Pexels only if no site photos.');
  } else {
    constraints.push('Payload is any structured JSON you need (notes, copy, assets, links). The app shows it as-is and will not turn it into a website.');
  }
  const brief = {
    instruction: instructions,
    job_type: type,
    site_shape: shape || null,
    constraints,
    lead: null,
    verified_facts: [],
    candidate_facts: [],
    site_snapshot: null,
    style_guide: null,
    source_structure: null,
    site_map: null,
    content: null,
    owner_notes: '',
    learned_lessons: [],
  };
  if (!leadId) {
    try {
      require('./designLearning').attachLessonsToBrief(db, brief, { jobType: type, siteShape: shape });
    } catch { /* learning optional */ }
    return brief;
  }
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) throw fail('LEAD_NOT_FOUND', `Lead #${leadId} not found.`);
  const facts = engine.collectFacts(db, lead);
  const verified = [];
  for (const [key, fact] of facts.ok) {
    if (fact.claim_class === 'VERIFIED' || fact.claim_class === 'OWNER_PROVIDED') {
      verified.push({
        fact_key: key,
        value: fact.value,
        source: fact.source,
        claim_class: fact.claim_class,
      });
    }
  }
  const candidates = (facts.unknown || []).map((f) => ({
    fact_key: f.fact_key,
    value: f.value,
    claim_class: 'UNKNOWN',
  }));

  let siteSnapshot = null;
  const snapFact = verified.find((f) => f.fact_key === 'site.snapshot');
  if (snapFact) {
    try { siteSnapshot = JSON.parse(snapFact.value); } catch { siteSnapshot = null; }
  }
  if (!siteSnapshot) {
    const rows = db.prepare(
      "SELECT fact_key, value FROM business_facts WHERE lead_id = ? AND fact_key = 'site.snapshot' ORDER BY id DESC LIMIT 1"
    ).all(leadId);
    if (rows[0]) {
      try { siteSnapshot = JSON.parse(rows[0].value); } catch { siteSnapshot = null; }
    }
  }

  const services = verified
    .filter((f) => f.fact_key.startsWith('service:'))
    .map((f) => f.value);
  const images = [];
  const imagesEnhanced = [];
  for (const f of verified) {
    const k = String(f.fact_key);
    if (/^site\.image:\d+$/.test(k)) images.push(f.value);
  }
  // Enhanced images are AI_COPY — read from all facts, not only verified map.
  const enhRows = db.prepare(
    "SELECT fact_key, value FROM business_facts WHERE lead_id = ? AND fact_key LIKE 'site.image.enhanced:%' AND fact_key NOT LIKE '%.local' ORDER BY id"
  ).all(leadId);
  for (const r of enhRows) imagesEnhanced.push(r.value);
  if (!images.length) {
    const imgRows = db.prepare(
      "SELECT value FROM business_facts WHERE lead_id = ? AND fact_key GLOB 'site.image:[0-9]*' AND fact_key NOT LIKE '%.%' ORDER BY id"
    ).all(leadId);
    // SQLite GLOB may not match — fallback LIKE
    if (!imgRows.length) {
      db.prepare(
        "SELECT fact_key, value FROM business_facts WHERE lead_id = ? AND fact_key LIKE 'site.image:%' ORDER BY id"
      ).all(leadId).forEach((r) => {
        if (/^site\.image:\d+$/.test(r.fact_key)) images.push(r.value);
      });
    } else {
      imgRows.forEach((r) => images.push(r.value));
    }
  }
  const aboutFact = verified.find((f) => f.fact_key === 'site.about' || f.fact_key === 'description');
  const hoursFact = verified.find((f) => f.fact_key === 'hours');
  const ctasFact = verified.find((f) => f.fact_key === 'site.ctas');

  brief.lead = {
    id: lead.id,
    business_name: lead.business_name || '',
    category: lead.category || '',
    city: lead.city || '',
    state: lead.state || '',
    website: lead.website || '',
  };
  brief.verified_facts = verified;
  brief.candidate_facts = candidates.slice(0, 40);
  brief.site_snapshot = siteSnapshot;

  let styleGuide = (siteSnapshot && siteSnapshot.style_guide) || null;
  if (!styleGuide) {
    const sgFact = verified.find((f) => f.fact_key === 'site.style_guide')
      || db.prepare(
        "SELECT value FROM business_facts WHERE lead_id = ? AND fact_key = 'site.style_guide' ORDER BY id DESC LIMIT 1"
      ).get(leadId);
    const raw = sgFact && (sgFact.value || sgFact);
    if (raw) {
      try { styleGuide = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { styleGuide = null; }
    }
  }
  if (!styleGuide) {
    const primary = (verified.find((f) => f.fact_key === 'site.brand.primary') || {}).value;
    const secondary = (verified.find((f) => f.fact_key === 'site.brand.secondary') || {}).value;
    const font = (verified.find((f) => f.fact_key === 'site.brand.font') || {}).value;
    const logo = (verified.find((f) => f.fact_key === 'site.brand.logo') || {}).value;
    if (primary || font || logo) {
      styleGuide = {
        primary: primary || null,
        secondary: secondary || null,
        fonts: font ? [font] : [],
        logo: logo || null,
        direction: 'Use extracted brand cues; invent a fresh non-template layout.',
        source: 'facts',
      };
    }
  }
  brief.style_guide = styleGuide;

  let sourceStructure = (siteSnapshot && siteSnapshot.structure) || null;
  if (!sourceStructure) {
    const st = db.prepare(
      "SELECT value FROM business_facts WHERE lead_id = ? AND fact_key = 'site.structure' ORDER BY id DESC LIMIT 1"
    ).get(leadId);
    if (st) {
      try { sourceStructure = JSON.parse(st.value); } catch { sourceStructure = null; }
    }
  }
  brief.source_structure = sourceStructure;

  let siteMap = (siteSnapshot && siteSnapshot.site_map) || null;
  if (!siteMap) {
    const mapRow = db.prepare(
      "SELECT value FROM business_facts WHERE lead_id = ? AND fact_key = 'site.map' ORDER BY id DESC LIMIT 1"
    ).get(leadId);
    if (mapRow) {
      try { siteMap = JSON.parse(mapRow.value); } catch { siteMap = null; }
    }
  }
  brief.site_map = siteMap;

  let faq = (siteMap && siteMap.faq) || (siteSnapshot && siteSnapshot.faq) || [];
  if (!faq.length) {
    const faqRow = db.prepare(
      "SELECT value FROM business_facts WHERE lead_id = ? AND fact_key = 'site.faq' ORDER BY id DESC LIMIT 1"
    ).get(leadId);
    if (faqRow) {
      try { faq = JSON.parse(faqRow.value); } catch { faq = []; }
    }
  }

  const copyBlocks = [];
  for (const f of verified) {
    if (!String(f.fact_key).startsWith('site.copy:')) continue;
    try { copyBlocks.push(JSON.parse(f.value)); } catch { /* skip */ }
  }
  if (!copyBlocks.length) {
    const rows = db.prepare(
      "SELECT value FROM business_facts WHERE lead_id = ? AND fact_key LIKE 'site.copy:%' ORDER BY id"
    ).all(leadId);
    for (const r of rows) {
      try { copyBlocks.push(JSON.parse(r.value)); } catch { /* skip */ }
    }
  }
  let nav = (siteSnapshot && siteSnapshot.nav) || [];
  if (!nav.length) {
    const navRow = db.prepare(
      "SELECT value FROM business_facts WHERE lead_id = ? AND fact_key = 'site.nav' ORDER BY id DESC LIMIT 1"
    ).get(leadId);
    if (navRow) {
      try { nav = JSON.parse(navRow.value); } catch { nav = []; }
    }
  }

  const mapServices = (siteMap && Array.isArray(siteMap.services))
    ? siteMap.services.map((s) => s.title || s.slug).filter(Boolean)
    : [];
  const mergedServices = [...services];
  for (const s of mapServices) {
    if (!mergedServices.some((x) => String(x).toLowerCase() === String(s).toLowerCase())) {
      mergedServices.push(s);
    }
  }

  brief.content = {
    about: aboutFact ? aboutFact.value : (lead.description || ''),
    services: mergedServices,
    hours: hoursFact ? hoursFact.value : (lead.hours || ''),
    ctas: ctasFact ? (() => { try { return JSON.parse(ctasFact.value); } catch { return []; } })() : [],
    images,
    images_enhanced: imagesEnhanced,
    nav,
    copy_blocks: copyBlocks.slice(0, 48),
    faq,
    areas: (siteMap && siteMap.areas) || [],
    recommended_pages: (siteMap && siteMap.recommended_pages) || [],
    phone: (verified.find((f) => f.fact_key === 'phone') || {}).value || lead.phone || '',
    email: (verified.find((f) => f.fact_key === 'email') || {}).value || lead.email || '',
    address: (verified.find((f) => f.fact_key === 'address') || {}).value || lead.address || '',
  };
  const notes = [lead.notes, lead.qualification_note].filter((s) => s && String(s).trim());
  brief.owner_notes = notes.join('\n\n');
  try {
    require('./designLearning').attachLessonsToBrief(db, brief, { jobType: type, siteShape: shape });
  } catch { /* learning optional */ }
  return brief;
}

function createJob(db, input = {}) {
  ensureTables(db);
  const type = String(input.type || '').trim().slice(0, 40);
  const title = String(input.title || '').trim().slice(0, 200);
  const instructions = String(input.instructions || '').trim().slice(0, 8000);
  if (!type) throw fail('INVALID_ARGS', 'type is required (website, logo, social, flyer, brand, other, or your own label).');
  if (!title) throw fail('INVALID_ARGS', 'title is required.');
  if (!instructions) throw fail('INVALID_ARGS', 'instructions are required. Describe the work for the agent.');
  let leadId = null;
  if (input.leadId != null && input.leadId !== '') {
    leadId = Number(input.leadId);
    if (!Number.isInteger(leadId) || leadId < 1) throw fail('INVALID_ARGS', 'leadId must be a positive integer.');
  }
  const rawShape = input.siteShape != null ? input.siteShape : input.site_shape;
  let siteShape = normalizeSiteShape(rawShape);
  if (rawShape != null && String(rawShape).trim() !== '' && !siteShape) {
    throw fail('INVALID_ARGS', 'site_shape must be "landing" or "multipage".');
  }
  if (type === 'website' && !siteShape) {
    siteShape = defaultSiteShape(db, leadId, type);
  }
  const brief = buildBrief(db, leadId, instructions, type, siteShape);
  let contact = String(input.contactEmail || '').trim().slice(0, 254);
  if (!contact && leadId) {
    const lead = db.prepare('SELECT email FROM leads WHERE id = ?').get(leadId);
    contact = lead && lead.email ? String(lead.email).trim() : '';
  }
  if (leadId) {
    const open = db.prepare(
      `SELECT * FROM design_jobs WHERE lead_id = ? AND type = ? AND status != 'delivered' ORDER BY id DESC LIMIT 1`
    ).get(leadId, type);
    if (open) {
      const pending = pendingCount(db, open.id);
      const status = pending ? 'questions_pending' : 'waiting_on_agent';
      db.prepare(
        `UPDATE design_jobs SET title = ?, instructions = ?, brief = ?, site_shape = ?, contact_email = COALESCE(NULLIF(?, ''), contact_email), status = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(title, instructions, JSON.stringify(brief), siteShape, contact, status, open.id);
      logActivity(db, `Design job #${open.id} brief refreshed (${type}, ${siteShape || 'n/a'}). Waiting on the agent.`);
      notifyAgentQueue(db,
        `Design job #${open.id} refreshed (${type}). Status ${status} — MCP agents: design.next or design.pending.`,
        { jobId: open.id, reason: 'refreshed', status }
      );
      return publicJob(db, getRow(db, open.id));
    }
  }
  const info = db.prepare(
    `INSERT INTO design_jobs (type, title, instructions, lead_id, contact_email, status, brief, site_shape, built_by)
     VALUES (?, ?, ?, ?, ?, 'waiting_on_agent', ?, ?, NULL)`
  ).run(type, title, instructions, leadId, contact || null, JSON.stringify(brief), siteShape);
  const id = Number(info.lastInsertRowid);
  logActivity(db, `Design job #${id} assigned (${type}${siteShape ? `, ${siteShape}` : ''}): "${title}". Waiting on the agent.`);
  notifyAgentQueue(db,
    `Design job #${id} assigned (${type}): "${title.slice(0, 120)}". Status waiting_on_agent — MCP agents: design.next or design.pending.`,
    { jobId: id, reason: 'assigned', status: 'waiting_on_agent' }
  );
  return publicJob(db, getRow(db, id));
}

/** Update site_shape (and rebuild brief constraints) on an existing job. */
function updateJob(db, id, input = {}) {
  ensureTables(db);
  const row = getRow(db, id);
  const rawShape = input.siteShape != null ? input.siteShape : input.site_shape;
  if (rawShape == null || String(rawShape).trim() === '') {
    throw fail('INVALID_ARGS', 'site_shape is required ("landing" or "multipage").');
  }
  const siteShape = normalizeSiteShape(rawShape);
  if (!siteShape) throw fail('INVALID_ARGS', 'site_shape must be "landing" or "multipage".');
  const brief = buildBrief(db, row.lead_id, row.instructions, row.type, siteShape);
  // Preserve instruction text already on the job; rebuild research + shape constraints.
  brief.instruction = row.instructions;
  db.prepare(
    `UPDATE design_jobs SET site_shape = ?, brief = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(siteShape, JSON.stringify(brief), row.id);
  logActivity(db, `Design job #${row.id} site_shape set to ${siteShape}.`);
  return publicJob(db, getRow(db, row.id));
}

/**
 * Stderr ping + optional desktop notify / trigger file / shell command
 * when a job is waiting_on_agent. Failures never throw.
 * meta.reason vocabulary: assigned | redesign | improvements |
 * questions_answered | refreshed | queue
 */
function notifyAgentQueue(db, message, meta = {}) {
  try {
    if (typeof process !== 'undefined' && process.stderr && process.stderr.write) {
      process.stderr.write(`[design-agent] ${message}\n`);
    }
  } catch { /* ignore */ }
  try {
    const { fireAgentTriggers } = require('./designAgentTrigger');
    fireAgentTriggers(db, {
      jobId: meta.jobId,
      reason: meta.reason || 'queue',
      status: meta.status || 'waiting_on_agent',
      message,
    });
  } catch { /* ignore */ }
}

const AGENT_QUEUE_STATUSES = ['waiting_on_agent', 'questions_pending'];

function pendingAgentSummary(db, { previewLimit = 10 } = {}) {
  ensureTables(db);
  const counts = { waiting_on_agent: 0, questions_pending: 0 };
  for (const row of db.prepare(
    `SELECT status, COUNT(*) AS c FROM design_jobs
     WHERE status IN ('waiting_on_agent', 'questions_pending')
     GROUP BY status`
  ).all()) {
    if (row.status in counts) counts[row.status] = row.c;
  }
  const total = counts.waiting_on_agent + counts.questions_pending;
  const limit = Math.min(50, Math.max(1, Number(previewLimit) || 10));
  const preview = db.prepare(
    `SELECT * FROM design_jobs
     WHERE status IN ('waiting_on_agent', 'questions_pending')
     ORDER BY
       CASE status WHEN 'waiting_on_agent' THEN 0 ELSE 1 END,
       created_at ASC, id ASC
     LIMIT ?`
  ).all(limit).map((row) => publicJob(db, row, { withDeliverable: false }));
  return {
    total,
    counts,
    preview,
    hint: total
      ? 'Call design.next to claim the oldest waiting_on_agent job (marks in_progress), or design.get with a specific id.'
      : 'No jobs waiting on the agent.',
  };
}

function pendingSignature(summary) {
  const c = summary.counts || {};
  const ids = (summary.preview || []).map((j) => `${j.id}:${j.status}:${j.updated_at}`);
  return `${summary.total}|${c.waiting_on_agent}|${c.questions_pending}|${ids.join(',')}`;
}

function claimNextAgentJob(db) {
  ensureTables(db);
  const row = db.prepare(
    `SELECT * FROM design_jobs
     WHERE status = 'waiting_on_agent'
     ORDER BY created_at ASC, id ASC
     LIMIT 1`
  ).get();
  if (!row) return null;
  return getJob(db, row.id, { markInProgress: true });
}

function listJobs(db, { status, limit, page, pageSize } = {}) {
  ensureTables(db);
  const { pageArgs, pageResult } = require('./paginate');
  // Legacy `limit` (MCP) maps to a single page of that size.
  const legacyLimit = limit != null ? Math.min(100, Math.max(1, Number(limit) || 50)) : null;
  const paging = pageArgs(
    { page: page || 1, pageSize: pageSize != null ? pageSize : (legacyLimit || 25) },
    { pageSize: 25, maxSize: 100 }
  );
  let where = '';
  const params = [];
  if (status) {
    if (!STATUSES.includes(status)) throw fail('INVALID_ARGS', 'Unknown status.');
    where = ' WHERE status = ?';
    params.push(status);
  }
  const total = db.prepare(`SELECT COUNT(*) AS c FROM design_jobs${where}`).get(...params).c;
  const rows = db.prepare(
    `SELECT * FROM design_jobs${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`
  ).all(...params, paging.pageSize, paging.offset)
    .map((row) => publicJob(db, row, { withDeliverable: false }));
  return Object.assign({ jobs: rows }, pageResult(rows, total, paging.page, paging.pageSize));
}

function getJob(db, id, { markInProgress = false } = {}) {
  const row = getRow(db, id);
  if (markInProgress && row.status === 'waiting_on_agent') {
    db.prepare(`UPDATE design_jobs SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?`).run(id);
    try {
      require('./designLearning').refreshJobBriefLessons(db, id);
    } catch { /* learning optional */ }
    logActivity(db, `Design job #${id} picked up by the agent.`);
    return publicJob(db, getRow(db, id));
  }
  return publicJob(db, row);
}

function askQuestion(db, jobId, question) {
  const row = getRow(db, jobId);
  const text = String(question || '').trim();
  if (!text) throw fail('INVALID_ARGS', 'question is required.');
  if (text.length > 2000) throw fail('INVALID_ARGS', 'question must be 2000 characters or fewer.');
  const info = db.prepare('INSERT INTO design_questions (job_id, question) VALUES (?, ?)').run(jobId, text);
  db.prepare(`UPDATE design_jobs SET status = 'questions_pending', updated_at = datetime('now') WHERE id = ?`).run(jobId);
  logActivity(db, `Design job #${jobId} question #${info.lastInsertRowid}: ${text.slice(0, 180)}`);
  return {
    id: Number(info.lastInsertRowid),
    job_id: row.id,
    question: text,
    answer: null,
    status: 'questions_pending',
  };
}

function listAnswers(db, jobId) {
  getRow(db, jobId);
  return questionsFor(db, jobId);
}

function answerQuestion(db, questionId, answer, fromEmail) {
  ensureTables(db);
  const q = db.prepare('SELECT * FROM design_questions WHERE id = ?').get(questionId);
  if (!q) throw fail('QUESTION_NOT_FOUND', `Question #${questionId} not found.`);
  const text = String(answer || '').trim();
  if (!text) throw fail('INVALID_ARGS', 'answer is required.');
  if (text.length > 4000) throw fail('INVALID_ARGS', 'answer must be 4000 characters or fewer.');
  const from = cleanEmail(fromEmail);
  db.prepare(`UPDATE design_questions SET answer = ?, from_email = ?, answered_at = datetime('now') WHERE id = ?`).run(text, from, questionId);
  refreshQuestionStatus(db, q.job_id);
  logActivity(db, `Design job #${q.job_id} answer recorded for question #${questionId}.`);
  return publicJob(db, getRow(db, q.job_id));
}

function refreshQuestionStatus(db, jobId) {
  const pending = pendingCount(db, jobId);
  const job = getRow(db, jobId);
  let status = job.status;
  const prev = job.status;
  if (!pending && status === 'questions_pending') status = 'waiting_on_agent';
  else if (pending) status = 'questions_pending';
  db.prepare(`UPDATE design_jobs SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, jobId);
  if (prev !== status && status === 'waiting_on_agent') {
    notifyAgentQueue(db,
      `Design job #${jobId} is waiting_on_agent again (questions answered). MCP agents: design.next or design.pending.`,
      { jobId, reason: 'questions_answered', status: 'waiting_on_agent' }
    );
  }
}

function cleanEmail(value) {
  const email = String(value || '').trim().toLowerCase().slice(0, 254);
  if (!email) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw fail('INVALID_ARGS', 'from email is not a valid address.');
  }
  return email;
}

function settingValue(db, key) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row && row.value != null ? String(row.value) : '';
  } catch { return ''; }
}

function setContactEmail(db, jobId, email) {
  getRow(db, jobId);
  const clean = cleanEmail(email);
  if (!clean) throw fail('INVALID_ARGS', 'contact email is required.');
  db.prepare(`UPDATE design_jobs SET contact_email = ?, updated_at = datetime('now') WHERE id = ?`).run(clean, jobId);
  logActivity(db, `Design job #${jobId} contact email set.`);
  return publicJob(db, getRow(db, jobId));
}

function composeQuestionEmail(db, row, pending) {
  const lead = row.lead_id ? db.prepare('SELECT business_name, email FROM leads WHERE id = ?').get(row.lead_id) : null;
  const business = (lead && lead.business_name) || row.title;
  const to = String(row.contact_email || (lead && lead.email) || '').trim().toLowerCase();
  const subject = `Questions about project #${row.id}: ${row.title}`.slice(0, 200);
  const lines = pending.map((q, i) => `${i + 1}. ${q.question}`).join('\n');
  const footer = settingValue(db, 'mail.footer');
  const body = [
    `Project #${row.id} — ${row.title}`,
    `Business: ${business}`,
    `Kind of work: ${row.type}`,
    '',
    'A few questions before this design continues:',
    '',
    lines,
    '',
    'Reply with your answers. Paste that reply into the design job in the app if inbound email is not connected.',
    footer ? `\n${footer}` : '',
  ].join('\n');
  return { to, subject, body, business };
}

function emailQuestions(db, jobId) {
  ensureTables(db);
  const row = getRow(db, jobId);
  const pending = questionsFor(db, jobId).filter((q) => q.answer == null);
  if (!pending.length) throw fail('NO_QUESTIONS', 'This job has no unanswered questions to email.');
  const draft = composeQuestionEmail(db, row, pending);
  const paused = settingValue(db, 'automation_paused') === '1';
  if (paused) {
    throw fail('AUTOMATION_PAUSED', 'Automation is paused. These questions were not emailed.');
  }
  if (!draft.to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.to)) {
    throw fail('NO_RECIPIENT', 'No contact email on this job. Add one on the job, or an email on the lead.');
  }
  const suppressed = db.prepare('SELECT reason FROM suppression_list WHERE lower(email) = lower(?)').get(draft.to);
  if (suppressed) {
    throw fail('SUPPRESSED', `This address is on the suppression list (${suppressed.reason}). Questions were not emailed.`);
  }
  const cap = parseInt(settingValue(db, 'cost.max_outreach_per_day'), 10) || 200;
  const sentToday = db.prepare(
    `SELECT COUNT(*) AS c FROM campaign_messages WHERE status = 'sent' AND date(sent_at) = date('now', 'localtime')`
  ).get().c;
  if (sentToday >= cap) {
    throw fail('CAP_REACHED', `Daily outreach cap reached (${cap}). Questions were not queued.`);
  }
  const host = settingValue(db, 'smtp.host').trim();
  const fromEmail = settingValue(db, 'smtp.from_email').trim();
  if (!host || !fromEmail) {
    return {
      queued: false,
      sent: false,
      code: 'SMTP_NOT_CONFIGURED',
      jobId: row.id,
      to: draft.to,
      subject: draft.subject,
      body: draft.body,
      questionIds: pending.map((q) => q.id),
      error: 'SMTP is not configured (smtp.host / smtp.from_email). Questions were composed but not emailed.',
    };
  }
  let messageId = null;
  if (row.lead_id) {
    let campaign = db.prepare("SELECT id FROM campaigns WHERE name = ?").get('Design questions');
    if (!campaign) {
      campaign = { id: Number(db.prepare("INSERT INTO campaigns (name, status) VALUES ('Design questions', 'draft')").run().lastInsertRowid) };
    }
    messageId = Number(db.prepare(
      `INSERT INTO campaign_messages (campaign_id, lead_id, to_email, subject, body, status)
       VALUES (?, ?, ?, ?, ?, 'queued')`
    ).run(campaign.id, row.lead_id, draft.to, draft.subject, draft.body).lastInsertRowid);
  }
  const info = db.prepare(
    `INSERT INTO design_question_emails (job_id, to_email, subject, body, status, message_id)
     VALUES (?, ?, ?, ?, 'queued', ?)`
  ).run(row.id, draft.to, draft.subject, draft.body, messageId);
  db.prepare(`UPDATE design_jobs SET questions_emailed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(row.id);
  logActivity(db, `Design job #${row.id} questions queued to ${draft.to} (${pending.length} question(s), not sent).`);
  return {
    queued: true,
    sent: false,
    jobId: row.id,
    emailId: Number(info.lastInsertRowid),
    messageId,
    to: draft.to,
    subject: draft.subject,
    body: draft.body,
    questionIds: pending.map((q) => q.id),
  };
}

const DELIVERY_ITEM_KEYS = [
  'days', 'posts', 'items', 'variants', 'cards', 'assets', 'slogans',
  'options', 'creatives', 'captions', 'concepts', 'slides', 'entries',
];
const DELIVERY_TEXT_KEYS = [
  'caption', 'copy', 'text', 'body', 'description', 'content', 'post', 'script', 'message',
];
const DELIVERY_TITLE_KEYS = ['headline', 'title', 'theme', 'name', 'label', 'day', 'platform', 'kind'];

function pickStr(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of keys) {
    if (typeof obj[k] === 'string' && obj[k].trim()) return obj[k].trim();
    if (typeof obj[k] === 'number') return String(obj[k]);
  }
  return '';
}

function formatDeliveryItemBlock(item, index, groupKey) {
  if (typeof item === 'string') {
    return [`${groupKey ? `${groupKey} ` : ''}#${index + 1}`, item.trim(), ''].join('\n');
  }
  if (!item || typeof item !== 'object') return '';
  const title = pickStr(item, DELIVERY_TITLE_KEYS)
    || (item.day != null ? `Day ${item.day}` : `${groupKey || 'Item'} ${index + 1}`);
  const lines = [];
  lines.push(`── ${title} ──`);
  if (Array.isArray(item.platform_fit) && item.platform_fit.length) {
    lines.push(`Platforms: ${item.platform_fit.map(String).join(', ')}`);
  }
  const primary = pickStr(item, DELIVERY_TEXT_KEYS);
  if (primary) {
    lines.push('');
    lines.push(primary);
  }
  if (Array.isArray(item.hashtags) && item.hashtags.length) {
    lines.push('');
    lines.push(item.hashtags.map(String).join(' '));
  } else if (typeof item.hashtags === 'string' && item.hashtags.trim()) {
    lines.push('');
    lines.push(item.hashtags.trim());
  }
  const cta = pickStr(item, ['cta', 'call_to_action']);
  if (cta) {
    lines.push('');
    lines.push(`CTA: ${cta}`);
  }
  if (item.image_suggestion) lines.push(`Image idea: ${String(item.image_suggestion).trim()}`);
  // Extra short string fields
  const skip = new Set([
    ...DELIVERY_TEXT_KEYS, ...DELIVERY_TITLE_KEYS,
    'hashtags', 'cta', 'call_to_action', 'image_suggestion', 'platform_fit', 'claims', 'id', 'day',
  ]);
  for (const [k, v] of Object.entries(item)) {
    if (skip.has(k) || v == null) continue;
    if (typeof v === 'string' && v.trim() && v.trim().length < 400) {
      lines.push(`${k}: ${v.trim()}`);
    } else if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number')) {
      lines.push(`${k}: ${v.map(String).join(', ')}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Clean plain-text email body for non-website deliveries (cards → email).
 */
function formatDeliveryEmailBody(db, row, payload) {
  const lead = row.lead_id
    ? db.prepare('SELECT business_name, email FROM leads WHERE id = ?').get(row.lead_id)
    : null;
  const business = (lead && lead.business_name)
    || (payload && payload.business)
    || row.title;
  const footer = settingValue(db, 'mail.footer');
  const sections = [];
  sections.push(`Project #${row.id} — ${row.title}`);
  sections.push(`Kind: ${row.type}`);
  sections.push(`For: ${business}`);
  if (payload && payload.market) sections.push(`Market: ${payload.market}`);
  if (payload && payload.contact && typeof payload.contact === 'object') {
    const c = payload.contact;
    const bits = [];
    if (c.phone_display || c.phone) bits.push(c.phone_display || c.phone);
    if (c.email) bits.push(c.email);
    if (c.address_line || c.address) bits.push(c.address_line || c.address);
    if (bits.length) sections.push(`Contact: ${bits.join(' · ')}`);
  }
  if (Array.isArray(payload && payload.channels) && payload.channels.length) {
    sections.push(`Channels: ${payload.channels.map(String).join(', ')}`);
  }
  sections.push('');
  sections.push('Here is your delivery, formatted for easy copy/paste:');
  sections.push('');

  // Overview notes
  if (payload) {
    for (const key of ['notes', 'summary', 'description']) {
      const v = payload[key];
      if (typeof v === 'string' && v.trim()) {
        sections.push(`Notes:\n${v.trim()}`, '');
      } else if (Array.isArray(v) && v.length) {
        sections.push('Notes:');
        v.forEach((line) => { if (String(line || '').trim()) sections.push(`• ${String(line).trim()}`); });
        sections.push('');
      }
    }
    for (const key of ['copy', 'text']) {
      if (typeof payload[key] === 'string' && payload[key].trim()) {
        sections.push(payload[key].trim(), '');
      }
    }
  }

  let itemBlocks = 0;
  if (payload && typeof payload === 'object') {
    for (const key of DELIVERY_ITEM_KEYS) {
      const arr = payload[key];
      if (!Array.isArray(arr) || !arr.length) continue;
      sections.push(`${key.toUpperCase()} (${arr.length})`);
      sections.push('');
      arr.forEach((item, i) => {
        const block = formatDeliveryItemBlock(item, i, key);
        if (block) {
          sections.push(block);
          itemBlocks += 1;
        }
      });
    }
    // Fallback: any array of objects with text
    if (!itemBlocks) {
      for (const [key, val] of Object.entries(payload)) {
        if (!Array.isArray(val) || !val.length) continue;
        if (!val.every((x) => x && typeof x === 'object')) continue;
        sections.push(`${key.toUpperCase()} (${val.length})`, '');
        val.forEach((item, i) => {
          const block = formatDeliveryItemBlock(item, i, key);
          if (block) {
            sections.push(block);
            itemBlocks += 1;
          }
        });
      }
    }
  }

  if (!itemBlocks && payload) {
    // Compact remaining top-level strings
    for (const [k, v] of Object.entries(payload)) {
      if (['kind', 'business', 'market', 'contact', 'channels', 'notes', 'claims'].includes(k)) continue;
      if (typeof v === 'string' && v.trim().length >= 8) {
        sections.push(`${k}:\n${v.trim()}`, '');
      }
    }
  }

  if (Array.isArray(payload && payload.links) && payload.links.length) {
    sections.push('Links:');
    payload.links.forEach((link) => {
      if (link && link.url) sections.push(`• ${link.label || link.url}: ${link.url}`);
    });
    sections.push('');
  }

  sections.push('—');
  sections.push('Sent from Website Scout. Reply if you want changes.');
  if (footer) sections.push(footer);
  return sections.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 50000);
}

function composeDeliveryEmail(db, row, payload) {
  const lead = row.lead_id
    ? db.prepare('SELECT business_name, email FROM leads WHERE id = ?').get(row.lead_id)
    : null;
  const to = String(row.contact_email || (lead && lead.email) || '').trim().toLowerCase();
  const kindLabel = String(row.type || 'delivery').replace(/[-_]/g, ' ');
  const subject = `${kindLabel} for you — project #${row.id}: ${row.title}`.slice(0, 200);
  const body = formatDeliveryEmailBody(db, row, payload);
  return { to, subject, body };
}

/**
 * Queue a clean client email of a non-website delivery (social, logo, flyer, …).
 * Same SMTP/queue rules as emailQuestions — composes even when SMTP is missing.
 */
function emailDelivery(db, jobId) {
  ensureTables(db);
  const row = getRow(db, jobId);
  if (row.type === 'website') {
    throw fail('WEBSITE_JOB', 'Use Open in browser / export for websites. Email delivery is for non-website jobs (social, logo, flyer, brand, …).');
  }
  const payload = parseJson(row.deliverable, null);
  if (!payload || typeof payload !== 'object') {
    throw fail('NO_DELIVERY', 'The agent has not delivered this job yet.');
  }
  const draft = composeDeliveryEmail(db, row, payload);
  const paused = settingValue(db, 'automation_paused') === '1';
  if (paused) {
    throw fail('AUTOMATION_PAUSED', 'Automation is paused. Delivery was not emailed.');
  }
  if (!draft.to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.to)) {
    throw fail('NO_RECIPIENT', 'No contact email on this job. Add one on the job, or an email on the lead.');
  }
  const suppressed = db.prepare('SELECT reason FROM suppression_list WHERE lower(email) = lower(?)').get(draft.to);
  if (suppressed) {
    throw fail('SUPPRESSED', `This address is on the suppression list (${suppressed.reason}). Delivery was not emailed.`);
  }
  const cap = parseInt(settingValue(db, 'cost.max_outreach_per_day'), 10) || 200;
  const sentToday = db.prepare(
    `SELECT COUNT(*) AS c FROM campaign_messages WHERE status = 'sent' AND date(sent_at) = date('now', 'localtime')`
  ).get().c;
  if (sentToday >= cap) {
    throw fail('CAP_REACHED', `Daily outreach cap reached (${cap}). Delivery was not queued.`);
  }
  const host = settingValue(db, 'smtp.host').trim();
  const fromEmail = settingValue(db, 'smtp.from_email').trim();
  if (!host || !fromEmail) {
    return {
      queued: false,
      sent: false,
      code: 'SMTP_NOT_CONFIGURED',
      jobId: row.id,
      to: draft.to,
      subject: draft.subject,
      body: draft.body,
      error: 'SMTP is not configured (smtp.host / smtp.from_email). Delivery email was composed but not queued.',
    };
  }
  let messageId = null;
  if (row.lead_id) {
    let campaign = db.prepare("SELECT id FROM campaigns WHERE name = ?").get('Design deliveries');
    if (!campaign) {
      campaign = {
        id: Number(db.prepare("INSERT INTO campaigns (name, status) VALUES ('Design deliveries', 'draft')").run().lastInsertRowid),
      };
    }
    messageId = Number(db.prepare(
      `INSERT INTO campaign_messages (campaign_id, lead_id, to_email, subject, body, status)
       VALUES (?, ?, ?, ?, ?, 'queued')`
    ).run(campaign.id, row.lead_id, draft.to, draft.subject, draft.body).lastInsertRowid);
  }
  const info = db.prepare(
    `INSERT INTO design_delivery_emails (job_id, to_email, subject, body, status, message_id)
     VALUES (?, ?, ?, ?, 'queued', ?)`
  ).run(row.id, draft.to, draft.subject, draft.body, messageId);
  db.prepare(
    `UPDATE design_jobs SET delivery_emailed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(row.id);
  logActivity(db, `Design job #${row.id} delivery email queued to ${draft.to} (not sent).`);
  return {
    queued: true,
    sent: false,
    jobId: row.id,
    emailId: Number(info.lastInsertRowid),
    messageId,
    to: draft.to,
    subject: draft.subject,
    body: draft.body,
  };
}

function recordEmailReply(db, jobId, reply, fromEmail) {
  ensureTables(db);
  getRow(db, jobId);
  const text = String(reply || '').trim();
  if (!text) throw fail('INVALID_ARGS', 'reply text is required.');
  if (text.length > 8000) throw fail('INVALID_ARGS', 'reply must be 8000 characters or fewer.');
  const from = cleanEmail(fromEmail);
  const pending = questionsFor(db, jobId).filter((q) => q.answer == null);
  if (!pending.length) throw fail('NO_QUESTIONS', 'This job has no open questions to attach a reply to.');
  const stmt = db.prepare(
    `UPDATE design_questions SET answer = ?, from_email = ?, answered_at = datetime('now') WHERE id = ? AND job_id = ?`
  );
  for (const q of pending) stmt.run(text, from, q.id, jobId);
  refreshQuestionStatus(db, jobId);
  logActivity(db, `Design job #${jobId} email reply recorded on ${pending.length} question(s).`);
  return publicJob(db, getRow(db, jobId));
}

function verifiedValueSet(db, leadId) {
  const set = new Set();
  if (!leadId) return set;
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) return set;
  const facts = engine.collectFacts(db, lead);
  for (const [, fact] of facts.ok) {
    if (fact.claim_class === 'VERIFIED' || fact.claim_class === 'OWNER_PROVIDED') {
      const v = String(fact.value || '').trim().toLowerCase();
      if (v) set.add(v);
    }
  }
  return set;
}

function classify(agentClass, value, verified) {
  const chosen = CLAIM_CLASSES.has(agentClass) ? agentClass : 'AI_COPY';
  if (chosen !== 'VERIFIED') return chosen;
  const v = String(value || '').trim().toLowerCase();
  if (v && verified.has(v)) return 'VERIFIED';
  return 'AI_COPY';
}

function collectClaims(payload, verified, agentClaims) {
  const claims = [];
  const push = (claim, value, agentClass) => {
    const text = value == null ? '' : String(value).trim();
    if (!text) return;
    claims.push({
      claim: String(claim).slice(0, 80),
      value: text.slice(0, 200),
      class: classify(agentClass, text, verified),
      source: 'agent delivery',
    });
  };
  if (Array.isArray(agentClaims)) {
    for (const c of agentClaims) {
      if (!c || typeof c !== 'object') continue;
      push(c.claim || c.fact_key || 'claim', c.value, c.class || c.claim_class);
    }
  }
  const pages = payload && Array.isArray(payload.pages) ? payload.pages : [];
  const factKeys = ['phone', 'phone_display', 'email', 'address', 'business_name'];
  for (const page of pages) {
    for (const section of page.sections || []) {
      const content = section.content || {};
      for (const key of factKeys) {
        if (content[key]) push(key, content[key], 'VERIFIED');
      }
      if (content.rating) push('rating', content.rating, 'VERIFIED');
    }
  }
  if (payload && typeof payload.copy === 'string' && payload.copy.trim()) {
    push('copy', payload.copy, 'AI_COPY');
  }
  if (payload && typeof payload.notes === 'string' && payload.notes.trim()) {
    push('notes', payload.notes, 'AI_COPY');
  }
  return claims;
}

function validateWebsitePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw fail('INVALID_ARGS', 'website payload must be an object.');
  }
  if (!Array.isArray(payload.pages) || payload.pages.length === 0) {
    throw fail('INVALID_ARGS', 'website payload.pages must be a non-empty array.');
  }
  payload.pages.forEach((page, i) => {
    if (!page || typeof page !== 'object') throw fail('INVALID_ARGS', `pages[${i}] must be an object.`);
    if (typeof page.slug !== 'string' || !page.slug.trim()) throw fail('INVALID_ARGS', `pages[${i}].slug is required.`);
    if (typeof page.title !== 'string' || !page.title.trim()) throw fail('INVALID_ARGS', `pages[${i}].title is required.`);
    const hasHtml = typeof page.html === 'string' && page.html.trim();
    const hasSections = Array.isArray(page.sections) && page.sections.length > 0;
    if (!hasHtml && !hasSections) {
      throw fail('INVALID_ARGS', `pages[${i}] needs sections or html.`);
    }
    if (hasSections) {
      page.sections.forEach((section, j) => {
        if (!section || typeof section !== 'object') throw fail('INVALID_ARGS', `pages[${i}].sections[${j}] must be an object.`);
        if (typeof section.type !== 'string' || !section.type.trim()) {
          throw fail('INVALID_ARGS', `pages[${i}].sections[${j}].type is required.`);
        }
        if (!section.content || typeof section.content !== 'object' || Array.isArray(section.content)) {
          throw fail('INVALID_ARGS', `pages[${i}].sections[${j}].content must be an object.`);
        }
      });
    }
  });
  if (payload.theme != null && (typeof payload.theme !== 'object' || Array.isArray(payload.theme))) {
    throw fail('INVALID_ARGS', 'theme must be an object.');
  }
}

function liberateTheme(theme, pages) {
  const t = theme && typeof theme === 'object' && !Array.isArray(theme) ? Object.assign({}, theme) : {};
  const freeform = (pages || []).some((p) => typeof p.html === 'string' && p.html.trim());
  if (freeform || (t.customCss && String(t.customCss).trim())) {
    if (t.baseCss !== true && t.baseCss !== 1 && t.baseCss !== '1') t.baseCss = false;
  }
  return t;
}

function upsertWebsite(db, job, payload) {
  if (!job.lead_id) return null;
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(job.lead_id);
  if (!lead) return null;
  engine.ensureTables(db);
  const name = String(payload.name || job.title || lead.business_name || 'Website').slice(0, 200);
  payload.theme = liberateTheme(payload.theme, payload.pages);
  const theme = JSON.stringify(payload.theme || {});
  const pages = JSON.stringify(payload.pages);
  const existing = db.prepare('SELECT id FROM websites WHERE lead_id = ?').get(lead.id);
  let websiteId;
  if (existing) {
    db.prepare(
      `UPDATE websites SET name = ?, industry = ?, theme = ?, pages = ?, origin = 'agent', status = 'draft', updated_at = datetime('now') WHERE id = ?`
    ).run(name, job.type, theme, pages, existing.id);
    websiteId = existing.id;
  } else {
    const info = db.prepare(
      `INSERT INTO websites (lead_id, name, industry, theme, pages, status, origin)
       VALUES (?, ?, ?, ?, ?, 'draft', 'agent')`
    ).run(lead.id, name, lead.category || job.type, theme, pages);
    websiteId = Number(info.lastInsertRowid);
  }
  const versionNo = Number(db.prepare('SELECT COALESCE(MAX(version_no), 0) AS m FROM website_versions WHERE website_id = ?').get(websiteId).m) + 1;
  db.prepare('INSERT INTO website_versions (website_id, version_no, pages, theme, note) VALUES (?, ?, ?, ?, ?)')
    .run(websiteId, versionNo, pages, theme, 'Agent delivery');
  return websiteId;
}

function deliverJob(db, jobId, payload, agentClaims, opts = {}) {
  const row = getRow(db, jobId);
  const hadPriorDelivery = !!row.deliverable;
  const priorRequestKind = row.request_kind || null;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw fail('INVALID_ARGS', 'payload must be a JSON object.');
  }
  const rawShape = opts && (opts.siteShape != null ? opts.siteShape : opts.site_shape);
  let siteShape = null;
  if (rawShape != null && String(rawShape).trim() !== '') {
    siteShape = normalizeSiteShape(rawShape);
    if (!siteShape) throw fail('INVALID_ARGS', 'site_shape must be "landing" or "multipage".');
  }
  if (row.type === 'website') {
    validateWebsitePayload(payload);
    payload.theme = liberateTheme(payload.theme, payload.pages);
  }
  const encoded = JSON.stringify(payload);
  if (encoded.length > 5000000) throw fail('INVALID_ARGS', 'payload is too large.');
  const verified = verifiedValueSet(db, row.lead_id);
  const claims = collectClaims(payload, verified, agentClaims || payload.claims);
  let websiteId = row.website_id;
  if (row.type === 'website' && row.lead_id) {
    websiteId = upsertWebsite(db, row, payload);
    if (websiteId) {
      db.prepare('INSERT OR REPLACE INTO claim_manifest (website_id, manifest) VALUES (?, ?)')
        .run(websiteId, JSON.stringify(claims));
    }
  }
  if (siteShape) {
    const brief = parseJson(row.brief, {}) || {};
    brief.site_shape = siteShape;
    if (row.type === 'website') {
      // Refresh shape-specific constraints without dropping research already on the brief.
      const rebuilt = buildBrief(db, row.lead_id, row.instructions, row.type, siteShape);
      brief.constraints = rebuilt.constraints;
      brief.site_shape = siteShape;
    }
    db.prepare(
      `UPDATE design_jobs
       SET deliverable = ?, claims = ?, website_id = ?, built_by = 'agent', status = 'delivered',
           site_shape = ?, brief = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(encoded, JSON.stringify(claims), websiteId, siteShape, JSON.stringify(brief), jobId);
  } else {
    db.prepare(
      `UPDATE design_jobs
       SET deliverable = ?, claims = ?, website_id = ?, built_by = 'agent', status = 'delivered', updated_at = datetime('now')
       WHERE id = ?`
    ).run(encoded, JSON.stringify(claims), websiteId, jobId);
  }
  logActivity(db, `Design job #${jobId} delivered by agent (${row.type}${siteShape ? `, ${siteShape}` : ''}).`);
  try {
    require('./designLearning').observeDeliver(db, jobId, {
      hadPrior: hadPriorDelivery,
      requestKind: priorRequestKind,
      siteShape: siteShape || row.site_shape || null,
      pageCount: row.type === 'website' && payload.pages ? payload.pages.length : null,
    });
  } catch { /* learning optional */ }
  return publicJob(db, getRow(db, jobId));
}

function saveWebsiteEdit(db, jobId, pages, theme) {
  const row = getRow(db, jobId);
  if (row.type !== 'website') throw fail('NOT_A_WEBSITE', 'Block edits apply to website deliveries.');
  const payload = parseJson(row.deliverable, null);
  if (!payload || !Array.isArray(payload.pages)) throw fail('NO_DELIVERY', 'The agent has not delivered a website yet.');
  validateWebsitePayload({ pages, theme: theme || payload.theme });
  const freeform = (pages || []).some((p) => typeof p.html === 'string' && p.html.trim())
    || (payload.pages || []).some((p) => typeof p.html === 'string' && p.html.trim());
  // Freeform agent HTML is not forced through locked template fields.
  payload.pages = freeform ? pages : keepLocked(payload.pages, pages);
  if (theme && typeof theme === 'object' && !Array.isArray(theme)) {
    payload.theme = liberateTheme(theme, payload.pages);
  }
  const encoded = JSON.stringify(payload);
  db.prepare(`UPDATE design_jobs SET deliverable = ?, updated_at = datetime('now') WHERE id = ?`).run(encoded, jobId);
  if (row.website_id) {
    const themeJson = JSON.stringify(payload.theme || {});
    const pagesJson = JSON.stringify(payload.pages);
    db.prepare(`UPDATE websites SET pages = ?, theme = ?, origin = 'agent', updated_at = datetime('now') WHERE id = ?`)
      .run(pagesJson, themeJson, row.website_id);
    const versionNo = Number(db.prepare('SELECT COALESCE(MAX(version_no), 0) AS m FROM website_versions WHERE website_id = ?').get(row.website_id).m) + 1;
    db.prepare('INSERT INTO website_versions (website_id, version_no, pages, theme, note) VALUES (?, ?, ?, ?, ?)')
      .run(row.website_id, versionNo, pagesJson, themeJson, 'Block edit');
  }
  logActivity(db, `Design job #${jobId} website blocks saved.`);
  return publicJob(db, getRow(db, jobId));
}

const LOCKED_KEYS = ['phone', 'phone_display', 'email', 'address', 'address_lines', 'hours', 'rating', 'review_count', 'business_name'];

function keepLocked(prevPages, nextPages) {
  const next = JSON.parse(JSON.stringify(nextPages));
  next.forEach((page, pi) => {
    const prev = prevPages[pi];
    if (!prev) return;
    (page.sections || []).forEach((section, si) => {
      const old = prev.sections && prev.sections[si];
      if (!old || old.type !== section.type || !old.content || !section.content) return;
      for (const key of LOCKED_KEYS) {
        if (Object.prototype.hasOwnProperty.call(old.content, key)) section.content[key] = old.content[key];
      }
    });
  });
  return next;
}

function imageQueryFor(job, lead, requested) {
  const q = pexels.cleanQuery(requested);
  if (q) return q;
  if (lead && lead.category && String(lead.category).trim()) return String(lead.category).trim().slice(0, 100);
  if (job.type && job.type !== 'website') return String(job.type).slice(0, 100);
  return String(job.title || 'business').slice(0, 100);
}

async function addImages(db, jobId, opts = {}) {
  const row = getRow(db, jobId);
  if (row.type !== 'website') throw fail('NOT_A_WEBSITE', 'Pexels photos attach to website deliveries.');
  const payload = parseJson(row.deliverable, null);
  if (!payload || !Array.isArray(payload.pages)) throw fail('NO_DELIVERY', 'Deliver the website before adding photos.');
  const paused = db.prepare(`SELECT value FROM settings WHERE key = 'automation_paused'`).get();
  if (paused && paused.value === '1') {
    throw fail('AUTOMATION_PAUSED', 'Automation is paused. Resume it before pulling photos.');
  }
  const keyRow = db.prepare(`SELECT value FROM settings WHERE key = 'pexels.api_key'`).get();
  const key = keyRow && keyRow.value ? String(keyRow.value).trim() : '';
  if (!key) throw fail('PEXELS_NOT_CONFIGURED', 'Pexels API key is not set. Add it in Settings.');
  const lead = row.lead_id ? db.prepare('SELECT * FROM leads WHERE id = ?').get(row.lead_id) : null;
  const query = imageQueryFor(row, lead, opts.query);
  const count = pexels.clampCount(opts.count == null ? 5 : opts.count);
  const photos = await pexels.searchPhotos(key, query, count);
  if (!photos.length) throw fail('PEXELS_EMPTY', `Pexels returned no photos for "${query}".`);
  payload.pages = engine.applyImagesToPages(payload.pages, photos, { heroImage: true });
  const encoded = JSON.stringify(payload);
  db.prepare(`UPDATE design_jobs SET deliverable = ?, updated_at = datetime('now') WHERE id = ?`).run(encoded, jobId);
  if (row.website_id) {
    const pagesJson = JSON.stringify(payload.pages);
    const themeJson = JSON.stringify(payload.theme || {});
    db.prepare(`UPDATE websites SET pages = ?, origin = 'agent', updated_at = datetime('now') WHERE id = ?`).run(pagesJson, row.website_id);
    const versionNo = Number(db.prepare('SELECT COALESCE(MAX(version_no), 0) AS m FROM website_versions WHERE website_id = ?').get(row.website_id).m) + 1;
    db.prepare('INSERT INTO website_versions (website_id, version_no, pages, theme, note) VALUES (?, ?, ?, ?, ?)')
      .run(row.website_id, versionNo, pagesJson, themeJson, `Pexels photos for "${query}"`);
  }
  logActivity(db, `Design job #${jobId} attached ${photos.length} Pexels photo(s) for "${query}".`);
  return { id: jobId, count: photos.length, query };
}

function defaultImagePrompt(db, row) {
  const lead = row.lead_id
    ? db.prepare('SELECT business_name, category, city, state FROM leads WHERE id = ?').get(row.lead_id)
    : null;
  const business = (lead && lead.business_name) || row.title || 'local business';
  const category = (lead && lead.category) || row.type || 'business';
  const place = [lead && lead.city, lead && lead.state].filter(Boolean).join(', ');
  if (row.type === 'logo') {
    return `Clean professional logo mark for ${business} (${category}${place ? `, ${place}` : ''}). Simple vector-friendly shapes, high contrast, no tiny text, white background.`;
  }
  if (row.type === 'social') {
    return `Square social media photo for ${business}${place ? ` in ${place}` : ''}, ${category}, bright natural light, authentic local-business feel, no fake text overlays.`;
  }
  return `Professional photograph for a ${category} website hero — ${business}${place ? `, ${place}` : ''}. Realistic, sharp, inviting, no watermarks or unreadable text.`;
}

/**
 * Copy generated files into ~/website-scout-exports/design-{id}/images/ and
 * return relative urls (images/foo.png). Never embeds base64 into deliverables —
 * that blew up review/QA prompts and IPC.
 */
function stageImagesForJob(jobId, resultImages, prompt, model) {
  const fs = require('fs');
  const path = require('path');
  const openPreviewMod = require('./openPreview');
  const folder = `design-${jobId}`;
  const exportDir = path.join(openPreviewMod.exportRoot(), folder);
  const imgDir = path.join(exportDir, 'images');
  fs.mkdirSync(imgDir, { recursive: true });
  const assets = [];
  for (let i = 0; i < resultImages.length; i++) {
    const img = resultImages[i];
    const ext = (img.mime || '').includes('jpeg') ? 'jpg' : ((img.mime || '').includes('webp') ? 'webp' : 'png');
    const name = `openai-${Date.now()}-${i + 1}.${ext}`;
    const dest = path.join(imgDir, name);
    fs.copyFileSync(img.path, dest);
    const rel = `images/${name}`;
    assets.push({
      name,
      path: dest,
      url: rel,
      alt: String(prompt || '').slice(0, 120),
      photographer: 'OpenAI',
      source: 'openai',
      model,
      revised_prompt: img.revised_prompt || null,
    });
  }
  return { folder, exportDir, assets };
}

function injectRelativeImagesIntoFreeform(pages, photos) {
  let idx = 0;
  return (Array.isArray(pages) ? pages : []).map((page) => {
    if (!page || typeof page.html !== 'string' || !page.html.trim()) return page;
    let html = page.html;
    html = html.replace(
      /src=(["'])(data:image\/[^"']*|https?:\/\/(?:images\.unsplash\.com|picsum\.photos|via\.placeholder\.com)[^"']*)\1/gi,
      (m, q) => {
        if (idx >= photos.length) return m;
        const url = photos[idx++].url;
        return `src=${q}${url}${q}`;
      }
    );
    return Object.assign({}, page, { html });
  });
}

/**
 * Generate images via OpenAI Images API and attach to the job deliverable.
 * Stores file paths + relative urls only (no base64 in SQLite / IPC).
 */
async function generateJobImages(db, jobId, opts = {}) {
  ensureTables(db);
  const openaiImages = require('./openaiImages');
  const row = getRow(db, jobId);
  const payload = parseJson(row.deliverable, null);
  if (!payload || typeof payload !== 'object') {
    throw fail('NO_DELIVERY', 'Deliver the job before generating images.');
  }
  const prompt = String(opts.prompt || '').trim() || defaultImagePrompt(db, row);
  const n = Math.min(4, Math.max(1, Number(opts.n) || 1));
  const result = await openaiImages.generateImages(db, prompt, {
    n,
    size: opts.size,
    model: opts.model,
    quality: opts.quality != null ? opts.quality : 'low',
    jobId,
    leadId: row.lead_id,
    note: `design job #${jobId}`,
  });

  const staged = stageImagesForJob(jobId, result.images, prompt, result.model);
  const assets = staged.assets;

  // Absolute preview URLs for the desktop UI (localhost server; not stored in DB).
  let previewBase = null;
  try {
    const previewServer = require('./previewServer');
    const served = await previewServer.urlForExportFolder(staged.folder);
    previewBase = served.url.replace(/\/+$/, '');
  } catch { /* optional */ }

  if (row.type === 'website' && Array.isArray(payload.pages)) {
    const photos = assets.map((a) => ({
      url: a.url,
      alt: a.alt,
      photographer: a.photographer,
      photographer_url: '',
      pexels_url: '',
    }));
    const freeformOnly = payload.pages.length && payload.pages.every((p) =>
      typeof p.html === 'string' && p.html.trim() && !(Array.isArray(p.sections) && p.sections.length));
    if (freeformOnly) {
      payload.pages = injectRelativeImagesIntoFreeform(payload.pages, photos);
    } else {
      payload.pages = engine.applyImagesToPages(payload.pages, photos, { heroImage: true });
    }
    if (!Array.isArray(payload.images)) payload.images = [];
    payload.images.push(...assets.map((a) => ({
      alt: a.alt,
      source: 'openai',
      path: a.path,
      url: a.url,
      model: result.model,
    })));
  } else {
    // images[] is always a list. files may be an array OR a name→svg map from logo agents — never clobber a map.
    if (!Array.isArray(payload.images)) payload.images = [];
    const fileEntries = assets.map((a) => ({
      name: a.name,
      path: a.path,
      url: a.url,
      format: a.name.endsWith('.jpg') ? 'jpeg' : (a.name.endsWith('.webp') ? 'webp' : 'png'),
      source: 'openai',
      model: result.model,
    }));
    for (const a of assets) {
      payload.images.push({
        url: a.url,
        alt: a.alt,
        source: 'openai',
        path: a.path,
        name: a.name,
      });
    }
    if (Array.isArray(payload.files)) {
      payload.files.push(...fileEntries);
    } else if (payload.files && typeof payload.files === 'object') {
      if (!Array.isArray(payload.generated_files)) payload.generated_files = [];
      payload.generated_files.push(...fileEntries);
    } else {
      payload.files = fileEntries;
    }
  }

  const encoded = JSON.stringify(payload);
  if (encoded.length > 2000000) {
    throw fail('INVALID_ARGS', 'Deliverable grew too large after attaching generated images.');
  }
  db.prepare(
    `UPDATE design_jobs SET deliverable = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(encoded, jobId);

  if (row.type === 'website' && row.website_id) {
    try {
      const pagesJson = JSON.stringify(payload.pages);
      db.prepare(
        `UPDATE websites SET pages = ?, origin = 'agent', updated_at = datetime('now') WHERE id = ?`
      ).run(pagesJson, row.website_id);
    } catch { /* optional */ }
  }

  logActivity(db, `Design job #${jobId} generated ${assets.length} OpenAI image(s) (${result.model}).`);
  return {
    id: jobId,
    count: assets.length,
    model: result.model,
    prompt: result.prompt,
    paths: assets.map((a) => a.path),
    urls: assets.map((a) => a.url),
    previewUrls: previewBase ? assets.map((a) => `${previewBase}/${a.url}`) : [],
    // Lean job: avoid shipping huge briefs+payloads back over IPC after generate.
    status: 'delivered',
  };
}

async function openPreview(db, jobId) {
  const row = getRow(db, jobId);
  if (row.type !== 'website') throw fail('NOT_A_WEBSITE', 'Only a website delivery can open in a browser.');
  const payload = parseJson(row.deliverable, null);
  if (!payload || !Array.isArray(payload.pages) || !payload.pages.length) {
    throw fail('NO_DELIVERY', 'The agent has not delivered a website yet.');
  }
  const openPreviewMod = require('./openPreview');
  const opened = await openPreviewMod.openPagesFile(payload.pages, payload.theme || {}, `design-${row.id}`);
  logActivity(db, `Design job #${jobId} opened in the browser.`);
  return {
    id: jobId,
    path: opened.path,
    url: opened.url || null,
    folder: opened.folder || `design-${row.id}`,
    via: opened.via,
  };
}

/**
 * Export a delivered website and return a localhost http:// preview URL for MCP agents.
 * Does not open a browser unless opts.open is true.
 */
/**
 * Ensure localhost preview server can serve ~/website-scout-exports/design-{id}/.
 * Works for any job type (logo images, website HTML, …).
 */
async function assetBaseUrl(db, jobId) {
  const row = getRow(db, jobId);
  const fs = require('fs');
  const path = require('path');
  const openPreviewMod = require('./openPreview');
  const folder = `design-${row.id}`;
  const dir = path.join(openPreviewMod.exportRoot(), folder);
  fs.mkdirSync(dir, { recursive: true });
  const previewServer = require('./previewServer');
  const served = await previewServer.urlForExportFolder(folder);
  return {
    id: row.id,
    folder,
    dir,
    baseUrl: String(served.url || '').replace(/\/+$/, ''),
    url: served.url,
  };
}

async function previewUrl(db, jobId, opts = {}) {
  const row = getRow(db, jobId);
  if (row.type !== 'website') throw fail('NOT_A_WEBSITE', 'Preview URL is for website deliveries.');
  const payload = parseJson(row.deliverable, null);
  if (!payload || !Array.isArray(payload.pages) || !payload.pages.length) {
    throw fail('NO_DELIVERY', 'The agent has not delivered a website yet.');
  }
  const openPreviewMod = require('./openPreview');
  const folder = `design-${row.id}`;
  if (opts.open) {
    const opened = await openPreviewMod.openPagesFile(payload.pages, payload.theme || {}, folder);
    logActivity(db, `Design job #${jobId} preview URL opened: ${opened.url || opened.path}`);
    return {
      id: jobId,
      url: opened.url,
      path: opened.path,
      folder: opened.folder || folder,
      opened: true,
    };
  }
  const preview = await openPreviewMod.previewUrlForPages(payload.pages, payload.theme || {}, folder);
  logActivity(db, `Design job #${jobId} preview URL: ${preview.url}`);
  return {
    id: jobId,
    url: preview.url,
    indexUrl: preview.indexUrl,
    path: preview.path,
    folder: preview.folder,
    files: preview.files,
    port: preview.port,
    opened: false,
  };
}

function deleteJob(db, id) {
  ensureTables(db);
  const jobId = Number(id);
  if (!Number.isInteger(jobId) || jobId < 1) throw fail('INVALID_ARGS', 'id must be a positive integer.');
  const row = getRow(db, jobId);
  const title = row.title;
  const tx = db.transaction(() => {
    try { db.prepare('DELETE FROM design_delivery_emails WHERE job_id = ?').run(jobId); } catch { /* table may be new */ }
    db.prepare('DELETE FROM design_question_emails WHERE job_id = ?').run(jobId);
    db.prepare('DELETE FROM design_questions WHERE job_id = ?').run(jobId);
    db.prepare('DELETE FROM design_jobs WHERE id = ?').run(jobId);
  });
  tx();
  logActivity(db, `Design job #${jobId} deleted: "${String(title).slice(0, 120)}".`);
  return { id: jobId, deleted: true };
}

/**
 * Remove one card/item from a non-website deliverable.
 * path examples: "days.2", "notes.0", "notes", "copy"
 */
function removeDeliveryItem(db, jobId, path) {
  ensureTables(db);
  const row = getRow(db, jobId);
  if (row.type === 'website') {
    throw fail('WEBSITE_JOB', 'Card delete applies to non-website deliveries.');
  }
  const payload = parseJson(row.deliverable, null);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw fail('NO_DELIVERY', 'No delivery to edit.');
  }
  const raw = String(path || '').trim();
  if (!raw || raw.length > 120) throw fail('INVALID_ARGS', 'path is required (e.g. days.0).');
  if (!/^[a-zA-Z_][\w.]{0,118}$/.test(raw)) throw fail('INVALID_ARGS', 'Invalid delivery path.');

  const parts = raw.split('.');
  const key = parts[0];
  if (!(key in payload)) throw fail('NOT_FOUND', `No field "${key}" on this delivery.`);

  if (parts.length === 1) {
    delete payload[key];
  } else if (parts.length === 2) {
    const idx = Number(parts[1]);
    if (!Array.isArray(payload[key])) throw fail('INVALID_ARGS', `"${key}" is not a list.`);
    if (!Number.isInteger(idx) || idx < 0 || idx >= payload[key].length) {
      throw fail('NOT_FOUND', `No item at ${raw}.`);
    }
    payload[key].splice(idx, 1);
    if (!payload[key].length) delete payload[key];
  } else {
    throw fail('INVALID_ARGS', 'path may be "field" or "field.index" only.');
  }

  const encoded = JSON.stringify(payload);
  if (encoded.length > 5000000) throw fail('INVALID_ARGS', 'payload is too large.');
  db.prepare(
    `UPDATE design_jobs SET deliverable = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(encoded, jobId);
  logActivity(db, `Design job #${jobId} delivery item removed (${raw}).`);
  return publicJob(db, getRow(db, jobId));
}

module.exports = {
  buildBrief,
  SUGGESTED_TYPES,
  STATUSES,
  SITE_SHAPES,
  MANY_PAGES_THRESHOLD,
  AGENT_QUEUE_STATUSES,
  DEFAULT_WEBSITE_DESIGN_INSTRUCTIONS,
  defaultWebsiteInstructions,
  ensureTables,
  createJob,
  updateJob,
  listJobs,
  pendingAgentSummary,
  pendingSignature,
  claimNextAgentJob,
  getJob,
  askQuestion,
  listAnswers,
  answerQuestion,
  setContactEmail,
  emailQuestions,
  emailDelivery,
  formatDeliveryEmailBody,
  composeDeliveryEmail,
  recordEmailReply,
  deliverJob,
  saveWebsiteEdit,
  addImages,
  generateJobImages,
  openPreview,
  previewUrl,
  assetBaseUrl,
  deleteJob,
  removeDeliveryItem,
  reviewJob,
  redesignJob,
  improveJob,
  notifyAgentQueue,
  classify,
  normalizeSiteShape,
  resolveSiteShape,
  defaultSiteShape,
};
