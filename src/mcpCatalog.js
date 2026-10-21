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
    description: 'Open a website design job for the agent (type=website). Does not build a local template site — the agent designs freely and delivers via design.deliver. Pass site_shape: "landing" (one focused scrollable page; collapse recommended_pages into sections) or "multipage" (full IA from site_map.recommended_pages). When omitted, inferred from recommended_pages count (many → multipage, else landing). Queuing sets waiting_on_agent and fires the optional agent notify/trigger. FORMS: never hand-roll <form> HTML — use contact_form, forms.create + form/bitpype_form section, or website.addBlock (form). MODULES+FORMS STYLING: bare mounts must match the site — wrap in a themed card/section; style via theme.customCss under .bitpype-module-embed, .bitpype-form-embed, and section[data-ws-section-type="site_module|bitpype_form|contact_form"]. For logo/social/flyer/brand/other, use design.create.',
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
        instructions: { type: 'string', maxLength: 20000 },
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
    description: 'Edit a website. CUSTOM FREEDOM: theme.partials.{headerHtml,footerHtml} = shared chrome (every page; set page.chromeOverride:true to opt out); page.description / page.ogImage / page.canonical / page.customJs; theme.customCss + theme.customJs + theme.favicon. For client-driven structural asks: INSPECT FIRST (nav/modules/forms), classify SAFE|BETTER_PATH|PUSH_BACK, dedupe — never add a second Book Now or hand-rolled form when native/module exists. INTENT: appointment-intent pages (book/reserve/schedule) → bookings module, not contact_form; attaching a form there returns a warning pointing at bookings. Pass pages (+ optional theme, note) for a full validated save, or instruction for a safe structural edit. FORMS: raw <form> stripped — use contact_form / forms.create / website.addBlock (form). Module-in-cell via website.addBlock({cellIndex}). STYLING: .bitpype-module-embed / .bitpype-form-embed via theme.customCss.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        pages: { type: 'array', description: 'Full pages[]; each page may include description, ogImage, canonical, customJs, chromeOverride' },
        theme: { type: 'object', description: 'Theme incl. customCss, customJs, favicon, partials.{headerHtml,footerHtml}' },
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
    description: 'Read one design job: instructions, site_shape, request_kind, brief (learned_lessons, change_request_review {classification SAFE|BETTER_PATH|PUSH_BACK, plan, clientMessage, log}, change_verification), Q&A, review, delivery, pending_email_redesigns. CHANGE REQUESTS: INSPECT live site first (pages/nav/modules/forms), follow brief.change_request_review, dedupe nav/forms, never silently comply with harmful or silently refuse. Only verified_facts may be VERIFIED. Screenshots are paths only.',
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
    description: 'Submit finished design. After store runs whole-site verification (website.qa + nav/form) into brief.change_verification and data.change_summary — required after change requests. FORMS: never hand-roll <form>; use contact_form/forms.create/bitpype_form. Dedupe: one Book CTA when bookings attached; one form per page. Optional site_shape. VERIFIED claims only from verified facts.',
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
    description: 'Set website theme colors (#RRGGBB), fonts (fonts.list), customCss, customJs (site-wide body-end), customHead (before </head>), favicon (assets/… path), and/or shared partials {headerHtml,footerHtml}. Rewrites matching hexes in theme.customCss. Pass id or leadId.',
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
        font: { type: 'string', description: 'Body font name from fonts.list (e.g. Figtree)' },
        headingFont: { type: 'string', description: 'Heading font name from fonts.list (e.g. Fraunces)' },
        customCss: { type: 'string' },
        customJs: { type: 'string', description: 'Site-wide JS injected before </body> (sanitized)' },
        customHead: { type: 'string', description: 'Site-wide HTML injected before </head> (sanitized)' },
        favicon: { type: 'string', description: 'assets/favicon.ico or similar from website.uploadAsset' },
        partials: {
          type: 'object',
          description: 'Shared chrome: { headerHtml, footerHtml } — every page unless chromeOverride',
          properties: {
            headerHtml: { type: 'string' },
            footerHtml: { type: 'string' },
          },
        },
        baseCss: { type: 'boolean' },
        note: { type: 'string', maxLength: 500 },
      },
    },
  },
  {
    name: 'fonts.list',
    description: 'List curated Google Fonts for theme.font / theme.headingFont (same catalog as the portal Theme bar). Free — local list only; no Google API key or billed calls. Optional group: Sans|Serif|Display|Mono. Then pass a name to website.setTheme or design.deliver theme.',
    schema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Optional filter: Sans, Serif, Display, or Mono' },
      },
    },
  },
  {
    name: 'website.replaceImage',
    description: 'Replace a site image by replaceSrc (images/hero.jpg or assets/photo.jpg): pass data (base64) or prompt (AI). Optional crop:{aspect,focalX,focalY,width?,height?} — server-crops so width/height match the CROP box; placement also stores crop meta for aspect-ratio CSS. Pass id or leadId. Does not fetch remote URLs. assets/ filenames stay stable (never renamed). For fonts/video/SVG use website.uploadAsset → assets/.',
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
        crop: {
          type: 'object',
          properties: {
            aspect: { type: 'string', description: '"16:9" | "1:1" | "4:3" | number' },
            focalX: { type: 'number', minimum: 0, maximum: 1 },
            focalY: { type: 'number', minimum: 0, maximum: 1 },
            width: { type: 'integer', minimum: 1 },
            height: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
  },
  {
    name: 'website.uploadAsset',
    description: 'Upload a stable site asset to assets/<filename> (images, fonts/woff2, video mp4|webm, SVG, ico). Filename is preserved — never renamed by optimize/replace. Included in CF Pages publish under /assets/* (same origin). Pass data (base64), mimeType, filename. Optional setFavicon:true sets theme.favicon (injected into exported HTML <head>). Reference as assets/YourFont.woff2 in theme.customCss @font-face or page HTML.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        websiteId: { type: 'integer', minimum: 1 },
        leadId: { type: 'integer', minimum: 1 },
        data: { type: 'string', description: 'Base64 (optionally data:…;base64,)' },
        mimeType: { type: 'string' },
        mime: { type: 'string' },
        filename: { type: 'string', maxLength: 200 },
        name: { type: 'string', maxLength: 200 },
        setFavicon: { type: 'boolean' },
      },
      required: ['data', 'filename'],
    },
  },
  {
    name: 'website.screenshot',
    description: 'Capture a PNG of a site page at a viewport width (use 390 and/or 1440). Pass id, path (index.html / about.html), width. Uses live preview when available; otherwise local render. For batch home+services captures see site.screenshots.capture.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        websiteId: { type: 'integer', minimum: 1 },
        path: { type: 'string', maxLength: 200, description: 'Page file e.g. index.html or about.html' },
        width: { type: 'integer', minimum: 320, maximum: 2560 },
        height: { type: 'integer', minimum: 480, maximum: 4096 },
        previewUrl: { type: 'string' },
      },
      required: ['width'],
    },
  },
  {
    name: 'website.optimizeImages',
    description: 'Optimize all raster images for a customer site (resize long edge ≤2400px, compress JPEG/PNG/WebP, convert opaque photos to WebP when smaller). Keeps logo.png as PNG. Rewrites pages/theme and export HTML when filenames change. Pass id, websiteId, or leadId. Optional force recompresses even small files. Auto-runs (same-format) on generate/preview/export; use this for a full WebP pass on existing sites.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1, description: 'Website id' },
        websiteId: { type: 'integer', minimum: 1, description: 'Alias of id' },
        leadId: { type: 'integer', minimum: 1, description: 'Resolve latest website for lead when id omitted' },
        force: { type: 'boolean', description: 'Recompress even when already small / recently optimized' },
        preferWebp: { type: 'boolean', description: 'Convert opaque photos to WebP when smaller (default true)' },
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
    name: 'website.addSection',
    description: 'Add a page section (Page → Section → Block). Nesting: sections live on a page; blocks (heading/text/image/HTML/columns/widgets) go inside a section or layout cell. Pass sectionType "section" (or omit type) for an empty ws-page-section container, or a content/layout type (heading, text, image, html, columns, text_image, cards, hero, …) to insert that block as a section. cols=1..12 for columns/cards. afterIndex=-1 inserts near the top (after nav). Prefer website.addBlock to place a block into an existing section or column cell.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        websiteId: { type: 'integer', minimum: 1 },
        pageIndex: { type: 'integer', minimum: 0 },
        afterIndex: { type: 'integer', minimum: -1 },
        sectionType: { type: 'string', description: 'section|heading|text|image|html|columns|text_image|cards|hero|…' },
        type: { type: 'string' },
        cols: { type: 'integer', minimum: 1, maximum: 12, description: 'Column count for columns/cards (1–12)' },
        html: { type: 'string', description: 'Optional raw HTML when type is html' },
      },
      required: ['pageIndex', 'afterIndex'],
    },
  },
  {
    name: 'website.addBlock',
    description: 'Add a block into an existing section or columns cell. Types: heading, text, image, html, columns (1–12), text_image, cards, module, form. Optional cellIndex places a native module/form widget into that cell. For module: moduleType. For form: formId or formToken. INTENT: placing form/contact_form on an appointment-intent page (book/reserve/schedule) returns a warning — use bookings module instead. Style via theme.customCss on .bitpype-module-embed / .bitpype-form-embed / .col-widget.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        websiteId: { type: 'integer', minimum: 1 },
        pageIndex: { type: 'integer', minimum: 0 },
        sectionIndex: { type: 'integer', minimum: 0 },
        blockType: { type: 'string', description: 'heading|text|image|html|columns|text_image|cards|module|form|…' },
        type: { type: 'string' },
        cols: { type: 'integer', minimum: 1, maximum: 12 },
        cellIndex: { type: 'integer', minimum: 0, description: 'Columns cell index for native module/form/html-in-cell' },
        moduleType: { type: 'string' },
        formId: { type: 'integer', minimum: 1 },
        formToken: { type: 'string' },
        html: { type: 'string' },
        content: { type: 'object' },
      },
      required: ['pageIndex', 'sectionIndex'],
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
    description: 'Queue a FULL redesign. Runs instruction-review first (inspect site snapshot, classify SAFE|BETTER_PATH|PUSH_BACK, plan + clientMessage on brief.change_request_review), writes === REDESIGN REQUEST === + CHANGE REQUEST REVIEW, sets waiting_on_agent. Agent inspects live site, dedupes nav/forms/modules, then design.deliver; verification on change_summary. For polish use design.improve.',
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
    description: 'Queue INCREMENTAL improvements. Runs instruction-review first (inspect, classify SAFE|BETTER_PATH|PUSH_BACK, brief.change_request_review), writes === IMPROVEMENTS REQUEST === + CHANGE REQUEST REVIEW. Dedupe nav/forms; reuse module CTAs; never hand-roll forms when native exists. design.deliver attaches whole-site verification to change_summary.',
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
    description: 'Inbound client email change requests. Actions: list|get|ingest|submit|dismiss|scan. Submit runs instruction-review (site snapshot → SAFE|BETTER_PATH|PUSH_BACK), persists review_json + brief.change_request_review, queues design.redesign/improve. Returns change_request_review.',
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
    description: 'Attach a site module (blog|ecommerce|courses|gallery|directory|faq|testimonials|team|events|bookings). INTENT: appointments with availability → bookings module (never a contact form); then bookings.createService (published) + bookings.setHours. Structured requests (quote/callback/RSVP/waitlist) → forms.create with purpose=…; general inquiries → contact form. AUTHOR MODE (default): if purpose already served, injects NOTHING and returns wouldInject + skippedInject. forceInject:true overrides. dryRun / authorMode:"preview" preview without mutate. Prefer website.addBlock({cellIndex}) for custom layouts. Attaching a non-bookings module (or form) on an appointment-intent page returns a warning. After changes: website.preview(force:true).',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        module: { type: 'string', enum: ['blog', 'ecommerce', 'courses', 'gallery', 'directory', 'faq', 'testimonials', 'team', 'events', 'bookings'] },
        moduleType: { type: 'string', enum: ['blog', 'ecommerce', 'courses', 'gallery', 'directory', 'faq', 'testimonials', 'team', 'events', 'bookings'] },
        title: { type: 'string' },
        target_page_slug: { type: 'string', description: 'Page slug to embed on (default per module).' },
        pageSlug: { type: 'string' },
        show_request_form: { type: 'boolean', description: 'Bookings only. Default true.' },
        settings: {
          type: 'object',
          description: 'Embed settings. Blog: post_limit (int, null=all), show_excerpt (bool, default true). Bookings: show_request_form.',
          properties: {
            post_limit: { type: 'integer', minimum: 1, description: 'Blog: max published posts to render (newest first); omit for all' },
            show_excerpt: { type: 'boolean', description: 'Blog: show excerpt under card title (default true)' },
            show_request_form: { type: 'boolean' },
          },
        },
        dryRun: { type: 'boolean', description: 'Return wouldInject without mutating pages' },
        authorMode: { type: 'boolean', description: 'Default true — skip inject when purpose already served' },
        forceInject: { type: 'boolean', description: 'Override author-mode skip' },
      },
      required: ['leadId'],
    },
  },
  {
    name: 'modules.list',
    description: 'List site module embeds (in-page JS mounts), public tokens, target pages, and item counts for a lead (Standard/Premium siteModules). Style mounts with theme.customCss on .bitpype-module-embed / section[data-ws-section-type="site_module"] — wrap in a themed card/section.',
    schema: {
      type: 'object',
      properties: { leadId: { type: 'integer', minimum: 1 } },
    },
  },
  {
    name: 'forms.list',
    description: 'List custom BitPype forms for a lead (or websiteId). Returns form records + managed embed snippets (bitpype-form-embed + form-embed.js). Prefer contact_form / forms.create over raw HTML <form>.',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        websiteId: { type: 'integer', minimum: 1 },
        siteId: { type: 'integer', minimum: 1 },
      },
    },
  },
  {
    name: 'forms.get',
    description: 'Get one custom form by formId (or first form for lead) plus managed embed snippet.',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        formId: { type: 'integer', minimum: 1 },
        id: { type: 'integer', minimum: 1 },
        websiteId: { type: 'integer', minimum: 1 },
      },
      required: ['leadId'],
    },
  },
  {
    name: 'forms.create',
    description: 'Create + publish a custom form. Required leadId + (name OR purpose). Row starts draft in DB; tool publishes immediately. Embeds only on target_page_slug — missing page → website.get formsUnembedded (no homepage fallback). INTENT: live calendar → bookings module; structured requests → purpose + typed fields; optional fields[] override. Never hand-roll <form>.',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        name: { type: 'string' },
        title: { type: 'string' },
        purpose: {
          type: 'string',
          enum: ['appointment_request', 'quote_request', 'callback_request', 'event_rsvp', 'general_inquiry'],
          description: 'When set, generates typed fields from purpose + lead data unless fields[] provided.',
        },
        fields: { type: 'array', items: { type: 'object' } },
        submit_label: { type: 'string' },
        submitLabel: { type: 'string' },
        success_message: { type: 'string' },
        successMessage: { type: 'string' },
        notify_email: { type: 'string' },
        notifyEmail: { type: 'string' },
        target_page_slug: { type: 'string' },
        targetPageSlug: { type: 'string' },
        intro: { type: 'string' },
        embed_enabled: { type: 'boolean' },
        embed_on_page: { type: 'boolean' },
        add_to_nav: { type: 'boolean', description: 'Show target page in top menu. Default false.' },
        nav_visible: { type: 'boolean', description: 'Alias of add_to_nav. Default false.' },
      },
      required: ['leadId'],
    },
  },
  {
    name: 'forms.suggestFields',
    description: 'Preview purpose-built typed fields for a lead without creating a form. purpose: appointment_request|quote_request|callback_request|event_rsvp|general_inquiry. Uses lead booking services, team, hours, and events for select options. Then call forms.create with the same purpose (or pass fields).',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        purpose: {
          type: 'string',
          enum: ['appointment_request', 'quote_request', 'callback_request', 'event_rsvp', 'general_inquiry'],
        },
      },
      required: ['leadId', 'purpose'],
    },
  },
  {
    name: 'forms.update',
    description: 'Update a custom form (name, fields, submit_label, success_message, notify_email, embed_enabled/embed_on_page, add_to_nav/nav_visible). embed_enabled:false removes the on-page panel and form-embed.js for that form after export/publish.',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        formId: { type: 'integer', minimum: 1 },
        id: { type: 'integer', minimum: 1 },
        name: { type: 'string' },
        title: { type: 'string' },
        fields: { type: 'array', items: { type: 'object' } },
        submit_label: { type: 'string' },
        success_message: { type: 'string' },
        notify_email: { type: 'string' },
        embed_enabled: { type: 'boolean' },
        embed_on_page: { type: 'boolean' },
        add_to_nav: { type: 'boolean' },
        nav_visible: { type: 'boolean' },
        target_page_slug: { type: 'string' },
      },
      required: ['leadId', 'formId'],
    },
  },
  {
    name: 'forms.delete',
    description: 'Delete a custom form (keeps at least one form per lead).',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        formId: { type: 'integer', minimum: 1 },
        id: { type: 'integer', minimum: 1 },
      },
      required: ['leadId', 'formId'],
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
    description: 'Create a blog post: title, slug, body_html, excerpt (optional), cover_image, status draft|published (Standard/Premium). When excerpt is empty it is derived from the first ~30 words of body_html. Only status=published posts appear in the public in-page blog mount after website.addModule. Use website.addModule settings.post_limit / settings.show_excerpt for home-page previews.',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        title: { type: 'string' },
        slug: { type: 'string' },
        body_html: { type: 'string' },
        body: { type: 'string' },
        excerpt: { type: 'string', description: 'Card blurb; auto-derived from body when omitted' },
        cover_image: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'published'] },
      },
      required: ['title'],
    },
  },
  {
    name: 'blog.update',
    description: 'Update a blog post by id (Standard/Premium). Pass excerpt to set the card blurb; body edits re-derive excerpt when excerpt is omitted.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        leadId: { type: 'integer', minimum: 1 },
        title: { type: 'string' },
        slug: { type: 'string' },
        body_html: { type: 'string' },
        excerpt: { type: 'string' },
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
      required: ['leadId'],
    },
  },
  {
    name: 'bookings.createService',
    description: 'Create a bookable service. Default status draft — publish before bookings.slots. E2E: createService → updateService status published → setHours → slots. module-fit unchanged.',
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
      required: ['leadId', 'name'],
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
      required: ['id', 'leadId'],
    },
  },
  {
    name: 'bookings.deleteService',
    description: 'Delete a bookable service by id (Standard/Premium).',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 }, leadId: { type: 'integer', minimum: 1 } },
      required: ['id', 'leadId'],
    },
  },
  {
    name: 'bookings.getHours',
    description: 'List weekly availability hours + booking settings (Standard/Premium).',
    schema: {
      type: 'object',
      properties: { leadId: { type: 'integer', minimum: 1 } },
      required: ['leadId'],
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
      required: ['leadId', 'hours'],
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
      required: ['leadId'],
    },
  },
  {
    name: 'bookings.list',
    description: 'List appointments with status filter. Default excludes archived; pass includeArchived or archivedOnly (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        status: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        limit: { type: 'integer' },
        includeArchived: { type: 'boolean' },
        archivedOnly: { type: 'boolean' },
      },
      required: ['leadId'],
    },
  },
  {
    name: 'bookings.updateStatus',
    description: 'Update appointment status (pending|confirmed|cancelled|completed) and/or archive (archived true/false; completed/cancelled only) (Standard/Premium).',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        leadId: { type: 'integer', minimum: 1 },
        status: { type: 'string', enum: ['pending', 'confirmed', 'cancelled', 'completed'] },
        archived: { type: 'boolean' },
      },
      required: ['id', 'leadId'],
    },
  },
  {
    name: 'bookings.slots',
    description: 'Compute available time slots for date (YYYY-MM-DD) + published serviceId. Requires leadId and date.',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'integer', minimum: 1 },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        serviceId: { type: 'integer', minimum: 1 },
        service_id: { type: 'integer', minimum: 1 },
      },
      required: ['leadId', 'date'],
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
