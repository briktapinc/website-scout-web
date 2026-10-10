'use strict';

const fs = require('fs');
const path = require('path');

const DRIVER = String(process.env.DB_DRIVER || 'mysql').toLowerCase();

let mysqlPool = null;
let sqliteDb = null;

function mysqlConfig() {
  return {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'scout',
    password: process.env.MYSQL_PASSWORD || 'scout',
    database: process.env.MYSQL_DATABASE || 'website_scout',
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_POOL || 10),
    namedPlaceholders: true,
    timezone: 'Z',
    dateStrings: true,
  };
}

function sqlitePath() {
  return process.env.SQLITE_PATH
    || path.join(__dirname, '..', 'data', 'website-scout-web.sqlite');
}

function toSqliteSql(sql) {
  return String(sql)
    .replace(/INSERT IGNORE/gi, 'INSERT OR IGNORE')
    .replace(/UTC_TIMESTAMP\(\)/gi, "datetime('now')")
    .replace(/UTC_DATE\(\)/gi, "date('now')")
    .replace(/ON DUPLICATE KEY UPDATE/gi, 'ON CONFLICT DO UPDATE SET')
    .replace(/CAST\(:(\w+) AS JSON\)/gi, ':$1')
    .replace(/`/g, '');
}

/** Convert :name placeholders + object params to ? + ordered array for better-sqlite3. */
function bindNamed(sql, params) {
  if (!params || Array.isArray(params)) return { sql, params: params || [] };
  const names = [];
  const outSql = sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, name) => {
    names.push(name);
    return '?';
  });
  return { sql: outSql, params: names.map((n) => params[n]) };
}

function getMysqlPool() {
  if (!mysqlPool) {
    const mysql = require('mysql2/promise');
    mysqlPool = mysql.createPool(mysqlConfig());
  }
  return mysqlPool;
}

function getSqlite() {
  if (!sqliteDb) {
    const Database = require('better-sqlite3');
    const file = sqlitePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    sqliteDb = new Database(file);
    sqliteDb.pragma('journal_mode = WAL');
    sqliteDb.pragma('foreign_keys = ON');
  }
  return sqliteDb;
}

async function query(sql, params) {
  if (DRIVER === 'sqlite') {
    const db = getSqlite();
    let s = toSqliteSql(sql);
    // SQLite upsert rewrite for settings/sessions style inserts
    if (/ON CONFLICT DO UPDATE SET/i.test(s) && /workspace_settings/i.test(s)) {
      s = s.replace(
        /ON CONFLICT DO UPDATE SET value = VALUES\(value\)/i,
        'ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value'
      );
    }
    if (/ON CONFLICT DO UPDATE SET/i.test(s) && /sessions/i.test(s)) {
      s = s.replace(
        /ON CONFLICT DO UPDATE SET expires = VALUES\(expires\), data = VALUES\(data\)/i,
        'ON CONFLICT(session_id) DO UPDATE SET expires = excluded.expires, data = excluded.data'
      );
    }
    const bound = bindNamed(s, params || {});
    const trimmed = bound.sql.trim().toUpperCase();
    if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) {
      return db.prepare(bound.sql).all(...bound.params);
    }
    const info = db.prepare(bound.sql).run(...bound.params);
    return { insertId: info.lastInsertRowid, affectedRows: info.changes, changes: info.changes };
  }

  const [rows] = await getMysqlPool().execute(sql, params || {});
  return rows;
}

async function withConnection(fn) {
  if (DRIVER === 'sqlite') {
    const db = getSqlite();
    const conn = {
      beginTransaction: async () => db.exec('BEGIN'),
      commit: async () => db.exec('COMMIT'),
      rollback: async () => db.exec('ROLLBACK'),
      execute: async (sql, paramsArr) => {
        // workspace.js uses positional ? arrays with conn.execute
        const s = toSqliteSql(sql);
        const trimmed = s.trim().toUpperCase();
        if (trimmed.startsWith('SELECT')) {
          return [db.prepare(s).all(...(paramsArr || []))];
        }
        const info = db.prepare(s).run(...(paramsArr || []));
        return [{ insertId: info.lastInsertRowid, affectedRows: info.changes }];
      },
      query: async (sql) => {
        db.exec(sql);
        return [];
      },
    };
    return fn(conn);
  }

  const conn = await getMysqlPool().getConnection();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

async function migrate() {
  if (DRIVER === 'sqlite') {
    const schemaPath = path.join(__dirname, '..', 'sql', 'schema.sqlite.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    getSqlite().exec(sql);
    return;
  }

  const schemaPath = path.join(__dirname, '..', 'sql', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const statements = sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('--'));
  await withConnection(async (conn) => {
    for (const stmt of statements) {
      await conn.query(stmt);
    }
  });
}

async function ping() {
  if (DRIVER === 'sqlite') {
    getSqlite().prepare('SELECT 1').get();
    return true;
  }
  await query('SELECT 1 AS ok');
  return true;
}

function driver() {
  return DRIVER;
}

module.exports = { query, withConnection, migrate, ping, driver, sqlitePath, mysqlConfig };
