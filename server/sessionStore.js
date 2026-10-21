'use strict';

const session = require('express-session');
const { query, driver } = require('./db');

class DbSessionStore extends session.Store {
  constructor() {
    super();
  }

  async get(sid, cb) {
    try {
      const rows = await query(
        'SELECT data, expires FROM sessions WHERE session_id = :sid LIMIT 1',
        { sid }
      );
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) return cb(null, null);
      if (Number(row.expires) < Date.now()) {
        await query('DELETE FROM sessions WHERE session_id = :sid', { sid });
        return cb(null, null);
      }
      let sess;
      try {
        sess = JSON.parse(row.data);
      } catch (e) {
        await query('DELETE FROM sessions WHERE session_id = :sid', { sid });
        return cb(null, null);
      }
      // Rehydrate cookie.expires so express-session rolling/maxAge math stays valid.
      if (sess && sess.cookie && typeof sess.cookie.expires === 'string') {
        sess.cookie.expires = new Date(sess.cookie.expires);
      }
      return cb(null, sess);
    } catch (e) {
      return cb(e);
    }
  }

  async set(sid, sess, cb) {
    try {
      const maxAge = sess.cookie && Number(sess.cookie.maxAge) > 0
        ? Number(sess.cookie.maxAge)
        : (sess.cookie && Number(sess.cookie.originalMaxAge) > 0
          ? Number(sess.cookie.originalMaxAge)
          : 14 * 24 * 60 * 60 * 1000);
      const expires = Date.now() + maxAge;
      const data = JSON.stringify(sess);
      if (driver() === 'sqlite') {
        await query(
          `INSERT INTO sessions (session_id, expires, data) VALUES (:sid, :expires, :data)
           ON CONFLICT(session_id) DO UPDATE SET expires = excluded.expires, data = excluded.data`,
          { sid, expires, data }
        );
      } else {
        await query(
          `INSERT INTO sessions (session_id, expires, data) VALUES (:sid, :expires, :data)
           ON DUPLICATE KEY UPDATE expires = VALUES(expires), data = VALUES(data)`,
          { sid, expires, data }
        );
      }
      cb && cb(null);
    } catch (e) {
      cb && cb(e);
    }
  }

  async destroy(sid, cb) {
    try {
      await query('DELETE FROM sessions WHERE session_id = :sid', { sid });
      cb && cb(null);
    } catch (e) {
      cb && cb(e);
    }
  }

  async touch(sid, sess, cb) {
    // Rolling expiry only — avoid rewriting the full session blob on every request.
    try {
      const maxAge = sess && sess.cookie && Number(sess.cookie.maxAge) > 0
        ? Number(sess.cookie.maxAge)
        : (sess && sess.cookie && Number(sess.cookie.originalMaxAge) > 0
          ? Number(sess.cookie.originalMaxAge)
          : 14 * 24 * 60 * 60 * 1000);
      const expires = Date.now() + maxAge;
      await query('UPDATE sessions SET expires = :expires WHERE session_id = :sid', { sid, expires });
      cb && cb(null);
    } catch (e) {
      cb && cb(e);
    }
  }
}

module.exports = { MySQLSessionStore: DbSessionStore, DbSessionStore };
