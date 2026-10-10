'use strict';

const express = require('express');
const jobs = require('../jobs');
const { query } = require('../db');
const { requireWorkspace, requireRole } = require('../middleware');

const router = express.Router();
router.use(requireWorkspace);

router.get('/', async (req, res, next) => {
  try {
    const list = await jobs.listJobs(req.auth.workspaceId);
    res.json({ ok: true, data: { jobs: list, types: jobs.JOB_TYPES } });
  } catch (e) {
    next(e);
  }
});

router.get('/:id/runs', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const runs = await query(
      `SELECT * FROM job_runs WHERE job_id = :id AND workspace_id = :workspaceId
       ORDER BY id DESC LIMIT 50`,
      { id, workspaceId: req.auth.workspaceId }
    );
    res.json({ ok: true, data: { runs } });
  } catch (e) {
    next(e);
  }
});

router.post('/', requireRole('owner', 'admin', 'member'), async (req, res, next) => {
  try {
    const job = await jobs.createJob(req.auth.workspaceId, req.body || {});
    res.status(201).json({ ok: true, data: { job } });
  } catch (e) {
    if (e.code === 'INVALID') return res.status(400).json({ ok: false, error: e.message });
    next(e);
  }
});

router.patch('/:id', requireRole('owner', 'admin', 'member'), async (req, res, next) => {
  try {
    const job = await jobs.updateJob(req.auth.workspaceId, Number(req.params.id), req.body || {});
    res.json({ ok: true, data: { job } });
  } catch (e) {
    if (e.code === 'NOT_FOUND') return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    next(e);
  }
});

router.delete('/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const data = await jobs.deleteJob(req.auth.workspaceId, Number(req.params.id));
    res.json({ ok: true, data });
  } catch (e) {
    if (e.code === 'NOT_FOUND') return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    next(e);
  }
});

router.post('/:id/run', async (req, res, next) => {
  try {
    const result = await jobs.executeJob(req.auth.workspaceId, Number(req.params.id), { force: true });
    res.json({ ok: true, data: result });
  } catch (e) {
    if (e.code === 'NOT_FOUND') return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
