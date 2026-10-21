'use strict';

/**
 * Instruction-review layer for client website change requests.
 *
 * Flow: INSPECT site → CLASSIFY (SAFE | BETTER_PATH | PUSH_BACK) → plan +
 * client message → persist log on brief → agent applies → VERIFY whole site.
 *
 * Never silently comply with harmful asks; never silently refuse. Client gets
 * the change, a better version, or a short explanation + alternative.
 */

const CLASSIFICATIONS = Object.freeze({
  SAFE: 'SAFE',
  BETTER_PATH: 'BETTER_PATH',
  PUSH_BACK: 'PUSH_BACK',
});

function normalizeLabel(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeRouteSafe(hrefOrSlug) {
  try {
    const eng = require('./websiteEngine');
    if (typeof eng.normalizeRoute === 'function') return eng.normalizeRoute(hrefOrSlug);
  } catch { /* */ }
  let s = String(hrefOrSlug == null ? '' : hrefOrSlug).trim().toLowerCase();
  if (!s || s === '/' || s === '#') return 'index';
  s = s.replace(/^#/, '').split('?')[0].split('#')[0];
  s = s.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.html?$/i, '');
  if (!s || s === 'home' || s === 'index') return 'index';
  return s;
}

function extractNavFromHtml(html) {
  const links = [];
  const navBlocks = String(html || '').match(/<nav\b[\s\S]*?<\/nav>/gi) || [];
  const scan = navBlocks.length ? navBlocks.join('\n') : String(html || '');
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(scan))) {
    const attrs = m[1] || '';
    const hrefM = attrs.match(/\bhref\s*=\s*["']([^"']*)["']/i);
    const href = hrefM ? hrefM[1] : '';
    const label = String(m[2] || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!label && !href) continue;
    links.push({
      label,
      href,
      route: normalizeRouteSafe(href || label),
      labelKey: normalizeLabel(label),
    });
  }
  return links;
}

function pageSectionSummary(page) {
  const sections = Array.isArray(page && page.sections) ? page.sections : [];
  return sections.map((s, i) => ({
    index: i,
    type: String((s && s.type) || ''),
    className: (s && s.className) || null,
    hasFormSlot: !!(s && s.content && (
      s.content.formId
      || s.content.formToken
      || /bitpype-form|data-bitpype-form/i.test(JSON.stringify(s.content || {}))
    )),
    moduleType: (s && s.content && (s.content.moduleType || s.content.module)) || null,
  }));
}

/**
 * Build a live site snapshot used for classification.
 * Includes structure, normalized nav, modules (what injects Book Now etc.), forms.
 */
