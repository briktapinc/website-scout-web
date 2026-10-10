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
      return cb(null, JSON.parse(row.data));
    } catch (e) {
      return cb(e);
    }
  }

  async set(sid, sess, cb) {
    try {
      const maxAge = sess.cookie && sess.cookie.maxAge ? sess.cookie.maxAge : 86400000;
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
    return this.set(sid, sess, cb);
  }
}

module.exports = { MySQLSessionStore: DbSessionStore, DbSessionStore };
