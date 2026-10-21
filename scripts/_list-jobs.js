'use strict';

(async () => {
  const { query } = require('../server/db');
  const jobs = await query('SELECT id, workspace_id, name, type, cron_expr, interval_minutes, enabled, next_run_at, last_run_at FROM jobs ORDER BY id');
  console.log(JSON.stringify(jobs, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
