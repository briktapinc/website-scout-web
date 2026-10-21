'use strict';

/**
 * Module-fit: appointment-intent pages must mount the bookings module with
 * ≥1 published service and weekly hours. Shared by website.qa and MCP
 * addModule / edit / addBlock warnings.
 */

const APPOINTMENT_TOKEN_RE = /\b(book|booking|bookings|reserve|reservation|schedule|scheduling|appointment|appointments)\b/i;
const CALL_TO_BOOK_RE = /\b(call\s+to\s+book|phone\s+to\s+(book|schedule|reserve)|call\s+(us\s+)?to\s+(book|schedule|reserve)|ring\s+to\s+book)\b/i;
const TEL_HREF_RE = /\bhref\s*=\s*["']tel:/i;
const BOOKINGS_MOUNT_RE = /data-bitpype-module-type\s*=\s*["']bookings["']/i;
const FORM_MOUNT_RE = /data-bitpype-form(?:-embed)?\s*=/i;

const APPOINTMENT_FORM_WARNING =
  'Appointment-intent pages need the bookings module (website.addModule module=bookings + bookings.createService status=published + bookings.setHours), not a contact/appointment request form. Use forms.create purpose=appointment_request only for waitlist-style requests when calendar booking is unavailable.';

function normalizeSlug(slug) {
  return String(slug || '')
    .trim()
    .toLowerCase()
    .replace(/^\//, '')
    .replace(/\.html$/i, '')
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function pageTextBlob(page) {
  if (!page || typeof page !== 'object') return '';
  const parts = [
    page.slug,
    page.title,
    page.description,
    typeof page.html === 'string' ? page.html.replace(/<script[\s\S]*?<\/script>/gi, ' ') : '',
  ];
  const walk = (node) => {
    if (!node) return;
    if (typeof node === 'string') {
      parts.push(node.replace(/<script[\s\S]*?<\/script>/gi, ' '));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === 'object') {
      if (node.html) parts.push(String(node.html));
      if (node.text) parts.push(String(node.text));
      if (node.title) parts.push(String(node.title));
      if (node.heading) parts.push(String(node.heading));
      if (node.label) parts.push(String(node.label));
      if (node.content && typeof node.content === 'object') walk(node.content);
      if (Array.isArray(node.sections)) walk(node.sections);
      if (Array.isArray(node.blocks)) walk(node.blocks);
      if (Array.isArray(node.cols)) walk(node.cols);
      if (Array.isArray(node.cells)) walk(node.cells);
      if (node.widget) walk(node.widget);
    }
  };
  walk(page.sections);
  return parts.filter(Boolean).join(' ');
}

function pageHtmlBlob(page) {
  if (!page || typeof page !== 'object') return '';
  const parts = [];
  if (typeof page.html === 'string') parts.push(page.html);
  const walk = (node) => {
    if (!node) return;
    if (typeof node === 'string') {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === 'object') {
      if (typeof node.html === 'string') parts.push(node.html);
      if (node.content && typeof node.content === 'object') walk(node.content);
      if (Array.isArray(node.sections)) walk(node.sections);
      if (Array.isArray(node.blocks)) walk(node.blocks);
      if (Array.isArray(node.cols)) walk(node.cols);
      if (Array.isArray(node.cells)) walk(node.cells);
      if (node.widget) walk(node.widget);
    }
  };
  walk(page.sections);
  return parts.join('\n');
}

function navLabelsForPage(pages, page) {
  const slug = normalizeSlug(page && page.slug);
  const labels = [];
  const all = Array.isArray(pages) ? pages : [];
  for (const p of all) {
    const html = pageHtmlBlob(p);
    const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html))) {
      const href = String(m[1] || '');
      const lab = String(m[2] || '').replace(/<[^>]+>/g, '').trim();
      if (!lab) continue;
      const hrefSlug = normalizeSlug(href.replace(/^#/, '').split(/[?#]/)[0]);
      if (hrefSlug === slug || hrefSlug === `${slug}.html` || href.endsWith(`/${slug}`) || href.endsWith(`${slug}.html`)) {
        labels.push(lab);
      }
    }
  }
  return labels;
}

/**
 * True when slug, nav label, or primary page job signals appointment intent.
 * Exempt: content-only "call to book" with a tel: CTA and no appointment slug/nav.
 */
function pageHasAppointmentIntent(page, pages = []) {
  if (!page) return { intent: false, reason: null, exempt: false };

  const slug = normalizeSlug(page.slug);
  const title = String(page.title || '');
  const navLabels = navLabelsForPage(pages, page);
  const slugHit = APPOINTMENT_TOKEN_RE.test(slug.replace(/-/g, ' '))
    || /^(book|booking|reserve|reservation|schedule|appointment|appointments)$/i.test(slug);
  const titleHit = APPOINTMENT_TOKEN_RE.test(title);
  const navHit = navLabels.some((lab) => APPOINTMENT_TOKEN_RE.test(lab));

  if (slugHit || titleHit || navHit) {
    return {
      intent: true,
      reason: slugHit ? `slug "${slug}"` : (titleHit ? `title "${title}"` : `nav label`),
      exempt: false,
    };
  }

  const blob = pageTextBlob(page);
  const html = pageHtmlBlob(page);
  const contentHit = APPOINTMENT_TOKEN_RE.test(blob);
  if (!contentHit) return { intent: false, reason: null, exempt: false };

  // Content-only mention + tel CTA → exempt (not primary appointment job)
  if (CALL_TO_BOOK_RE.test(blob) && TEL_HREF_RE.test(html)) {
    return { intent: false, reason: null, exempt: true };
  }

  // Strong content signals without slug/nav still count as intent when the
  // page's job is clearly booking (headings / CTAs), not a tel-only aside.
  const headingHit = /<(h1|h2)[^>]*>[^<]*\b(book|reserve|schedule|appointment)\b/i.test(html)
    || /\b(book\s+now|book\s+online|reserve\s+(a|an|your)|schedule\s+(a|an|your)|request\s+an?\s+appointment)\b/i.test(blob);
  if (headingHit && !TEL_HREF_RE.test(html)) {
    return { intent: true, reason: 'content signals appointment as primary job', exempt: false };
  }

  return { intent: false, reason: null, exempt: false };
}

function pageHasBookingsMount(page) {
  const html = pageHtmlBlob(page);
  if (BOOKINGS_MOUNT_RE.test(html)) return true;
  const sections = Array.isArray(page && page.sections) ? page.sections : [];
  for (const s of sections) {
    if (!s) continue;
    const t = String(s.type || '').toLowerCase();
    const mt = String((s.content && s.content.module_type) || s.module_type || s.moduleType || '').toLowerCase();
    if ((t === 'site_module' || t === 'module') && mt === 'bookings') return true;
    if (s.widget && String(s.widget.module_type || '').toLowerCase() === 'bookings') return true;
    const cells = [];
    if (Array.isArray(s.cols)) {
      for (const col of s.cols) {
        if (Array.isArray(col)) cells.push(...col);
        else if (col && Array.isArray(col.cells)) cells.push(...col.cells);
        else if (col) cells.push(col);
      }
    }
    if (Array.isArray(s.blocks)) cells.push(...s.blocks);
    for (const c of cells) {
      if (!c) continue;
      const w = c.widget || c;
      if (String(w.module_type || '').toLowerCase() === 'bookings') return true;
      if (typeof c.html === 'string' && BOOKINGS_MOUNT_RE.test(c.html)) return true;
    }
  }
  return false;
}

function pageHasFormMount(page) {
  const html = pageHtmlBlob(page);
  if (FORM_MOUNT_RE.test(html) || /<form\b/i.test(html)) return true;
  const sections = Array.isArray(page && page.sections) ? page.sections : [];
  return sections.some((s) => {
    if (!s) return false;
    const t = String(s.type || '').toLowerCase();
    return t === 'contact_form' || t === 'bitpype_form' || t === 'form';
  });
}

function leadBookingsReady(db, leadId) {
  const modules = require('./siteModules');
  modules.ensureTables(db);
  const lid = Number(leadId);
  const embed = modules.getEmbedRow(db, lid, 'bookings');
  const mounted = !!(embed && embed.published && embed.embed_enabled && embed.public_token);
  const services = modules.listBookingServices(db, lid, { includeDrafts: false }) || [];
  const hours = modules.listBookingHours(db, lid) || [];
  const hasService = services.length >= 1;
  const hasHours = hours.length >= 1;
  return {
    embedMounted: mounted,
    embed,
    services,
    hours,
    hasService,
    hasHours,
    ready: mounted && hasService && hasHours,
  };
}

/**
 * Assess module-fit for a site. Returns { pass, detail, remediation[], intentPages[] }.
 */
function assessModuleFit(db, leadId, pages) {
  const list = Array.isArray(pages) ? pages : [];
  const intentPages = [];
  for (const page of list) {
    const hit = pageHasAppointmentIntent(page, list);
    if (hit.intent) intentPages.push({ page, hit });
  }

  if (!intentPages.length) {
    return {
      pass: true,
      detail: 'No appointment-intent pages; module-fit N/A.',
      remediation: [],
      intentPages: [],
      warnings: [],
    };
  }

  const booking = leadBookingsReady(db, leadId);
  const remediation = [];
  const failures = [];

  for (const { page, hit } of intentPages) {
    const slug = normalizeSlug(page.slug) || 'page';
    const hasMount = pageHasBookingsMount(page);
    if (!hasMount) {
      failures.push(`${slug}: appointment intent (${hit.reason}) but bookings module not mounted`);
      remediation.push(
        `Mount bookings on "${slug}" via website.addModule({ module: "bookings", target_page_slug: "${slug}" })`
      );
    }
  }

  if (!booking.embedMounted && !intentPages.some(({ page }) => pageHasBookingsMount(page))) {
    // already covered per-page; ensure embed enabled note
    if (!remediation.some((r) => /addModule/.test(r))) {
      remediation.push('Attach bookings with website.addModule({ module: "bookings" })');
    }
  }

  if (!booking.hasService) {
    failures.push('no published booking service');
    remediation.push('Create ≥1 published service via bookings.createService({ status: "published" })');
  }
  if (!booking.hasHours) {
    failures.push('no booking hours set');
    remediation.push('Set weekly hours via bookings.setHours');
  }

  // If every intent page has the mount AND lead has service+hours → pass
  const allMounted = intentPages.every(({ page }) => pageHasBookingsMount(page));
  const pass = allMounted && booking.hasService && booking.hasHours;

  const detail = pass
    ? `Appointment-intent page(s) ok: bookings mounted, ${booking.services.length} published service(s), hours set.`
    : `module-fit failed: ${failures.join('; ')}. Remediation: ${[...new Set(remediation)].join(' · ')}`;

  return {
    pass,
    detail,
    remediation: [...new Set(remediation)],
    intentPages: intentPages.map(({ page, hit }) => ({
      slug: normalizeSlug(page.slug),
      reason: hit.reason,
      hasBookingsMount: pageHasBookingsMount(page),
      hasForm: pageHasFormMount(page),
    })),
    warnings: [],
  };
}

/**
 * Warning when attaching a form/contact_form onto an appointment-intent page.
 */
function formOnAppointmentPageWarning(pages, pageIndexOrSlug) {
  const list = Array.isArray(pages) ? pages : [];
  let page = null;
  if (typeof pageIndexOrSlug === 'number') {
    page = list[pageIndexOrSlug];
  } else {
    const want = normalizeSlug(pageIndexOrSlug);
    page = list.find((p) => normalizeSlug(p && p.slug) === want) || null;
  }
  if (!page) return null;
  const hit = pageHasAppointmentIntent(page, list);
  if (!hit.intent) return null;
  if (pageHasBookingsMount(page)) return null;
  return APPOINTMENT_FORM_WARNING;
}

/**
 * Scan full pages payload (edit/save) for form mounts on appointment pages.
 */
function warningsForPages(pages) {
  const list = Array.isArray(pages) ? pages : [];
  const out = [];
  for (const page of list) {
    const hit = pageHasAppointmentIntent(page, list);
    if (!hit.intent) continue;
    if (pageHasBookingsMount(page)) continue;
    if (pageHasFormMount(page)) {
      out.push(`${APPOINTMENT_FORM_WARNING} (page: ${normalizeSlug(page.slug) || 'page'})`);
      break;
    }
  }
  return out;
}

/**
 * Warning when addModule targets an appointment-intent page with a non-bookings module.
 */
function addModuleAppointmentWarning(pages, moduleType, targetSlug) {
  const type = String(moduleType || '').toLowerCase();
  if (type === 'bookings') return null;
  const list = Array.isArray(pages) ? pages : [];
  const slug = normalizeSlug(targetSlug);
  const page = list.find((p) => normalizeSlug(p && p.slug) === slug)
    || list.find((p) => pageHasAppointmentIntent(p, list).intent)
    || null;
  if (!page) return null;
  const hit = pageHasAppointmentIntent(page, list);
  if (!hit.intent) return null;
  return APPOINTMENT_FORM_WARNING;
}

module.exports = {
  APPOINTMENT_TOKEN_RE,
  APPOINTMENT_FORM_WARNING,
  normalizeSlug,
  pageHasAppointmentIntent,
  pageHasBookingsMount,
  pageHasFormMount,
  leadBookingsReady,
  assessModuleFit,
  formOnAppointmentPageWarning,
  warningsForPages,
  addModuleAppointmentWarning,
};
