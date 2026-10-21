'use strict';

const domain = require('./domain');
const jobs = require('./jobs');
const { createWorkspaceToken } = require('./workspace');
const { portalToolDefs, dispatchPortalTool } = require('./clientMcp');

const SERVER_INFO = {
  name: 'website-scout-web-mcp',
  version: '0.2.0',
  title: 'BitPype Website Scout',
  description: [
    'TOOLS ONLY: use only tools from tools/list (or the matching /api/v1 routes). Do not invent DIY CRMs, hand-rolled forms, booking widgets, chat stacks, or other parallel systems when a tool is missing or denied — report the gap and stop.',
    'Access order (2026-10-19): prefer the REST API at /api/v1 (Bearer workspace token) for leads, design jobs, and websites.',
    'MCP is the transport fallback when the API is unreachable, and remains the surface for long-tail tools not mirrored on the API.',
    'Portal/cl_ tokens are site-scoped; workspace/ws_ tokens get the outreach lead pipeline (lead.search).',
    'OpenAPI: GET /api/v1/openapi.json · Health: GET /api/v1/health (no auth).',
    'Idempotency-Key on POST /api/v1/leads, POST /api/v1/design/jobs, POST .../deliver is shared with MCP writes of the same operation.',
  ].join(' '),
};
const PROTOCOL_VERSION = '2025-11-25';

const ID = { type: 'integer', minimum: 1 };
const STR = { type: 'string' };
function schema(properties = {}, required = []) {
  return required.length ? { type: 'object', properties, required } : { type: 'object', properties };
}

/** Client lead-scoped tools (Standard/Premium portal MCP; also on workspace tokens with leadId). */
function clientToolDefs() {
  return [
    ...portalToolDefs(),
    {
      name: 'social.posts.list',
      description: 'List social posts for scheduling. Premium only (socialMcpSchedule). Prefer social.calendar for read-only month view.',
      inputSchema: schema({
        leadId: ID,
        status: STR,
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      }),
    },
    {
      name: 'social.posts.update',
      description: 'Update a social post (caption, scheduled_at, status). Premium socialMcpSchedule.',
      inputSchema: schema({
        id: ID,
        leadId: ID,
        caption: STR,
        scheduled_at: STR,
        status: STR,
        client_notes: STR,
      }, ['id']),
    },
    {
      name: 'social.posts.approve',
      description: 'Approve posts → status scheduled. Premium socialMcpSchedule.',
      inputSchema: schema({
        leadId: ID,
        postIds: { type: 'array', items: ID },
      }, ['postIds']),
    },
    {
      name: 'website.addModule',
      description: 'Attach a site module (blog|ecommerce|courses|gallery|directory|faq|testimonials|team|events|bookings|chatbot) into the live site template with an in-page JS mount (not an iframe). Standard/Premium siteModules. chatbot = sitewide floating bubble (chat-embed.js); visitor replies go through portal CLIENT MCP chatbot.* only — never admin design.*/lead.* or workspace ws_ tokens. INTENT: appointments with availability → bookings module (never a contact form); then bookings.createService (published) + bookings.setHours. Structured requests → forms.create purpose=…; general inquiries → contact form. Alias: modules.attach. Bookings: optional show_request_form. After attach, call site.publish. Non-bookings attach on appointment-intent pages returns a warning. STYLING: wrap mount; theme.customCss under .bitpype-module-embed.',
      inputSchema: schema({
        leadId: ID,
        module: { type: 'string', enum: ['blog', 'ecommerce', 'courses', 'gallery', 'directory', 'faq', 'testimonials', 'team', 'events', 'bookings', 'chatbot'] },
        moduleType: { type: 'string', enum: ['blog', 'ecommerce', 'courses', 'gallery', 'directory', 'faq', 'testimonials', 'team', 'events', 'bookings', 'chatbot'] },
        title: STR,
        target_page_slug: STR,
        pageSlug: STR,
        show_request_form: { type: 'boolean' },
        settings: { type: 'object' },
      }),
    },
    {
      name: 'modules.list',
      description: 'List site module embeds (in-page JS mounts), public tokens, target pages, and item counts for a lead. Standard/Premium siteModules. Style mounts via theme.customCss on .bitpype-module-embed / section[data-ws-section-type="site_module"].',
      inputSchema: schema({ leadId: ID }),
    },
    {
      name: 'forms.list',
      description: 'List custom BitPype forms for a lead (or websiteId). Returns form records + managed embed snippets (bitpype-form-embed + form-embed.js). Prefer contact_form / forms.create over raw HTML <form>.',
      inputSchema: schema({ leadId: ID, websiteId: ID, siteId: ID }),
    },
    {
      name: 'forms.get',
      description: 'Get one custom form by formId (or first form for lead) plus managed embed snippet.',
      inputSchema: schema({ leadId: ID, formId: ID, id: ID, websiteId: ID }, ['leadId']),
    },
    {
      name: 'forms.create',
      description: 'Create + publish a custom form for a lead. Row starts draft in DB; this tool publishes immediately (status published, public_token). Embed sync only attaches to target_page_slug — if that page is missing, form stays unembedded (see website.get formsUnembedded). Required: leadId + (name OR purpose). purpose: general_inquiry|quote_request|appointment_request|callback_request|event_rsvp. fields[]: { label, type: text|email|phone|textarea|select|date|checkbox, required?, options? }. Optional submit_label, success_message, notify_email, embed_enabled, add_to_nav (default false). Returns formId + managed-embed snippet. Place with website.addBlock (blockType form + formId) or form/bitpype_form section { content: { formId } }.',
      inputSchema: schema({
        leadId: ID,
        name: STR,
        title: STR,
        purpose: STR,
        fields: { type: 'array', items: { type: 'object' } },
        submit_label: STR,
        submitLabel: STR,
        success_message: STR,
        successMessage: STR,
        notify_email: STR,
        notifyEmail: STR,
        target_page_slug: STR,
        targetPageSlug: STR,
        intro: STR,
        embed_enabled: { type: 'boolean' },
        embed_on_page: { type: 'boolean' },
        add_to_nav: { type: 'boolean' },
        nav_visible: { type: 'boolean' },
      }, ['leadId']),
    },
    {
      name: 'forms.suggestFields',
      description: 'Preview purpose-built typed fields for a lead without creating a form. purpose: appointment_request|quote_request|callback_request|event_rsvp|general_inquiry. Uses lead booking services, team, hours, and events for select options.',
      inputSchema: schema({
        leadId: ID,
        purpose: { type: 'string', enum: ['appointment_request', 'quote_request', 'callback_request', 'event_rsvp', 'general_inquiry'] },
      }, ['leadId', 'purpose']),
    },
    {
      name: 'forms.update',
      description: 'Update a custom form (name, fields, submit_label, success_message, notify_email, embed_enabled/embed_on_page, add_to_nav/nav_visible). embed_enabled:false removes the on-page panel and form-embed.js for that form.',
      inputSchema: schema({
        leadId: ID,
        formId: ID,
        id: ID,
        name: STR,
        title: STR,
        fields: { type: 'array', items: { type: 'object' } },
        submit_label: STR,
        success_message: STR,
        notify_email: STR,
        embed_enabled: { type: 'boolean' },
        embed_on_page: { type: 'boolean' },
        add_to_nav: { type: 'boolean' },
        nav_visible: { type: 'boolean' },
        target_page_slug: STR,
      }, ['leadId', 'formId']),
    },
    {
      name: 'forms.delete',
      description: 'Delete a custom form (keeps at least one form per lead).',
      inputSchema: schema({ leadId: ID, formId: ID, id: ID }, ['leadId', 'formId']),
    },
    {
      name: 'blog.list',
      description: 'List blog posts for a lead. Standard/Premium siteModules.',
      inputSchema: schema({ leadId: ID, includeDrafts: { type: 'boolean' } }),
    },
    {
      name: 'blog.create',
      description: 'Create a blog post (title, slug, body_html, excerpt optional, cover_image, status draft|published). Excerpt auto-derives from body when omitted. Standard/Premium.',
      inputSchema: schema({
        leadId: ID,
        title: STR,
        slug: STR,
        body_html: STR,
        body: STR,
        excerpt: STR,
        cover_image: STR,
        status: STR,
      }, ['title']),
    },
    {
      name: 'blog.update',
      description: 'Update a blog post by id (optional excerpt). Standard/Premium.',
      inputSchema: schema({
        id: ID,
        leadId: ID,
        title: STR,
        slug: STR,
        body_html: STR,
        excerpt: STR,
        cover_image: STR,
        status: STR,
      }, ['id']),
    },
    {
      name: 'blog.delete',
      description: 'Delete a blog post by id. Standard/Premium.',
      inputSchema: schema({ id: ID, leadId: ID }, ['id']),
    },
    {
      name: 'ecommerce.list',
      description: 'List ecommerce products for a lead. Standard/Premium.',
      inputSchema: schema({ leadId: ID, includeDrafts: { type: 'boolean' } }),
    },
    {
      name: 'ecommerce.create',
      description: 'Create a product (name, price or price_cents, description, image_url, checkout_url, status). Standard/Premium.',
      inputSchema: schema({
        leadId: ID,
        name: STR,
        slug: STR,
        description: STR,
        price: { type: 'number' },
        price_cents: { type: 'integer' },
        currency: STR,
        image_url: STR,
        checkout_url: STR,
        status: STR,
      }, ['name']),
    },
    {
      name: 'ecommerce.update',
      description: 'Update a product by id. Standard/Premium.',
      inputSchema: schema({
        id: ID,
        leadId: ID,
        name: STR,
        slug: STR,
        description: STR,
        price: { type: 'number' },
        price_cents: { type: 'integer' },
        currency: STR,
        image_url: STR,
        checkout_url: STR,
        status: STR,
      }, ['id']),
    },
    {
      name: 'ecommerce.delete',
      description: 'Delete a product by id. Standard/Premium.',
      inputSchema: schema({ id: ID, leadId: ID }, ['id']),
    },
    {
      name: 'courses.list',
      description: 'List courses with lessons for a lead. Standard/Premium.',
      inputSchema: schema({ leadId: ID, includeDrafts: { type: 'boolean' } }),
    },
    {
      name: 'courses.create',
      description: 'Create a course (title, description, enrollment_url, optional lessons[]). Standard/Premium.',
      inputSchema: schema({
        leadId: ID,
        title: STR,
        slug: STR,
        description: STR,
        enrollment_url: STR,
        cover_image: STR,
        status: STR,
        lessons: { type: 'array', items: { type: 'object' } },
      }, ['title']),
    },
    {
      name: 'courses.update',
      description: 'Update a course by id. Standard/Premium.',
      inputSchema: schema({
        id: ID,
        leadId: ID,
        title: STR,
        slug: STR,
        description: STR,
        enrollment_url: STR,
        cover_image: STR,
        status: STR,
      }, ['id']),
    },
    {
      name: 'courses.delete',
      description: 'Delete a course and its lessons. Standard/Premium.',
      inputSchema: schema({ id: ID, leadId: ID }, ['id']),
    },
    {
      name: 'courses.addLesson',
      description: 'Add a lesson to a course (title, body_html, lesson_url). Standard/Premium.',
      inputSchema: schema({
        courseId: ID,
        leadId: ID,
        title: STR,
        body_html: STR,
        lesson_url: STR,
        sort_order: { type: 'integer' },
      }, ['courseId', 'title']),
    },
    {
      name: 'gallery.list',
      description: 'List gallery albums with images. Standard/Premium.',
      inputSchema: schema({ leadId: ID, includeDrafts: { type: 'boolean' } }),
    },
    {
      name: 'gallery.create',
      description: 'Create a gallery album (title, description, optional images[{image_url,caption}]). Standard/Premium.',
      inputSchema: schema({
        leadId: ID,
        title: STR,
        slug: STR,
        description: STR,
        status: STR,
        images: { type: 'array', items: { type: 'object' } },
      }, ['title']),
    },
    {
      name: 'gallery.update',
      description: 'Update a gallery album by id. Standard/Premium.',
      inputSchema: schema({
        id: ID,
        leadId: ID,
        title: STR,
        slug: STR,
        description: STR,
        status: STR,
      }, ['id']),
    },
    {
      name: 'gallery.delete',
      description: 'Delete a gallery album and its images. Standard/Premium.',
      inputSchema: schema({ id: ID, leadId: ID }, ['id']),
    },
    {
      name: 'gallery.addImage',
      description: 'Add an image to a gallery album. Standard/Premium.',
      inputSchema: schema({
        albumId: ID,
        leadId: ID,
        image_url: STR,
        caption: STR,
        sort_order: { type: 'integer' },
      }, ['albumId', 'image_url']),
    },
    {
      name: 'directory.list',
      description: 'List directory listings. Standard/Premium.',
      inputSchema: schema({ leadId: ID, category: STR, includeDrafts: { type: 'boolean' } }),
    },
    {
      name: 'directory.create',
      description: 'Create a directory listing (name, category, contact, description, image_url, website_url). Standard/Premium.',
      inputSchema: schema({
        leadId: ID,
        name: STR,
        category: STR,
        description: STR,
        contact_email: STR,
        contact_phone: STR,
        website_url: STR,
        image_url: STR,
        status: STR,
      }, ['name']),
    },
    {
      name: 'directory.update',
      description: 'Update a directory listing by id. Standard/Premium.',
      inputSchema: schema({
        id: ID,
        leadId: ID,
        name: STR,
        category: STR,
        description: STR,
        contact_email: STR,
        contact_phone: STR,
        website_url: STR,
        image_url: STR,
        status: STR,
      }, ['id']),
    },
    {
      name: 'directory.delete',
      description: 'Delete a directory listing by id. Standard/Premium.',
      inputSchema: schema({ id: ID, leadId: ID }, ['id']),
    },
    {
      name: 'faq.list',
      description: 'List FAQ items for a lead. Standard/Premium.',
      inputSchema: schema({ leadId: ID, includeDrafts: { type: 'boolean' }, category: STR }),
    },
    {
      name: 'faq.create',
      description: 'Create an FAQ item (question, answer_html, category, status). Standard/Premium.',
      inputSchema: schema({
        leadId: ID, question: STR, answer_html: STR, answer: STR, category: STR, status: STR,
      }, ['question']),
    },
    {
      name: 'faq.update',
      description: 'Update an FAQ item by id. Standard/Premium.',
      inputSchema: schema({
        id: ID, leadId: ID, question: STR, answer_html: STR, category: STR, status: STR,
      }, ['id']),
    },
    {
      name: 'faq.delete',
      description: 'Delete an FAQ item by id. Standard/Premium.',
      inputSchema: schema({ id: ID, leadId: ID }, ['id']),
    },
    {
      name: 'testimonials.list',
      description: 'List testimonials for a lead. Standard/Premium.',
      inputSchema: schema({ leadId: ID, includeDrafts: { type: 'boolean' } }),
    },
    {
      name: 'testimonials.create',
      description: 'Create a testimonial (quote, author, rating 1-5, status). Standard/Premium.',
      inputSchema: schema({
        leadId: ID, quote: STR, author_name: STR, author_title: STR, author_company: STR,
        rating: { type: 'number' }, image_url: STR, status: STR,
      }, ['quote']),
    },
    {
      name: 'testimonials.update',
      description: 'Update a testimonial by id. Standard/Premium.',
      inputSchema: schema({
        id: ID, leadId: ID, quote: STR, author_name: STR, author_title: STR, author_company: STR,
        rating: { type: 'number' }, image_url: STR, status: STR,
      }, ['id']),
    },
    {
      name: 'testimonials.delete',
      description: 'Delete a testimonial by id. Standard/Premium.',
      inputSchema: schema({ id: ID, leadId: ID }, ['id']),
    },
    {
      name: 'team.list',
      description: 'List team members for a lead. Standard/Premium.',
      inputSchema: schema({ leadId: ID, includeDrafts: { type: 'boolean' } }),
    },
    {
      name: 'team.create',
      description: 'Create a team member (name, role_title, bio, image_url, status). Standard/Premium.',
      inputSchema: schema({
        leadId: ID, name: STR, slug: STR, role_title: STR, bio: STR, image_url: STR,
        email: STR, phone: STR, social_url: STR, status: STR,
      }, ['name']),
    },
    {
      name: 'team.update',
      description: 'Update a team member by id. Standard/Premium.',
      inputSchema: schema({
        id: ID, leadId: ID, name: STR, slug: STR, role_title: STR, bio: STR, image_url: STR,
        email: STR, phone: STR, social_url: STR, status: STR,
      }, ['id']),
    },
    {
      name: 'team.delete',
      description: 'Delete a team member by id. Standard/Premium.',
      inputSchema: schema({ id: ID, leadId: ID }, ['id']),
    },
    {
      name: 'events.list',
      description: 'List events for a lead. Standard/Premium.',
      inputSchema: schema({ leadId: ID, includeDrafts: { type: 'boolean' } }),
    },
    {
      name: 'events.create',
      description: 'Create an event (title, starts_at, location, ticket_url, status). Standard/Premium.',
      inputSchema: schema({
        leadId: ID, title: STR, slug: STR, description: STR, starts_at: STR, ends_at: STR,
        location: STR, image_url: STR, ticket_url: STR, status: STR,
      }, ['title']),
    },
    {
      name: 'events.update',
      description: 'Update an event by id. Standard/Premium.',
      inputSchema: schema({
        id: ID, leadId: ID, title: STR, slug: STR, description: STR, starts_at: STR, ends_at: STR,
        location: STR, image_url: STR, ticket_url: STR, status: STR,
      }, ['id']),
    },
    {
      name: 'events.delete',
      description: 'Delete an event by id. Standard/Premium.',
      inputSchema: schema({ id: ID, leadId: ID }, ['id']),
    },
    {
      name: 'bookings.services',
      description: 'List bookable services (duration, buffer, price). includeDrafts defaults true. Standard/Premium siteModules.',
      inputSchema: schema({ leadId: ID, includeDrafts: { type: 'boolean' } }, ['leadId']),
    },
    {
      name: 'bookings.createService',
      description: 'Create a bookable service. Default status is draft — set status:"published" (here or via bookings.updateService) before bookings.slots returns times. INTENT: appointment pages with availability use website.addModule(bookings) + published service(s) + bookings.setHours — never a contact form. website.qa module-fit requires ≥1 published service with hours. E2E: createService → publish → setHours → slots. Required: leadId, name.',
      inputSchema: schema({
        leadId: ID, name: STR, slug: STR, description: STR,
        duration_minutes: { type: 'integer' }, buffer_minutes: { type: 'integer' },
        price: { type: 'number' }, price_cents: { type: 'integer' }, currency: STR,
        image_url: STR, status: { type: 'string', enum: ['draft', 'published'] },
      }, ['leadId', 'name']),
    },
    {
      name: 'bookings.updateService',
      description: 'Update a bookable service by id. Use status:"published" to expose in slots/widget. Standard/Premium.',
      inputSchema: schema({
        id: ID, leadId: ID, name: STR, slug: STR, description: STR,
        duration_minutes: { type: 'integer' }, buffer_minutes: { type: 'integer' },
        price: { type: 'number' }, price_cents: { type: 'integer' }, currency: STR,
        image_url: STR, status: { type: 'string', enum: ['draft', 'published'] },
      }, ['id', 'leadId']),
    },
    {
      name: 'bookings.deleteService',
      description: 'Delete a bookable service by id. Standard/Premium.',
      inputSchema: schema({ id: ID, leadId: ID }, ['id', 'leadId']),
    },
    {
      name: 'bookings.setHours',
      description: 'Replace weekly availability hours (weekday 0=Sun..6=Sat, start_time/end_time HH:MM). Replaces the whole week. Standard/Premium.',
      inputSchema: schema({
        leadId: ID,
        hours: { type: 'array', items: { type: 'object' } },
      }, ['leadId', 'hours']),
    },
    {
      name: 'bookings.getHours',
      description: 'List weekly availability hours and booking settings. Standard/Premium.',
      inputSchema: schema({ leadId: ID }, ['leadId']),
    },
    {
      name: 'bookings.setSettings',
      description: 'Update booking settings (timezone, slot_interval_minutes, min_notice_hours, max_days_ahead, auto_confirm). Standard/Premium.',
      inputSchema: schema({
        leadId: ID, timezone: STR,
        slot_interval_minutes: { type: 'integer' },
        min_notice_hours: { type: 'integer' },
        max_days_ahead: { type: 'integer' },
        auto_confirm: { type: 'boolean' },
      }, ['leadId']),
    },
    {
      name: 'bookings.list',
      description: 'List appointments (pending/confirmed/cancelled/completed). Default excludes archived. Pass includeArchived or archivedOnly. Standard/Premium.',
      inputSchema: schema({
        leadId: ID, status: STR, from: STR, to: STR, limit: { type: 'integer' },
        includeArchived: { type: 'boolean' }, archivedOnly: { type: 'boolean' },
      }, ['leadId']),
    },
    {
      name: 'bookings.updateStatus',
      description: 'Update appointment status (pending|confirmed|cancelled|completed) and/or archive (archived:true|false; completed/cancelled only). Standard/Premium.',
      inputSchema: schema({
        id: ID, leadId: ID, status: STR, archived: { type: 'boolean' },
      }, ['id', 'leadId']),
    },
    {
      name: 'bookings.slots',
      description: 'List available time slots for date (YYYY-MM-DD) + published serviceId. Requires leadId, date, and serviceId when multiple services exist. Standard/Premium.',
      inputSchema: schema({
        leadId: ID, date: STR, serviceId: ID, service_id: ID,
      }, ['leadId', 'date']),
    },
  ];
}