function buildSiteSnapshot(db, leadId) {
  const lid = Number(leadId);
  const snapshot = {
    leadId: lid || null,
    websiteId: null,
    pages: [],
    nav: [],
    navLabels: [],
    navRoutes: [],
    modules: [],
    moduleTypes: [],
    forms: [],
    formPages: [],
    hasBookings: false,
    hasContactForm: false,
    hasNativeFormEmbed: false,
    hasHandRolledForm: false,
    ctaLabels: [],
  };

  if (!lid) return snapshot;

  let site = null;
  try {
    site = db.prepare(
      'SELECT id, pages, theme, name FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
    ).get(lid);
  } catch { site = null; }

  if (site) {
    snapshot.websiteId = site.id;
    snapshot.name = site.name || '';
    let pages = [];
    try { pages = JSON.parse(site.pages || '[]'); } catch { pages = []; }
    if (!Array.isArray(pages)) pages = [];

    const allNav = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i] || {};
      const slug = String(p.slug || (i === 0 ? 'home' : `page-${i}`));
      const title = String(p.title || slug);
      const sections = pageSectionSummary(p);
      const sectionTypes = sections.map((s) => s.type);
      const htmlBits = [];
      if (typeof p.html === 'string') htmlBits.push(p.html);
      for (const s of (p.sections || [])) {
        if (s && s.content && typeof s.content.html === 'string') htmlBits.push(s.content.html);
      }
      const pageHtml = htmlBits.join('\n');
      const navLinks = extractNavFromHtml(pageHtml);
      // Also pull structured nav links when available
      try {
        const structure = require('./siteStructure');
        if (typeof structure.buildNavLinks === 'function' && i === 0) {
          const built = structure.buildNavLinks(pages, { preview: false }) || [];
          for (const l of built) {
            allNav.push({
              label: l.label,
              href: l.href,
              route: normalizeRouteSafe(l.slug || l.href),
              labelKey: normalizeLabel(l.label),
              source: 'structure',
            });
          }
        }
      } catch { /* */ }
      for (const l of navLinks) allNav.push({ ...l, source: 'html', page: slug });

      const hasForm = sectionTypes.includes('contact_form')
        || sectionTypes.includes('bitpype_form')
        || sectionTypes.includes('form')
        || /data-bitpype-form|bitpype-form-embed|<form\b/i.test(pageHtml);
      const hasHandForm = /<form\b/i.test(pageHtml)
        && !/data-bitpype-form\s*=/i.test(pageHtml);

      if (hasForm) snapshot.formPages.push(slug);
      if (sectionTypes.includes('contact_form') || /data-bitpype-form/i.test(pageHtml)) {
        snapshot.hasContactForm = true;
      }
      if (/data-bitpype-form-embed|bitpype-form-embed/i.test(pageHtml)
        || sectionTypes.includes('bitpype_form')
        || sectionTypes.includes('form')) {
        snapshot.hasNativeFormEmbed = true;
      }
      if (hasHandForm) snapshot.hasHandRolledForm = true;

      snapshot.pages.push({
        slug,
        title,
        route: normalizeRouteSafe(slug),
        sectionTypes,
        sections,
        hasForm,
        navLinkCount: navLinks.length,
      });
    }

    // Dedupe nav by route+label
    const seen = new Set();
    for (const l of allNav) {
      const key = `${l.route}::${l.labelKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      snapshot.nav.push(l);
    }
    snapshot.navLabels = [...new Set(snapshot.nav.map((n) => n.labelKey).filter(Boolean))];
    snapshot.navRoutes = [...new Set(snapshot.nav.map((n) => n.route).filter(Boolean))];
    snapshot.ctaLabels = snapshot.nav
      .filter((n) => /book|appoint|reserve|schedule|get.?quote|contact|call/i.test(n.labelKey))
      .map((n) => n.label);
  }

  try {
    const modules = require('../server/siteModules');
    const embeds = typeof modules.listEmbeds === 'function'
      ? modules.listEmbeds(db, lid)
      : [];
    snapshot.modules = (embeds || []).map((e) => {
      const published = !!Number(e.published);
      const embedOn = e.embed_enabled == null || e.embed_enabled === ''
        ? true
        : Number(e.embed_enabled) !== 0;
      const active = published && !!e.public_token && embedOn;
      return {
        type: e.module_type || e.type,
        active,
        published,
        slug: e.target_page_slug || (modules.MODULE_META && modules.MODULE_META[e.module_type]
          ? modules.MODULE_META[e.module_type].defaultSlug
          : null),
        title: e.title || (modules.MODULE_META && modules.MODULE_META[e.module_type]
          ? modules.MODULE_META[e.module_type].defaultTitle
          : e.module_type),
      };
    });
    snapshot.moduleTypes = snapshot.modules
      .filter((m) => m.active)
      .map((m) => m.type)
      .filter(Boolean);
    snapshot.hasBookings = snapshot.moduleTypes.includes('bookings');
  } catch { /* modules optional */ }

  try {
    const forms = require('../server/contactForms');
    if (typeof forms.listFormsForLead === 'function') {
      const list = forms.listFormsForLead(db, lid) || [];
      snapshot.forms = list.map((f) => ({
        id: f.id,
        name: f.name,
        slug: f.target_page_slug || f.embed_on_page || null,
        purpose: f.purpose || f.kind || null,
      }));
      if (snapshot.forms.length) {
        snapshot.hasContactForm = true;
        snapshot.hasNativeFormEmbed = true;
      }
    }
  } catch { /* forms optional */ }

  return snapshot;
}

function messageAsks(text) {
  const t = String(text || '').toLowerCase();
  return {
    bookNow: /\b(book\s*now|book\s*(an?\s*)?(appointment|online)|add\s*(a\s*)?(book|booking)\b|booking\s*button|schedule\s*(a\s*)?(visit|appointment))\b/i.test(t),
    secondBook: /\b(second|another|duplicate|extra|second\s*book)\b/i.test(t) && /\bbook\b/i.test(t),
    customForm: /\b(custom\s*form|html\s*form|hand[- ]?(built|rolled|made)\s*form|build\s*(a\s*)?form|add\s*(a\s*)?form|contact\s*form|quote\s*form)\b/i.test(t),
    handForm: /\b(raw\s*<form|hand[- ]?(built|rolled)|html\s*form|iframe\s*form|google\s*form|typeform)\b/i.test(t),
    bookingsAndForm: /\b(bookings?|book\s*now|appointment)\b/i.test(t) && /\b(form|contact\s*form|quote)\b/i.test(t)
      && /\b(and|also|both|plus|as\s*well)\b/i.test(t),
    duplicateNav: /\b(duplicate|second|another|extra)\b/i.test(t)
      && /\b(nav|menu|link|button|cta|book\s*now|home)\b/i.test(t),
    inventFacts: /\b(fake|invent|make\s*up|add\s*(fake\s*)?(reviews?|testimonials?|ratings?))\b/i.test(t),
    removeContact: /\b(remove|delete|drop)\b/i.test(t) && /\b(contact|phone|form|booking)\b/i.test(t)
      && !/\b(spam|old|unused|duplicate)\b/i.test(t),
    restyleOnly: /\b(restyle|recolor|recolour|tweak|polish|copy|wording|font|spacing|mobile|cta\s*text|button\s*color)\b/i.test(t)
      && !/\b(add\s+(a\s+)?(new\s+)?(page|form|button|module|nav)|duplicate)\b/i.test(t),
  };
}

function findMatchingNav(snapshot, patterns) {
  const labels = snapshot.navLabels || [];
  return labels.filter((l) => patterns.some((re) => re.test(l)));
}

/**
 * Classify a change request against a site snapshot.
 * @returns {{ classification, plan, clientMessage, reasons, conflicts }}
 */
function classifyChangeRequest(message, snapshot = {}) {
  const asks = messageAsks(message);
  const reasons = [];
  const conflicts = [];
  const plan = [];
  let classification = CLASSIFICATIONS.SAFE;
  let clientMessage = '';

  const bookLabels = findMatchingNav(snapshot, [/book/, /appoint/, /reserve/, /schedule/]);
  const hasBookCta = bookLabels.length > 0 || snapshot.hasBookings;
  const hasForm = snapshot.hasContactForm || snapshot.hasNativeFormEmbed
    || (snapshot.forms && snapshot.forms.length > 0)
    || (snapshot.formPages && snapshot.formPages.length > 0);

  // PUSH_BACK: invent facts / remove only contact path
  if (asks.inventFacts) {
    classification = CLASSIFICATIONS.PUSH_BACK;
    reasons.push('Request asks for invented reviews/testimonials/facts.');
    conflicts.push('unverified_claims');
    plan.push('Refuse fabricated trust signals; offer real verified facts or soft AI_COPY without fake reviews.');
    clientMessage = 'We can’t add fake reviews or invented business facts. We can highlight verified details you already have, or soft marketing copy that doesn’t claim fake results.';
  }

  if (asks.removeContact && hasForm && !asks.duplicateNav && classification !== CLASSIFICATIONS.PUSH_BACK) {
    // Soft push-back only when they wipe the only lead path with no replacement
    if (!asks.bookNow && !asks.customForm) {
      classification = CLASSIFICATIONS.PUSH_BACK;
      reasons.push('Removing the only contact/booking path without a replacement.');
      conflicts.push('remove_contact_path');
      plan.push('Keep at least one working contact or booking path; offer to restyle or relocate it instead.');
      clientMessage = 'Your site needs at least one way for visitors to reach you. We can restyle or move the contact/booking block, but we shouldn’t remove it without a replacement.';
    }
  }

  // BETTER_PATH: duplicate Book Now when module/nav already has one
  if ((asks.bookNow || asks.secondBook || asks.duplicateNav) && hasBookCta
    && classification === CLASSIFICATIONS.SAFE) {
    classification = CLASSIFICATIONS.BETTER_PATH;
    reasons.push(snapshot.hasBookings
      ? 'Bookings module already injects a Book/appointment nav CTA — do not add a second one.'
      : `Nav already has booking CTA(s): ${bookLabels.join(', ') || 'book'}.`);
    conflicts.push('duplicate_book_cta');
    plan.push('Reuse/restyle the existing Book Now / bookings nav link and module page — ship exactly one.');
    plan.push('Do not add a second Book Now button or duplicate nav label.');
    clientMessage = snapshot.hasBookings
      ? 'Your Bookings module already adds a Book link in the menu. We’ll restyle that single CTA so it matches your request — no second Book Now button.'
      : 'A booking CTA is already in your navigation. We’ll update that one button instead of adding a duplicate.';
  }

  // BETTER_PATH: hand-built / custom form when native exists
  if ((asks.customForm || asks.handForm) && hasForm && classification === CLASSIFICATIONS.SAFE) {
    classification = CLASSIFICATIONS.BETTER_PATH;
    reasons.push('Native BitPype form/contact_form already on site — never hand-roll a second form.');
    conflicts.push('duplicate_form');
    plan.push('Reuse or restyle the existing native form / form slot; do not add raw <form> or a second embed.');
    plan.push('If they need different fields, update the existing form fields — keep one functional form per page.');
    clientMessage = 'Your site already has a working contact form. We’ll adjust that form (fields/styling/placement) instead of adding a second hand-built one.';
  }

  // BETTER_PATH / PUSH_BACK: custom form AND bookings for the same job
  if (asks.bookingsAndForm || (asks.bookNow && asks.customForm)) {
    if (snapshot.hasBookings && hasForm) {
      if (classification === CLASSIFICATIONS.SAFE) classification = CLASSIFICATIONS.BETTER_PATH;
      reasons.push('Site already has both bookings and a form — pick one coherent lead path for this ask.');
      conflicts.push('form_and_bookings_overlap');
      plan.push('Keep bookings as the appointment path; use the existing form only for general contact/quote — do not add another form or Book CTA.');
      if (!clientMessage) {
        clientMessage = 'You already have Bookings for appointments and a contact form for messages. We’ll improve those existing pieces so each has one clear job — not add overlapping widgets.';
      }
    } else if (asks.bookingsAndForm && !snapshot.hasBookings) {
      if (classification === CLASSIFICATIONS.SAFE) classification = CLASSIFICATIONS.BETTER_PATH;
      reasons.push('Client asked for custom form AND bookings for the same job — choose one primary path.');
      conflicts.push('form_and_bookings_same_job');
      plan.push('Prefer attach bookings module for scheduling; keep a single native contact/quote form for messages — never hand-roll both as duplicate CTAs.');
      clientMessage = 'For scheduling we’ll use the Bookings module (one Book CTA). For general messages we’ll keep a single native contact form — not two overlapping systems for the same job.';
    }
  }

  // Hand-rolled form ask when native exists → escalate to PUSH_BACK if they insist on raw HTML
  if (asks.handForm && hasForm && classification !== CLASSIFICATIONS.PUSH_BACK) {
    classification = CLASSIFICATIONS.BETTER_PATH;
    if (!conflicts.includes('duplicate_form')) conflicts.push('hand_rolled_form');
    plan.push('Reject raw/iframe/Google Form embeds; use BitPype forms.create / contact_form / bitpype_form only.');
  }

  // Duplicate nav label that already exists
  const msgLabels = String(message || '').match(/\b(?:add|put|include)\s+(?:a\s+)?["']?([A-Za-z][A-Za-z0-9 &-]{1,40})["']?\s+(?:link|button|cta|to\s+(?:the\s+)?(?:nav|menu))/i);
  if (msgLabels && classification === CLASSIFICATIONS.SAFE) {
    const want = normalizeLabel(msgLabels[1]);
    if (want && (snapshot.navLabels || []).includes(want)) {
      classification = CLASSIFICATIONS.BETTER_PATH;
      reasons.push(`Nav label "${want}" already exists — reuse/restyle, do not duplicate.`);
      conflicts.push('duplicate_nav_label');
      plan.push(`Restyle or retarget the existing "${msgLabels[1]}" nav item; do not add a second identical label.`);
      clientMessage = `"${msgLabels[1]}" is already in your menu. We’ll update that link instead of adding another one.`;
    }
  }

  if (classification === CLASSIFICATIONS.SAFE) {
    if (asks.restyleOnly) {
      reasons.push('Request looks like polish/copy/style with no structural conflict.');
      plan.push('Apply the requested polish against the live site; do not invent new nav/forms/modules.');
    } else {
      reasons.push('No conflict with existing nav, modules, or forms detected from snapshot.');
      plan.push('Inspect live pages/modules/forms first, then apply the request as stated.');
      plan.push('If an equivalent element already exists at apply-time, reuse/restyle instead of duplicating.');
    }
    clientMessage = 'We’ll make these updates on your current site.';
  }

  if (!plan.length) {
    plan.push('Inspect site snapshot, then apply the safest coherent change.');
  }

  return {
    classification,
    plan,
    clientMessage: clientMessage || 'We’ll make these updates on your current site.',
    reasons,
    conflicts,
    asks,
  };
}

/**
 * Full review: snapshot + classify + structured log for persistence / agent instructions.
 */
function reviewChangeRequest(db, {
  leadId = null,
  message = '',
  kind = 'improvements',
  source = 'unknown',
  jobId = null,
} = {}) {
  const asked = String(message || '').trim();
  const snapshot = buildSiteSnapshot(db, leadId);
  const classified = classifyChangeRequest(asked, snapshot);
  const at = new Date().toISOString();

  const log = {
    at,
    jobId: jobId != null ? Number(jobId) : null,
    leadId: leadId != null ? Number(leadId) : null,
    source,
    kind: kind === 'redesign' ? 'redesign' : 'improvements',
    asked: asked.slice(0, 4000),
    classification: classified.classification,
    done: classified.plan.slice(),
    why: classified.reasons.slice(),
    conflicts: classified.conflicts.slice(),
    clientMessage: classified.clientMessage,
    snapshotSummary: {
      websiteId: snapshot.websiteId,
      pages: (snapshot.pages || []).map((p) => p.slug),
      navLabels: snapshot.navLabels,
      moduleTypes: snapshot.moduleTypes,
      formCount: (snapshot.forms || []).length,
      formPages: snapshot.formPages,
      hasBookings: snapshot.hasBookings,
      hasContactForm: snapshot.hasContactForm,
    },
  };

  return {
    classification: classified.classification,
    plan: classified.plan,
    clientMessage: classified.clientMessage,
    log,
    snapshot,
    reasons: classified.reasons,
    conflicts: classified.conflicts,
  };
}

/**
 * Block injected into agent instructions so the developer-agent follows the review.
 */
function formatReviewForInstructions(review) {
  if (!review || !review.classification) return '';
  const lines = [
    '=== CHANGE REQUEST REVIEW (mandatory) ===',
    `Classification: ${review.classification}`,
    'INSPECT FIRST: load current pages, sections, nav, modules, and forms (including what modules inject). Decide from the live site, not the request alone.',
    'DEDUPE: if an element already exists, reuse/restyle — never ship a duplicate nav CTA or second form.',
  ];
  if (review.plan && review.plan.length) {
    lines.push('Plan:');
    for (const step of review.plan) lines.push(`- ${step}`);
  }
  if (review.reasons && review.reasons.length) {
    lines.push(`Why: ${review.reasons.join(' ')}`);
  }
  if (review.clientMessage) {
    lines.push(`Client-facing note: ${review.clientMessage}`);
  }
  lines.push('After changes: run website.qa (and nav/form checks). Include whole-site verification in the change summary.');
  lines.push('Log decision: asked → classification → done → why (already on brief.change_request_review).');
  return lines.join('\n');
}

function attachReviewToBrief(brief, review) {
  const b = brief && typeof brief === 'object' ? brief : {};
  if (!review) return b;
  b.change_request_review = {
    classification: review.classification,
    plan: review.plan,
    clientMessage: review.clientMessage,
    log: review.log,
    at: (review.log && review.log.at) || new Date().toISOString(),
  };
  if (review.clientMessage) {
    b.client_facing_message = review.clientMessage;
  }
  return b;
}

/**
 * Post-change whole-site verification (website.qa + nav/form duplicate checks).
 */
async function verifyAfterChange(db, websiteId, { skipAi = true } = {}) {
  const id = Number(websiteId);
  const result = {
    ok: false,
    websiteId: id || null,
    qa: null,
    navForm: null,
    summary: '',
  };
  if (!id) {
    result.summary = 'No website id — verification skipped.';
    return result;
  }

  let qa = null;
  try {
    const engine = require('./websiteEngine');
    // qaSite may call AI; prefer heuristic path — still full structural checks
    qa = await engine.qaSite(db, id);
    if (skipAi && qa && Array.isArray(qa.checks)) {
      qa = {
        ...qa,
        checks: qa.checks.filter((c) => c && c.name !== 'ai-qa'),
      };
      qa.pass = qa.checks.every((c) => c.pass);
    }
  } catch (e) {
    result.summary = `QA failed: ${e.message || e}`;
    result.qa = { pass: false, error: String(e.message || e) };
    return result;
  }
  result.qa = {
    pass: !!qa.pass,
    checks: (qa.checks || []).map((c) => ({
      name: c.name,
      pass: !!c.pass,
      detail: String(c.detail || '').slice(0, 240),
    })),
  };

  // Extra nav/form duplicate scan on rendered output
  const navForm = { pass: true, issues: [] };
  try {
    const site = db.prepare('SELECT pages, theme, lead_id FROM websites WHERE id = ?').get(id);
    let pages = [];
    let theme = {};
    try { pages = JSON.parse(site.pages || '[]'); } catch { pages = []; }
    try { theme = JSON.parse(site.theme || '{}'); } catch { theme = {}; }
    const eng = require('./websiteEngine');
    const labelCounts = new Map();
    for (const p of pages) {
      let html = '';
      try { html = eng.renderPage(p, pages, theme) || ''; } catch { html = ''; }
      const navs = html.match(/<nav\b[\s\S]*?<\/nav>/gi) || [];
      for (const nav of navs) {
        const anchors = [...nav.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)];
        const seenRoute = new Set();
        for (const a of anchors) {
          const label = normalizeLabel(String(a[1] || '').replace(/<[^>]+>/g, ' '));
          if (!label) continue;
          labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
          const hrefM = String(a[0]).match(/\bhref\s*=\s*["']([^"']*)["']/i);
          const route = normalizeRouteSafe(hrefM ? hrefM[1] : '');
          if (route && seenRoute.has(route) && !/brand|logo/.test(label)) {
            navForm.issues.push(`Duplicate nav route "${route}" on page ${p.slug || '?'}`);
          }
          if (route) seenRoute.add(route);
        }
      }
      const forms = (html.match(/<form\b/gi) || []).length
        + (html.match(/data-bitpype-form-embed/gi) || []).length;
      if (forms > 1) {
        navForm.issues.push(`Page ${p.slug || '?'}: ${forms} forms/embeds (max 1)`);
      }
    }
    for (const [label, n] of labelCounts) {
      // Count across pages is expected for shared nav; flag only heavy duplicates of CTA labels in one scan budget
      if (n > pages.length && /book|appoint|quote|contact us/.test(label)) {
        navForm.issues.push(`CTA label "${label}" appears ${n} times across rendered navs (possible duplicates per page)`);
      }
    }
    // Per-page: same label more than once in a single nav is caught via route dupes;
    // also scan first page nav for repeated identical labels
    if (pages[0]) {
      let html0 = '';
      try { html0 = eng.renderPage(pages[0], pages, theme) || ''; } catch { html0 = ''; }
      const nav0 = (html0.match(/<nav\b[\s\S]*?<\/nav>/i) || [''])[0];
      const labels0 = [...nav0.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
        .map((a) => normalizeLabel(String(a[1] || '').replace(/<[^>]+>/g, ' ')))
        .filter(Boolean);
      const freq = new Map();
      for (const l of labels0) freq.set(l, (freq.get(l) || 0) + 1);
      for (const [l, n] of freq) {
        if (n > 1) navForm.issues.push(`Home nav has ${n}× "${l}"`);
      }
    }
    navForm.pass = navForm.issues.length === 0;

    // Module-aware: bookings present → at most one book-like nav label on home
    try {
      const snap = buildSiteSnapshot(db, site.lead_id);
      if (snap.hasBookings && pages[0]) {
        const homeHtml = html0For(eng, pages, theme);
        const bookHits = labels0BookCount(homeHtml);
        if (bookHits > 1) {
          navForm.issues.push(`Bookings module active but ${bookHits} Book-like nav CTAs on home (want 1)`);
          navForm.pass = false;
        }
      }
    } catch { /* */ }
  } catch (e) {
    navForm.pass = false;
    navForm.issues.push(String(e.message || e));
  }
  result.navForm = navForm;

  result.ok = !!(result.qa.pass && navForm.pass);
  const failed = (result.qa.checks || []).filter((c) => !c.pass).map((c) => c.name);
  result.summary = [
    `Whole-site verification: ${result.ok ? 'PASS' : 'FAIL'}`,
    `QA: ${result.qa.pass ? 'pass' : `fail (${failed.slice(0, 6).join(', ') || 'checks'})`}`,
    `Nav/form: ${navForm.pass ? 'pass' : navForm.issues.slice(0, 4).join('; ')}`,
  ].join(' · ');
  return result;
}

function html0For(eng, pages, theme) {
  try { return eng.renderPage(pages[0], pages, theme) || ''; } catch { return ''; }
}

function labels0BookCount(html) {
  const nav0 = (String(html || '').match(/<nav\b[\s\S]*?<\/nav>/i) || [''])[0];
  const labels = [...nav0.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((a) => normalizeLabel(String(a[1] || '').replace(/<[^>]+>/g, ' ')));
  return labels.filter((l) => /\bbook\b|\bappoint/.test(l)).length;
}

/**
 * Persist review onto design_jobs.brief (and optional email-redesign notes JSON).
 */
function persistReviewOnJob(db, jobId, review) {
  if (!jobId || !review) return null;
  const row = db.prepare('SELECT brief FROM design_jobs WHERE id = ?').get(Number(jobId));
  if (!row) return null;
  let brief = {};
  try { brief = row.brief ? JSON.parse(row.brief) : {}; } catch { brief = {}; }
  brief = attachReviewToBrief(brief, review);
  db.prepare(
    `UPDATE design_jobs SET brief = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(JSON.stringify(brief), Number(jobId));
  return brief.change_request_review;
}

function persistReviewOnEmailRequest(db, requestId, review) {
  if (!requestId || !review) return;
  try {
    const cols = db.prepare('PRAGMA table_info(design_email_redesigns)').all();
    if (!cols.some((c) => c.name === 'review_json')) {
      db.exec('ALTER TABLE design_email_redesigns ADD COLUMN review_json TEXT');
    }
    db.prepare(
      'UPDATE design_email_redesigns SET review_json = ? WHERE id = ?'
    ).run(JSON.stringify({
      classification: review.classification,
      plan: review.plan,
      clientMessage: review.clientMessage,
      log: review.log,
    }), Number(requestId));
  } catch { /* optional column */ }
}

module.exports = {
  CLASSIFICATIONS,
  buildSiteSnapshot,
  classifyChangeRequest,
  reviewChangeRequest,
  formatReviewForInstructions,
  attachReviewToBrief,
  verifyAfterChange,
  persistReviewOnJob,
  persistReviewOnEmailRequest,
  normalizeLabel,
  normalizeRouteSafe,
};
