'use strict';

const BASE = process.env.APP_URL || 'https://bitpype.com';
const email = process.env.BOOTSTRAP_EMAIL || 'owner@example.com';
const password = process.env.BOOTSTRAP_PASSWORD || 'ChangeMe_Scout1';
const to = process.env.TEST_TO || email;

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
  const raw = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [];
  const cookieHeader = raw.map((c) => String(c).split(';')[0]).join('; ');
  const wsId = login.data.workspaceId || 1;
  const headers = {
    'Content-Type': 'application/json',
    Cookie: cookieHeader,
    'X-Workspace-Id': String(wsId),
  };

  const settingsRes = await fetch(`${BASE}/api/v1/settings`, { headers });
  const settingsBody = await settingsRes.json();
  const s = (settingsBody.data && settingsBody.data.settings) || {};
  const keys = [
    'smtp.host', 'smtp.port', 'smtp.secure', 'smtp.user', 'smtp.pass',
    'smtp.from_name', 'smtp.from_email',
  ];
  console.log('SMTP settings:');
  for (const k of keys) {
    const v = s[k];
    if (k === 'smtp.pass') console.log(`  ${k}=${v === '***' ? 'SET' : (v ? 'NON_EMPTY' : 'EMPTY')}`);
    else console.log(`  ${k}=${JSON.stringify(v || '')}`);
  }

  // Prefer API test if present; otherwise compose+send via campaign message path is heavy.
  // Call a lightweight probe endpoint we may add — for now use VPS-side script via note.
  console.log('to=', to);
  console.log('login_ok workspace=', wsId);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