function toolDefs({ clientScoped = false } = {}) {
  if (clientScoped) return clientToolDefs();
  return [
    ...clientToolDefs(),
    { name: 'lead.search', description: 'Search outreach CRM leads (pipeline). Requires a workspace MCP token (ws_…). Client/portal tokens (cl_…, Claude OAuth) cannot use this — they only see LeadScout form contacts via leadscout.contacts.list, or their one linked lead via site.get.', inputSchema: { type: 'object', properties: { q: { type: 'string' }, status: { type: 'string' }, minScore: { type: 'integer' }, limit: { type: 'integer' } } } },
    { name: 'lead.get', description: 'Get one lead with facts/scores.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'lead.create', description: 'Create a lead.', inputSchema: { type: 'object', properties: { business_name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, city: { type: 'string' }, category: { type: 'string' }, website: { type: 'string' }, status: { type: 'string' }, notes: { type: 'string' } }, required: ['business_name'] } },
    { name: 'lead.update', description: 'Update a lead.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'lead.delete', description: 'Delete a lead.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'lead.qualify', description: 'Qualify a lead.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'lead.score', description: 'Score a lead.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'lead.research', description: 'Research a lead.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'lead.discover', description: 'Discover leads via providers.', inputSchema: { type: 'object', properties: { category: { type: 'string' }, location: { type: 'string' }, limit: { type: 'integer' }, provider: { type: 'string' }, group: { type: 'string' } } } },
    { name: 'lead.importCsv', description: 'Import CSV text. Accepts standard lead headers and GapScout exports (project, business, platform, profile_url, location, website, email, phone, score, opportunity, signal_evidence, status, notes). Skips rows whose profile_url/source_ref already exists.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, group: { type: 'string' } }, required: ['text'] } },
    { name: 'lead.merge', description: 'Merge duplicate leads.', inputSchema: { type: 'object', properties: { keepId: { type: 'integer' }, dropIds: { type: 'array', items: { type: 'integer' } } }, required: ['keepId', 'dropIds'] } },
    { name: 'lead.duplicates', description: 'Find duplicates for a lead.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'lead.facets', description: 'Lead filter facets.', inputSchema: { type: 'object', properties: {} } },
    { name: 'lead.bulk', description: 'Bulk lead actions.', inputSchema: { type: 'object', properties: { action: { type: 'string' }, ids: { type: 'array', items: { type: 'integer' } }, value: { type: 'string' } }, required: ['action', 'ids'] } },
    { name: 'design.pending', description: 'Jobs waiting on agent.', inputSchema: { type: 'object', properties: {} } },
    { name: 'design.next', description: 'Claim next waiting_on_agent job.', inputSchema: { type: 'object', properties: {} } },
    { name: 'design.list', description: 'List design jobs.', inputSchema: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'integer' } } } },
    { name: 'design.get', description: 'Get design job.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'design.create', description: 'Create design job.', inputSchema: { type: 'object', properties: { type: { type: 'string' }, title: { type: 'string' }, instructions: { type: 'string' }, leadId: { type: 'integer' } }, required: ['title', 'instructions'] } },
    { name: 'design.deliver', description: 'Deliver design payload. Change requests attach change_verification + change_summary (website.qa + nav/form). Downloads remote images locally. Auto-provisions BitPype forms. Strips hand-rolled <form>. MODULES+FORMS STYLING via theme.customCss.', inputSchema: { type: 'object', properties: { id: { type: 'integer' }, payload: { type: 'object' }, claims: { type: 'array' } }, required: ['id', 'payload'] } },
    { name: 'design.ask', description: 'Ask clarifying question.', inputSchema: { type: 'object', properties: { id: { type: 'integer' }, question: { type: 'string' } }, required: ['id', 'question'] } },
    { name: 'design.review', description: 'Review delivered website (no screenshots on web).', inputSchema: { type: 'object', properties: { id: { type: 'integer' }, skipAi: { type: 'boolean' } }, required: ['id'] } },
    { name: 'design.redesign', description: 'Queue full redesign.', inputSchema: { type: 'object', properties: { id: { type: 'integer' }, instructions: { type: 'string' } }, required: ['id'] } },
    { name: 'design.improve', description: 'Queue incremental improvements.', inputSchema: { type: 'object', properties: { id: { type: 'integer' }, instructions: { type: 'string' } }, required: ['id'] } },
    { name: 'design.previewUrl', description: 'HTTP preview URL for delivered site.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'website.list', description: 'List websites.', inputSchema: { type: 'object', properties: { status: { type: 'string' } } } },
    { name: 'website.get', description: 'Get website (parsed pages/theme, latest version_note, formsUnembedded when embed target page missing).', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'website.delete', description: 'Delete a website record and purge its EXPORT_ROOT folders (ws-{workspace}-site-{id}*, site-{id}, screenshots, legacy slug exports). Does not wipe other workspaces or delete remote Cloudflare Pages projects. Design jobs are unlinked, not deleted.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'website.generate', description: 'Generate template website for lead. Also auto-provisions Bitpype contact/quote/appointment forms for matching pages and embeds them.', inputSchema: { type: 'object', properties: { leadId: { type: 'integer' }, force: { type: 'boolean' } }, required: ['leadId'] } },
    { name: 'website.qa', description: 'QA custom/template site. No mandatory hero. Grades links, ≤1 form/page, export images + crop aspect, unique nav labels, no horizontal overflow at 390px, module-fit (appointment-intent pages need bookings + published service + hours), form-purpose-fields warning.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'website.export', description: 'Export website HTML/assets. Multipage nav links are normalized on save; preview/publish blocks dangling #hash cross-page links.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'website.postcard', description: 'Claim kit for a website: site preview URL + signed claim Yes/No URL + QR data-URLs. Pass includePdf:true for base64 PDF (4×6 postcard). Works while automation is paused. Requires APP_URL + SESSION_SECRET and a preview URL for PDF.', inputSchema: { type: 'object', properties: { id: { type: 'integer' }, includePdf: { type: 'boolean' } }, required: ['id'] } },
    { name: 'lead.claimKit', description: 'Claim kit for a lead (latest website): site URL, claim URL, QR data-URLs; optional includePdf for postcard PDF base64. Same intent path as {{interested}}/{{uninterested}}.', inputSchema: { type: 'object', properties: { leadId: { type: 'integer' }, id: { type: 'integer' }, websiteId: { type: 'integer' }, includePdf: { type: 'boolean' } }, required: ['leadId'] } },
    { name: 'outreach.campaigns', description: 'Campaign admin: list | create | setStatus | cancel | delete | messages. create uses a dual-channel template; pass channel email|sms|both. setStatus accepts draft|active|paused|done (cancelled campaigns cannot resume — use cancel). delete removes the campaign row.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'create', 'setStatus', 'cancel', 'delete', 'messages'] }, id: { type: 'integer' }, name: { type: 'string' }, templateId: { type: 'integer' }, leadIds: { type: 'array', items: { type: 'integer' } }, status: { type: 'string', enum: ['draft', 'active', 'paused', 'done', 'cancelled'] }, channel: { type: 'string', enum: ['email', 'sms', 'both'] }, ratePerHour: { type: 'integer' }, limit: { type: 'integer' } }, required: ['action'] } },
    { name: 'outreach.templates', description: 'Dual-channel templates: list | save | delete. One record holds email subject/body (HTML OK) and sms_body (plain). Placeholders: {{website_link}}, {{business_name}}, {{interested}}, {{uninterested}}, {{site_screenshot}} (per-lead hosted preview image; email HTML img / SMS→MMS media URL with text+link fallback). Campaigns/compose choose email, SMS, or both.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'save', 'delete'] }, id: { type: 'integer' }, name: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, sms_body: { type: 'string' } }, required: ['action'] } },
    { name: 'outreach.processQueue', description: 'Process queued email and SMS messages (respects automation pause, suppression, daily cap).', inputSchema: { type: 'object', properties: {} } },
    { name: 'outreach.stats', description: 'Outreach stats.', inputSchema: { type: 'object', properties: {} } },
    { name: 'outreach.pipeline', description: 'Pipeline board.', inputSchema: { type: 'object', properties: {} } },
    { name: 'email.compose', description: 'Compose from a dual-channel template. Pass channel email|sms (default email). queue:true persists a campaign_message and returns messageId for email.send. SMS needs lead.phone + template.sms_body. Email personalizes {{website_link}}, {{interested}}, {{uninterested}}.', inputSchema: { type: 'object', properties: { leadId: { type: 'integer' }, templateId: { type: 'integer' }, queue: { type: 'boolean' }, channel: { type: 'string', enum: ['email', 'sms'] } }, required: ['leadId', 'templateId'] } },
    { name: 'email.draft', description: 'AI-draft outreach JSON: subject + HTML body + companion sms_body (must include {{website_link}}). Optional leadId for context, prompt to steer, existingSubject/existingBody to revise. Returns draft fields only — save via outreach.templates or compose. Respects automation pause.', inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, leadId: { type: 'integer' }, existingSubject: { type: 'string' }, existingBody: { type: 'string' } } } },
    { name: 'email.uploadAsset', description: 'Upload an image for HTML email templates (base64 via data or base64, max 5MB). Returns a public APP_URL /email-assets/{workspaceId}/{file} URL safe for img src. Does not send mail.', inputSchema: schema({ data: STR, mimeType: STR, base64: STR, mime: STR }) },
    { name: 'sms.queue', description: 'Queue a freeform SMS for a lead (personalizes {{website_link}}; appends link if missing). Requires lead phone. Returns messageId for email.send (same sender path handles SMS). Respects automation pause.', inputSchema: { type: 'object', properties: { leadId: { type: 'integer' }, body: { type: 'string', maxLength: 1600 } }, required: ['leadId', 'body'] } },
    { name: 'settings.get', description: 'Read settings (secrets redacted).', inputSchema: { type: 'object', properties: {} } },
    { name: 'settings.set', description: 'Set non-secret setting.', inputSchema: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] } },
    { name: 'automation.pause', description: 'Pause automation.', inputSchema: { type: 'object', properties: {} } },
    { name: 'automation.resume', description: 'Resume automation.', inputSchema: { type: 'object', properties: {} } },
    { name: 'analytics.get', description: 'Dashboard stats.', inputSchema: { type: 'object', properties: {} } },
    { name: 'discovery.schedule', description: 'get|set|runNow discovery schedule.', inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } },
    { name: 'cloudflare.publish', description: 'Publish site to Cloudflare Pages.', inputSchema: { type: 'object', properties: { websiteId: { type: 'integer' } }, required: ['websiteId'] } },
    { name: 'cloudflare.test', description: 'Test Cloudflare credentials.', inputSchema: { type: 'object', properties: {} } },
    { name: 'domains.search', description: 'Search Cloudflare Registrar for domain suggestions.', inputSchema: schema({ q: STR, query: STR, leadId: ID, limit: { type: 'integer' } }) },
    { name: 'domains.check', description: 'Real-time domain availability + pricing (Cloudflare Registrar).', inputSchema: schema({ domain: STR, domains: { type: 'array', items: STR } }) },
    { name: 'domains.register', description: 'Purchase a domain via Cloudflare Registrar (bills CF payment method).', inputSchema: schema({ domain: STR, domainName: STR, years: { type: 'integer' }, websiteId: ID, leadId: ID }, ['domain']) },
    { name: 'domains.status', description: 'Poll domain registration workflow status.', inputSchema: schema({ domain: STR }, ['domain']) },
    { name: 'domains.list', description: 'List workspace domain records (linked/registered).', inputSchema: schema({ websiteId: ID, leadId: ID, status: STR }) },
    { name: 'domains.owned', description: 'List domains on the Cloudflare Registrar account.', inputSchema: schema({}) },
    { name: 'domains.link', description: 'Link a domain to a website Pages project (custom hostname).', inputSchema: schema({ domain: STR, websiteId: ID, leadId: ID, forcePublish: { type: 'boolean' }, project: STR }, ['domain', 'websiteId']) },
    { name: 'domains.unlink', description: 'Unlink a domain from its website.', inputSchema: schema({ domain: STR, project: STR, removeFromPages: { type: 'boolean' } }, ['domain']) },
    { name: 'jobs.list', description: 'List scheduled jobs.', inputSchema: { type: 'object', properties: {} } },
    { name: 'jobs.create', description: 'Create scheduled job.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' }, interval_minutes: { type: 'integer' }, payload: { type: 'object' } }, required: ['name', 'type'] } },
    { name: 'jobs.update', description: 'Update job.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'jobs.delete', description: 'Delete job.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'jobs.runNow', description: 'Run job now.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'handsOff.status', description: 'Hands-off Muse mode status: enabled, automation_paused, last run/digest, Muse key configured, scheduled jobs.', inputSchema: { type: 'object', properties: {} } },
    { name: 'handsOff.runNow', description: 'Run one Hands-off tick now (discover→score→design→Muse→publish→outreach). Honors automation_paused. Pass force:true to run even when hands_off.enabled is off (still blocked when paused).', inputSchema: { type: 'object', properties: { force: { type: 'boolean' } } } },
    ...parityToolDefs(),
  ];
}

