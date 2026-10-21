'use strict';

const express = require('express');
const { query } = require('../db');
const { logActivity } = require('../workspace');
const { requireWorkspace } = require('../middleware');

const router = express.Router();
router.use(requireWorkspace);

function mapJob(row) {
  if (!row) return null;
  const parse = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return v; }
  };
  return {
    ...row,
    brief: parse(row.brief),
    delivery: parse(row.delivery),
    review: parse(row.review),
  };
}

router.get('/pending', async (req, res, next) => {
  try {
    const waiting = await query(
      `SELECT id, type, title, status, updated_at FROM design_jobs
       WHERE workspace_id = :workspaceId AND status IN ('waiting_on_agent','questions_pending')
       ORDER BY updated_at ASC LIMIT 50`,
      { workspaceId: req.auth.workspaceId }
    );
    const counts = {
      waiting_on_agent: waiting.filter((j) => j.status === 'waiting_on_agent').length,
      questions_pending: waiting.filter((j) => j.status === 'questions_pending').length,
    };
    res.json({
      ok: true,
      data: {
        total: waiting.length,
        counts,
        preview: waiting.slice(0, 10),
      },
    });
  } catch (e) {
    next(e);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const status = String(req.query.status || '').trim();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const params = { workspaceId: req.auth.workspaceId };
    let where = 'workspace_id = :workspaceId';
    if (status) {
      where += ' AND status = :status';
      params.status = status;
    }
    const rows = await query(
      `SELECT id, lead_id, type, title, status, site_shape, contact_email, created_at, updated_at,
              (delivery IS NOT NULL) AS has_delivery
       FROM design_jobs WHERE ${where} ORDER BY updated_at DESC LIMIT ${limit}`,
      params
    );
    res.json({ ok: true, data: { jobs: rows } });
  } catch (e) {
    next(e);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const rows = await query(
      'SELECT * FROM design_jobs WHERE id = :id AND workspace_id = :workspaceId LIMIT 1',
      { id, workspaceId: req.auth.workspaceId }
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    const questions = await query(
      'SELECT * FROM design_questions WHERE job_id = :id AND workspace_id = :workspaceId ORDER BY id',
      { id, workspaceId: req.auth.workspaceId }
    );
    res.json({ ok: true, data: { job: mapJob(rows[0]), questions } });
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const type = String(b.type || 'website').slice(0, 40);
    const title = String(b.title || '').trim();
    const instructions = String(b.instructions || '').trim();
    if (!title || !instructions) {
      return res.status(400).json({ ok: false, error: 'title and instructions required' });
    }
    await query(
      `INSERT INTO design_jobs (
        workspace_id, lead_id, type, title, instructions, status, site_shape, contact_email
      ) VALUES (
        :workspaceId, :leadId, :type, :title, :instructions, 'waiting_on_agent', :siteShape, :contactEmail
      )`,
      {
        workspaceId: req.auth.workspaceId,
        leadId: b.leadId || null,
        type,
        title,
        instructions,
        siteShape: b.site_shape || b.siteShape || null,
        contactEmail: b.contactEmail || b.contact_email || null,
      }
    );
    const job = (await query(
      `SELECT * FROM design_jobs WHERE workspace_id = :workspaceId ORDER BY id DESC LIMIT 1`,
      { workspaceId: req.auth.workspaceId }
    ))[0];
    await logActivity(req.auth.workspaceId, 'design', `Design job queued #${job.id}: ${title}`);
    res.status(201).json({ ok: true, data: { job: mapJob(job) } });
  } catch (e) {
    next(e);
  }
});

router.post('/next', async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT * FROM design_jobs
       WHERE workspace_id = :workspaceId AND status = 'waiting_on_agent'
       ORDER BY updated_at ASC LIMIT 1`,
      { workspaceId: req.auth.workspaceId }
    );
    if (!rows[0]) return res.json({ ok: true, data: { job: null } });
    await query(
      `UPDATE design_jobs SET status = 'in_progress' WHERE id = :id AND workspace_id = :workspaceId`,
      { id: rows[0].id, workspaceId: req.auth.workspaceId }
    );
    rows[0].status = 'in_progress';
    res.json({ ok: true, data: { job: mapJob(rows[0]) } });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/deliver', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const payload = req.body && req.body.payload;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ ok: false, error: 'payload object required' });
    }
    const result = await query(
      `UPDATE design_jobs
       SET status = 'delivered', delivery = CAST(:delivery AS JSON), site_shape = COALESCE(:siteShape, site_shape)
       WHERE id = :id AND workspace_id = :workspaceId`,
      {
        id,
        workspaceId: req.auth.workspaceId,
        delivery: JSON.stringify(payload),
        siteShape: req.body.site_shape || req.body.siteShape || null,
      }
    );
    if (!result.affectedRows) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    await logActivity(req.auth.workspaceId, 'design', `Design delivered #${id}`);
    const job = (await query(
      'SELECT * FROM design_jobs WHERE id = :id AND workspace_id = :workspaceId',
      { id, workspaceId: req.auth.workspaceId }
    ))[0];
    res.json({ ok: true, data: { job: mapJob(job) } });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/ask', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const question = String((req.body && req.body.question) || '').trim();
    if (!question) return res.status(400).json({ ok: false, error: 'question required' });
    const job = (await query(
      'SELECT id FROM design_jobs WHERE id = :id AND workspace_id = :workspaceId',
      { id, workspaceId: req.auth.workspaceId }
    ))[0];
    if (!job) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    await query(
      `INSERT INTO design_questions (workspace_id, job_id, question)
       VALUES (:workspaceId, :id, :question)`,
      { workspaceId: req.auth.workspaceId, id, question }
    );
    await query(
      `UPDATE design_jobs SET status = 'questions_pending' WHERE id = :id AND workspace_id = :workspaceId`,
      { id, workspaceId: req.auth.workspaceId }
    );
    res.json({ ok: true, data: { id } });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
