'use strict';

/**
 * Electron IPC for Cloudflare Registrar domains + Pages linking.
 * Auto-loaded by main.js from src/ipc/*.js
 */

const cfDomains = require('../cfDomains');
const cf = require('../cloudflare');

function register(ipcMain, db) {
  cfDomains.ensureTables(db);

  ipcMain.handle('domains:list', (_e, args = {}) => {
    return { domains: cfDomains.listLinked(db, args || {}) };
  });

  ipcMain.handle('domains:search', async (_e, args = {}) => {
    const q = args.q || args.query;
    const result = await cfDomains.searchDomains(db, q, { limit: args.limit });
    if (args.leadId != null) cfDomains.recordSearchIntent(db, args.leadId, q);
    return result;
  });

  ipcMain.handle('domains:check', async (_e, args = {}) => {
    const names = args.domains || args.names || (args.domain ? [args.domain] : []);
    return cfDomains.checkDomains(db, names);
  });

  ipcMain.handle('domains:owned', async () => cfDomains.listOwnedDomains(db));

  ipcMain.handle('domains:register', async (_e, args = {}) => {
    return cfDomains.registerDomain(db, args.domain || args.domainName, {
      years: args.years,
      websiteId: args.websiteId,
      leadId: args.leadId,
    });
  });

  ipcMain.handle('domains:status', async (_e, args = {}) => {
    return cfDomains.registrationStatus(db, args.domain || args.domainName);
  });

  ipcMain.handle('domains:link', async (_e, args = {}) => {
    const websiteId = Number(args.websiteId);
    return cfDomains.linkDomainToWebsite(db, {
      domain: args.domain || args.domainName,
      websiteId,
      leadId: args.leadId,
      project: args.project,
      forcePublish: !!args.forcePublish,
      source: args.source || 'link',
      publishFn: async (id, project) => {
        const path = require('node:path');
        const os = require('node:os');
        const engine = require('../websiteEngine');
        const outDir = path.join(os.tmpdir(), `website-scout-export-${id}-${Date.now()}`);
        const exported = await engine.exportStatic(db, id, outDir);
        const dir = (exported && (exported.dir || exported.path)) || outDir;
        await cf.publishDirectory(db, { websiteId: id, dir, project });
      },
    });
  });

  ipcMain.handle('domains:unlink', async (_e, args = {}) => {
    return cfDomains.unlinkDomain(db, {
      domain: args.domain || args.domainName,
      project: args.project,
      removeFromPages: args.removeFromPages !== false,
    });
  });
}

module.exports = { register };