/** Tools added for Electron IPC / stdio-MCP parity. */
function parityToolDefs() {
  return [
    { name: 'lead.addFact', description: 'Add a business fact to a lead (claim_class e.g. VERIFIED / OWNER_PROVIDED / INFERRED).', inputSchema: schema({ id: ID, fact_key: STR, value: STR, source: STR, source_url: STR, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, claim_class: STR }, ['id', 'fact_key', 'value', 'source', 'claim_class']) },
    { name: 'lead.timeline', description: 'Merged lead/prospect/email event timeline for a lead.', inputSchema: schema({ id: ID, limit: { type: 'integer' } }, ['id']) },
    { name: 'prospect.score', description: "Lead's score with Hot/Qualified/Cold label from current thresholds.", inputSchema: schema({ leadId: ID }, ['leadId']) },

    { name: 'website.create', description: 'Open a website design job for the agent (default). Pass mode "template" to generate a template site immediately. FORMS: never hand-roll <form> HTML — use the contact_form section, an existing form module, or forms.create + form/bitpype_form section. MODULES+FORMS STYLING: wrap bare mounts in a themed card/section; theme.customCss under .bitpype-module-embed, .bitpype-form-embed, and section[data-ws-section-type="site_module|bitpype_form|contact_form"].', inputSchema: schema({ leadId: ID, site_shape: { type: 'string', enum: ['landing', 'multipage'] }, siteShape: { type: 'string', enum: ['landing', 'multipage'] }, mode: { type: 'string', enum: ['agent', 'template'] }, instructions: STR, force: { type: 'boolean' } }, ['leadId']) },
    { name: 'website.preview', description: 'Publish/export a website and return a public preview URL (Cloudflare Pages or APP_URL /site-previews/…).', inputSchema: schema({ id: ID, open: { type: 'boolean' }, force: { type: 'boolean' } }, ['id']) },
    { name: 'website.edit', description: 'Edit a website. Full save: pass pages[] + optional theme + note. pages[].sections[]: { type, content: { … }, cols?, cells?[] }. theme.partials.{headerHtml,footerHtml} shared chrome; page.chromeOverride skips partials. Head/meta: page.description, page.ogImage, page.canonical; scripts: theme.customJs + page.customJs (before </body>); head tags: theme.customHead + page.customHead (before </head>). <script> inside section HTML is rejected with SECTION_SCRIPT — use customJs/customHead. Or pass instruction for safe structural edits. FORMS: no raw <form> — use contact_form / forms.create / website.addBlock (form).', inputSchema: schema({ id: ID, pages: { type: 'array' }, theme: { type: 'object' }, note: STR, author: STR, instruction: STR }, ['id']) },
    { name: 'website.setLogo', description: 'Set site header logo without regenerating the site. mode "text" restores the text brand; mode "image" accepts base64 (JPEG/PNG/WebP/GIF, max ~5.5MB), cover-crops, strips solid backgrounds when feasible, saves images/logo.png with theme.logoMode=image. Pass id or leadId.', inputSchema: schema({ id: ID, mode: { type: 'string', enum: ['text', 'image'] }, data: STR, mimeType: STR, brandName: STR, leadId: ID }) },
    { name: 'website.setTheme', description: 'Set theme colors, fonts, customCss/customJs/customHead, favicon, shared partials {headerHtml,footerHtml}. Pass id or leadId. customHead injects before </head>; customJs before </body>. Never put <script> inside section HTML — use these fields.', inputSchema: schema({ id: ID, leadId: ID, primary: STR, secondary: STR, bg: STR, text: STR, colors: { type: 'object' }, font: STR, headingFont: STR, customCss: STR, customJs: STR, customHead: STR, favicon: STR, partials: { type: 'object' }, baseCss: { type: 'boolean' }, note: STR }) },
    { name: 'fonts.list', description: 'List curated Google Fonts available for theme.font / theme.headingFont (same catalog as the portal Theme bar). Free — local catalog only; no Google API key or billed calls. Optional group filter: Sans|Serif|Display|Mono. Pick a name then pass it to website.setTheme / theme.set / design.deliver theme.', inputSchema: schema({ group: STR }) },
    { name: 'website.replaceImage', description: 'Replace site image by replaceSrc under images/ or assets/: data or prompt. Optional crop. assets/ filenames stay stable.', inputSchema: schema({ id: ID, leadId: ID, replaceSrc: STR, src: STR, data: STR, mimeType: STR, prompt: STR, size: STR, quality: STR, crop: { type: 'object' } }) },
    { name: 'website.uploadAsset', description: 'Upload stable asset to assets/<filename> (ships on CF Pages /assets/*). Filename preserved. Optional setFavicon (injected into export <head>).', inputSchema: schema({ id: ID, websiteId: ID, leadId: ID, data: STR, mimeType: STR, mime: STR, filename: STR, name: STR, setFavicon: { type: 'boolean' } }, ['data', 'filename']) },
    { name: 'website.screenshot', description: 'PNG screenshot at viewport width (390|1440). Pass id, path, width.', inputSchema: schema({ id: ID, websiteId: ID, path: STR, width: { type: 'integer' }, height: { type: 'integer' }, previewUrl: STR }, ['width']) },
    { name: 'website.optimizeImages', description: 'Optimize all raster images for a customer site (resize long edge ≤2400px, compress JPEG/PNG/WebP, convert opaque photos to WebP when smaller). Keeps logo.png as PNG. Does not rename assets/ uploads. Pass id, websiteId, or leadId. Optional force.', inputSchema: schema({ id: ID, websiteId: ID, leadId: ID, force: { type: 'boolean' }, preferWebp: { type: 'boolean' } }) },
    { name: 'website.structure', description: 'Read WordPress-style menu tree + section summary (depth, menuParent, canNest/canUnnest). Pass id or websiteId.', inputSchema: schema({ id: ID, websiteId: ID }) },
    { name: 'website.structure.reorder', description: 'Reorder menu/sections or nest/unnest a one-level submenu. scope=menu|sections; action=move|nest|unnest; fromIndex from website.structure.menu[].index; direction -1|1 for move; pageIndex when scope=sections.', inputSchema: schema({ id: ID, websiteId: ID, scope: STR, action: STR, fromIndex: { type: 'integer', minimum: 0 }, direction: { type: 'integer' }, pageIndex: { type: 'integer', minimum: 0 } }, ['scope', 'fromIndex']) },
    { name: 'website.addSection', description: 'Add a page section (Page → Section → Block). Use sectionType "section" for an empty container, or a block type (heading/text/image/html/columns/…). cols=1..12 for columns/cards. Prefer website.addBlock to nest into an existing section or layout cell. afterIndex=-1 inserts near the top.', inputSchema: schema({ id: ID, websiteId: ID, pageIndex: { type: 'integer', minimum: 0 }, afterIndex: { type: 'integer', minimum: -1 }, sectionType: STR, type: STR, cols: { type: 'integer', minimum: 1, maximum: 12 }, html: STR }, ['pageIndex', 'afterIndex']) },
    { name: 'website.addBlock', description: 'Add block into section or columns cell. Native module/form-in-cell via cellIndex (no body CSS hacks). Types: heading|text|image|html|columns|module|form|…', inputSchema: schema({ id: ID, websiteId: ID, pageIndex: { type: 'integer', minimum: 0 }, sectionIndex: { type: 'integer', minimum: 0 }, blockType: STR, type: STR, cols: { type: 'integer', minimum: 1, maximum: 12 }, cellIndex: { type: 'integer', minimum: 0 }, moduleType: STR, formId: ID, formToken: STR, html: STR, content: { type: 'object' } }, ['pageIndex', 'sectionIndex']) },
    { name: 'website.forLead', description: 'Get the website for a lead (or null).', inputSchema: schema({ leadId: ID }, ['leadId']) },
    { name: 'website.addImages', description: 'Attach Pexels stock photos to a website (not AI replace — use website.replaceImage for that).', inputSchema: schema({ id: ID, query: STR, count: { type: 'integer', minimum: 1, maximum: 6 } }, ['id']) },
    { name: 'site.screenshots.list', description: 'List registered site preview screenshots (home/services × desktop/mobile + email/MMS renditions) by websiteId or leadId. Stored under EXPORT_ROOT/site-{id}/screenshots and served via /site-previews. Optional ready:true runs HTTP image/* checks.', inputSchema: schema({ websiteId: ID, leadId: ID, currentOnly: { type: 'boolean' }, checkReady: { type: 'boolean' }, kind: STR }) },
    { name: 'site.screenshots.capture', description: 'Capture/regenerate viewport screenshots of a live site preview (home + services; desktop 1440×900 + mobile 390×844). Stores PNG captures plus email JPEG (≤1200px) and MMS JPEG (<900KB) renditions. Requires a public preview URL (publishes with forcePreview when needed). Does not send outreach.', inputSchema: schema({ id: ID, websiteId: ID, forcePreview: { type: 'boolean' }, previewUrl: STR }, []) },
    { name: 'website.versions', description: 'List saved versions of a website (version_no, note, author, created_at).', inputSchema: schema({ id: ID, page: { type: 'integer' }, pageSize: { type: 'integer' } }, ['id']) },
    { name: 'website.diff', description: 'Page-level diff between two saved versions (from/to = version_no or version row id): pages added/removed/changed by slug, per-page section type count deltas, theme keys changed.', inputSchema: schema({ id: ID, from: ID, to: ID }, ['id', 'from', 'to']) },
    { name: 'website.restore', description: 'Restore a website version.', inputSchema: schema({ versionId: ID }, ['versionId']) },
    { name: 'website.render', description: 'Render website (by id) or supplied pages/theme to HTML.', inputSchema: schema({ id: ID, pages: { type: 'array' }, theme: { type: 'object' }, pageSlug: STR, pageIndex: { type: 'integer' }, editable: { type: 'boolean' } }) },

    { name: 'design.answers', description: 'Read questions and user answers for a design job.', inputSchema: schema({ id: ID }, ['id']) },
    { name: 'design.emailQuestions', description: 'Email unanswered questions for one design job via workspace SMTP.', inputSchema: schema({ id: ID, jobId: ID }) },
    { name: 'design.emailDelivery', description: 'Email the delivery for a non-website design job via workspace SMTP.', inputSchema: schema({ id: ID, jobId: ID }) },
    { name: 'design.setContact', description: 'Set the contact email and/or phone on a design job.', inputSchema: schema({ id: ID, email: STR, phone: STR }, ['id']) },
    { name: 'design.recordReply', description: 'Record a customer email reply on a design job (answers open questions).', inputSchema: schema({ id: ID, jobId: ID, reply: STR, fromEmail: STR }, ['reply']) },
    { name: 'design.images', description: 'Attach Pexels photos to a delivered design website.', inputSchema: schema({ id: ID, query: STR, count: { type: 'integer', minimum: 1, maximum: 6 } }, ['id']) },
    { name: 'design.generateImage', description: 'Generate images via OpenAI Images API and attach to a design job.', inputSchema: schema({ id: ID, prompt: STR, n: { type: 'integer', minimum: 1, maximum: 4 }, size: STR, quality: STR, model: STR }, ['id']) },
    { name: 'design.generateLogo', description: 'Generate a site header logo with OpenAI Images (transparent PNG preferred), cover-crop, attach to the design job, and apply to the linked website (theme.logoMode=image + theme.logoUrl). Existing sites stay on text logos until this or website.setLogo is used. Optional prompt / brandName / websiteId. Respects automation pause.', inputSchema: schema({ id: ID, prompt: STR, brandName: STR, websiteId: ID, size: STR, quality: STR, model: STR }, ['id']) },
    { name: 'design.openPreview', description: 'Return a public preview URL for a delivered website (Cloudflare Pages or APP_URL; not localhost).', inputSchema: schema({ id: ID, open: { type: 'boolean' } }, ['id']) },
    { name: 'design.emailRedesign', description: 'Inbound email redesign/improvement requests: list|get|ingest|submit|dismiss|scan.', inputSchema: schema({ action: { type: 'string', enum: ['list', 'get', 'ingest', 'submit', 'dismiss', 'scan'] }, id: ID, requestId: ID, jobId: ID, designJobId: ID, leadId: ID, fromEmail: STR, subject: STR, body: STR, reply: STR, requestKind: STR, force: { type: 'boolean' }, instructions: STR, status: STR, pendingOnly: { type: 'boolean' }, includeAll: { type: 'boolean' }, limit: { type: 'integer' } }, ['action']) },
    { name: 'design.lessons', description: 'Design learning: status|list|playbook|clear|distill.', inputSchema: schema({ action: { type: 'string', enum: ['status', 'list', 'playbook', 'clear', 'distill'] }, what: { type: 'string', enum: ['all', 'playbook', 'events'] }, jobId: ID, eventType: STR, limit: { type: 'integer', minimum: 1, maximum: 200 }, force: { type: 'boolean' } }) },
    { name: 'design.saveWebsite', description: 'Save an edited pages/theme payload onto a delivered design website.', inputSchema: schema({ id: ID, pages: { type: 'array' }, theme: { type: 'object' } }, ['id', 'pages']) },
    { name: 'design.removeDeliveryItem', description: 'Remove one delivered file/item (by path) from a design job.', inputSchema: schema({ id: ID, jobId: ID, path: STR }, ['path']) },
    { name: 'design.defaultInstructions', description: 'Default website design instructions served to builders (src/defaultDesignInstructions.js). Includes Muse build pack: brief-first concept/palette/type/motif, craft gaps, publish-verify loop, nav/forms/modules/bookings/images playbook, modular freestyle delivery, and design asset ids such as mobile-nav.', inputSchema: schema({}) },
    { name: 'design.assets', description: 'List BitPype design assets the agent can paste into builds, or get one by id. Includes mobile-nav: CSS-only hamburger menu for mobile (data-bitpype-mobile-nav) — no JavaScript; BitPype injects the CSS on export.', inputSchema: schema({ id: STR }) },

    { name: 'email.send', description: 'Send a queued message now. Respects suppression list, automation pause, and daily outreach cap.', inputSchema: schema({ messageId: ID }, ['messageId']) },
    { name: 'outreach.suppression', description: 'Suppression list: list|add|remove.', inputSchema: schema({ action: { type: 'string', enum: ['list', 'add', 'remove'] }, email: STR, reason: STR, id: ID, page: { type: 'integer' }, pageSize: { type: 'integer' } }, ['action']) },
    { name: 'outreach.intent', description: 'Prospect intent: get|record.', inputSchema: schema({ action: { type: 'string', enum: ['get', 'record'] }, leadId: ID, event: STR, note: STR }, ['action', 'leadId']) },

    { name: 'ai.usage', description: 'AI spend: today, month, by task and recent calls.', inputSchema: schema({ days: { type: 'integer', minimum: 1, maximum: 365 } }) },
    { name: 'prompts.list', description: 'List editable AI prompts.', inputSchema: schema({}) },
    { name: 'prompts.save', description: 'Save an AI prompt body, or restore the seed default with reset:true.', inputSchema: schema({ key: STR, body: STR, reset: { type: 'boolean' } }, ['key']) },
    { name: 'activity.recent', description: 'Recent activity log.', inputSchema: schema({ limit: { type: 'integer' }, page: { type: 'integer' }, pageSize: { type: 'integer' } }) },
  ];
}

