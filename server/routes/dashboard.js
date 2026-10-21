'use strict';

/**
 * DEPRECATED — do not mount. Product dashboard uses workspace SQLite via domainApi.
 * This module queries MySQL product tables that are not the runtime source of truth.
 */

const express = require('express');
const { query } = require('../db');
const { getSetting } = require('../workspace');
const { requireWorkspace } = require('../middleware');

const router = express.Router();
router.use(requireWorkspace);

router.get('/stats', async (req, res, next) => {
  try {
    const ws = req.auth.workspaceId;
    const leadCounts = await query(
      `SELECT status, COUNT(*) AS c FROM leads WHERE workspace_id = :ws GROUP BY status`,
      { ws }
    );
    const byStatus = {};
    let leadsTotal = 0;
    for (const r of leadCounts) {
      byStatus[r.status] = Number(r.c);
      leadsTotal += Number(r.c);
    }
    const websites = (await query(
      'SELECT COUNT(*) AS c FROM websites WHERE workspace_id = :ws',
      { ws }
    ))[0].c;
    const designWaiting = (await query(
      `SELECT COUNT(*) AS c FROM design_jobs WHERE workspace_id = :ws AND status = 'waiting_on_agent'`,
      { ws }
    ))[0].c;
    const designQuestions = (await query(
      `SELECT COUNT(*) AS c FROM design_jobs WHERE workspace_id = :ws AND status = 'questions_pending'`,
      { ws }
    ))[0].c;
    const jobsEnabled = (await query(
      'SELECT COUNT(*) AS c FROM scheduled_jobs WHERE workspace_id = :ws AND enabled = 1',
      { ws }
    ))[0].c;
    const aiToday = (await query(
      `SELECT ROUND(COALESCE(SUM(cost_usd),0),4) AS c FROM ai_usage
       WHERE workspace_id = :ws AND DATE(at) = UTC_DATE()`,
      { ws }
    ))[0].c;
    const paused = (await getSetting(ws, 'automation_paused', '0')) === '1';
    const activity = await query(
      `SELECT id, area, message, at FROM activity_log WHERE workspace_id = :ws ORDER BY id DESC LIMIT 15`,
      { ws }
    );

    res.json({
      ok: true,
      data: {
        leadsTotal,
        byStatus,
        websites: Number(websites),
        designJobsWaitingOnAgent: Number(designWaiting),
        designJobsQuestionsPending: Number(designQuestions),
        jobsEnabled: Number(jobsEnabled),
        aiSpendTodayUsd: Number(aiToday),
        automationPaused: paused,
        activity,
        workspace: {
          id: req.auth.workspaceId,
          name: req.auth.workspace.name,
          slug: req.auth.workspace.slug,
          role: req.auth.role,
        },
      },
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
