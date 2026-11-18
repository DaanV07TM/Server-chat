'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

let pool = null;
const MIGRATION_VERSION = 1;
const MIGRATION_FILE = path.join(__dirname, 'migrations', '001_account_persistence.sql');

function isEnabled() {
  return Boolean(pool);
}

function postgresSslOptions(connectionString) {
  let mode = String(process.env.PGSSLMODE || '').trim().toLowerCase();
  if (!mode) {
    try {
      mode = new URL(connectionString).searchParams.get('sslmode') || '';
    } catch (_) {
      mode = '';
    }
  }
  mode = mode.toLowerCase();
  if (!mode || mode === 'disable') return false;
  if (mode === 'verify-ca' || mode === 'verify-full') return { rejectUnauthorized: true };
  // Render external connection strings use sslmode=require. TLS is enabled, while
  // certificate/hostname verification can be enabled explicitly with verify-full.
  return { rejectUnauthorized: false };
}

async function initialize() {
  if (pool) return true;
  const connectionString = String(process.env.DATABASE_URL || '').trim();
  if (!connectionString) {
    console.info('[database] DATABASE_URL is not set; account storage remains memory-only.');
    return false;
  }

  const candidate = new Pool({
    connectionString,
    ssl: postgresSslOptions(connectionString),
    max: Math.max(2, Math.min(20, Number.parseInt(process.env.PGPOOL_MAX || '10', 10) || 10)),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    application_name: 'server-chat'
  });
  candidate.on('error', error => {
    const code = error && error.code ? error.code : 'unknown';
    console.error('[database] Idle PostgreSQL connection error (' + code + ').');
  });

  try {
    const client = await candidate.connect();
    try {
      await client.query('BEGIN');
      // Serialize startup migrations if more than one app instance starts together.
      await client.query('SELECT pg_advisory_xact_lock($1)', [731182026]);
      await client.query('CREATE TABLE IF NOT EXISTS server_chat_schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
      const applied = await client.query(
        'SELECT version FROM server_chat_schema_migrations WHERE version = $1',
        [MIGRATION_VERSION]
      );
      if (!applied.rowCount) {
        const migration = fs.readFileSync(MIGRATION_FILE, 'utf8');
        await client.query(migration);
        await client.query(
          'INSERT INTO server_chat_schema_migrations (version, name) VALUES ($1, $2)',
          [MIGRATION_VERSION, 'account-and-session-persistence']
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    await candidate.query('SELECT 1');
    pool = candidate;
    console.info('[database] PostgreSQL connected; account and session persistence is enabled.');
    return true;
  } catch (error) {
    await candidate.end().catch(() => {});
    const code = error && error.code ? error.code : 'unknown';
    const wrapped = new Error('PostgreSQL initialization failed (' + code + '). Check DATABASE_URL, SSL mode and database availability.');
    wrapped.cause = error;
    throw wrapped;
  }
}

function requirePool() {
  if (!pool) throw new Error('PostgreSQL is not initialized.');
  return pool;
}

async function saveAccount(account) {
  if (!pool) return;
  await requirePool().query(
    'INSERT INTO server_chat_accounts ' +
    '(account_key, username, password_salt, password_hash, account_token, created_at_ms, legal_accepted_at_ms, legal_terms_version) ' +
    'VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ' +
    'ON CONFLICT (account_key) DO UPDATE SET username = EXCLUDED.username, password_salt = EXCLUDED.password_salt, ' +
    'password_hash = EXCLUDED.password_hash, account_token = EXCLUDED.account_token, ' +
    'legal_accepted_at_ms = EXCLUDED.legal_accepted_at_ms, legal_terms_version = EXCLUDED.legal_terms_version',
    [
      account.key,
      account.username,
      account.salt,
      account.passwordHash,
      account.token,
      Number(account.createdAt),
      Number(account.legalAcceptedAt),
      account.legalTermsVersion
    ]
  );
}

async function loadAccounts(limit = 2000) {
  if (!pool) return [];
  const result = await requirePool().query(
    'SELECT account_key, username, password_salt, password_hash, account_token, ' +
    'created_at_ms, legal_accepted_at_ms, legal_terms_version ' +
    'FROM server_chat_accounts ORDER BY created_at_ms DESC LIMIT $1',
    [Math.max(1, Math.min(2000, Number(limit) || 2000))]
  );
  return result.rows.map(row => ({
    key: row.account_key,
    username: row.username,
    salt: row.password_salt,
    passwordHash: row.password_hash,
    token: row.account_token,
    createdAt: Number(row.created_at_ms),
    legalAcceptedAt: Number(row.legal_accepted_at_ms),
    legalTermsVersion: row.legal_terms_version
  }));
}

async function saveSession(sessionHash, accountKey, createdAt = Date.now()) {
  if (!pool) return;
  if (!/^[a-f0-9]{64}$/.test(String(sessionHash || ''))) throw new Error('Invalid session-token hash.');
  await requirePool().query(
    'INSERT INTO server_chat_sessions (session_hash, account_key, created_at_ms) VALUES ($1, $2, $3) ' +
    'ON CONFLICT (session_hash) DO UPDATE SET account_key = EXCLUDED.account_key',
    [sessionHash, accountKey, Number(createdAt)]
  );
}

async function loadSessions(limit = 10000) {
  if (!pool) return [];
  const result = await requirePool().query(
    'SELECT session_hash, account_key FROM server_chat_sessions ORDER BY created_at_ms ASC LIMIT $1',
    [Math.max(1, Math.min(10000, Number(limit) || 10000))]
  );
  return result.rows.map(row => ({ sessionHash: row.session_hash, accountKey: row.account_key }));
}

async function updateAccountPassword(account, exceptSessionHash) {
  if (!pool) return;
  const client = await requirePool().connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      'UPDATE server_chat_accounts SET password_salt = $2, password_hash = $3 WHERE account_key = $1',
      [account.key, account.salt, account.passwordHash]
    );
    if (!updated.rowCount) throw new Error('Account record was not found during password update.');
    await client.query(
      'DELETE FROM server_chat_sessions WHERE account_key = $1 AND session_hash <> $2',
      [account.key, exceptSessionHash]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function deleteSession(sessionHash) {
  if (!pool) return;
  if (!/^[a-f0-9]{64}$/.test(String(sessionHash || ''))) return;
  await requirePool().query('DELETE FROM server_chat_sessions WHERE session_hash = $1', [sessionHash]);
}

async function deleteSessionsForAccount(accountKey, exceptSessionHash = '') {
  if (!pool) return;
  if (exceptSessionHash) {
    await requirePool().query(
      'DELETE FROM server_chat_sessions WHERE account_key = $1 AND session_hash <> $2',
      [accountKey, exceptSessionHash]
    );
  } else {
    await requirePool().query('DELETE FROM server_chat_sessions WHERE account_key = $1', [accountKey]);
  }
}

async function deleteAccount(accountKey) {
  if (!pool) return;
  await requirePool().query('DELETE FROM server_chat_accounts WHERE account_key = $1', [accountKey]);
}

async function close() {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}

module.exports = {
  close,
  deleteAccount,
  deleteSession,
  deleteSessionsForAccount,
  initialize,
  isEnabled,
  loadAccounts,
  loadSessions,
  saveAccount,
  saveSession,
  updateAccountPassword
};