/** Throws if automation kill switch is engaged (for AI / external-cost tools). */
function ensureNotPaused(workspaceId) {
  if (domain.withDb(workspaceId, (db) => domain.getSetting(db, 'automation_paused', '0')) === '1') {
    throw new Error('Automation is paused (kill switch). Resume it before running this tool.');
  }
}

function need(value, what) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${what} must be a positive integer.`);
  return n;
}

async function callParityTool(ws, name, a) {
  switch (name) {
    case 'lead.addFact': {
      const fact = domain.leadsAddFact(ws, need(a.id, 'id'), {
        fact_key: a.fact_key, value: a.value, source: a.source,
        source_url: a.source_url, confidence: a.confidence, claim_class: a.claim_class,
      });
      return { fact };
    }
    case 'lead.timeline': return { timeline: domain.leadsTimeline(ws, need(a.id, 'id'), { limit: a.limit }) };
    case 'prospect.score': return domain.prospectScore(ws, need(a.leadId, 'leadId'));

    case 'website.create': {
      const leadId = need(a.leadId, 'leadId');
      if (a.mode === 'template') return domain.sitesGenerate(ws, leadId, { force: !!a.force });
      const shape = a.site_shape != null ? a.site_shape : a.siteShape;
      const lead = domain.leadsGet(ws, leadId);
      if (!lead) throw new Error(`Lead ${leadId} not found.`);
      const job = domain.designCreate(ws, {
        type: 'website',
        leadId,
        site_shape: shape,
        title: `${lead.lead.business_name || 'Business'} website`,
        instructions: (a.instructions && String(a.instructions).trim()) || domain.designDefaultInstructions().website,
      });
      domain.withDb(ws, (db) => db.prepare('INSERT INTO lead_events (lead_id, type, detail) VALUES (?, ?, ?)')
        .run(leadId, 'site_assigned', `Design job #${job.id} assigned via MCP (agent-owned design, ${job.site_shape || 'multipage'})`));
      return { jobId: job.id, status: job.status, type: 'website', site_shape: job.site_shape };
    }
    case 'website.preview': return domain.sitesPreview(ws, need(a.id, 'id'), { open: !!a.open, force: !!a.force });
    case 'website.edit': {
      const id = need(a.id, 'id');
      if (a.pages != null) {
        let theme = a.theme;
        if (theme == null) {
          const existing = domain.sitesGet(ws, id);
          theme = existing && existing.theme != null
            ? (typeof existing.theme === 'string' ? JSON.parse(existing.theme) : existing.theme)
            : {};
        }
        return domain.sitesSave(ws, id, { pages: a.pages, theme, note: a.note });
      }
      if (a.instruction != null) return domain.sitesApplyInstruction(ws, id, a.instruction);
      throw new Error('Provide pages (+theme) for a full save, or instruction for a safe structural edit.');
    }
    case 'website.setLogo': {
      const mode = String(a.mode || (a.data ? 'image' : 'text')).toLowerCase();
      if (mode === 'text') {
        return domain.sitesSetLogo(ws, a.id != null ? need(a.id, 'id') : null, {
          leadId: a.leadId != null ? need(a.leadId, 'leadId') : undefined,
          mode: 'text',
          brandName: a.brandName,
          note: 'MCP website.setLogo text',
        });
      }
      const dataB64 = String(a.data || '').replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '').replace(/\s+/g, '');
      if (!dataB64) throw new Error('data (base64 image) is required for mode=image, or pass mode=text.');
      // Cap before Buffer.from to avoid huge allocations (~5.5MB decoded).
      const maxB64 = Math.ceil(5.5 * 1024 * 1024 * 4 / 3) + 256;
      if (dataB64.length > maxB64) throw new Error('Logo image is too large (max 5.5 MB).');
      const buffer = Buffer.from(dataB64, 'base64');
      return domain.sitesSetLogo(ws, a.id != null ? need(a.id, 'id') : null, {
        leadId: a.leadId != null ? need(a.leadId, 'leadId') : undefined,
        mode: 'image',
        buffer,
        brandName: a.brandName,
        note: 'MCP website.setLogo image',
      });
    }
    case 'website.setTheme': {
      const colors = a.colors && typeof a.colors === 'object'
        ? a.colors
        : { primary: a.primary, secondary: a.secondary, bg: a.bg, text: a.text };
      return domain.sitesSetTheme(ws, a.id != null ? need(a.id, 'id') : null, {
        leadId: a.leadId != null ? need(a.leadId, 'leadId') : undefined,
        colors,
        font: a.font,
        headingFont: a.headingFont,
        customCss: a.customCss,
        customJs: a.customJs,
        favicon: a.favicon,
        partials: a.partials,
        baseCss: a.baseCss,
        note: a.note,
      });
    }
    case 'fonts.list': {
      const fonts = require('../public/js/fonts.js');
      let list = Array.isArray(fonts.CATALOG) ? fonts.CATALOG.slice() : [];
      const group = a.group != null ? String(a.group).trim() : '';
      if (group) {
        const g = group.toLowerCase();
        list = list.filter((f) => String(f.group || '').toLowerCase() === g);
      }
      const groups = [...new Set((fonts.CATALOG || []).map((f) => f.group).filter(Boolean))];
      return {
        fonts: list.map((f) => ({
          name: f.name,
          group: f.group,
          generic: f.generic,
          stack: fonts.stackFor(f.name),
        })),
        groups,
        count: list.length,
        note: 'Free local catalog. Use name with website.setTheme ({ font, headingFont }) or theme.font on design.deliver. Google Fonts CSS is loaded for visitors at no API cost.',
      };
    }
    case 'website.replaceImage': {
      ensureNotPaused(ws);
      return domain.sitesReplaceImage(ws, a.id != null ? need(a.id, 'id') : null, {
        leadId: a.leadId != null ? need(a.leadId, 'leadId') : undefined,
        replaceSrc: a.replaceSrc || a.src,
        data: a.data,
        mimeType: a.mimeType,
        prompt: a.prompt,
        size: a.size,
        quality: a.quality,
        crop: a.crop,
      });
    }
    case 'website.uploadAsset': {
      ensureNotPaused(ws);
      return domain.sitesUploadAsset(ws, a.id != null ? need(a.id, 'id') : null, {
        websiteId: a.websiteId,
        leadId: a.leadId,
        data: a.data,
        mimeType: a.mimeType || a.mime,
        filename: a.filename || a.name,
        setFavicon: !!a.setFavicon,
      });
    }
    case 'website.screenshot': {
      const siteId = a.websiteId != null ? need(a.websiteId, 'websiteId') : need(a.id, 'id');
      return domain.sitesScreenshot(ws, siteId, {
        path: a.path,
        width: a.width,
        height: a.height,
        previewUrl: a.previewUrl,
      });
    }
    case 'website.optimizeImages': {
      ensureNotPaused(ws);
      return domain.sitesOptimizeImages(ws, a.id != null ? need(a.id, 'id') : null, {
        websiteId: a.websiteId != null ? need(a.websiteId, 'websiteId') : undefined,
        leadId: a.leadId != null ? need(a.leadId, 'leadId') : undefined,
        force: !!a.force,
        preferWebp: a.preferWebp !== false,
      });
    }
    case 'website.structure': {
      const siteId = a.websiteId != null ? need(a.websiteId, 'websiteId') : need(a.id, 'id');
      return domain.sitesGetStructure(ws, siteId);
    }
    case 'website.structure.reorder': {
      const siteId = a.websiteId != null ? need(a.websiteId, 'websiteId') : need(a.id, 'id');
      return domain.sitesReorderStructure(ws, siteId, {
        scope: a.scope,
        action: a.action,
        fromIndex: a.fromIndex,
        direction: a.direction,
        pageIndex: a.pageIndex,
      });
    }
    case 'website.addSection': {
      const siteId = a.websiteId != null ? need(a.websiteId, 'websiteId') : need(a.id, 'id');
      return domain.sitesInsertSection(ws, siteId, {
        pageIndex: a.pageIndex,
        afterIndex: a.afterIndex,
        sectionType: a.sectionType || a.type || 'section',
        cols: a.cols,
        html: a.html,
      });
    }
    case 'website.addBlock': {
      const siteId = a.websiteId != null ? need(a.websiteId, 'websiteId') : need(a.id, 'id');
      return domain.sitesAddBlock(ws, siteId, {
        pageIndex: a.pageIndex,
        sectionIndex: a.sectionIndex,
        blockType: a.blockType || a.type,
        cols: a.cols,
        cellIndex: a.cellIndex,
        moduleType: a.moduleType || a.module_type || a.module,
        formId: a.formId,
        formToken: a.formToken || a.form_token,
        html: a.html,
        content: a.content,
      });
    }
    case 'website.forLead': return domain.sitesForLead(ws, need(a.leadId, 'leadId'));
    case 'website.addImages': return domain.sitesAddImages(ws, need(a.id, 'id'), { query: a.query, count: a.count });
    case 'site.screenshots.list': {
      const websiteId = a.websiteId != null ? Number(a.websiteId) : (a.id != null ? Number(a.id) : undefined);
      const leadId = a.leadId != null ? Number(a.leadId) : undefined;
      if (!(Number.isInteger(websiteId) && websiteId > 0) && !(Number.isInteger(leadId) && leadId > 0)) {
        throw Object.assign(new Error('websiteId or leadId is required'), { code: 'INVALID_ARGS' });
      }
      return await domain.sitesScreenshotsList(ws, {
        websiteId,
        leadId,
        currentOnly: a.currentOnly !== false,
        checkReady: !!(a.checkReady || a.ready),
        kind: a.kind,
      });
    }
    case 'site.screenshots.capture': {
      const websiteId = a.websiteId != null ? Number(a.websiteId) : need(a.id, 'id');
      return await domain.sitesScreenshotsCapture(ws, websiteId, {
        forcePreview: a.forcePreview !== false,
        previewUrl: a.previewUrl,
        leadId: a.leadId,
        designJobId: a.designJobId,
      });
    }
    case 'website.versions': return domain.sitesVersions(ws, need(a.id, 'id'), a);
    case 'website.diff': return domain.sitesDiff(ws, need(a.id, 'id'), a);
    case 'website.restore': return { site: domain.sitesRestore(ws, need(a.versionId, 'versionId')) };
    case 'website.render': return domain.sitesRenderHtml(ws, a.id != null ? need(a.id, 'id') : null, a);

    case 'design.answers': return domain.designListAnswers(ws, need(a.id, 'id'));
    case 'design.emailQuestions': return await domain.designEmailQuestions(ws, need(a.jobId != null ? a.jobId : a.id, 'jobId'));
    case 'design.emailDelivery': return await domain.designEmailDelivery(ws, need(a.jobId != null ? a.jobId : a.id, 'jobId'));
    case 'design.setContact': return { job: domain.designSetContact(ws, need(a.id, 'id'), { email: a.email, phone: a.phone }) };
    case 'design.recordReply': return { job: domain.designRecordReply(ws, need(a.id != null ? a.id : a.jobId, 'id'), a.reply, a.fromEmail) };
    case 'design.images': {
      ensureNotPaused(ws);
      return domain.designAddImages(ws, need(a.id, 'id'), { query: a.query, count: a.count });
    }
    case 'design.generateImage': {
      ensureNotPaused(ws);
      const r = await domain.designGenerateImages(ws, need(a.id, 'id'), { prompt: a.prompt, n: a.n, size: a.size, quality: a.quality, model: a.model });
      return { id: r.id, count: r.count, model: r.model, prompt: r.prompt, paths: r.paths };
    }
    case 'design.generateLogo': {
      ensureNotPaused(ws);
      return domain.designGenerateLogo(ws, need(a.id, 'id'), {
        prompt: a.prompt,
        brandName: a.brandName,
        websiteId: a.websiteId != null ? need(a.websiteId, 'websiteId') : undefined,
        size: a.size,
        quality: a.quality,
        model: a.model,
      });
    }
    case 'design.openPreview': return domain.designOpenPreview(ws, need(a.id, 'id'), { open: !!a.open });
    case 'design.emailRedesign': {
      const action = String(a.action || '').trim().toLowerCase();
      const reqId = a.id != null ? a.id : a.requestId;
      if (action === 'list') return domain.emailRedesignList(ws, { limit: a.limit, status: a.status, jobId: a.jobId, pendingOnly: a.pendingOnly, includeAll: a.includeAll });
      if (action === 'get') return domain.emailRedesignGet(ws, need(reqId, 'id'));
      if (action === 'ingest') {
        if (a.body == null && a.reply == null) throw new Error('body is required for ingest.');
        return domain.emailRedesignIngest(ws, { ...a, source: a.source || 'mcp' });
      }
      if (action === 'submit') return domain.emailRedesignSubmit(ws, need(reqId, 'id'), a);
      if (action === 'dismiss') return domain.emailRedesignDismiss(ws, need(reqId, 'id'));
      if (action === 'scan') return domain.emailRedesignScan(ws);
      throw new Error('action must be list, get, ingest, submit, dismiss, or scan.');
    }
    case 'design.lessons': {
      const action = String(a.action || 'status').trim().toLowerCase();
      if (action === 'status') return domain.learningStatus(ws);
      if (action === 'list') return domain.learningEvents(ws, { jobId: a.jobId, eventType: a.eventType, limit: a.limit });
      if (action === 'playbook') return domain.learningPlaybook(ws);
      if (action === 'clear') return domain.learningClear(ws, a.what || 'playbook');
      if (action === 'distill') return domain.learningDistill(ws, { force: !!a.force });
      throw new Error('action must be status, list, playbook, clear, or distill.');
    }
    case 'design.saveWebsite': return { job: domain.designSaveWebsite(ws, need(a.id, 'id'), a.pages, a.theme) };
    case 'design.removeDeliveryItem': return { job: domain.designRemoveDelivery(ws, need(a.id != null ? a.id : a.jobId, 'id'), a.path) };
    case 'design.defaultInstructions': return domain.designDefaultInstructions();
    case 'design.assets': return domain.designAssets(a.id);

    case 'email.send': {
      ensureNotPaused(ws);
      return domain.emailSend(ws, need(a.messageId, 'messageId'));
    }
    case 'outreach.suppression': {
      if (a.action === 'list') return domain.suppressionList(ws, a);
      if (a.action === 'add') return domain.suppressionAdd(ws, a.email, a.reason);
      if (a.action === 'remove') return domain.suppressionRemove(ws, need(a.id, 'id'));
      throw new Error('Unknown suppression action (list|add|remove).');
    }
    case 'outreach.intent': {
      const leadId = need(a.leadId, 'leadId');
      if (a.action === 'get') return domain.intentGet(ws, leadId);
      if (a.action === 'record') return domain.intentRecord(ws, leadId, a.event, a.note);
      throw new Error('Unknown intent action (get|record).');
    }

    case 'ai.usage': return domain.aiUsage(ws, a.days != null ? Math.min(365, Math.max(1, Number(a.days) || 30)) : 30);
    case 'prompts.list': return { prompts: domain.promptsList(ws) };
    case 'prompts.save': {
      if (a.reset) return domain.promptsReset(ws, a.key);
      return domain.promptsSave(ws, a.key, a.body);
    }
    case 'activity.recent': return domain.activityRecent(ws, a);
    default: return undefined;
  }
}

