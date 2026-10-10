'use strict';

/**
 * Extra MCP tools for desktop-app parity (leads admin, design job admin,
 * websites, outreach, settings, discovery, cloudflare).
 *
 * Wired from mcp.js — keep schemas mirrored in mcpCatalog.js.
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
  } = ctx;

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
          if (isErr(limit) || limit == null) throw argError('limit must be 1–50.');
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
      description: 'Import leads from CSV text (same parser as the Leads page). Max 1 MB.',
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
          instructions: { type: 'string', maxLength: 8000 },
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
      description: 'Queue a client email of a non-website delivery (social/logo/etc.). Same as Email delivery in the app.',
      schema: {
        type: 'object',
        properties: {
          jobId: { type: 'integer', minimum: 1 },
          id: { type: 'integer', minimum: 1 },
        },
      },
      run(args) {
        const design = require('./designJobs');
        const id = requireId(args.jobId != null ? args.jobId : args.id, 'jobId');
        return { ok: true, data: design.emailDelivery(db, id) };
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
      description: 'Get one website row (pages/theme JSON). Prefer design.get for agent design jobs.',
      schema: {
        type: 'object',
        properties: { id: { type: 'integer', minimum: 1 } },
        required: ['id'],
      },
      run(args) {
        const engine = require('./websiteEngine');
        const id = requireId(args.id, 'id');
        const site = engine.getWebsite(db, id);
        return {
          ok: true,
          data: {
            site: {
              id: site.id,
              lead_id: site.lead_id,
              name: site.name,
              industry: site.industry,
              status: site.status,
              origin: site.origin,
              pages: typeof site.pages === 'string' ? JSON.parse(site.pages) : site.pages,
              theme: typeof site.theme === 'string' ? JSON.parse(site.theme) : site.theme,
              updated_at: site.updated_at,
            },
          },
        };
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
      description: 'Run automated QA on a website id.',
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
      description: 'Attach Pexels photos to a websites-table site (not a design job — use design.images for jobs).',
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
        const total = db.prepare('SELECT COUNT(*) AS c FROM website_versions WHERE website_id = ?').get(id).c;
        const versions = db.prepare(
          'SELECT id, version_no, note, created_at FROM website_versions WHERE website_id = ? ORDER BY version_no DESC LIMIT ? OFFSET ?'
        ).all(id, pageSize, offset);
        return { ok: true, data: Object.assign({ versions }, pageResult(versions, total, page, pageSize)) };
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
      description: 'Campaign admin: list | create | setStatus | messages.',
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'setStatus', 'messages'] },
          id: { type: 'integer', minimum: 1 },
          name: { type: 'string', maxLength: 200 },
          templateId: { type: 'integer', minimum: 1 },
          leadIds: { type: 'array', items: { type: 'integer', minimum: 1 } },
          ratePerHour: { type: 'integer', minimum: 1, maximum: 500 },
          status: { type: 'string', maxLength: 40 },
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
          });
          return { ok: true, data: created };
        }
        if (action === 'setStatus') {
          const id = requireId(args.id, 'id');
          const status = optStr(args.status, 40);
          if (!status) throw argError('status is required.');
          return { ok: true, data: outreach.setCampaignStatus(db, id, status) };
        }
        if (action === 'messages') {
          const id = requireId(args.id, 'id');
          return { ok: true, data: outreach.listMessages(db, id, null, { pageSize: args.limit || 50 }) };
        }
        throw argError('Unknown campaigns action.');
      },
    },

    'outreach.templates': {
      description: 'Email template admin: list | save | delete.',
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'save', 'delete'] },
          id: { type: 'integer', minimum: 1 },
          name: { type: 'string', maxLength: 200 },
          subject: { type: 'string', maxLength: 500 },
          body: { type: 'string', maxLength: 20000 },
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
      description: 'Set a non-secret setting key (models, SMTP host, costs, discovery, design agent triggers, etc.). Cannot set api keys — use the desktop Settings UI for secrets.',
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
        if (isErr(days)) throw argError('days must be 1–90.');
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
      description: 'Scheduled lead discovery: get | set | runNow (same as Settings → Discovery).',
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
        const os = require('os');
        const websiteId = requireId(args.websiteId, 'websiteId');
        let dir = optStr(args.dir, 500);
        if (!dir) {
          const site = engine.getWebsite(db, websiteId);
          const slug = String(site.name || 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'site';
          dir = path.join(os.homedir(), 'website-scout-exports', `${slug}-${site.id}`);
          engine.exportStatic(db, websiteId, dir);
        }
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

    'prompts.list': {
      description: 'List AI prompt library keys/names/bodies (Settings → Prompts).',
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
