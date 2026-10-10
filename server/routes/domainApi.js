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
router.post('/leads/:id/facts', (req, res) => { try { ok(res, { fact: domain.leadsAddFact(req.auth.workspaceId, Number(req.params.id), req.body || {}) }); } catch (e) { fail(res, e); } });
router.get('/leads/:id/timeline', (req, res) => { try { ok(res, { timeline: domain.leadsTimeline(req.auth.workspaceId, Number(req.params.id), { limit: req.query.limit }) }); } catch (e) { fail(res, e); } });
router.get('/leads/:id/prospect-score', (req, res) => { try { ok(res, domain.prospectScore(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e); } });
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
router.get('/design', (req, res) => { try { ok(res, domain.designList(req.auth.workspaceId, req.query)); } catch (e) { fail(res, e); } });
router.get('/design/default-instructions', (req, res) => { try { ok(res, domain.designDefaultInstructions()); } catch (e) { fail(res, e); } });

// Design — inbound email redesign requests (also mounted at /email-redesign)
const ER = ['/design/email-redesign', '/email-redesign'];
const erPaths = (suffix = '') => ER.map((p) => `${p}${suffix}`);
router.get(erPaths(), (req, res) => {
  try {
    const args = { ...req.query };
    if (args.pendingOnly != null) args.pendingOnly = args.pendingOnly === '1' || args.pendingOnly === 'true';
    if (args.includeAll != null) args.includeAll = args.includeAll === '1' || args.includeAll === 'true';
    ok(res, domain.emailRedesignList(req.auth.workspaceId, args));
  } catch (e) { fail(res, e); }
});
router.post(erPaths('/ingest'), (req, res) => { try { ok(res, domain.emailRedesignIngest(req.auth.workspaceId, req.body || {})); } catch (e) { fail(res, e); } });
router.post(erPaths('/scan'), (req, res) => { try { ok(res, domain.emailRedesignScan(req.auth.workspaceId)); } catch (e) { fail(res, e); } });
router.get(erPaths('/:id'), (req, res) => { try { ok(res, domain.emailRedesignGet(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e); } });
router.post(erPaths('/:id/submit'), async (req, res) => { try { ok(res, await domain.emailRedesignSubmit(req.auth.workspaceId, Number(req.params.id), req.body || {})); } catch (e) { fail(res, e, 500); } });
router.post(erPaths('/:id/dismiss'), (req, res) => { try { ok(res, domain.emailRedesignDismiss(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e); } });

// Design — learning playbook (also mounted at /design-learning)
const DL = ['/design/learning', '/design-learning'];
const dlPaths = (suffix = '') => DL.map((p) => `${p}${suffix}`);
router.get(dlPaths('/status'), (req, res) => { try { ok(res, domain.learningStatus(req.auth.workspaceId)); } catch (e) { fail(res, e); } });
router.get(dlPaths('/playbook'), (req, res) => { try { ok(res, domain.learningPlaybook(req.auth.workspaceId)); } catch (e) { fail(res, e); } });
router.get(dlPaths('/events'), (req, res) => { try { ok(res, domain.learningEvents(req.auth.workspaceId, req.query)); } catch (e) { fail(res, e); } });
router.post(dlPaths('/clear'), requireRole('owner', 'admin'), (req, res) => { try { ok(res, domain.learningClear(req.auth.workspaceId, (req.body && req.body.what) || 'all')); } catch (e) { fail(res, e); } });
router.post(dlPaths('/distill'), async (req, res) => { try { ok(res, await domain.learningDistill(req.auth.workspaceId, req.body || {})); } catch (e) { fail(res, e, 500); } });

router.post('/design/render', (req, res) => { try { ok(res, domain.designRenderHtml(req.auth.workspaceId, req.body || {})); } catch (e) { fail(res, e); } });
router.get('/design/:id/answers', (req, res) => { try { ok(res, domain.designListAnswers(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e); } });
router.post('/design/:id/contact', (req, res) => { try { ok(res, { job: domain.designSetContact(req.auth.workspaceId, Number(req.params.id), req.body && req.body.email) }); } catch (e) { fail(res, e); } });
router.post('/design/:id/email-questions', (req, res) => { try { ok(res, domain.designEmailQuestions(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e); } });
router.post('/design/:id/email-delivery', (req, res) => { try { ok(res, domain.designEmailDelivery(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e); } });
router.post('/design/:id/reply', (req, res) => { try { ok(res, { job: domain.designRecordReply(req.auth.workspaceId, Number(req.params.id), req.body && req.body.reply, req.body && req.body.fromEmail) }); } catch (e) { fail(res, e); } });
router.put('/design/:id/website', (req, res) => { try { ok(res, { job: domain.designSaveWebsite(req.auth.workspaceId, Number(req.params.id), req.body && req.body.pages, req.body && req.body.theme) }); } catch (e) { fail(res, e); } });
router.post('/design/:id/render', (req, res) => { try { ok(res, domain.designRenderHtml(req.auth.workspaceId, { ...(req.body || {}), id: Number(req.params.id) })); } catch (e) { fail(res, e); } });
router.get('/design/:id/asset-base', async (req, res) => { try { ok(res, await domain.designAssetBase(req.auth.workspaceId, Number(req.params.id))); } catch (e) { fail(res, e, 500); } });
router.post('/design/:id/remove-delivery', (req, res) => { try { ok(res, { job: domain.designRemoveDelivery(req.auth.workspaceId, Number(req.params.id), req.body && req.body.path) }); } catch (e) { fail(res, e); } });
router.delete('/design/:id/delivery', (req, res) => { try { ok(res, { job: domain.designRemoveDelivery(req.auth.workspaceId, Number(req.params.id), (req.body && req.body.path) || req.query.path) }); } catch (e) { fail(res, e); } });
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
router.get('/websites/by-lead/:leadId', (req, res) => { try { ok(res, domain.sitesForLead(req.auth.workspaceId, Number(req.params.leadId))); } catch (e) { fail(res, e); } });
router.post('/websites/render', (req, res) => { try { ok(res, domain.sitesRenderHtml(req.auth.workspaceId, null, req.body || {})); } catch (e) { fail(res, e); } });
router.put('/websites/:id', (req, res) => { try { ok(res, domain.sitesSave(req.auth.workspaceId, Number(req.params.id), req.body || {})); } catch (e) { fail(res, e); } });
router.post('/websites/:id/render', (req, res) => { try { ok(res, domain.sitesRenderHtml(req.auth.workspaceId, Number(req.params.id), req.body || {})); } catch (e) { fail(res, e); } });
router.post('/websites/:id/preview', async (req, res) => { try { ok(res, await domain.sitesPreview(req.auth.workspaceId, Number(req.params.id), req.body || {})); } catch (e) { fail(res, e, 500); } });
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
router.post('/email/compose', (req, res) => { try { ok(res, domain.emailCompose(req.auth.workspaceId, req.body.leadId, req.body.templateId, { queue: !!req.body.queue })); } catch (e) { fail(res, e); } });
router.post('/email/send', async (req, res) => { try { ok(res, await domain.emailSend(req.auth.workspaceId, Number(req.body && req.body.messageId))); } catch (e) { fail(res, e, e.code === 'SEND_FAILED' ? 502 : 400); } });

// Settings (workspace SQLite — same keys as desktop)
router.get('/settings', (req, res) => { try { ok(res, { settings: domain.settingsGetAll(req.auth.workspaceId) }); } catch (e) { fail(res, e); } });
router.put('/settings', requireRole('owner', 'admin'), (req, res) => { try { ok(res, domain.settingsSet(req.auth.workspaceId, req.body.key, req.body.value)); } catch (e) { fail(res, e); } });
router.put('/settings/secret', requireRole('owner', 'admin'), (req, res) => { try { ok(res, domain.settingsSetSecret(req.auth.workspaceId, req.body.key, req.body.value)); } catch (e) { fail(res, e); } });
router.post('/settings/automation', requireRole('owner', 'admin'), (req, res) => { try { ok(res, domain.automationSet(req.auth.workspaceId, !!(req.body && req.body.paused))); } catch (e) { fail(res, e); } });
router.get('/prompts', (req, res) => { try { ok(res, { prompts: domain.promptsList(req.auth.workspaceId) }); } catch (e) { fail(res, e); } });
router.put('/prompts/:key', requireRole('owner', 'admin'), (req, res) => { try { ok(res, domain.promptsSave(req.auth.workspaceId, req.params.key, req.body.body)); } catch (e) { fail(res, e); } });
router.post('/prompts/:key/reset', requireRole('owner', 'admin'), (req, res) => { try { ok(res, domain.promptsReset(req.auth.workspaceId, req.params.key)); } catch (e) { fail(res, e); } });
router.get('/activity', (req, res) => { try { ok(res, domain.activityRecent(req.auth.workspaceId, req.query)); } catch (e) { fail(res, e); } });
router.get('/ai/usage', (req, res) => { try { ok(res, domain.aiUsage(req.auth.workspaceId, Number(req.query.days) || 30)); } catch (e) { fail(res, e); } });
router.get('/ai/status', (req, res) => { try { ok(res, domain.aiStatus(req.auth.workspaceId)); } catch (e) { fail(res, e); } });

// Cloudflare
router.get('/cloudflare', (req, res) => { try { ok(res, domain.cfGetConfig(req.auth.workspaceId)); } catch (e) { fail(res, e); } });
router.put('/cloudflare', requireRole('owner', 'admin'), (req, res) => { try { ok(res, domain.cfSaveConfig(req.auth.workspaceId, req.body || {})); } catch (e) { fail(res, e); } });
router.post('/cloudflare/test', async (req, res) => { try { ok(res, await domain.cfTest(req.auth.workspaceId)); } catch (e) { fail(res, e, 500); } });
router.post('/cloudflare/publish', async (req, res) => { try { ok(res, await domain.cfPublish(req.auth.workspaceId, Number(req.body.websiteId), req.body.dir)); } catch (e) { fail(res, e, 500); } });

module.exports = router;
