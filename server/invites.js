'use strict';

const crypto = require('crypto');
const { query, driver } = require('./db');
const { staffUrl } = require('./appUrls');
const { sendPlatformMail } = require('./mailer');

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function createInvite({ workspaceId, email, role, invitedBy }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    throw Object.assign(new Error('Valid email required'), { code: 'INVALID_EMAIL' });
  }
  const r = ['owner', 'admin', 'member'].includes(role) ? role : 'member';
  const raw = crypto.randomBytes(24).toString('hex');
  const tokenHash = hashToken(raw);
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const expiresSql = expires.toISOString().slice(0, 19).replace('T', ' ');

  await query(
    `INSERT INTO workspace_invites (workspace_id, email, role, token_hash, invited_by, expires_at)
     VALUES (:workspaceId, :email, :role, :tokenHash, :invitedBy, :expiresAt)`,
    {
      workspaceId: Number(workspaceId),
      email: cleanEmail,
      role: r,
      tokenHash,
      invitedBy: invitedBy || null,
      expiresAt: expiresSql,
    }
  );

  const link = staffUrl(`invite/${encodeURIComponent(raw)}`);
  let emailed = false;
  try {
    await sendPlatformMail({
      to: cleanEmail,
      subject: 'You are invited to Bitpype',
      title: 'Workspace invite',
      paragraphs: [
        'You have been invited to a Bitpype workspace.',
        'This link expires in 7 days.',
      ],
      cta: { url: link, label: 'Accept invite' },
      text: `You have been invited to a Bitpype workspace.\n\nAccept invite: ${link}\n\nThis link expires in 7 days.`,
    });
    emailed = true;
  } catch (e) {
    if (e.code !== 'SMTP_NOT_CONFIGURED') console.warn('[invites] email:', e.message);
  }

  return { email: cleanEmail, role: r, link: emailed ? undefined : link, emailed, expiresAt: expiresSql };
}

async function listInvites(workspaceId) {
  return query(
    `SELECT id, email, role, accepted_at, expires_at, created_at, invited_by
     FROM workspace_invites
     WHERE workspace_id = :workspaceId
     ORDER BY id DESC LIMIT 100`,
    { workspaceId: Number(workspaceId) }
  );
}

async function acceptInvite(rawToken, userId) {
  const tokenHash = hashToken(rawToken);
  const rows = await query(
    `SELECT * FROM workspace_invites WHERE token_hash = :tokenHash LIMIT 1`,
    { tokenHash }
  );
  const invite = rows[0];
  if (!invite) throw Object.assign(new Error('INVITE_NOT_FOUND'), { code: 'INVITE_NOT_FOUND' });
  if (invite.accepted_at) throw Object.assign(new Error('INVITE_ALREADY_USED'), { code: 'INVITE_ALREADY_USED' });
  const exp = new Date(String(invite.expires_at).replace(' ', 'T') + 'Z');
  if (Number.isFinite(exp.getTime()) && exp.getTime() < Date.now()) {
    throw Object.assign(new Error('INVITE_EXPIRED'), { code: 'INVITE_EXPIRED' });
  }

  const userRows = await query('SELECT id, email FROM users WHERE id = :id LIMIT 1', { id: Number(userId) });
  const user = userRows[0];
  if (!user) throw Object.assign(new Error('AUTH_REQUIRED'), { code: 'AUTH_REQUIRED' });
  if (String(user.email).toLowerCase() !== String(invite.email).toLowerCase()) {
    throw Object.assign(new Error('Invite email does not match your account'), { code: 'EMAIL_MISMATCH' });
  }

  await query(
    'DELETE FROM workspace_members WHERE workspace_id = :workspaceId AND user_id = :userId',
    { workspaceId: invite.workspace_id, userId: user.id }
  );
  await query(
    'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (:workspaceId, :userId, :role)',
    { workspaceId: invite.workspace_id, userId: user.id, role: invite.role }
  );
  await query(
    driver() === 'sqlite'
      ? "UPDATE workspace_invites SET accepted_at = datetime('now') WHERE id = :id"
      : 'UPDATE workspace_invites SET accepted_at = CURRENT_TIMESTAMP WHERE id = :id',
    { id: invite.id }
  );

  return { workspaceId: invite.workspace_id, role: invite.role };
}

module.exports = { createInvite, listInvites, acceptInvite, hashToken };
