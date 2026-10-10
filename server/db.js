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
    if (/ON CONFLICT DO UPDATE SET/i.test(s) && /platform_settings/i.test(s)) {
      s = s.replace(
        /ON CONFLICT DO UPDATE SET value = VALUES\(value\)/i,
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
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

async function ensureColumnMysql(conn, table, column, definition) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (Number(rows[0].c) === 0) {
    await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }
}

async function ensureColumnSqlite(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

async function migrate() {
  if (DRIVER === 'sqlite') {
    const schemaPath = path.join(__dirname, '..', 'sql', 'schema.sqlite.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    const db = getSqlite();
    db.exec(sql);
    try { ensureColumnSqlite(db, 'users', 'is_super_admin', 'INTEGER NOT NULL DEFAULT 0'); } catch { /* */ }
    try { ensureColumnSqlite(db, 'users', 'status', "TEXT NOT NULL DEFAULT 'active'"); } catch { /* */ }
    try { ensureColumnSqlite(db, 'users', 'last_login_at', 'TEXT'); } catch { /* */ }
    try { ensureColumnSqlite(db, 'users', 'stripe_customer_id', 'TEXT'); } catch { /* */ }
    try { ensureColumnSqlite(db, 'users', 'stripe_subscription_id', 'TEXT'); } catch { /* */ }
    try { ensureColumnSqlite(db, 'users', 'subscription_status', "TEXT NOT NULL DEFAULT 'none'"); } catch { /* */ }
    try { ensureColumnSqlite(db, 'users', 'subscription_price_id', 'TEXT'); } catch { /* */ }
    try { ensureColumnSqlite(db, 'users', 'current_period_end', 'TEXT'); } catch { /* */ }
    try { ensureColumnSqlite(db, 'users', 'deleted_at', 'TEXT'); } catch { /* */ }
    db.exec(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        key TEXT NOT NULL PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS platform_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id INTEGER,
        action TEXT NOT NULL,
        detail TEXT,
        at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        stripe_invoice_id TEXT,
        stripe_payment_intent_id TEXT,
        stripe_charge_id TEXT,
        amount_cents INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'usd',
        status TEXT NOT NULL DEFAULT 'open',
        description TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS refunds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payment_id INTEGER,
        user_id INTEGER,
        stripe_refund_id TEXT,
        amount_cents INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'usd',
        status TEXT NOT NULL DEFAULT 'succeeded',
        reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS workspace_invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER NOT NULL,
        email TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        token_hash TEXT NOT NULL UNIQUE,
        invited_by INTEGER,
        accepted_at TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
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
    await ensureColumnMysql(conn, 'users', 'is_super_admin', 'TINYINT(1) NOT NULL DEFAULT 0');
    await ensureColumnMysql(conn, 'users', 'status', "VARCHAR(20) NOT NULL DEFAULT 'active'");
    await ensureColumnMysql(conn, 'users', 'last_login_at', 'DATETIME NULL');
    await ensureColumnMysql(conn, 'users', 'stripe_customer_id', 'VARCHAR(120) NULL');
    await ensureColumnMysql(conn, 'users', 'stripe_subscription_id', 'VARCHAR(120) NULL');
    await ensureColumnMysql(conn, 'users', 'subscription_status', "VARCHAR(40) NOT NULL DEFAULT 'none'");
    await ensureColumnMysql(conn, 'users', 'subscription_price_id', 'VARCHAR(120) NULL');
    await ensureColumnMysql(conn, 'users', 'current_period_end', 'DATETIME NULL');
    await ensureColumnMysql(conn, 'users', 'deleted_at', 'DATETIME NULL');
    await conn.query(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        \`key\` VARCHAR(120) NOT NULL PRIMARY KEY,
        value MEDIUMTEXT NOT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS platform_audit (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        actor_user_id BIGINT UNSIGNED NULL,
        action VARCHAR(80) NOT NULL,
        detail TEXT NULL,
        at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_platform_audit_at (at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NULL,
        stripe_invoice_id VARCHAR(120) NULL,
        stripe_payment_intent_id VARCHAR(120) NULL,
        stripe_charge_id VARCHAR(120) NULL,
        amount_cents INT NOT NULL DEFAULT 0,
        currency VARCHAR(12) NOT NULL DEFAULT 'usd',
        status VARCHAR(40) NOT NULL DEFAULT 'open',
        description TEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_payments_invoice (stripe_invoice_id),
        KEY idx_payments_user (user_id),
        KEY idx_payments_charge (stripe_charge_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS refunds (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        payment_id BIGINT UNSIGNED NULL,
        user_id BIGINT UNSIGNED NULL,
        stripe_refund_id VARCHAR(120) NULL,
        amount_cents INT NOT NULL DEFAULT 0,
        currency VARCHAR(12) NOT NULL DEFAULT 'usd',
        status VARCHAR(40) NOT NULL DEFAULT 'succeeded',
        reason VARCHAR(80) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_refunds_stripe (stripe_refund_id),
        KEY idx_refunds_user (user_id),
        KEY idx_refunds_payment (payment_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        token_hash CHAR(64) NOT NULL,
        expires_at DATETIME NOT NULL,
        used_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_prt_hash (token_hash),
        KEY idx_prt_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS workspace_invites (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        workspace_id BIGINT UNSIGNED NOT NULL,
        email VARCHAR(254) NOT NULL,
        role ENUM('owner','admin','member') NOT NULL DEFAULT 'member',
        token_hash CHAR(64) NOT NULL,
        invited_by BIGINT UNSIGNED NULL,
        accepted_at DATETIME NULL,
        expires_at DATETIME NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_invite_hash (token_hash),
        KEY idx_invite_ws (workspace_id),
        KEY idx_invite_email (email)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
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
