'use strict';

/**
 * Site content modules (Blog, Ecommerce, Courses, Gallery, Directory,
 * FAQ, Testimonials, Team, Events, Bookings).
 * Workspace SQLite tables per lead; in-page JS embeds (legacy iframe URL kept);
 * portal + MCP CRUD.
 * Gated by plan entitlement `siteModules` (Standard + Premium).
 *
 * Bookings is interactive: weekly hours + services drive a public slot picker
 * (calendar / time management), unlike the appointment *request* form which
 * only collects preferred date/time text.
 */

const crypto = require('crypto');

const MODULE_TYPES = [
  'blog', 'ecommerce', 'courses', 'gallery', 'directory',
  'faq', 'testimonials', 'team', 'events', 'bookings', 'chatbot',
];
const MANAGED_ATTR = 'data-bitpype-module';
const EMBED_TYPE_ATTR = 'data-bitpype-module-type';
const EMBED_TOKEN_ATTR = 'data-bitpype-module-token';
const NAV_ATTR = 'data-bitpype-module-nav';
const SCRIPT_ATTR = 'data-bitpype-module-script';
const MODULE_SCRIPT_VER = 'mod6';

const MODULE_META = {
  blog: { label: 'Blog', defaultTitle: 'Blog', defaultSlug: 'blog' },
  ecommerce: { label: 'Shop', defaultTitle: 'Shop', defaultSlug: 'shop' },
  courses: { label: 'Courses', defaultTitle: 'Courses', defaultSlug: 'courses' },
  gallery: { label: 'Gallery', defaultTitle: 'Gallery', defaultSlug: 'gallery' },
  directory: { label: 'Directory', defaultTitle: 'Directory', defaultSlug: 'directory' },
  faq: { label: 'FAQ', defaultTitle: 'FAQ', defaultSlug: 'faq' },
  testimonials: { label: 'Testimonials', defaultTitle: 'Testimonials', defaultSlug: 'testimonials' },
  team: { label: 'Team', defaultTitle: 'Our Team', defaultSlug: 'team' },
  events: { label: 'Events', defaultTitle: 'Events', defaultSlug: 'events' },
  bookings: { label: 'Bookings', defaultTitle: 'Book an Appointment', defaultSlug: 'book' },
  // Floating sitewide widget — no nav page; inject chat-embed.js on all pages.
  chatbot: {
    label: 'Chatbot',
    defaultTitle: 'Chat',
    defaultSlug: '',
    sitewide: true,
    noNav: true,
    overlay: true,
  },
};

const BOOKING_STATUSES = ['pending', 'confirmed', 'cancelled', 'completed'];
const DEFAULT_BOOKING_HOURS = [
  { weekday: 1, start_time: '09:00', end_time: '17:00' },
  { weekday: 2, start_time: '09:00', end_time: '17:00' },
  { weekday: 3, start_time: '09:00', end_time: '17:00' },
  { weekday: 4, start_time: '09:00', end_time: '17:00' },
  { weekday: 5, start_time: '09:00', end_time: '17:00' },
];

function fail(code, message, status) {
  const err = new Error(message);
  err.code = code;
  if (status) err.status = status;
  return err;
}

function assertModuleType(type) {
  const t = String(type || '').trim().toLowerCase();
  if (!MODULE_TYPES.includes(t)) {
    throw fail('VALIDATION', `Unknown module type: ${type}. Use: ${MODULE_TYPES.join(', ')}`);
  }
  return t;
}

function slugify(raw, fallback = 'item') {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return s || fallback;
}

function makePublicToken(workspaceId) {
  const ws = Number(workspaceId);
  if (!Number.isInteger(ws) || ws <= 0) throw fail('INVALID', 'workspaceId required for public token');
  return `${ws}_${crypto.randomBytes(18).toString('base64url')}`;
}

function parseWorkspaceFromToken(token) {
  const m = String(token || '').match(/^(\d+)_[A-Za-z0-9_-]+$/);
  return m ? Number(m[1]) : null;
}

function appBaseUrl() {
  return String(process.env.APP_URL || '').replace(/\/$/, '');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

function ensureTables(db) {
  try { require('./chatbot').ensureTables(db); } catch { /* optional */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_module_embeds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      module_type TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      public_token TEXT,
      published INTEGER NOT NULL DEFAULT 0,
      embed_enabled INTEGER NOT NULL DEFAULT 1,
      target_page_slug TEXT NOT NULL DEFAULT '',
      settings_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(lead_id, module_type)
    );

    CREATE TABLE IF NOT EXISTS blog_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      body_html TEXT NOT NULL DEFAULT '',
      cover_image TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      published_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(lead_id, slug)
    );

    CREATE TABLE IF NOT EXISTS ecommerce_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      image_url TEXT NOT NULL DEFAULT '',
      checkout_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(lead_id, slug)
    );

    CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      enrollment_url TEXT NOT NULL DEFAULT '',
      cover_image TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(lead_id, slug)
    );

    CREATE TABLE IF NOT EXISTS course_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      body_html TEXT NOT NULL DEFAULT '',
      lesson_url TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS gallery_albums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(lead_id, slug)
    );

    CREATE TABLE IF NOT EXISTS gallery_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      album_id INTEGER NOT NULL,
      image_url TEXT NOT NULL,
      caption TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS directory_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      contact_email TEXT NOT NULL DEFAULT '',
      contact_phone TEXT NOT NULL DEFAULT '',
      website_url TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS faq_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      question TEXT NOT NULL,
      answer_html TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS testimonials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      quote TEXT NOT NULL,
      author_name TEXT NOT NULL DEFAULT '',
      author_title TEXT NOT NULL DEFAULT '',
      author_company TEXT NOT NULL DEFAULT '',
      rating INTEGER NOT NULL DEFAULT 0,
      image_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS team_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      role_title TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      social_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(lead_id, slug)
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      starts_at TEXT NOT NULL DEFAULT '',
      ends_at TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      ticket_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(lead_id, slug)
    );

    CREATE TABLE IF NOT EXISTS booking_settings (
      lead_id INTEGER PRIMARY KEY,
      timezone TEXT NOT NULL DEFAULT 'America/New_York',
      slot_interval_minutes INTEGER NOT NULL DEFAULT 30,
      min_notice_hours INTEGER NOT NULL DEFAULT 2,
      max_days_ahead INTEGER NOT NULL DEFAULT 60,
      auto_confirm INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS booking_services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      duration_minutes INTEGER NOT NULL DEFAULT 30,
      buffer_minutes INTEGER NOT NULL DEFAULT 0,
      price_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      image_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(lead_id, slug)
    );

    CREATE TABLE IF NOT EXISTS booking_hours (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      weekday INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      UNIQUE(lead_id, weekday, start_time, end_time)
    );

    CREATE TABLE IF NOT EXISTS booking_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      block_date TEXT NOT NULL,
      start_time TEXT NOT NULL DEFAULT '',
      end_time TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      service_id INTEGER NOT NULL,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL DEFAULT '',
      customer_phone TEXT NOT NULL DEFAULT '',
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_blog_posts_lead ON blog_posts(lead_id);
    CREATE INDEX IF NOT EXISTS idx_ecom_products_lead ON ecommerce_products(lead_id);
    CREATE INDEX IF NOT EXISTS idx_courses_lead ON courses(lead_id);
    CREATE INDEX IF NOT EXISTS idx_course_lessons_course ON course_lessons(course_id);
    CREATE INDEX IF NOT EXISTS idx_gallery_albums_lead ON gallery_albums(lead_id);
    CREATE INDEX IF NOT EXISTS idx_gallery_images_album ON gallery_images(album_id);
    CREATE INDEX IF NOT EXISTS idx_directory_lead ON directory_listings(lead_id);
    CREATE INDEX IF NOT EXISTS idx_faq_lead ON faq_items(lead_id);
    CREATE INDEX IF NOT EXISTS idx_testimonials_lead ON testimonials(lead_id);
    CREATE INDEX IF NOT EXISTS idx_team_lead ON team_members(lead_id);
    CREATE INDEX IF NOT EXISTS idx_events_lead ON events(lead_id);
    CREATE INDEX IF NOT EXISTS idx_booking_services_lead ON booking_services(lead_id);
    CREATE INDEX IF NOT EXISTS idx_booking_hours_lead ON booking_hours(lead_id);
    CREATE INDEX IF NOT EXISTS idx_booking_blocks_lead ON booking_blocks(lead_id, block_date);
    CREATE INDEX IF NOT EXISTS idx_bookings_lead ON bookings(lead_id, starts_at);
    CREATE INDEX IF NOT EXISTS idx_module_embeds_token ON site_module_embeds(public_token);
  `);
  try {
    const cols = db.prepare('PRAGMA table_info(site_module_embeds)').all()
      .map((c) => String(c.name || ''));
    if (!cols.includes('settings_json')) {
      db.exec('ALTER TABLE site_module_embeds ADD COLUMN settings_json TEXT');
    }
  } catch { /* race / exists */ }
  try {
    const blogCols = db.prepare('PRAGMA table_info(blog_posts)').all()
      .map((c) => String(c.name || ''));
    if (!blogCols.includes('excerpt')) {
      db.exec("ALTER TABLE blog_posts ADD COLUMN excerpt TEXT NOT NULL DEFAULT ''");
    }
  } catch { /* race / exists */ }
  try {
    const bookingCols = db.prepare('PRAGMA table_info(bookings)').all()
      .map((c) => String(c.name || ''));
    if (!bookingCols.includes('archived_at')) {
      db.exec('ALTER TABLE bookings ADD COLUMN archived_at TEXT');
    }
  } catch { /* race / exists */ }
}

/** First ~wordLimit words of plain text from HTML; never truncates mid-word. */
function deriveExcerptFromBody(bodyHtml, wordLimit = 30) {
  const plain = String(bodyHtml || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return '';
  const words = plain.split(' ').filter(Boolean);
  const n = Math.max(1, Math.min(200, Number(wordLimit) || 30));
  if (words.length <= n) return words.join(' ');
  return `${words.slice(0, n).join(' ')}…`;
}

function resolveBlogExcerpt(data, bodyHtml, fallback = '') {
  if (data && data.excerpt != null) {
    const explicit = String(data.excerpt).trim();
    if (explicit) return explicit.slice(0, 500);
  }
  const derived = deriveExcerptFromBody(bodyHtml, 30);
  if (derived) return derived.slice(0, 500);
  return String(fallback || '').trim().slice(0, 500);
}

function normalizePostLimit(value) {
  if (value == null || value === '' || value === false) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(100, Math.floor(n));
}

function parseEmbedSettings(row) {
  let raw = {};
  if (row && row.settings_json) {
    try {
      const parsed = JSON.parse(row.settings_json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
    } catch { /* ignore */ }
  }
  const showRequest = raw.show_request_form;
  const showExcerpt = raw.show_excerpt;
  return {
    show_request_form: showRequest === false || showRequest === 0 || showRequest === 'false'
      ? false
      : true,
    appointment_form_provisioned: !!(raw.appointment_form_provisioned),
    post_limit: normalizePostLimit(raw.post_limit),
    show_excerpt: showExcerpt === false || showExcerpt === 0 || showExcerpt === 'false'
      ? false
      : true,
  };
}

function writeEmbedSettings(db, embedId, settings = {}) {
  const row = db.prepare('SELECT * FROM site_module_embeds WHERE id = ?').get(Number(embedId));
  const cur = parseEmbedSettings(row || {});
  const next = {
    show_request_form: settings.show_request_form !== undefined
      ? settings.show_request_form !== false
      : cur.show_request_form,
    appointment_form_provisioned: settings.appointment_form_provisioned !== undefined
      ? !!settings.appointment_form_provisioned
      : cur.appointment_form_provisioned,
    post_limit: settings.post_limit !== undefined
      ? normalizePostLimit(settings.post_limit)
      : cur.post_limit,
    show_excerpt: settings.show_excerpt !== undefined
      ? !(settings.show_excerpt === false || settings.show_excerpt === 0 || settings.show_excerpt === 'false')
      : cur.show_excerpt,
  };
  db.prepare(`
    UPDATE site_module_embeds
    SET settings_json = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(next), Number(embedId));
  return next;
}

/**
 * Bookings companion "Appointment request" form — created once at attach when
 * show_request_form is true. Tracked on the embed settings, not form existence,
 * so delete/disable never silently re-provisions on export/publish.
 */
function maybeProvisionBookingsCompanionForm(db, leadId, embedRow, opts = {}) {
  if (!embedRow || embedRow.module_type !== 'bookings') return null;
  const settings = parseEmbedSettings(embedRow);
  const showRequest = opts.show_request_form != null
    ? !(opts.show_request_form === false || opts.show_request_form === 0 || opts.show_request_form === 'false')
    : settings.show_request_form;

  if (settings.appointment_form_provisioned) {
    // Keep show_request_form writable on re-attach without recreating the form.
    if (opts.show_request_form != null && showRequest !== settings.show_request_form) {
      writeEmbedSettings(db, embedRow.id, {
        ...settings,
        show_request_form: showRequest,
      });
    }
    return { provisioned: true, created: false, show_request_form: showRequest };
  }

  let created = false;
  let formId = null;
  let provisionError = null;
  if (showRequest) {
    try {
      const forms = require('./contactForms');
      forms.ensureTables(db);
      const existing = forms.listFormRows(db, Number(leadId))
        .find((r) => r.form_kind === 'appointment'
          || /appointment\s*request/i.test(String(r.name || '')));
      if (existing) {
        formId = existing.id;
        if (opts.workspaceId && (!existing.published || !existing.public_token)) {
          forms.publishForm(db, Number(leadId), existing.id, {
            workspaceId: opts.workspaceId,
            embed_enabled: existing.embed_enabled == null ? true : !!existing.embed_enabled,
            target_page_slug: existing.target_page_slug
              || embedRow.target_page_slug
              || MODULE_META.bookings.defaultSlug,
          });
        }
      } else {
        // Defensive lead read — older/partial DBs may lack columns.
        let lead = null;
        try {
          lead = db.prepare('SELECT business_name, email FROM leads WHERE id = ?')
            .get(Number(leadId));
        } catch {
          try {
            lead = db.prepare('SELECT business_name FROM leads WHERE id = ?')
              .get(Number(leadId));
          } catch { lead = null; }
        }
        const preset = forms.FORM_PRESETS.appointment;
        const createdForm = forms.createForm(db, Number(leadId), {
          form_kind: 'appointment',
          name: preset.name,
          title: preset.title,
          intro: preset.intro(lead && lead.business_name),
          submit_label: preset.submit_label,
          success_message: preset.success_message,
          notify_email: (lead && lead.email) || '',
          embed_enabled: true,
          add_to_nav: false,
          target_page_slug: embedRow.target_page_slug || MODULE_META.bookings.defaultSlug,
          fields: preset.fields(),
        });
        formId = createdForm.id;
        if (opts.workspaceId) {
          forms.publishForm(db, Number(leadId), formId, {
            workspaceId: opts.workspaceId,
            embed_enabled: true,
            target_page_slug: embedRow.target_page_slug || MODULE_META.bookings.defaultSlug,
          });
        }
        created = true;
      }
    } catch (e) {
      provisionError = e && e.message ? String(e.message) : 'companion_form_failed';
      console.warn('[siteModules] bookings companion form:', provisionError);
    }
  }

  // Only stamp provisioned when we intentionally skip the form, or we have a form id.
  // Failed creates must remain retryable on next attach/publish.
  const provisionedOk = !showRequest || formId != null;
  writeEmbedSettings(db, embedRow.id, {
    show_request_form: showRequest,
    appointment_form_provisioned: provisionedOk,
  });
  return {
    provisioned: provisionedOk,
    created,
    formId,
    show_request_form: showRequest,
    error: provisionError || undefined,
  };
}

