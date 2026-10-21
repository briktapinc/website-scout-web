'use strict';

const BASE = process.env.APP_URL || 'https://bitpype.com';
const email = process.env.BOOTSTRAP_EMAIL || 'owner@example.com';
const password = process.env.BOOTSTRAP_PASSWORD || 'ChangeMe_Scout1';

async function main() {
  const loginRes = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const login = await loginRes.json();
  if (!login.ok) {
    console.error('login failed', login);
    process.exit(1);
  }
  const raw = loginRes.headers.raw ? loginRes.headers.raw()['set-cookie'] : null;
  const cookieHeader = (raw || [])
    .filter(Boolean)
    .map((c) => String(c).split(';')[0])
    .join('; ');
  const wsId = login.data && (login.data.workspaceId
    || (login.data.workspaces && login.data.workspaces[0] && login.data.workspaces[0].id)
    || 1);
  const headers = {
    'Content-Type': 'application/json',
    Cookie: cookieHeader,
    'X-Workspace-Id': String(wsId),
  };

  const cfRes = await fetch(`${BASE}/api/v1/cloudflare`, { headers });
  const cf = await cfRes.json();
  console.log('cf.configured=', cf.data && cf.data.configured, 'project=', cf.data && cf.data.project, 'previewDomain=', cf.data && cf.data.previewDomain);

  console.log('POST /websites/1/preview force=true …');
  const prevRes = await fetch(`${BASE}/api/v1/websites/1/preview`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ force: true }),
  });
  const prev = await prevRes.json();
  console.log('status=', prevRes.status);
  console.log(JSON.stringify(prev, null, 2));

  const url = prev && prev.data && prev.data.url;
  if (!url) {
    console.error('FAIL: no preview url');
    process.exit(1);
  }
  if (/127\.0\.0\.1|localhost|:8755/i.test(url)) {
    console.error('FAIL: still localhost:', url);
    process.exit(1);
  }
  console.log('OK public preview url=', url);

  try {
    const head = await fetch(url, { method: 'GET', redirect: 'follow' });
    console.log('preview GET status=', head.status, 'final=', head.url);
  } catch (e) {
    console.log('preview GET error (may be DNS/custom domain):', e.message);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
