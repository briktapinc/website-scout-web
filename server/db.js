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
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
    try { ensureColumnSqlite(db, 'users', 'billing_plan', "TEXT NOT NULL DEFAULT 'free'"); } catch { /* */ }
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
      CREATE TABLE IF NOT EXISTS client_portal_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        workspace_id INTEGER NOT NULL,
        lead_id INTEGER NOT NULL,
        business_name TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        last_login_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS client_portal_login_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        portal_user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS credit_balances (
        workspace_id INTEGER NOT NULL PRIMARY KEY,
        balance INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS credit_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER NOT NULL,
        user_id INTEGER,
        delta INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        ref_type TEXT,
        ref_id TEXT,
        stripe_checkout_session_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(stripe_checkout_session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_credit_ledger_ws ON credit_ledger(workspace_id, id DESC);
      CREATE TABLE IF NOT EXISTS portal_referrals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        referrer_portal_user_id INTEGER NOT NULL,
        referrer_workspace_id INTEGER NOT NULL,
        referrer_lead_id INTEGER,
        referred_name TEXT NOT NULL DEFAULT '',
        referred_email TEXT,
        referred_phone TEXT,
        referred_business_name TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        linked_lead_id INTEGER,
        linked_portal_user_id INTEGER,
        linked_user_id INTEGER,
        plan_id TEXT,
        plan_amount_cents INTEGER,
        credits_awarded INTEGER NOT NULL DEFAULT 0,
        credited_at TEXT,
        stripe_subscription_id TEXT,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_portal_referrals_referrer ON portal_referrals(referrer_portal_user_id);
      CREATE INDEX IF NOT EXISTS idx_portal_referrals_ws ON portal_referrals(referrer_workspace_id);
      CREATE INDEX IF NOT EXISTS idx_portal_referrals_email ON portal_referrals(referred_email);
      CREATE INDEX IF NOT EXISTS idx_portal_referrals_status ON portal_referrals(status);
      CREATE TABLE IF NOT EXISTS stripe_events (
        event_id TEXT NOT NULL PRIMARY KEY,
        type TEXT NOT NULL DEFAULT '',
        processed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS upsell_tips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        feature_key TEXT NOT NULL DEFAULT '',
        target_plans TEXT NOT NULL DEFAULT 'free',
        enabled INTEGER NOT NULL DEFAULT 1,
        frequency_hours INTEGER NOT NULL DEFAULT 72,
        weight INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        cta_label TEXT NOT NULL DEFAULT 'Upgrade',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS upsell_tip_impressions (
        portal_user_id INTEGER NOT NULL,
        tip_id INTEGER NOT NULL,
        last_shown_at TEXT NOT NULL,
        show_count INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (portal_user_id, tip_id)
      );
      CREATE TABLE IF NOT EXISTS mcp_oauth_auth_codes (
        code TEXT NOT NULL PRIMARY KEY,
        payload_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mcp_oauth_refresh_tokens (
        token_hash TEXT NOT NULL PRIMARY KEY,
        payload_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
        client_id TEXT NOT NULL PRIMARY KEY,
        payload_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_exp ON mcp_oauth_auth_codes(expires_at);
      CREATE INDEX IF NOT EXISTS idx_mcp_oauth_refresh_exp ON mcp_oauth_refresh_tokens(expires_at);
      CREATE INDEX IF NOT EXISTS idx_mcp_oauth_clients_exp ON mcp_oauth_clients(expires_at);
    `);
    try { ensureColumnSqlite(db, 'workspace_tokens', 'lead_id', 'INTEGER'); } catch { /* */ }
    ensureColumnSqlite(db, 'job_runs', 'trigger_source', "TEXT NOT NULL DEFAULT 'legacy'");
    ensureColumnSqlite(db, 'job_runs', 'triggered_by', "TEXT NOT NULL DEFAULT 'unknown'");
    ensureColumnSqlite(db, 'workspace_tokens', 'expires_at', 'INTEGER');
    ensureColumnSqlite(db, 'workspace_tokens', 'oauth_user_id', 'INTEGER');
    await require('./oauthTokenPolicy').backfill(query);
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
    await ensureColumnMysql(conn, 'users', 'billing_plan', "VARCHAR(40) NOT NULL DEFAULT 'free'");
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
    await conn.query(`
      CREATE TABLE IF NOT EXISTS client_portal_users (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(254) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        workspace_id BIGINT UNSIGNED NOT NULL,
        lead_id BIGINT UNSIGNED NOT NULL,
        business_name VARCHAR(200) NOT NULL DEFAULT '',
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        last_login_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_client_portal_email (email),
        KEY idx_client_portal_ws_lead (workspace_id, lead_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS client_portal_login_tokens (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        portal_user_id BIGINT UNSIGNED NOT NULL,
        token_hash CHAR(64) NOT NULL,
        expires_at DATETIME NOT NULL,
        used_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_cpl_hash (token_hash),
        KEY idx_cpl_user (portal_user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS credit_balances (
        workspace_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
        balance INT NOT NULL DEFAULT 0,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS credit_ledger (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        workspace_id BIGINT UNSIGNED NOT NULL,
        user_id BIGINT UNSIGNED NULL,
        delta INT NOT NULL,
        balance_after INT NOT NULL,
        reason VARCHAR(120) NOT NULL DEFAULT '',
        ref_type VARCHAR(60) NULL,
        ref_id VARCHAR(80) NULL,
        stripe_checkout_session_id VARCHAR(120) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_credit_ledger_session (stripe_checkout_session_id),
        KEY idx_credit_ledger_ws (workspace_id, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS portal_referrals (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        referrer_portal_user_id BIGINT UNSIGNED NOT NULL,
        referrer_workspace_id BIGINT UNSIGNED NOT NULL,
        referrer_lead_id BIGINT UNSIGNED NULL,
        referred_name VARCHAR(160) NOT NULL DEFAULT '',
        referred_email VARCHAR(254) NULL,
        referred_phone VARCHAR(40) NULL,
        referred_business_name VARCHAR(200) NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        linked_lead_id BIGINT UNSIGNED NULL,
        linked_portal_user_id BIGINT UNSIGNED NULL,
        linked_user_id BIGINT UNSIGNED NULL,
        plan_id VARCHAR(40) NULL,
        plan_amount_cents INT NULL,
        credits_awarded INT NOT NULL DEFAULT 0,
        credited_at DATETIME NULL,
        stripe_subscription_id VARCHAR(120) NULL,
        notes TEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_portal_referrals_referrer (referrer_portal_user_id),
        KEY idx_portal_referrals_ws (referrer_workspace_id),
        KEY idx_portal_referrals_email (referred_email),
        KEY idx_portal_referrals_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS stripe_events (
        event_id VARCHAR(120) NOT NULL PRIMARY KEY,
        type VARCHAR(80) NOT NULL DEFAULT '',
        processed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_stripe_events_type (type)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await ensureColumnMysql(conn, 'workspace_tokens', 'lead_id', 'BIGINT UNSIGNED NULL');
    await ensureColumnMysql(conn, 'job_runs', 'trigger_source', "VARCHAR(40) NOT NULL DEFAULT 'legacy'");
    await ensureColumnMysql(conn, 'job_runs', 'triggered_by', "VARCHAR(120) NOT NULL DEFAULT 'unknown'");
    await ensureColumnMysql(conn, 'workspace_tokens', 'expires_at', 'BIGINT NULL');
    await ensureColumnMysql(conn, 'workspace_tokens', 'oauth_user_id', 'BIGINT UNSIGNED NULL');
    await conn.query(`
      CREATE TABLE IF NOT EXISTS upsell_tips (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        body TEXT NOT NULL,
        feature_key VARCHAR(80) NOT NULL DEFAULT '',
        target_plans VARCHAR(80) NOT NULL DEFAULT 'free',
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        frequency_hours INT NOT NULL DEFAULT 72,
        weight INT NOT NULL DEFAULT 1,
        sort_order INT NOT NULL DEFAULT 0,
        cta_label VARCHAR(80) NOT NULL DEFAULT 'Upgrade',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_upsell_tips_enabled (enabled, sort_order)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS upsell_tip_impressions (
        portal_user_id BIGINT UNSIGNED NOT NULL,
        tip_id BIGINT UNSIGNED NOT NULL,
        last_shown_at DATETIME NOT NULL,
        show_count INT NOT NULL DEFAULT 1,
        PRIMARY KEY (portal_user_id, tip_id),
        KEY idx_upsell_imp_shown (last_shown_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_auth_codes (
        code VARCHAR(128) NOT NULL PRIMARY KEY,
        payload_json MEDIUMTEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        KEY idx_mcp_oauth_codes_exp (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_refresh_tokens (
        token_hash VARCHAR(128) NOT NULL PRIMARY KEY,
        payload_json MEDIUMTEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        KEY idx_mcp_oauth_refresh_exp (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
        client_id VARCHAR(128) NOT NULL PRIMARY KEY,
        payload_json MEDIUMTEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        KEY idx_mcp_oauth_clients_exp (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  });
  await require('./oauthTokenPolicy').backfill(query);
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