function normalizeSlug(slug) {
  // Prefer shared route identity ("/" / "index" / "home" → "index").
  try {
    const eng = require('../src/websiteEngine');
    if (typeof eng.normalizeRoute === 'function') return eng.normalizeRoute(slug);
  } catch { /* fall through */ }
  return String(slug || '')
    .trim()
    .toLowerCase()
    .replace(/^\//, '')
    .replace(/\.html$/i, '')
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'index';
}

function routeKey(hrefOrSlug) {
  try {
    const eng = require('../src/websiteEngine');
    if (typeof eng.normalizeRoute === 'function') return eng.normalizeRoute(hrefOrSlug);
  } catch { /* fall through */ }
  return normalizeSlug(hrefOrSlug);
}

function anchorTextLabel(innerHtml) {
  try {
    const eng = require('../src/websiteEngine');
    if (typeof eng.navAnchorLabel === 'function') return eng.navAnchorLabel(innerHtml);
  } catch { /* fall through */ }
  return String(innerHtml || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Blank / missing slug means "use the fallback", not the home page. */
function resolveTargetSlug(explicit, stored, fallback) {
  const pick = (v) => {
    if (v == null) return '';
    const s = String(v).trim();
    if (!s) return '';
    return normalizeSlug(s);
  };
  return pick(explicit) || pick(stored) || normalizeSlug(fallback || 'home');
}

/**
 * Relative multipage filename. Must match src/websiteEngine.js pageFileName:
 * home/index → index.html, everything else → {slug}.html.
 */
function pageFileName(slug) {
  const s = String(slug || '/').replace(/^\//, '').replace(/\/$/, '');
  if (!s || s === 'home' || s === 'index') return 'index.html';
  return s.replace(/[^a-z0-9-_]/gi, '_') + '.html';
}

function moduleEmbedActive(row) {
  if (!row || !Number(row.published) || !row.public_token) return false;
  if (row.embed_enabled == null || row.embed_enabled === '') return true;
  const n = Number(row.embed_enabled);
  return !Number.isNaN(n) ? n !== 0 : !!row.embed_enabled;
}

function findPageIndex(pages, slug) {
  const want = normalizeSlug(slug || 'home');
  let idx = pages.findIndex((p) => normalizeSlug(p && p.slug) === want);
  if (idx >= 0) return idx;
  if (want === 'home' || want === 'index') {
    idx = pages.findIndex((p) => {
      const s = normalizeSlug(p && p.slug);
      return s === 'home' || s === 'index' || s === '';
    });
    if (idx >= 0) return idx;
    return pages.length ? 0 : -1;
  }
  return -1;
}

function listSitePages(db, leadId) {
  const site = db.prepare(
    'SELECT pages FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
  ).get(Number(leadId));
  if (!site) return [];
  try {
    const pages = JSON.parse(site.pages || '[]');
    if (!Array.isArray(pages)) return [];
    return pages.map((p) => ({
      slug: normalizeSlug(p && p.slug),
      title: String((p && p.title) || p.slug || ''),
    }));
  } catch {
    return [];
  }
}

/* ── Embeds ── */

function getEmbedRow(db, leadId, moduleType) {
  return db.prepare(
    'SELECT * FROM site_module_embeds WHERE lead_id = ? AND module_type = ?'
  ).get(Number(leadId), assertModuleType(moduleType));
}

function listEmbeds(db, leadId) {
  ensureTables(db);
  return db.prepare(
    'SELECT * FROM site_module_embeds WHERE lead_id = ? ORDER BY module_type'
  ).all(Number(leadId));
}

function ensureEmbed(db, leadId, moduleType, { workspaceId, title } = {}) {
  ensureTables(db);
  const type = assertModuleType(moduleType);
  let row = getEmbedRow(db, leadId, type);
  if (row) return row;
  const meta = MODULE_META[type];
  const token = workspaceId ? makePublicToken(workspaceId) : null;
  const info = db.prepare(`
    INSERT INTO site_module_embeds
      (lead_id, module_type, title, public_token, published, embed_enabled, target_page_slug)
    VALUES (?, ?, ?, ?, 0, 1, ?)
  `).run(
    Number(leadId),
    type,
    String(title || meta.defaultTitle).slice(0, 120),
    token,
    meta.defaultSlug
  );
  return db.prepare('SELECT * FROM site_module_embeds WHERE id = ?').get(info.lastInsertRowid);
}

function publicEmbed(row, appUrl) {
  if (!row) return null;
  const base = String(appUrl || appBaseUrl()).replace(/\/$/, '');
  const token = row.public_token || '';
  const embedUrl = token && base
    ? `${base}/embed/module.html?token=${encodeURIComponent(token)}`
    : '';
  const scriptUrl = base ? `${base}/js/module-embed.js?v=${MODULE_SCRIPT_VER}` : '';
  const settings = parseEmbedSettings(row);
  return {
    id: row.id,
    lead_id: row.lead_id,
    module_type: row.module_type,
    title: row.title,
    public_token: row.public_token,
    published: !!row.published,
    embed_enabled: row.embed_enabled == null ? true : !!row.embed_enabled,
    target_page_slug: row.target_page_slug || MODULE_META[row.module_type]?.defaultSlug || '',
    settings,
    show_request_form: settings.show_request_form,
    // Sites use an in-page JS mount (not an iframe). embed_url is a standalone viewer only.
    embed_mode: 'js',
    script_url: scriptUrl,
    embed_url: embedUrl,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function attachModule(db, leadId, moduleType, opts = {}) {
  ensureTables(db);
  const type = assertModuleType(moduleType);
  const workspaceId = opts.workspaceId;
  if (!workspaceId) throw fail('INVALID', 'workspaceId required to attach module');

  let row = ensureEmbed(db, leadId, type, {
    workspaceId,
    title: opts.title,
  });

  if (!row.public_token) {
    const token = makePublicToken(workspaceId);
    db.prepare(
      "UPDATE site_module_embeds SET public_token = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(token, row.id);
    row = getEmbedRow(db, leadId, type);
  }

  const meta = MODULE_META[type];
  const slug = resolveTargetSlug(opts.target_page_slug, row.target_page_slug, meta.defaultSlug);
  const embedEnabled = opts.embed_enabled != null ? (opts.embed_enabled ? 1 : 0)
    : (opts.toSite === false ? 0 : 1);
  const title = opts.title != null ? String(opts.title).slice(0, 120) : (row.title || meta.defaultTitle);

  db.prepare(`
    UPDATE site_module_embeds
    SET title = ?, published = 1, embed_enabled = ?, target_page_slug = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(title, embedEnabled, slug, row.id);

  row = getEmbedRow(db, leadId, type);

  // Persist embed settings (blog post_limit/show_excerpt, bookings show_request_form, …).
  if (opts.settings && typeof opts.settings === 'object') {
    writeEmbedSettings(db, row.id, {
      ...parseEmbedSettings(row),
      ...opts.settings,
      show_request_form: opts.show_request_form != null
        ? opts.show_request_form
        : (opts.settings.show_request_form != null
          ? opts.settings.show_request_form
          : parseEmbedSettings(row).show_request_form),
    });
    row = getEmbedRow(db, leadId, type);
  } else if (opts.show_request_form != null && type === 'bookings') {
    writeEmbedSettings(db, row.id, {
      ...parseEmbedSettings(row),
      show_request_form: opts.show_request_form,
    });
    row = getEmbedRow(db, leadId, type);
  }

  let companion = null;
  if (type === 'bookings') {
    companion = maybeProvisionBookingsCompanionForm(db, leadId, row, {
      workspaceId,
      show_request_form: opts.show_request_form != null
        ? opts.show_request_form
        : (opts.settings && opts.settings.show_request_form),
    });
    row = getEmbedRow(db, leadId, type);
  }

  const appUrl = opts.appUrl || appBaseUrl();
  const wouldInject = describeWouldInject(row, appUrl);

  // Author-mode preview: return what sync WOULD inject without mutating pages.
  if (opts.dryRun || opts.authorMode === 'preview') {
    let pages = [];
    try {
      const site = db.prepare(
        'SELECT pages FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
      ).get(Number(leadId));
      pages = site ? JSON.parse(site.pages || '[]') : [];
    } catch { pages = []; }
    const purpose = pageServesModulePurpose(pages, type, row.public_token, slug);
    return {
      embed: publicEmbed(row, appUrl),
      sync: { synced: false, dryRun: true },
      companion,
      authorMode: true,
      wouldInject,
      skippedInject: !!purpose.served,
      skipReason: purpose.served ? purpose.reason : null,
    };
  }

  // Author mode (default): if purpose already served, skip sync inject but still enable embed.
  let pagesPre = [];
  try {
    const site = db.prepare(
      'SELECT pages FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
    ).get(Number(leadId));
    pagesPre = site ? JSON.parse(site.pages || '[]') : [];
  } catch { pagesPre = []; }
  const purpose = pageServesModulePurpose(pagesPre, type, row.public_token, slug);
  const metaFlags = MODULE_META[type] || {};
  // Sitewide overlays (chatbot) always sync every page — skip author-purpose short-circuit.
  const authorMode = opts.authorMode !== false; // default ON
  if (!metaFlags.sitewide && authorMode && purpose.served && opts.forceInject !== true) {
    return {
      embed: publicEmbed(row, appUrl),
      sync: { synced: false, skipped: true, reason: purpose.reason },
      companion,
      authorMode: true,
      wouldInject,
      skippedInject: true,
      skipReason: purpose.reason,
    };
  }

  const sync = syncSiteModuleEmbeds(db, leadId, {
    appUrl,
    revealSlugs: metaFlags.noNav || metaFlags.sitewide ? [] : [slug],
  });
  return {
    embed: publicEmbed(row, appUrl),
    sync,
    companion,
    authorMode: true,
    wouldInject,
    skippedInject: false,
    sitewide: !!metaFlags.sitewide,
  };
}

function detachModule(db, leadId, moduleType) {
  ensureTables(db);
  const type = assertModuleType(moduleType);
  const row = getEmbedRow(db, leadId, type);
  if (!row) return { embed: null, sync: { synced: false } };
  db.prepare(`
    UPDATE site_module_embeds
    SET published = 0, embed_enabled = 0, updated_at = datetime('now')
    WHERE id = ?
  `).run(row.id);
  const sync = syncSiteModuleEmbeds(db, leadId);
  return { embed: publicEmbed(getEmbedRow(db, leadId, type)), sync };
}

function moduleScriptTag(appUrl) {
  const base = String(appUrl || appBaseUrl()).replace(/\/$/, '');
  if (!base) return '';
  return (
    `<script src="${escapeAttr(base)}/js/module-embed.js?v=${MODULE_SCRIPT_VER}" ` +
    `defer ${SCRIPT_ATTR}="1"></script>`
  );
}

function embedBlockHtml(embed, appUrl) {
  const base = String(appUrl || appBaseUrl()).replace(/\/$/, '');
  const token = String(embed.public_token || '');
  if (!/^\d+_[A-Za-z0-9_-]+$/.test(token)) return '';
  if (String(embed.module_type || '') === 'chatbot') {
    try {
      return require('./chatbot').chatEmbedBlockHtml(embed, base);
    } catch {
      return '';
    }
  }
  const type = escapeAttr(embed.module_type);
  // In-page mount: customer sites (CF Pages / custom domains) load module-embed.js
  // and fetch the public JSON API. Title comes from the host page when present.
  return (
    `<div class="bitpype-module-embed" ${MANAGED_ATTR}="1" ${EMBED_TYPE_ATTR}="${type}" ` +
    `${EMBED_TOKEN_ATTR}="${escapeAttr(token)}" data-bitpype-api="${escapeAttr(base)}" ` +
    `data-bitpype-hide-title="1"></div>`
  );
}

function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function htmlHasModuleToken(html, token) {
  const t = String(token || '').trim();
  if (!t) return false;
  const esc = escapeRegExp(t);
  return new RegExp(
    `${EMBED_TOKEN_ATTR}\\s*=\\s*["']${esc}["']`,
    'i'
  ).test(String(html || ''));
}

function stripManagedModuleEmbedsFromHtml(html) {
  let s = String(html || '');
  s = s.replace(
    new RegExp(
      `<div\\b[^>]*\\b${MANAGED_ATTR}\\s*=\\s*["']?1["']?[^>]*>[\\s\\S]*?<\\/div>`,
      'gi'
    ),
    ''
  );
  s = s.replace(
    new RegExp(
      `<div\\b[^>]*\\b${MANAGED_ATTR}\\s*=\\s*["']?1["']?[^>]*\\/?>`,
      'gi'
    ),
    ''
  );
  s = s.replace(/<iframe\b[^>]*\/embed\/module\.html[^>]*>\s*<\/iframe>/gi, '');
  s = s.replace(/<iframe\b[^>]*\/embed\/module\.html[^>]*\/>/gi, '');
  s = s.replace(
    new RegExp(`<script\\b[^>]*\\b${SCRIPT_ATTR}\\b[^>]*>\\s*<\\/script>`, 'gi'),
    ''
  );
  s = s.replace(/<script\b[^>]*\/js\/module-embed\.js[^>]*>\s*<\/script>/gi, '');
  return s;
}

/**
 * Remove managed module embeds whose token is not in keepTokens.
 * Active, already-placed widgets stay put (including inside design modules).
 */
function stripInactiveModuleEmbedsFromHtml(html, keepTokens) {
  const keep = keepTokens instanceof Set ? keepTokens : new Set(keepTokens || []);
  let s = String(html || '');
  s = s.replace(
    new RegExp(
      `<div\\b[^>]*\\b${MANAGED_ATTR}\\s*=\\s*["']?1["']?[^>]*>[\\s\\S]*?<\\/div>`,
      'gi'
    ),
    (block) => {
      const m = block.match(new RegExp(`${EMBED_TOKEN_ATTR}\\s*=\\s*["']([^"']+)["']`, 'i'));
      const tok = m && m[1] ? m[1] : '';
      if (tok && keep.has(tok)) return block;
      return '';
    }
  );
  s = s.replace(
    new RegExp(
      `<div\\b[^>]*\\b${MANAGED_ATTR}\\s*=\\s*["']?1["']?[^>]*\\/?>`,
      'gi'
    ),
    (block) => {
      const m = block.match(new RegExp(`${EMBED_TOKEN_ATTR}\\s*=\\s*["']([^"']+)["']`, 'i'));
      const tok = m && m[1] ? m[1] : '';
      if (tok && keep.has(tok)) return block;
      return '';
    }
  );
  // Drop orphan iframes / scripts only when no active embeds remain on the page.
  const stillHas = [...keep].some((t) => htmlHasModuleToken(s, t));
  if (!stillHas) {
    s = s.replace(/<iframe\b[^>]*\/embed\/module\.html[^>]*>\s*<\/iframe>/gi, '');
    s = s.replace(/<iframe\b[^>]*\/embed\/module\.html[^>]*\/>/gi, '');
    s = s.replace(
      new RegExp(`<script\\b[^>]*\\b${SCRIPT_ATTR}\\b[^>]*>\\s*<\\/script>`, 'gi'),
      ''
    );
    s = s.replace(/<script\b[^>]*\/js\/module-embed\.js[^>]*>\s*<\/script>/gi, '');
  }
  return s;
}

function pagesHaveModuleToken(pages, token) {
  const want = String(token || '').trim();
  if (!want) return false;
  try {
    const scan = require('../src/pageContentScan');
    if (scan.collectTypedTokens(pages, { module: true, form: false }).has(want)) return true;
    return scan.pagesBlobHas(pages, (blob, ctx) => {
      if (ctx && ctx.kind === 'cell.widget' && ctx.widget) {
        const w = ctx.widget;
        const wt = String(w.type || '').toLowerCase();
        if (wt === 'site_module' || wt === 'module') {
          return String(w.public_token || w.publicToken || '').trim() === want;
        }
      }
      return htmlHasModuleToken(blob, want);
    });
  } catch {
    for (const page of pages || []) {
      if (typeof page.html === 'string' && htmlHasModuleToken(page.html, want)) return true;
      if (Array.isArray(page.sections)) {
        for (const sec of page.sections) {
          if (!sec || !sec.content) continue;
          const c = sec.content;
          if (typeof c.html === 'string' && htmlHasModuleToken(c.html, want)) return true;
          const cells = Array.isArray(c.cells) ? c.cells : [];
          for (const cell of cells) {
            if (!cell) continue;
            if (typeof cell.html === 'string' && htmlHasModuleToken(cell.html, want)) return true;
            if (cell.widget) {
              const tok = String(cell.widget.public_token || cell.widget.publicToken || '').trim();
              if (tok === want) return true;
            }
          }
          const secType = String(sec.type || '').toLowerCase();
          if (secType === 'site_module' || secType === 'module') {
            const tok = String(c.public_token || c.publicToken || '').trim();
            if (tok === want) return true;
          }
        }
      }
    }
    return false;
  }
}

/**
 * Author-mode: page already serves a module purpose (token, typed section,
 * cell widget, or nav link to the module slug) — inject nothing for that purpose.
 */
function pageServesModulePurpose(pages, moduleType, token, slug) {
  const wantTok = String(token || '').trim();
  if (wantTok && pagesHaveModuleToken(pages, wantTok)) {
    return { served: true, reason: 'token_present' };
  }
  const wantType = String(moduleType || '').toLowerCase();
  const wantSlug = normalizeSlug(slug || '');
  for (const page of pages || []) {
    const pageSlug = normalizeSlug(page && page.slug);
    if (wantSlug && pageSlug === wantSlug) {
      // Target page exists with author content — treat as purpose served when it has any mount/slot.
      if (pageUsesSections(page)) {
        for (const sec of page.sections || []) {
          const t = String((sec && sec.type) || '').toLowerCase();
          if (t === 'site_module' || t === 'module') {
            const mt = String((sec.content && (sec.content.module_type || sec.content.moduleType)) || '').toLowerCase();
            if (!wantType || mt === wantType || !mt) {
              return { served: true, reason: 'typed_section', pageSlug };
            }
          }
          const cells = Array.isArray(sec && sec.content && sec.content.cells) ? sec.content.cells : [];
          for (const cell of cells) {
            if (cell && cell.widget) {
              const wt = String(cell.widget.module_type || cell.widget.moduleType || cell.widget.type || '').toLowerCase();
              if (wt === wantType || wt === 'site_module' || wt === 'module') {
                return { served: true, reason: 'cell_widget', pageSlug };
              }
            }
            if (cell && typeof cell.html === 'string' && /data-bitpype-module/i.test(cell.html)) {
              return { served: true, reason: 'cell_html_mount', pageSlug };
            }
          }
        }
      } else if (typeof page.html === 'string' && /data-bitpype-module/i.test(page.html)) {
        return { served: true, reason: 'page_html_mount', pageSlug };
      }
    }
  }
  return { served: false };
}

/** Describe what attach/sync would inject (author decides). */
function describeWouldInject(embed, appUrl) {
  const meta = MODULE_META[embed && embed.module_type] || {};
  if (meta.sitewide || (embed && embed.module_type === 'chatbot')) {
    return {
      moduleType: embed && embed.module_type,
      pageSlug: null,
      navLink: null,
      mountHtml: embedBlockHtml(embed, appUrl),
      createsPageIfMissing: false,
      insertsManagedNavOnFreeform: false,
      sitewide: true,
      note: 'Floating chat bubble on all pages via chat-embed.js (portal client MCP for replies).',
    };
  }
  const slug = normalizeSlug((embed && embed.target_page_slug) || meta.defaultSlug || 'home');
  const title = (embed && embed.title) || meta.defaultTitle || slug;
  return {
    moduleType: embed && embed.module_type,
    pageSlug: slug,
    navLink: { label: title, href: `${slug}.html`, slug },
    mountHtml: embedBlockHtml(embed, appUrl),
    createsPageIfMissing: true,
    insertsManagedNavOnFreeform: true,
  };
}

function ensureModuleEmbedScript(html, appUrl) {
  const tag = moduleScriptTag(appUrl);
  if (!tag) return String(html || '');
  let s = String(html || '');
  s = s.replace(
    new RegExp(`<script\\b[^>]*\\b${SCRIPT_ATTR}\\b[^>]*>\\s*<\\/script>`, 'gi'),
    ''
  );
  s = s.replace(/<script\b[^>]*\/js\/module-embed\.js[^>]*>\s*<\/script>/gi, '');
  if (/<\/body>/i.test(s)) return s.replace(/<\/body>/i, `${tag}\n</body>`);
  return `${s}\n${tag}`;
}

function isBareModulePage(html) {
  const s = String(html || '');
  if (!s.trim()) return true;
  if (/module-page/i.test(s) && !/<nav\b/i.test(s) && !/<header\b/i.test(s)) return true;
  const compact = s.replace(/\s+/g, ' ').trim();
  return /^<main\b[^>]*>.*<\/main>$/i.test(compact) && !/<nav\b/i.test(compact);
}

function pageUsesSections(page) {
  return !!(page && Array.isArray(page.sections) && page.sections.length > 0);
}

/** nav/html/footer freestyle pages (Delle Donne–style modular chrome). */
function isFreestyleModularPage(page) {
  if (!pageUsesSections(page)) return false;
  const types = page.sections.map((s) => (s && s.type) || '');
  if (!types.includes('nav') || !types.includes('footer')) return false;
  const nav = page.sections.find((s) => s && s.type === 'nav');
  return !!(nav && nav.content && typeof nav.content.html === 'string' && nav.content.html.trim());
}

function findFreestyleTemplatePage(pages, excludeSlug) {
  const skip = excludeSlug != null ? normalizeSlug(excludeSlug) : '';
  const ranked = (pages || []).filter((p) => {
    if (!p || skip && normalizeSlug(p.slug) === skip) return false;
    return isFreestyleModularPage(p);
  });
  ranked.sort((a, b) => {
    const sa = normalizeSlug(a.slug);
    const sb = normalizeSlug(b.slug);
    const score = (slug) => (slug === 'home' || slug === 'index' ? 10 : 0)
      + (slug === 'contact' ? 2 : 0);
    return score(sb) - score(sa);
  });
  return ranked[0] || null;
}

function findFreestyleBodySection(page) {
  if (!pageUsesSections(page)) return null;
  return page.sections.find((s) =>
    s && s.type === 'html' && typeof (s.content && s.content.html) === 'string'
    && /<main\b/i.test(s.content.html)
    && !(s.content && s.content.bitpype_module_managed)
  ) || page.sections.find((s) =>
    s && s.type === 'html' && s.content && typeof s.content.html === 'string'
    && !(s.content && s.content.bitpype_module_managed)
  ) || null;
}

function freestyleMobileBarFromTemplate(templatePage) {
  if (!templatePage || !pageUsesSections(templatePage)) return '';
  const htmlSec = templatePage.sections.find((s) => s && s.type === 'html');
  const html = htmlSec && htmlSec.content && htmlSec.content.html;
  if (typeof html !== 'string') return '';
  const mob = html.match(/<div class="mobilebar"[\s\S]*?<\/div>/i);
  return mob ? mob[0] : '';
}

function pushFreestyleModulePage(pages, { slug, title }) {
  const template = findFreestyleTemplatePage(pages, slug);
  if (!template) return false;
  const navSec = template.sections.find((s) => s && s.type === 'nav');
  const footSec = template.sections.find((s) => s && s.type === 'footer');
  if (!navSec || !footSec) return false;
  let body = ensureClientPageChrome(
    `<main class="bp-mod-main" id="main">${defaultClientPageInner(title)}</main>`
  );
  const mob = freestyleMobileBarFromTemplate(template);
  if (mob) body += `\n${mob}`;
  pages.push({
    slug,
    title,
    sections: [
      JSON.parse(JSON.stringify(navSec)),
      { type: 'html', content: { html: body } },
      JSON.parse(JSON.stringify(footSec)),
    ],
  });
  return true;
}

const MODULE_PAGE_INTRO = {
  bookings: 'Schedule electrical service online — pick a date and time that works for you.',
  blog: 'Read updates, tips, and news from our team.',
  ecommerce: 'Browse products and place an order online.',
  courses: 'Explore courses and enroll online.',
  gallery: 'View our recent work and project photos.',
  directory: 'Find people, places, and resources in our directory.',
  faq: 'Answers to common questions.',
  testimonials: 'See what customers are saying about us.',
  team: 'Meet the people behind our work.',
  events: 'Upcoming events and how to join.',
};

function upgradeModulePageIntro(html, pageEmbeds) {
  let s = String(html || '');
  const primary = pageEmbeds && pageEmbeds[0];
  const moduleType = primary && primary.module_type;
  const intro = MODULE_PAGE_INTRO[moduleType]
    || 'Use the tool below to get started.';
  if (!/<section\b[^>]*\bws-page-section\b/i.test(s)) return s;
  return s.replace(
    /<section\b([^>]*\bws-page-section\b[^>]*)>[\s\S]*?<\/section>/i,
    (block) => {
      if (!/add your content here|write this section|use \+ to add/i.test(block)) return block;
      const attrs = block.match(/^<section\b([^>]*)>/i);
      const open = attrs ? `<section${attrs[1]}>` : '<section class="ws-page-section" data-ws-page-section="1">';
      return `${open}<p>${escapeHtml(intro)}</p></section>`;
    }
  );
}

function shellHtmlFromPages(pages, excludeSlug) {
  const skip = excludeSlug != null ? normalizeSlug(excludeSlug) : '';
  const ranked = [];
  for (const p of pages || []) {
    if (!p || typeof p.html !== 'string' || !p.html.trim()) continue;
    if (skip && normalizeSlug(p.slug) === skip) continue;
    if (isBareModulePage(p.html)) continue;
    const html = String(p.html);
    const score = (/<nav\b/i.test(html) ? 4 : 0)
      + (/<header\b/i.test(html) ? 2 : 0)
      + (/<footer\b/i.test(html) ? 1 : 0)
      + (normalizeSlug(p.slug) === 'home' || normalizeSlug(p.slug) === 'index' ? 8 : 0);
    ranked.push({ html, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  if (ranked.length) return ranked[0].html;

  // Sections-only sites: synthesize a shell from freestyle nav/footer chrome.
  const home = (pages || []).find((p) => {
    if (!p || (skip && normalizeSlug(p.slug) === skip)) return false;
    const slug = normalizeSlug(p.slug);
    return slug === 'home' || slug === 'index' || p.slug === '/';
  }) || (pages || []).find((p) => p && pageUsesSections(p) && !(skip && normalizeSlug(p.slug) === skip));

  if (home && pageUsesSections(home)) {
    const nav = home.sections.find((s) => s && s.type === 'nav');
    const foot = home.sections.find((s) => s && s.type === 'footer');
    const navH = nav && nav.content && typeof nav.content.html === 'string' ? nav.content.html : '';
    const footH = foot && foot.content && typeof foot.content.html === 'string' ? foot.content.html : '';
    if (navH || footH) {
      return `${navH}\n<main class="bp-mod-main" id="main"></main>\n${footH}`;
    }
  }
  return '';
}

/** Blog-like page chrome (shared with module-embed bp-mod-* classes). */
const PAGE_CHROME_CSS = [
  'main.bp-mod-main,.bp-mod-main{',
  'max-width:1100px;width:100%;margin-left:auto;margin-right:auto;',
  'padding:clamp(1.75rem,4vw,3.25rem) clamp(1.1rem,3.5vw,2rem) clamp(3.5rem,8vw,5.5rem);',
  'box-sizing:border-box;',
  '}',
  'main.bp-mod-main > .bp-mod-page-title,.bp-mod-page-title{',
  'margin:0 0 0.2em;letter-spacing:-0.03em;line-height:1.08;',
  'font-size:clamp(2rem,4.5vw,3rem);',
  '}',
  '.ws-page-section{margin:1.35rem 0 0}',
  '.ws-page-section > h2:first-child{margin:0 0 0.45rem;letter-spacing:-0.02em;',
  'font-size:clamp(1.25rem,2.4vw,1.65rem);line-height:1.2}',
  '.ws-page-section > p{margin:0.55rem 0 0;max-width:42ch;',
  'color:var(--ws-muted,var(--muted,color-mix(in srgb,currentColor 58%,transparent)));',
  'font-size:1.05rem;line-height:1.55}',
].join('');

function ensurePageChromeStyle(html) {
  const s = String(html || '');
  if (!s.trim()) return s;
  if (/data-ws-page-chrome\s*=/.test(s)) return s;
  const tag = `<style data-ws-page-chrome="1">${PAGE_CHROME_CSS}</style>`;
  if (/<\/head>/i.test(s)) return s.replace(/<\/head>/i, `${tag}</head>`);
  return `${tag}${s}`;
}

function withMainClass(openTag, className) {
  const open = String(openTag || '<main>');
  const cls = String(className || '').trim();
  if (!cls) return open;
  if (new RegExp(`\\b${cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(open)) return open;
  if (/\bclass\s*=\s*"/i.test(open)) {
    return open.replace(/\bclass\s*=\s*"/i, `class="${cls} `);
  }
  if (/\bclass\s*=\s*'/i.test(open)) {
    return open.replace(/\bclass\s*=\s*'/i, `class='${cls} `);
  }
  return open.replace(/^<main\b/i, `<main class="${cls}"`);
}

/** Default interior for client-created / sparse pages — matches Blog title treatment. */
function defaultClientPageInner(title) {
  const t = escapeHtml(String(title || 'Page').trim() || 'Page');
  return `<h1 class="bp-mod-page-title">${t}</h1>`
    + `<section class="ws-page-section" data-ws-page-section="1">`
    + `<h2>Add your content here.</h2>`
    + `<p>Write this section, or use + to add another.</p>`
    + `</section>`;
}

/**
 * Upgrade sparse freeform <main> chrome (bare h1 + loose copy) into Blog-like
 * title + ws-page-section blocks, preserving module/form embeds.
 */
function ensureClientPageChrome(pageHtml) {
  let html = ensurePageChromeStyle(String(pageHtml || ''));
  if (!html.trim() || !/<main\b/i.test(html)) return html;
  return html.replace(/<main\b[^>]*>[\s\S]*?<\/main>/i, (mainBlock) => {
    const openMatch = mainBlock.match(/^<main\b[^>]*>/i);
    const open = withMainClass(openMatch ? openMatch[0] : '<main>', 'bp-mod-main');
    const openLen = openMatch ? openMatch[0].length : 6;
    const closeStart = mainBlock.lastIndexOf('</');
    const inner = closeStart > 0 ? mainBlock.slice(openLen, closeStart) : '';
    if (/data-ws-page-section\s*=|class="[^"]*\bws-page-section\b/i.test(inner)) {
      const titled = inner.replace(
        /^\s*(<h1\b)([^>]*)(>)/i,
        (full, tag, attrs, close) => {
          if (/\bbp-mod-page-title\b/.test(attrs)) return full;
          if (/\bclass\s*=\s*"/i.test(attrs)) {
            return `${tag}${attrs.replace(/\bclass\s*=\s*"/i, 'class="bp-mod-page-title ')}${close}`;
          }
          return `${tag}${attrs} class="bp-mod-page-title"${close}`;
        }
      );
      return `${open}${titled}</main>`;
    }
    const titleMatch = inner.match(/^\s*(<h1\b[^>]*>[\s\S]*?<\/h1>)/i);
    let titleHtml = '';
    let rest = inner;
    if (titleMatch) {
      titleHtml = titleMatch[1].replace(
        /^(<h1\b)([^>]*)(>)/i,
        (full, tag, attrs, close) => {
          if (/\bbp-mod-page-title\b/.test(attrs)) return full;
          if (/\bclass\s*=\s*"/i.test(attrs)) {
            return `${tag}${attrs.replace(/\bclass\s*=\s*"/i, 'class="bp-mod-page-title ')}${close}`;
          }
          return `${tag}${attrs} class="bp-mod-page-title"${close}`;
        }
      );
      rest = inner.slice(titleMatch[0].length);
    }
    const embedChunks = [];
    const contentParts = [];
    const chunkRe = /(<div\b[^>]*(?:bitpype-module|bitpype-form|bp-mod)[^>]*>[\s\S]*?<\/div>|<iframe\b[^>]*>[\s\S]*?<\/iframe>)/gi;
    let cm;
    let cursor = 0;
    while ((cm = chunkRe.exec(rest))) {
      if (cm.index > cursor) {
        const gap = rest.slice(cursor, cm.index);
        if (gap.trim()) contentParts.push(gap);
      }
      embedChunks.push(cm[0]);
      cursor = cm.index + cm[0].length;
    }
    if (cursor < rest.length) {
      const tail = rest.slice(cursor);
      if (tail.trim()) contentParts.push(tail);
    }
    const body = contentParts.join('').trim();
    let sectionHtml = '';
    if (body) {
      sectionHtml = `<section class="ws-page-section" data-ws-page-section="1">${body}</section>`;
    } else if (titleHtml) {
      sectionHtml = contentSectionHtml({
        heading: 'Add your content here.',
        body: 'Write this section, or use + to add another.',
      });
    }
    return `${open}${titleHtml}${sectionHtml}${embedChunks.join('')}</main>`;
  });
}

/** Blank content block inserted by portal edit-mode / structure “Content section”. */
function contentSectionHtml(opts = {}) {
  const heading = escapeHtml(String(opts.heading || 'New section').trim() || 'New section');
  const body = escapeHtml(String(opts.body || 'Add your content here.').trim() || 'Add your content here.');
  return `<section class="ws-page-section" data-ws-page-section="1">`
    + `<h2>${heading}</h2>`
    + `<p>${body}</p>`
    + `</section>`;
}

function injectContentSectionIntoHtml(pageHtml, sectionHtml, afterIndex) {
  let html = ensurePageChromeStyle(String(pageHtml || ''));
  const block = String(sectionHtml || contentSectionHtml());
  // Dedupe by section type / heading label — author content wins.
  const typeHint = (block.match(/\bdata-ws-section-type\s*=\s*["']([^"']+)["']/i) || [])[1]
    || (block.match(/\bclass\s*=\s*["'][^"']*\b(cta|footer|contact|hero|faq)\b/i) || [])[1]
    || '';
  const labelHint = anchorTextLabel(
    (block.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i) || [])[1] || ''
  );
  if (typeHint && new RegExp(
    `data-ws-section-type\\s*=\\s*["']${typeHint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`,
    'i'
  ).test(html)) {
    return html;
  }
  if (labelHint && new RegExp(`>(?:\\s*)${labelHint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s*)<`, 'i').test(html)) {
    return html;
  }
  if (!html.trim()) {
    return `<main class="bp-mod-main page module-page">${block}</main>`;
  }
  if (!/<main\b/i.test(html)) {
    return `${html}\n<main class="bp-mod-main page module-page">${block}</main>`;
  }
  return html.replace(/<main\b[^>]*>[\s\S]*?<\/main>/i, (mainBlock) => {
    const openMatch = mainBlock.match(/^<main\b[^>]*>/i);
    const open = withMainClass(openMatch ? openMatch[0] : '<main>', 'bp-mod-main');
    const openLen = openMatch ? openMatch[0].length : 6;
    const closeStart = mainBlock.lastIndexOf('</');
    const inner = closeStart > 0 ? mainBlock.slice(openLen, closeStart) : '';
    // Keep leading h1 (page title) out of the section list.
    const titleMatch = inner.match(/^\s*<h1\b[^>]*>[\s\S]*?<\/h1>/i);
    let rest = inner;
    let titleHtml = '';
    if (titleMatch) {
      titleHtml = titleMatch[0];
      rest = inner.slice(titleMatch[0].length);
    }
    const chunks = [];
    const chunkRe = /<section\b[\s\S]*?<\/section>|<div\b[^>]*(?:bitpype-module|bp-mod)[^>]*>[\s\S]*?<\/div>/gi;
    let cm;
    let cursor = 0;
    while ((cm = chunkRe.exec(rest))) {
      if (cm.index > cursor) {
        const gap = rest.slice(cursor, cm.index);
        if (gap.trim()) chunks.push(gap);
      }
      chunks.push(cm[0]);
      cursor = cm.index + cm[0].length;
    }
    if (cursor < rest.length) {
      const tail = rest.slice(cursor);
      if (tail.trim()) chunks.push(tail);
    }
    const at = Math.max(-1, Math.min(Number(afterIndex), chunks.length - 1));
    const out = [];
    if (!chunks.length || at < 0) {
      if (at < 0) out.push(block);
      out.push(...chunks);
      if (at >= 0 && !chunks.length) out.push(block);
    } else {
      chunks.forEach((c, i) => {
        out.push(c);
        if (i === at) out.push(block);
      });
    }
    return `${open}${titleHtml}${out.join('')}</main>`;
  });
}

function fillShellMain(shellHtml, innerHtml) {
  let html = stripManagedNavLinks(stripManagedModuleEmbedsFromHtml(shellHtml));
  const inner = String(innerHtml || '');
  if (!html.trim()) {
    return ensurePageChromeStyle(`<main class="bp-mod-main page module-page">${inner}</main>`);
  }
  if (/<main\b[^>]*>[\s\S]*?<\/main>/i.test(html)) {
    html = html.replace(/<main\b[^>]*>[\s\S]*?<\/main>/i, (m) => {
      const open = withMainClass(m.match(/^<main\b[^>]*>/i)[0], 'bp-mod-main');
      return `${open}${inner}</main>`;
    });
    return ensurePageChromeStyle(html);
  }
  if (/<\/header>/i.test(html) && /<footer\b/i.test(html)) {
    html = html.replace(
      /<\/header>[\s\S]*?<footer\b/i,
      `</header>\n<main class="bp-mod-main page module-page">${inner}</main>\n<footer`
    );
    return ensurePageChromeStyle(html);
  }
  if (/<\/body>/i.test(html)) {
    html = html.replace(/<\/body>/i, `<main class="bp-mod-main page module-page">${inner}</main></body>`);
    return ensurePageChromeStyle(html);
  }
  return ensurePageChromeStyle(`${html}\n<main class="bp-mod-main page module-page">${inner}</main>`);
}

function injectHtmlEmbed(pageHtml, block) {
  let html = String(pageHtml || '');
  const chunk = String(block || '');
  // Author / prior inject wins — never stack a second mount of the same token or type.
  const token = (chunk.match(/\bdata-bitpype-module-token\s*=\s*["']([^"']+)["']/i) || [])[1];
  const modType = (chunk.match(/\bdata-bitpype-module-type\s*=\s*["']([^"']+)["']/i) || [])[1];
  if (token && htmlHasModuleToken(html, token)) return html;
  if (modType && new RegExp(
    `\\bdata-bitpype-module-type\\s*=\\s*["']${modType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`,
    'i'
  ).test(html)) {
    return html;
  }
  if (!html.trim()) {
    return `<main class="bitpype-modules">${chunk}</main>`;
  }
  block = chunk;
  if (/<main\b/i.test(html)) {
    const secRe = /<section\b[^>]*\bws-page-section\b[^>]*>[\s\S]*?<\/section>/gi;
    let last;
    let m;
    while ((m = secRe.exec(html))) last = m;
    if (last) {
      const inner = last[0];
      if (!/bitpype-module-embed/i.test(inner)) {
        const upgraded = inner.replace(/<\/section>/i, `\n${block}</section>`);
        return html.slice(0, last.index) + upgraded + html.slice(last.index + last[0].length);
      }
    }
  }
  if (/<\/main>/i.test(html)) {
    return html.replace(/<\/main>/i, `${block}</main>`);
  }
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${block}</body>`);
  }
  if (/<footer\b/i.test(html)) {
    return html.replace(/<footer\b/i, `${block}<footer`);
  }
  return `${html}\n${block}`;
}

/* ── Top-nav links for module pages ── */

function scanOpenTag(html, from, tag) {
  const re = new RegExp(`<${tag}\\b`, 'ig');
  re.lastIndex = Math.max(0, from || 0);
  const m = re.exec(html);
  if (!m || m.index < from) return null;
  let quote = null;
  for (let i = m.index + m[0].length; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') {
      const selfClosing = html[i - 1] === '/';
      return {
        start: m.index,
        openEnd: i + 1,
        attrs: html.slice(m.index + m[0].length, selfClosing ? i - 1 : i),
        selfClosing,
      };
    }
  }
  return null;
}

function findElement(html, tag, from) {
  const open = scanOpenTag(html, from || 0, tag);
  if (!open) return null;
  if (open.selfClosing) {
    return {
      start: open.start,
      openEnd: open.openEnd,
      closeStart: open.openEnd,
      end: open.openEnd,
      attrs: open.attrs,
    };
  }
  let depth = 1;
  let i = open.openEnd;
  const closeRe = new RegExp(`</${tag}\\s*>`, 'ig');
  while (i < html.length && depth > 0) {
    const nextOpen = scanOpenTag(html, i, tag);
    closeRe.lastIndex = i;
    const nextClose = closeRe.exec(html);
    if (!nextClose) return null;
    if (nextOpen && nextOpen.start < nextClose.index) {
      depth += 1;
      i = nextOpen.openEnd;
    } else {
      depth -= 1;
      if (depth === 0) {
        return {
          start: open.start,
          openEnd: open.openEnd,
          closeStart: nextClose.index,
          end: nextClose.index + nextClose[0].length,
          attrs: open.attrs,
        };
      }
      i = nextClose.index + nextClose[0].length;
    }
  }
  return null;
}

function findAllElements(html, tag) {
  const out = [];
  let from = 0;
  while (from < html.length) {
    const el = findElement(html, tag, from);
    if (!el) break;
    out.push(el);
    from = Math.max(el.end, from + 1);
  }
  return out;
}

function shiftEl(el, delta) {
  return {
    start: el.start + delta,
    openEnd: el.openEnd + delta,
    closeStart: el.closeStart + delta,
    end: el.end + delta,
    attrs: el.attrs,
  };
}

function attrValue(attrs, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i');
  const m = String(attrs || '').match(re);
  if (!m) return '';
  if (m[1] != null) return m[1];
  if (m[2] != null) return m[2];
  return m[3] || '';
}

function cleanClass(cls) {
  return String(cls || '')
    .split(/\s+/)
    .filter((c) => c && !/^(active|current|is-active|is-current|selected|here)$/i.test(c))
    .join(' ');
}

function isPageLikeHref(href) {
  try {
    const eng = require('../src/websiteEngine');
    if (typeof eng.isComparableNavHref === 'function') return eng.isComparableNavHref(href);
  } catch { /* fall through */ }
  const h = String(href || '').trim();
  if (!h || /^(mailto:|tel:|javascript:|https?:|\/\/)/i.test(h)) return false;
  if (h.charAt(0) === '#') return /^#[A-Za-z][A-Za-z0-9_-]*$/.test(h);
  const path = h.split('#')[0].split('?')[0];
  // Bare "/" is home — must count as a page link or rebuild leaves it and injects another Home.
  if (path === '/' || path === '') return true;
  return /^(\.\.\/|\.\/|\/)?[A-Za-z0-9][A-Za-z0-9_-]*(\.html?)?$/i.test(path);
}

function hrefPrefix(href) {
  const t = String(href || '').trim();
  if (t.startsWith('../')) return '../';
  if (t.startsWith('./')) return './';
  if (t.startsWith('/') && !t.startsWith('//')) return '/';
  return '';
}

function majority(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = values[0] || '';
  let n = -1;
  for (const [k, c] of counts) {
    if (c > n) { best = k; n = c; }
  }
  return best;
}

/** Sibling href style, filename from pageFileName. Hashes are not a second scheme. */
function moduleHref(slug, sampleHrefs) {
  const file = pageFileName(normalizeSlug(slug));
  const samples = (sampleHrefs || [])
    .map((h) => String(h || '').trim())
    .filter((h) => h && h.charAt(0) !== '#' && isPageLikeHref(h));
  if (!samples.length) return file;
  const prefix = majority(samples.map(hrefPrefix));
  let htmlVotes = 0;
  let bareVotes = 0;
  for (const h of samples) {
    const path = h.split('#')[0].split('?')[0]
      .replace(/^\.\.\//, '')
      .replace(/^\.\//, '')
      .replace(/^\//, '');
    if (/\.html?$/i.test(path)) htmlVotes += 1;
    else if (path) bareVotes += 1;
  }
  const name = bareVotes > htmlVotes ? file.replace(/\.html$/i, '') : file;
  return prefix + name;
}

function hrefTargetsPage(href, slug) {
  const want = routeKey(slug);
  const raw = String(href || '').trim();
  if (!raw) return false;
  return routeKey(raw) === want;
}

function pageAnchorsIn(html, el) {
  if (!el || el.openEnd == null || el.closeStart == null) return [];
  const inner = html.slice(el.openEnd, el.closeStart);
  const out = [];
  for (const a of findAllElements(inner, 'a')) {
    const href = attrValue(a.attrs, 'href');
    if (!isPageLikeHref(href)) continue;
    if (new RegExp(`\\b${NAV_ATTR}\\b`, 'i').test(a.attrs || '')) continue;
    const shifted = shiftEl(a, el.openEnd);
    shifted.href = href;
    out.push(shifted);
  }
  return out;
}

function topLevelAnchors(html, el) {
  const all = pageAnchorsIn(html, el);
  const inner = html.slice(el.openEnd, el.closeStart);
  const nested = [];
  for (const tag of ['ul', 'ol']) {
    for (const list of findAllElements(inner, tag)) {
      nested.push({ start: el.openEnd + list.start, end: el.openEnd + list.end });
    }
  }
  if (!nested.length) return all;
  const top = all.filter((a) => !nested.some((n) => a.start >= n.start && a.end <= n.end));
  return top.length ? top : all;
}

function pickLinkRow(html, el) {
  const innerFrom = el.openEnd;
  const inner = html.slice(el.openEnd, el.closeStart);
  const lists = [];
  for (const tag of ['ul', 'ol']) {
    for (const list of findAllElements(inner, tag)) {
      const abs = shiftEl(list, innerFrom);
      const links = pageAnchorsIn(html, abs);
      if (links.length) lists.push({ container: abs, links, pageLinks: links.length, useLi: true });
    }
  }
  lists.sort((a, b) => b.pageLinks - a.pageLinks || a.container.start - b.container.start);
  const bestList = lists[0] || null;
  const direct = pageAnchorsIn(html, el);
  // A menu list wins over a logo/CTA sitting beside it.
  if (bestList && bestList.pageLinks >= 2) return bestList;
  if (direct.length) {
    if (bestList && bestList.pageLinks === direct.length) return bestList;
    return { container: el, links: direct, pageLinks: direct.length, useLi: false };
  }
  return bestList;
}

function collectRanges(html, kind) {
  const ranges = [];
  const seen = new Set();
  const re = /<([a-zA-Z][\w:-]*)\b([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[1];
    const attrs = m[2] || '';
    const t = tag.toLowerCase();
    let ok = false;
    if (kind === 'footer') {
      ok = t === 'footer'
        || /\bfooter\b/i.test(attrs)
        || /\brole\s*=\s*["']contentinfo["']/i.test(attrs);
    } else {
      ok = t === 'header'
        || /\brole\s*=\s*["']banner["']/i.test(attrs)
        || /\b(site-header|page-header|masthead|navbar|topbar)\b/i.test(attrs);
    }
    if (!ok) continue;
    if (/\/\s*$/.test(attrs)) continue;
    const el = findElement(html, tag, m.index);
    if (!el || seen.has(el.start)) continue;
    seen.add(el.start);
    ranges.push(el);
  }
  return ranges;
}

function indexInside(ranges, idx) {
  return ranges.some((r) => idx >= r.start && idx < r.end);
}

/**
 * Primary top nav: the header/nav link row, never the footer, never a list in the body.
 * Returns null when nothing safe is found — callers must not invent a header.
 */
function choosePrimaryNav(html) {
  const footerRanges = collectRanges(html, 'footer');
  const headerRanges = collectRanges(html, 'header');
  const mainAt = html.search(/<main\b/i);
  const candidates = [];
  for (const nav of findAllElements(html, 'nav')) {
    if (indexInside(footerRanges, nav.start)) continue;
    const blob = nav.attrs || '';
    if (/\b(footer|breadcrumb|social|legal|skip)\b/i.test(blob)) continue;
    const row = pickLinkRow(html, nav);
    if (!row || row.pageLinks < 1) continue;
    const fileLinks = row.links.filter((a) => String(a.href || '').trim().charAt(0) !== '#').length;
    let score = Math.min(row.pageLinks, 6) + fileLinks * 2;
    if (indexInside(headerRanges, nav.start)) score += 12;
    if (/\b(primary|main|site)\b/i.test(blob) || /aria-label\s*=\s*["'][^"']*(primary|main|site|navigation)/i.test(blob)) {
      score += 6;
    }
    if (/\b(nav|menu|header)\b/i.test(blob)) score += 3;
    if (mainAt >= 0 && nav.start < mainAt) score += 8;
    candidates.push({
      scope: nav,
      container: row.container,
      links: row.links,
      useLi: row.useLi,
      score,
      start: nav.start,
    });
  }
  if (!candidates.length) {
    for (const header of findAllElements(html, 'header')) {
      if (indexInside(footerRanges, header.start)) continue;
      if (/\bfooter\b/i.test(header.attrs || '')) continue;
      const row = pickLinkRow(html, header);
      if (!row || row.pageLinks < 2) continue;
      candidates.push({
        scope: header,
        container: row.container,
        links: row.links,
        useLi: row.useLi,
        score: row.pageLinks,
        start: header.start,
      });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || a.start - b.start);
  return candidates[0];
}

/**
 * Managed module nav chunks (li or a with data-bitpype-module-nav).
 * pageAnchorsIn intentionally skips these — collect separately so rebuild
 * can clear/hide/reorder them with the rest of the menu.
 */
function managedNavRangesIn(html, container) {
  if (!container || container.openEnd == null || container.closeStart == null) return [];
  const inner = html.slice(container.openEnd, container.closeStart);
  const attr = NAV_ATTR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quoted = '(?:"[^"]*"|\'[^\']*\')';
  const ranges = [];
  const liRe = new RegExp(`<li\\b[^>]*\\b${attr}\\s*=\\s*${quoted}[^>]*>[\\s\\S]*?<\\/li>`, 'gi');
  let m;
  while ((m = liRe.exec(inner))) {
    ranges.push({
      start: container.openEnd + m.index,
      end: container.openEnd + m.index + m[0].length,
      html: m[0],
    });
  }
  const aRe = new RegExp(`<a\\b[^>]*\\b${attr}\\s*=\\s*${quoted}[^>]*>[\\s\\S]*?<\\/a>`, 'gi');
  while ((m = aRe.exec(inner))) {
    const startPos = container.openEnd + m.index;
    const endPos = startPos + m[0].length;
    if (ranges.some((r) => startPos >= r.start && endPos <= r.end)) continue;
    ranges.push({ start: startPos, end: endPos, html: m[0] });
  }
  return ranges;
}

/**
 * Rebuild the primary header/nav link row to match portal menu order + navVisible.
 * Preserves logo/CTA outside the link row. Module pages (Blog/Shop/…) participate
 * like any other page via navLinks; old managed leftovers are cleared from the row.
 */
function rebuildFreeformPrimaryNav(html, navLinks, pages, opts = {}) {
  const src = String(html || '');
  if (!src.trim() || !Array.isArray(pages) || pages.length < 2) return src;
  const links = Array.isArray(navLinks) ? navLinks : [];
  const chosen = choosePrimaryNav(src);
  if (!chosen || !chosen.container) return src;

  const container = chosen.container;
  const pageAnchors = pageAnchorsIn(src, container);
  const managedRanges = managedNavRangesIn(src, container);
  if (!pageAnchors.length && !managedRanges.length) return src;

  const activeBySlug = new Map();
  const activeModules = Array.isArray(opts.activeModules) ? opts.activeModules : [];
  activeModules.forEach((it) => {
    const slug = normalizeSlug(it && it.slug);
    const type = String((it && it.type) || '').trim();
    if (slug && type) activeBySlug.set(slug, type);
  });

  const rowLinks = chosen.links || pageAnchors;
  const template = templateAnchor(rowLinks.length ? rowLinks : pageAnchors);
  if (!template && !links.length) {
    if (!managedRanges.length) return src;
    const removeStart = Math.min(...managedRanges.map((r) => r.start));
    const removeEnd = Math.max(...managedRanges.map((r) => r.end));
    return src.slice(0, removeStart) + src.slice(removeEnd);
  }
  const tpl = template || pageAnchors[0];
  if (!tpl) return src;
  const sampleHrefs = (rowLinks.length ? rowLinks : pageAnchors).map((a) => a.href).filter(Boolean);
  const useLi = !!chosen.useLi;
  const innerSlice = src.slice(container.openEnd, container.closeStart);
  const sep = /\n/.test(innerSlice) ? '\n' : ' ';

  // Preserve custom labels (e.g. Journal → blog.html) when rebuilding.
  // Key by normalizeRoute so "/" and "/index" reuse the same authored Home link.
  const existingByRoute = new Map();
  const existingByLabel = new Map();
  const scanInner = src.slice(container.openEnd, container.closeStart);
  for (const a of findAllElements(scanInner, 'a')) {
    const href = attrValue(a.attrs, 'href');
    if (!isPageLikeHref(href)) continue;
    const route = routeKey(href);
    const shifted = shiftEl(a, container.openEnd);
    const chunk = {
      html: src.slice(shifted.start, shifted.end),
      attrs: a.attrs || '',
      href,
    };
    const label = anchorTextLabel(src.slice(shifted.openEnd, shifted.closeStart));
    if (route && !existingByRoute.has(route)) existingByRoute.set(route, chunk);
    if (label && !existingByLabel.has(label)) existingByLabel.set(label, chunk);
  }

  const anchorFromTemplate = (href, label, moduleType) => {
    const route = routeKey(href);
    const labelKey = String(label || '').trim().toLowerCase();
    const prev = (route && existingByRoute.get(route))
      || (labelKey && existingByLabel.get(labelKey))
      || null;
    if (prev && prev.html) {
      let reused = prev.html;
      // Keep author href when it already targets the same route (e.g. "/" vs "/index").
      const prevRoute = routeKey(prev.href);
      if (prevRoute !== route) {
        reused = reused.replace(/\bhref\s*=\s*(["'])[^"']*\1/i, `href="${escapeAttr(href)}"`);
      }
      if (moduleType) {
        if (new RegExp(`\\b${NAV_ATTR}\\b`, 'i').test(reused)) {
          reused = reused.replace(
            new RegExp(`\\b${NAV_ATTR}\\s*=\\s*(["'])[^"']*\\1`, 'i'),
            `${NAV_ATTR}="${escapeAttr(moduleType)}"`
          );
        } else {
          reused = reused.replace(/^<a\b/i, `<a ${NAV_ATTR}="${escapeAttr(moduleType)}"`);
        }
      }
      return reused;
    }
    const cls = cleanClass(attrValue(tpl.attrs, 'class'));
    const clsAttr = cls ? ` class="${escapeAttr(cls)}"` : '';
    const modAttr = moduleType ? ` ${NAV_ATTR}="${escapeAttr(moduleType)}"` : '';
    return `<a${clsAttr} href="${escapeAttr(href)}"${modAttr}>${escapeHtml(label || href)}</a>`;
  };

  const liShell = (anchorHtml, extraCls, moduleType) => {
    if (!useLi) return anchorHtml;
    const liTpl = liWrapping(src, container, tpl);
    const liCls = cleanClass([
      extraCls,
      liTpl ? attrValue(liTpl.attrs, 'class') : '',
    ].filter(Boolean).join(' '));
    const liClsAttr = liCls ? ` class="${escapeAttr(liCls)}"` : '';
    const modAttr = moduleType ? ` ${NAV_ATTR}="${escapeAttr(moduleType)}"` : '';
    return `<li${liClsAttr}${modAttr}>${anchorHtml}</li>`;
  };

  const chunkForLink = (link) => {
    const slug = normalizeSlug(link.slug);
    const moduleType = activeBySlug.get(slug) || '';
    const href = moduleHref(link.slug, sampleHrefs);
    const top = anchorFromTemplate(href, link.label, moduleType);
    const kids = Array.isArray(link.children) ? link.children : [];
    if (!kids.length) return liShell(top, '', moduleType);
    const subParts = kids.map((c) => {
      const childType = activeBySlug.get(normalizeSlug(c.slug)) || '';
      const ch = anchorFromTemplate(moduleHref(c.slug, sampleHrefs), c.label, childType);
      if (!useLi) return ch;
      const childMod = childType ? ` ${NAV_ATTR}="${escapeAttr(childType)}"` : '';
      return `<li${childMod}>${ch}</li>`;
    }).join('');
    const sub = useLi
      ? `<ul class="nav-sub">${subParts}</ul>`
      : `<span class="nav-sub">${subParts}</span>`;
    return useLi
      ? liShell(`${top}${sub}`, 'has-children', moduleType)
      : `<span class="nav-item has-children">${top}${sub}</span>`;
  };

  const newPageChunk = links.map(chunkForLink).join(sep);
  const starts = pageAnchors.map((a) => a.start).concat(managedRanges.map((r) => r.start));
  const ends = pageAnchors.map((a) => a.end).concat(managedRanges.map((r) => r.end));
  const removeStart = Math.min(...starts);
  const removeEnd = Math.max(...ends);
  const out = src.slice(0, removeStart) + newPageChunk + src.slice(removeEnd);
  try {
    const eng = require('../src/websiteEngine');
    if (typeof eng.assertAndDedupeNavHtml === 'function') {
      return eng.assertAndDedupeNavHtml(out, 'rebuildFreeformPrimaryNav');
    }
  } catch { /* optional */ }
  return out;
}

function templateAnchor(anchors) {
  const files = anchors.filter((a) => String(a.href || '').trim().charAt(0) !== '#');
  const pool = files.length ? files : anchors;
  for (let i = pool.length - 1; i >= 0; i--) {
    const cls = attrValue(pool[i].attrs, 'class');
    if (/\b(cta|btn|button)\b/i.test(cls)) continue;
    return pool[i];
  }
  return pool.length ? pool[pool.length - 1] : null;
}

function liWrapping(html, container, anchor) {
  const inner = html.slice(container.openEnd, container.closeStart);
  const relStart = anchor.start - container.openEnd;
  const relEnd = anchor.end - container.openEnd;
  let best = null;
  for (const li of findAllElements(inner, 'li')) {
    if (relStart >= li.start && relEnd <= li.end) {
      if (!best || (li.end - li.start) < (best.end - best.start)) best = li;
    }
  }
  if (!best) return null;
  return shiftEl(best, container.openEnd);
}

function gapBefore(html, index) {
  const back = html.slice(Math.max(0, index - 80), index);
  const m = back.match(/(\s+)$/);
  if (!m) return '';
  const nl = m[1].match(/(\r?\n[ \t]*)$/);
  if (nl) return nl[1];
  return ' ';
}

function stripManagedNavLinks(html) {
  let s = String(html || '');
  const attr = NAV_ATTR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quoted = `(?:"[^"]*"|'[^']*')`;
  s = s.replace(new RegExp(`<li\\b[^>]*\\b${attr}\\s*=\\s*${quoted}[^>]*>[\\s\\S]*?<\\/li>`, 'gi'), '');
  s = s.replace(new RegExp(`<a\\b[^>]*\\b${attr}\\s*=\\s*${quoted}[^>]*>[\\s\\S]*?<\\/a>`, 'gi'), '');
  return s;
}

function navItemHtml(item, { href, className, liClass, useLi }) {
  const type = escapeAttr(item.type);
  const cls = className ? ` class="${escapeAttr(className)}"` : '';
  const anchor = `<a${cls} href="${escapeAttr(href)}" ${NAV_ATTR}="${type}">${escapeHtml(item.label)}</a>`;
  if (!useLi) return anchor;
  const liCls = liClass ? ` class="${escapeAttr(liClass)}"` : '';
  return `<li${liCls} ${NAV_ATTR}="${type}">${anchor}</li>`;
}

function insertModuleNavLinks(html, items, pages) {
  const src = String(html || '');
  if (!src.trim() || !Array.isArray(items) || !items.length) return src;
  const chosen = choosePrimaryNav(src);
  if (!chosen) return src;
  const scopeEl = chosen.scope || chosen.container;
  const scopeLinks = pageAnchorsIn(src, scopeEl);
  // Include labels from all anchors in the primary nav (even non-page-like) for dedupe.
  const scopeLabels = new Set();
  if (scopeEl && scopeEl.openEnd != null && scopeEl.closeStart != null) {
    const inner = src.slice(scopeEl.openEnd, scopeEl.closeStart);
    for (const a of findAllElements(inner, 'a')) {
      const label = anchorTextLabel(inner.slice(a.openEnd, a.closeStart));
      if (label) scopeLabels.add(label);
    }
  }
  const pageList = Array.isArray(pages) ? pages : [];
  const pending = items.filter((it) => {
    const label = String(it.label || '').trim().toLowerCase();
    if (scopeLinks.some((a) => hrefTargetsPage(a.href, it.slug))) return false;
    if (label && scopeLabels.has(label)) return false;
    // Real page in pages[] — syncFreeformNavOrder / rebuild owns visibility & order.
    const page = pageList.find((p) => routeKey(p && p.slug) === routeKey(it.slug));
    if (page) return false;
    return true;
  });
  if (!pending.length) return src;
  const rowLinks = pageAnchorsIn(src, chosen.container);
  const top = topLevelAnchors(src, chosen.container);
  const anchor = templateAnchor(top.length ? top : rowLinks);
  if (!anchor) return src;
  const sampleHrefs = (top.length ? top : rowLinks).map((a) => a.href);
  const className = cleanClass(attrValue(anchor.attrs, 'class'));
  let useLi = !!chosen.useLi;
  let liClass = '';
  let insertAt = anchor.end;
  let gapAt = anchor.start;
  if (useLi) {
    const li = liWrapping(src, chosen.container, anchor);
    if (li) {
      liClass = cleanClass(attrValue(li.attrs, 'class'));
      insertAt = li.end;
      gapAt = li.start;
    } else {
      useLi = false;
    }
  }
  const sep = gapBefore(src, gapAt) || ' ';
  const chunk = pending.map((it) => sep + navItemHtml(it, {
    href: moduleHref(it.slug, sampleHrefs),
    className,
    liClass,
    useLi,
  })).join('');
  return src.slice(0, insertAt) + chunk + src.slice(insertAt);
}

function moduleNavItems(embeds) {
  const items = [];
  const seen = new Set();
  for (const emb of embeds) {
    const meta = MODULE_META[emb.module_type] || {};
    if (meta.noNav || meta.sitewide || emb.module_type === 'chatbot') continue;
    const slug = normalizeSlug(emb.target_page_slug || meta.defaultSlug || 'home');
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const label = String(emb.title || meta.label || meta.defaultTitle || emb.module_type).trim()
      || meta.label
      || 'Page';
    items.push({ type: emb.module_type, slug, label });
  }
  return items;
}

/** True when a page is only a module title/embed, so detaching that module can hide it. */
function pageIsModuleShell(page) {
  const html = String((page && page.html) || '');
  if (!html.trim()) return true;
  const stripped = stripManagedModuleEmbedsFromHtml(html);
  const main = (stripped.match(/<main\b[^>]*>[\s\S]*?<\/main>/i) || [''])[0];
  const text = main.replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return true;
  const title = String((page && page.title) || '').trim();
  if (title && text.toLowerCase() === title.toLowerCase()) return true;
  // Default module page chrome still counts as a shell (title + placeholder copy).
  if (title && /add your content here|write this section|use \+ to add/i.test(text)) {
    const withoutPlaceholder = text
      .replace(/add your content here\.?/gi, ' ')
      .replace(/write this section,? or use \+ to add another\.?/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return withoutPlaceholder.toLowerCase() === title.toLowerCase();
  }
  return false;
}

function syncSiteModuleEmbeds(db, leadId, { appUrl, revealSlugs } = {}) {
  ensureTables(db);
  const site = db.prepare(
    'SELECT id, pages FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
  ).get(Number(leadId));
  if (!site) return { synced: false, reason: 'no_site' };

  let pages;
  try { pages = JSON.parse(site.pages || '[]'); } catch { return { synced: false, reason: 'bad_pages' }; }
  if (!Array.isArray(pages) || !pages.length) return { synced: false, reason: 'empty_pages' };

  const base = appUrl || appBaseUrl();
  // embed_enabled / toSite off → not active, so neither the page embed nor the nav link is kept.
  const embeds = listEmbeds(db, leadId).filter(moduleEmbedActive);
  const activeTokens = new Set(
    embeds.map((e) => String(e.public_token || '').trim()).filter(Boolean)
  );
  const reveal = new Set(
    (Array.isArray(revealSlugs) ? revealSlugs : [])
      .map((s) => normalizeSlug(s))
      .filter(Boolean)
  );

  // Pass 1: strip only inactive embeds; leave placed widgets where they are.
  for (const page of pages) {
    if (pageUsesSections(page)) {
      page.sections = page.sections
        .filter((sec) => {
          if (!(sec && sec.content && sec.content.bitpype_module_managed)) return true;
          // Keep managed mount sections that still hold an active token.
          const html = typeof sec.content.html === 'string' ? sec.content.html : '';
          return [...activeTokens].some((t) => htmlHasModuleToken(html, t));
        })
        .map((sec) => {
          if (!sec || !sec.content || typeof sec.content.html !== 'string') return sec;
          const cleaned = stripInactiveModuleEmbedsFromHtml(sec.content.html, activeTokens);
          if (cleaned === sec.content.html) return sec;
          return Object.assign({}, sec, {
            content: Object.assign({}, sec.content, { html: cleaned }),
          });
        });
      if (typeof page.html === 'string') delete page.html;
    } else if (typeof page.html === 'string' && page.html.trim()) {
      page.html = stripManagedNavLinks(
        stripInactiveModuleEmbedsFromHtml(page.html, activeTokens)
      );
    }
  }

  // Pass 2: inject only when an active embed is missing from every page.
  // Author-mode: if a page already serves that module purpose (cell/section/nav), skip.
  // Sitewide overlays (chatbot) are handled in a dedicated pass — skip here.
  const byPage = new Map();
  const authorSkipped = [];
  for (const emb of embeds) {
    const metaEarly = MODULE_META[emb.module_type] || {};
    if (metaEarly.sitewide || emb.module_type === 'chatbot') continue;

    const token = String(emb.public_token || '').trim();
    if (token && pagesHaveModuleToken(pages, token)) continue;

    const meta = metaEarly;
    const slug = normalizeSlug(emb.target_page_slug || meta.defaultSlug || 'home');
    const purpose = pageServesModulePurpose(pages, emb.module_type, token, slug);
    if (purpose.served) {
      authorSkipped.push({
        moduleType: emb.module_type,
        reason: purpose.reason,
        wouldInject: describeWouldInject(emb, base),
      });
      continue;
    }
    const title = emb.title || meta.defaultTitle || slug;
    let idx = findPageIndex(pages, slug);
    if (idx < 0) {
      // Prefer modular chrome clone when the site is already sections-based.
      let structure;
      try { structure = require('../src/siteStructure'); } catch { structure = null; }
      const siteIsModular = pages.some((p) => pageUsesSections(p));
      const allModular = siteIsModular && pages.every((p) => pageUsesSections(p));
      if (siteIsModular && pushFreestyleModulePage(pages, { slug, title })) {
        idx = pages.length - 1;
      } else if (allModular && structure && typeof structure.createClientPage === 'function') {
        // Portal-style /slug pages only when every page is already sections-based.
        // Mixed freeform sites keep bare module slugs (blog, not /blog).
        const created = structure.createClientPage(pages, {
          title,
          slug,
          shellHtml: shellHtmlFromPages(pages, slug),
          fillShellMain,
          defaultInner: defaultClientPageInner,
        });
        pages = created.pages;
        idx = Number.isInteger(created.pageIndex) ? created.pageIndex : findPageIndex(pages, slug);
        if (idx >= 0 && pages[idx] && routeKey(pages[idx].slug) === routeKey(slug)) {
          pages[idx].slug = slug;
        }
      } else {
        const shell = shellHtmlFromPages(pages, slug);
        pages.push({
          slug,
          title,
          html: fillShellMain(shell, defaultClientPageInner(title)),
        });
        idx = pages.length - 1;
      }
    } else if (
      !pageUsesSections(pages[idx])
      && typeof pages[idx].html === 'string'
      && isBareModulePage(pages[idx].html)
    ) {
      const shell = shellHtmlFromPages(pages, slug);
      if (shell) {
        pages[idx].html = fillShellMain(shell, defaultClientPageInner(title));
      }
    }
    if (idx < 0) continue;
    if (!byPage.has(idx)) byPage.set(idx, []);
    byPage.get(idx).push(emb);
  }

  for (const [idx, pageEmbeds] of byPage) {
    const page = pages[idx];
    const missing = pageEmbeds.filter((e) => {
      const token = String(e.public_token || '').trim();
      return !token || !pagesHaveModuleToken(pages, token);
    });
    if (!missing.length) continue;
    const blocks = missing.map((e) => embedBlockHtml(e, base)).join('\n');
    const usesSections = pageUsesSections(page);
    const hasHtml = !usesSections && typeof page.html === 'string' && page.html.trim();

    // Single write target — mirrors renderPage (sections win when non-empty).
    if (usesSections) {
      const bodySec = findFreestyleBodySection(page);
      if (bodySec) {
        let html = String(bodySec.content.html || '');
        html = ensureClientPageChrome(html);
        html = upgradeModulePageIntro(html, missing);
        html = injectHtmlEmbed(html, blocks);
        bodySec.content = Object.assign({}, bodySec.content, {
          html: ensureModuleEmbedScript(html, base),
        });
        delete bodySec.content.bitpype_module_managed;
      } else {
        const embedSec = {
          type: 'html',
          content: {
            html: `${blocks}\n${moduleScriptTag(base)}`,
            bitpype_module_managed: 1,
          },
        };
        const footerAt = page.sections.findIndex((s) => s && s.type === 'footer');
        if (footerAt >= 0) page.sections.splice(footerAt, 0, embedSec);
        else page.sections.push(embedSec);
      }
      if (typeof page.html === 'string') delete page.html;
    } else if (hasHtml) {
      page.html = ensureModuleEmbedScript(injectHtmlEmbed(page.html, blocks), base);
    } else {
      page.sections = [{
        type: 'html',
        content: {
          html: `${blocks}\n${moduleScriptTag(base)}`,
          bitpype_module_managed: 1,
        },
      }];
    }
  }

  // Ensure script tags on pages that already host active embeds.
  for (const page of pages) {
    if (pageUsesSections(page)) {
      for (const sec of page.sections || []) {
        if (!sec || !sec.content || typeof sec.content.html !== 'string') continue;
        if (![...activeTokens].some((t) => htmlHasModuleToken(sec.content.html, t))) continue;
        sec.content.html = ensureModuleEmbedScript(sec.content.html, base);
      }
    } else if (typeof page.html === 'string' && page.html.trim()) {
      if ([...activeTokens].some((t) => htmlHasModuleToken(page.html, t))) {
        page.html = ensureModuleEmbedScript(page.html, base);
      }
    }
  }

  // Section-type nav is rebuilt from the pages array at render time (one link per
  // page). Inserting another <a> there would duplicate it. Freeform HTML bakes the
  // menu into each page — module pages participate via pages[] + syncFreeformNavOrder.
  const navItems = moduleNavItems(embeds);
  const activeSlugs = new Set(navItems.map((it) => normalizeSlug(it.slug)));
  const moduleDefaultSlugs = new Set(
    Object.values(MODULE_META).map((m) => normalizeSlug(m.defaultSlug)).filter(Boolean)
  );
  // Detached / disabled module pages stay in the site but leave the menu.
  // attachModule passes revealSlugs so re-attach restores menu presence without
  // undoing a client hide while the module is still active.
  for (const page of pages) {
    const slug = normalizeSlug(page && page.slug);
    if (!moduleDefaultSlugs.has(slug)) continue;
    if (reveal.has(slug)) {
      delete page.navVisible;
      delete page.nav_visible;
      delete page.hiddenInNav;
      delete page.hidden_in_nav;
    } else if (!activeSlugs.has(slug) && pageIsModuleShell(page)) {
      page.navVisible = false;
    }
  }

  let navInserted = 0;
  for (const page of pages) {
    if (typeof page.html !== 'string' || !page.html.trim()) continue;
    const next = insertModuleNavLinks(page.html, navItems, pages);
    if (next !== page.html) navInserted += 1;
    page.html = next;
  }

  try {
    pages = require('../src/siteStructure').syncFreeformNavOrder(pages, {
      activeModules: navItems,
    });
  } catch (e) {
    console.warn('[siteModules] syncFreeformNavOrder after module sync:', e && e.message);
  }

  // Sitewide floating chatbot on every page (no nav link / no module page).
  let chatbotSync = null;
  try {
    chatbotSync = require('./chatbot').syncChatbotSitewide(db, leadId, pages, { appUrl: base });
  } catch (e) {
    console.warn('[siteModules] chatbot sitewide sync:', e && e.message);
  }

  db.prepare("UPDATE websites SET pages = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(pages), site.id);

  return {
    synced: true,
    siteId: site.id,
    embeds: embeds.length,
    pages: byPage.size,
    navInserted,
    authorSkipped,
    authorMode: true,
    chatbot: chatbotSync,
  };
}

/**
 * After generate/deliver: ensure module pages exist only when embeds already published.
 * Does not auto-create content — attaches nothing new unless already configured.
 */
function syncPublishedModules(db, leadId, opts = {}) {
  ensureTables(db);
  return syncSiteModuleEmbeds(db, leadId, opts);
}

/* ── Blog ── */

function listBlogPosts(db, leadId, { includeDrafts = true } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM blog_posts WHERE lead_id = ?';
  if (!includeDrafts) sql += " AND status = 'published'";
  sql += ' ORDER BY COALESCE(published_at, created_at) DESC, id DESC';
  return db.prepare(sql).all(Number(leadId));
}

function getBlogPost(db, leadId, idOrSlug) {
  ensureTables(db);
  const lid = Number(leadId);
  if (/^\d+$/.test(String(idOrSlug))) {
    return db.prepare('SELECT * FROM blog_posts WHERE lead_id = ? AND id = ?').get(lid, Number(idOrSlug));
  }
  return db.prepare('SELECT * FROM blog_posts WHERE lead_id = ? AND slug = ?').get(lid, slugify(idOrSlug));
}

function createBlogPost(db, leadId, data = {}) {
  ensureTables(db);
  const title = String(data.title || '').trim();
  if (!title) throw fail('VALIDATION', 'title is required');
  const slug = slugify(data.slug || title, 'post');
  const status = String(data.status || 'draft').toLowerCase() === 'published' ? 'published' : 'draft';
  const publishedAt = status === 'published'
    ? (data.published_at || new Date().toISOString())
    : null;
  const bodyHtml = String(data.body_html || data.body || '');
  const excerpt = resolveBlogExcerpt(data, bodyHtml);
  try {
    const info = db.prepare(`
      INSERT INTO blog_posts
        (lead_id, title, slug, body_html, excerpt, cover_image, status, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Number(leadId),
      title.slice(0, 200),
      slug,
      bodyHtml,
      excerpt,
      String(data.cover_image || data.coverImage || ''),
      status,
      publishedAt
    );
    return getBlogPost(db, leadId, info.lastInsertRowid);
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      throw fail('CONFLICT', `Blog slug already exists: ${slug}`, 409);
    }
    throw e;
  }
}

function updateBlogPost(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = getBlogPost(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Blog post not found', 404);
  const title = data.title != null ? String(data.title).trim().slice(0, 200) : row.title;
  const slug = data.slug != null ? slugify(data.slug, row.slug) : row.slug;
  const body = data.body_html != null || data.body != null
    ? String(data.body_html != null ? data.body_html : data.body)
    : row.body_html;
  const cover = data.cover_image != null || data.coverImage != null
    ? String(data.cover_image != null ? data.cover_image : data.coverImage)
    : row.cover_image;
  // Explicit excerpt wins; body edits re-derive; otherwise keep stored or derive.
  const nextExcerpt = data.excerpt != null
    ? resolveBlogExcerpt(data, body)
    : ((data.body_html != null || data.body != null)
      ? resolveBlogExcerpt({ excerpt: '' }, body)
      : (String(row.excerpt || '').trim() || resolveBlogExcerpt({}, body)));
  let status = row.status;
  let publishedAt = row.published_at;
  if (data.status != null) {
    status = String(data.status).toLowerCase() === 'published' ? 'published' : 'draft';
    if (status === 'published' && !publishedAt) publishedAt = new Date().toISOString();
    if (status === 'draft') publishedAt = null;
  }
  if (data.published_at != null) publishedAt = data.published_at || null;
  try {
    db.prepare(`
      UPDATE blog_posts SET title=?, slug=?, body_html=?, excerpt=?, cover_image=?, status=?,
        published_at=?, updated_at=datetime('now') WHERE id=? AND lead_id=?
    `).run(title, slug, body, nextExcerpt, cover, status, publishedAt, row.id, Number(leadId));
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      throw fail('CONFLICT', `Blog slug already exists: ${slug}`, 409);
    }
    throw e;
  }
  return getBlogPost(db, leadId, row.id);
}

function deleteBlogPost(db, leadId, id) {
  ensureTables(db);
  const row = getBlogPost(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Blog post not found', 404);
  db.prepare('DELETE FROM blog_posts WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

/* ── Ecommerce ── */

function listProducts(db, leadId, { includeDrafts = true } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM ecommerce_products WHERE lead_id = ?';
  if (!includeDrafts) sql += " AND status = 'published'";
  sql += ' ORDER BY sort_order ASC, id DESC';
  return db.prepare(sql).all(Number(leadId));
}

function getProduct(db, leadId, idOrSlug) {
  ensureTables(db);
  const lid = Number(leadId);
  if (/^\d+$/.test(String(idOrSlug))) {
    return db.prepare('SELECT * FROM ecommerce_products WHERE lead_id = ? AND id = ?').get(lid, Number(idOrSlug));
  }
  return db.prepare('SELECT * FROM ecommerce_products WHERE lead_id = ? AND slug = ?').get(lid, slugify(idOrSlug));
}

function createProduct(db, leadId, data = {}) {
  ensureTables(db);
  const name = String(data.name || data.title || '').trim();
  if (!name) throw fail('VALIDATION', 'name is required');
  const slug = slugify(data.slug || name, 'product');
  const priceCents = data.price_cents != null
    ? Math.round(Number(data.price_cents) || 0)
    : Math.round((Number(data.price) || 0) * 100);
  const status = String(data.status || 'draft').toLowerCase() === 'published' ? 'published' : 'draft';
  try {
    const info = db.prepare(`
      INSERT INTO ecommerce_products
        (lead_id, name, slug, description, price_cents, currency, image_url, checkout_url, status, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Number(leadId),
      name.slice(0, 200),
      slug,
      String(data.description || ''),
      priceCents,
      String(data.currency || 'USD').slice(0, 8).toUpperCase(),
      String(data.image_url || data.image || ''),
      String(data.checkout_url || data.checkoutUrl || data.buy_url || ''),
      status,
      Number(data.sort_order) || 0
    );
    return getProduct(db, leadId, info.lastInsertRowid);
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      throw fail('CONFLICT', `Product slug already exists: ${slug}`, 409);
    }
    throw e;
  }
}

function updateProduct(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = getProduct(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Product not found', 404);
  const name = data.name != null || data.title != null
    ? String(data.name != null ? data.name : data.title).trim().slice(0, 200)
    : row.name;
  const slug = data.slug != null ? slugify(data.slug, row.slug) : row.slug;
  const description = data.description != null ? String(data.description) : row.description;
  let priceCents = row.price_cents;
  if (data.price_cents != null) priceCents = Math.round(Number(data.price_cents) || 0);
  else if (data.price != null) priceCents = Math.round((Number(data.price) || 0) * 100);
  const currency = data.currency != null ? String(data.currency).slice(0, 8).toUpperCase() : row.currency;
  const image = data.image_url != null || data.image != null
    ? String(data.image_url != null ? data.image_url : data.image)
    : row.image_url;
  const checkout = data.checkout_url != null || data.checkoutUrl != null || data.buy_url != null
    ? String(data.checkout_url != null ? data.checkout_url : (data.checkoutUrl != null ? data.checkoutUrl : data.buy_url))
    : row.checkout_url;
  const status = data.status != null
    ? (String(data.status).toLowerCase() === 'published' ? 'published' : 'draft')
    : row.status;
  const sortOrder = data.sort_order != null ? Number(data.sort_order) || 0 : row.sort_order;
  try {
    db.prepare(`
      UPDATE ecommerce_products SET name=?, slug=?, description=?, price_cents=?, currency=?,
        image_url=?, checkout_url=?, status=?, sort_order=?, updated_at=datetime('now')
      WHERE id=? AND lead_id=?
    `).run(name, slug, description, priceCents, currency, image, checkout, status, sortOrder, row.id, Number(leadId));
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      throw fail('CONFLICT', `Product slug already exists: ${slug}`, 409);
    }
    throw e;
  }
  return getProduct(db, leadId, row.id);
}

function deleteProduct(db, leadId, id) {
  ensureTables(db);
  const row = getProduct(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Product not found', 404);
  db.prepare('DELETE FROM ecommerce_products WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

function formatPrice(cents, currency = 'USD') {
  const raw = Number(cents);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const n = raw / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(n);
  } catch {
    return `${currency || 'USD'} ${n.toFixed(2)}`;
  }
}

/* ── Courses ── */

function lessonsForCourse(db, courseId) {
  return db.prepare(
    'SELECT * FROM course_lessons WHERE course_id = ? ORDER BY sort_order ASC, id ASC'
  ).all(Number(courseId));
}

function listCourses(db, leadId, { includeDrafts = true, withLessons = true } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM courses WHERE lead_id = ?';
  if (!includeDrafts) sql += " AND status = 'published'";
  sql += ' ORDER BY sort_order ASC, id DESC';
  const rows = db.prepare(sql).all(Number(leadId));
  if (!withLessons) return rows;
  return rows.map((c) => ({ ...c, lessons: lessonsForCourse(db, c.id) }));
}

function getCourse(db, leadId, idOrSlug, { withLessons = true } = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  let row;
  if (/^\d+$/.test(String(idOrSlug))) {
    row = db.prepare('SELECT * FROM courses WHERE lead_id = ? AND id = ?').get(lid, Number(idOrSlug));
  } else {
    row = db.prepare('SELECT * FROM courses WHERE lead_id = ? AND slug = ?').get(lid, slugify(idOrSlug));
  }
  if (!row) return null;
  if (withLessons) row = { ...row, lessons: lessonsForCourse(db, row.id) };
  return row;
}

function createCourse(db, leadId, data = {}) {
  ensureTables(db);
  const title = String(data.title || '').trim();
  if (!title) throw fail('VALIDATION', 'title is required');
  const slug = slugify(data.slug || title, 'course');
  const status = String(data.status || 'draft').toLowerCase() === 'published' ? 'published' : 'draft';
  let course;
  try {
    const info = db.prepare(`
      INSERT INTO courses
        (lead_id, title, slug, description, enrollment_url, cover_image, status, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Number(leadId),
      title.slice(0, 200),
      slug,
      String(data.description || ''),
      String(data.enrollment_url || data.enrollmentUrl || ''),
      String(data.cover_image || data.coverImage || ''),
      status,
      Number(data.sort_order) || 0
    );
    course = getCourse(db, leadId, info.lastInsertRowid, { withLessons: false });
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      throw fail('CONFLICT', `Course slug already exists: ${slug}`, 409);
    }
    throw e;
  }
  const lessons = Array.isArray(data.lessons) ? data.lessons : [];
  for (let i = 0; i < lessons.length; i++) {
    addLesson(db, leadId, course.id, { ...lessons[i], sort_order: lessons[i].sort_order != null ? lessons[i].sort_order : i });
  }
  return getCourse(db, leadId, course.id);
}

function updateCourse(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = getCourse(db, leadId, id, { withLessons: false });
  if (!row) throw fail('NOT_FOUND', 'Course not found', 404);
  const title = data.title != null ? String(data.title).trim().slice(0, 200) : row.title;
  const slug = data.slug != null ? slugify(data.slug, row.slug) : row.slug;
  const description = data.description != null ? String(data.description) : row.description;
  const enrollment = data.enrollment_url != null || data.enrollmentUrl != null
    ? String(data.enrollment_url != null ? data.enrollment_url : data.enrollmentUrl)
    : row.enrollment_url;
  const cover = data.cover_image != null || data.coverImage != null
    ? String(data.cover_image != null ? data.cover_image : data.coverImage)
    : row.cover_image;
  const status = data.status != null
    ? (String(data.status).toLowerCase() === 'published' ? 'published' : 'draft')
    : row.status;
  const sortOrder = data.sort_order != null ? Number(data.sort_order) || 0 : row.sort_order;
  try {
    db.prepare(`
      UPDATE courses SET title=?, slug=?, description=?, enrollment_url=?, cover_image=?,
        status=?, sort_order=?, updated_at=datetime('now') WHERE id=? AND lead_id=?
    `).run(title, slug, description, enrollment, cover, status, sortOrder, row.id, Number(leadId));
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      throw fail('CONFLICT', `Course slug already exists: ${slug}`, 409);
    }
    throw e;
  }
  return getCourse(db, leadId, row.id);
}

function deleteCourse(db, leadId, id) {
  ensureTables(db);
  const row = getCourse(db, leadId, id, { withLessons: false });
  if (!row) throw fail('NOT_FOUND', 'Course not found', 404);
  db.prepare('DELETE FROM course_lessons WHERE course_id = ?').run(row.id);
  db.prepare('DELETE FROM courses WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

function addLesson(db, leadId, courseId, data = {}) {
  ensureTables(db);
  const course = getCourse(db, leadId, courseId, { withLessons: false });
  if (!course) throw fail('NOT_FOUND', 'Course not found', 404);
  const title = String(data.title || '').trim();
  if (!title) throw fail('VALIDATION', 'lesson title is required');
  const info = db.prepare(`
    INSERT INTO course_lessons (course_id, title, body_html, lesson_url, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    course.id,
    title.slice(0, 200),
    String(data.body_html || data.body || ''),
    String(data.lesson_url || data.lessonUrl || data.url || ''),
    Number(data.sort_order) || 0
  );
  return db.prepare('SELECT * FROM course_lessons WHERE id = ?').get(info.lastInsertRowid);
}

function updateLesson(db, leadId, lessonId, data = {}) {
  ensureTables(db);
  const lesson = db.prepare('SELECT * FROM course_lessons WHERE id = ?').get(Number(lessonId));
  if (!lesson) throw fail('NOT_FOUND', 'Lesson not found', 404);
  const course = getCourse(db, leadId, lesson.course_id, { withLessons: false });
  if (!course) throw fail('NOT_FOUND', 'Course not found', 404);
  const title = data.title != null ? String(data.title).trim().slice(0, 200) : lesson.title;
  const body = data.body_html != null || data.body != null
    ? String(data.body_html != null ? data.body_html : data.body)
    : lesson.body_html;
  const url = data.lesson_url != null || data.lessonUrl != null || data.url != null
    ? String(data.lesson_url != null ? data.lesson_url : (data.lessonUrl != null ? data.lessonUrl : data.url))
    : lesson.lesson_url;
  const sortOrder = data.sort_order != null ? Number(data.sort_order) || 0 : lesson.sort_order;
  db.prepare(`
    UPDATE course_lessons SET title=?, body_html=?, lesson_url=?, sort_order=?,
      updated_at=datetime('now') WHERE id=?
  `).run(title, body, url, sortOrder, lesson.id);
  return db.prepare('SELECT * FROM course_lessons WHERE id = ?').get(lesson.id);
}

function deleteLesson(db, leadId, lessonId) {
  ensureTables(db);
  const lesson = db.prepare('SELECT * FROM course_lessons WHERE id = ?').get(Number(lessonId));
  if (!lesson) throw fail('NOT_FOUND', 'Lesson not found', 404);
  const course = getCourse(db, leadId, lesson.course_id, { withLessons: false });
  if (!course) throw fail('NOT_FOUND', 'Course not found', 404);
  db.prepare('DELETE FROM course_lessons WHERE id = ?').run(lesson.id);
  return { deleted: true, id: lesson.id };
}

/* ── Gallery ── */

function imagesForAlbum(db, albumId) {
  return db.prepare(
    'SELECT * FROM gallery_images WHERE album_id = ? ORDER BY sort_order ASC, id ASC'
  ).all(Number(albumId));
}

function listAlbums(db, leadId, { includeDrafts = true, withImages = true } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM gallery_albums WHERE lead_id = ?';
  if (!includeDrafts) sql += " AND status = 'published'";
  sql += ' ORDER BY sort_order ASC, id DESC';
  const rows = db.prepare(sql).all(Number(leadId));
  if (!withImages) return rows;
  return rows.map((a) => ({ ...a, images: imagesForAlbum(db, a.id) }));
}

function getAlbum(db, leadId, idOrSlug, { withImages = true } = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  let row;
  if (/^\d+$/.test(String(idOrSlug))) {
    row = db.prepare('SELECT * FROM gallery_albums WHERE lead_id = ? AND id = ?').get(lid, Number(idOrSlug));
  } else {
    row = db.prepare('SELECT * FROM gallery_albums WHERE lead_id = ? AND slug = ?').get(lid, slugify(idOrSlug));
  }
  if (!row) return null;
  if (withImages) row = { ...row, images: imagesForAlbum(db, row.id) };
  return row;
}

function createAlbum(db, leadId, data = {}) {
  ensureTables(db);
  const title = String(data.title || data.name || '').trim();
  if (!title) throw fail('VALIDATION', 'title is required');
  const slug = slugify(data.slug || title, 'album');
  const status = String(data.status || 'draft').toLowerCase() === 'published' ? 'published' : 'draft';
  let album;
  try {
    const info = db.prepare(`
      INSERT INTO gallery_albums (lead_id, title, slug, description, status, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      Number(leadId),
      title.slice(0, 200),
      slug,
      String(data.description || ''),
      status,
      Number(data.sort_order) || 0
    );
    album = getAlbum(db, leadId, info.lastInsertRowid, { withImages: false });
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      throw fail('CONFLICT', `Album slug already exists: ${slug}`, 409);
    }
    throw e;
  }
  const images = Array.isArray(data.images) ? data.images : [];
  for (let i = 0; i < images.length; i++) {
    addGalleryImage(db, leadId, album.id, { ...images[i], sort_order: images[i].sort_order != null ? images[i].sort_order : i });
  }
  return getAlbum(db, leadId, album.id);
}

function updateAlbum(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = getAlbum(db, leadId, id, { withImages: false });
  if (!row) throw fail('NOT_FOUND', 'Album not found', 404);
  const title = data.title != null || data.name != null
    ? String(data.title != null ? data.title : data.name).trim().slice(0, 200)
    : row.title;
  const slug = data.slug != null ? slugify(data.slug, row.slug) : row.slug;
  const description = data.description != null ? String(data.description) : row.description;
  const status = data.status != null
    ? (String(data.status).toLowerCase() === 'published' ? 'published' : 'draft')
    : row.status;
  const sortOrder = data.sort_order != null ? Number(data.sort_order) || 0 : row.sort_order;
  try {
    db.prepare(`
      UPDATE gallery_albums SET title=?, slug=?, description=?, status=?, sort_order=?,
        updated_at=datetime('now') WHERE id=? AND lead_id=?
    `).run(title, slug, description, status, sortOrder, row.id, Number(leadId));
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      throw fail('CONFLICT', `Album slug already exists: ${slug}`, 409);
    }
    throw e;
  }
  return getAlbum(db, leadId, row.id);
}

function deleteAlbum(db, leadId, id) {
  ensureTables(db);
  const row = getAlbum(db, leadId, id, { withImages: false });
  if (!row) throw fail('NOT_FOUND', 'Album not found', 404);
  db.prepare('DELETE FROM gallery_images WHERE album_id = ?').run(row.id);
  db.prepare('DELETE FROM gallery_albums WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

function addGalleryImage(db, leadId, albumId, data = {}) {
  ensureTables(db);
  const album = getAlbum(db, leadId, albumId, { withImages: false });
  if (!album) throw fail('NOT_FOUND', 'Album not found', 404);
  const imageUrl = String(data.image_url || data.url || data.src || '').trim();
  if (!imageUrl) throw fail('VALIDATION', 'image_url is required');
  const info = db.prepare(`
    INSERT INTO gallery_images (album_id, image_url, caption, sort_order)
    VALUES (?, ?, ?, ?)
  `).run(album.id, imageUrl, String(data.caption || ''), Number(data.sort_order) || 0);
  return db.prepare('SELECT * FROM gallery_images WHERE id = ?').get(info.lastInsertRowid);
}

function deleteGalleryImage(db, leadId, imageId) {
  ensureTables(db);
  const img = db.prepare('SELECT * FROM gallery_images WHERE id = ?').get(Number(imageId));
  if (!img) throw fail('NOT_FOUND', 'Image not found', 404);
  const album = getAlbum(db, leadId, img.album_id, { withImages: false });
  if (!album) throw fail('NOT_FOUND', 'Album not found', 404);
  db.prepare('DELETE FROM gallery_images WHERE id = ?').run(img.id);
  return { deleted: true, id: img.id };
}

/* ── Directory ── */

function listListings(db, leadId, { includeDrafts = true, category } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM directory_listings WHERE lead_id = ?';
  const params = [Number(leadId)];
  if (!includeDrafts) sql += " AND status = 'published'";
  if (category) {
    sql += ' AND LOWER(category) = LOWER(?)';
    params.push(String(category));
  }
  sql += ' ORDER BY sort_order ASC, name ASC, id DESC';
  return db.prepare(sql).all(...params);
}

function getListing(db, leadId, id) {
  ensureTables(db);
  return db.prepare(
    'SELECT * FROM directory_listings WHERE lead_id = ? AND id = ?'
  ).get(Number(leadId), Number(id));
}

function createListing(db, leadId, data = {}) {
  ensureTables(db);
  const name = String(data.name || data.title || '').trim();
  if (!name) throw fail('VALIDATION', 'name is required');
  const status = String(data.status || 'draft').toLowerCase() === 'published' ? 'published' : 'draft';
  const info = db.prepare(`
    INSERT INTO directory_listings
      (lead_id, name, category, description, contact_email, contact_phone, website_url, image_url, status, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(leadId),
    name.slice(0, 200),
    String(data.category || '').slice(0, 120),
    String(data.description || ''),
    String(data.contact_email || data.email || ''),
    String(data.contact_phone || data.phone || ''),
    String(data.website_url || data.link || data.url || ''),
    String(data.image_url || data.image || ''),
    status,
    Number(data.sort_order) || 0
  );
  return getListing(db, leadId, info.lastInsertRowid);
}

function updateListing(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = getListing(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Listing not found', 404);
  const name = data.name != null || data.title != null
    ? String(data.name != null ? data.name : data.title).trim().slice(0, 200)
    : row.name;
  const category = data.category != null ? String(data.category).slice(0, 120) : row.category;
  const description = data.description != null ? String(data.description) : row.description;
  const email = data.contact_email != null || data.email != null
    ? String(data.contact_email != null ? data.contact_email : data.email)
    : row.contact_email;
  const phone = data.contact_phone != null || data.phone != null
    ? String(data.contact_phone != null ? data.contact_phone : data.phone)
    : row.contact_phone;
  const website = data.website_url != null || data.link != null || data.url != null
    ? String(data.website_url != null ? data.website_url : (data.link != null ? data.link : data.url))
    : row.website_url;
  const image = data.image_url != null || data.image != null
    ? String(data.image_url != null ? data.image_url : data.image)
    : row.image_url;
  const status = data.status != null
    ? (String(data.status).toLowerCase() === 'published' ? 'published' : 'draft')
    : row.status;
  const sortOrder = data.sort_order != null ? Number(data.sort_order) || 0 : row.sort_order;
  db.prepare(`
    UPDATE directory_listings SET name=?, category=?, description=?, contact_email=?,
      contact_phone=?, website_url=?, image_url=?, status=?, sort_order=?,
      updated_at=datetime('now') WHERE id=? AND lead_id=?
  `).run(name, category, description, email, phone, website, image, status, sortOrder, row.id, Number(leadId));
  return getListing(db, leadId, row.id);
}

function deleteListing(db, leadId, id) {
  ensureTables(db);
  const row = getListing(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Listing not found', 404);
  db.prepare('DELETE FROM directory_listings WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

/* ── FAQ ── */

function listFaqItems(db, leadId, { includeDrafts = true, category } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM faq_items WHERE lead_id = ?';
  const params = [Number(leadId)];
  if (!includeDrafts) sql += " AND status = 'published'";
  if (category) {
    sql += ' AND LOWER(category) = LOWER(?)';
    params.push(String(category));
  }
  sql += ' ORDER BY sort_order ASC, id ASC';
  return db.prepare(sql).all(...params);
}

function getFaqItem(db, leadId, id) {
  ensureTables(db);
  return db.prepare('SELECT * FROM faq_items WHERE lead_id = ? AND id = ?')
    .get(Number(leadId), Number(id));
}

function createFaqItem(db, leadId, data = {}) {
  ensureTables(db);
  const question = String(data.question || data.title || '').trim();
  if (!question) throw fail('VALIDATION', 'question is required');
  const status = String(data.status || 'draft').toLowerCase() === 'published' ? 'published' : 'draft';
  const info = db.prepare(`
    INSERT INTO faq_items (lead_id, question, answer_html, category, status, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    Number(leadId),
    question.slice(0, 400),
    String(data.answer_html || data.answer || data.body_html || ''),
    String(data.category || '').slice(0, 120),
    status,
    Number(data.sort_order) || 0
  );
  return getFaqItem(db, leadId, info.lastInsertRowid);
}

function updateFaqItem(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = getFaqItem(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'FAQ item not found', 404);
  const question = data.question != null || data.title != null
    ? String(data.question != null ? data.question : data.title).trim().slice(0, 400)
    : row.question;
  const answer = data.answer_html != null || data.answer != null || data.body_html != null
    ? String(data.answer_html != null ? data.answer_html : (data.answer != null ? data.answer : data.body_html))
    : row.answer_html;
  const category = data.category != null ? String(data.category).slice(0, 120) : row.category;
  const status = data.status != null
    ? (String(data.status).toLowerCase() === 'published' ? 'published' : 'draft')
    : row.status;
  const sortOrder = data.sort_order != null ? Number(data.sort_order) || 0 : row.sort_order;
  db.prepare(`
    UPDATE faq_items SET question=?, answer_html=?, category=?, status=?, sort_order=?,
      updated_at=datetime('now') WHERE id=? AND lead_id=?
  `).run(question, answer, category, status, sortOrder, row.id, Number(leadId));
  return getFaqItem(db, leadId, row.id);
}

function deleteFaqItem(db, leadId, id) {
  ensureTables(db);
  const row = getFaqItem(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'FAQ item not found', 404);
  db.prepare('DELETE FROM faq_items WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

/* ── Testimonials ── */

function listTestimonials(db, leadId, { includeDrafts = true } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM testimonials WHERE lead_id = ?';
  if (!includeDrafts) sql += " AND status = 'published'";
  sql += ' ORDER BY sort_order ASC, id DESC';
  return db.prepare(sql).all(Number(leadId));
}

function getTestimonial(db, leadId, id) {
  ensureTables(db);
  return db.prepare('SELECT * FROM testimonials WHERE lead_id = ? AND id = ?')
    .get(Number(leadId), Number(id));
}

function createTestimonial(db, leadId, data = {}) {
  ensureTables(db);
  const quote = String(data.quote || data.body || data.text || '').trim();
  if (!quote) throw fail('VALIDATION', 'quote is required');
  const status = String(data.status || 'draft').toLowerCase() === 'published' ? 'published' : 'draft';
  let rating = Number(data.rating);
  if (!Number.isFinite(rating) || rating < 0) rating = 0;
  if (rating > 5) rating = 5;
  rating = Math.round(rating);
  const info = db.prepare(`
    INSERT INTO testimonials
      (lead_id, quote, author_name, author_title, author_company, rating, image_url, status, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(leadId),
    quote,
    String(data.author_name || data.author || data.name || '').slice(0, 160),
    String(data.author_title || data.title || data.role || '').slice(0, 160),
    String(data.author_company || data.company || '').slice(0, 160),
    rating,
    String(data.image_url || data.image || ''),
    status,
    Number(data.sort_order) || 0
  );
  return getTestimonial(db, leadId, info.lastInsertRowid);
}

function updateTestimonial(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = getTestimonial(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Testimonial not found', 404);
  const quote = data.quote != null || data.body != null || data.text != null
    ? String(data.quote != null ? data.quote : (data.body != null ? data.body : data.text)).trim()
    : row.quote;
  const authorName = data.author_name != null || data.author != null || data.name != null
    ? String(data.author_name != null ? data.author_name : (data.author != null ? data.author : data.name)).slice(0, 160)
    : row.author_name;
  const authorTitle = data.author_title != null || data.title != null || data.role != null
    ? String(data.author_title != null ? data.author_title : (data.title != null ? data.title : data.role)).slice(0, 160)
    : row.author_title;
  const authorCompany = data.author_company != null || data.company != null
    ? String(data.author_company != null ? data.author_company : data.company).slice(0, 160)
    : row.author_company;
  let rating = row.rating;
  if (data.rating != null) {
    rating = Number(data.rating);
    if (!Number.isFinite(rating) || rating < 0) rating = 0;
    if (rating > 5) rating = 5;
    rating = Math.round(rating);
  }
  const image = data.image_url != null || data.image != null
    ? String(data.image_url != null ? data.image_url : data.image)
    : row.image_url;
  const status = data.status != null
    ? (String(data.status).toLowerCase() === 'published' ? 'published' : 'draft')
    : row.status;
  const sortOrder = data.sort_order != null ? Number(data.sort_order) || 0 : row.sort_order;
  db.prepare(`
    UPDATE testimonials SET quote=?, author_name=?, author_title=?, author_company=?,
      rating=?, image_url=?, status=?, sort_order=?, updated_at=datetime('now')
    WHERE id=? AND lead_id=?
  `).run(quote, authorName, authorTitle, authorCompany, rating, image, status, sortOrder, row.id, Number(leadId));
  return getTestimonial(db, leadId, row.id);
}

function deleteTestimonial(db, leadId, id) {
  ensureTables(db);
  const row = getTestimonial(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Testimonial not found', 404);
  db.prepare('DELETE FROM testimonials WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

/* ── Team ── */

function listTeamMembers(db, leadId, { includeDrafts = true } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM team_members WHERE lead_id = ?';
  if (!includeDrafts) sql += " AND status = 'published'";
  sql += ' ORDER BY sort_order ASC, name ASC, id ASC';
  return db.prepare(sql).all(Number(leadId));
}

function getTeamMember(db, leadId, idOrSlug) {
  ensureTables(db);
  const lid = Number(leadId);
  if (/^\d+$/.test(String(idOrSlug))) {
    return db.prepare('SELECT * FROM team_members WHERE lead_id = ? AND id = ?').get(lid, Number(idOrSlug));
  }
  return db.prepare('SELECT * FROM team_members WHERE lead_id = ? AND slug = ?').get(lid, slugify(idOrSlug));
}

function createTeamMember(db, leadId, data = {}) {
  ensureTables(db);
  const name = String(data.name || data.title || '').trim();
  if (!name) throw fail('VALIDATION', 'name is required');
  const status = String(data.status || 'draft').toLowerCase() === 'published' ? 'published' : 'draft';
  let slug = slugify(data.slug || name, 'member');
  const exists = db.prepare('SELECT id FROM team_members WHERE lead_id = ? AND slug = ?').get(Number(leadId), slug);
  if (exists) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
  const info = db.prepare(`
    INSERT INTO team_members
      (lead_id, name, slug, role_title, bio, image_url, email, phone, social_url, status, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(leadId),
    name.slice(0, 200),
    slug,
    String(data.role_title || data.role || data.title || '').slice(0, 160),
    String(data.bio || data.description || ''),
    String(data.image_url || data.image || ''),
    String(data.email || ''),
    String(data.phone || ''),
    String(data.social_url || data.link || data.url || ''),
    status,
    Number(data.sort_order) || 0
  );
  return getTeamMember(db, leadId, info.lastInsertRowid);
}

function updateTeamMember(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = getTeamMember(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Team member not found', 404);
  const name = data.name != null ? String(data.name).trim().slice(0, 200) : row.name;
  let slug = row.slug;
  if (data.slug != null) {
    slug = slugify(data.slug, 'member');
    const clash = db.prepare(
      'SELECT id FROM team_members WHERE lead_id = ? AND slug = ? AND id != ?'
    ).get(Number(leadId), slug, row.id);
    if (clash) throw fail('VALIDATION', 'slug already in use');
  }
  const role = data.role_title != null || data.role != null || data.title != null
    ? String(data.role_title != null ? data.role_title : (data.role != null ? data.role : data.title)).slice(0, 160)
    : row.role_title;
  const bio = data.bio != null || data.description != null
    ? String(data.bio != null ? data.bio : data.description)
    : row.bio;
  const image = data.image_url != null || data.image != null
    ? String(data.image_url != null ? data.image_url : data.image)
    : row.image_url;
  const email = data.email != null ? String(data.email) : row.email;
  const phone = data.phone != null ? String(data.phone) : row.phone;
  const social = data.social_url != null || data.link != null || data.url != null
    ? String(data.social_url != null ? data.social_url : (data.link != null ? data.link : data.url))
    : row.social_url;
  const status = data.status != null
    ? (String(data.status).toLowerCase() === 'published' ? 'published' : 'draft')
    : row.status;
  const sortOrder = data.sort_order != null ? Number(data.sort_order) || 0 : row.sort_order;
  db.prepare(`
    UPDATE team_members SET name=?, slug=?, role_title=?, bio=?, image_url=?, email=?,
      phone=?, social_url=?, status=?, sort_order=?, updated_at=datetime('now')
    WHERE id=? AND lead_id=?
  `).run(name, slug, role, bio, image, email, phone, social, status, sortOrder, row.id, Number(leadId));
  return getTeamMember(db, leadId, row.id);
}

function deleteTeamMember(db, leadId, id) {
  ensureTables(db);
  const row = getTeamMember(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Team member not found', 404);
  db.prepare('DELETE FROM team_members WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

/* ── Events ── */

function listEvents(db, leadId, { includeDrafts = true } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM events WHERE lead_id = ?';
  if (!includeDrafts) sql += " AND status = 'published'";
  sql += ' ORDER BY CASE WHEN starts_at = \'\' THEN 1 ELSE 0 END, starts_at ASC, sort_order ASC, id DESC';
  return db.prepare(sql).all(Number(leadId));
}

function getEvent(db, leadId, idOrSlug) {
  ensureTables(db);
  const lid = Number(leadId);
  if (/^\d+$/.test(String(idOrSlug))) {
    return db.prepare('SELECT * FROM events WHERE lead_id = ? AND id = ?').get(lid, Number(idOrSlug));
  }
  return db.prepare('SELECT * FROM events WHERE lead_id = ? AND slug = ?').get(lid, slugify(idOrSlug));
}

function createEvent(db, leadId, data = {}) {
  ensureTables(db);
  const title = String(data.title || data.name || '').trim();
  if (!title) throw fail('VALIDATION', 'title is required');
  const status = String(data.status || 'draft').toLowerCase() === 'published' ? 'published' : 'draft';
  let slug = slugify(data.slug || title, 'event');
  const exists = db.prepare('SELECT id FROM events WHERE lead_id = ? AND slug = ?').get(Number(leadId), slug);
  if (exists) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
  const info = db.prepare(`
    INSERT INTO events
      (lead_id, title, slug, description, starts_at, ends_at, location, image_url, ticket_url, status, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(leadId),
    title.slice(0, 200),
    slug,
    String(data.description || data.body || ''),
    String(data.starts_at || data.start || data.date || ''),
    String(data.ends_at || data.end || ''),
    String(data.location || data.venue || '').slice(0, 240),
    String(data.image_url || data.image || ''),
    String(data.ticket_url || data.link || data.url || ''),
    status,
    Number(data.sort_order) || 0
  );
  return getEvent(db, leadId, info.lastInsertRowid);
}

function updateEvent(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = getEvent(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Event not found', 404);
  const title = data.title != null || data.name != null
    ? String(data.title != null ? data.title : data.name).trim().slice(0, 200)
    : row.title;
  let slug = row.slug;
  if (data.slug != null) {
    slug = slugify(data.slug, 'event');
    const clash = db.prepare(
      'SELECT id FROM events WHERE lead_id = ? AND slug = ? AND id != ?'
    ).get(Number(leadId), slug, row.id);
    if (clash) throw fail('VALIDATION', 'slug already in use');
  }
  const description = data.description != null || data.body != null
    ? String(data.description != null ? data.description : data.body)
    : row.description;
  const starts = data.starts_at != null || data.start != null || data.date != null
    ? String(data.starts_at != null ? data.starts_at : (data.start != null ? data.start : data.date))
    : row.starts_at;
  const ends = data.ends_at != null || data.end != null
    ? String(data.ends_at != null ? data.ends_at : data.end)
    : row.ends_at;
  const location = data.location != null || data.venue != null
    ? String(data.location != null ? data.location : data.venue).slice(0, 240)
    : row.location;
  const image = data.image_url != null || data.image != null
    ? String(data.image_url != null ? data.image_url : data.image)
    : row.image_url;
  const ticket = data.ticket_url != null || data.link != null || data.url != null
    ? String(data.ticket_url != null ? data.ticket_url : (data.link != null ? data.link : data.url))
    : row.ticket_url;
  const status = data.status != null
    ? (String(data.status).toLowerCase() === 'published' ? 'published' : 'draft')
    : row.status;
  const sortOrder = data.sort_order != null ? Number(data.sort_order) || 0 : row.sort_order;
  db.prepare(`
    UPDATE events SET title=?, slug=?, description=?, starts_at=?, ends_at=?, location=?,
      image_url=?, ticket_url=?, status=?, sort_order=?, updated_at=datetime('now')
    WHERE id=? AND lead_id=?
  `).run(title, slug, description, starts, ends, location, image, ticket, status, sortOrder, row.id, Number(leadId));
  return getEvent(db, leadId, row.id);
}

function deleteEvent(db, leadId, id) {
  ensureTables(db);
  const row = getEvent(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Event not found', 404);
  db.prepare('DELETE FROM events WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

/* ── Bookings (services + hours + calendar slots) ── */

function parseHm(s) {
  const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function formatHm(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function ymdFromDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseYmd(s) {
  const m = String(s || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

function publicBookingService(row) {
  if (!row) return null;
  const priceLabel = formatPrice(row.price_cents, row.currency);
  return {
    ...row,
    price_label: priceLabel,
    duration_label: `${row.duration_minutes} min`,
  };
}

function getBookingSettings(db, leadId) {
  ensureTables(db);
  let row = db.prepare('SELECT * FROM booking_settings WHERE lead_id = ?').get(Number(leadId));
  if (!row) {
    db.prepare(`
      INSERT INTO booking_settings (lead_id) VALUES (?)
    `).run(Number(leadId));
    row = db.prepare('SELECT * FROM booking_settings WHERE lead_id = ?').get(Number(leadId));
  }
  return {
    lead_id: row.lead_id,
    timezone: row.timezone || 'America/New_York',
    slot_interval_minutes: Number(row.slot_interval_minutes) || 30,
    min_notice_hours: Number(row.min_notice_hours) || 0,
    max_days_ahead: Number(row.max_days_ahead) || 60,
    auto_confirm: !!row.auto_confirm,
    updated_at: row.updated_at,
  };
}

function updateBookingSettings(db, leadId, data = {}) {
  ensureTables(db);
  getBookingSettings(db, leadId);
  const cur = db.prepare('SELECT * FROM booking_settings WHERE lead_id = ?').get(Number(leadId));
  const timezone = data.timezone != null ? String(data.timezone).slice(0, 80) : cur.timezone;
  let interval = data.slot_interval_minutes != null ? Number(data.slot_interval_minutes) : cur.slot_interval_minutes;
  if (!Number.isFinite(interval) || interval < 5) interval = 5;
  if (interval > 240) interval = 240;
  let notice = data.min_notice_hours != null ? Number(data.min_notice_hours) : cur.min_notice_hours;
  if (!Number.isFinite(notice) || notice < 0) notice = 0;
  if (notice > 168) notice = 168;
  let ahead = data.max_days_ahead != null ? Number(data.max_days_ahead) : cur.max_days_ahead;
  if (!Number.isFinite(ahead) || ahead < 1) ahead = 1;
  if (ahead > 365) ahead = 365;
  const auto = data.auto_confirm != null ? (data.auto_confirm ? 1 : 0) : cur.auto_confirm;
  db.prepare(`
    UPDATE booking_settings SET timezone=?, slot_interval_minutes=?, min_notice_hours=?,
      max_days_ahead=?, auto_confirm=?, updated_at=datetime('now') WHERE lead_id=?
  `).run(timezone, interval, notice, ahead, auto, Number(leadId));
  return getBookingSettings(db, leadId);
}

function listBookingHours(db, leadId) {
  ensureTables(db);
  const rows = db.prepare(
    'SELECT * FROM booking_hours WHERE lead_id = ? ORDER BY weekday ASC, start_time ASC'
  ).all(Number(leadId));
  return rows;
}

function ensureDefaultBookingHours(db, leadId) {
  ensureTables(db);
  const existing = listBookingHours(db, leadId);
  if (existing.length) return existing;
  const insert = db.prepare(
    'INSERT INTO booking_hours (lead_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)'
  );
  const tx = db.transaction(() => {
    for (const h of DEFAULT_BOOKING_HOURS) {
      insert.run(Number(leadId), h.weekday, h.start_time, h.end_time);
    }
  });
  tx();
  return listBookingHours(db, leadId);
}

function setBookingHours(db, leadId, hours) {
  ensureTables(db);
  if (!Array.isArray(hours)) throw fail('VALIDATION', 'hours is required');
  const list = hours;
  const cleaned = [];
  for (const h of list) {
    const weekday = Number(h.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw fail('VALIDATION', 'weekday must be 0 (Sun) through 6 (Sat)');
    }
    const start = parseHm(h.start_time || h.start);
    const end = parseHm(h.end_time || h.end);
    if (start == null || end == null || end <= start) {
      throw fail('VALIDATION', 'Each hour needs start_time and end_time as HH:MM with end after start');
    }
    cleaned.push({ weekday, start_time: formatHm(start), end_time: formatHm(end) });
  }
  const del = db.prepare('DELETE FROM booking_hours WHERE lead_id = ?');
  const insert = db.prepare(
    'INSERT INTO booking_hours (lead_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)'
  );
  const tx = db.transaction(() => {
    del.run(Number(leadId));
    for (const h of cleaned) insert.run(Number(leadId), h.weekday, h.start_time, h.end_time);
  });
  tx();
  return listBookingHours(db, leadId);
}

function listBookingBlocks(db, leadId, { from, to } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM booking_blocks WHERE lead_id = ?';
  const params = [Number(leadId)];
  if (from) {
    sql += ' AND block_date >= ?';
    params.push(String(from));
  }
  if (to) {
    sql += ' AND block_date <= ?';
    params.push(String(to));
  }
  sql += ' ORDER BY block_date ASC, start_time ASC, id ASC';
  return db.prepare(sql).all(...params);
}

function createBookingBlock(db, leadId, data = {}) {
  ensureTables(db);
  const date = String(data.block_date || data.date || '').trim();
  if (!parseYmd(date)) throw fail('VALIDATION', 'block_date must be YYYY-MM-DD');
  const start = data.start_time != null ? String(data.start_time).trim() : '';
  const end = data.end_time != null ? String(data.end_time).trim() : '';
  if (start || end) {
    if (parseHm(start) == null || parseHm(end) == null || parseHm(end) <= parseHm(start)) {
      throw fail('VALIDATION', 'Partial blocks need valid start_time and end_time');
    }
  }
  const info = db.prepare(`
    INSERT INTO booking_blocks (lead_id, block_date, start_time, end_time, reason)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    Number(leadId),
    date,
    start,
    end,
    String(data.reason || '').slice(0, 240)
  );
  return db.prepare('SELECT * FROM booking_blocks WHERE id = ?').get(info.lastInsertRowid);
}

function deleteBookingBlock(db, leadId, id) {
  ensureTables(db);
  const row = db.prepare(
    'SELECT * FROM booking_blocks WHERE id = ? AND lead_id = ?'
  ).get(Number(id), Number(leadId));
  if (!row) throw fail('NOT_FOUND', 'Block not found', 404);
  db.prepare('DELETE FROM booking_blocks WHERE id = ?').run(row.id);
  return { deleted: true, id: row.id };
}

function listBookingServices(db, leadId, { includeDrafts = true } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM booking_services WHERE lead_id = ?';
  if (!includeDrafts) sql += " AND status = 'published'";
  sql += ' ORDER BY sort_order ASC, name ASC, id ASC';
  return db.prepare(sql).all(Number(leadId)).map(publicBookingService);
}

function getBookingService(db, leadId, idOrSlug) {
  ensureTables(db);
  const lid = Number(leadId);
  let row;
  if (/^\d+$/.test(String(idOrSlug))) {
    row = db.prepare('SELECT * FROM booking_services WHERE lead_id = ? AND id = ?').get(lid, Number(idOrSlug));
  } else {
    row = db.prepare('SELECT * FROM booking_services WHERE lead_id = ? AND slug = ?').get(lid, slugify(idOrSlug));
  }
  return publicBookingService(row);
}

function createBookingService(db, leadId, data = {}) {
  ensureTables(db);
  ensureDefaultBookingHours(db, leadId);
  getBookingSettings(db, leadId);
  const name = String(data.name || data.title || '').trim();
  if (!name) throw fail('VALIDATION', 'name is required');
  const status = String(data.status || 'draft').toLowerCase() === 'published' ? 'published' : 'draft';
  let slug = slugify(data.slug || name, 'service');
  const exists = db.prepare('SELECT id FROM booking_services WHERE lead_id = ? AND slug = ?').get(Number(leadId), slug);
  if (exists) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
  let duration = Number(data.duration_minutes != null ? data.duration_minutes : data.duration) || 30;
  if (duration < 5) duration = 5;
  if (duration > 480) duration = 480;
  let buffer = Number(data.buffer_minutes != null ? data.buffer_minutes : data.buffer) || 0;
  if (buffer < 0) buffer = 0;
  if (buffer > 240) buffer = 240;
  let priceCents = 0;
  if (data.price_cents != null) priceCents = Math.round(Number(data.price_cents)) || 0;
  else if (data.price != null) priceCents = Math.round(Number(data.price) * 100) || 0;
  const info = db.prepare(`
    INSERT INTO booking_services
      (lead_id, name, slug, description, duration_minutes, buffer_minutes, price_cents, currency, image_url, status, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(leadId),
    name.slice(0, 200),
    slug,
    String(data.description || ''),
    duration,
    buffer,
    priceCents,
    String(data.currency || 'USD').slice(0, 8).toUpperCase(),
    String(data.image_url || data.image || ''),
    status,
    Number(data.sort_order) || 0
  );
  return getBookingService(db, leadId, info.lastInsertRowid);
}

function updateBookingService(db, leadId, id, data = {}) {
  ensureTables(db);
  const raw = db.prepare('SELECT * FROM booking_services WHERE lead_id = ? AND id = ?')
    .get(Number(leadId), Number(id));
  if (!raw) throw fail('NOT_FOUND', 'Service not found', 404);
  const name = data.name != null || data.title != null
    ? String(data.name != null ? data.name : data.title).trim().slice(0, 200)
    : raw.name;
  let slug = raw.slug;
  if (data.slug != null) {
    slug = slugify(data.slug, 'service');
    const clash = db.prepare(
      'SELECT id FROM booking_services WHERE lead_id = ? AND slug = ? AND id != ?'
    ).get(Number(leadId), slug, raw.id);
    if (clash) throw fail('VALIDATION', 'slug already in use');
  }
  const description = data.description != null ? String(data.description) : raw.description;
  let duration = raw.duration_minutes;
  if (data.duration_minutes != null || data.duration != null) {
    duration = Number(data.duration_minutes != null ? data.duration_minutes : data.duration) || 30;
    if (duration < 5) duration = 5;
    if (duration > 480) duration = 480;
  }
  let buffer = raw.buffer_minutes;
  if (data.buffer_minutes != null || data.buffer != null) {
    buffer = Number(data.buffer_minutes != null ? data.buffer_minutes : data.buffer) || 0;
    if (buffer < 0) buffer = 0;
    if (buffer > 240) buffer = 240;
  }
  let priceCents = raw.price_cents;
  if (data.price_cents != null) priceCents = Math.round(Number(data.price_cents)) || 0;
  else if (data.price != null) priceCents = Math.round(Number(data.price) * 100) || 0;
  const currency = data.currency != null
    ? String(data.currency).slice(0, 8).toUpperCase()
    : raw.currency;
  const image = data.image_url != null || data.image != null
    ? String(data.image_url != null ? data.image_url : data.image)
    : raw.image_url;
  const status = data.status != null
    ? (String(data.status).toLowerCase() === 'published' ? 'published' : 'draft')
    : raw.status;
  const sortOrder = data.sort_order != null ? Number(data.sort_order) || 0 : raw.sort_order;
  db.prepare(`
    UPDATE booking_services SET name=?, slug=?, description=?, duration_minutes=?, buffer_minutes=?,
      price_cents=?, currency=?, image_url=?, status=?, sort_order=?, updated_at=datetime('now')
    WHERE id=? AND lead_id=?
  `).run(name, slug, description, duration, buffer, priceCents, currency, image, status, sortOrder, raw.id, Number(leadId));
  return getBookingService(db, leadId, raw.id);
}

function deleteBookingService(db, leadId, id) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM booking_services WHERE lead_id = ? AND id = ?')
    .get(Number(leadId), Number(id));
  if (!row) throw fail('NOT_FOUND', 'Service not found', 404);
  db.prepare('DELETE FROM booking_services WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

function listAppointments(db, leadId, {
  status, from, to, limit = 200, includeArchived = false, archivedOnly = false,
} = {}) {
  ensureTables(db);
  let sql = `
    SELECT b.*, s.name AS service_name, s.duration_minutes AS service_duration
    FROM bookings b
    LEFT JOIN booking_services s ON s.id = b.service_id
    WHERE b.lead_id = ?
  `;
  const params = [Number(leadId)];
  if (status) {
    sql += ' AND b.status = ?';
    params.push(String(status));
  }
  if (archivedOnly) {
    sql += ' AND b.archived_at IS NOT NULL';
  } else if (!includeArchived) {
    sql += ' AND b.archived_at IS NULL';
  }
  if (from) {
    sql += ' AND b.starts_at >= ?';
    params.push(String(from));
  }
  if (to) {
    sql += ' AND b.starts_at <= ?';
    params.push(String(to));
  }
  sql += ' ORDER BY b.starts_at ASC, b.id ASC LIMIT ?';
  params.push(Math.min(500, Math.max(1, Number(limit) || 200)));
  return db.prepare(sql).all(...params);
}

function getAppointment(db, leadId, id) {
  ensureTables(db);
  return db.prepare(`
    SELECT b.*, s.name AS service_name, s.duration_minutes AS service_duration
    FROM bookings b
    LEFT JOIN booking_services s ON s.id = b.service_id
    WHERE b.lead_id = ? AND b.id = ?
  `).get(Number(leadId), Number(id));
}

function updateAppointmentStatus(db, leadId, id, status) {
  ensureTables(db);
  const row = getAppointment(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Appointment not found', 404);
  const st = String(status || '').toLowerCase();
  if (!BOOKING_STATUSES.includes(st)) {
    throw fail('VALIDATION', `status must be one of: ${BOOKING_STATUSES.join(', ')}`);
  }
  db.prepare(
    "UPDATE bookings SET status = ?, updated_at = datetime('now') WHERE id = ? AND lead_id = ?"
  ).run(st, row.id, Number(leadId));
  return getAppointment(db, leadId, row.id);
}

const ARCHIVABLE_STATUSES = ['completed', 'cancelled'];

function setAppointmentArchived(db, leadId, id, archived = true) {
  ensureTables(db);
  const row = getAppointment(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Appointment not found', 404);
  const want = archived === true || archived === 1 || String(archived).toLowerCase() === 'true';
  if (want) {
    if (!ARCHIVABLE_STATUSES.includes(String(row.status || '').toLowerCase())) {
      throw fail(
        'VALIDATION',
        `Only ${ARCHIVABLE_STATUSES.join(' or ')} appointments can be archived`
      );
    }
    db.prepare(
      "UPDATE bookings SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND lead_id = ?"
    ).run(row.id, Number(leadId));
  } else {
    db.prepare(
      'UPDATE bookings SET archived_at = NULL, updated_at = datetime(\'now\') WHERE id = ? AND lead_id = ?'
    ).run(row.id, Number(leadId));
  }
  return getAppointment(db, leadId, row.id);
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function listAvailableSlots(db, leadId, { date, serviceId, serviceSlug } = {}) {
  ensureTables(db);
  ensureDefaultBookingHours(db, leadId);
  const settings = getBookingSettings(db, leadId);
  const day = parseYmd(date);
  if (!day) throw fail('VALIDATION', 'date must be YYYY-MM-DD');

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const max = new Date(today);
  max.setDate(max.getDate() + settings.max_days_ahead);
  if (day < today) throw fail('VALIDATION', 'date is in the past');
  if (day > max) throw fail('VALIDATION', `date is beyond the ${settings.max_days_ahead}-day booking window`);

  let service = null;
  if (serviceId != null) service = getBookingService(db, leadId, serviceId);
  else if (serviceSlug) service = getBookingService(db, leadId, serviceSlug);
  else {
    const services = listBookingServices(db, leadId, { includeDrafts: false });
    if (services.length === 1) service = services[0];
  }
  if (!service || service.status !== 'published') {
    throw fail('VALIDATION', 'A published service is required (serviceId)');
  }

  const weekday = day.getDay();
  const windows = listBookingHours(db, leadId).filter((h) => Number(h.weekday) === weekday);
  if (!windows.length) {
    return {
      date: ymdFromDate(day),
      service: service,
      settings,
      slots: [],
      closed: true,
    };
  }

  const ymd = ymdFromDate(day);
  const blocks = listBookingBlocks(db, leadId, { from: ymd, to: ymd });
  const duration = Number(service.duration_minutes) || 30;
  const buffer = Number(service.buffer_minutes) || 0;
  const step = Math.max(5, Number(settings.slot_interval_minutes) || duration);
  const noticeMs = (Number(settings.min_notice_hours) || 0) * 60 * 60 * 1000;
  const earliest = Date.now() + noticeMs;

  const busy = listAppointments(db, leadId, {
    from: `${ymd}T00:00:00`,
    to: `${ymd}T23:59:59`,
  }).filter((b) => b.status === 'pending' || b.status === 'confirmed');

  const slots = [];
  for (const win of windows) {
    const wStart = parseHm(win.start_time);
    const wEnd = parseHm(win.end_time);
    if (wStart == null || wEnd == null) continue;
    for (let t = wStart; t + duration <= wEnd; t += step) {
      const startLabel = formatHm(t);
      const endLabel = formatHm(t + duration);
      const startIso = `${ymd}T${startLabel}:00`;
      const endIso = `${ymd}T${endLabel}:00`;
      const startMs = new Date(
        day.getFullYear(), day.getMonth(), day.getDate(),
        Math.floor(t / 60), t % 60, 0
      ).getTime();
      if (startMs < earliest) continue;

      let blocked = false;
      for (const bl of blocks) {
        if (!bl.start_time && !bl.end_time) { blocked = true; break; }
        const bs = parseHm(bl.start_time);
        const be = parseHm(bl.end_time);
        if (bs != null && be != null && rangesOverlap(t, t + duration, bs, be)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      let conflict = false;
      for (const b of busy) {
        const bStart = String(b.starts_at || '');
        const bEnd = String(b.ends_at || '');
        // Expand busy by buffer on both sides of existing appointment
        const bStartM = parseHm(bStart.slice(11, 16));
        const bEndM = parseHm(bEnd.slice(11, 16));
        if (bStartM == null || bEndM == null) continue;
        if (rangesOverlap(t, t + duration + buffer, bStartM - buffer, bEndM + buffer)) {
          conflict = true;
          break;
        }
      }
      if (conflict) continue;

      slots.push({
        starts_at: startIso,
        ends_at: endIso,
        label: startLabel,
      });
    }
  }

  return {
    date: ymd,
    service,
    settings,
    slots,
    closed: false,
  };
}

function createPublicBooking(db, leadId, data = {}) {
  ensureTables(db);
  ensureDefaultBookingHours(db, leadId);
  const settings = getBookingSettings(db, leadId);
  const service = getBookingService(db, leadId, data.service_id || data.serviceId || data.service);
  if (!service || service.status !== 'published') {
    throw fail('VALIDATION', 'service_id must reference a published service');
  }
  const name = String(data.customer_name || data.name || '').trim();
  const email = String(data.customer_email || data.email || '').trim();
  const phone = String(data.customer_phone || data.phone || '').trim();
  if (!name) throw fail('VALIDATION', 'customer_name is required');
  if (!email && !phone) throw fail('VALIDATION', 'customer_email or customer_phone is required');

  let startsAt = String(data.starts_at || data.start || '').trim();
  if (!startsAt && data.date && data.time) {
    const time = String(data.time).trim();
    const hm = parseHm(time.length === 5 ? time : time.slice(0, 5));
    if (!parseYmd(data.date) || hm == null) throw fail('VALIDATION', 'date and time must be YYYY-MM-DD and HH:MM');
    startsAt = `${data.date}T${formatHm(hm)}:00`;
  }
  const m = startsAt.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!m) throw fail('VALIDATION', 'starts_at must be YYYY-MM-DDTHH:MM');
  const date = m[1];
  const time = m[2];
  const duration = Number(service.duration_minutes) || 30;
  const startMins = parseHm(time);
  const endsAt = `${date}T${formatHm(startMins + duration)}:00`;

  const available = listAvailableSlots(db, leadId, { date, serviceId: service.id });
  const okSlot = (available.slots || []).some((s) => s.starts_at === `${date}T${time}:00` || s.label === time);
  if (!okSlot) throw fail('VALIDATION', 'That time slot is no longer available', 409);

  const status = settings.auto_confirm ? 'confirmed' : 'pending';
  const info = db.prepare(`
    INSERT INTO bookings
      (lead_id, service_id, customer_name, customer_email, customer_phone, starts_at, ends_at, notes, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(leadId),
    service.id,
    name.slice(0, 200),
    email.slice(0, 240),
    phone.slice(0, 60),
    `${date}T${time}:00`,
    endsAt,
    String(data.notes || '').slice(0, 2000),
    status
  );
  const appt = getAppointment(db, leadId, info.lastInsertRowid);
  try {
    const portalContacts = require('./portalContacts');
    portalContacts.captureFromBooking(db, {
      leadId,
      booking: appt,
      serviceName: service.name,
      pageSlug: '',
    });
  } catch (e) {
    console.warn('[siteModules] LeadScout booking capture failed:', e.message || e);
  }
  return appt;
}

function createAppointment(db, leadId, data = {}) {
  // Staff/portal create — may force a slot even if slightly outside public rules
  ensureTables(db);
  const service = getBookingService(db, leadId, data.service_id || data.serviceId || data.service);
  if (!service) throw fail('VALIDATION', 'service_id is required');
  const name = String(data.customer_name || data.name || '').trim();
  if (!name) throw fail('VALIDATION', 'customer_name is required');
  let startsAt = String(data.starts_at || data.start || '').trim();
  if (!startsAt && data.date && data.time) {
    startsAt = `${data.date}T${String(data.time).slice(0, 5)}:00`;
  }
  const m = startsAt.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!m) throw fail('VALIDATION', 'starts_at must be YYYY-MM-DDTHH:MM');
  const duration = Number(service.duration_minutes) || 30;
  const endsAt = data.ends_at
    ? String(data.ends_at)
    : `${m[1]}T${formatHm(parseHm(m[2]) + duration)}:00`;
  let status = String(data.status || 'confirmed').toLowerCase();
  if (!BOOKING_STATUSES.includes(status)) status = 'confirmed';
  const info = db.prepare(`
    INSERT INTO bookings
      (lead_id, service_id, customer_name, customer_email, customer_phone, starts_at, ends_at, notes, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(leadId),
    service.id,
    name.slice(0, 200),
    String(data.customer_email || data.email || '').slice(0, 240),
    String(data.customer_phone || data.phone || '').slice(0, 60),
    `${m[1]}T${m[2]}:00`,
    endsAt,
    String(data.notes || '').slice(0, 2000),
    status
  );
  const appt = getAppointment(db, leadId, info.lastInsertRowid);
  try {
    const portalContacts = require('./portalContacts');
    portalContacts.captureFromBooking(db, {
      leadId,
      booking: appt,
      serviceName: service.name,
      pageSlug: '',
    });
  } catch (e) {
    console.warn('[siteModules] LeadScout appointment capture failed:', e.message || e);
  }
  return appt;
}

function deleteAppointment(db, leadId, id) {
  ensureTables(db);
  const row = getAppointment(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Appointment not found', 404);
  db.prepare('DELETE FROM bookings WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

function moduleItemCount(db, leadId, type) {
  if (type === 'blog') return listBlogPosts(db, leadId).length;
  if (type === 'ecommerce') return listProducts(db, leadId).length;
  if (type === 'courses') return listCourses(db, leadId, { withLessons: false }).length;
  if (type === 'gallery') return listAlbums(db, leadId, { withImages: false }).length;
  if (type === 'directory') return listListings(db, leadId).length;
  if (type === 'faq') return listFaqItems(db, leadId).length;
  if (type === 'testimonials') return listTestimonials(db, leadId).length;
  if (type === 'team') return listTeamMembers(db, leadId).length;
  if (type === 'events') return listEvents(db, leadId).length;
  if (type === 'bookings') {
    // Nav badge: active appointments only (exclude archived).
    ensureTables(db);
    const row = db.prepare(
      'SELECT COUNT(*) AS c FROM bookings WHERE lead_id = ? AND archived_at IS NULL'
    ).get(Number(leadId));
    return Number(row && row.c) || 0;
  }
  if (type === 'chatbot') {
    try { return require('./chatbot').listKnowledge(db, leadId).length; } catch { return 0; }
  }
  return 0;
}

/* ── Public payload for embed ── */

function getPublicModuleByToken(db, token) {
  ensureTables(db);
  const row = db.prepare(
    'SELECT * FROM site_module_embeds WHERE public_token = ? AND published = 1'
  ).get(String(token || ''));
  if (!row) throw fail('NOT_FOUND', 'Module not found', 404);
  const leadId = row.lead_id;
  const type = row.module_type;
  const settings = parseEmbedSettings(row);
  let items = [];
  let booking = null;
  let total_published = null;
  if (type === 'blog') {
    items = listBlogPosts(db, leadId, { includeDrafts: false }).map((p) => ({
      ...p,
      excerpt: String(p.excerpt || '').trim() || deriveExcerptFromBody(p.body_html, 30),
    }));
    total_published = items.length;
    if (settings.post_limit != null) items = items.slice(0, settings.post_limit);
  } else if (type === 'ecommerce') {
    items = listProducts(db, leadId, { includeDrafts: false }).map((p) => ({
      ...p,
      price_label: formatPrice(p.price_cents, p.currency),
    }));
  } else if (type === 'courses') items = listCourses(db, leadId, { includeDrafts: false, withLessons: true });
  else if (type === 'gallery') items = listAlbums(db, leadId, { includeDrafts: false, withImages: true });
  else if (type === 'directory') items = listListings(db, leadId, { includeDrafts: false });
  else if (type === 'faq') items = listFaqItems(db, leadId, { includeDrafts: false });
  else if (type === 'testimonials') items = listTestimonials(db, leadId, { includeDrafts: false });
  else if (type === 'team') items = listTeamMembers(db, leadId, { includeDrafts: false });
  else if (type === 'events') items = listEvents(db, leadId, { includeDrafts: false });
  else if (type === 'bookings') {
    ensureDefaultBookingHours(db, leadId);
    items = listBookingServices(db, leadId, { includeDrafts: false });
    booking = {
      settings: getBookingSettings(db, leadId),
      hours: listBookingHours(db, leadId),
    };
  } else if (type === 'chatbot') {
    try {
      const chat = require('./chatbot');
      return {
        ...chat.getPublicConfigByToken(db, row.public_token),
        items: [],
      };
    } catch (e) {
      throw fail('NOT_FOUND', e.message || 'Chatbot not found', 404);
    }
  }

  const out = {
    embed: publicEmbed(row),
    module_type: type,
    title: row.title || MODULE_META[type]?.label || type,
    settings,
    items,
  };
  if (total_published != null) {
    out.total_published = total_published;
    out.post_limit = settings.post_limit;
    out.show_excerpt = settings.show_excerpt;
    out.truncated = settings.post_limit != null && total_published > items.length;
  }
  if (booking) out.booking = booking;
  return out;
}

function getPublicModuleItem(db, token, slugOrId) {
  const payload = getPublicModuleByToken(db, token);
  const type = payload.module_type;
  const leadId = payload.embed.lead_id;
  let item = null;
  if (type === 'blog') item = getBlogPost(db, leadId, slugOrId);
  else if (type === 'ecommerce') {
    item = getProduct(db, leadId, slugOrId);
    if (item) item = { ...item, price_label: formatPrice(item.price_cents, item.currency) };
  } else if (type === 'courses') item = getCourse(db, leadId, slugOrId);
  else if (type === 'gallery') item = getAlbum(db, leadId, slugOrId);
  else if (type === 'directory') item = getListing(db, leadId, slugOrId);
  else if (type === 'faq') item = getFaqItem(db, leadId, slugOrId);
  else if (type === 'testimonials') item = getTestimonial(db, leadId, slugOrId);
  else if (type === 'team') item = getTeamMember(db, leadId, slugOrId);
  else if (type === 'events') item = getEvent(db, leadId, slugOrId);
  else if (type === 'bookings') item = getBookingService(db, leadId, slugOrId);
  if (!item || (item.status && item.status !== 'published')) {
    throw fail('NOT_FOUND', 'Item not found', 404);
  }
  return { ...payload, item };
}

function getPublicBookingSlots(db, token, { date, serviceId, serviceSlug } = {}) {
  ensureTables(db);
  const row = db.prepare(
    'SELECT * FROM site_module_embeds WHERE public_token = ? AND published = 1'
  ).get(String(token || ''));
  if (!row || row.module_type !== 'bookings') {
    throw fail('NOT_FOUND', 'Bookings module not found', 404);
  }
  return {
    embed: publicEmbed(row),
    module_type: 'bookings',
    title: row.title || MODULE_META.bookings.label,
    ...listAvailableSlots(db, row.lead_id, { date, serviceId, serviceSlug }),
  };
}

function createPublicBookingByToken(db, token, data = {}) {
  ensureTables(db);
  const row = db.prepare(
    'SELECT * FROM site_module_embeds WHERE public_token = ? AND published = 1'
  ).get(String(token || ''));
  if (!row || row.module_type !== 'bookings') {
    throw fail('NOT_FOUND', 'Bookings module not found', 404);
  }
  const appointment = createPublicBooking(db, row.lead_id, data);
  return {
    embed: publicEmbed(row),
    appointment: {
      id: appointment.id,
      service_id: appointment.service_id,
      service_name: appointment.service_name,
      starts_at: appointment.starts_at,
      ends_at: appointment.ends_at,
      status: appointment.status,
      customer_name: appointment.customer_name,
    },
    message: appointment.status === 'confirmed'
      ? 'Your appointment is confirmed.'
      : 'Request received — we will confirm your appointment soon.',
  };
}

/** Portal summary for all modules. */
function portalSummary(db, leadId, { appUrl, siteModules = false } = {}) {
  ensureTables(db);
  const pages = listSitePages(db, leadId);
  const embeds = listEmbeds(db, leadId).map((e) => publicEmbed(e, appUrl));
  return {
    siteModules: !!siteModules,
    modules: MODULE_TYPES.map((type) => {
      const emb = embeds.find((e) => e.module_type === type) || null;
      return {
        type,
        label: MODULE_META[type].label,
        count: moduleItemCount(db, leadId, type),
        embed: emb,
      };
    }),
    pages,
  };
}

module.exports = {
  MODULE_TYPES,
  MODULE_META,
  BOOKING_STATUSES,
  ensureTables,
  parseWorkspaceFromToken,
  makePublicToken,
  listSitePages,
  listEmbeds,
  getEmbedRow,
  ensureEmbed,
  publicEmbed,
  attachModule,
  detachModule,
  parseEmbedSettings,
  writeEmbedSettings,
  maybeProvisionBookingsCompanionForm,
  syncSiteModuleEmbeds,
  syncPublishedModules,
  rebuildFreeformPrimaryNav,
  shellHtmlFromPages,
  fillShellMain,
  PAGE_CHROME_CSS,
  ensurePageChromeStyle,
  defaultClientPageInner,
  ensureClientPageChrome,
  contentSectionHtml,
  injectContentSectionIntoHtml,
  withMainClass,
  embedBlockHtml,
  moduleScriptTag,
  ensureModuleEmbedScript,
  injectHtmlEmbed,
  htmlHasModuleToken,
  stripInactiveModuleEmbedsFromHtml,
  pagesHaveModuleToken,
  pageServesModulePurpose,
  describeWouldInject,
  stripManagedModuleEmbedsFromHtml,
  deriveExcerptFromBody,
  parseEmbedSettings,
  writeEmbedSettings,
  listBlogPosts,
  getBlogPost,
  createBlogPost,
  updateBlogPost,
  deleteBlogPost,
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  formatPrice,
  listCourses,
  getCourse,
  createCourse,
  updateCourse,
  deleteCourse,
  addLesson,
  updateLesson,
  deleteLesson,
  listAlbums,
  getAlbum,
  createAlbum,
  updateAlbum,
  deleteAlbum,
  addGalleryImage,
  deleteGalleryImage,
  listListings,
  getListing,
  createListing,
  updateListing,
  deleteListing,
  listFaqItems,
  getFaqItem,
  createFaqItem,
  updateFaqItem,
  deleteFaqItem,
  listTestimonials,
  getTestimonial,
  createTestimonial,
  updateTestimonial,
  deleteTestimonial,
  listTeamMembers,
  getTeamMember,
  createTeamMember,
  updateTeamMember,
  deleteTeamMember,
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  getBookingSettings,
  updateBookingSettings,
  listBookingHours,
  ensureDefaultBookingHours,
  setBookingHours,
  listBookingBlocks,
  createBookingBlock,
  deleteBookingBlock,
  listBookingServices,
  getBookingService,
  createBookingService,
  updateBookingService,
  deleteBookingService,
  listAppointments,
  moduleItemCount,
  getAppointment,
  createAppointment,
  updateAppointmentStatus,
  setAppointmentArchived,
  deleteAppointment,
  listAvailableSlots,
  createPublicBooking,
  getPublicModuleByToken,
  getPublicModuleItem,
  getPublicBookingSlots,
  createPublicBookingByToken,
  portalSummary,
  embedBlockHtml,
};
