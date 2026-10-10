'use strict';

/**
 * Review a delivered website design job and produce two instruction buckets:
 *   - redesign_instructions — fuller visual/IA rethink (design.redesign)
 *   - improvement_instructions — smaller polish/fixes (design.improve)
 * Optionally captures Electron screenshots and runs a vision pass.
 */

const fs = require('fs');
const path = require('path');
const ai = require('./ai');
const engine = require('./websiteEngine');
const { captureDesignScreenshots, shotsMeta } = require('./designCapture');

/** Shared vocabulary for agent triggers, brief meta, and email inbound. */
const REQUEST_KINDS = ['redesign', 'improvements'];

const REVIEW_SYSTEM = `You are a senior website design reviewer for Website Scout (static freeform HTML sites for local businesses).

You may receive:
- Automated QA checks and HTML heuristics
- Screenshots of the rendered site (mobile and desktop)

Return ONLY JSON with TWO separate instruction buckets (do not conflate them):
{
  "summary": "1-3 sentences overall verdict grounded in what you see",
  "issues": ["specific visual or content issue 1", "..."],
  "redesign_instructions": "FULL rethink pass for the design agent via design.deliver: visual/IA rebuild, hierarchy, composition, section structure, major layout changes. Reference concrete problems. Reuse verified contact/services. Do not invent testimonials, prices, or addresses. Honor site_shape if given. Prefer page.html + theme.customCss, baseCss:false.",
  "improvement_instructions": "INCREMENTAL polish only — copy tweaks, CTA wording/placement, mobile sizing/spacing, imagery swaps, contrast/accessibility nits. Do NOT ask for a full visual/IA rethink here. Same fact/reuse rules as above."
}

Be specific and actionable. Put big structural/visual rethinks in redesign_instructions only. Put small polish in improvement_instructions only. Do not claim SEO rankings. If screenshots are present, prioritize what you see in them over guessing from HTML alone.`;

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function normalizeRequestKind(kind) {
  const k = String(kind || '').trim().toLowerCase();
  if (k === 'improve' || k === 'improvement' || k === 'improvements') return 'improvements';
  if (k === 'redesign') return 'redesign';
  return null;
}

function stripCodeFences(text) {
  const s = String(text || '').trim();
  const m = s.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  return m ? m[1].trim() : s;
}

