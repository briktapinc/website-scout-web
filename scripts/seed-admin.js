'use strict';

require('dotenv').config();
const { migrate } = require('../server/db');
const { findUserByEmail, createUserWithWorkspace, createWorkspaceToken } = require('../server/workspace');

(async () => {
  await migrate();
  const email = process.env.BOOTSTRAP_EMAIL || process.argv[2];
  const password = process.env.BOOTSTRAP_PASSWORD || process.argv[3];
  if (!email || !password) {
    console.error('Usage: node scripts/seed-admin.js email password');
    process.exit(1);
  }
  let user = await findUserByEmail(email);
  let workspaceId;
  if (!user) {
    const created = await createUserWithWorkspace({
      email,
      password,
      name: process.env.BOOTSTRAP_NAME || 'Owner',
      workspaceName: process.env.BOOTSTRAP_WORKSPACE || 'Primary',
    });
    workspaceId = created.workspaceId;
    console.log('Created user', created.userId, 'workspace', workspaceId);
  } else {
    const { listWorkspacesForUser } = require('../server/workspace');
    const ws = await listWorkspacesForUser(user.id);
    workspaceId = ws[0] && ws[0].id;
    console.log('User already exists; workspace', workspaceId);
  }
  if (workspaceId && process.argv.includes('--token')) {
    const t = await createWorkspaceToken(workspaceId, 'CLI');
    console.log('MCP token (copy once):', t.token);
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
