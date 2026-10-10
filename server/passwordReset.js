'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, driver } = require('./db');
const { findUserByEmail } = require('./workspace');
const { appUrl } = require('./stripeClient');
const { sendPlatformMail } = require('./mailer');

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function requestReset(email) {
  const user = await findUserByEmail(email);
  // Always return ok to avoid email enumeration
  if (!user || String(user.status) === 'disabled') {
    return { ok: true };
  }
  const raw = crypto.randomBytes(24).toString('hex');
  const tokenHash = hashToken(raw);
  const expires = new Date(Date.now() + 60 * 60 * 1000);
  const expiresSql = expires.toISOString().slice(0, 19).replace('T', ' ');

  await query('DELETE FROM password_reset_tokens WHERE user_id = :userId', { userId: user.id });
  await query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES (:userId, :tokenHash, :expiresAt)`,
    { userId: user.id, tokenHash, expiresAt: expiresSql }
  );

  const link = `${appUrl()}/#/reset/${raw}`;
  let emailed = false;
  let devLink;
  try {
    await sendPlatformMail({
      to: user.email,
      subject: 'Reset your Website Scout password',
      html: `<p>Reset your password:</p><p><a href="${link}">${link}</a></p><p>Expires in 1 hour.</p>`,
      text: `Reset password: ${link}`,
    });
    emailed = true;
  } catch (e) {
    if (e.code === 'SMTP_NOT_CONFIGURED') {
      // Only expose the link outside production when SMTP is not configured.
      if (process.env.NODE_ENV !== 'production' || process.env.DEV_RETURN_RESET_LINK === '1') {
        devLink = link;
      } else {
        console.warn('[passwordReset] SMTP not configured; reset link not returned in production');
      }
    } else {
      console.warn('[passwordReset] email:', e.message);
    }
  }
  return { ok: true, emailed, ...(devLink ? { resetLink: devLink } : {}) };
}

async function confirmReset(rawToken, newPassword) {
  if (!newPassword || String(newPassword).length < 8) {
    throw Object.assign(new Error('password must be at least 8 characters'), { code: 'WEAK_PASSWORD' });
  }
  const tokenHash = hashToken(rawToken);
  const rows = await query(
    'SELECT * FROM password_reset_tokens WHERE token_hash = :tokenHash LIMIT 1',
    { tokenHash }
  );
  const row = rows[0];
  if (!row) throw Object.assign(new Error('INVALID_TOKEN'), { code: 'INVALID_TOKEN' });
  if (row.used_at) throw Object.assign(new Error('TOKEN_USED'), { code: 'TOKEN_USED' });
  const exp = new Date(String(row.expires_at).replace(' ', 'T') + 'Z');
  if (Number.isFinite(exp.getTime()) && exp.getTime() < Date.now()) {
    throw Object.assign(new Error('TOKEN_EXPIRED'), { code: 'TOKEN_EXPIRED' });
  }

  const hash = await bcrypt.hash(String(newPassword), 12);
  await query('UPDATE users SET password_hash = :hash WHERE id = :id', { hash, id: row.user_id });
  await query(
    driver() === 'sqlite'
      ? "UPDATE password_reset_tokens SET used_at = datetime('now') WHERE id = :id"
      : 'UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = :id',
    { id: row.id }
  );
  return { ok: true };
}

module.exports = { requestReset, confirmReset };