async function planEntitlements(workspaceId) {
  const billing = require('./billing');
  const { getPlan } = require('./plans');
  const planId = await billing.workspacePlan(workspaceId);
  return { planId, entitlements: getPlan(planId).entitlements };
}

function resolveLeadId(ctx, argsLeadId) {
  if (ctx && ctx.leadId) return Number(ctx.leadId);
  return argsLeadId != null ? need(argsLeadId, 'leadId') : null;
}

async function callClientTool(ws, name, a, ctx = {}) {
  const portalOut = await dispatchPortalTool(ws, name, a, ctx);
  if (portalOut !== undefined) return portalOut;

  const social = require('../src/socialMedia');
  const modules = require('./siteModules');
  const { planId, entitlements } = await planEntitlements(ws);

  if (name === 'social.posts.list' || name === 'social.posts.update' || name === 'social.posts.approve') {
    if (!entitlements.socialMcpSchedule) {
      throw Object.assign(
        new Error('Social MCP scheduling requires Premium (socialMcpSchedule).'),
        { code: 'PLAN_REQUIRED' }
      );
    }
  }
  const moduleToolNames = new Set([
    'website.addModule', 'modules.list',
    'blog.list', 'blog.create', 'blog.update', 'blog.delete',
    'ecommerce.list', 'ecommerce.create', 'ecommerce.update', 'ecommerce.delete',
    'courses.list', 'courses.create', 'courses.update', 'courses.delete', 'courses.addLesson',
    'gallery.list', 'gallery.create', 'gallery.update', 'gallery.delete', 'gallery.addImage',
    'directory.list', 'directory.create', 'directory.update', 'directory.delete',
    'faq.list', 'faq.create', 'faq.update', 'faq.delete',
    'testimonials.list', 'testimonials.create', 'testimonials.update', 'testimonials.delete',
    'team.list', 'team.create', 'team.update', 'team.delete',
    'events.list', 'events.create', 'events.update', 'events.delete',
    'bookings.services', 'bookings.createService', 'bookings.updateService', 'bookings.deleteService',
    'bookings.setHours', 'bookings.getHours', 'bookings.setSettings',
    'bookings.list', 'bookings.updateStatus', 'bookings.slots',
  ]);
  if (moduleToolNames.has(name) && !entitlements.siteModules) {
    throw Object.assign(
      new Error('Site modules require Standard or Premium (siteModules).'),
      { code: 'PLAN_REQUIRED' }
    );
  }

  if (name === 'social.posts.list') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    const limit = Math.min(200, Math.max(1, Number(a.limit) || 50));
    return domain.withDb(ws, (db) => {
      social.ensureTables(db);
      let sql = 'SELECT * FROM social_posts WHERE lead_id = ?';
      const params = [leadId];
      if (a.status) {
        sql += ' AND status = ?';
        params.push(String(a.status));
      }
      sql += ' ORDER BY scheduled_at ASC, id ASC LIMIT ?';
      params.push(limit);
      const posts = db.prepare(sql).all(...params).map((p) => {
        const pub = social.publicPost ? social.publicPost(p) : p;
        return pub;
      });
      return { plan: planId, leadId, posts };
    });
  }

  if (name === 'social.posts.update') {
    const id = need(a.id, 'id');
    const leadId = resolveLeadId(ctx, a.leadId);
    return domain.withDb(ws, (db) => {
      social.ensureTables(db);
      const row = db.prepare('SELECT * FROM social_posts WHERE id = ?').get(id);
      if (!row) throw new Error('Post not found');
      if (leadId && Number(row.lead_id) !== Number(leadId)) throw new Error('Post not in lead scope');
      if (ctx.leadId && Number(row.lead_id) !== Number(ctx.leadId)) throw new Error('Forbidden');
      const post = social.updatePost(db, id, {
        caption: a.caption,
        scheduled_at: a.scheduled_at,
        status: a.status,
        client_notes: a.client_notes,
      });
      return { post };
    });
  }

  if (name === 'social.posts.approve') {
    const leadId = resolveLeadId(ctx, a.leadId);
    const ids = (Array.isArray(a.postIds) ? a.postIds : []).map(Number).filter((n) => n > 0);
    return domain.withDb(ws, (db) => {
      social.ensureTables(db);
      const approved = [];
      for (const id of ids) {
        const row = db.prepare('SELECT * FROM social_posts WHERE id = ?').get(id);
        if (!row) continue;
        if (leadId && Number(row.lead_id) !== Number(leadId)) continue;
        if (ctx.leadId && Number(row.lead_id) !== Number(ctx.leadId)) continue;
        db.prepare(
          "UPDATE social_posts SET status = 'scheduled', updated_at = datetime('now') WHERE id = ? AND status IN ('draft','pending_approval','approved','rejected')"
        ).run(id);
        approved.push(id);
      }
      return { approved, plan: planId };
    });
  }

  if (name === 'website.addModule') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    if (ctx.leadId && Number(leadId) !== Number(ctx.leadId)) throw new Error('Forbidden');
    const moduleType = a.module || a.moduleType || a.type;
    if (!moduleType) {
      throw new Error('module is required (blog|ecommerce|courses|gallery|directory|faq|testimonials|team|events|bookings|chatbot)');
    }
    const attached = domain.modulesAttach(ws, leadId, moduleType, a);
    return {
      plan: planId,
      embed_mode: 'js',
      note: 'Module is injected as an in-page JS mount inside the site template (not an iframe). Call site.publish so the public site HTML picks it up.',
      ...attached,
    };
  }

  if (name === 'modules.list') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    if (ctx.leadId && Number(leadId) !== Number(ctx.leadId)) throw new Error('Forbidden');
    return { plan: planId, ...domain.modulesSummary(ws, leadId) };
  }

  if (name === 'forms.list') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (ctx.leadId && leadId && Number(leadId) !== Number(ctx.leadId)) throw new Error('Forbidden');
    return domain.formsList(ws, {
      leadId: leadId || ctx.leadId,
      websiteId: a.websiteId || a.siteId,
      siteId: a.siteId,
    });
  }
  if (name === 'forms.get') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (ctx.leadId && leadId && Number(leadId) !== Number(ctx.leadId)) throw new Error('Forbidden');
    return domain.formsGet(ws, {
      leadId: leadId || ctx.leadId,
      formId: a.formId != null ? a.formId : a.id,
      id: a.id,
      websiteId: a.websiteId,
    });
  }
  if (name === 'forms.create') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId && !ctx.leadId) throw new Error('leadId is required');
    if (ctx.leadId && leadId && Number(leadId) !== Number(ctx.leadId)) throw new Error('Forbidden');
    return domain.formsCreate(ws, Object.assign({}, a, { leadId: leadId || ctx.leadId }));
  }
  if (name === 'forms.suggestFields') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId && !ctx.leadId) throw new Error('leadId is required');
    if (ctx.leadId && leadId && Number(leadId) !== Number(ctx.leadId)) throw new Error('Forbidden');
    return domain.formsSuggestFields(ws, Object.assign({}, a, { leadId: leadId || ctx.leadId }));
  }
  if (name === 'forms.update') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId && !ctx.leadId) throw new Error('leadId is required');
    if (ctx.leadId && leadId && Number(leadId) !== Number(ctx.leadId)) throw new Error('Forbidden');
    return domain.formsUpdate(ws, Object.assign({}, a, {
      leadId: leadId || ctx.leadId,
      formId: a.formId != null ? a.formId : a.id,
    }));
  }
  if (name === 'forms.delete') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId && !ctx.leadId) throw new Error('leadId is required');
    if (ctx.leadId && leadId && Number(leadId) !== Number(ctx.leadId)) throw new Error('Forbidden');
    return domain.formsDelete(ws, {
      leadId: leadId || ctx.leadId,
      formId: a.formId != null ? a.formId : a.id,
      id: a.id,
    });
  }

  if (name === 'blog.list') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      posts: modules.listBlogPosts(db, leadId, { includeDrafts: a.includeDrafts !== false }),
    }));
  }
  if (name === 'blog.create') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({ plan: planId, post: modules.createBlogPost(db, leadId, a) }));
  }
  if (name === 'blog.update') {
    const leadId = resolveLeadId(ctx, a.leadId);
    const id = need(a.id, 'id');
    return domain.withDb(ws, (db) => {
      if (leadId) {
        const row = modules.getBlogPost(db, leadId, id);
        if (!row) throw new Error('Blog post not found');
      }
      const lid = leadId || (modules.getBlogPost(db, ctx.leadId, id) && Number(ctx.leadId));
      if (!lid && !ctx.leadId) throw new Error('leadId is required');
      return { plan: planId, post: modules.updateBlogPost(db, lid || Number(ctx.leadId), id, a) };
    });
  }
  if (name === 'blog.delete') {
    const leadId = resolveLeadId(ctx, a.leadId);
    const id = need(a.id, 'id');
    if (!leadId && !ctx.leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      ...modules.deleteBlogPost(db, leadId || Number(ctx.leadId), id),
    }));
  }

  if (name === 'ecommerce.list') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      products: modules.listProducts(db, leadId, { includeDrafts: a.includeDrafts !== false })
        .map((p) => ({ ...p, price_label: modules.formatPrice(p.price_cents, p.currency) })),
    }));
  }
  if (name === 'ecommerce.create') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({ plan: planId, product: modules.createProduct(db, leadId, a) }));
  }
  if (name === 'ecommerce.update') {
    const leadId = resolveLeadId(ctx, a.leadId);
    const id = need(a.id, 'id');
    if (!leadId && !ctx.leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      product: modules.updateProduct(db, leadId || Number(ctx.leadId), id, a),
    }));
  }
  if (name === 'ecommerce.delete') {
    const leadId = resolveLeadId(ctx, a.leadId);
    const id = need(a.id, 'id');
    if (!leadId && !ctx.leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      ...modules.deleteProduct(db, leadId || Number(ctx.leadId), id),
    }));
  }

  if (name === 'courses.list') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      courses: modules.listCourses(db, leadId, { includeDrafts: a.includeDrafts !== false }),
    }));
  }
  if (name === 'courses.create') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({ plan: planId, course: modules.createCourse(db, leadId, a) }));
  }
  if (name === 'courses.update') {
    const leadId = resolveLeadId(ctx, a.leadId);
    const id = need(a.id, 'id');
    if (!leadId && !ctx.leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      course: modules.updateCourse(db, leadId || Number(ctx.leadId), id, a),
    }));
  }
  if (name === 'courses.delete') {
    const leadId = resolveLeadId(ctx, a.leadId);
    const id = need(a.id, 'id');
    if (!leadId && !ctx.leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      ...modules.deleteCourse(db, leadId || Number(ctx.leadId), id),
    }));
  }
  if (name === 'courses.addLesson') {
    const leadId = resolveLeadId(ctx, a.leadId);
    const courseId = need(a.courseId != null ? a.courseId : a.id, 'courseId');
    if (!leadId && !ctx.leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      lesson: modules.addLesson(db, leadId || Number(ctx.leadId), courseId, a),
    }));
  }

  if (name === 'gallery.list') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      albums: modules.listAlbums(db, leadId, { includeDrafts: a.includeDrafts !== false }),
    }));
  }
  if (name === 'gallery.create') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({ plan: planId, album: modules.createAlbum(db, leadId, a) }));
  }
  if (name === 'gallery.update') {
    const leadId = resolveLeadId(ctx, a.leadId);
    const id = need(a.id, 'id');
    if (!leadId && !ctx.leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      album: modules.updateAlbum(db, leadId || Number(ctx.leadId), id, a),
    }));
  }
  if (name === 'gallery.delete') {
    const leadId = resolveLeadId(ctx, a.leadId);
    const id = need(a.id, 'id');
    if (!leadId && !ctx.leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      ...modules.deleteAlbum(db, leadId || Number(ctx.leadId), id),
    }));
  }
  if (name === 'gallery.addImage') {
    const leadId = resolveLeadId(ctx, a.leadId);
    const albumId = need(a.albumId != null ? a.albumId : a.id, 'albumId');
    if (!leadId && !ctx.leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      image: modules.addGalleryImage(db, leadId || Number(ctx.leadId), albumId, a),
    }));
  }

  if (name === 'directory.list') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      listings: modules.listListings(db, leadId, {
        includeDrafts: a.includeDrafts !== false,
        category: a.category,
      }),
    }));
  }
  if (name === 'directory.create') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({ plan: planId, listing: modules.createListing(db, leadId, a) }));
  }
  if (name === 'directory.update') {
    const leadId = resolveLeadId(ctx, a.leadId);
    const id = need(a.id, 'id');
    if (!leadId && !ctx.leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      listing: modules.updateListing(db, leadId || Number(ctx.leadId), id, a),
    }));
  }
  if (name === 'directory.delete') {
    const leadId = resolveLeadId(ctx, a.leadId);
    const id = need(a.id, 'id');
    if (!leadId && !ctx.leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      ...modules.deleteListing(db, leadId || Number(ctx.leadId), id),
    }));
  }

  if (name === 'faq.list') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      items: modules.listFaqItems(db, leadId, {
        includeDrafts: a.includeDrafts !== false,
        category: a.category,
      }),
    }));
  }
  if (name === 'faq.create') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({ plan: planId, item: modules.createFaqItem(db, leadId, a) }));
  }
  if (name === 'faq.update') {
    const leadId = resolveLeadId(ctx, a.leadId);
    const id = need(a.id, 'id');
    if (!leadId && !ctx.leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      item: modules.updateFaqItem(db, leadId || Number(ctx.leadId), id, a),
    }));
  }
  if (name === 'faq.delete') {
    const leadId = resolveLeadId(ctx, a.leadId);
    const id = need(a.id, 'id');
    if (!leadId && !ctx.leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      ...modules.deleteFaqItem(db, leadId || Number(ctx.leadId), id),
    }));
  }

  if (name === 'testimonials.list') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      items: modules.listTestimonials(db, leadId, { includeDrafts: a.includeDrafts !== false }),
    }));
  }
  if (name === 'testimonials.create') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({ plan: planId, item: modules.createTestimonial(db, leadId, a) }));
  }
  if (name === 'testimonials.update') {
    const leadId = resolveLeadId(ctx, a.leadId);
    const id = need(a.id, 'id');
    if (!leadId && !ctx.leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      item: modules.updateTestimonial(db, leadId || Number(ctx.leadId), id, a),
    }));
  }
  if (name === 'testimonials.delete') {
    const leadId = resolveLeadId(ctx, a.leadId);
    const id = need(a.id, 'id');
    if (!leadId && !ctx.leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      ...modules.deleteTestimonial(db, leadId || Number(ctx.leadId), id),
    }));
  }

  if (name === 'team.list') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      members: modules.listTeamMembers(db, leadId, { includeDrafts: a.includeDrafts !== false }),
    }));
  }
  if (name === 'team.create') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({ plan: planId, member: modules.createTeamMember(db, leadId, a) }));
  }
  if (name === 'team.update') {
    const leadId = resolveLeadId(ctx, a.leadId);
    const id = need(a.id, 'id');
    if (!leadId && !ctx.leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      member: modules.updateTeamMember(db, leadId || Number(ctx.leadId), id, a),
    }));
  }
  if (name === 'team.delete') {
    const leadId = resolveLeadId(ctx, a.leadId);
    const id = need(a.id, 'id');
    if (!leadId && !ctx.leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      ...modules.deleteTeamMember(db, leadId || Number(ctx.leadId), id),
    }));
  }

  if (name === 'events.list') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      events: modules.listEvents(db, leadId, { includeDrafts: a.includeDrafts !== false }),
    }));
  }
  if (name === 'events.create') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({ plan: planId, event: modules.createEvent(db, leadId, a) }));
  }
  if (name === 'events.update') {
    const leadId = resolveLeadId(ctx, a.leadId);
    const id = need(a.id, 'id');
    if (!leadId && !ctx.leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      event: modules.updateEvent(db, leadId || Number(ctx.leadId), id, a),
    }));
  }
  if (name === 'events.delete') {
    const leadId = resolveLeadId(ctx, a.leadId);
    const id = need(a.id, 'id');
    if (!leadId && !ctx.leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      ...modules.deleteEvent(db, leadId || Number(ctx.leadId), id),
    }));
  }

  if (name === 'bookings.services') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      services: modules.listBookingServices(db, leadId, { includeDrafts: a.includeDrafts !== false }),
    }));
  }
  if (name === 'bookings.createService') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    if (!a.name || !String(a.name).trim()) throw new Error('name is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      service: modules.createBookingService(db, leadId, a),
    }));
  }
  if (name === 'bookings.updateService') {
    const leadId = resolveLeadId(ctx, a.leadId);
    const id = need(a.id, 'id');
    if (!leadId && !ctx.leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      service: modules.updateBookingService(db, leadId || Number(ctx.leadId), id, a),
    }));
  }
  if (name === 'bookings.deleteService') {
    const leadId = resolveLeadId(ctx, a.leadId);
    const id = need(a.id, 'id');
    if (!leadId && !ctx.leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      ...modules.deleteBookingService(db, leadId || Number(ctx.leadId), id),
    }));
  }
  if (name === 'bookings.getHours') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => {
      modules.ensureDefaultBookingHours(db, leadId);
      return {
        plan: planId,
        hours: modules.listBookingHours(db, leadId),
        settings: modules.getBookingSettings(db, leadId),
      };
    });
  }
  if (name === 'bookings.setHours') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    if (!Array.isArray(a.hours)) throw new Error('hours is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      hours: modules.setBookingHours(db, leadId, a.hours),
    }));
  }
  if (name === 'bookings.setSettings') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      settings: modules.updateBookingSettings(db, leadId, a),
    }));
  }
  if (name === 'bookings.list') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      appointments: modules.listAppointments(db, leadId, {
        status: a.status,
        from: a.from,
        to: a.to,
        limit: a.limit,
        includeArchived: a.includeArchived,
        archivedOnly: a.archivedOnly,
      }),
    }));
  }
  if (name === 'bookings.updateStatus') {
    const leadId = resolveLeadId(ctx, a.leadId);
    const id = need(a.id, 'id');
    if (!leadId && !ctx.leadId) throw new Error('leadId is required');
    if (a.status == null && a.archived == null) throw new Error('status or archived is required');
    const lid = leadId || Number(ctx.leadId);
    return domain.withDb(ws, (db) => {
      let appointment = null;
      if (a.status != null) {
        appointment = modules.updateAppointmentStatus(db, lid, id, a.status);
      }
      if (a.archived != null) {
        appointment = modules.setAppointmentArchived(db, lid, id, a.archived);
      }
      return { plan: planId, appointment };
    });
  }
  if (name === 'bookings.slots') {
    const leadId = resolveLeadId(ctx, a.leadId);
    if (!leadId) throw new Error('leadId is required');
    return domain.withDb(ws, (db) => ({
      plan: planId,
      ...modules.listAvailableSlots(db, leadId, {
        date: a.date,
        serviceId: a.serviceId || a.service_id,
        serviceSlug: a.service || a.serviceSlug,
      }),
    }));
  }

  return undefined;
}

