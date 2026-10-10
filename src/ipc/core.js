'use strict';

// Core system IPC: dashboard stats only.
//
// NOTE: settings/prompts/automation/activity channels live in src/ipc/system.js
// (canonical, with validation + secret redaction). They were previously also
// registered here, which threw "Attempted to register a second handler" on
// boot and killed the whole system.js module (including settings:setSecret).

function register(ipcMain, db) {
  ipcMain.handle('dashboard:stats', () => {
    const one = (sql, params = []) => db.prepare(sql).get(...params);
    const leadsTotal = one('SELECT COUNT(*) AS c FROM leads').c;
    const qualified = one('SELECT COUNT(*) AS c FROM leads WHERE qualified = 1').c;
    const websitesGenerated = one('SELECT COUNT(*) AS c FROM websites').c;
    const emailsSent = one("SELECT COUNT(*) AS c FROM campaign_messages WHERE status = 'sent'").c;
    const hotLeads = one(
      `SELECT COUNT(*) AS c FROM intent_scores i
       WHERE i.id IN (SELECT MAX(id) FROM intent_scores GROUP BY lead_id) AND i.label = 'Hot'`
    ).c;
    const aiCostToday = one(
      "SELECT COALESCE(SUM(cost_usd), 0) AS s FROM ai_usage WHERE date(at) = date('now')"
    ).s;
    const aiCostMonth = one(
      "SELECT COALESCE(SUM(cost_usd), 0) AS s FROM ai_usage WHERE strftime('%Y-%m', at) = strftime('%Y-%m', 'now')"
    ).s;
    const pausedRow = one("SELECT value FROM settings WHERE key = 'automation_paused'");
    return {
      leadsTotal,
      qualified,
      websitesGenerated,
      emailsSent,
      hotLeads,
      aiCostToday,
      aiCostMonth,
      automationPaused: pausedRow ? pausedRow.value === '1' : false,
    };
  });
}

module.exports = { register };
