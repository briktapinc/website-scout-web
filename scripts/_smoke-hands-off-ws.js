'use strict';
const { query } = require('../server/db');
const domain = require('../server/domain');

(async () => {
  const rows = await query('SELECT id, name FROM workspaces ORDER BY id ASC LIMIT 5');
  console.log('workspaces', JSON.stringify(rows));
  const ws = Number(process.env.HANDS_OFF_SMOKE_WS || (rows[0] && rows[0].id));
  if (!ws) {
    console.error('no workspace');
    process.exit(1);
  }
  const st = await domain.handsOffStatus(ws);
  console.log('status', JSON.stringify({
    workspaceId: ws,
    enabled: st.enabled,
    paused: st.automationPaused,
    muse: st.museConfigured,
    model: st.museModel,
    lastRunAt: st.lastRunAt,
    jobs: st.jobs,
  }));
  const r = await domain.handsOffRunNow(ws, { force: true });
  console.log('tick', JSON.stringify({
    ok: r.ok,
    skipped: r.skipped,
    reason: r.reason,
    discovered: r.discovered,
    scored: r.scored,
    designJobs: r.designJobs,
    delivered: r.delivered,
    published: r.published,
    campaigns: r.campaigns,
    errors: (r.errors || []).slice(0, 8),
  }));
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
