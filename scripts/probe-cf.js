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
  const cookie = (loginRes.headers.getSetCookie && loginRes.headers.getSetCookie())
    || [];
  // Node fetch: get set-cookie via raw headers
  const raw = loginRes.headers.raw ? loginRes.headers.raw()['set-cookie'] : null;
  const cookies = raw || cookie;
  const cookieHeader = (Array.isArray(cookies) ? cookies : [cookies])
    .filter(Boolean)
    .map((c) => String(c).split(';')[0])
    .join('; ');

  console.log('login ok=', login.ok, 'status=', loginRes.status, 'error=', login.error || '');
  if (!login.ok) process.exit(1);

  const wsId = login.data && (login.data.workspaceId || (login.data.workspaces && login.data.workspaces[0] && login.data.workspaces[0].id));
  console.log('workspaceId=', wsId);

  const headers = {
    'Content-Type': 'application/json',
    Cookie: cookieHeader,
    'X-Workspace-Id': String(wsId || 1),
  };

  const settingsRes = await fetch(`${BASE}/api/v1/settings`, { headers });
  const settings = await settingsRes.json();
  const s = (settings.data && settings.data.settings) || {};
  const cfKeys = Object.keys(s).filter((k) => k.startsWith('cf.'));
  console.log('cf settings keys=', cfKeys);
  for (const k of cfKeys) {
    const v = s[k];
    if (k === 'cf.api_token') console.log(k, '=', v === '***' ? 'SET(***)' : (v ? 'NON_EMPTY' : 'EMPTY'));
    else console.log(k, '=', JSON.stringify(v));
  }

  const cfRes = await fetch(`${BASE}/api/v1/cloudflare`, { headers });
  const cf = await cfRes.json();
  console.log('cfGet=', JSON.stringify(cf));

  const testRes = await fetch(`${BASE}/api/v1/cloudflare/test`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  const test = await testRes.json();
  console.log('cfTest status=', testRes.status, 'body=', JSON.stringify(test));

  // Platform admin CF defaults (if super admin)
  try {
    const adminRes = await fetch(`${BASE}/api/v1/admin/settings`, { headers });
    const admin = await adminRes.json();
    if (admin.ok) {
      const list = (admin.data && (admin.data.settings || admin.data)) || [];
      const arr = Array.isArray(list) ? list : Object.entries(list).map(([key, value]) => ({ key, value }));
      const cfAdmin = arr.filter((x) => String(x.key || x).includes('cf.'));
      console.log('platform cf settings=', JSON.stringify(cfAdmin.map((x) => ({
        key: x.key,
        value: x.key === 'cf.api_token' || x.secret
          ? (x.value === '***' || (x.value && String(x.value).length) ? 'SET' : 'EMPTY')
          : x.value,
        secret: !!x.secret,
      }))));
    } else {
      console.log('admin settings skipped:', admin.error);
    }
  } catch (e) {
    console.log('admin settings error', e.message);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
