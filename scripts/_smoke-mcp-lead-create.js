#!/usr/bin/env node
'use strict';
/**
 * Smoke: workspace MCP tools must not die with "leadId is required"
 * when the bearer token has no lead_id (portal dispatch gate).
 */
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { callTool } = require('../server/mcp');

async function main() {
  // Workspace 1, no lead on ctx — mirrors workspace-scoped ws_ tokens.
  const ctx = { leadId: null };
  const name = `MCP smoke lead ${Date.now()}`;
  const out = await callTool(1, 'lead.create', { business_name: name }, ctx);
  if (!out || out.ok !== true) {
    console.error('FAIL lead.create', out);
    process.exit(1);
  }
  const lead = out.data && out.data.lead;
  if (!lead || !lead.id) {
    console.error('FAIL no lead id', out);
    process.exit(1);
  }
  // underscore alias
  const out2 = await callTool(1, 'lead_create', {
    business_name: `${name} alias`,
  }, ctx);
  if (!out2 || out2.ok !== true) {
    console.error('FAIL lead_create alias', out2);
    process.exit(1);
  }
  console.log('SMOKE OK mcp-lead-create', lead.id, out2.data.lead.id);
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
