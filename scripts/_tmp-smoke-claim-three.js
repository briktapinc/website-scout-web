'use strict';

/**
 * Smoke Yes / No / Later claim API with a disposable lead.
 * Run in app container: node scripts/_tmp-smoke-claim-three.js
 */
const outreach = require('../src/outreach');
const claimKit = require('../src/claimKit');
const leadEngine = require('../src/leadEngine');
const { openWorkspaceDb } = require('../server/workspaceDb');

const workspaceId = Number(process.argv[2] || 1);
const port = process.env.PORT || 3000;
const db = openWorkspaceDb(workspaceId);
const created = leadEngine.createLead(db, {
  business_name: 'Claim Three-Way Smoke',
  email: `claim-three-smoke-${Date.now()}@example.invalid`,
  status: 'contacted',
  source: 'smoke-test',
});
const leadId = Number(created.id || created);
const token = outreach.signInterestToken({ workspaceId, leadId, action: 'c' });
const base = `http://127.0.0.1:${port}`;

function cleanup() {
  try { db.prepare('DELETE FROM prospect_events WHERE lead_id = ?').run(leadId); } catch { /* */ }
  try { db.prepare('DELETE FROM intent_scores WHERE lead_id = ?').run(leadId); } catch { /* */ }
  try {
    const lead = db.prepare('SELECT email FROM leads WHERE id = ?').get(leadId);
    if (lead && lead.email) {
      db.prepare('DELETE FROM suppression_list WHERE lower(email) = lower(?)').run(lead.email);
    }
  } catch { /* */ }
  try { db.prepare('DELETE FROM leads WHERE id = ?').run(leadId); } catch { /* */ }
}

(async () => {
  try {
    let meta = await (await fetch(`${base}/api/v1/outreach/public/claim/${encodeURIComponent(token)}`)).json();
    console.log('meta1', meta.data);
    if (!meta.data.showClaimPrompt) throw new Error('expected showClaimPrompt true initially');

    const later = await (await fetch(`${base}/api/v1/outreach/public/claim/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'later' }),
    })).json();
    console.log('later', later.data);
    if (!later.ok || later.data.action !== 'later' || !later.data.deferred) {
      throw new Error('later failed');
    }

    meta = await (await fetch(`${base}/api/v1/outreach/public/claim/${encodeURIComponent(token)}`)).json();
    console.log('meta after later', {
      showClaimPrompt: meta.data.showClaimPrompt,
      alreadyDeferred: meta.data.alreadyDeferred,
      laterCount: meta.data.laterCount,
    });
    if (meta.data.showClaimPrompt !== true) throw new Error('later must still allow re-prompt');
    if (!meta.data.alreadyDeferred || meta.data.laterCount < 1) throw new Error('later not persisted');

    const yes = await (await fetch(`${base}/api/v1/outreach/public/claim/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'interested' }),
    })).json();
    console.log('yes', yes.data);
    if (!yes.ok || yes.data.action !== 'interested') throw new Error('yes failed');

    // Reset for No path
    db.prepare(`UPDATE leads SET status = 'contacted' WHERE id = ?`).run(leadId);
    db.prepare(`DELETE FROM prospect_events WHERE lead_id = ? AND type IN ('email.interested','email.uninterested')`).run(leadId);

    const no = await (await fetch(`${base}/api/v1/outreach/public/claim/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'uninterested' }),
    })).json();
    console.log('no', no.data);
    if (!no.ok || no.data.action !== 'uninterested') throw new Error('no failed');

    meta = await (await fetch(`${base}/api/v1/outreach/public/claim/${encodeURIComponent(token)}`)).json();
    console.log('meta after no', {
      showClaimPrompt: meta.data.showClaimPrompt,
      alreadyUninterested: meta.data.alreadyUninterested,
    });
    if (meta.data.showClaimPrompt !== false) throw new Error('No should suppress prompt');

    // Local applyClaimResponse unit
    const unit = outreach.applyClaimResponse(db, leadId, 'later');
    console.log('unit later while lost', unit.action, unit.status);

    console.log('OK three-way claim');
  } finally {
    cleanup();
  }
})().catch((e) => {
  console.error(e);
  cleanup();
  process.exit(1);
});
