'use strict';

/**
 * Full product API — mirrors Electron app features (not Electron shell).
 */

const express = require('express');
const domain = require('../domain');
const { requireWorkspace, requireRole } = require('../middleware');

const router = express.Router();
router.use(requireWorkspace);

function ok(res, data) { res.json({ ok: true, data }); }
function fail(res, e, status = 400) {
  const code = e.code || e.status || status;
  const http = typeof code === 'number' ? code : (e.message === 'NOT_FOUND' ? 404 : status);
  res.status(http >= 400 && http < 600 ? http : 400).json({ ok: false, error: e.message || String(e), code: e.code });
}

// Dashboard
router.get('/dashboard/stats', (req, res) => {
  try {
    const stats = domain.dashboardStats(req.auth.workspaceId);
    ok(res, {
      ...stats,
      workspace: {
        id: req.auth.workspaceId,
        name: req.auth.workspace.name,
        slug: req.auth.workspace.slug,
        role: req.auth.role,
      },
    });
  } catch (e) { fail(res, e, 500); }
});

// Leads
router.get('/leads', (req, res) => { try { ok(res, domain.leadsList(req.auth.workspaceId, req.query)); } catch (e) { fail(res, e); } });
router.get('/leads/facets', (req, res) => { try { ok(res, { facets: domain.leadsFacets(req.auth.workspaceId) }); } catch (e) { fail(res, e); } });
router.get('/leads/:id', (req, res) => {
  try {
    const data = domain.leadsGet(req.auth.workspaceId, Number(req.params.id));
    if (!data) return fail(res, Object.assign(new Error('NOT_FOUND'), { code: 404 }), 404);
    ok(res, data);
  } catch (e) { fail(res, e); }
});
router.post('/leads', (req, res) => { try { ok(res, { lead: domain.leadsCreate(req.auth.workspaceId, req.body || {}) }); } catch (e) { fail(res, e); } });
router.patch('/leads/:id', (req, res) => { try { ok(res, { lead: domain.leadsUpdate(req.auth.workspaceId, Number(req.params.id), req.body || {}) }); } catch (e) { fail(res, e); } });
router.delete('/leads/:id', (req, res) => { try { domain.leadsDelete(req.auth.workspaceId, Number(req.params.id)); ok(res, { id: Number(req.params.id) }); } catch (e) { fail(res, e); } });
router.post('/leads/:id/score', (req, res) => { try { ok(res, domain.leadsScore(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e); } });
router.post('/leads/:id/qualify', (req, res) => { try { ok(res, { lead: domain.leadsQualify(req.auth.workspaceId, Number(req.params.id), req.body && req.body.note) }); } catch (e) { fail(res, e); } });
router.post('/leads/:id/research', async (req, res) => { try { ok(res, await domain.leadsResearch(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e, 500); } });
router.get('/leads/:id/duplicates', (req, res) => { try { ok(res, { duplicates: domain.leadsDuplicates(req.auth.workspaceId, Number(req.params.id)) }); } catch (e) { fail(res, e); } });
router.post('/leads/merge', (req, res) => { try { ok(res, { lead: domain.leadsMerge(req.auth.workspaceId, req.body.keepId, req.body.dropIds) }); } catch (e) { fail(res, e); } });
router.post('/leads/import', (req, res) => { try { ok(res, domain.leadsImportCsv(req.auth.workspaceId, req.body.text, req.body)); } catch (e) { fail(res, e); } });
router.post('/leads/bulk', async (req, res) => { try { ok(res, { bulk: await domain.leadsBulk(req.auth.workspaceId, req.body || {}) }); } catch (e) { fail(res, e); } });
router.post('/leads/discover', async (req, res) => { try { ok(res, await domain.leadsDiscover(req.auth.workspaceId, req.body || {})); } catch (e) { fail(res, e, 500); } });

// Providers / discovery schedule
router.get('/providers', (req, res) => { try { ok(res, { providers: domain.providersList(req.auth.workspaceId) }); } catch (e) { fail(res, e); } });
router.post('/providers/search', async (req, res) => { try { ok(res, await domain.providersSearch(req.auth.workspaceId, req.body || {})); } catch (e) { fail(res, e, 500); } });
router.get('/discovery/schedule', (req, res) => { try { ok(res, domain.discoveryGet(req.auth.workspaceId)); } catch (e) { fail(res, e); } });
router.put('/discovery/schedule', requireRole('owner', 'admin'), (req, res) => { try { ok(res, { schedule: domain.discoverySet(req.auth.workspaceId, req.body || {}) }); } catch (e) { fail(res, e); } });
router.post('/discovery/run', requireRole('owner', 'admin', 'member'), async (req, res) => { try { ok(res, await domain.discoveryRunNow(req.auth.workspaceId)); } catch (e) { fail(res, e, 500); } });

// Design
router.get('/design/pending', (req, res) => { try { ok(res, domain.designPending(req.auth.workspaceId)); } catch (e) { fail(res, e); } });
router.get('/design', (req, res) => { try { ok(res, { jobs: domain.designList(req.auth.workspaceId, req.query) }); } catch (e) { fail(res, e); } });
router.get('/design/:id', (req, res) => { try { ok(res, { job: domain.designGet(req.auth.workspaceId, Number(req.params.id)) }); } catch (e) { fail(res, e); } });
router.post('/design', (req, res) => { try { ok(res, { job: domain.designCreate(req.auth.workspaceId, req.body || {}) }); } catch (e) { fail(res, e); } });
router.patch('/design/:id', (req, res) => { try { ok(res, { job: domain.designUpdate(req.auth.workspaceId, Number(req.params.id), req.body || {}) }); } catch (e) { fail(res, e); } });
router.delete('/design/:id', (req, res) => { try { ok(res, domain.designDelete(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e); } });
router.post('/design/next', (req, res) => { try { ok(res, { job: domain.designNext(req.auth.workspaceId) }); } catch (e) { fail(res, e); } });
router.post('/design/:id/deliver', (req, res) => {
  try {
    const b = req.body || {};
    ok(res, { job: domain.designDeliver(req.auth.workspaceId, Number(req.params.id), b.payload, b.claims, b) });
  } catch (e) { fail(res, e); }
});
router.post('/design/:id/ask', (req, res) => { try { ok(res, domain.designAsk(req.auth.workspaceId, Number(req.params.id), req.body.question)); } catch (e) { fail(res, e); } });
router.post('/design/answer', (req, res) => { try { ok(res, { job: domain.designAnswer(req.auth.workspaceId, req.body.questionId || req.body.id, req.body.answer, req.body.fromEmail) }); } catch (e) { fail(res, e); } });
router.post('/design/:id/review', async (req, res) => { try { ok(res, await domain.designReview(req.auth.workspaceId, Number(req.params.id), req.body || {})); } catch (e) { fail(res, e, 500); } });
router.post('/design/:id/redesign', async (req, res) => { try { ok(res, await domain.designRedesign(req.auth.workspaceId, Number(req.params.id), req.body || {})); } catch (e) { fail(res, e, 500); } });
router.post('/design/:id/improve', async (req, res) => { try { ok(res, await domain.designImprove(req.auth.workspaceId, Number(req.params.id), req.body || {})); } catch (e) { fail(res, e, 500); } });
router.post('/design/:id/preview', async (req, res) => { try { ok(res, await domain.designPreviewUrl(req.auth.workspaceId, Number(req.params.id), !!(req.body && req.body.open))); } catch (e) { fail(res, e, 500); } });
router.post('/design/:id/images', async (req, res) => { try { ok(res, await domain.designAddImages(req.auth.workspaceId, Number(req.params.id), req.body || {})); } catch (e) { fail(res, e, 500); } });
router.post('/design/:id/generate-images', async (req, res) => { try { ok(res, await domain.designGenerateImages(req.auth.workspaceId, Number(req.params.id), req.body || {})); } catch (e) { fail(res, e, 500); } });

// Websites
router.get('/websites', (req, res) => { try { ok(res, domain.sitesList(req.auth.workspaceId, req.query)); } catch (e) { fail(res, e); } });
router.get('/websites/:id', (req, res) => { try { ok(res, { site: domain.sitesGet(req.auth.workspaceId, Number(req.params.id)) }); } catch (e) { fail(res, e); } });
router.post('/websites/generate', async (req, res) => { try { ok(res, await domain.sitesGenerate(req.auth.workspaceId, Number(req.body.leadId), req.body || {})); } catch (e) { fail(res, e, 500); } });
router.post('/websites/:id/qa', async (req, res) => { try { ok(res, await domain.sitesQa(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e, 500); } });
router.post('/websites/:id/export', (req, res) => { try { ok(res, domain.sitesExport(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e); } });
router.post('/websites/:id/images', async (req, res) => { try { ok(res, await domain.sitesAddImages(req.auth.workspaceId, Number(req.params.id), req.body || {})); } catch (e) { fail(res, e, 500); } });
router.get('/websites/:id/versions', (req, res) => { try { ok(res, domain.sitesVersions(req.auth.workspaceId, Number(req.params.id), req.query)); } catch (e) { fail(res, e); } });
router.post('/websites/restore', (req, res) => { try { ok(res, { site: domain.sitesRestore(req.auth.workspaceId, Number(req.body.versionId)) }); } catch (e) { fail(res, e); } });

// Outreach
router.get('/campaigns', (req, res) => { try { ok(res, domain.campaignsList(req.auth.workspaceId, req.query)); } catch (e) { fail(res, e); } });
router.post('/campaigns', (req, res) => { try { ok(res, domain.campaignsCreate(req.auth.workspaceId, req.body || {})); } catch (e) { fail(res, e); } });
router.post('/campaigns/:id/status', (req, res) => { try { ok(res, domain.campaignsSetStatus(req.auth.workspaceId, Number(req.params.id), req.body.status)); } catch (e) { fail(res, e); } });
router.get('/campaigns/:id/messages', (req, res) => { try { ok(res, domain.campaignsMessages(req.auth.workspaceId, Number(req.params.id), req.query)); } catch (e) { fail(res, e); } });
router.get('/templates', (req, res) => { try { ok(res, { templates: domain.templatesList(req.auth.workspaceId) }); } catch (e) { fail(res, e); } });
router.post('/templates', (req, res) => { try { ok(res, domain.templatesSave(req.auth.workspaceId, req.body || {})); } catch (e) { fail(res, e); } });
router.delete('/templates/:id', (req, res) => { try { ok(res, domain.templatesDelete(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e); } });
router.post('/outreach/process', async (req, res) => { try { ok(res, await domain.outreachProcessQueue(req.auth.workspaceId)); } catch (e) { fail(res, e, 500); } });
router.get('/outreach/stats', (req, res) => { try { ok(res, domain.outreachStats(req.auth.workspaceId)); } catch (e) { fail(res, e); } });
router.get('/suppression', (req, res) => { try { ok(res, domain.suppressionList(req.auth.workspaceId, req.query)); } catch (e) { fail(res, e); } });
router.post('/suppression', (req, res) => { try { ok(res, domain.suppressionAdd(req.auth.workspaceId, req.body.email, req.body.reason)); } catch (e) { fail(res, e); } });
router.delete('/suppression/:id', (req, res) => { try { ok(res, domain.suppressionRemove(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e); } });
router.get('/pipeline', (req, res) => { try { ok(res, domain.pipelineBoard(req.auth.workspaceId, req.query)); } catch (e) { fail(res, e); } });
router.get('/intent/:leadId', (req, res) => { try { ok(res, domain.intentGet(req.auth.workspaceId, Number(req.params.leadId))); } catch (e) { fail(res, e); } });
router.post('/intent/:leadId', (req, res) => { try { ok(res, domain.intentRecord(req.auth.workspaceId, Number(req.params.leadId), req.body.event, req.body.note)); } catch (e) { fail(res, e); } });
router.post('/email/compose', (req, res) => { try { ok(res, domain.emailCompose(req.auth.workspaceId, req.body.leadId, req.body.templateId)); } catch (e) { fail(res, e); } });

// Settings (workspace SQLite — same keys as desktop)
router.get('/settings', (req, res) => { try { ok(res, { settings: domain.settingsGetAll(req.auth.workspaceId) }); } catch (e) { fail(res, e); } });
router.put('/settings', requireRole('owner', 'admin'), (req, res) => { try { ok(res, domain.settingsSet(req.auth.workspaceId, req.body.key, req.body.value)); } catch (e) { fail(res, e); } });
router.put('/settings/secret', requireRole('owner', 'admin'), (req, res) => { try { ok(res, domain.settingsSetSecret(req.auth.workspaceId, req.body.key, req.body.value)); } catch (e) { fail(res, e); } });
router.post('/settings/automation', requireRole('owner', 'admin'), (req, res) => { try { ok(res, domain.automationSet(req.auth.workspaceId, !!(req.body && req.body.paused))); } catch (e) { fail(res, e); } });
router.get('/prompts', (req, res) => { try { ok(res, { prompts: domain.promptsList(req.auth.workspaceId) }); } catch (e) { fail(res, e); } });
router.put('/prompts/:key', requireRole('owner', 'admin'), (req, res) => { try { ok(res, domain.promptsSave(req.auth.workspaceId, req.params.key, req.body.body)); } catch (e) { fail(res, e); } });
router.get('/ai/usage', (req, res) => { try { ok(res, domain.aiUsage(req.auth.workspaceId, Number(req.query.days) || 30)); } catch (e) { fail(res, e); } });
router.get('/ai/status', (req, res) => { try { ok(res, domain.aiStatus(req.auth.workspaceId)); } catch (e) { fail(res, e); } });

// Cloudflare
router.get('/cloudflare', (req, res) => { try { ok(res, domain.cfGetConfig(req.auth.workspaceId)); } catch (e) { fail(res, e); } });
router.put('/cloudflare', requireRole('owner', 'admin'), (req, res) => { try { ok(res, domain.cfSaveConfig(req.auth.workspaceId, req.body || {})); } catch (e) { fail(res, e); } });
router.post('/cloudflare/test', async (req, res) => { try { ok(res, await domain.cfTest(req.auth.workspaceId)); } catch (e) { fail(res, e, 500); } });
router.post('/cloudflare/publish', async (req, res) => { try { ok(res, await domain.cfPublish(req.auth.workspaceId, Number(req.body.websiteId), req.body.dir)); } catch (e) { fail(res, e, 500); } });

module.exports = router;