async function callTool(workspaceId, name, args = {}, ctx = {}) {
  const a = args || {};
  const ws = workspaceId;
  // Cursor / some clients expose tools as website_addSection; server defs use dots.
  name = String(name || '').trim().replace(/_/g, '.');

  try {
    if (ctx && ctx.leadId) {
      const clientNames = new Set(clientToolDefs().map((t) => t.name));
      if (!clientNames.has(name)) {
        const leadTools = /^lead\./.test(name) && !/^leadscout\./.test(name);
        return {
          ok: false,
          error: leadTools
            ? `Tool ${name} needs a workspace token (ws_…). This connection is client-scoped (cl_/Claude OAuth) and only has portal tools for lead #${ctx.leadId}. Use site.get for that lead, or leadscout.contacts.list for form/booking contacts. For the outreach lead pipeline, reconnect MCP with a workspace Bearer token from the staff app.`
            : `Tool ${name} is not available on client-scoped MCP tokens.`,
        };
      }
    }

    const clientOut = await callClientTool(ws, name, a, ctx);
    if (clientOut !== undefined) return { ok: true, data: clientOut };

    if (name === 'lead.search') return { ok: true, data: domain.leadsList(ws, a) };
    if (name === 'lead.get') {
      const data = domain.leadsGet(ws, a.id);
      if (!data) return { ok: false, error: 'NOT_FOUND' };
      return { ok: true, data };
    }
    if (name === 'lead.create') {
      const idem = require('./idempotency');
      const { openWorkspaceDb } = require('./workspaceDb');
      const key = a.idempotencyKey || a.idempotency_key || null;
      const body = { ...a };
      delete body.idempotencyKey;
      delete body.idempotency_key;
      const data = await idem.once(openWorkspaceDb(ws), 'leads.create', key, body, async () => ({
        lead: domain.leadsCreate(ws, body),
      }));
      return { ok: true, data };
    }
    if (name === 'lead.update') {
      const { id, ...patch } = a;
      return { ok: true, data: { lead: domain.leadsUpdate(ws, id, patch) } };
    }
    if (name === 'lead.delete') {
      try {
        domain.leadsDelete(ws, a.id);
        return { ok: true, data: { id: a.id } };
      } catch (e) {
        if (/FOREIGN KEY|SQLITE_CONSTRAINT/i.test(String(e && e.message || ''))) {
          return {
            ok: false,
            error: { code: 'FK_CONFLICT', message: 'Delete blocked: referenced by websites_or_design_jobs' },
          };
        }
        throw e;
      }
    }
    if (name === 'lead.qualify') return { ok: true, data: { lead: domain.leadsQualify(ws, a.id) } };
    if (name === 'lead.score') return { ok: true, data: domain.leadsScore(ws, a.id) };
    if (name === 'lead.research') return { ok: true, data: await domain.leadsResearch(ws, a.id) };
    if (name === 'lead.discover') return { ok: true, data: await domain.leadsDiscover(ws, a) };
    if (name === 'lead.importCsv') return { ok: true, data: domain.leadsImportCsv(ws, a.text, a) };
    if (name === 'lead.merge') return { ok: true, data: { lead: domain.leadsMerge(ws, a.keepId, a.dropIds) } };
    if (name === 'lead.duplicates') return { ok: true, data: { duplicates: domain.leadsDuplicates(ws, a.id) } };
    if (name === 'lead.facets') return { ok: true, data: { facets: domain.leadsFacets(ws) } };
    if (name === 'lead.bulk') return { ok: true, data: { bulk: await domain.leadsBulk(ws, a) } };

    if (name === 'design.pending') return { ok: true, data: domain.designPending(ws) };
    if (name === 'design.next') return { ok: true, data: { job: domain.designNext(ws) } };
    if (name === 'design.list') return { ok: true, data: domain.designList(ws, a) };
    if (name === 'design.get') return { ok: true, data: { job: domain.designGet(ws, a.id) } };
    if (name === 'design.create') {
      const idem = require('./idempotency');
      const { openWorkspaceDb } = require('./workspaceDb');
      const key = a.idempotencyKey || a.idempotency_key || null;
      const body = { ...a };
      delete body.idempotencyKey;
      delete body.idempotency_key;
      const data = await idem.once(openWorkspaceDb(ws), 'design.jobs.create', key, body, async () => ({
        job: domain.designCreate(ws, body),
      }));
      return { ok: true, data };
    }
    if (name === 'design.deliver') {
      const idem = require('./idempotency');
      const { openWorkspaceDb } = require('./workspaceDb');
      const key = a.idempotencyKey || a.idempotency_key || null;
      const idemBody = { id: a.id, payload: a.payload, claims: a.claims };
      const receipt = await idem.once(openWorkspaceDb(ws), 'design.deliver', key, idemBody, async () => {
        const job = await domain.designDeliver(ws, a.id, a.payload, a.claims, a);
        const qaRaw = job && (job.qa || job.qa_result);
        let checksFailed = [];
        let passed = true;
        if (qaRaw && typeof qaRaw === 'object') {
          passed = qaRaw.passed !== false && qaRaw.ok !== false;
          const fails = qaRaw.checks_failed || qaRaw.failed || qaRaw.failures || [];
          if (Array.isArray(fails)) {
            checksFailed = fails.map((f) => (typeof f === 'string' ? f : (f && (f.name || f.message)) || String(f))).slice(0, 40);
          }
        }
        return {
          job_id: job && job.id != null ? Number(job.id) : null,
          status: (job && job.status) || null,
          website_id: job && job.website_id != null ? Number(job.website_id) : null,
          qa: { passed: !!passed, checks_failed: checksFailed },
        };
      });
      if (a.full === true) {
        return { ok: true, data: { receipt, job: domain.designGet(ws, a.id) } };
      }
      return { ok: true, data: receipt };
    }
    if (name === 'design.ask') return { ok: true, data: domain.designAsk(ws, a.id, a.question) };
    if (name === 'design.review') return { ok: true, data: await domain.designReview(ws, a.id, a) };
    if (name === 'design.redesign') return { ok: true, data: await domain.designRedesign(ws, a.id, a) };
    if (name === 'design.improve') return { ok: true, data: await domain.designImprove(ws, a.id, a) };
    if (name === 'design.previewUrl') return { ok: true, data: await domain.designPreviewUrl(ws, a.id, false) };

    if (name === 'website.list') return { ok: true, data: domain.sitesList(ws, a) };
    if (name === 'website.get') return { ok: true, data: { site: domain.sitesGet(ws, a.id) } };
    if (name === 'website.delete') return { ok: true, data: domain.sitesDelete(ws, need(a.id, 'id')) };
    if (name === 'website.generate') return { ok: true, data: await domain.sitesGenerate(ws, a.leadId, a) };
    if (name === 'website.qa') return { ok: true, data: await domain.sitesQa(ws, a.id) };
    if (name === 'website.export') return { ok: true, data: await domain.sitesExport(ws, a.id) };
    if (name === 'website.postcard') {
      const kit = a.includePdf
        ? await domain.sitesPostcard(ws, need(a.id, 'id'))
        : await domain.sitesClaimKit(ws, need(a.id, 'id'));
      if (kit.pdf) {
        const { pdf, ...rest } = kit;
        return {
          ok: true,
          data: {
            ...rest,
            pdfBase64: pdf.toString('base64'),
            pdfBytes: pdf.length,
          },
        };
      }
      return { ok: true, data: kit };
    }
    if (name === 'lead.claimKit') {
      const leadId = need(a.leadId != null ? a.leadId : a.id, 'leadId');
      const kit = await domain.leadsClaimKit(ws, leadId, {
        websiteId: a.websiteId,
        includePdf: !!a.includePdf,
      });
      if (kit.pdf) {
        const { pdf, ...rest } = kit;
        return {
          ok: true,
          data: {
            ...rest,
            pdfBase64: pdf.toString('base64'),
            pdfBytes: pdf.length,
          },
        };
      }
      return { ok: true, data: kit };
    }

    if (name === 'outreach.campaigns') {
      if (a.action === 'list') return { ok: true, data: domain.campaignsList(ws, a) };
      if (a.action === 'create') {
        ensureNotPaused(ws);
        return { ok: true, data: domain.campaignsCreate(ws, a) };
      }
      if (a.action === 'setStatus') return { ok: true, data: domain.campaignsSetStatus(ws, a.id, a.status) };
      if (a.action === 'cancel') return { ok: true, data: domain.campaignsCancel(ws, a.id) };
      if (a.action === 'delete') return { ok: true, data: domain.campaignsDelete(ws, a.id) };
      if (a.action === 'messages') return { ok: true, data: domain.campaignsMessages(ws, a.id, a) };
      return { ok: false, error: 'Unknown campaigns action' };
    }
    if (name === 'outreach.templates') {
      if (a.action === 'list') return { ok: true, data: { templates: domain.templatesList(ws) } };
      if (a.action === 'save') return { ok: true, data: domain.templatesSave(ws, a) };
      if (a.action === 'delete') return { ok: true, data: domain.templatesDelete(ws, a.id) };
      return { ok: false, error: 'Unknown templates action' };
    }
    if (name === 'outreach.processQueue') {
      ensureNotPaused(ws);
      return { ok: true, data: await domain.outreachProcessQueue(ws) };
    }
    if (name === 'outreach.stats') return { ok: true, data: domain.outreachStats(ws) };
    if (name === 'outreach.pipeline') return { ok: true, data: domain.pipelineBoard(ws, a) };
    if (name === 'email.compose') return { ok: true, data: domain.emailCompose(ws, a.leadId, a.templateId, { queue: !!a.queue, channel: a.channel }) };
    if (name === 'email.draft') {
      ensureNotPaused(ws);
      return { ok: true, data: await domain.emailDraft(ws, a) };
    }
    if (name === 'email.uploadAsset') {
      const data = a.data != null ? a.data : a.base64;
      if (data == null || data === '') throw new Error('data (base64 image) is required');
      const dataB64 = String(data).replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '').replace(/\s+/g, '');
      const maxB64 = Math.ceil(5 * 1024 * 1024 * 4 / 3) + 256;
      if (dataB64.length > maxB64) throw new Error('Image is too large (max 5 MB).');
      return { ok: true, data: await domain.emailUploadAsset(ws, { data: dataB64, mimeType: a.mimeType || a.mime }) };
    }
    if (name === 'sms.queue') {
      ensureNotPaused(ws);
      return { ok: true, data: domain.smsQueue(ws, a) };
    }

    if (name === 'settings.get') return { ok: true, data: { settings: domain.settingsGetAll(ws) } };
    if (name === 'settings.set') return { ok: true, data: domain.settingsSet(ws, a.key, a.value) };
    if (name === 'automation.pause') return { ok: true, data: domain.automationSet(ws, true) };
    if (name === 'automation.resume') return { ok: true, data: domain.automationSet(ws, false) };
    if (name === 'analytics.get') return { ok: true, data: domain.dashboardStats(ws) };

    if (name === 'discovery.schedule') {
      if (a.action === 'get') return { ok: true, data: domain.discoveryGet(ws) };
      if (a.action === 'set') return { ok: true, data: { schedule: domain.discoverySet(ws, a) } };
      if (a.action === 'runNow') return { ok: true, data: await domain.discoveryRunNow(ws) };
      return { ok: false, error: 'Unknown discovery action' };
    }
    if (name === 'cloudflare.publish') return { ok: true, data: await domain.cfPublish(ws, a.websiteId, a.dir) };
    if (name === 'cloudflare.test') return { ok: true, data: await domain.cfTest(ws) };
    if (name === 'domains.search') {
      return { ok: true, data: await domain.domainsSearch(ws, a.q || a.query, { leadId: a.leadId, limit: a.limit }) };
    }
    if (name === 'domains.check') {
      return { ok: true, data: await domain.domainsCheck(ws, a.domains || a.names || [a.domain]) };
    }
    if (name === 'domains.register') return { ok: true, data: await domain.domainsRegister(ws, a) };
    if (name === 'domains.status') return { ok: true, data: await domain.domainsRegistrationStatus(ws, a.domain) };
    if (name === 'domains.list') return { ok: true, data: domain.domainsList(ws, a) };
    if (name === 'domains.owned') return { ok: true, data: await domain.domainsOwned(ws) };
    if (name === 'domains.link') return { ok: true, data: await domain.domainsLink(ws, a) };
    if (name === 'domains.unlink') return { ok: true, data: await domain.domainsUnlink(ws, a) };

    if (name === 'jobs.list') return { ok: true, data: { jobs: await jobs.listJobs(ws), types: jobs.JOB_TYPES } };
    if (name === 'jobs.create') return { ok: true, data: { job: await jobs.createJob(ws, a) } };
    if (name === 'jobs.update') return { ok: true, data: { job: await jobs.updateJob(ws, a.id, a) } };
    if (name === 'jobs.delete') return { ok: true, data: await jobs.deleteJob(ws, a.id) };
    if (name === 'jobs.runNow') return { ok: true, data: await jobs.executeJob(ws, a.id, { force: true, source: 'mcp', triggeredBy: ctx.tokenId ? 'token:' + ctx.tokenId : (ctx.userId ? 'user:' + ctx.userId : 'mcp-workspace') }) };
    if (name === 'handsOff.status') return { ok: true, data: await domain.handsOffStatus(ws) };
    if (name === 'handsOff.runNow') {
      ensureNotPaused(ws);
      return { ok: true, data: await domain.handsOffRunNow(ws, { force: !!a.force }) };
    }

    const parity = await callParityTool(ws, name, a);
    if (parity !== undefined) return { ok: true, data: parity };

    return { ok: false, error: `Unknown tool: ${name}` };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function handleJsonRpc(workspaceId, body, ctx = {}) {
  const req = typeof body === 'string' ? JSON.parse(body) : body;
  const id = Object.prototype.hasOwnProperty.call(req, 'id') ? req.id : undefined;
  const isNotification = id === undefined;
  const reply = (result, error) => {
    if (isNotification) return null;
    if (error) return { jsonrpc: '2.0', id, error };
    return { jsonrpc: '2.0', id, result };
  };
  const clientScoped = !!(ctx && ctx.leadId);
  try {
    if (req.method === 'initialize') {
      return reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    if (req.method === 'notifications/initialized' || req.method === 'initialized') return null;
    if (req.method === 'ping') return reply({});
    if (req.method === 'tools/list') {
      return reply({
        tools: toolDefs({ clientScoped }).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    }
    if (req.method === 'tools/call') {
      const outcome = await callTool(
        workspaceId,
        req.params && req.params.name,
        (req.params && req.params.arguments) || {},
        ctx
      );
      return reply({ content: [{ type: 'text', text: JSON.stringify(outcome) }], isError: !outcome.ok });
    }
    return reply(null, { code: -32601, message: `Method not found: ${req.method}` });
  } catch (e) {
    return reply(null, { code: -32000, message: e.message || String(e) });
  }
}

module.exports = {
  handleJsonRpc,
  callTool,
  toolDefs,
  clientToolDefs,
  SERVER_INFO,
  PROTOCOL_VERSION,
  createWorkspaceToken,
};
