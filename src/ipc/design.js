'use strict';

const design = require('../designJobs');
const engine = require('../websiteEngine');
const emailRedesign = require('../emailRedesign');
const designLearning = require('../designLearning');

function ok(data) { return Object.assign({ ok: true }, data); }
function fail(e) {
  return { ok: false, error: e && e.message ? e.message : String(e), code: (e && e.code) || 'ERROR' };
}

function register(ipcMain, db) {
  engine.ensureTables(db);
  design.ensureTables(db);
  emailRedesign.ensureTables(db);
  designLearning.ensureTables(db);
  const wrap = (fn) => async (_event, args) => {
    try { return ok(await fn(args)); } catch (e) { return fail(e); }
  };

  ipcMain.handle('design:list', wrap((args = {}) => design.listJobs(db, args || {})));
  ipcMain.handle('design:get', wrap((id) => {
    const job = design.getJob(db, Number(id));
    if (job && job.review) {
      const designReview = require('../designReview');
      job.review.screenshot_previews = designReview.loadReviewShotPreviews(job.review);
    }
    return { job };
  }));
  ipcMain.handle('design:defaultInstructions', wrap(() => ({
    website: design.defaultWebsiteInstructions(),
  })));
  ipcMain.handle('design:create', wrap((args = {}) => ({ job: design.createJob(db, args || {}) })));
  ipcMain.handle('design:update', wrap((args = {}) => ({
    job: design.updateJob(db, Number(args.id), args || {}),
  })));
  ipcMain.handle('design:answer', wrap((args = {}) => ({
    job: design.answerQuestion(db, Number(args.questionId), args.answer, args.fromEmail),
  })));
  ipcMain.handle('design:setContact', wrap((args = {}) => ({
    job: design.setContact(db, Number(args.id), {
      email: args.email,
      phone: args.phone != null ? args.phone : args.contact_phone,
    }),
  })));
  ipcMain.handle('design:emailQuestions', wrap(async (args = {}) => {
    const id = Number(args.jobId != null ? args.jobId : args.id);
    return design.emailQuestions(db, id);
  }));
  ipcMain.handle('design:emailDelivery', wrap(async (args = {}) => {
    const id = Number(args.jobId != null ? args.jobId : args.id);
    return design.emailDelivery(db, id);
  }));
  ipcMain.handle('design:recordReply', wrap((args = {}) => ({
    job: design.recordEmailReply(db, Number(args.id || args.jobId), args.reply, args.fromEmail),
  })));
  ipcMain.handle('design:saveWebsite', wrap((args = {}) => ({
    job: design.saveWebsiteEdit(db, Number(args.id), args.pages, args.theme),
  })));
  ipcMain.handle('design:addImages', wrap(async (args = {}) => design.addImages(db, Number(args.id), args)));
  ipcMain.handle('design:generateImages', wrap(async (args = {}) => design.generateJobImages(db, Number(args.id), args)));
  ipcMain.handle('design:openPreview', wrap(async (id) => design.openPreview(db, Number(id && id.id !== undefined ? id.id : id))));
  ipcMain.handle('design:previewUrl', wrap(async (args = {}) => {
    const id = Number(args.id != null ? args.id : args);
    return design.previewUrl(db, id, { open: !!args.open });
  }));
  ipcMain.handle('design:assetBase', wrap(async (args = {}) => {
    const id = Number(args.id != null ? args.id : args);
    return design.assetBaseUrl(db, id);
  }));
  ipcMain.handle('design:review', wrap(async (args = {}) => {
    const id = Number(args.id != null ? args.id : args);
    const review = await design.reviewJob(db, id, {
      skipAi: !!args.skipAi,
      skipScreenshots: !!args.skipScreenshots,
    });
    const job = design.getJob(db, id);
    if (job && job.review) {
      job.review.screenshot_previews = review.screenshot_previews
        || require('../designReview').loadReviewShotPreviews(job.review);
    }
    return { review, job };
  }));
  ipcMain.handle('design:redesign', wrap(async (args = {}) => {
    const id = Number(args.id);
    const job = await design.redesignJob(db, id, {
      instructions: args.instructions,
      refresh: args.refresh !== false,
      forceReview: !!args.forceReview,
      skipAi: !!args.skipAi,
    });
    return { job, review: job.review };
  }));
  ipcMain.handle('design:improve', wrap(async (args = {}) => {
    const id = Number(args.id);
    const job = await design.improveJob(db, id, {
      instructions: args.instructions,
      refresh: args.refresh !== false,
      forceReview: !!args.forceReview,
      skipAi: !!args.skipAi,
    });
    return { job, review: job.review };
  }));
  ipcMain.handle('design:listEmailRedesigns', wrap((args = {}) => ({
    requests: emailRedesign.listEmailRedesigns(db, args || {}),
    dropDir: emailRedesign.resolveDropDir(db),
  })));
  ipcMain.handle('design:ingestEmailRedesign', wrap((args = {}) => {
    const result = emailRedesign.ingestInboundEmail(db, {
      fromEmail: args.fromEmail,
      subject: args.subject,
      body: args.body != null ? args.body : args.reply,
      designJobId: args.designJobId != null ? args.designJobId : args.id,
      leadId: args.leadId,
      source: args.source || 'paste',
      force: args.force !== false,
      requestKind: args.requestKind || args.request_kind,
    });
    if (result.skipped) return { ok: false, skipped: true, error: 'Not detected as a redesign/improvements request.', reason: result.reason };
    return { request: result.request, job: args.designJobId != null || args.id != null
      ? design.getJob(db, Number(args.designJobId != null ? args.designJobId : args.id))
      : null };
  }));
  ipcMain.handle('design:submitEmailRedesign', wrap(async (args = {}) => {
    const out = await emailRedesign.submitEmailRedesign(db, Number(args.id || args.requestId), {
      designJobId: args.designJobId,
      instructions: args.instructions,
      requestKind: args.requestKind || args.request_kind,
    });
    return out;
  }));
  ipcMain.handle('design:dismissEmailRedesign', wrap((args = {}) => ({
    request: emailRedesign.dismissEmailRedesign(db, Number(args.id || args.requestId)),
  })));
  ipcMain.handle('design:scanInboundEmail', wrap(() => emailRedesign.scanDropFolder(db)));
  ipcMain.handle('design:delete', wrap((id) => design.deleteJob(db, Number(id && id.id !== undefined ? id.id : id))));
  ipcMain.handle('design:removeDeliveryItem', wrap((args = {}) => ({
    job: design.removeDeliveryItem(db, Number(args.id || args.jobId), args.path),
  })));
  ipcMain.handle('design:learningStatus', wrap(() => designLearning.getStatus(db)));
  ipcMain.handle('design:learningPlaybook', wrap(() => ({
    playbook: designLearning.getPlaybook(db),
    status: designLearning.getStatus(db),
  })));
  ipcMain.handle('design:learningEvents', wrap((args = {}) => ({
    events: designLearning.listEvents(db, args || {}),
  })));
  ipcMain.handle('design:learningClear', wrap((args = {}) => {
    const what = String((args && args.what) || 'all').toLowerCase();
    if (what === 'playbook') return designLearning.clearPlaybook(db);
    if (what === 'events') return designLearning.clearEvents(db);
    return designLearning.clearAll(db);
  }));
  ipcMain.handle('design:learningDistill', wrap(async (args = {}) =>
    designLearning.maybeDistill(db, { force: !!(args && args.force) })
  ));
  ipcMain.handle('design:renderHtml', wrap((args = {}) => {
    let pages = args.pages;
    let theme = args.theme || {};
    let job = null;
    if (!Array.isArray(pages) || !pages.length) {
      job = design.getJob(db, Number(args.id));
      const payload = job.deliverable;
      if (!payload || !Array.isArray(payload.pages)) throw Object.assign(new Error('No website delivery yet.'), { code: 'NO_DELIVERY' });
      pages = payload.pages;
      theme = payload.theme || {};
    } else if (args.id != null) {
      try { job = design.getJob(db, Number(args.id)); } catch { /* optional */ }
    }
    // Prefer linked website freestyle CSS when deliverable theme lost customCss.
    const websiteId = job && job.website_id != null ? Number(job.website_id) : null;
    if (websiteId) {
      try {
        const site = engine.getWebsite(db, websiteId);
        let siteTheme = site.theme;
        if (typeof siteTheme === 'string') {
          try { siteTheme = JSON.parse(siteTheme || 'null'); } catch { siteTheme = null; }
        }
        let sitePages = site.pages;
        if (typeof sitePages === 'string') {
          try { sitePages = JSON.parse(sitePages || 'null'); } catch { sitePages = null; }
        }
        if (!Array.isArray(args.pages) || !args.pages.length) {
          if (Array.isArray(sitePages) && sitePages.length) pages = sitePages;
          if (siteTheme && typeof siteTheme === 'object') {
            const siteCssLen = typeof siteTheme.customCss === 'string' ? siteTheme.customCss.trim().length : 0;
            const themeCssLen = typeof theme.customCss === 'string' ? theme.customCss.trim().length : 0;
            if (siteCssLen && siteCssLen >= themeCssLen) theme = siteTheme;
            else theme = design.mergeThemePreferCss(theme, siteTheme);
          }
        } else if (siteTheme) {
          theme = design.mergeThemePreferCss(theme, siteTheme);
        }
      } catch { /* optional */ }
    }
    const opts = {
      editable: !!args.editable,
      preview: true,
      pageSlug: args.pageSlug,
      pageIndex: Number.isInteger(args.pageIndex) ? args.pageIndex : (args.pageIndex != null ? Number(args.pageIndex) : undefined),
    };
    // Multipage: render one page when a tab asks for it; otherwise stack with #anchor nav.
    if (opts.pageSlug != null || Number.isInteger(opts.pageIndex)) {
      return { html: engine.renderPageAt(pages, theme, opts), pages: pages.map((p) => ({ slug: p.slug, title: p.title })) };
    }
    return { html: engine.renderSite(pages, theme, opts), pages: pages.map((p) => ({ slug: p.slug, title: p.title })) };
  }));
}

module.exports = { register };
