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
  if (!login.ok) throw new Error(login.error || 'login failed');
  const cookies = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [];
  const cookieHeader = cookies.map((c) => String(c).split(';')[0]).join('; ');
  const wsId = login.data.workspaceId || 1;
  const headers = {
    'Content-Type': 'application/json',
    Cookie: cookieHeader,
    'X-Workspace-Id': String(wsId),
  };

  const created = await fetch(`${BASE}/api/v1/design`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'logo',
      title: 'Form smoke test',
      instructions: 'Make a simple logo concept for testing the client form.',
    }),
  }).then((r) => r.json());
  if (!created.ok) throw new Error(created.error || 'create failed');
  const jobId = created.data.job.id;
  console.log('job', jobId);

  const link = await fetch(`${BASE}/api/v1/design/${jobId}/client-form`, { headers }).then((r) => r.json());
  if (!link.ok) throw new Error(link.error || 'link failed');
  console.log('url', link.data.url);

  const u = new URL(link.data.url);
  const token = u.searchParams.get('token');
  const w = u.searchParams.get('w');

  const get = await fetch(`${BASE}/api/v1/design/public/form/${token}?w=${w}`).then((r) => r.json());
  if (!get.ok) throw new Error(get.error || 'public get failed');
  console.log('public job', get.data.job.id, get.data.job.title);

  const post = await fetch(`${BASE}/api/v1/design/public/form/${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      w: Number(w),
      kind: 'improvements',
      message: 'Please use blue and make the mark simpler.',
      email: 'client@example.com',
    }),
  }).then((r) => r.json());
  if (!post.ok) throw new Error(post.error || 'submit failed');
  console.log('submit', post.data);
  console.log('OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
