'use strict';

// Shared MCP metadata. src/mcp.js uses this for tools/list, and the desktop
// app shows the same catalog on the MCP page. Keep run() implementations in mcp.js.

const server = { name: 'website-scout-mcp', version: '0.1.0' };

// Stable initialize-handshake revisions (newest last). initialize echoes the
// client's protocolVersion when it is in this list; otherwise it answers with
// the newest. The draft 2026 per-request metadata handshake is a different
// session model — this server stays on stdio + initialize.
const protocolVersions = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const protocolVersion = protocolVersions[protocolVersions.length - 1];

const tools = [
  {
    name: 'lead.search',
    description: 'Search leads by keyword, status, and minimum score.',
    schema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Keyword matched against name, category, city, email' },
        status: { type: 'string', description: 'Lead status filter' },
        minScore: { type: 'integer', minimum: 0, maximum: 100 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
    },
  },
  {
    name: 'lead.get',
    description: 'Get full details for one lead, including facts and latest score.',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 } },
      required: ['id'],
    },
  },
  {
    name: 'lead.qualify',
    description: 'Mark a lead as qualified with an optional note.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        note: { type: 'string', maxLength: 2000 },
      },
      required: ['id'],
    },
  },
  {
    name: 'lead.create',
    description: 'Create a lead (manual / MCP). Requires business_name. Optional contact and location fields, status, tags, group, notes. Defaults status to "new" and source to "mcp" when omitted.',
    schema: {
      type: 'object',
      properties: {
        business_name: { type: 'string', maxLength: 200 },
        category: { type: 'string', maxLength: 120 },
        phone: { type: 'string', maxLength: 40 },
        email: { type: 'string', maxLength: 200 },
        website: { type: 'string', maxLength: 500 },
        address: { type: 'string', maxLength: 300 },
        city: { type: 'string', maxLength: 120 },
        state: { type: 'string', maxLength: 80 },
        postal_code: { type: 'string', maxLength: 30 },
        country: { type: 'string', maxLength: 80 },
        description: { type: 'string', maxLength: 4000 },
        notes: { type: 'string', maxLength: 10000 },
        status: { type: 'string', maxLength: 40, description: 'new, researching, qualified, ready, …' },
        tags: { type: 'array', items: { type: 'string', maxLength: 60 }, maxItems: 30 },
        group: { type: 'string', maxLength: 120, description: 'Lead group / batch label' },
        lead_group: { type: 'string', maxLength: 120 },
        source: { type: 'string', maxLength: 80 },
        rating: { type: 'number', minimum: 0, maximum: 5 },
        review_count: { type: 'integer', minimum: 0 },
      },
      required: ['business_name'],
    },
  },
  {
    name: 'lead.update',
    description: 'Update fields on an existing lead. Pass id plus only the fields to change (partial update).',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        business_name: { type: 'string', maxLength: 200 },
        category: { type: 'string', maxLength: 120 },
        phone: { type: 'string', maxLength: 40 },
        email: { type: 'string', maxLength: 200 },
        website: { type: 'string', maxLength: 500 },
        address: { type: 'string', maxLength: 300 },
        city: { type: 'string', maxLength: 120 },
        state: { type: 'string', maxLength: 80 },
        postal_code: { type: 'string', maxLength: 30 },
        country: { type: 'string', maxLength: 80 },
        description: { type: 'string', maxLength: 4000 },
        notes: { type: 'string', maxLength: 10000 },
        status: { type: 'string', maxLength: 40 },
        tags: { type: 'array', items: { type: 'string', maxLength: 60 }, maxItems: 30 },
        group: { type: 'string', maxLength: 120 },
        lead_group: { type: 'string', maxLength: 120 },
        source: { type: 'string', maxLength: 80 },
        rating: { type: 'number', minimum: 0, maximum: 5 },
        review_count: { type: 'integer', minimum: 0 },
      },
      required: ['id'],
    },
  },
  {
    name: 'lead.delete',
    description: 'Permanently delete a lead and its facts/scores/events. Irreversible.',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 } },
      required: ['id'],
    },
  },
  {
    name: 'lead.addFact',
    description: 'Attach a structured business fact to a lead (phone, hours, services, etc.). claim_class must be VERIFIED, AI_COPY, OWNER_PROVIDED, or UNKNOWN.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1, description: 'Lead id' },
        fact_key: { type: 'string', maxLength: 200 },
        value: { type: 'string', maxLength: 80000 },
        source: { type: 'string', maxLength: 200 },
        source_url: { type: 'string', maxLength: 1000 },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        claim_class: { type: 'string', enum: ['VERIFIED', 'AI_COPY', 'OWNER_PROVIDED', 'UNKNOWN'] },
      },
      required: ['id', 'fact_key', 'value', 'source', 'claim_class'],
    },
  },
  {
    name: 'website.create',
    description: 'Open a website design job for the agent (type=website). Does not build a local template site — the agent designs freely and delivers via design.deliver. Pass site_shape: "landing" (one focused scrollable page; collapse recommended_pages into sections) or "multipage" (full IA from site_map.recommended_pages). When omitted, inferred from recommended_pages count (many → multipage, else landing). Queuing sets waiting_on_agent and fires the optional agent notify/trigger. For logo/social/flyer/brand/other, use design.create.',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        site_shape: { type: 'string', enum: ['landing', 'multipage'], description: 'landing = one focused page; multipage = map recommended_pages' },
        siteShape: { type: 'string', enum: ['landing', 'multipage'], description: 'Alias of site_shape' },
      },
      required: ['leadId'],
    },
  },
  {
    name: 'design.create',
    description: 'Create any design job kind for the MCP agent (website, logo, social, flyer, brand, other, or a custom label). Requires type, title, and instructions. Optional leadId and contactEmail. For website jobs, optional site_shape landing|multipage (same inference as website.create when omitted). Sets waiting_on_agent and fires the optional agent notify/trigger. website.create remains the short path for lead-linked websites with default instructions.',
    schema: {
      type: 'object',
      properties: {
        type: { type: 'string', maxLength: 40, description: 'website, logo, social, flyer, brand, other, or your own label' },
        title: { type: 'string', maxLength: 200 },
        instructions: { type: 'string', maxLength: 8000 },
        leadId: { type: 'integer', minimum: 1 },
        contactEmail: { type: 'string', maxLength: 254 },
        site_shape: { type: 'string', enum: ['landing', 'multipage'], description: 'Website jobs only' },
        siteShape: { type: 'string', enum: ['landing', 'multipage'], description: 'Alias of site_shape' },
      },
      required: ['type', 'title', 'instructions'],
    },
  },
  {
    name: 'website.preview',
    description: 'Publish/export a website and return a public preview URL (Cloudflare Pages or APP_URL /site-previews/…). Pass force:true to rematerialize and republish even when a stored preview URL looks healthy.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        open: { type: 'boolean' },
        force: { type: 'boolean', description: 'Force rematerialize + Cloudflare republish' },
      },
      required: ['id'],
    },
  },
  {
    name: 'website.edit',
    description: 'Edit a website. Pass pages (+ optional theme, note) for a full validated save (multipage nav links normalized), or instruction for a safe structural edit (primary colour, rename, add section, phone). Theme is optional on full save — current theme is merged when omitted. Prefer website.setTheme for palette-only changes.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        pages: { type: 'array' },
        theme: { type: 'object' },
        note: { type: 'string' },
        instruction: { type: 'string', maxLength: 2000 },
      },
      required: ['id'],
    },
  },
  {
    name: 'design.pending',
    description: 'Poll-friendly summary of work waiting on the MCP agent (waiting_on_agent and questions_pending). The desktop app does not push to stdio clients — call this on session start, after notifications on HTTP SSE, or on a timer. Returns counts and a preview ordered oldest-first. Use design.next to claim the next waiting_on_agent job. When jobs enter waiting_on_agent the app also writes an optional agent trigger file / desktop notify / shell command (see design.agentTrigger) — that is not an MCP push.',
    schema: {
      type: 'object',
      properties: {
        previewLimit: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'How many queued jobs to include in preview' },
      },
    },
  },
  {
    name: 'design.next',
    description: 'Claim the oldest design job with status waiting_on_agent: returns the full job (same as design.get) and sets status to in_progress. Refreshes brief.learned_lessons from the design learning playbook when learning is on. Returns job null when the queue is empty. Does not claim questions_pending jobs — read answers with design.answers first. Jobs may already have been announced via the optional agent trigger (design.agentTrigger); this tool is how you claim them.',
    schema: { type: 'object', properties: {} },
  },
  {
    name: 'design.list',
    description: 'List design jobs assigned to the agent (any kind of work: website, logo, social, flyer, brand, or another label). Returns instructions, status, and whether a delivery exists. Does not include the full deliverable; use design.get. For open work, prefer design.pending or design.next.',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'draft, waiting_on_agent, questions_pending, in_progress, or delivered' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      },
    },
  },
  {
    name: 'design.get',
    description: 'Read one design job: instructions, site_shape (landing|multipage), request_kind when set (redesign|improvements), brief (including learned_lessons craft tips when Design learning is on), verified contact facts, constraints, Q&A, review summary, delivery, and pending_email_redesigns (inbound client change requests). Claiming waiting_on_agent refreshes learned_lessons. For website jobs: landing = one focused page (collapse recommended_pages into sections); multipage = deliver the full IA from site_map.recommended_pages. Be freely creative — the app does not design or restyle the work. Only verified_facts may be labeled VERIFIED for phone/address/hours/reviews; other copy is AI_COPY. Never invent business facts from learned_lessons. Screenshot base64 is never included — use review.screenshots[].path / screenshot_dir if present.',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 } },
      required: ['id'],
    },
  },
  {
    name: 'design.ask',
    description: 'Post a clarifying question on a design job. The user answers in the desktop app. Questions are optional.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        question: { type: 'string', maxLength: 2000 },
      },
      required: ['id', 'question'],
    },
  },
  {
    name: 'design.answers',
    description: 'Read questions and the user answers for a design job, including pasted email replies (from_email and answered_at).',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 } },
      required: ['id'],
    },
  },
  {
    name: 'design.emailQuestions',
    description: 'Email the unanswered questions for one design job only. Subject includes the project id. Sends via workspace SMTP when configured (also records a campaign_messages row when the job has a lead). Returns SMTP_NOT_CONFIGURED with the composed subject and body when mail is not set up. Respects the suppression list, daily outreach cap, and automation pause. Does not mark another job as emailed.',
    schema: {
      type: 'object',
      properties: {
        jobId: { type: 'integer', minimum: 1 },
        id: { type: 'integer', minimum: 1, description: 'Alias of jobId' },
      },
    },
  },
  {
    name: 'design.emailDelivery',
    description: 'Email a non-website delivery (social, logo, flyer, brand, etc.) to the job/lead contact as clean plain text (sections matching the Design cards: headlines, captions, hashtags, CTAs). Website jobs are rejected — use export/preview instead. Sends via workspace SMTP when configured. Returns SMTP_NOT_CONFIGURED with composed subject/body when mail is not set up. Requires contact_email on the job or email on the lead.',
    schema: {
      type: 'object',
      properties: {
        jobId: { type: 'integer', minimum: 1 },
        id: { type: 'integer', minimum: 1, description: 'Alias of jobId' },
      },
    },
  },
  {
    name: 'design.deliver',
    description: 'Submit the finished design as-is (no local prompts or industry templates). Website payload: { name, theme, pages }. Prefer page.html (body or full HTML document) + theme.customCss; baseCss defaults off when customCss is set. Scripts stripped; style tags and https font/stylesheet links allowed. Built-in section types are optional. Optional site_shape ("landing"|"multipage") records or corrects the delivery shape. Other job types: any JSON. VERIFIED claims only when values match verified facts. Missing Pexels key does not block delivery.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        payload: { type: 'object' },
        site_shape: { type: 'string', enum: ['landing', 'multipage'], description: 'Optional. landing = one page; multipage = full IA' },
        siteShape: { type: 'string', enum: ['landing', 'multipage'], description: 'Alias of site_shape' },
        claims: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              claim: { type: 'string' },
              value: { type: 'string' },
              class: { type: 'string', enum: ['VERIFIED', 'AI_COPY', 'OWNER_PROVIDED', 'UNKNOWN'] },
            },
          },
        },
      },
      required: ['id', 'payload'],
    },
  },
  {
    name: 'design.images',
    description: 'Optional. Search Pexels, download photos into app export storage (EXPORT_ROOT/design-{id}/images), and attach local images/… paths to a delivered website job — never leaves images.pexels.com hotlinks. Uses the lead category or an explicit query. Fails clearly if the Pexels key is missing; never required for design.deliver. Respects the automation pause.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        query: { type: 'string', maxLength: 120 },
        count: { type: 'integer', minimum: 1, maximum: 6 },
      },
      required: ['id'],
    },
  },
  {
    name: 'design.generateImage',
    description: 'Generate images with the OpenAI Images API (ai.api_key / ai.model.image, default gpt-image-2.5-sunburst) and attach them to a delivered design job. Websites: inject into gallery/hero. Other types: append to images/files with on-disk paths under generated-images/. Optional prompt; otherwise a lead-aware default is used. Returns paths (no base64). Respects automation pause.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        prompt: { type: 'string', maxLength: 4000, description: 'Image prompt. Omit to use a lead/job default.' },
        n: { type: 'integer', minimum: 1, maximum: 4, description: 'Number of images (default 2, or 1 for logos).' },
        size: { type: 'string', description: '1024x1024 | 1024x1536 | 1536x1024 | 512x512 | 256x256' },
        quality: { type: 'string', description: 'Optional gpt-image quality (e.g. low, medium, high).' },
        model: { type: 'string', maxLength: 120, description: 'Override ai.model.image.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'design.generateLogo',
    description: 'Generate a site header logo with OpenAI Images (transparent PNG preferred), cover-crop to a consistent header size, attach to the design job, and apply to the linked website via theme.logoMode=image + theme.logoUrl. Existing sites stay on text logos until this (or website.setLogo / portal upload) is used. Optional prompt and brandName. Respects automation pause.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1, description: 'Design job id' },
        prompt: { type: 'string', maxLength: 4000, description: 'Logo prompt. Omit for a lead-aware default.' },
        brandName: { type: 'string', maxLength: 120, description: 'Optional brand label / alt text.' },
        websiteId: { type: 'integer', minimum: 1, description: 'Override which website receives the logo.' },
        size: { type: 'string' },
        quality: { type: 'string' },
        model: { type: 'string', maxLength: 120 },
      },
      required: ['id'],
    },
  },
  {
    name: 'website.setLogo',
    description: 'Set a website header logo without regenerating the site. mode "text" restores the text brand name; mode "image" accepts base64 image data (JPEG/PNG/WebP/GIF, max ~5.5MB), cover-crops, strips solid backgrounds when feasible, and saves images/logo.png with theme.logoMode=image. Pass id or leadId.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1, description: 'Website id' },
        leadId: { type: 'integer', minimum: 1, description: 'Resolve website from lead when id omitted' },
        mode: { type: 'string', enum: ['text', 'image'] },
        data: { type: 'string', description: 'Base64 image (required for mode=image)' },
        mimeType: { type: 'string' },
        brandName: { type: 'string', maxLength: 120 },
      },
    },
  },
  {
    name: 'website.setTheme',
    description: 'Set website theme colors (primary, secondary, bg, text as #RRGGBB). Rewrites matching hexes in theme.customCss. Pass id or leadId. Same color model as the client portal.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        leadId: { type: 'integer', minimum: 1 },
        primary: { type: 'string' },
        secondary: { type: 'string' },
        bg: { type: 'string' },
        text: { type: 'string' },
        colors: { type: 'object', description: 'Optional bag of primary/secondary/bg/text' },
        note: { type: 'string', maxLength: 500 },
      },
    },
  },
  {
    name: 'website.replaceImage',
    description: 'Replace a site image by replaceSrc (e.g. images/hero.jpg): pass data (base64 upload) or prompt (AI generate; spends credits unless plan includes images). Pass id or leadId. Does not fetch remote URLs.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        leadId: { type: 'integer', minimum: 1 },
        replaceSrc: { type: 'string', maxLength: 500 },
        src: { type: 'string', maxLength: 500, description: 'Alias of replaceSrc' },
        data: { type: 'string', description: 'Base64 image upload' },
        mimeType: { type: 'string' },
        prompt: { type: 'string', maxLength: 2000, description: 'AI image prompt when not uploading' },
        size: { type: 'string' },
        quality: { type: 'string' },
      },
    },
  },
  {
    name: 'website.structure',
    description: 'Read the WordPress-style menu tree and per-page section list for a website (visual order, depth, menuParent, canNest/canUnnest flags). Pass id (website id).',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        websiteId: { type: 'integer', minimum: 1 },
      },
    },
  },
  {
    name: 'website.structure.reorder',
    description: 'Reorder menu pages or page sections, or nest/unnest a one-level submenu (WordPress-style menuParent). scope=menu|sections; action=move|nest|unnest (indent/outdent aliases). For move, pass direction -1|1. fromIndex is the page array index from website.structure.menu[].index (or section index when scope=sections + pageIndex). Saves a new site version and syncs freeform nav markup.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        websiteId: { type: 'integer', minimum: 1 },
        scope: { type: 'string', enum: ['menu', 'sections'] },
        action: { type: 'string', enum: ['move', 'nest', 'unnest', 'indent', 'outdent'] },
        fromIndex: { type: 'integer', minimum: 0 },
        direction: { type: 'integer', enum: [-1, 1] },
        pageIndex: { type: 'integer', minimum: 0, description: 'Required when scope=sections' },
      },
      required: ['scope', 'fromIndex'],
    },
  },
  {
    name: 'site.screenshots.list',
    description: 'List registered site preview screenshots for a websiteId or leadId (home/services × desktop/mobile captures plus email/MMS JPEG renditions). Served from /site-previews/site-{id}/screenshots/. Optional checkReady runs HTTP 200 + image/* validation.',
    schema: {
      type: 'object',
      properties: {
        websiteId: { type: 'integer', minimum: 1 },
        leadId: { type: 'integer', minimum: 1 },
        currentOnly: { type: 'boolean' },
        checkReady: { type: 'boolean' },
        kind: { type: 'string', enum: ['capture', 'email', 'mms'] },
      },
    },
  },
  {
    name: 'site.screenshots.capture',
    description: 'Capture or regenerate viewport screenshots of a live site preview (homepage + services page; desktop 1440×900 and mobile 390×844). Stores PNG captures and email (≤1200px JPEG) + MMS (<900KB JPEG) renditions under EXPORT_ROOT. Does not send campaigns. Prefers forcePreview to refresh the public preview URL first.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1, description: 'Website id' },
        websiteId: { type: 'integer', minimum: 1 },
        forcePreview: { type: 'boolean' },
        previewUrl: { type: 'string' },
        leadId: { type: 'integer', minimum: 1 },
      },
    },
  },
  {
    name: 'domains.search',
    description: 'Search Cloudflare Registrar for available domain suggestions (keyword or name). Non-authoritative — call domains.check before purchase. Requires cf.api_token with Registrar permissions.',
    schema: {
      type: 'object',
      properties: {
        q: { type: 'string', maxLength: 200 },
        query: { type: 'string', maxLength: 200 },
        leadId: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: 'domains.check',
    description: 'Real-time Cloudflare Registrar availability + pricing for one or more domains. Call before domains.register.',
    schema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        domains: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'domains.register',
    description: 'Purchase/register a domain via Cloudflare Registrar (bills the Cloudflare account payment method; non-refundable). Optional websiteId/leadId to associate. Poll domains.status until succeeded, then domains.link.',
    schema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        domainName: { type: 'string' },
        years: { type: 'integer', minimum: 1, maximum: 10 },
        websiteId: { type: 'integer', minimum: 1 },
        leadId: { type: 'integer', minimum: 1 },
      },
      required: ['domain'],
    },
  },
  {
    name: 'domains.status',
    description: 'Poll Cloudflare Registrar registration workflow status for a domain.',
    schema: {
      type: 'object',
      properties: { domain: { type: 'string' } },
      required: ['domain'],
    },
  },
  {
    name: 'domains.list',
    description: 'List domains tracked in this workspace (linked/registered/registering).',
    schema: {
      type: 'object',
      properties: {
        websiteId: { type: 'integer', minimum: 1 },
        leadId: { type: 'integer', minimum: 1 },
        status: { type: 'string' },
      },
    },
  },
  {
    name: 'domains.owned',
    description: 'List domains already on the Cloudflare Registrar account.',
    schema: { type: 'object', properties: {} },
  },
  {
    name: 'domains.link',
    description: 'Attach a domain to a website’s Cloudflare Pages project (custom hostname), set websites.custom_domain, and prefer that URL for outreach. Publishes the site when forcePublish is true or preview is missing.',
    schema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        websiteId: { type: 'integer', minimum: 1 },
        leadId: { type: 'integer', minimum: 1 },
        forcePublish: { type: 'boolean' },
        project: { type: 'string' },
      },
      required: ['domain', 'websiteId'],
    },
  },
  {
    name: 'domains.unlink',
    description: 'Unlink a domain from its website (optionally remove from Pages project).',
    schema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        project: { type: 'string' },
        removeFromPages: { type: 'boolean' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'design.openPreview',
    description: 'Open a delivered website in the default external browser. Exports HTML into ~/website-scout-exports/design-{id}/, starts a localhost preview server if needed, and returns { path, url } (e.g. http://127.0.0.1:8755/design-5/).',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 } },
      required: ['id'],
    },
  },
  {
    name: 'design.previewUrl',
    description: 'Export a delivered website job and return an accessible localhost HTTP URL for the agent (no browser open by default). Serves files from ~/website-scout-exports/design-{id}/ via http://127.0.0.1:8755/… so multipage relative links work. Use this instead of shipping zip/base64. Optional open:true also launches the system browser.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        open: { type: 'boolean', description: 'If true, also open the URL in the default browser.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'design.review',
    description: 'Review a delivered website job (automated QA + optional AI/vision). In Electron, captures mobile/desktop screenshots into review-shots and may run a vision pass unless skipScreenshots/skipAi. Return shape (data.review): pass, summary, issues[], checks[], redesign_instructions, improvement_instructions, ai_used, vision_used, site_shape, page_count, screenshots[{page,viewport,path}], screenshot_dir. screenshot_previews / base64 PNGs are stripped over MCP — open paths locally if needed. Does not requeue; call design.redesign or design.improve afterward.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        skipAi: { type: 'boolean', description: 'If true, skip the AI/vision review pass (heuristics + QA only).' },
        skipScreenshots: { type: 'boolean', description: 'If true, skip Electron screenshot capture (HTML-only review; typical for headless MCP).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'design.redesign',
    description: 'Queue a FULL redesign (visual/IA rethink) for a delivered website job: runs (or refreshes) a review, writes redesign instructions framed as === REDESIGN REQUEST ===, sets waiting_on_agent, trigger reason redesign (fires optional agent notify/trigger file). Prior deliverable remains; agent should revise and design.deliver. For copy/CTA/mobile/imagery polish only, use design.improve. Optional instructions override review.redesign_instructions. Returned review omits base64 previews.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        instructions: { type: 'string', description: 'Optional override redesign instructions (else use latest review.redesign_instructions).' },
        refresh: { type: 'boolean', description: 'Default true: run review before queueing if needed.' },
        forceReview: { type: 'boolean', description: 'Force a fresh review even if one exists.' },
        skipAi: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'design.improve',
    description: 'Queue INCREMENTAL improvements (not a full redesign): copy tweaks, CTA, mobile sizing, imagery polish. Writes === IMPROVEMENTS REQUEST ===, sets waiting_on_agent, trigger reason improvements (fires optional agent notify/trigger). Prior deliverable remains; agent should polish only and design.deliver. Optional instructions override review.improvement_instructions. Returned review omits base64 previews.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        instructions: { type: 'string', description: 'Optional override improvement instructions (else use latest review.improvement_instructions).' },
        refresh: { type: 'boolean', description: 'Default true: run review before queueing if needed.' },
        forceReview: { type: 'boolean', description: 'Force a fresh review even if one exists.' },
        skipAi: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'design.emailRedesign',
    description: 'Inbound client email change requests (redesign vs improvements). No IMAP yet — paste/ingest, drop-folder scan (.eml/.txt), or future inbound_hook. Actions: list (pending by default; optional jobId/status), get, ingest (body required; optional fromEmail/subject/designJobId/requestKind; force defaults true for paste), submit (queues design.redesign or design.improve from the email and fires agent trigger), dismiss, scan (process drop folder). Returns request rows + dropDir on list/scan.',
    schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'ingest', 'submit', 'dismiss', 'scan'],
          description: 'Which email-redesign operation to run',
        },
        id: { type: 'integer', minimum: 1, description: 'Request id for get/submit/dismiss' },
        requestId: { type: 'integer', minimum: 1, description: 'Alias of id' },
        jobId: { type: 'integer', minimum: 1, description: 'Filter list by design job' },
        designJobId: { type: 'integer', minimum: 1, description: 'Link ingest/submit to a design job' },
        leadId: { type: 'integer', minimum: 1 },
        fromEmail: { type: 'string', maxLength: 254 },
        subject: { type: 'string', maxLength: 500 },
        body: { type: 'string', maxLength: 12000, description: 'Required for ingest' },
        reply: { type: 'string', maxLength: 12000, description: 'Alias of body for ingest' },
        requestKind: { type: 'string', enum: ['redesign', 'improvements'], description: 'Override inferred kind' },
        request_kind: { type: 'string', enum: ['redesign', 'improvements'], description: 'Alias of requestKind' },
        force: { type: 'boolean', description: 'ingest: store even without redesign keywords (default true)' },
        instructions: { type: 'string', maxLength: 8000, description: 'submit: override email body as queue instructions' },
        status: { type: 'string', enum: ['pending', 'submitted', 'dismissed'], description: 'list filter' },
        pendingOnly: { type: 'boolean', description: 'list: default true unless status/includeAll set' },
        includeAll: { type: 'boolean', description: 'list: include all statuses' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
      required: ['action'],
    },
  },
  {
    name: 'design.agentTrigger',
    description: 'Read-only status of the optional agent wake-up path: trigger JSON file path, whether it exists, last payload, desktop notify on/off, and whether a shell command is configured. Queuing waiting_on_agent already fires notify/trigger — this tool does not fire again. Configure under Settings → Design agent.',
    schema: { type: 'object', properties: {} },
  },
  {
    name: 'design.lessons',
    description: 'Design learning playbook and raw observation events (reviews, redesign/improve queues, inbound email messages on paste/drop, email submits, delivers). Email bodies are learned as soon as they are saved (event_type email_message) and again on submit (email_submit). Actions: status, list (events; optional jobId/eventType/limit), playbook, clear (what=playbook|events|all; default playbook), distill (optional force). Job briefs include brief.learned_lessons when learning is enabled — craft guidance only, never invent business facts. Configure under Settings → Design learning.',
    schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'list', 'playbook', 'clear', 'distill'],
          description: 'Default status',
        },
        what: {
          type: 'string',
          enum: ['all', 'playbook', 'events'],
          description: 'clear: what to wipe (default playbook)',
        },
        jobId: { type: 'integer', minimum: 1, description: 'list: filter by design job' },
        eventType: {
          type: 'string',
          description: 'list: review|suggested_redesign|suggested_improvements|change_request|email_message|email_submit|deliver',
        },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        force: { type: 'boolean', description: 'distill: bypass throttle' },
      },
    },
  },
  {
    name: 'email.compose',
    description: 'Compose from a dual-channel template. Pass channel email|sms (default email). queue:true persists a campaign_message and returns messageId for email.send. SMS needs lead.phone + template.sms_body. Email personalizes {{website_link}}, {{interested}}, {{uninterested}}.',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        templateId: { type: 'integer', minimum: 1 },
        channel: { type: 'string', enum: ['email', 'sms'], description: 'Which template content to compose (default email)' },
        queue: { type: 'boolean', description: 'Persist as queued campaign_message' },
      },
      required: ['leadId', 'templateId'],
    },
  },
  {
    name: 'email.draft',
    description: 'AI-draft outreach JSON: subject + HTML body + companion sms_body (must include {{website_link}}). Optional leadId for context, prompt to steer, existingSubject/existingBody to revise. Returns draft fields only — save via outreach.templates. Respects automation pause.',
    schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', maxLength: 4000 },
        leadId: { type: 'integer', minimum: 1 },
        existingSubject: { type: 'string', maxLength: 500 },
        existingBody: { type: 'string', maxLength: 20000 },
      },
    },
  },
  {
    name: 'email.uploadAsset',
    description: 'Upload an image for HTML email templates (base64 via data, max 5MB). Returns a public URL safe for <img src>. Does not send mail.',
    schema: {
      type: 'object',
      properties: {
        data: { type: 'string', description: 'Base64 image (data: URI prefix OK)' },
        mimeType: { type: 'string' },
      },
    },
  },
  {
    name: 'sms.queue',
    description: 'Queue a freeform SMS for a lead (personalizes {{website_link}}; appends link if missing). Requires lead phone. Returns messageId for email.send. Respects automation pause.',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        body: { type: 'string', maxLength: 1600 },
      },
      required: ['leadId', 'body'],
    },
  },
  {
    name: 'email.send',
    description: 'Send a queued email or SMS message now. Respects suppression list (email), automation pause, and daily outreach cap.',
    schema: {
      type: 'object',
      properties: { messageId: { type: 'integer', minimum: 1 } },
      required: ['messageId'],
    },
  },
  {
    name: 'prospect.score',
    description: "Return a lead's score with its Qualified/Hot label from current thresholds.",
    schema: {
      type: 'object',
      properties: { leadId: { type: 'integer', minimum: 1 } },
      required: ['leadId'],
    },
  },
  {
    name: 'analytics.get',
    description: 'Dashboard stats: lead counts by status, websites, outreach today, AI spend, and design jobs waiting on the agent (designJobsWaitingOnAgent / designJobsQuestionsPending).',
    schema: { type: 'object', properties: {} },
  },
  {
    name: 'automation.pause',
    description: 'Engage the kill switch: stop scanning, generation, campaigns, follow-ups, and AI actions.',
    schema: { type: 'object', properties: {} },
  },
  {
    name: 'website.addModule',
    description: 'Attach a site module (blog|ecommerce|courses|gallery|directory|faq|testimonials|team|events|bookings) into the live site template with an in-page JS mount (not an iframe). Requires Standard/Premium siteModules. Creates a public embed token, injects a managed mount + module-embed.js (clones site nav/header/footer onto the module page when missing), and adds a managed top-nav link on every page that already has a top nav. Published items from blog.create / ecommerce.create / etc. render inside that page via /api/v1/modules/public. Bookings adds calendar slots (/slots) and public booking (POST /book). Re-synced on website.generate and design.deliver when already attached. After attach or content changes, call website.preview (force:true) so Cloudflare/public HTML picks up the mount.',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        module: { type: 'string', enum: ['blog', 'ecommerce', 'courses', 'gallery', 'directory', 'faq', 'testimonials', 'team', 'events', 'bookings'] },
        moduleType: { type: 'string', enum: ['blog', 'ecommerce', 'courses', 'gallery', 'directory', 'faq', 'testimonials', 'team', 'events', 'bookings'] },
        title: { type: 'string' },
        target_page_slug: { type: 'string', description: 'Page slug to embed on (default per module: blog/shop/courses/gallery/directory/faq/testimonials/team/events/book). That page is created from the site chrome if missing.' },
        pageSlug: { type: 'string' },
      },
      required: ['leadId'],
    },
  },
  {
    name: 'modules.list',
    description: 'List site module embeds (in-page JS mounts), public tokens, target pages, and item counts for a lead (Standard/Premium siteModules).',
    schema: {
      type: 'object',
      properties: { leadId: { type: 'integer', minimum: 1 } },
    },
  },
  {
    name: 'blog.list',
    description: 'List blog posts for a lead (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        includeDrafts: { type: 'boolean' },
      },
    },
  },
  {
    name: 'blog.create',
    description: 'Create a blog post: title, slug, body_html, cover_image, status draft|published (Standard/Premium). Only status=published posts appear in the public in-page blog mount after website.addModule. Drafts stay in the portal/MCP only.',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        title: { type: 'string' },
        slug: { type: 'string' },
        body_html: { type: 'string' },
        body: { type: 'string' },
        cover_image: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'published'] },
      },
      required: ['title'],
    },
  },
  {
    name: 'blog.update',
    description: 'Update a blog post by id (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        leadId: { type: 'integer', minimum: 1 },
        title: { type: 'string' },
        slug: { type: 'string' },
        body_html: { type: 'string' },
        cover_image: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'published'] },
      },
      required: ['id'],
    },
  },
  {
    name: 'blog.delete',
    description: 'Delete a blog post by id (Standard/Premium).',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 }, leadId: { type: 'integer', minimum: 1 } },
      required: ['id'],
    },
  },
  {
    name: 'ecommerce.list',
    description: 'List ecommerce products for a lead (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        includeDrafts: { type: 'boolean' },
      },
    },
  },
  {
    name: 'ecommerce.create',
    description: 'Create a product with name, price/price_cents, description, image_url, checkout_url (external Stripe/buy link), status (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        name: { type: 'string' },
        slug: { type: 'string' },
        description: { type: 'string' },
        price: { type: 'number' },
        price_cents: { type: 'integer' },
        currency: { type: 'string' },
        image_url: { type: 'string' },
        checkout_url: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'published'] },
      },
      required: ['name'],
    },
  },
  {
    name: 'ecommerce.update',
    description: 'Update a product by id (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        leadId: { type: 'integer', minimum: 1 },
        name: { type: 'string' },
        slug: { type: 'string' },
        description: { type: 'string' },
        price: { type: 'number' },
        price_cents: { type: 'integer' },
        currency: { type: 'string' },
        image_url: { type: 'string' },
        checkout_url: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'published'] },
      },
      required: ['id'],
    },
  },
  {
    name: 'ecommerce.delete',
    description: 'Delete a product by id (Standard/Premium).',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 }, leadId: { type: 'integer', minimum: 1 } },
      required: ['id'],
    },
  },
  {
    name: 'courses.list',
    description: 'List courses with lessons for a lead (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        includeDrafts: { type: 'boolean' },
      },
    },
  },
  {
    name: 'courses.create',
    description: 'Create a course with title, description, enrollment_url, optional lessons[] (Standard/Premium). Text/link lessons — no video hosting.',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        title: { type: 'string' },
        slug: { type: 'string' },
        description: { type: 'string' },
        enrollment_url: { type: 'string' },
        cover_image: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'published'] },
        lessons: { type: 'array', items: { type: 'object' } },
      },
      required: ['title'],
    },
  },
  {
    name: 'courses.update',
    description: 'Update a course by id (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        leadId: { type: 'integer', minimum: 1 },
        title: { type: 'string' },
        slug: { type: 'string' },
        description: { type: 'string' },
        enrollment_url: { type: 'string' },
        cover_image: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'published'] },
      },
      required: ['id'],
    },
  },
  {
    name: 'courses.delete',
    description: 'Delete a course and its lessons (Standard/Premium).',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 }, leadId: { type: 'integer', minimum: 1 } },
      required: ['id'],
    },
  },
  {
    name: 'courses.addLesson',
    description: 'Add a lesson to a course: title, body_html, lesson_url (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        courseId: { type: 'integer', minimum: 1 },
        leadId: { type: 'integer', minimum: 1 },
        title: { type: 'string' },
        body_html: { type: 'string' },
        lesson_url: { type: 'string' },
        sort_order: { type: 'integer' },
      },
      required: ['courseId', 'title'],
    },
  },
  {
    name: 'gallery.list',
    description: 'List gallery albums with images (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        includeDrafts: { type: 'boolean' },
      },
    },
  },
  {
    name: 'gallery.create',
    description: 'Create a gallery album with optional images[{image_url,caption}] (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        title: { type: 'string' },
        slug: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'published'] },
        images: { type: 'array', items: { type: 'object' } },
      },
      required: ['title'],
    },
  },
  {
    name: 'gallery.update',
    description: 'Update a gallery album by id (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        leadId: { type: 'integer', minimum: 1 },
        title: { type: 'string' },
        slug: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'published'] },
      },
      required: ['id'],
    },
  },
  {
    name: 'gallery.delete',
    description: 'Delete a gallery album and its images (Standard/Premium).',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 }, leadId: { type: 'integer', minimum: 1 } },
      required: ['id'],
    },
  },
  {
    name: 'gallery.addImage',
    description: 'Add an image_url to a gallery album (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        albumId: { type: 'integer', minimum: 1 },
        leadId: { type: 'integer', minimum: 1 },
        image_url: { type: 'string' },
        caption: { type: 'string' },
        sort_order: { type: 'integer' },
      },
      required: ['albumId', 'image_url'],
    },
  },
  {
    name: 'directory.list',
    description: 'List directory listings (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        category: { type: 'string' },
        includeDrafts: { type: 'boolean' },
      },
    },
  },
  {
    name: 'directory.create',
    description: 'Create a directory listing: name, category, contact, description, image/link (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        name: { type: 'string' },
        category: { type: 'string' },
        description: { type: 'string' },
        contact_email: { type: 'string' },
        contact_phone: { type: 'string' },
        website_url: { type: 'string' },
        image_url: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'published'] },
      },
      required: ['name'],
    },
  },
  {
    name: 'directory.update',
    description: 'Update a directory listing by id (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        leadId: { type: 'integer', minimum: 1 },
        name: { type: 'string' },
        category: { type: 'string' },
        description: { type: 'string' },
        contact_email: { type: 'string' },
        contact_phone: { type: 'string' },
        website_url: { type: 'string' },
        image_url: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'published'] },
      },
      required: ['id'],
    },
  },
  {
    name: 'directory.delete',
    description: 'Delete a directory listing by id (Standard/Premium).',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 }, leadId: { type: 'integer', minimum: 1 } },
      required: ['id'],
    },
  },
  {
    name: 'faq.list',
    description: 'List FAQ items (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        category: { type: 'string' },
        includeDrafts: { type: 'boolean' },
      },
    },
  },
  {
    name: 'faq.create',
    description: 'Create an FAQ item: question, answer_html, category, status (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        question: { type: 'string' },
        answer_html: { type: 'string' },
        category: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'published'] },
      },
      required: ['question'],
    },
  },
  {
    name: 'faq.update',
    description: 'Update an FAQ item by id (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        leadId: { type: 'integer', minimum: 1 },
        question: { type: 'string' },
        answer_html: { type: 'string' },
        category: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'published'] },
      },
      required: ['id'],
    },
  },
  {
    name: 'faq.delete',
    description: 'Delete an FAQ item by id (Standard/Premium).',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 }, leadId: { type: 'integer', minimum: 1 } },
      required: ['id'],
    },
  },
  {
    name: 'testimonials.list',
    description: 'List testimonials (Standard/Premium).',
    schema: {
      type: 'object',
      properties: { leadId: { type: 'integer', minimum: 1 }, includeDrafts: { type: 'boolean' } },
    },
  },
  {
    name: 'testimonials.create',
    description: 'Create a testimonial: quote, author, rating 1-5 (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        quote: { type: 'string' },
        author_name: { type: 'string' },
        author_title: { type: 'string' },
        author_company: { type: 'string' },
        rating: { type: 'number' },
        image_url: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'published'] },
      },
      required: ['quote'],
    },
  },
  {
    name: 'testimonials.update',
    description: 'Update a testimonial by id (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        leadId: { type: 'integer', minimum: 1 },
        quote: { type: 'string' },
        author_name: { type: 'string' },
        author_title: { type: 'string' },
        author_company: { type: 'string' },
        rating: { type: 'number' },
        image_url: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'published'] },
      },
      required: ['id'],
    },
  },
  {
    name: 'testimonials.delete',
    description: 'Delete a testimonial by id (Standard/Premium).',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 }, leadId: { type: 'integer', minimum: 1 } },
      required: ['id'],
    },
  },
  {
    name: 'team.list',
    description: 'List team members (Standard/Premium).',
    schema: {
      type: 'object',
      properties: { leadId: { type: 'integer', minimum: 1 }, includeDrafts: { type: 'boolean' } },
    },
  },
  {
    name: 'team.create',
    description: 'Create a team member: name, role_title, bio, image (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        name: { type: 'string' },
        slug: { type: 'string' },
        role_title: { type: 'string' },
        bio: { type: 'string' },
        image_url: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        social_url: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'published'] },
      },
      required: ['name'],
    },
  },
  {
    name: 'team.update',
    description: 'Update a team member by id (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        leadId: { type: 'integer', minimum: 1 },
        name: { type: 'string' },
        slug: { type: 'string' },
        role_title: { type: 'string' },
        bio: { type: 'string' },
        image_url: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        social_url: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'published'] },
      },
      required: ['id'],
    },
  },
  {
    name: 'team.delete',
    description: 'Delete a team member by id (Standard/Premium).',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 }, leadId: { type: 'integer', minimum: 1 } },
      required: ['id'],
    },
  },
  {
    name: 'events.list',
    description: 'List events (Standard/Premium).',
    schema: {
      type: 'object',
      properties: { leadId: { type: 'integer', minimum: 1 }, includeDrafts: { type: 'boolean' } },
    },
  },
  {
    name: 'events.create',
    description: 'Create an event: title, starts_at, location, ticket_url (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        title: { type: 'string' },
        slug: { type: 'string' },
        description: { type: 'string' },
        starts_at: { type: 'string' },
        ends_at: { type: 'string' },
        location: { type: 'string' },
        image_url: { type: 'string' },
        ticket_url: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'published'] },
      },
      required: ['title'],
    },
  },
  {
    name: 'events.update',
    description: 'Update an event by id (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        leadId: { type: 'integer', minimum: 1 },
        title: { type: 'string' },
        slug: { type: 'string' },
        description: { type: 'string' },
        starts_at: { type: 'string' },
        ends_at: { type: 'string' },
        location: { type: 'string' },
        image_url: { type: 'string' },
        ticket_url: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'published'] },
      },
      required: ['id'],
    },
  },
  {
    name: 'events.delete',
    description: 'Delete an event by id (Standard/Premium).',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 }, leadId: { type: 'integer', minimum: 1 } },
      required: ['id'],
    },
  },
  {
    name: 'bookings.services',
    description: 'List bookable services with duration/price (Standard/Premium). True calendar booking — not the appointment request form.',
    schema: {
      type: 'object',
      properties: { leadId: { type: 'integer', minimum: 1 }, includeDrafts: { type: 'boolean' } },
    },
  },
  {
    name: 'bookings.createService',
    description: 'Create a bookable service (name, duration_minutes, buffer, price, status). Standard/Premium.',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        name: { type: 'string' },
        slug: { type: 'string' },
        description: { type: 'string' },
        duration_minutes: { type: 'integer' },
        buffer_minutes: { type: 'integer' },
        price: { type: 'number' },
        price_cents: { type: 'integer' },
        currency: { type: 'string' },
        image_url: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'published'] },
      },
      required: ['name'],
    },
  },
  {
    name: 'bookings.updateService',
    description: 'Update a bookable service by id (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        leadId: { type: 'integer', minimum: 1 },
        name: { type: 'string' },
        slug: { type: 'string' },
        description: { type: 'string' },
        duration_minutes: { type: 'integer' },
        buffer_minutes: { type: 'integer' },
        price: { type: 'number' },
        price_cents: { type: 'integer' },
        currency: { type: 'string' },
        image_url: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'published'] },
      },
      required: ['id'],
    },
  },
  {
    name: 'bookings.deleteService',
    description: 'Delete a bookable service by id (Standard/Premium).',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 }, leadId: { type: 'integer', minimum: 1 } },
      required: ['id'],
    },
  },
  {
    name: 'bookings.getHours',
    description: 'List weekly availability hours + booking settings (Standard/Premium).',
    schema: {
      type: 'object',
      properties: { leadId: { type: 'integer', minimum: 1 } },
    },
  },
  {
    name: 'bookings.setHours',
    description: 'Replace weekly hours: [{weekday:0-6, start_time, end_time}] (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        hours: { type: 'array', items: { type: 'object' } },
      },
      required: ['hours'],
    },
  },
  {
    name: 'bookings.setSettings',
    description: 'Update booking settings: timezone, slot interval, min notice, max days ahead, auto_confirm (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        timezone: { type: 'string' },
        slot_interval_minutes: { type: 'integer' },
        min_notice_hours: { type: 'integer' },
        max_days_ahead: { type: 'integer' },
        auto_confirm: { type: 'boolean' },
      },
    },
  },
  {
    name: 'bookings.list',
    description: 'List appointments with status filter (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        status: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        limit: { type: 'integer' },
      },
    },
  },
  {
    name: 'bookings.updateStatus',
    description: 'Update appointment status: pending|confirmed|cancelled|completed (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        leadId: { type: 'integer', minimum: 1 },
        status: { type: 'string', enum: ['pending', 'confirmed', 'cancelled', 'completed'] },
      },
      required: ['id', 'status'],
    },
  },
  {
    name: 'bookings.slots',
    description: 'Compute available time slots for a date + service (calendar engine). Standard/Premium.',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        serviceId: { type: 'integer', minimum: 1 },
        service_id: { type: 'integer', minimum: 1 },
      },
      required: ['date'],
    },
  },
];

// App-parity tools (leads admin, websites, outreach, settings, …). Skip names
// already listed above (e.g. design.emailDelivery keeps the richer description).
const { getParityCatalogEntries } = require('./mcpParityTools');
const known = new Set(tools.map((t) => t.name));
for (const entry of getParityCatalogEntries()) {
  if (!known.has(entry.name)) tools.push(entry);
}

/** Lead-scoped client portal MCP (Standard/Premium). Listed via tools/list on client tokens only — not merged into staff tools above. */
const { portalToolDefs } = require('../server/clientMcp');
const clientPortalTools = portalToolDefs();

module.exports = {
  server,
  protocolVersion,
  protocolVersions,
  tools,
  clientPortalTools,
};
