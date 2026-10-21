'use strict';

/**
 * Smoke-test signed {{interested}} / {{uninterested}} tokens + applyInterestResponse.
 * Creates a disposable lead and cleans it up.
 * Usage (in container): node scripts/_test-interest-links.js [workspaceId]
 */

const outreach = require('../src/outreach');
const leadEngine = require('../src/leadEngine');
const { openWorkspaceDb } = require('../server/workspaceDb');

const workspaceId = Number(process.argv[2] || 1);
if (!process.env.APP_URL) process.env.APP_URL = 'https://bitpype.com';

const db = openWorkspaceDb(workspaceId);
const created = leadEngine.createLead(db, {
  business_name: 'Interest Link Smoke Test',
  email: `interest-link-smoke-${Date.now()}@example.invalid`,
  status: 'contacted',
  source: 'smoke-test',
});
const leadId = Number(created.id || created);
const lead = db.prepare('SELECT id, business_name, email, status FROM leads WHERE id = ?').get(leadId);

function cleanup() {
  try { db.prepare('DELETE FROM prospect_events WHERE lead_id = ?').run(leadId); } catch { /* */ }
  try { db.prepare('DELETE FROM intent_scores WHERE lead_id = ?').run(leadId); } catch { /* */ }
  try { db.prepare('DELETE FROM lead_events WHERE lead_id = ?').run(leadId); } catch { /* */ }
  try {
    db.prepare('DELETE FROM suppression_list WHERE lower(email) = lower(?)').run(lead.email);
  } catch { /* */ }
  try { db.prepare('DELETE FROM leads WHERE id = ?').run(leadId); } catch { /* */ }
}

try {
  const extras = outreach.personalizeExtras(db, lead.id, 'Bitpype', { workspaceId });
  console.log('lead', { id: lead.id, status: lead.status, email: lead.email });
  console.log('interested html:', extras.interested);
  console.log('uninterested html:', extras.uninterested);

  if (!extras.interested || !extras.uninterested) {
    throw new Error('merge vars empty (need APP_URL + workspaceId)');
  }
  if (!extras.interested.includes("I'm interested") || !extras.uninterested.includes('Not interested')) {
    throw new Error('expected link labels missing');
  }

  const interestedUrl = extras.interested.match(/href="([^"]+)"/)[1];
  const token = decodeURIComponent(interestedUrl.split('/response/')[1]);
  const verified = outreach.verifyInterestToken(token);
  if (verified.workspaceId !== workspaceId || verified.leadId !== lead.id || verified.action !== 'interested') {
    throw new Error(`verify mismatch: ${JSON.stringify(verified)}`);
  }

  // Forged token must fail
  let forgedOk = false;
  try {
    outreach.verifyInterestToken(`${token.slice(0, -2)}xx`);
  } catch (e) {
    forgedOk = e.code === 'INVALID_TOKEN';
  }
  if (!forgedOk) throw new Error('forged token should fail');

  const once = outreach.applyInterestResponse(db, lead.id, 'interested');
  const twice = outreach.applyInterestResponse(db, lead.id, 'interested');
  console.log('interested first', once);
  console.log('interested second', twice);
  if (once.status !== 'engaged') throw new Error(`expected engaged, got ${once.status}`);
  if (twice.already !== true) throw new Error('second interested click should be already=true');

  // Reset for uninterested path
  db.prepare(`UPDATE leads SET status = 'contacted' WHERE id = ?`).run(lead.id);
  db.prepare(`DELETE FROM prospect_events WHERE lead_id = ? AND type = 'email.interested'`).run(lead.id);

  const no = outreach.applyInterestResponse(db, lead.id, 'uninterested');
  const no2 = outreach.applyInterestResponse(db, lead.id, 'uninterested');
  console.log('uninterested first', no);
  console.log('uninterested second', no2);
  if (no.status !== 'lost') throw new Error(`expected lost, got ${no.status}`);
  if (no2.already !== true) throw new Error('second uninterested click should be already=true');
  const suppressed = outreach.isSuppressed(db, lead.email);
  if (!suppressed) throw new Error('expected suppression after uninterested');

  // Live HTTP check against the app (when running inside the container)
  const port = process.env.PORT || 3000;
  const unUrl = extras.uninterested.match(/href="([^"]+)"/)[1]
    .replace(/^https?:\/\/[^/]+/, `http://127.0.0.1:${port}`);
  // Re-sign a fresh interested token for HTTP (lead is lost now — still idempotent)
  const fresh = outreach.signInterestToken({ workspaceId, leadId: lead.id, action: 'interested' });
  const path = outreach.interestResponsePath(fresh);
  fetch(`http://127.0.0.1:${port}${path}`)
    .then(async (r) => {
      const text = await r.text();
      console.log('http interested', r.status, text.includes('Thank you') ? 'thank-you-ok' : text.slice(0, 120));
      if (r.status !== 200 || !text.includes('Thank you')) throw new Error('HTTP interested page failed');
      const bad = await fetch(`http://127.0.0.1:${port}/api/v1/outreach/public/response/not.a.valid.token`);
      console.log('http forged', bad.status);
      if (bad.status !== 400 && bad.status !== 404) throw new Error(`expected 400 for forged, got ${bad.status}`);
      console.log('OK', unUrl ? '(uninterested url built)' : '');
      cleanup();
    })
    .catch((e) => {
      cleanup();
      console.error('FAIL', e.message || e);
      process.exit(1);
    });
} catch (e) {
  cleanup();
  console.error('FAIL', e.message || e);
  process.exit(1);
}