function heuristicIssues(html, pages, checks) {
  const issues = [];
  for (const c of checks || []) {
    if (!c.pass) issues.push(`[QA:${c.name}] ${c.detail || 'failed'}`);
  }
  const text = String(html || '').replace(/<[^>]+>/g, ' ');
  if ((pages || []).length === 1 && text.length < 800) {
    issues.push('Landing content looks thin — expand services, areas, and contact with researched copy.');
  }
  if (!/tel:/i.test(html || '')) {
    issues.push('No clickable tel: link found — primary CTA should call the verified phone.');
  }
  if (!/<h1[\s>]/i.test(html || '')) {
    issues.push('Missing H1 — add a clear primary heading for SEO and accessibility.');
  }
  if (!/<main[\s>]/i.test(html || '') && !/role=["']main["']/i.test(html || '')) {
    issues.push('No <main> landmark — wrap primary content for accessibility.');
  }
  if (/lorem ipsum|TODO|FIXME|\[insert/i.test(text)) {
    issues.push('Placeholder copy still present.');
  }
  return issues;
}

function fallbackRedesignInstructions({ siteShape, issues, summary, hadShots }) {
  const shape = siteShape === 'landing'
    ? 'Keep site_shape landing: one scrollable page with clear sections.'
    : 'Keep site_shape multipage: deliver the full recommended IA, not a stub.';
  const bullets = (issues || []).slice(0, 12).map((i) => `- ${i}`).join('\n');
  return [
    'REDESIGN PASS — fuller visual/IA rethink. Revise the current delivery and submit with design.deliver.',
    summary || 'Rethink hierarchy, composition, and local-business conversion layout.',
    shape,
    hadShots
      ? 'Visual screenshots were captured (mobile + desktop) — address layout, spacing, CTA prominence, and mobile readability as part of a broader redesign.'
      : 'No screenshots available (run Review from the desktop app for visual capture).',
    'Reuse verified phone/email/address/services from the brief. Do not invent testimonials, prices, licenses, or claims.',
    'Prefer freeform page.html + theme.customCss with baseCss:false. Fix the issues below with a real redesign (not only polish):',
    bullets || '- Strengthen hero, services, contact CTA, and overall visual system.',
  ].join('\n');
}

function fallbackImprovementInstructions({ siteShape, issues, summary, hadShots }) {
  const shape = siteShape === 'landing'
    ? 'Keep site_shape landing — do not expand into a multi-page IA.'
    : 'Keep site_shape multipage — do not collapse the IA to a single stub page.';
  const polishIssues = (issues || []).filter((i) => {
    const s = String(i || '').toLowerCase();
    return /cta|copy|mobile|image|photo|contrast|spacing|button|heading|tel:|placeholder|h1|main|thin/.test(s)
      || s.startsWith('[qa:');
  }).slice(0, 10);
  const bullets = (polishIssues.length ? polishIssues : (issues || []).slice(0, 8))
    .map((i) => `- ${i}`).join('\n');
  return [
    'IMPROVEMENTS PASS — incremental polish only. Do not rebuild the whole visual system or IA.',
    summary || 'Tighten copy, CTAs, mobile sizing, and imagery.',
    shape,
    hadShots
      ? 'Screenshots were captured — prefer small, visible fixes (type size, CTA, crop, spacing) over a full redesign.'
      : 'No screenshots available (run Review from the desktop app for visual capture).',
    'Reuse verified phone/email/address/services. Do not invent testimonials, prices, licenses, or claims.',
    'Prefer page.html + theme.customCss with baseCss:false. Apply only the polish items below:',
    bullets || '- Sharpen CTA copy, fix mobile overflow/sizing, and refresh weak imagery.',
  ].join('\n');
}

function buildVisionUserContent({ textBlock, shots }) {
  const parts = [{ type: 'text', text: textBlock }];
  const usable = (shots || []).filter((s) => s.dataUrl).slice(0, 6);
  for (const s of usable) {
    parts.push({
      type: 'text',
      text: `Screenshot: page="${s.page}" viewport=${s.viewport} (${s.width}x${s.height})`,
    });
    parts.push({
      type: 'image_url',
      image_url: { url: s.dataUrl, detail: 'low' },
    });
  }
  return parts;
}

/**
 * Review a design job's website delivery.
 * @returns {Promise<object>} review report
 */
async function reviewDesignJob(db, jobId, opts = {}) {
  const design = require('./designJobs');
  design.ensureTables(db);
  const job = design.getJob(db, jobId);
  if (!job) throw fail('JOB_NOT_FOUND', `Design job #${jobId} not found.`);
  if (job.type !== 'website') throw fail('NOT_A_WEBSITE', 'Review applies to website jobs.');
  const payload = job.deliverable;
  if (!payload || !Array.isArray(payload.pages) || !payload.pages.length) {
    throw fail('NO_DELIVERY', 'Deliver a website before reviewing.');
  }

  const websiteId = job.website_id;
  let qa = { pass: true, checks: [] };
  if (websiteId) {
    try {
      qa = await engine.qaSite(db, websiteId);
    } catch (e) {
      qa = {
        pass: false,
        checks: [{ name: 'qa-run', pass: false, detail: e.message || String(e) }],
      };
    }
  }

  let html = '';
  try {
    html = engine.renderSite(payload.pages, payload.theme || {});
  } catch (e) {
    html = (payload.pages || []).map((p) => p.html || '').join('\n');
  }

  const issues = heuristicIssues(html, payload.pages, qa.checks);
  const siteShape = job.site_shape || (payload.pages.length > 1 ? 'multipage' : 'landing');

  // Screenshots (Electron desktop app only)
  let capture = { available: false, shots: [], reason: 'skipped' };
  if (opts.skipScreenshots !== true) {
    try {
      capture = await captureDesignScreenshots(
        payload.pages,
        payload.theme || {},
        jobId,
        { maxPages: opts.maxPages }
      );
      if (!capture.available && capture.reason) {
        issues.push(`[screenshots] ${capture.reason}`);
      }
    } catch (e) {
      capture = { available: false, shots: [], reason: e.message || String(e) };
      issues.push(`[screenshots] ${capture.reason}`);
    }
  }

  let summary = qa.pass
    ? 'Automated QA passed; still room for design polish.'
    : 'Automated QA found problems that should be fixed.';
  const fallbackArgs = {
    siteShape,
    issues,
    summary,
    hadShots: capture.available,
  };
  let redesign_instructions = fallbackRedesignInstructions(fallbackArgs);
  let improvement_instructions = fallbackImprovementInstructions(fallbackArgs);
  let aiUsed = false;
  let visionUsed = false;

  ai.setDb(db);
  if (opts.skipAi !== true && ai.aiConfigured()) {
    try {
      const brief = job.brief || {};
      const facts = (brief.verified_facts || []).slice(0, 40)
        .map((f) => `${f.fact_key}=${f.value}`)
        .join('\n');
      const textBlock = [
        `Job #${job.id} · site_shape=${siteShape} · pages=${payload.pages.length}`,
        `Screenshots: ${capture.available ? `${capture.shots.filter((s) => s.dataUrl).length} captured` : (capture.reason || 'none')}`,
        `QA checks: ${JSON.stringify(qa.checks || []).slice(0, 3500)}`,
        `Heuristic issues: ${JSON.stringify(issues)}`,
        `Verified facts:\n${facts || '(none)'}`,
        `Style guide: ${JSON.stringify(brief.style_guide || {}).slice(0, 800)}`,
        // Strip embedded bitmaps — data:image blobs drown the model and look like "broken OpenAI".
        `Site HTML (truncated):\n${String(html).replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, '[image]').slice(0, 10000)}`,
        '',
        'Produce BOTH redesign_instructions (full rethink) and improvement_instructions (incremental polish). Keep scopes separate.',
      ].join('\n\n');

      const userContent = capture.available
        ? buildVisionUserContent({ textBlock, shots: capture.shots })
        : textBlock;

      visionUsed = capture.available && Array.isArray(userContent);
      const { text } = await ai.chat({
        task: 'qa',
        messages: [
          { role: 'system', content: REVIEW_SYSTEM },
          { role: 'user', content: userContent },
        ],
        maxTokens: 1800,
        leadId: job.lead_id,
        note: `design review job #${job.id}${visionUsed ? ' +vision' : ''}`,
      });
      let parsed = null;
      try { parsed = JSON.parse(stripCodeFences(text)); } catch { /* ignore */ }
      if (parsed && typeof parsed === 'object') {
        aiUsed = true;
        if (parsed.summary) summary = String(parsed.summary).slice(0, 800);
        if (Array.isArray(parsed.issues) && parsed.issues.length) {
          for (const i of parsed.issues) {
            const s = String(i || '').trim();
            if (s && !issues.includes(s)) issues.push(s);
          }
        }
        if (parsed.redesign_instructions) {
          redesign_instructions = String(parsed.redesign_instructions).slice(0, 6000);
        }
        if (parsed.improvement_instructions) {
          improvement_instructions = String(parsed.improvement_instructions).slice(0, 6000);
        } else if (parsed.improvements_instructions) {
          // Tolerate alternate key from models
          improvement_instructions = String(parsed.improvements_instructions).slice(0, 6000);
        }
      }
    } catch (e) {
      issues.push(`AI review skipped: ${e.code || e.message || 'error'}`);
    }
  }

  const screenshots = shotsMeta(capture);
  const review = {
    at: new Date().toISOString(),
    pass: !!qa.pass && !issues.some((i) => !String(i).startsWith('[screenshots]')),
    summary,
    issues: issues.slice(0, 40),
    checks: qa.checks || [],
    redesign_instructions,
    improvement_instructions,
    ai_used: aiUsed,
    vision_used: visionUsed,
    screenshots,
    screenshot_dir: capture.dir || null,
    site_shape: siteShape,
    page_count: payload.pages.length,
  };

  // Persist without base64 payloads
  db.prepare(
    `UPDATE design_jobs SET review = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(JSON.stringify(review), job.id);

  try {
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
      'design',
      `Design job #${job.id} reviewed (${review.pass ? 'pass' : 'needs work'}` +
        `${visionUsed ? ', vision' : ''}, shots=${screenshots.length}).`
    );
  } catch { /* ignore */ }

  // Attach data URLs for immediate UI (not stored)
  review.screenshot_previews = (capture.shots || [])
    .filter((s) => s.dataUrl)
    .slice(0, 6)
    .map((s) => ({
      page: s.page,
      viewport: s.viewport,
      dataUrl: s.dataUrl,
      path: s.path,
    }));

  try {
    require('./designLearning').observeReview(db, job, review);
  } catch { /* learning must not block review */ }

  return review;
}

/**
 * Load PNG data URLs for persisted screenshot paths on a job review.
 */
function loadReviewShotPreviews(review, { max = 6 } = {}) {
  const shots = (review && review.screenshots) || [];
  const out = [];
  for (const s of shots) {
    if (out.length >= max) break;
    if (!s.path || !fs.existsSync(s.path)) continue;
    // Safety: only under review-shots
    const norm = path.normalize(s.path);
    if (!/[\\/]review-shots[\\/]/i.test(norm)) continue;
    try {
      const buf = fs.readFileSync(s.path);
      out.push({
        page: s.page,
        viewport: s.viewport,
        path: s.path,
        dataUrl: `data:image/png;base64,${buf.toString('base64')}`,
      });
    } catch { /* skip */ }
  }
  return out;
}

function instructionHeader(kind) {
  return kind === 'improvements'
    ? '=== IMPROVEMENTS REQUEST ==='
    : '=== REDESIGN REQUEST ===';
}

function pickInstructions(kind, override, review) {
  if (override) return override;
  if (!review) return '';
  if (kind === 'improvements') {
    return String(review.improvement_instructions || '').trim();
  }
  return String(review.redesign_instructions || '').trim();
}

/**
 * Queue a redesign or improvements pass for the MCP agent.
 * @param {object} opts
 * @param {'redesign'|'improvements'} [opts.kind='redesign']
 * @param {string} [opts.instructions] override text for the chosen kind
 */
async function requestAgentChange(db, jobId, opts = {}) {
  const design = require('./designJobs');
  design.ensureTables(db);
  const kind = normalizeRequestKind(opts.kind) || 'redesign';
  const row = db.prepare('SELECT * FROM design_jobs WHERE id = ?').get(jobId);
  if (!row) throw fail('JOB_NOT_FOUND', `Design job #${jobId} not found.`);
  if (row.type !== 'website') throw fail('NOT_A_WEBSITE', `${kind} applies to website jobs.`);
  if (!row.deliverable) throw fail('NO_DELIVERY', `Deliver a website before requesting ${kind}.`);

  let review = null;
  try { review = row.review ? JSON.parse(row.review) : null; } catch { review = null; }

  if (opts.refresh !== false && (!review || opts.forceReview)) {
    review = await reviewDesignJob(db, jobId, {
      skipAi: opts.skipAi,
      skipScreenshots: opts.skipScreenshots,
    });
  }

  const override = opts.instructions != null ? String(opts.instructions).trim() : '';
  const changeText = pickInstructions(kind, override, review);
  if (!changeText) {
    const which = kind === 'improvements' ? 'improvement' : 'redesign';
    throw fail('NO_INSTRUCTIONS', `No ${which} instructions available. Run a review first.`);
  }

  const prior = String(row.instructions || '').trim();
  const shotNote = review && review.screenshots && review.screenshots.length
    ? `\n(Visual review used ${review.screenshots.length} screenshot(s).)`
    : '';
  const scopeNote = kind === 'improvements'
    ? '\nScope: incremental polish only (copy, CTA, mobile sizing, imagery). Do not treat this as a full redesign.'
    : '\nScope: fuller visual/IA rethink. Prior deliverable remains for reference — revise and design.deliver again.';
  const merged = [
    instructionHeader(kind),
    changeText.slice(0, 5000) + shotNote + scopeNote,
    '',
    '=== ORIGINAL INSTRUCTIONS (context) ===',
    prior.slice(0, 2500),
  ].join('\n').slice(0, 8000);

  const siteShape = design.normalizeSiteShape(row.site_shape)
    || (row.site_shape === 'landing' || row.site_shape === 'multipage' ? row.site_shape : null);

  const brief = design.buildBrief(db, row.lead_id, merged, row.type, siteShape || undefined);
  brief.instruction = merged;
  brief.request_kind = kind;
  brief.review = review
    ? { ...review, screenshot_previews: undefined }
    : null;
  try {
    require('./designLearning').attachLessonsToBrief(db, brief, {
      jobType: row.type,
      siteShape: siteShape || undefined,
    });
  } catch { /* learning optional */ }
  const changeMeta = {
    at: new Date().toISOString(),
    kind,
    from_status: row.status,
    note: kind === 'improvements'
      ? 'Prior deliverable is still on the job — apply incremental polish and design.deliver again.'
      : 'Prior deliverable is still on the job — revise (fuller rethink) and design.deliver again.',
  };
  // Keep brief.redesign for existing redesign callers; use brief.improvements for polish.
  if (kind === 'improvements') {
    brief.improvements = changeMeta;
  } else {
    brief.redesign = changeMeta;
  }
  brief.change_request = changeMeta;

  const reviewStore = review
    ? JSON.stringify({ ...review, screenshot_previews: undefined })
    : row.review;

  db.prepare(
    `UPDATE design_jobs
     SET instructions = ?, brief = ?, review = ?, request_kind = ?, status = 'waiting_on_agent',
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(merged, JSON.stringify(brief), reviewStore, kind, jobId);

  const label = kind === 'improvements' ? 'improvements' : 'redesign';
  try {
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
      'design',
      `Design job #${jobId} ${label} sent to agent queue.`
    );
  } catch { /* ignore */ }

  design.notifyAgentQueue(db,
    `Design job #${jobId} ${label} queued (waiting_on_agent). MCP: design.next or design.pending.`,
    { jobId, reason: kind, status: 'waiting_on_agent', request_kind: kind }
  );

  try {
    require('./designLearning').observeChangeRequest(db, jobId, kind, changeText, review);
  } catch { /* learning must not block queue */ }

  return design.getJob(db, jobId);
}

/** Queue a full redesign (visual/IA rethink). */
async function requestRedesign(db, jobId, opts = {}) {
  return requestAgentChange(db, jobId, { ...opts, kind: 'redesign' });
}

/** Queue incremental improvements (polish/fixes only). */
async function requestImprovements(db, jobId, opts = {}) {
  return requestAgentChange(db, jobId, { ...opts, kind: 'improvements' });
}

module.exports = {
  REQUEST_KINDS,
  normalizeRequestKind,
  reviewDesignJob,
  requestAgentChange,
  requestRedesign,
  requestImprovements,
  loadReviewShotPreviews,
  heuristicIssues,
  fallbackRedesignInstructions,
  fallbackImprovementInstructions,
};
