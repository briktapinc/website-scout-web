'use strict';

const express = require('express');
const { query } = require('../db');
const { logActivity } = require('../workspace');
const { requireWorkspace } = require('../middleware');

const router = express.Router();
router.use(requireWorkspace);

function parseJsonField(v, fallback) {
  if (v == null || v === '') return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

function mapLead(row) {
  if (!row) return null;
  return {
    ...row,
    tags: parseJsonField(row.tags, []),
    hours: parseJsonField(row.hours, null),
    services: parseJsonField(row.services, null),
    social_links: parseJsonField(row.social_links, null),
    qualified: !!row.qualified,
  };
}

router.get('/', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const params = { workspaceId: req.auth.workspaceId, limit };
    let where = 'workspace_id = :workspaceId';
    if (status) {
      where += ' AND status = :status';
      params.status = status;
    }
    if (q) {
      where += ' AND (business_name LIKE :q OR email LIKE :q OR city LIKE :q OR category LIKE :q)';
      params.q = `%${q}%`;
    }
    const rows = await query(
      `SELECT * FROM leads WHERE ${where} ORDER BY updated_at DESC LIMIT ${limit}`,
      params
    );
    res.json({ ok: true, data: { leads: rows.map(mapLead) } });
  } catch (e) {
    next(e);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const rows = await query(
      'SELECT * FROM leads WHERE id = :id AND workspace_id = :workspaceId LIMIT 1',
      { id, workspaceId: req.auth.workspaceId }
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    const facts = await query(
      'SELECT * FROM business_facts WHERE lead_id = :id AND workspace_id = :workspaceId ORDER BY id DESC LIMIT 100',
      { id, workspaceId: req.auth.workspaceId }
    );
    const scores = await query(
      'SELECT * FROM lead_scores WHERE lead_id = :id AND workspace_id = :workspaceId ORDER BY id DESC LIMIT 5',
      { id, workspaceId: req.auth.workspaceId }
    );
    res.json({ ok: true, data: { lead: mapLead(rows[0]), facts, scores } });
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const business_name = String(b.business_name || '').trim();
    if (!business_name) return res.status(400).json({ ok: false, error: 'business_name required' });
    const tags = JSON.stringify(Array.isArray(b.tags) ? b.tags : []);
    const result = await query(
      `INSERT INTO leads (
        workspace_id, business_name, category, phone, email, website, address, city, state,
        postal_code, country, description, notes, status, tags, lead_group, source
      ) VALUES (
        :workspaceId, :business_name, :category, :phone, :email, :website, :address, :city, :state,
        :postal_code, :country, :description, :notes, :status, CAST(:tags AS JSON), :lead_group, :source
      )`,
      {
        workspaceId: req.auth.workspaceId,
        business_name,
        category: b.category || null,
        phone: b.phone || null,
        email: b.email || null,
        website: b.website || null,
        address: b.address || null,
        city: b.city || null,
        state: b.state || null,
        postal_code: b.postal_code || null,
        country: b.country || 'US',
        description: b.description || null,
        notes: b.notes || null,
        status: b.status || 'new',
        tags,
        lead_group: b.group || b.lead_group || null,
        source: b.source || 'web',
      }
    );
    // mysql2 execute with named placeholders may not return insertId the same way
    const insertId = result.insertId || (await query(
      'SELECT id FROM leads WHERE workspace_id = :workspaceId AND business_name = :business_name ORDER BY id DESC LIMIT 1',
      { workspaceId: req.auth.workspaceId, business_name }
    ))[0].id;

    await logActivity(req.auth.workspaceId, 'leads', `Lead created: ${business_name} (#${insertId})`);
    const lead = (await query(
      'SELECT * FROM leads WHERE id = :id AND workspace_id = :workspaceId',
      { id: insertId, workspaceId: req.auth.workspaceId }
    ))[0];
    res.status(201).json({ ok: true, data: { lead: mapLead(lead) } });
  } catch (e) {
    next(e);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = (await query(
      'SELECT id FROM leads WHERE id = :id AND workspace_id = :workspaceId',
      { id, workspaceId: req.auth.workspaceId }
    ))[0];
    if (!existing) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

    const b = req.body || {};
    const fields = [];
    const params = { id, workspaceId: req.auth.workspaceId };
    const map = [
      'business_name', 'category', 'phone', 'email', 'website', 'address', 'city', 'state',
      'postal_code', 'country', 'description', 'notes', 'status', 'source',
    ];
    for (const k of map) {
      if (b[k] !== undefined) {
        fields.push(`${k} = :${k}`);
        params[k] = b[k];
      }
    }
    if (b.group !== undefined || b.lead_group !== undefined) {
      fields.push('lead_group = :lead_group');
      params.lead_group = b.group != null ? b.group : b.lead_group;
    }
    if (b.tags !== undefined) {
      fields.push('tags = CAST(:tags AS JSON)');
      params.tags = JSON.stringify(Array.isArray(b.tags) ? b.tags : []);
    }
    if (b.qualified !== undefined) {
      fields.push('qualified = :qualified');
      params.qualified = b.qualified ? 1 : 0;
    }
    if (b.qualification_note !== undefined) {
      fields.push('qualification_note = :qualification_note');
      params.qualification_note = b.qualification_note;
    }
    if (!fields.length) return res.status(400).json({ ok: false, error: 'No fields to update' });

    await query(
      `UPDATE leads SET ${fields.join(', ')} WHERE id = :id AND workspace_id = :workspaceId`,
      params
    );
    const lead = (await query(
      'SELECT * FROM leads WHERE id = :id AND workspace_id = :workspaceId',
      { id, workspaceId: req.auth.workspaceId }
    ))[0];
    res.json({ ok: true, data: { lead: mapLead(lead) } });
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const result = await query(
      'DELETE FROM leads WHERE id = :id AND workspace_id = :workspaceId',
      { id, workspaceId: req.auth.workspaceId }
    );
    if (!result.affectedRows) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    await logActivity(req.auth.workspaceId, 'leads', `Lead deleted #${id}`);
    res.json({ ok: true, data: { id } });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/qualify', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const note = req.body && req.body.note != null ? String(req.body.note) : null;
    const result = await query(
      `UPDATE leads SET qualified = 1, status = 'qualified', qualification_note = :note
       WHERE id = :id AND workspace_id = :workspaceId`,
      { id, workspaceId: req.auth.workspaceId, note }
    );
    if (!result.affectedRows) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    res.json({ ok: true, data: { id, qualified: true } });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/score', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const lead = (await query(
      'SELECT * FROM leads WHERE id = :id AND workspace_id = :workspaceId',
      { id, workspaceId: req.auth.workspaceId }
    ))[0];
    if (!lead) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

    let score = 20;
    const breakdown = { base: 20 };
    if (lead.email) { score += 15; breakdown.email = 15; }
    if (lead.phone) { score += 10; breakdown.phone = 10; }
    if (lead.website) { score += 10; breakdown.website = 10; }
    if (lead.city) { score += 5; breakdown.city = 5; }
    if (Number(lead.rating) >= 4) { score += 15; breakdown.rating = 15; }
    if (Number(lead.review_count) >= 20) { score += 10; breakdown.reviews = 10; }
    score = Math.min(100, score);

    await query(
      'UPDATE leads SET score = :score WHERE id = :id AND workspace_id = :workspaceId',
      { score, id, workspaceId: req.auth.workspaceId }
    );
    await query(
      `INSERT INTO lead_scores (workspace_id, lead_id, score, breakdown)
       VALUES (:workspaceId, :id, :score, CAST(:breakdown AS JSON))`,
      { workspaceId: req.auth.workspaceId, id, score, breakdown: JSON.stringify(breakdown) }
    );
    res.json({ ok: true, data: { id, score, breakdown } });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
