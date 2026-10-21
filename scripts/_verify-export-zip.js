'use strict';

/**
 * In-container verify: rematerialize + zip via domain.sitesExportZip,
 * then hit GET /websites/:id/export-zip with a temporary Bearer token.
 */

const domain = require('../server/domain');
const { createWorkspaceToken, hashToken } = require('../server/workspace');
const { query } = require('../server/db');

async function main() {
  const list = domain.sitesList(1, { pageSize: 1 });
  const site = (list.sites || list.rows || [])[0];
  if (!site) throw new Error('no websites in workspace 1');

  console.log('zipping website', site.id, site.name || '');
  const zipped = domain.sitesExportZip(1, site.id);
  if (!zipped.buffer || zipped.buffer.length < 4) throw new Error('empty zip buffer');
  if (zipped.buffer[0] !== 0x50 || zipped.buffer[1] !== 0x4b) {
    throw new Error('domain zip missing PK magic');
  }
  if (!/\.zip$/i.test(zipped.filename || '')) throw new Error('bad filename: ' + zipped.filename);
  console.log('domain_ok', zipped.filename, 'bytes', zipped.bytes, 'files', (zipped.files || []).length);

  const port = process.env.PORT || '3000';
  const base = process.env.APP_URL || `http://127.0.0.1:${port}`;
  const created = await createWorkspaceToken(1, 'export-zip-verify-' + Date.now());
  const raw = created && created.token;
  if (!raw) throw new Error('createWorkspaceToken did not return raw token');

  try {
    const zipRes = await fetch(`${base}/api/v1/websites/${site.id}/export-zip`, {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + raw,
        'X-Workspace-Id': '1',
      },
    });
    const ct = zipRes.headers.get('content-type') || '';
    const cd = zipRes.headers.get('content-disposition') || '';
    const buf = Buffer.from(await zipRes.arrayBuffer());
    console.log('http_status', zipRes.status, 'ct', ct, 'cd', cd, 'bytes', buf.length);

    if (!zipRes.ok) {
      throw new Error('HTTP export-zip failed: ' + buf.toString('utf8').slice(0, 400));
    }
    if (!/application\/zip/i.test(ct)) throw new Error('expected application/zip, got ' + ct);
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
      throw new Error('HTTP response is not a ZIP');
    }
    if (!/filename=/i.test(cd)) throw new Error('missing Content-Disposition filename');
    console.log('VERIFY_OK export-zip');
  } finally {
    try {
      await query('DELETE FROM workspace_tokens WHERE token_hash = :h', { h: hashToken(raw) });
    } catch (e) {
      console.warn('token cleanup failed:', e.message);
    }
  }
}

main().catch((e) => {
  console.error('VERIFY_FAIL', e.message || e);
  process.exit(1);
});
