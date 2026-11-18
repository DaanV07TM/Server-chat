'use strict';

// PostgreSQL persistence for data that should survive a service restart.
// Live sockets, abuse counters, short-lived chat history and playback state remain in memory.
let pool = null;

function isEnabled() {
  return Boolean(pool);
}

async function initializeDatabase() {
  const connectionString = String(process.env.DATABASE_URL || '').trim();
  if (!connectionString) {
    return { enabled: false, accounts: [], conversations: [], shares: [] };
  }

  const { Pool } = require('pg');
  const poolOptions = {
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  };
  pool = new Pool(poolOptions);
  pool.on('error', () => {
    // Do not log connection strings or database credentials.
    console.error('[database] An idle PostgreSQL connection reported an error.');
  });

  try {
    await pool.query('SELECT 1');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        account_key TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        legal_accepted_at BIGINT NOT NULL,
        legal_terms_version TEXT NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_conversations (
        owner_key TEXT NOT NULL,
        conversation_id VARCHAR(32) NOT NULL,
        title VARCHAR(72) NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        pinned BOOLEAN NOT NULL DEFAULT FALSE,
        share_id VARCHAR(32),
        messages JSONB NOT NULL DEFAULT '[]'::jsonb,
        PRIMARY KEY (owner_key, conversation_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_shares (
        share_id VARCHAR(32) PRIMARY KEY,
        owner_key TEXT NOT NULL,
        conversation_id VARCHAR(32) NOT NULL,
        title VARCHAR(72) NOT NULL,
        messages JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        CONSTRAINT ai_shares_conversation_fk
          FOREIGN KEY (owner_key, conversation_id)
          REFERENCES ai_conversations (owner_key, conversation_id)
          ON DELETE CASCADE
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS ai_conversations_owner_updated_idx ON ai_conversations (owner_key, updated_at DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS ai_shares_expiry_idx ON ai_shares (expires_at)');
    await pool.query('DELETE FROM ai_shares WHERE expires_at <= $1', [Date.now()]);

    const [accountRows, conversationRows, shareRows] = await Promise.all([
      pool.query('SELECT account_key, username, password_salt, password_hash, created_at, legal_accepted_at, legal_terms_version FROM accounts ORDER BY created_at ASC'),
      pool.query('SELECT owner_key, conversation_id, title, created_at, updated_at, pinned, share_id, messages FROM ai_conversations ORDER BY updated_at DESC'),
      pool.query('SELECT share_id, owner_key, conversation_id, title, messages, created_at, updated_at, expires_at FROM ai_shares WHERE expires_at > $1', [Date.now()])
    ]);

    return {
      enabled: true,
      accounts: accountRows.rows.map(row => ({
        key: row.account_key,
        username: row.username,
        salt: row.password_salt,
        passwordHash: Buffer.from(row.password_hash, 'hex'),
        token: require('node:crypto').randomBytes(32).toString('hex'),
        createdAt: Number(row.created_at),
        legalAcceptedAt: Number(row.legal_accepted_at),
        legalTermsVersion: row.legal_terms_version
      })),
      conversations: conversationRows.rows.map(row => ({
        ownerKey: row.owner_key,
        conversation: {
          id: row.conversation_id,
          title: row.title,
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at),
          pinned: row.pinned === true,
          shareId: row.share_id || null,
          messages: Array.isArray(row.messages) ? row.messages : []
        }
      })),
      shares: shareRows.rows.map(row => ({
        id: row.share_id,
        ownerKey: row.owner_key,
        conversationId: row.conversation_id,
        title: row.title,
        messages: Array.isArray(row.messages) ? row.messages : [],
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        expiresAt: Number(row.expires_at)
      }))
    };
  } catch (error) {
    const failedPool = pool;
    pool = null;
    if (failedPool) await failedPool.end().catch(() => {});
    throw error;
  }
}

async function saveAccount(account) {
  if (!pool) return;
  await pool.query(`
    INSERT INTO accounts
      (account_key, username, password_salt, password_hash, created_at, legal_accepted_at, legal_terms_version)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (account_key) DO UPDATE SET
      username = EXCLUDED.username,
      password_salt = EXCLUDED.password_salt,
      password_hash = EXCLUDED.password_hash,
      legal_accepted_at = EXCLUDED.legal_accepted_at,
      legal_terms_version = EXCLUDED.legal_terms_version
  `, [
    account.key, account.username, account.salt, Buffer.from(account.passwordHash).toString('hex'),
    account.createdAt, account.legalAcceptedAt, account.legalTermsVersion
  ]);
}

async function updateAccountPassword(account) {
  if (!pool) return;
  const result = await pool.query(
    'UPDATE accounts SET password_salt = $2, password_hash = $3 WHERE account_key = $1',
    [account.key, account.salt, Buffer.from(account.passwordHash).toString('hex')]
  );
  if (result.rowCount !== 1) throw new Error('Account record was not found during password update.');
}

async function deleteAccount(accountKey) {
  if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM ai_shares WHERE owner_key = $1', [accountKey]);
    await client.query('DELETE FROM ai_conversations WHERE owner_key = $1', [accountKey]);
    await client.query('DELETE FROM accounts WHERE account_key = $1', [accountKey]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function saveAiConversation(ownerKey, conversation) {
  if (!pool) return;
  await pool.query(`
    INSERT INTO ai_conversations
      (owner_key, conversation_id, title, created_at, updated_at, pinned, share_id, messages)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    ON CONFLICT (owner_key, conversation_id) DO UPDATE SET
      title = EXCLUDED.title,
      updated_at = EXCLUDED.updated_at,
      pinned = EXCLUDED.pinned,
      share_id = EXCLUDED.share_id,
      messages = EXCLUDED.messages
  `, [
    ownerKey, conversation.id, conversation.title, conversation.createdAt, conversation.updatedAt,
    conversation.pinned === true, conversation.shareId || null, JSON.stringify(conversation.messages || [])
  ]);
}

async function saveAiShareAndConversation(share, conversation) {
  if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      INSERT INTO ai_conversations
        (owner_key, conversation_id, title, created_at, updated_at, pinned, share_id, messages)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      ON CONFLICT (owner_key, conversation_id) DO UPDATE SET
        title = EXCLUDED.title, updated_at = EXCLUDED.updated_at,
        pinned = EXCLUDED.pinned, share_id = EXCLUDED.share_id, messages = EXCLUDED.messages
    `, [
      share.ownerKey, conversation.id, conversation.title, conversation.createdAt, conversation.updatedAt,
      conversation.pinned === true, conversation.shareId || null, JSON.stringify(conversation.messages || [])
    ]);
    await client.query(`
      INSERT INTO ai_shares
        (share_id, owner_key, conversation_id, title, messages, created_at, updated_at, expires_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
      ON CONFLICT (share_id) DO UPDATE SET
        title = EXCLUDED.title, messages = EXCLUDED.messages,
        updated_at = EXCLUDED.updated_at, expires_at = EXCLUDED.expires_at
    `, [
      share.id, share.ownerKey, share.conversationId, share.title, JSON.stringify(share.messages || []),
      share.createdAt, share.updatedAt, share.expiresAt
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function deleteAiConversation(ownerKey, conversationId) {
  if (!pool) return;
  await pool.query('DELETE FROM ai_conversations WHERE owner_key = $1 AND conversation_id = $2', [ownerKey, conversationId]);
}

async function revokeAiShare(ownerKey, shareId) {
  if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM ai_shares WHERE owner_key = $1 AND share_id = $2', [ownerKey, shareId]);
    await client.query(
      'UPDATE ai_conversations SET share_id = NULL WHERE owner_key = $1 AND share_id = $2',
      [ownerKey, shareId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function clearAiData() {
  if (!pool) return;
  await pool.query('DELETE FROM ai_shares');
  await pool.query('DELETE FROM ai_conversations');
}

async function closeDatabase() {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}

module.exports = {
  initializeDatabase,
  isEnabled,
  saveAccount,
  updateAccountPassword,
  deleteAccount,
  saveAiConversation,
  saveAiShareAndConversation,
  deleteAiConversation,
  revokeAiShare,
  clearAiData,
  closeDatabase
};
