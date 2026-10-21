'use strict';

/**
 * Extra MCP tools for desktop-app parity (leads admin, design job admin,
 * websites, outreach, settings, discovery, cloudflare).
 *
 * Wired from mcp.js â€” keep schemas mirrored in mcpCatalog.js.
 */

function createParityTools(ctx) {
  const {
    db,
    vStr,
    vInt,
    requireId,
    isErr,
    argError,
    ensureNotPaused,
    leadSummary,
    mcpSafeJob,
    logActivity,
    getSetting,
    setSetting,
    runLeadEngine,
    workspaceId: ctxWorkspaceId,
  } = ctx;
  const workspaceId = Number(ctxWorkspaceId) > 0 ? Number(ctxWorkspaceId) : 1;

  function optStr(v, max) {
    if (v == null || v === '') return undefined;
    const s = vStr(v, { max, def: '' });
    if (isErr(s)) throw argError(`string too long (max ${max}).`);
    return String(s);
  }

  return {
    // ----- Leads (beyond search/get/qualify/create/update/delete/addFact) -----
    'lead.score': {
      description: 'Score a lead with the deterministic scorer (same as the Leads page Score action).',
      schema: {
        type: 'object',
        properties: { id: { type: 'integer', minimum: 1 } },
        required: ['id'],
      },
      run(args) {
        const id = requireId(args.id, 'id');
        const engine = require('./leadEngine');
        const result = runLeadEngine(() => engine.scoreLead(db, id));
        return { ok: true, data: result };
      },
    },

    'lead.research': {
      description: 'Run research on a lead (facts / site snapshot when providers allow). Respects automation pause.',
      schema: {
        type: 'object',
        properties: { id: { type: 'integer', minimum: 1 } },
        required: ['id'],
      },
      async run(args) {
        ensureNotPaused();
        const id = requireId(args.id, 'id');
        const engine = require('./leadEngine');
        const result = await runLeadEngine(() => engine.researchLead(db, id));
        return { ok: true, data: result };
      },
    },

    'lead.discover': {
      description: 'Discover new leads via configured providers (Tavily etc.). Same as Discover in the app. Respects automation pause.',
      schema: {
        type: 'object',
        properties: {
          category: { type: 'string', maxLength: 120 },
          location: { type: 'string', maxLength: 200 },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          provider: { type: 'string', maxLength: 40 },
          group: { type: 'string', maxLength: 120 },
        },
      },
      async run(args = {}) {
        ensureNotPaused();
        const engine = require('./leadEngine');
        let limit;
        if (args.limit != null && args.limit !== '') {
          limit = vInt(args.limit, { min: 1, max: 50 });
          if (isErr(limit) || limit == null) throw argError('limit must be 1â€“50.');
        }
        const result = await runLeadEngine(() => engine.discoverLeads(db, {
          category: optStr(args.category, 120),
          location: optStr(args.location, 200),
          limit,
          provider: optStr(args.provider, 40),
          group: optStr(args.group, 120),
        }));
        return { ok: true, data: result };
      },
    },

    'lead.importCsv': {
      description: 'Import leads from CSV text (same parser as the Leads page). Accepts GapScout exports (project, business, profile_url, location, score, opportunity, …). Max 1 MB.',
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string', maxLength: 1048576 },
          group: { type: 'string', maxLength: 120 },
          lead_group: { type: 'string', maxLength: 120 },
        },
        required: ['text'],
      },
      run(args) {
        const text = vStr(args.text, { max: 1048576, def: '' });
        if (isErr(text) || !String(text).trim()) throw argError('text is required.');
        const engine = require('./leadEngine');
        const result = runLeadEngine(() => engine.importCsv(db, String(text), {
          group: args.group != null ? args.group : args.lead_group,
        }));
        return { ok: true, data: result };
      },
    },

    'lead.merge': {
      description: 'Merge duplicate leads into keepId; dropIds are deleted after copying useful fields.',
      schema: {
        type: 'object',
        properties: {
          keepId: { type: 'integer', minimum: 1 },
          dropIds: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: 50 },
        },
        required: ['keepId', 'dropIds'],
      },
      run(args) {
        const keepId = requireId(args.keepId, 'keepId');
        if (!Array.isArray(args.dropIds) || !args.dropIds.length) throw argError('dropIds is required.');
        const dropIds = args.dropIds.map((d) => requireId(d, 'dropId'));
        const engine = require('./leadEngine');
        const lead = runLeadEngine(() => engine.mergeLeads(db, keepId, dropIds));
        return { ok: true, data: { lead: leadSummary(lead) } };
      },
    },

    'lead.duplicates': {
      description: 'Find likely duplicate leads for one lead (phone/email/name/domain heuristics).',
      schema: {
        type: 'object',
        properties: { id: { type: 'integer', minimum: 1 } },
        required: ['id'],
      },
      run(args) {
        const id = requireId(args.id, 'id');
        const engine = require('./leadEngine');
        const lead = engine.getLead(db, id);
        if (!lead) throw argError(`Lead ${id} not found.`);
        const dups = runLeadEngine(() => engine.findDuplicates(db, lead));
        return { ok: true, data: { id, duplicates: (dups || []).map(leadSummary) } };
      },
    },

    'lead.facets': {
      description: 'Facet counts for the Leads filters (status, category, group, city).',
      schema: { type: 'object', properties: {} },
      run() {
        const engine = require('./leadEngine');
        return { ok: true, data: engine.listLeadFacets(db) };
      },
    },

    'lead.bulk': {
      description: 'Bulk lead actions: tag, untag, status, delete, research, set_group, set_category. Max 200 ids.',
      schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['tag', 'untag', 'status', 'delete', 'research', 'set_group', 'set_category'],
          },
          ids: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: 200 },
          value: { type: 'string', maxLength: 200 },
        },
        required: ['action', 'ids'],
      },
      async run(args) {
        const action = String(args.action || '').trim();
        const valid = ['tag', 'untag', 'status', 'delete', 'research', 'set_group', 'set_category'];
        if (!valid.includes(action)) throw argError(`unsupported bulk action: ${action}`);
        if (!Array.isArray(args.ids) || !args.ids.length) throw argError('ids is required.');
        if (args.ids.length > 200) throw argError('cannot process more than 200 leads at once.');
        const ids = args.ids.map((d) => requireId(d, 'id'));
        const engine = require('./leadEngine');
        const results = { action, processed: 0, failed: 0, errors: [] };
        if (action === 'research') ensureNotPaused();

        if (action === 'delete') {
          for (const id of ids) {
            try { engine.deleteLead(db, id); results.processed++; }
            catch (e) { results.failed++; results.errors.push({ id, error: e.message }); }
          }
          return { ok: true, data: { bulk: results } };
        }
        if (action === 'status') {
          const status = optStr(args.value, 50);
          if (!status || !engine.LEAD_STATUSES.includes(status)) throw argError('valid status value is required.');
          for (const id of ids) {
            try { engine.updateLead(db, id, { status }); results.processed++; }
            catch (e) { results.failed++; results.errors.push({ id, error: e.message }); }
          }
          return { ok: true, data: { bulk: results } };
        }
        if (action === 'set_group') {
          const group = engine.normalizeGroupName(args.value);
          for (const id of ids) {
            try { engine.updateLead(db, id, { lead_group: group }); results.processed++; }
            catch (e) { results.failed++; results.errors.push({ id, error: e.message }); }
          }
          return { ok: true, data: { bulk: results } };
        }
        if (action === 'set_category') {
          const category = optStr(args.value, 200);
          if (!category) throw argError('category value is required.');
          for (const id of ids) {
            try { engine.updateLead(db, id, { category }); results.processed++; }
            catch (e) { results.failed++; results.errors.push({ id, error: e.message }); }
          }
          return { ok: true, data: { bulk: results } };
        }
        if (action === 'tag' || action === 'untag') {
          const tag = optStr(args.value, 100);
          if (!tag) throw argError('tag value is required.');
          for (const id of ids) {
            try {
              const lead = engine.getLead(db, id);
              if (!lead) throw new Error(`lead not found: ${id}`);
              const tags = new Set(lead.tags || []);
              if (action === 'tag') tags.add(tag); else tags.delete(tag);
              engine.updateLead(db, id, { tags: [...tags] });
              results.processed++;
            } catch (e) { results.failed++; results.errors.push({ id, error: e.message }); }
          }
          return { ok: true, data: { bulk: results } };
        }
        if (action === 'research') {
          for (const id of ids) {
            try { await engine.researchLead(db, id); results.processed++; }
            catch (e) { results.failed++; results.errors.push({ id, error: e.message }); }
          }
          return { ok: true, data: { bulk: results } };
        }
        return { ok: true, data: { bulk: results } };
      },
    },

    // ----- Design job admin -----
    'design.update': {
      description: 'Update a design job (title, instructions, contact_email, site_shape, status fields the app allows).',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          title: { type: 'string', maxLength: 200 },
          instructions: { type: 'string', maxLength: 20000 },
          contact_email: { type: 'string', maxLength: 200 },
          contactEmail: { type: 'string', maxLength: 200 },
          site_shape: { type: 'string', enum: ['landing', 'multipage'] },
          siteShape: { type: 'string', enum: ['landing', 'multipage'] },
        },
        required: ['id'],
      },
      run(args) {
        const design = require('./designJobs');
        const id = requireId(args.id, 'id');
        const patch = {};
        if (args.title != null) patch.title = args.title;
        if (args.instructions != null) patch.instructions = args.instructions;
        if (args.contact_email != null || args.contactEmail != null) {
          patch.contact_email = args.contact_email != null ? args.contact_email : args.contactEmail;
        }
        if (args.site_shape != null || args.siteShape != null) {
          patch.site_shape = args.site_shape != null ? args.site_shape : args.siteShape;
        }
        const job = design.updateJob(db, id, patch);
        return { ok: true, data: { job: mcpSafeJob(job) } };
      },
    },

    'design.delete': {
      description: 'Delete a design job and its questions / delivery email rows.',
      schema: {
        type: 'object',
        properties: { id: { type: 'integer', minimum: 1 } },
        required: ['id'],
      },
      run(args) {
        const design = require('./designJobs');
        return { ok: true, data: design.deleteJob(db, requireId(args.id, 'id')) };
      },
    },

    'design.answer': {
      description: 'Answer a clarifying question on a design job (same as answering in the Design UI).',
      schema: {
        type: 'object',
        properties: {
          questionId: { type: 'integer', minimum: 1 },
          id: { type: 'integer', minimum: 1, description: 'Alias of questionId' },
          answer: { type: 'string', maxLength: 8000 },
          fromEmail: { type: 'string', maxLength: 200 },
        },
        required: ['answer'],
      },
      run(args) {
        const design = require('./designJobs');
        const qid = requireId(args.questionId != null ? args.questionId : args.id, 'questionId');
        const answer = vStr(args.answer, { max: 8000, def: '' });
        if (isErr(answer) || !String(answer).trim()) throw argError('answer is required.');
        const job = design.answerQuestion(db, qid, String(answer), args.fromEmail);
        return { ok: true, data: { job: mcpSafeJob(job) } };
      },
    },

    'design.setContact': {
      description: 'Set contact_email on a design job.',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          email: { type: 'string', maxLength: 200 },
        },
        required: ['id', 'email'],
      },
      run(args) {
        const design = require('./designJobs');
        const id = requireId(args.id, 'id');
        const email = vStr(args.email, { max: 200, def: '' });
        if (isErr(email)) throw argError('email is invalid.');
        const job = design.setContactEmail(db, id, String(email));
        return { ok: true, data: { job: mcpSafeJob(job) } };
      },
    },

    'design.emailDelivery': {
      description: 'Email a non-website delivery (social/logo/etc.) via workspace SMTP. Same as Email delivery in the app.',
      schema: {
        type: 'object',
        properties: {
          jobId: { type: 'integer', minimum: 1 },
          id: { type: 'integer', minimum: 1 },
        },
      },
      async run(args) {
        const design = require('./designJobs');
        const id = requireId(args.jobId != null ? args.jobId : args.id, 'jobId');
        return { ok: true, data: await design.emailDelivery(db, id) };
      },
    },

    'design.recordReply': {
      description: 'Record a pasted client email reply onto a design job.',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          reply: { type: 'string', maxLength: 12000 },
          fromEmail: { type: 'string', maxLength: 200 },
        },
        required: ['id', 'reply'],
      },
      run(args) {
        const design = require('./designJobs');
        const id = requireId(args.id, 'id');
        const reply = vStr(args.reply, { max: 12000, def: '' });
        if (isErr(reply) || !String(reply).trim()) throw argError('reply is required.');
        const job = design.recordEmailReply(db, id, String(reply), args.fromEmail);
        return { ok: true, data: { job: mcpSafeJob(job) } };
      },
    },

    'design.removeDeliveryItem': {
      description: 'Delete one card/item from a non-website delivery (path like days.0 or notes).',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          path: { type: 'string', maxLength: 120 },
        },
        required: ['id', 'path'],
      },
      run(args) {
        const design = require('./designJobs');
        const id = requireId(args.id, 'id');
        const path = vStr(args.path, { max: 120, def: '' });
        if (isErr(path) || !String(path).trim()) throw argError('path is required.');
        const job = design.removeDeliveryItem(db, id, String(path));
        return { ok: true, data: { job: mcpSafeJob(job) } };
      },
    },

    'design.saveWebsite': {
      description: 'Save block/theme edits on a delivered website design job (same as Save block edits).',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          pages: { type: 'array' },
          theme: { type: 'object' },
        },
        required: ['id', 'pages'],
      },
      run(args) {
        const design = require('./designJobs');
        const id = requireId(args.id, 'id');
        if (!Array.isArray(args.pages)) throw argError('pages must be an array.');
        const job = design.saveWebsiteEdit(db, id, args.pages, args.theme || {});
        return { ok: true, data: { job: mcpSafeJob(job) } };
      },
    },

    // ----- Websites table -----
    'website.list': {
      description: 'List websites (template or agent-origin) with pagination.',
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          page: { type: 'integer', minimum: 1 },
          pageSize: { type: 'integer', minimum: 1, maximum: 100 },
        },
      },
      run(args = {}) {
        const { pageArgs, pageResult } = require('./paginate');
        const { page, pageSize, offset } = pageArgs(args || {}, { pageSize: 25, maxSize: 100 });
        let where = '';
        const params = [];
        if (args.status) { where = ' WHERE w.status = ?'; params.push(String(args.status)); }
        const total = db.prepare(`SELECT COUNT(*) AS c FROM websites w${where}`).get(...params).c;
        const rows = db.prepare(
          `SELECT w.id, w.lead_id, w.name, w.industry, w.status, w.origin, w.updated_at,
                  l.business_name, l.category,
                  (SELECT COUNT(*) FROM website_versions v WHERE v.website_id = w.id) AS version_count
           FROM websites w LEFT JOIN leads l ON l.id = w.lead_id
           ${where}
           ORDER BY w.updated_at DESC LIMIT ? OFFSET ?`
        ).all(...params, pageSize, offset);
        return { ok: true, data: Object.assign({ sites: rows }, pageResult(rows, total, page, pageSize)) };
      },
    },

    'website.get': {
      description: 'Get one website (parsed pages/theme, version_note from latest snapshot, formsUnembedded).',
      schema: {
        type: 'object',
        properties: { id: { type: 'integer', minimum: 1 } },
        required: ['id'],
      },
      run(args) {
        const domain = require('../server/domain');
        const id = requireId(args.id, 'id');
        const site = domain.sitesGet(1, id);
        return { ok: true, data: { site } };
      },
    },

    'website.delete': {
      description: 'Delete a website and purge its EXPORT_ROOT folders / screenshots. Does not delete remote Cloudflare Pages projects or design jobs (jobs are unlinked).',
      schema: {
        type: 'object',
        properties: { id: { type: 'integer', minimum: 1 } },
        required: ['id'],
      },
      run(args) {
        const engine = require('./websiteEngine');
        const id = requireId(args.id, 'id');
        return { ok: true, data: engine.deleteWebsite(db, id) };
      },
    },

    'website.generate': {
      description: 'Template-fallback website generate for a lead (not the agent path). Use website.create / design.deliver for agent sites. Pass fallback:true to overwrite an agent site.',
      schema: {
        type: 'object',
        properties: {
          leadId: { type: 'integer', minimum: 1 },
          force: { type: 'boolean' },
          fallback: { type: 'boolean' },
        },
        required: ['leadId'],
      },
      async run(args) {
        ensureNotPaused();
        const engine = require('./websiteEngine');
        const leadId = requireId(args.leadId, 'leadId');
        const force = !!args.force;
        const fallback = !!args.fallback;
        engine.ensureTables(db);
        const existing = db.prepare('SELECT id, origin FROM websites WHERE lead_id = ?').get(leadId);
        if (existing && existing.origin === 'agent' && !fallback) {
          throw argError('An agent already delivered this website. Pass fallback:true to overwrite with the template generator.');
        }
        const result = await engine.generateSite(db, leadId, { force: fallback ? true : force });
        return { ok: true, data: result };
      },
    },

    'website.qa': {
      description: 'QA a custom or template site. Does NOT require template heroes. Grades: links, ≤1 form/page, export images + crop aspect, unique nav labels, no horizontal overflow at 390px, module-fit (appointment-intent pages need bookings module + ≥1 published service + hours), form-purpose-fields warning for free-text structured forms.',
      schema: {
        type: 'object',
        properties: { id: { type: 'integer', minimum: 1 } },
        required: ['id'],
      },
      async run(args) {
        const engine = require('./websiteEngine');
        const id = requireId(args.id, 'id');
        return { ok: true, data: await engine.qaSite(db, id) };
      },
    },

    'website.export': {
      description: 'Export a website to ~/website-scout-exports/<slug>-<id>/.',
      schema: {
        type: 'object',
        properties: { id: { type: 'integer', minimum: 1 } },
        required: ['id'],
      },
      run(args) {
        const path = require('path');
        const os = require('os');
        const engine = require('./websiteEngine');
        const id = requireId(args.id, 'id');
        const site = engine.getWebsite(db, id);
        const slug = String(site.name || 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'site';
        const dir = path.join(os.homedir(), 'website-scout-exports', `${slug}-${site.id}`);
        const out = engine.exportStatic(db, id, dir);
        return { ok: true, data: { path: out } };
      },
    },

    'website.postcard': {
      description: 'Claim kit for a website: preview URL, signed claim Yes/No URL, QR data-URLs; includePdf for base64 postcard PDF. Does not require automation.',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          includePdf: { type: 'boolean' },
        },
        required: ['id'],
      },
      async run(args) {
        const claimKit = require('./claimKit');
        const id = requireId(args.id, 'id');
        const engine = require('./websiteEngine');
        const site = engine.getWebsite(db, id);
        const leadId = Number(site.lead_id);
        if (!Number.isInteger(leadId) || leadId <= 0) throw new Error('Website has no lead');
        const kit = await claimKit.buildClaimKit(db, workspaceId, {
          leadId,
          websiteId: id,
          includePdf: !!args.includePdf,
        });
        if (kit.pdf) {
          const { pdf, ...rest } = kit;
          return { ok: true, data: { ...rest, pdfBase64: pdf.toString('base64'), pdfBytes: pdf.length } };
        }
        return { ok: true, data: kit };
      },
    },

    'lead.claimKit': {
      description: 'Claim kit for a lead: site URL, claim URL, QRs; optional includePdf postcard. Same intent as interested/uninterested links.',
      schema: {
        type: 'object',
        properties: {
          leadId: { type: 'integer', minimum: 1 },
          id: { type: 'integer', minimum: 1 },
          websiteId: { type: 'integer', minimum: 1 },
          includePdf: { type: 'boolean' },
        },
        required: ['leadId'],
      },
      async run(args) {
        const claimKit = require('./claimKit');
        const leadId = requireId(args.leadId != null ? args.leadId : args.id, 'leadId');
        const kit = await claimKit.buildClaimKit(db, workspaceId, {
          leadId,
          websiteId: args.websiteId != null ? Number(args.websiteId) : undefined,
          includePdf: !!args.includePdf,
        });
        if (kit.pdf) {
          const { pdf, ...rest } = kit;
          return { ok: true, data: { ...rest, pdfBase64: pdf.toString('base64'), pdfBytes: pdf.length } };
        }
        return { ok: true, data: kit };
      },
    },

    'website.openPreview': {
      description: 'Open a websites-table site in the default browser (exports HTML first).',
      schema: {
        type: 'object',
        properties: { id: { type: 'integer', minimum: 1 } },
        required: ['id'],
      },
      async run(args) {
        const openPreview = require('./openPreview');
        const id = requireId(args.id, 'id');
        const opened = await openPreview.openWebsiteFile(db, id);
        return { ok: true, data: { path: opened.path } };
      },
    },

    'website.addImages': {
      description: 'Attach Pexels stock photos to a website (not AI replace â€” use website.replaceImage for that).',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          query: { type: 'string', maxLength: 120 },
          count: { type: 'integer', minimum: 1, maximum: 6 },
        },
        required: ['id'],
      },
      async run(args) {
        ensureNotPaused();
        const engine = require('./websiteEngine');
        const id = requireId(args.id, 'id');
        const result = await engine.attachPexelsImages(db, id, {
          query: optStr(args.query, 120),
          count: args.count,
        });
        return { ok: true, data: result };
      },
    },

    'design.generateLogo': {
      description: 'Generate a site header logo (OpenAI Images, transparent PNG), attach to the design job, and apply to the linked website theme when possible. Respects automation pause.',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          prompt: { type: 'string', maxLength: 4000 },
          brandName: { type: 'string', maxLength: 120 },
          websiteId: { type: 'integer', minimum: 1 },
          size: { type: 'string' },
          quality: { type: 'string' },
          model: { type: 'string', maxLength: 120 },
        },
        required: ['id'],
      },
      async run(args) {
        ensureNotPaused();
        const design = require('./designJobs');
        const logoProcess = require('./logoProcess');
        const engine = require('./websiteEngine');
        const fs = require('fs');
        const path = require('path');
        const openPreview = require('./openPreview');
        const id = requireId(args.id, 'id');
        const result = await design.generateJobLogo(db, id, {
          prompt: optStr(args.prompt, 4000),
          brandName: optStr(args.brandName, 120),
          size: optStr(args.size, 32),
          quality: optStr(args.quality, 32),
          model: optStr(args.model, 120),
        });
        let appliedToSite = false;
        let siteId = args.websiteId != null ? requireId(args.websiteId, 'websiteId') : result.websiteId;
        if (!siteId && result.leadId) {
          const row = db.prepare('SELECT id FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(result.leadId);
          if (row) siteId = row.id;
        }
        if (siteId && result.buffer) {
          const site = engine.getWebsite(db, siteId);
          let pages = typeof site.pages === 'string' ? JSON.parse(site.pages || '[]') : (site.pages || []);
          const theme = Object.assign(
            {},
            typeof site.theme === 'string' ? JSON.parse(site.theme || '{}') : (site.theme || {})
          );
          if (args.brandName) theme.brandName = String(args.brandName).slice(0, 120);
          const folder = `site-${siteId}`;
          const imgDir = path.join(openPreview.exportRoot(), folder, 'images');
          fs.mkdirSync(imgDir, { recursive: true });
          fs.writeFileSync(path.join(imgDir, 'logo.png'), result.buffer);
          theme.logoMode = 'image';
          theme.logoUrl = 'images/logo.png';
          pages = logoProcess.applyLogoMarkupToPages(pages, theme.logoUrl, theme.brandName || site.name || 'Logo');
          engine.saveSite(db, siteId, pages, theme, `MCP design.generateLogo job #${id}`);
          appliedToSite = true;
        }
        return {
          ok: true,
          data: {
            id: result.id,
            websiteId: siteId || null,
            model: result.model,
            prompt: result.prompt,
            logoUrl: result.logoUrl,
            path: result.path,
            mode: 'image',
            appliedToSite,
          },
        };
      },
    },

    'website.setLogo': {
      description: 'Set site header logo: mode "text" or "image" with base64 data (max ~5.5MB). Cover-crops to transparent PNG.',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          leadId: { type: 'integer', minimum: 1 },
          mode: { type: 'string', enum: ['text', 'image'] },
          data: { type: 'string' },
          mimeType: { type: 'string' },
          brandName: { type: 'string', maxLength: 120 },
        },
      },
      async run(args) {
        const engine = require('./websiteEngine');
        const logoProcess = require('./logoProcess');
        const fs = require('fs');
        const path = require('path');
        const openPreview = require('./openPreview');
        let siteId = args.id != null ? requireId(args.id, 'id') : null;
        if (!siteId && args.leadId != null) {
          const row = db.prepare('SELECT id FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1')
            .get(requireId(args.leadId, 'leadId'));
          if (!row) throw argError('No website is available for this lead');
          siteId = row.id;
        }
        if (!siteId) throw argError('id or leadId is required.');
        const site = engine.getWebsite(db, siteId);
        let pages = typeof site.pages === 'string' ? JSON.parse(site.pages || '[]') : (site.pages || []);
        const theme = Object.assign(
          {},
          typeof site.theme === 'string' ? JSON.parse(site.theme || '{}') : (site.theme || {})
        );
        if (args.brandName != null) theme.brandName = String(args.brandName).trim().slice(0, 120);
        const mode = String(args.mode || (args.data ? 'image' : 'text')).toLowerCase();
        if (mode === 'text') {
          theme.logoMode = 'text';
          theme.logoUrl = '';
          pages = logoProcess.clearLogoMarkupFromPages(pages);
        } else {
          const dataB64 = String(args.data || '').replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '').replace(/\s+/g, '');
          const maxB64 = Math.ceil(5.5 * 1024 * 1024 * 4 / 3) + 256;
          if (!dataB64) throw argError('data (base64 image) is required for mode=image.');
          if (dataB64.length > maxB64) throw argError('Logo image is too large (max 5.5 MB).');
          const buffer = Buffer.from(dataB64, 'base64');
          if (!buffer.length || buffer.length > 5.5 * 1024 * 1024) {
            throw argError('Logo image must be between 1 byte and 5.5 MB.');
          }
          const processed = await logoProcess.processLogoBuffer(buffer);
          const folder = `site-${siteId}`;
          const imgDir = path.join(openPreview.exportRoot(), folder, 'images');
          fs.mkdirSync(imgDir, { recursive: true });
          fs.writeFileSync(path.join(imgDir, 'logo.png'), processed.buffer);
          theme.logoMode = 'image';
          theme.logoUrl = 'images/logo.png';
          pages = logoProcess.applyLogoMarkupToPages(pages, theme.logoUrl, theme.brandName || site.name || 'Logo');
        }
        const version = engine.saveSite(db, siteId, pages, theme, mode === 'text' ? 'Logo mode: text' : 'Logo upload');
        return {
          ok: true,
          data: {
            siteId,
            mode: mode === 'text' ? 'text' : 'image',
            logoUrl: theme.logoUrl || '',
            brandName: theme.brandName || null,
            version: { id: version.id, version_no: version.version_no },
          },
        };
      },
    },

    'website.setTheme': {
      description: 'Set website theme colors, fonts, customCss/customJs/customHead, favicon, and/or shared partials (headerHtml/footerHtml). Pass id or leadId.',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          leadId: { type: 'integer', minimum: 1 },
          primary: { type: 'string' },
          secondary: { type: 'string' },
          bg: { type: 'string' },
          text: { type: 'string' },
          colors: { type: 'object' },
          font: { type: 'string' },
          headingFont: { type: 'string' },
          customCss: { type: 'string' },
          customJs: { type: 'string' },
          customHead: { type: 'string' },
          favicon: { type: 'string' },
          partials: { type: 'object' },
          baseCss: { type: 'boolean' },
          note: { type: 'string', maxLength: 500 },
        },
      },
      run(args) {
        const engine = require('./websiteEngine');
        const googleFonts = require('../public/js/fonts.js');
        const keys = ['primary', 'secondary', 'bg', 'text'];
        const src = args.colors && typeof args.colors === 'object' ? args.colors : args;
        const patch = {};
        for (const key of keys) {
          if (src[key] == null || src[key] === '') continue;
          let s = String(src[key]).trim();
          if (s[0] !== '#') s = `#${s}`;
          if (/^#[0-9a-fA-F]{3}$/.test(s)) s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
          if (!/^#[0-9a-fA-F]{6}$/.test(s)) throw argError(`Invalid ${key} color (use #RRGGBB).`);
          patch[key] = s.toLowerCase();
        }
        if (args.font != null && String(args.font).trim()) {
          patch.font = googleFonts.safeStack(args.font);
        }
        if (args.headingFont != null) {
          const heading = String(args.headingFont).trim();
          patch.headingFont = heading ? googleFonts.safeStack(heading) : '';
        }
        if (args.customCss != null) patch.customCss = String(args.customCss);
        if (args.customJs != null) patch.customJs = String(args.customJs);
        if (args.customHead != null) patch.customHead = String(args.customHead);
        if (args.favicon != null) patch.favicon = String(args.favicon).trim();
        if (args.baseCss != null) patch.baseCss = !!args.baseCss;
        if (args.partials && typeof args.partials === 'object') {
          patch.partials = {
            headerHtml: args.partials.headerHtml != null
              ? String(args.partials.headerHtml)
              : (args.partials.header != null ? String(args.partials.header) : undefined),
            footerHtml: args.partials.footerHtml != null
              ? String(args.partials.footerHtml)
              : (args.partials.footer != null ? String(args.partials.footer) : undefined),
          };
        }
        if (!Object.keys(patch).length) {
          throw argError('Provide at least one theme field (colors, fonts, customCss/Js, favicon, partials).');
        }
        let siteId = args.id != null ? requireId(args.id, 'id') : null;
        if (!siteId && args.leadId != null) {
          const row = db.prepare('SELECT id FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1')
            .get(requireId(args.leadId, 'leadId'));
          if (!row) throw argError('No website is available for this lead');
          siteId = row.id;
        }
        if (!siteId) throw argError('id or leadId is required.');
        const site = engine.getWebsite(db, siteId);
        const pages = typeof site.pages === 'string' ? JSON.parse(site.pages || '[]') : (site.pages || []);
        const oldTheme = typeof site.theme === 'string' ? JSON.parse(site.theme || '{}') : (site.theme || {});
        const theme = Object.assign({}, oldTheme, patch);
        if (typeof theme.customCss === 'string' && theme.customCss) {
          let css = theme.customCss;
          for (const key of keys) {
            if (!oldTheme[key] || !patch[key]) continue;
            css = css.split(String(oldTheme[key])).join(patch[key]);
          }
          theme.customCss = css;
        }
        const version = engine.saveSite(
          db,
          siteId,
          pages,
          theme,
          args.note || (patch.font || patch.headingFont ? 'MCP website.setTheme fonts' : 'MCP website.setTheme')
        );
        const normalized = engine.normalizeTheme(theme);
        return {
          ok: true,
          data: {
            siteId,
            colors: {
              primary: normalized.primary,
              secondary: normalized.secondary,
              bg: normalized.bg,
              text: normalized.text,
              font: normalized.font,
              headingFont: normalized.headingFont || '',
            },
            version: { id: version.id, version_no: version.version_no },
          },
        };
      },
    },

    'fonts.list': {
      description: 'List curated Google Fonts for theme.font / theme.headingFont. Free local catalog.',
      schema: {
        type: 'object',
        properties: {
          group: { type: 'string', description: 'Optional: Sans, Serif, Display, or Mono' },
        },
      },
      run(args) {
        const fonts = require('../public/js/fonts.js');
        let list = Array.isArray(fonts.CATALOG) ? fonts.CATALOG.slice() : [];
        const group = args && args.group != null ? String(args.group).trim() : '';
        if (group) {
          const g = group.toLowerCase();
          list = list.filter((f) => String(f.group || '').toLowerCase() === g);
        }
        return {
          ok: true,
          data: {
            fonts: list.map((f) => ({
              name: f.name,
              group: f.group,
              generic: f.generic,
              stack: fonts.stackFor(f.name),
            })),
            groups: [...new Set((fonts.CATALOG || []).map((f) => f.group).filter(Boolean))],
            count: list.length,
            note: 'Free local catalog. Use name with website.setTheme ({ font, headingFont }).',
          },
        };
      },
    },

    'website.replaceImage': {
      description: 'Replace a site image by replaceSrc under images/ or assets/: pass data (base64) or prompt (AI). Optional crop:{aspect,focalX,focalY,width?,height?} writes a server-cropped variant whose width/height match the CROP box. Pass id or leadId. Does not fetch remote URLs. assets/ filenames stay stable.',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          leadId: { type: 'integer', minimum: 1 },
          replaceSrc: { type: 'string', maxLength: 500 },
          src: { type: 'string', maxLength: 500 },
          data: { type: 'string' },
          mimeType: { type: 'string' },
          prompt: { type: 'string', maxLength: 2000 },
          size: { type: 'string' },
          quality: { type: 'string' },
          crop: {
            type: 'object',
            properties: {
              aspect: { type: 'string', description: 'e.g. "16:9" or "1:1"' },
              focalX: { type: 'number', minimum: 0, maximum: 1 },
              focalY: { type: 'number', minimum: 0, maximum: 1 },
              width: { type: 'integer', minimum: 1 },
              height: { type: 'integer', minimum: 1 },
            },
          },
        },
      },
      async run(args) {
        ensureNotPaused();
        const engine = require('./websiteEngine');
        const fs = require('fs');
        const path = require('path');
        const openPreview = require('./openPreview');
        let siteId = args.id != null ? requireId(args.id, 'id') : null;
        if (!siteId && args.leadId != null) {
          const row = db.prepare('SELECT id FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1')
            .get(requireId(args.leadId, 'leadId'));
          if (!row) throw argError('No website is available for this lead');
          siteId = row.id;
        }
        if (!siteId) throw argError('id or leadId is required.');
        let replaceSrc = String(args.replaceSrc || args.src || '').trim().replace(/\\/g, '/');
        if (!replaceSrc) throw argError('replaceSrc is required (e.g. images/hero.jpg or assets/photo.jpg).');
        if (replaceSrc.includes('..')) throw argError('Invalid replaceSrc.');
        replaceSrc = replaceSrc.replace(/^\.?\//, '');
        const isAsset = /^assets\//i.test(replaceSrc);
        if (!/^images\//i.test(replaceSrc) && !isAsset) {
          if (/\.(png|jpe?g|gif|webp|svg|ico)$/i.test(replaceSrc) && !replaceSrc.includes('/')) {
            replaceSrc = `images/${replaceSrc}`;
          } else {
            throw argError('replaceSrc must be under images/ or assets/.');
          }
        }
        let buffer;
        if (args.data) {
          const dataB64 = String(args.data).replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '').replace(/\s+/g, '');
          const maxB64 = Math.ceil(5.5 * 1024 * 1024 * 4 / 3) + 256;
          if (dataB64.length > maxB64) throw argError('Image is too large (max 5.5 MB).');
          buffer = Buffer.from(dataB64, 'base64');
        } else if (args.prompt) {
          const openaiImages = require('./openaiImages');
          const site = engine.getWebsite(db, siteId);
          const gen = await openaiImages.generateImages(db, String(args.prompt).trim(), {
            n: 1,
            size: args.size || '1024x1024',
            quality: args.quality != null ? args.quality : 'low',
            leadId: site.lead_id,
            note: `MCP website.replaceImage #${siteId}`,
          });
          const file = gen.images && gen.images[0];
          if (!file || !file.path || !fs.existsSync(file.path)) throw argError('Image provider returned no image.');
          buffer = fs.readFileSync(file.path);
        } else {
          throw argError('Provide data (base64) or prompt (AI).');
        }
        if (!buffer.length || buffer.length > 5.5 * 1024 * 1024) {
          throw argError('Image must be between 1 byte and 5.5 MB.');
        }
        let cropMeta = null;
        if (args.crop && typeof args.crop === 'object') {
          const imageCrop = require('./imageCrop');
          const cropped = await imageCrop.cropBuffer(buffer, args.crop);
          buffer = cropped.buffer;
          cropMeta = imageCrop.cropMetaFromResult(cropped, args.crop);
        }
        // Stable assets/ filenames are never renamed by optimize.
        let destName = path.basename(replaceSrc);
        let outExt = path.extname(destName) || '.png';
        if (!isAsset && !cropMeta) {
          try {
            const imageOptimize = require('./imageOptimize');
            const opt = await imageOptimize.optimizeBuffer(buffer, {
              fileName: destName,
              role: /^logo\./i.test(destName) ? 'logo' : 'photo',
              preferWebp: !/^logo\./i.test(destName),
            });
            if (!opt.skipped && opt.buffer && opt.buffer.length) {
              buffer = opt.buffer;
              if (opt.ext) {
                outExt = opt.ext;
                destName = `${path.basename(destName, path.extname(destName))}${opt.ext}`;
              }
            }
          } catch (e) {
            console.warn('[mcp] replaceImage optimize skip:', e.message || e);
          }
        } else if (cropMeta) {
          // Keep crop pixel box; prefer webp only when dest already webp.
          outExt = path.extname(destName) || '.jpg';
        }
        const folder = isAsset ? 'assets' : 'images';
        const imgDir = path.join(openPreview.exportRoot(), `site-${siteId}`, folder);
        fs.mkdirSync(imgDir, { recursive: true });
        const dest = path.join(imgDir, destName);
        fs.writeFileSync(dest, buffer);
        const site = engine.getWebsite(db, siteId);
        let pages = typeof site.pages === 'string' ? JSON.parse(site.pages || '[]') : (site.pages || []);
        const theme = typeof site.theme === 'string' ? JSON.parse(site.theme || '{}') : (site.theme || {});
        const from = replaceSrc;
        const to = `${folder}/${destName}`;
        const rewrite = (v) => {
          if (typeof v === 'string') return v === from || v.includes(from) ? v.split(from).join(to) : v;
          if (Array.isArray(v)) return v.map(rewrite);
          if (v && typeof v === 'object') {
            const out = {};
            for (const [k, val] of Object.entries(v)) out[k] = rewrite(val);
            return out;
          }
          return v;
        };
        pages = rewrite(pages);
        if (cropMeta) {
          const stamp = (node) => {
            if (!node || typeof node !== 'object') return;
            if (typeof node.url === 'string' && (node.url === to || node.url === from)) {
              node.crop = Object.assign({}, cropMeta);
            }
            if (Array.isArray(node)) node.forEach(stamp);
            else Object.values(node).forEach(stamp);
          };
          stamp(pages);
        }
        const version = engine.saveSite(db, siteId, pages, theme, `MCP replaceImage ${to}`);
        // Rematerialize immediately so the next publish/screenshot is not one version behind.
        try {
          const slug = String(site.name || 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'site';
          const outDir = path.join(openPreview.exportRoot(), `${slug}-${siteId}`);
          engine.exportStatic(db, siteId, outDir);
        } catch (e) {
          console.warn('[mcp] replaceImage rematerialize skip:', e.message || e);
        }
        return {
          ok: true,
          data: {
            siteId,
            replaceSrc: from,
            url: to,
            path: dest,
            bytes: buffer.length,
            ext: outExt,
            crop: cropMeta,
            version: { id: version.id, version_no: version.version_no },
          },
        };
      },
    },

    'website.uploadAsset': {
      description: 'Upload a stable site asset as assets/<filename> (images, fonts/woff2, video/mp4|webm, SVG). Filename is preserved â€” never renamed by optimize/replace. Pass data (base64), mimeType, filename. Optional setFavicon:true writes theme.favicon.',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          websiteId: { type: 'integer', minimum: 1 },
          leadId: { type: 'integer', minimum: 1 },
          data: { type: 'string' },
          mimeType: { type: 'string' },
          mime: { type: 'string' },
          filename: { type: 'string', maxLength: 200 },
          name: { type: 'string', maxLength: 200 },
          setFavicon: { type: 'boolean' },
        },
        required: ['data', 'filename'],
      },
      run(args) {
        ensureNotPaused();
        const engine = require('./websiteEngine');
        const fs = require('fs');
        const path = require('path');
        const openPreview = require('./openPreview');
        let siteId = args.id != null ? requireId(args.id, 'id') : null;
        if (!siteId && args.websiteId != null) siteId = requireId(args.websiteId, 'websiteId');
        if (!siteId && args.leadId != null) {
          const row = db.prepare('SELECT id FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1')
            .get(requireId(args.leadId, 'leadId'));
          if (!row) throw argError('No website is available for this lead');
          siteId = row.id;
        }
        if (!siteId) throw argError('id, websiteId, or leadId is required.');
        let filename = String(args.filename || args.name || '').trim();
        filename = path.basename(filename).replace(/[^\w.\-()+ ]+/g, '_');
        if (!filename || filename === '.' || filename === '..') throw argError('filename is required');
        const mime = String(args.mimeType || args.mime || '').toLowerCase();
        const allowedExt = /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|mp4|webm)$/i;
        if (!allowedExt.test(filename)) {
          throw argError('filename must end with png/jpg/gif/webp/svg/ico/woff2/ttf/otf/mp4/webm');
        }
        const allowedMime = /^(image\/(png|jpeg|jpg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon)|font\/(woff2?|ttf|otf)|application\/(font-woff2?|octet-stream)|video\/(mp4|webm))$/i;
        if (mime && !allowedMime.test(mime) && !/^application\/octet-stream$/i.test(mime)) {
          throw argError(`Unsupported mimeType: ${mime}`);
        }
        const dataB64 = String(args.data).replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
        const maxBytes = /\.(mp4|webm)$/i.test(filename) ? 25 * 1024 * 1024 : 8 * 1024 * 1024;
        const maxB64 = Math.ceil(maxBytes * 4 / 3) + 256;
        if (dataB64.length > maxB64) throw argError(`Asset too large (max ${Math.round(maxBytes / 1024 / 1024)} MB).`);
        const buffer = Buffer.from(dataB64, 'base64');
        if (!buffer.length) throw argError('Empty asset data');
        const assetsDir = path.join(openPreview.exportRoot(), `site-${siteId}`, 'assets');
        fs.mkdirSync(assetsDir, { recursive: true });
        const dest = path.join(assetsDir, filename);
        fs.writeFileSync(dest, buffer);
        const url = `assets/${filename}`;
        const site = engine.getWebsite(db, siteId);
        let theme = typeof site.theme === 'string' ? JSON.parse(site.theme || '{}') : (site.theme || {});
        let pages = typeof site.pages === 'string' ? JSON.parse(site.pages || '[]') : (site.pages || []);
        if (args.setFavicon) {
          theme = Object.assign({}, theme, { favicon: url });
          engine.saveSite(db, siteId, pages, theme, `MCP uploadAsset favicon ${url}`);
        }
        // Rematerialize into the canonical publish folder (same path CF publish uses).
        try {
          const domain = require('../server/domain');
          const wsId = Number(process.env.WORKSPACE_ID || process.env.DEFAULT_WORKSPACE_ID || 1);
          if (typeof domain.materializeWebsiteExport === 'function') {
            domain.materializeWebsiteExport(db, wsId, siteId);
          } else {
            engine.exportStatic(db, siteId, path.join(openPreview.exportRoot(), `site-${siteId}-export`));
          }
        } catch (e) {
          console.warn('[mcp] uploadAsset rematerialize skip:', e.message || e);
        }
        logActivity('mcp', `website.uploadAsset site=${siteId} ${url} (${buffer.length}b)`);
        return {
          ok: true,
          data: {
            siteId,
            url,
            path: dest,
            filename,
            bytes: buffer.length,
            mimeType: mime || null,
            favicon: args.setFavicon ? url : undefined,
          },
        };
      },
    },

    'website.screenshot': {
      description: 'Capture a PNG screenshot of a site page at a viewport width (at least 390 and 1440). Pass id, path (e.g. index.html or about.html), width. Renders the latest saved pages locally by default (avoids stale CF preview_url); pass previewUrl to force a live URL. Also see site.screenshots.capture for batch home/services shots.',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          websiteId: { type: 'integer', minimum: 1 },
          path: { type: 'string', maxLength: 200 },
          width: { type: 'integer', minimum: 320, maximum: 2560 },
          height: { type: 'integer', minimum: 480, maximum: 4096 },
          previewUrl: { type: 'string' },
        },
        required: ['width'],
      },
      async run(args) {
        const shots = require('./siteScreenshots');
        shots.ensureTables(db);
        let siteId = args.id != null ? requireId(args.id, 'id') : null;
        if (!siteId && args.websiteId != null) siteId = requireId(args.websiteId, 'websiteId');
        if (!siteId) throw argError('id or websiteId is required.');
        const width = Number(args.width);
        if (!Number.isFinite(width)) throw argError('width is required');
        const row = await shots.captureOneScreenshot(db, siteId, {
          path: args.path != null ? String(args.path) : 'index.html',
          width,
          height: args.height != null ? Number(args.height) : undefined,
          previewUrl: args.previewUrl != null ? String(args.previewUrl) : undefined,
        });
        logActivity('mcp', `website.screenshot site=${siteId} w=${width} path=${args.path || 'index.html'}`);
        return { ok: true, data: row };
      },
    },

    'website.optimizeImages': {
      description: 'Optimize all site images (resize â‰¤2400px, compress, WebP when safe). Pass id, websiteId, or leadId. Optional force.',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          websiteId: { type: 'integer', minimum: 1 },
          leadId: { type: 'integer', minimum: 1 },
          force: { type: 'boolean' },
          preferWebp: { type: 'boolean' },
        },
      },
      async run(args) {
        ensureNotPaused();
        const imageOptimize = require('./imageOptimize');
        let siteId = args.id != null ? requireId(args.id, 'id') : null;
        if (!siteId && args.websiteId != null) siteId = requireId(args.websiteId, 'websiteId');
        if (!siteId && args.leadId != null) {
          const row = db.prepare('SELECT id FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1')
            .get(requireId(args.leadId, 'leadId'));
          if (!row) throw argError('No website is available for this lead');
          siteId = row.id;
        }
        if (!siteId) throw argError('id, websiteId, or leadId is required.');
        const result = await imageOptimize.optimizeWebsiteImages(db, siteId, {
          force: !!args.force,
          preferWebp: args.preferWebp !== false,
          savePages: true,
          note: 'MCP website.optimizeImages',
        });
        return { ok: true, data: result };
      },
    },

    'website.structure': {
      description: 'Read visual menu tree + section summary (menuParent / nest flags) for a website.',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          websiteId: { type: 'integer', minimum: 1 },
        },
      },
      run(args) {
        const engine = require('./websiteEngine');
        const structure = require('./siteStructure');
        const siteId = requireId(args.websiteId != null ? args.websiteId : args.id, 'id');
        const site = engine.getWebsite(db, siteId);
        let pages = site.pages;
        if (typeof pages === 'string') {
          try { pages = JSON.parse(pages || '[]'); } catch { pages = []; }
        }
        if (!Array.isArray(pages)) pages = [];
        const summary = structure.summarizeStructure(pages);
        return { ok: true, data: { siteId, menu: summary.menu, pages: summary.pages } };
      },
    },

    'website.structure.reorder': {
      description: 'Reorder menu/sections or nest/unnest a one-level submenu (menuParent).',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          websiteId: { type: 'integer', minimum: 1 },
          scope: { type: 'string', enum: ['menu', 'sections'] },
          action: { type: 'string', enum: ['move', 'nest', 'unnest', 'indent', 'outdent'] },
          fromIndex: { type: 'integer', minimum: 0 },
          direction: { type: 'integer', enum: [-1, 1] },
          pageIndex: { type: 'integer', minimum: 0 },
        },
        required: ['scope', 'fromIndex'],
      },
      run(args) {
        const engine = require('./websiteEngine');
        const structure = require('./siteStructure');
        const siteId = requireId(args.websiteId != null ? args.websiteId : args.id, 'id');
        const scope = String(args.scope || '').toLowerCase();
        const fromIndex = Number(args.fromIndex);
        const action = String(args.action || 'move').toLowerCase();
        if (scope !== 'menu' && scope !== 'sections') throw argError('scope must be menu or sections');
        if (!Number.isInteger(fromIndex) || fromIndex < 0) throw argError('Invalid fromIndex');
        const site = engine.getWebsite(db, siteId);
        let pages = site.pages;
        if (typeof pages === 'string') {
          try { pages = JSON.parse(pages || '[]'); } catch { pages = []; }
        }
        if (!Array.isArray(pages) || !pages.length) throw argError('No pages on this website');
        let result;
        if (scope === 'menu') {
          result = structure.applyMenuAction(pages, {
            action,
            fromIndex,
            direction: args.direction,
          });
        } else {
          const pageIndex = Number(args.pageIndex);
          if (!Number.isInteger(pageIndex) || pageIndex < 0) throw argError('pageIndex is required for sections');
          const direction = Number(args.direction);
          if (direction !== 1 && direction !== -1) throw argError('direction must be 1 or -1');
          result = structure.reorderSections(pages, pageIndex, fromIndex, direction);
        }
        if (!result.changed) throw argError('Cannot move that item');
        const theme = typeof site.theme === 'string'
          ? (() => { try { return JSON.parse(site.theme || '{}'); } catch { return {}; } })()
          : (site.theme || {});
        const note = scope === 'menu'
          ? (action === 'nest' || action === 'indent' ? 'MCP nested menu item'
            : (action === 'unnest' || action === 'outdent' ? 'MCP unnested menu item' : 'MCP reordered menu'))
          : 'MCP reordered sections';
        const version = engine.saveSite(db, siteId, result.pages, theme, note);
        const summary = structure.summarizeStructure(result.pages);
        logActivity('mcp', `website.structure.reorder site=${siteId} scope=${scope} action=${action}`);
        return {
          ok: true,
          data: {
            siteId,
            scope,
            action,
            version: { id: version.id, version_no: version.version_no },
            menu: summary.menu,
            pages: summary.pages,
          },
        };
      },
    },

    'website.addSection': {
      description: 'Add a page section (Page â†’ Section â†’ Block). Use sectionType "section" for an empty container, or a block type (heading/text/image/html/columns/â€¦). cols=1..12. Prefer website.addBlock to nest into an existing section/cell.',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          websiteId: { type: 'integer', minimum: 1 },
          pageIndex: { type: 'integer', minimum: 0 },
          afterIndex: { type: 'integer', minimum: -1 },
          sectionType: { type: 'string' },
          type: { type: 'string' },
          cols: { type: 'integer', minimum: 1, maximum: 12 },
          html: { type: 'string' },
        },
        required: ['pageIndex', 'afterIndex'],
      },
      run(args) {
        const engine = require('./websiteEngine');
        const structure = require('./siteStructure');
        const siteId = requireId(args.websiteId != null ? args.websiteId : args.id, 'id');
        const pageIndex = Number(args.pageIndex);
        const afterIndex = Number(args.afterIndex);
        const sectionType = String(args.sectionType || args.type || 'section').trim().toLowerCase() || 'section';
        if (!Number.isInteger(pageIndex) || pageIndex < 0) throw argError('Invalid pageIndex');
        if (!Number.isInteger(afterIndex) || afterIndex < -1) throw argError('Invalid afterIndex');
        const site = engine.getWebsite(db, siteId);
        let pages = site.pages;
        if (typeof pages === 'string') {
          try { pages = JSON.parse(pages || '[]'); } catch { pages = []; }
        }
        if (!Array.isArray(pages) || !pages.length) throw argError('No pages on this website');
        const cols = args.cols != null ? Number(args.cols) : undefined;
        const html = args.html != null ? String(args.html) : undefined;
        const result = structure.insertContentSection(pages, pageIndex, afterIndex, sectionType, { cols, html });
        if (!result.changed) throw argError(result.reason === 'no_sections' ? 'Page has no modular sections' : 'Cannot insert that section');
        const theme = typeof site.theme === 'string'
          ? (() => { try { return JSON.parse(site.theme || '{}'); } catch { return {}; } })()
          : (site.theme || {});
        const version = engine.saveSite(db, siteId, result.pages, theme, `MCP inserted ${sectionType}`);
        const summary = structure.summarizeStructure(result.pages);
        logActivity('mcp', `website.addSection site=${siteId} type=${sectionType}`);
        return {
          ok: true,
          data: {
            siteId,
            sectionType,
            sectionIndex: result.sectionIndex,
            version: { id: version.id, version_no: version.version_no },
            menu: summary.menu,
            pages: summary.pages,
          },
        };
      },
    },

    'website.addBlock': {
      description: 'Add a block into a section (or columns cell). Types: heading, text, image, html, columns (cols 1â€“12), text_image, cards, module, form. Nesting: block in section; optional cellIndex for a layout cell.',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          websiteId: { type: 'integer', minimum: 1 },
          pageIndex: { type: 'integer', minimum: 0 },
          sectionIndex: { type: 'integer', minimum: 0 },
          blockType: { type: 'string' },
          type: { type: 'string' },
          cols: { type: 'integer', minimum: 1, maximum: 12 },
          cellIndex: { type: 'integer', minimum: 0 },
          moduleType: { type: 'string' },
          formId: { type: 'integer', minimum: 1 },
          formToken: { type: 'string' },
          html: { type: 'string' },
          content: { type: 'object' },
        },
        required: ['pageIndex', 'sectionIndex'],
      },
      run(args) {
        const engine = require('./websiteEngine');
        const structure = require('./siteStructure');
        const modules = require('../server/siteModules');
        const forms = require('../server/contactForms');
        const siteId = requireId(args.websiteId != null ? args.websiteId : args.id, 'id');
        const pageIndex = Number(args.pageIndex);
        const sectionIndex = Number(args.sectionIndex);
        let blockType = String(args.blockType || args.type || '').trim().toLowerCase();
        if (!blockType) throw argError('blockType is required');
        if (!Number.isInteger(pageIndex) || pageIndex < 0) throw argError('Invalid pageIndex');
        if (!Number.isInteger(sectionIndex) || sectionIndex < 0) throw argError('Invalid sectionIndex');
        const site = engine.getWebsite(db, siteId);
        let pages = site.pages;
        if (typeof pages === 'string') {
          try { pages = JSON.parse(pages || '[]'); } catch { pages = []; }
        }
        if (!Array.isArray(pages) || !pages.length) throw argError('No pages on this website');
        const cols = args.cols != null ? Number(args.cols) : undefined;
        const cellIndex = args.cellIndex != null ? Number(args.cellIndex) : undefined;
        let html = args.html != null ? String(args.html) : undefined;
        let content = args.content && typeof args.content === 'object' ? args.content : undefined;

        let widget = undefined;
        const intoCell = Number.isInteger(cellIndex) && cellIndex >= 0;
        if (blockType === 'module' || blockType === 'site_module' || blockType === 'widget') {
          const moduleType = String(args.moduleType || args.module_type || args.module || '').trim().toLowerCase();
          if (!moduleType) throw argError('moduleType is required for module blocks');
          const leadId = site.lead_id;
          if (!leadId) throw argError('Website has no lead_id');
          modules.ensureTables(db);
          const wsHint = Number(leadId) || 1;
          let row = modules.getEmbedRow(db, Number(leadId), moduleType);
          if (!row) {
            row = modules.ensureEmbed(db, Number(leadId), moduleType, { workspaceId: wsHint });
          }
          if (!row.public_token && typeof modules.makePublicToken === 'function') {
            const token = modules.makePublicToken(wsHint);
            db.prepare(
              "UPDATE site_module_embeds SET public_token = ?, updated_at = datetime('now') WHERE id = ?"
            ).run(token, row.id);
            row = modules.getEmbedRow(db, Number(leadId), moduleType);
          }
          if (!row || !row.public_token) throw argError('Could not enable module embed');
          db.prepare(
            `UPDATE site_module_embeds SET published = 1, embed_enabled = 1, updated_at = datetime('now')
             WHERE lead_id = ? AND module_type = ?`
          ).run(Number(leadId), moduleType);
          row = modules.getEmbedRow(db, Number(leadId), moduleType);
          html = modules.embedBlockHtml(modules.publicEmbed(row), undefined);
          if (intoCell) {
            widget = {
              type: 'site_module',
              public_token: row.public_token,
              module_type: moduleType,
              html,
            };
            content = widget;
            // Keep blockType as module so insertBlockIntoSection stores cell.widget.
          } else {
            blockType = 'html';
            content = undefined;
          }
        } else if (blockType === 'form' || blockType === 'bitpype_form') {
          const leadId = site.lead_id;
          if (!leadId) throw argError('Website has no lead_id');
          forms.ensureTables(db);
          let row = null;
          if (args.formId != null) row = forms.getFormRowById(db, Number(leadId), Number(args.formId));
          if (!row && args.formToken) {
            row = db.prepare(
              'SELECT * FROM contact_forms WHERE lead_id = ? AND public_token = ?'
            ).get(Number(leadId), String(args.formToken));
          }
          if (!row) {
            const list = forms.listFormRows(db, Number(leadId));
            row = (list || [])[0] || null;
          }
          if (!row || !row.public_token) throw argError('No form available');
          db.prepare(
            `UPDATE contact_forms SET published = 1, embed_enabled = 1, updated_at = datetime('now') WHERE id = ?`
          ).run(row.id);
          html = forms.embedBlockHtml(forms.publicForm(row, []), undefined);
          if (intoCell) {
            widget = {
              type: 'form',
              form_token: row.public_token,
              formId: row.id,
              html,
            };
            content = widget;
          } else {
            blockType = 'html';
            content = undefined;
          }
        }

        const result = structure.insertBlockIntoSection(pages, pageIndex, sectionIndex, blockType, {
          cols,
          cellIndex,
          html,
          content,
          widget,
        });
        if (!result.changed) {
          throw argError(result.reason === 'no_sections' ? 'Page has no modular sections'
            : (result.reason || 'Cannot insert that block'));
        }
        const theme = typeof site.theme === 'string'
          ? (() => { try { return JSON.parse(site.theme || '{}'); } catch { return {}; } })()
          : (site.theme || {});
        const version = engine.saveSite(db, siteId, result.pages, theme, `MCP added block ${blockType}`);
        const summary = structure.summarizeStructure(result.pages);
        logActivity('mcp', `website.addBlock site=${siteId} type=${blockType}`);
        const warnings = [];
        const origType = String(args.blockType || args.type || '').trim().toLowerCase();
        if (origType === 'form' || origType === 'bitpype_form' || origType === 'contact_form') {
          try {
            const moduleFit = require('../server/moduleFit');
            const w = moduleFit.formOnAppointmentPageWarning(result.pages, pageIndex);
            if (w) warnings.push(w);
          } catch { /* optional */ }
        }
        return {
          ok: true,
          data: {
            siteId,
            blockType,
            sectionIndex: result.sectionIndex,
            cellIndex: result.cellIndex,
            version: { id: version.id, version_no: version.version_no },
            menu: summary.menu,
            pages: summary.pages,
            warnings,
          },
        };
      },
    },

    'site.screenshots.list': {
      description: 'List registered site preview screenshots by websiteId or leadId.',
      schema: {
        type: 'object',
        properties: {
          websiteId: { type: 'integer', minimum: 1 },
          leadId: { type: 'integer', minimum: 1 },
          currentOnly: { type: 'boolean' },
          checkReady: { type: 'boolean' },
          kind: { type: 'string' },
        },
      },
      async run(args) {
        const shots = require('./siteScreenshots');
        shots.ensureTables(db);
        const websiteId = args.websiteId != null ? requireId(args.websiteId, 'websiteId') : null;
        const leadId = args.leadId != null ? requireId(args.leadId, 'leadId') : null;
        if (!websiteId && !leadId) throw argError('websiteId or leadId is required');
        let rows = shots.listScreenshots(db, {
          websiteId: websiteId || undefined,
          leadId: leadId || undefined,
          currentOnly: args.currentOnly !== false,
          kind: args.kind,
        });
        if (args.checkReady || args.ready) rows = await shots.enrichReady(rows);
        return { ok: true, data: { screenshots: rows } };
      },
    },

    'site.screenshots.capture': {
      description: 'Capture/regenerate live preview screenshots for a website.',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          websiteId: { type: 'integer', minimum: 1 },
          forcePreview: { type: 'boolean' },
          previewUrl: { type: 'string' },
          leadId: { type: 'integer', minimum: 1 },
        },
      },
      async run(args) {
        const shots = require('./siteScreenshots');
        const engine = require('./websiteEngine');
        const siteId = requireId(args.websiteId != null ? args.websiteId : args.id, 'id');
        const site = engine.getWebsite(db, siteId);
        let previewUrl = args.previewUrl || site.preview_url || null;
        if ((!previewUrl || args.forcePreview) && typeof engine.exportStatic === 'function') {
          /* keep stored previewUrl; Electron may only have local export */
        }
        if (!previewUrl) {
          throw argError('Website has no preview URL. Publish a preview first, then capture.');
        }
        const result = await shots.captureWebsiteScreenshots(db, siteId, {
          previewUrl,
          leadId: args.leadId != null ? args.leadId : site.lead_id,
        });
        return { ok: true, data: result };
      },
    },

    'website.versions': {
      description: 'List saved versions for a website.',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          page: { type: 'integer', minimum: 1 },
          pageSize: { type: 'integer', minimum: 1, maximum: 100 },
        },
        required: ['id'],
      },
      run(args) {
        const engine = require('./websiteEngine');
        const { pageArgs, pageResult } = require('./paginate');
        const id = requireId(args.id, 'id');
        engine.getWebsite(db, id);
        const { page, pageSize, offset } = pageArgs(args, { pageSize: 20, maxSize: 100 });
        engine.ensureTables(db);
        const total = db.prepare('SELECT COUNT(*) AS c FROM website_versions WHERE website_id = ?').get(id).c;
        const versions = db.prepare(
          'SELECT id, version_no, note, author, created_at FROM website_versions WHERE website_id = ? ORDER BY version_no DESC LIMIT ? OFFSET ?'
        ).all(id, pageSize, offset);
        return { ok: true, data: Object.assign({ versions }, pageResult(versions, total, page, pageSize)) };
      },
    },

    'website.diff': {
      description: 'Diff two website versions (from/to = version_no or version id).',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          from: { type: 'integer', minimum: 1 },
          to: { type: 'integer', minimum: 1 },
        },
        required: ['id', 'from', 'to'],
      },
      run(args) {
        const domain = require('../server/domain');
        const id = requireId(args.id, 'id');
        return { ok: true, data: domain.sitesDiff(1, id, args) };
      },
    },

    'website.restore': {
      description: 'Restore a website to a prior version_id.',
      schema: {
        type: 'object',
        properties: { versionId: { type: 'integer', minimum: 1 } },
        required: ['versionId'],
      },
      run(args) {
        const engine = require('./websiteEngine');
        const versionId = requireId(args.versionId, 'versionId');
        const site = engine.restoreVersion(db, versionId);
        return { ok: true, data: { id: site.id, name: site.name, status: site.status } };
      },
    },

    'website.forLead': {
      description: 'Find the website row linked to a lead, if any.',
      schema: {
        type: 'object',
        properties: { leadId: { type: 'integer', minimum: 1 } },
        required: ['leadId'],
      },
      run(args) {
        const leadId = requireId(args.leadId, 'leadId');
        const row = db.prepare(
          'SELECT id, lead_id, name, status, origin, updated_at FROM websites WHERE lead_id = ?'
        ).get(leadId);
        return { ok: true, data: { site: row || null } };
      },
    },

    // ----- Outreach / pipeline -----
    'outreach.campaigns': {
      description: 'Campaign admin: list | create | setStatus | cancel | delete | messages. create uses a dual-channel template; pass channel email|sms|both. setStatus: draft|active|paused|done. cancel cannot be resumed; delete removes the campaign.',
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'setStatus', 'cancel', 'delete', 'messages'] },
          id: { type: 'integer', minimum: 1 },
          name: { type: 'string', maxLength: 200 },
          templateId: { type: 'integer', minimum: 1 },
          leadIds: { type: 'array', items: { type: 'integer', minimum: 1 } },
          ratePerHour: { type: 'integer', minimum: 1, maximum: 500 },
          status: { type: 'string', enum: ['draft', 'active', 'paused', 'done', 'cancelled'] },
          channel: { type: 'string', enum: ['email', 'sms', 'both'] },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
        required: ['action'],
      },
      run(args) {
        const outreach = require('./outreach');
        const action = String(args.action || '').trim();
        if (action === 'list') {
          return { ok: true, data: outreach.listCampaigns(db, { pageSize: args.limit || 25 }) };
        }
        if (action === 'create') {
          ensureNotPaused();
          const name = optStr(args.name, 200);
          const templateId = requireId(args.templateId, 'templateId');
          if (!name) throw argError('name is required.');
          if (!Array.isArray(args.leadIds) || !args.leadIds.length) throw argError('leadIds is required.');
          const created = outreach.createCampaign(db, {
            name,
            templateId,
            leadIds: args.leadIds.map((x) => requireId(x, 'leadId')),
            ratePerHour: args.ratePerHour,
            channel: args.channel || 'email',
          });
          return { ok: true, data: created };
        }
        if (action === 'setStatus') {
          const id = requireId(args.id, 'id');
          const status = optStr(args.status, 40);
          if (!status) throw argError('status is required.');
          return { ok: true, data: outreach.setCampaignStatus(db, id, status) };
        }
        if (action === 'cancel') {
          return { ok: true, data: outreach.cancelCampaign(db, requireId(args.id, 'id')) };
        }
        if (action === 'delete') {
          return { ok: true, data: outreach.deleteCampaign(db, requireId(args.id, 'id')) };
        }
        if (action === 'messages') {
          const id = requireId(args.id, 'id');
          return { ok: true, data: outreach.listMessages(db, id, null, { pageSize: args.limit || 50 }) };
        }
        throw argError('Unknown campaigns action.');
      },
    },

    'outreach.templates': {
      description: 'Dual-channel templates: list | save | delete. Holds email subject/body (HTML OK) and sms_body (plain). Placeholders: {{website_link}}, {{business_name}}, {{interested}}, {{uninterested}}.',
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'save', 'delete'] },
          id: { type: 'integer', minimum: 1 },
          name: { type: 'string', maxLength: 200 },
          subject: { type: 'string', maxLength: 500 },
          body: { type: 'string', maxLength: 20000 },
          sms_body: { type: 'string', maxLength: 1600 },
        },
        required: ['action'],
      },
      run(args) {
        const outreach = require('./outreach');
        const action = String(args.action || '').trim();
        if (action === 'list') return { ok: true, data: { templates: outreach.listTemplates(db) } };
        if (action === 'save') {
          const saved = outreach.saveTemplate(db, {
            id: args.id,
            name: args.name,
            subject: args.subject,
            body: args.body,
            sms_body: args.sms_body,
          });
          return { ok: true, data: saved };
        }
        if (action === 'delete') {
          const id = requireId(args.id, 'id');
          return { ok: true, data: outreach.deleteTemplate(db, id) };
        }
        throw argError('Unknown templates action.');
      },
    },

    'email.draft': {
      description: 'AI-draft outreach subject + HTML body + companion sms_body. Optional leadId + prompt. Respects automation pause.',
      schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', maxLength: 4000 },
          leadId: { type: 'integer', minimum: 1 },
          existingSubject: { type: 'string', maxLength: 500 },
          existingBody: { type: 'string', maxLength: 20000 },
        },
      },
      async run(args = {}) {
        ensureNotPaused();
        const { chat, aiConfigured } = require('./ai');
        if (!aiConfigured(db)) throw argError('AI is not configured: set ai.api_key in Settings.');
        const outreach = require('./outreach');
        const email = require('./email');
        const sms = require('./sms');
        outreach.ensureTables(db);
        const promptRow = db.prepare('SELECT body FROM prompts WHERE key = ?').get('write_outreach');
        const systemSeed = (promptRow && promptRow.body)
          || 'Write short outreach. Return JSON: {"subject":"...","body":"...","sms_body":"..."}.';
        const leadId = args.leadId != null ? requireId(args.leadId, 'leadId') : null;
        const fromName = getSetting('smtp.from_name', '') || getSetting('app.name', '') || 'Bitpype';
        let lead = null;
        let websiteLink = '';
        if (leadId) {
          lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
          if (!lead) throw argError('Lead not found');
          websiteLink = outreach.resolveWebsiteLink(db, leadId) || '';
        }
        const fill = (text, vars) => String(text || '').replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, k) => {
          const v = vars[k];
          return v == null ? '' : String(v);
        });
        const vars = {
          sequence_step: '1',
          owner_name: (lead && (lead.owner_name || lead.contact_name)) || 'there',
          business_name: (lead && lead.business_name) || '',
          category: (lead && lead.category) || '',
          city: (lead && lead.city) || '',
          state: (lead && lead.state) || '',
          observation: String(args.prompt || '').trim()
            || (lead ? `Their online presence could use a cleaner website${lead.city ? ` for ${lead.city}` : ''}.` : 'A local business that needs a better website.'),
          preview_url: websiteLink,
          website_link: websiteLink,
          from_name: fromName,
          mail_footer: getSetting('mail.footer', '') || '',
        };
        const system = fill(systemSeed, vars)
          + '\n\nReturn ONLY JSON: {"subject":"...","body":"...","sms_body":"..."}. '
          + 'sms_body must be plain text and include {{website_link}}. Prefer {{interested}}/{{uninterested}} in email body when asking for a response.';
        const userBits = [
          String(args.prompt || '').trim()
            ? `Writer brief: ${String(args.prompt).trim()}`
            : 'Draft a short cold outreach email offering a free website preview.',
          lead ? `Lead: ${lead.business_name || ''} | ${lead.category || ''} | phone=${lead.phone || 'n/a'}` : 'Reusable template (no lead).',
          websiteLink ? `Website URL: ${websiteLink}` : 'Use {{website_link}} placeholder.',
          args.existingSubject ? `Current subject: ${String(args.existingSubject).slice(0, 200)}` : '',
          args.existingBody ? `Current body:\n${String(args.existingBody).slice(0, 2000)}` : '',
        ].filter(Boolean);
        const result = await chat({
          task: 'email',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userBits.join('\n') },
          ],
          maxTokens: 1200,
          leadId: leadId || null,
          note: 'outreach template draft',
          db,
        });
        let subject = '';
        let body = '';
        let smsBody = '';
        const raw = String(result.text || '').trim();
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            subject = String(parsed.subject || '').trim();
            body = String(parsed.body || '').trim();
            smsBody = String(parsed.sms_body || parsed.sms || '').trim();
          } catch { /* fall through */ }
        }
        if (!subject && !body) {
          body = raw;
          subject = lead && lead.business_name ? `Quick idea for ${lead.business_name}` : 'Quick idea for your website';
        }
        if (body && !email.looksLikeHtml(body)) {
          body = body.split(/\n{2,}/).map((block) => `<p>${String(block)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`).join('\n');
        } else if (body) {
          body = email.sanitizeEmailHtml(body);
        }
        smsBody = sms.plainSmsBody(smsBody);
        const linkToken = websiteLink || '{{website_link}}';
        if (!smsBody || (!smsBody.includes(linkToken) && !smsBody.includes('{{website_link}}') && !/https?:\/\//i.test(smsBody))) {
          smsBody = sms.companionSmsDraft({
            businessName: (lead && lead.business_name) || '{{business_name}}',
            websiteLink: linkToken,
            fromName,
          });
        }
        return {
          ok: true,
          data: {
            subject, body, sms_body: smsBody, model: result.model,
            website_link: websiteLink || null, leadId: leadId || null,
            lead_phone: lead && lead.phone ? lead.phone : null,
            has_phone: Boolean(lead && outreach.normalizePhone(lead.phone)),
          },
        };
      },
    },

    'email.uploadAsset': {
      description: 'Upload an image for HTML email templates (base64, max 5MB). Returns a local file URL under email-assets/.',
      schema: {
        type: 'object',
        properties: {
          data: { type: 'string' },
          mimeType: { type: 'string' },
        },
      },
      async run(args = {}) {
        const fs = require('fs');
        const path = require('path');
        const crypto = require('crypto');
        const openPreview = require('./openPreview');
        const dataB64 = String(args.data || args.base64 || '')
          .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
          .replace(/\s+/g, '');
        if (!dataB64) throw argError('data (base64 image) is required');
        const maxB64 = Math.ceil(5 * 1024 * 1024 * 4 / 3) + 256;
        if (dataB64.length > maxB64) throw argError('Image is too large (max 5 MB).');
        let buffer = Buffer.from(dataB64, 'base64');
        if (!buffer.length || buffer.length > 5 * 1024 * 1024) {
          throw argError('Image must be between 1 byte and 5 MB.');
        }
        let ext = 'png';
        const magic = buffer.slice(0, 4).toString('hex');
        if (magic.startsWith('89504e47')) ext = 'png';
        else if (magic.startsWith('ffd8ff')) ext = 'jpg';
        else if (magic.startsWith('47494638')) ext = 'gif';
        else if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') ext = 'webp';
        const name = `em-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
        const dir = path.join(openPreview.exportRoot(), 'email-assets');
        fs.mkdirSync(dir, { recursive: true });
        const abs = path.join(dir, name);
        fs.writeFileSync(abs, buffer);
        return { ok: true, data: { url: abs, name, bytes: buffer.length, path: abs } };
      },
    },

    'sms.queue': {
      description: 'Queue a freeform SMS for a lead (personalizes {{website_link}}). Requires phone. Returns messageId for email.send.',
      schema: {
        type: 'object',
        properties: {
          leadId: { type: 'integer', minimum: 1 },
          body: { type: 'string', maxLength: 1600 },
        },
        required: ['leadId', 'body'],
      },
      run(args) {
        ensureNotPaused();
        const outreach = require('./outreach');
        const email = require('./email');
        const sms = require('./sms');
        outreach.ensureTables(db);
        const leadId = requireId(args.leadId, 'leadId');
        const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
        if (!lead) throw argError('Lead not found');
        const phone = outreach.normalizePhone(lead.phone);
        if (!phone) throw argError(`Lead ${leadId} has no phone number for SMS.`);
        const rawBody = String(args.body || args.sms_body || '');
        if (rawBody.length > 1600) throw argError('SMS body is too long (max 1600 characters).');
        let body = sms.plainSmsBody(rawBody);
        if (!body) throw argError('SMS body is required');
        const fromName = getSetting('smtp.from_name', '') || getSetting('app.name', '');
        const facts = db.prepare('SELECT * FROM business_facts WHERE lead_id = ?').all(leadId);
        const personalized = email.personalize(
          { subject: '(SMS)', body },
          lead, facts,
          outreach.personalizeExtras(db, leadId, fromName, {})
        );
        body = sms.plainSmsBody(personalized.body);
        const websiteLink = outreach.resolveWebsiteLink(db, leadId);
        if (websiteLink && !body.includes(websiteLink) && !/https?:\/\//i.test(body)) {
          body = `${body} ${websiteLink}`.trim().slice(0, 320);
        }
        let campaign = db.prepare("SELECT id FROM campaigns WHERE name = ? AND status = 'draft'").get('Compose SMS');
        if (!campaign) {
          campaign = {
            id: db.prepare('INSERT INTO campaigns (name, template_id, status) VALUES (?, ?, ?)')
              .run('Compose SMS', null, 'draft').lastInsertRowid,
          };
        }
        const r = db.prepare(
          `INSERT INTO campaign_messages
             (campaign_id, lead_id, to_email, subject, body, status, channel, to_phone)
           VALUES (?, ?, ?, '(SMS)', ?, 'queued', 'sms', ?)`
        ).run(Number(campaign.id), leadId, phone, body, phone);
        return {
          ok: true,
          data: {
            messageId: Number(r.lastInsertRowid),
            to: phone,
            to_phone: phone,
            body,
            channel: 'sms',
            queued: true,
            website_link: websiteLink || null,
          },
        };
      },
    },

    'outreach.suppression': {
      description: 'Suppression list: list | add | remove.',
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'remove'] },
          id: { type: 'integer', minimum: 1 },
          email: { type: 'string', maxLength: 200 },
          reason: { type: 'string', maxLength: 200 },
        },
        required: ['action'],
      },
      run(args) {
        const outreach = require('./outreach');
        const action = String(args.action || '').trim();
        if (action === 'list') return { ok: true, data: outreach.listSuppressions(db, {}) };
        if (action === 'add') {
          const email = optStr(args.email, 200);
          if (!email) throw argError('email is required.');
          return { ok: true, data: outreach.addSuppression(db, email, args.reason || 'manual') };
        }
        if (action === 'remove') {
          return { ok: true, data: outreach.removeSuppression(db, requireId(args.id, 'id')) };
        }
        throw argError('Unknown suppression action.');
      },
    },

    'outreach.processQueue': {
      description: 'Process the outbound email queue (same as Process queue in Outreach). Respects pause and caps.',
      schema: { type: 'object', properties: {} },
      async run() {
        ensureNotPaused();
        const outreach = require('./outreach');
        return { ok: true, data: await outreach.processQueue(db) };
      },
    },

    'outreach.stats': {
      description: 'Outreach stats (queued/sent/failed today, etc.).',
      schema: { type: 'object', properties: {} },
      run() {
        const outreach = require('./outreach');
        return { ok: true, data: outreach.getOutreachStats(db) };
      },
    },

    'outreach.pipeline': {
      description: 'Pipeline board columns and lead cards.',
      schema: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 500 } },
      },
      run(args = {}) {
        const outreach = require('./outreach');
        return { ok: true, data: outreach.pipelineBoard(db, { perColumn: args.limit }) };
      },
    },

    'outreach.intent': {
      description: 'Lead intent score: get | record.',
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'record'] },
          leadId: { type: 'integer', minimum: 1 },
          event: { type: 'string', maxLength: 80 },
          note: { type: 'string', maxLength: 2000 },
        },
        required: ['action', 'leadId'],
      },
      run(args) {
        const outreach = require('./outreach');
        const leadId = requireId(args.leadId, 'leadId');
        const action = String(args.action || '').trim();
        if (action === 'get') return { ok: true, data: outreach.getIntent(db, leadId) };
        if (action === 'record') {
          const event = optStr(args.event, 80);
          if (!event) throw argError('event is required for record.');
          return { ok: true, data: outreach.recordIntent(db, leadId, event, args.note) };
        }
        throw argError('Unknown intent action.');
      },
    },

    // ----- Settings / discovery / AI / activity -----
    'settings.get': {
      description: 'Read app settings. Secrets are redacted as "***" when set (same as Settings page).',
      schema: {
        type: 'object',
        properties: {
          keys: { type: 'array', items: { type: 'string' }, description: 'Optional subset of keys' },
        },
      },
      run(args = {}) {
        const { SECRET_KEYS } = require('./ipc/system');
        const rows = db.prepare('SELECT key, value FROM settings').all();
        const out = {};
        const want = Array.isArray(args.keys) && args.keys.length
          ? new Set(args.keys.map(String))
          : null;
        for (const r of rows) {
          if (want && !want.has(r.key)) continue;
          out[r.key] = SECRET_KEYS.includes(r.key) && r.value ? '***' : r.value;
        }
        return { ok: true, data: { settings: out } };
      },
    },

    'settings.set': {
      description: 'Set a non-secret setting key (models, SMTP host, costs, discovery, design agent triggers, etc.). Cannot set api keys â€” use the desktop Settings UI for secrets.',
      schema: {
        type: 'object',
        properties: {
          key: { type: 'string', maxLength: 120 },
          value: { type: 'string', maxLength: 5000 },
        },
        required: ['key', 'value'],
      },
      run(args) {
        const { SETTABLE_KEYS } = require('./ipc/system');
        const key = String(args.key || '').trim();
        if (!SETTABLE_KEYS.includes(key)) {
          throw argError(`"${key}" is not writable via MCP (or is a secret). Use Settings in the app for secrets.`);
        }
        const value = args.value == null ? '' : String(args.value);
        if (value.length > 5000) throw argError('value too long.');
        setSetting(key, value);
        logActivity('settings', `Setting updated via MCP: ${key}`);
        return { ok: true, data: { key, value } };
      },
    },

    'automation.resume': {
      description: 'Resume automation after pause (clear kill switch).',
      schema: { type: 'object', properties: {} },
      run() {
        setSetting('automation_paused', '0');
        logActivity('automation', 'Automation RESUMED via MCP.');
        return { ok: true, data: { paused: false } };
      },
    },

    'ai.usage': {
      description: 'AI spend summary (today / month / recent rows).',
      schema: {
        type: 'object',
        properties: { days: { type: 'integer', minimum: 1, maximum: 90 } },
      },
      run(args = {}) {
        const days = vInt(args.days, { min: 1, max: 90, def: 30 });
        if (isErr(days)) throw argError('days must be 1â€“90.');
        const today = db.prepare(
          `SELECT ROUND(COALESCE(SUM(cost_usd),0),4) AS c FROM ai_usage WHERE date(at) = date('now','localtime')`
        ).get().c;
        const month = db.prepare(
          `SELECT ROUND(COALESCE(SUM(cost_usd),0),4) AS c FROM ai_usage WHERE strftime('%Y-%m', at) = strftime('%Y-%m','now','localtime')`
        ).get().c;
        const recent = db.prepare(
          `SELECT id, task, model, prompt_tokens, completion_tokens, cost_usd, lead_id, note, at
           FROM ai_usage WHERE at >= datetime('now', ?) ORDER BY id DESC LIMIT 100`
        ).all(`-${days} days`);
        return { ok: true, data: { todayUsd: today, monthUsd: month, days, recent } };
      },
    },

    'activity.recent': {
      description: 'Recent activity log entries from the app.',
      schema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          area: { type: 'string', maxLength: 40 },
        },
      },
      run(args = {}) {
        const limit = vInt(args.limit, { min: 1, max: 100, def: 30 });
        if (isErr(limit)) throw argError('limit invalid.');
        let rows;
        if (args.area) {
          rows = db.prepare(
            `SELECT id, area, message, at FROM activity_log WHERE area = ? ORDER BY id DESC LIMIT ?`
          ).all(String(args.area), limit);
        } else {
          rows = db.prepare(
            `SELECT id, area, message, at FROM activity_log ORDER BY id DESC LIMIT ?`
          ).all(limit);
        }
        return { ok: true, data: { activity: rows } };
      },
    },

    'discovery.schedule': {
      description: 'Scheduled lead discovery: get | set | runNow (same as Settings â†’ Discovery).',
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set', 'runNow'] },
          enabled: { type: 'boolean' },
          mode: { type: 'string', enum: ['interval', 'daily'] },
          interval_hours: { type: 'number' },
          daily_time: { type: 'string' },
          provider: { type: 'string' },
          category: { type: 'string' },
          location: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
        required: ['action'],
      },
      async run(args) {
        const sched = require('./discoverySchedule');
        const action = String(args.action || '').trim();
        if (action === 'get') return { ok: true, data: sched.readSchedule(db) };
        if (action === 'set') {
          const patch = {};
          for (const k of ['enabled', 'mode', 'interval_hours', 'daily_time', 'provider', 'category', 'location', 'limit']) {
            if (args[k] !== undefined) patch[k] = args[k];
          }
          return { ok: true, data: sched.writeSchedule(db, patch) };
        }
        if (action === 'runNow') {
          ensureNotPaused();
          return { ok: true, data: await sched.runDiscoveryJob(db, { source: 'mcp' }) };
        }
        throw argError('Unknown discovery action.');
      },
    },

    'cloudflare.publish': {
      description: 'Publish an exported website folder to Cloudflare Pages (needs cf.* settings + token in the app).',
      schema: {
        type: 'object',
        properties: {
          websiteId: { type: 'integer', minimum: 1 },
          dir: { type: 'string', maxLength: 500, description: 'Optional export folder; default exports the site first' },
        },
        required: ['websiteId'],
      },
      async run(args) {
        ensureNotPaused();
        const cf = require('./cloudflare');
        const engine = require('./websiteEngine');
        const path = require('path');
        const openPreview = require('./openPreview');
        const websiteId = requireId(args.websiteId, 'websiteId');
        // Always rematerialize from the latest DB save â€” never trust a caller-supplied
        // dir (that caused publish to ship one version behind after replace/upload).
        const site = engine.getWebsite(db, websiteId);
        const slug = String(site.name || 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'site';
        const dir = path.join(openPreview.exportRoot(), `${slug}-${site.id}`);
        engine.exportStatic(db, websiteId, dir);
        void optStr(args.dir, 500); // accepted for schema compat; ignored
        const result = await cf.publishDirectory(db, { websiteId, dir });
        return { ok: true, data: result };
      },
    },

    'cloudflare.test': {
      description: 'Test Cloudflare API credentials stored in Settings.',
      schema: { type: 'object', properties: {} },
      async run() {
        const cf = require('./cloudflare');
        return { ok: true, data: await cf.testConnection(db) };
      },
    },

    'domains.search': {
      description: 'Search Cloudflare Registrar for domain suggestions.',
      schema: {
        type: 'object',
        properties: {
          q: { type: 'string', maxLength: 200 },
          query: { type: 'string', maxLength: 200 },
          leadId: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
      },
      async run(args) {
        const mod = require('./cfDomains');
        const q = args.q || args.query;
        const result = await mod.searchDomains(db, q, { limit: args.limit });
        if (args.leadId != null) mod.recordSearchIntent(db, args.leadId, q);
        return { ok: true, data: result };
      },
    },
    'domains.check': {
      description: 'Real-time domain availability + pricing.',
      schema: {
        type: 'object',
        properties: {
          domain: { type: 'string' },
          domains: { type: 'array', items: { type: 'string' } },
        },
      },
      async run(args) {
        const mod = require('./cfDomains');
        return { ok: true, data: await mod.checkDomains(db, args.domains || [args.domain]) };
      },
    },
    'domains.register': {
      description: 'Purchase a domain via Cloudflare Registrar.',
      schema: {
        type: 'object',
        properties: {
          domain: { type: 'string' },
          years: { type: 'integer', minimum: 1, maximum: 10 },
          websiteId: { type: 'integer', minimum: 1 },
          leadId: { type: 'integer', minimum: 1 },
        },
        required: ['domain'],
      },
      async run(args) {
        const mod = require('./cfDomains');
        return {
          ok: true,
          data: await mod.registerDomain(db, args.domain || args.domainName, {
            years: args.years,
            websiteId: args.websiteId,
            leadId: args.leadId,
          }),
        };
      },
    },
    'domains.status': {
      description: 'Poll domain registration status.',
      schema: {
        type: 'object',
        properties: { domain: { type: 'string' } },
        required: ['domain'],
      },
      async run(args) {
        const mod = require('./cfDomains');
        return { ok: true, data: await mod.registrationStatus(db, args.domain) };
      },
    },
    'domains.list': {
      description: 'List workspace domain records.',
      schema: {
        type: 'object',
        properties: {
          websiteId: { type: 'integer', minimum: 1 },
          leadId: { type: 'integer', minimum: 1 },
          status: { type: 'string' },
        },
      },
      run(args) {
        const mod = require('./cfDomains');
        mod.ensureTables(db);
        return { ok: true, data: { domains: mod.listLinked(db, args || {}) } };
      },
    },
    'domains.owned': {
      description: 'List domains on the Cloudflare Registrar account.',
      schema: { type: 'object', properties: {} },
      async run() {
        const mod = require('./cfDomains');
        return { ok: true, data: await mod.listOwnedDomains(db) };
      },
    },
    'domains.link': {
      description: 'Link a domain to a website Pages project.',
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
      async run(args) {
        const mod = require('./cfDomains');
        const cf = require('./cloudflare');
        const engine = require('./websiteEngine');
        const path = require('path');
        const os = require('os');
        const websiteId = requireId(args.websiteId, 'websiteId');
        const result = await mod.linkDomainToWebsite(db, {
          domain: args.domain,
          websiteId,
          leadId: args.leadId,
          project: args.project,
          forcePublish: !!args.forcePublish,
          publishFn: async (id, project) => {
            const outDir = path.join(os.tmpdir(), `website-scout-export-${id}-${Date.now()}`);
            const exported = await engine.exportStatic(db, id, outDir);
            const dir = (exported && (exported.dir || exported.path)) || outDir;
            await cf.publishDirectory(db, { websiteId: id, dir, project });
          },
        });
        return { ok: true, data: result };
      },
    },
    'domains.unlink': {
      description: 'Unlink a domain from its website.',
      schema: {
        type: 'object',
        properties: {
          domain: { type: 'string' },
          project: { type: 'string' },
          removeFromPages: { type: 'boolean' },
        },
        required: ['domain'],
      },
      async run(args) {
        const mod = require('./cfDomains');
        return {
          ok: true,
          data: await mod.unlinkDomain(db, {
            domain: args.domain,
            project: args.project,
            removeFromPages: args.removeFromPages !== false,
          }),
        };
      },
    },

    'prompts.list': {
      description: 'List AI prompt library keys/names/bodies (Settings â†’ Prompts).',
      schema: { type: 'object', properties: {} },
      run() {
        const rows = db.prepare('SELECT key, name, body, updated_at FROM prompts ORDER BY key').all();
        return { ok: true, data: { prompts: rows } };
      },
    },

    'prompts.save': {
      description: 'Save a prompt body by key.',
      schema: {
        type: 'object',
        properties: {
          key: { type: 'string', maxLength: 80 },
          body: { type: 'string', maxLength: 100000 },
        },
        required: ['key', 'body'],
      },
      run(args) {
        const key = optStr(args.key, 80);
        const body = vStr(args.body, { max: 100000, def: '' });
        if (!key) throw argError('key is required.');
        if (isErr(body)) throw argError('body too long.');
        const info = db.prepare(
          `UPDATE prompts SET body = ?, updated_at = datetime('now') WHERE key = ?`
        ).run(String(body), key);
        if (!info.changes) throw argError(`Unknown prompt key: ${key}`);
        logActivity('prompts', `Prompt saved via MCP: ${key}`);
        return { ok: true, data: { key } };
      },
    },

    'forms.list': {
      description: 'List custom BitPype forms for a lead. Returns form records + managed embed snippets. Prefer contact_form / forms.create over raw HTML <form>.',
      schema: {
        type: 'object',
        properties: {
          leadId: { type: 'integer', minimum: 1 },
          websiteId: { type: 'integer', minimum: 1 },
        },
      },
      run(args = {}) {
        const forms = require('../server/contactForms');
        forms.ensureTables(db);
        let leadId = args.leadId != null ? requireId(args.leadId, 'leadId') : null;
        if (!leadId && args.websiteId != null) {
          const site = db.prepare('SELECT lead_id FROM websites WHERE id = ?')
            .get(requireId(args.websiteId, 'websiteId'));
          if (!site) throw argError('Website not found');
          leadId = Number(site.lead_id);
        }
        if (!leadId) throw argError('leadId or websiteId is required');
        const list = forms.listFormsForLead(db, leadId);
        return {
          ok: true,
          data: {
            leadId,
            forms: list.map((form) => ({ form, embed: forms.embedSnippet(form) })),
          },
        };
      },
    },

    'forms.get': {
      description: 'Get one custom form by formId (or first for lead) plus managed embed snippet.',
      schema: {
        type: 'object',
        properties: {
          leadId: { type: 'integer', minimum: 1 },
          formId: { type: 'integer', minimum: 1 },
          id: { type: 'integer', minimum: 1 },
        },
        required: ['leadId'],
      },
      run(args) {
        const forms = require('../server/contactForms');
        const leadId = requireId(args.leadId, 'leadId');
        const formId = args.formId != null ? requireId(args.formId, 'formId')
          : (args.id != null ? requireId(args.id, 'id') : null);
        const form = formId != null
          ? forms.getFormById(db, leadId, formId)
          : forms.getFormForLead(db, leadId);
        return { ok: true, data: { leadId, form, embed: forms.embedSnippet(form) } };
      },
    },

    'forms.create': {
      description: 'Create + publish a custom form. Pass purpose (appointment_request|quote_request|callback_request|event_rsvp|general_inquiry) to auto-generate typed fields from lead data. Appointments with availability → bookings module, not a form. Returns formId + embed.',
      schema: {
        type: 'object',
        properties: {
          leadId: { type: 'integer', minimum: 1 },
          name: { type: 'string' },
          title: { type: 'string' },
          purpose: {
            type: 'string',
            enum: ['appointment_request', 'quote_request', 'callback_request', 'event_rsvp', 'general_inquiry'],
          },
          fields: { type: 'array', items: { type: 'object' } },
          submit_label: { type: 'string' },
          success_message: { type: 'string' },
          notify_email: { type: 'string' },
          target_page_slug: { type: 'string' },
          embed_enabled: { type: 'boolean' },
          embed_on_page: { type: 'boolean' },
          add_to_nav: { type: 'boolean' },
          nav_visible: { type: 'boolean' },
        },
        required: ['leadId'],
      },
      run(args) {
        const forms = require('../server/contactForms');
        const leadId = requireId(args.leadId, 'leadId');
        const purpose = forms.normalizePurpose(args.purpose);
        const hasName = !!(args.name && String(args.name).trim()) || !!(args.title && String(args.title).trim());
        if (!hasName && !purpose) throw argError('name or purpose is required');
        const fields = Array.isArray(args.fields)
          ? args.fields.map((f, i) => forms.normalizeFieldInput(f, i))
          : undefined;
        const created = forms.createForm(db, leadId, {
          name: args.name,
          title: args.title || args.name,
          intro: args.intro,
          purpose: purpose || undefined,
          submit_label: args.submit_label || args.submitLabel,
          success_message: args.success_message || args.successMessage,
          notify_email: args.notify_email || args.notifyEmail,
          fields,
          target_page_slug: args.target_page_slug || args.targetPageSlug,
          embed_enabled: args.embed_enabled != null ? args.embed_enabled : args.embed_on_page,
          add_to_nav: args.add_to_nav != null ? args.add_to_nav : args.nav_visible,
        });
        const published = forms.publishForm(db, leadId, created.id, {
          workspaceId: 1,
          embed_enabled: args.embed_enabled != null ? args.embed_enabled
            : (args.embed_on_page != null ? args.embed_on_page : true),
          toSite: false,
        });
        logActivity('mcp', `forms.create lead=${leadId} form=${published.id}`);
        const warnings = [];
        try {
          const moduleFit = require('../server/moduleFit');
          const site = db.prepare(
            'SELECT pages FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
          ).get(leadId);
          const pages = site ? JSON.parse(site.pages || '[]') : [];
          const w = moduleFit.formOnAppointmentPageWarning(
            pages,
            published.target_page_slug || args.target_page_slug || args.targetPageSlug
          );
          if (w) warnings.push(w);
        } catch { /* optional */ }
        return {
          ok: true,
          data: {
            leadId,
            form: published,
            formId: published.id,
            purpose: purpose || null,
            embed: forms.embedSnippet(published),
            warnings,
            sectionHint: {
              type: 'bitpype_form',
              content: { formId: published.id, form_token: published.public_token },
            },
          },
        };
      },
    },

    'forms.suggestFields': {
      description: 'Preview purpose-built typed fields for a lead without creating a form. purpose: appointment_request|quote_request|callback_request|event_rsvp|general_inquiry.',
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
      run(args) {
        const forms = require('../server/contactForms');
        const leadId = requireId(args.leadId, 'leadId');
        const purpose = forms.normalizePurpose(args.purpose);
        if (!purpose) throw argError(`purpose required (${forms.FORM_PURPOSES.join('|')})`);
        const suggested = forms.suggestFieldsForPurpose(db, leadId, purpose);
        return { ok: true, data: { leadId, ...suggested } };
      },
    },

    'forms.update': {
      description: 'Update a custom form (name, fields, labels, notify email, embed_enabled, add_to_nav).',
      schema: {
        type: 'object',
        properties: {
          leadId: { type: 'integer', minimum: 1 },
          formId: { type: 'integer', minimum: 1 },
          name: { type: 'string' },
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
      run(args) {
        const forms = require('../server/contactForms');
        const leadId = requireId(args.leadId, 'leadId');
        const formId = requireId(args.formId, 'formId');
        const patch = Object.assign({}, args);
        delete patch.leadId;
        delete patch.formId;
        if (Array.isArray(args.fields)) {
          patch.fields = args.fields.map((f, i) => forms.normalizeFieldInput(f, i));
        }
        const form = forms.saveForm(db, leadId, formId, patch);
        return { ok: true, data: { leadId, form, embed: forms.embedSnippet(form) } };
      },
    },

    'forms.delete': {
      description: 'Delete a custom form (keeps at least one per lead).',
      schema: {
        type: 'object',
        properties: {
          leadId: { type: 'integer', minimum: 1 },
          formId: { type: 'integer', minimum: 1 },
        },
        required: ['leadId', 'formId'],
      },
      run(args) {
        const forms = require('../server/contactForms');
        const leadId = requireId(args.leadId, 'leadId');
        const formId = requireId(args.formId, 'formId');
        return { ok: true, data: forms.deleteForm(db, leadId, formId) };
      },
    },

    // ----- Bookings (parity with server/mcp.js HTTP MCP) -----
    'bookings.services': {
      description: 'List bookable services (duration, buffer, price). includeDrafts defaults true. Required: leadId.',
      schema: {
        type: 'object',
        properties: {
          leadId: { type: 'integer', minimum: 1 },
          includeDrafts: { type: 'boolean' },
        },
        required: ['leadId'],
      },
      run(args) {
        const modules = require('../server/siteModules');
        const leadId = requireId(args.leadId, 'leadId');
        modules.ensureTables(db);
        return {
          ok: true,
          data: {
            services: modules.listBookingServices(db, leadId, {
              includeDrafts: args.includeDrafts !== false,
            }),
          },
        };
      },
    },

    'bookings.createService': {
      description: 'Create a bookable service. Default status draft — set status:"published" before bookings.slots. Required: leadId, name. E2E: create → publish → setHours → slots.',
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
      run(args) {
        const modules = require('../server/siteModules');
        const leadId = requireId(args.leadId, 'leadId');
        if (!args.name || !String(args.name).trim()) throw argError('name is required');
        modules.ensureTables(db);
        const service = modules.createBookingService(db, leadId, args);
        logActivity('mcp', `bookings.createService lead=${leadId} id=${service && service.id}`);
        return { ok: true, data: { service } };
      },
    },

    'bookings.updateService': {
      description: 'Update a bookable service by id. Use status:"published" to expose in slots/widget. Required: id, leadId.',
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
      run(args) {
        const modules = require('../server/siteModules');
        const leadId = requireId(args.leadId, 'leadId');
        const id = requireId(args.id, 'id');
        modules.ensureTables(db);
        return { ok: true, data: { service: modules.updateBookingService(db, leadId, id, args) } };
      },
    },

    'bookings.deleteService': {
      description: 'Delete a bookable service by id. Required: id, leadId.',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          leadId: { type: 'integer', minimum: 1 },
        },
        required: ['id', 'leadId'],
      },
      run(args) {
        const modules = require('../server/siteModules');
        const leadId = requireId(args.leadId, 'leadId');
        const id = requireId(args.id, 'id');
        modules.ensureTables(db);
        return { ok: true, data: modules.deleteBookingService(db, leadId, id) };
      },
    },

    'bookings.getHours': {
      description: 'List weekly availability hours and booking settings. Required: leadId.',
      schema: {
        type: 'object',
        properties: { leadId: { type: 'integer', minimum: 1 } },
        required: ['leadId'],
      },
      run(args) {
        const modules = require('../server/siteModules');
        const leadId = requireId(args.leadId, 'leadId');
        modules.ensureTables(db);
        modules.ensureDefaultBookingHours(db, leadId);
        return {
          ok: true,
          data: {
            hours: modules.listBookingHours(db, leadId),
            settings: modules.getBookingSettings(db, leadId),
          },
        };
      },
    },

    'bookings.setHours': {
      description: 'Replace weekly availability hours (weekday 0=Sun..6=Sat, start_time/end_time HH:MM). Required: leadId, hours.',
      schema: {
        type: 'object',
        properties: {
          leadId: { type: 'integer', minimum: 1 },
          hours: { type: 'array', items: { type: 'object' } },
        },
        required: ['leadId', 'hours'],
      },
      run(args) {
        const modules = require('../server/siteModules');
        const leadId = requireId(args.leadId, 'leadId');
        if (!Array.isArray(args.hours)) throw argError('hours is required');
        modules.ensureTables(db);
        return { ok: true, data: { hours: modules.setBookingHours(db, leadId, args.hours) } };
      },
    },

    'bookings.setSettings': {
      description: 'Update booking settings (timezone, slot_interval_minutes, min_notice_hours, max_days_ahead, auto_confirm). Required: leadId.',
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
      run(args) {
        const modules = require('../server/siteModules');
        const leadId = requireId(args.leadId, 'leadId');
        modules.ensureTables(db);
        return {
          ok: true,
          data: { settings: modules.updateBookingSettings(db, leadId, args) },
        };
      },
    },

    'bookings.list': {
      description: 'List appointments (pending/confirmed/cancelled/completed). Default excludes archived. Required: leadId.',
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
      run(args) {
        const modules = require('../server/siteModules');
        const leadId = requireId(args.leadId, 'leadId');
        modules.ensureTables(db);
        return {
          ok: true,
          data: {
            appointments: modules.listAppointments(db, leadId, {
              status: args.status,
              from: args.from,
              to: args.to,
              limit: args.limit,
              includeArchived: args.includeArchived,
              archivedOnly: args.archivedOnly,
            }),
          },
        };
      },
    },

    'bookings.updateStatus': {
      description: 'Update appointment status (pending|confirmed|cancelled|completed) and/or archive (archived true/false; completed/cancelled only). Required: id, leadId; status or archived.',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          leadId: { type: 'integer', minimum: 1 },
          status: {
            type: 'string',
            enum: ['pending', 'confirmed', 'cancelled', 'completed'],
          },
          archived: { type: 'boolean' },
        },
        required: ['id', 'leadId'],
      },
      run(args) {
        const modules = require('../server/siteModules');
        const leadId = requireId(args.leadId, 'leadId');
        const id = requireId(args.id, 'id');
        if (args.status == null && args.archived == null) {
          throw argError('status or archived is required');
        }
        modules.ensureTables(db);
        let appointment = null;
        if (args.status != null) {
          appointment = modules.updateAppointmentStatus(db, leadId, id, args.status);
        }
        if (args.archived != null) {
          appointment = modules.setAppointmentArchived(db, leadId, id, args.archived);
        }
        return {
          ok: true,
          data: { appointment },
        };
      },
    },

    'bookings.slots': {
      description: 'List available time slots for date (YYYY-MM-DD) + published serviceId. Required: leadId, date. Pass serviceId when multiple services exist.',
      schema: {
        type: 'object',
        properties: {
          leadId: { type: 'integer', minimum: 1 },
          date: { type: 'string' },
          serviceId: { type: 'integer', minimum: 1 },
          service_id: { type: 'integer', minimum: 1 },
          serviceSlug: { type: 'string' },
        },
        required: ['leadId', 'date'],
      },
      run(args) {
        const modules = require('../server/siteModules');
        const leadId = requireId(args.leadId, 'leadId');
        if (!args.date || !String(args.date).trim()) throw argError('date is required');
        modules.ensureTables(db);
        const result = modules.listAvailableSlots(db, leadId, {
          date: args.date,
          serviceId: args.serviceId != null ? args.serviceId : args.service_id,
          serviceSlug: args.serviceSlug || args.service,
        });
        return { ok: true, data: result };
      },
    },
  };
}

function getParityCatalogEntries() {
  const stub = {
    db: null,
    vStr: () => '',
    vInt: () => 0,
    requireId: () => 1,
    isErr: () => false,
    argError: (m) => new Error(m),
    ensureNotPaused: () => {},
    leadSummary: (x) => x,
    mcpSafeJob: (x) => x,
    logActivity: () => {},
    getSetting: () => '',
    setSetting: () => {},
    runLeadEngine: (fn) => fn(),
  };
  const tools = createParityTools(stub);
  return Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description,
    schema: t.schema,
  }));
}

module.exports = { createParityTools, getParityCatalogEntries };
