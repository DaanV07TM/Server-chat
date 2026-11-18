'use strict';

// PostgreSQL persistence for data that should survive a service restart.
// Live sockets, admin sessions, abuse counters, image blobs and playback state remain in memory.
let pool = null;

function isEnabled() {
  return Boolean(pool);
}

async function initializeDatabase() {
  const connectionString = String(process.env.DATABASE_URL || '').trim();
  if (!connectionString) {
    return { enabled: false, accounts: [], sessions: [], chatMessages: [], conversations: [], shares: [] };
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
        account_token TEXT,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        legal_accepted_at BIGINT NOT NULL,
        legal_terms_version TEXT NOT NULL
      )
    `);
    await pool.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS account_token TEXT');
    await pool.query("UPDATE accounts SET account_token = md5(random()::text || clock_timestamp()::text || account_key) WHERE account_token IS NULL");
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS accounts_account_token_idx ON accounts (account_token)');
    await pool.query('ALTER TABLE accounts ALTER COLUMN account_token SET NOT NULL');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS account_sessions (
        session_hash CHAR(64) PRIMARY KEY,
        account_key TEXT NOT NULL REFERENCES accounts(account_key) ON DELETE CASCADE,
        created_at BIGINT NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        message_id BIGINT PRIMARY KEY,
        room_key TEXT NOT NULL,
        owner_key TEXT REFERENCES accounts(account_key) ON DELETE CASCADE,
        payload JSONB NOT NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL
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
    await pool.query('CREATE INDEX IF NOT EXISTS account_sessions_owner_idx ON account_sessions (account_key)');
    await pool.query('CREATE INDEX IF NOT EXISTS chat_messages_room_expiry_idx ON chat_messages (room_key, expires_at)');
    await pool.query('DELETE FROM ai_shares WHERE expires_at <= $1', [Date.now()]);
    await pool.query('DELETE FROM chat_messages WHERE expires_at <= $1', [Date.now()]);

    const [accountRows, sessionRows, conversationRows, shareRows, chatRows] = await Promise.all([
      pool.query('SELECT account_key, username, account_token, password_salt, password_hash, created_at, legal_accepted_at, legal_terms_version FROM accounts ORDER BY created_at ASC'),
      pool.query('SELECT session_hash, account_key FROM (SELECT session_hash, account_key, created_at FROM account_sessions ORDER BY created_at DESC LIMIT 10000) recent_sessions ORDER BY created_at ASC'),
      pool.query('SELECT owner_key, conversation_id, title, created_at, updated_at, pinned, share_id, messages FROM ai_conversations ORDER BY updated_at DESC'),
      pool.query('SELECT share_id, owner_key, conversation_id, title, messages, created_at, updated_at, expires_at FROM ai_shares WHERE expires_at > $1', [Date.now()]),
      pool.query('SELECT room_key, message_id, payload FROM chat_messages WHERE expires_at > $1 ORDER BY message_id ASC', [Date.now()])
    ]);

    return {
      enabled: true,
      accounts: accountRows.rows.map(row => ({
        key: row.account_key,
        username: row.username,
        salt: row.password_salt,
        passwordHash: Buffer.from(row.password_hash, 'hex'),
        token: row.account_token,
        createdAt: Number(row.created_at),
        legalAcceptedAt: Number(row.legal_accepted_at),
        legalTermsVersion: row.legal_terms_version
      })),
      sessions: sessionRows.rows.map(row => ({
        sessionHash: row.session_hash,
        accountKey: row.account_key
      })),
      chatMessages: chatRows.rows.map(row => ({
        room: row.room_key,
        message: { ...row.payload, mid: Number(row.message_id) }
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
      (account_key, username, account_token, password_salt, password_hash, created_at, legal_accepted_at, legal_terms_version)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (account_key) DO UPDATE SET
      username = EXCLUDED.username,
      account_token = EXCLUDED.account_token,
      password_salt = EXCLUDED.password_salt,
      password_hash = EXCLUDED.password_hash,
      legal_accepted_at = EXCLUDED.legal_accepted_at,
      legal_terms_version = EXCLUDED.legal_terms_version
  `, [
    account.key, account.username, account.token, account.salt, Buffer.from(account.passwordHash).toString('hex'),
    account.createdAt, account.legalAcceptedAt, account.legalTermsVersion
  ]);
}

async function saveAccountSession(accountKey, sessionHash) {
  if (!pool) return;
  await pool.query(
    'INSERT INTO account_sessions (session_hash, account_key, created_at) VALUES ($1, $2, $3) ON CONFLICT (session_hash) DO NOTHING',
    [sessionHash, accountKey, Date.now()]
  );
}

async function deleteAccountSession(sessionHash) {
  if (!pool) return;
  await pool.query('DELETE FROM account_sessions WHERE session_hash = $1', [sessionHash]);
}

async function deleteAccountSessionsExcept(accountKey, keepSessionHash) {
  if (!pool) return;
  await pool.query(
    'DELETE FROM account_sessions WHERE account_key = $1 AND session_hash <> $2',
    [accountKey, keepSessionHash]
  );
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
    await client.query('DELETE FROM account_sessions WHERE account_key = $1', [accountKey]);
    await client.query('DELETE FROM chat_messages WHERE owner_key = $1', [accountKey]);
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

async function updateAccountPasswordAndRevokeSessions(account, keepSessionHash) {
  if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'UPDATE accounts SET password_salt = $2, password_hash = $3 WHERE account_key = $1',
      [account.key, account.salt, Buffer.from(account.passwordHash).toString('hex')]
    );
    if (result.rowCount !== 1) throw new Error('Account record was not found during password update.');
    await client.query(
      'DELETE FROM account_sessions WHERE account_key = $1 AND session_hash <> $2',
      [account.key, keepSessionHash]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function saveChatMessage(room, message, ownerKey = null) {
  if (!pool || room === 'announcements') return;
  const payload = { ...message };
  if (payload.img) {
    delete payload.img;
    delete payload.imageApproved;
    delete payload.imageReviewed;
    payload.imageUnavailable = true;
    if (!payload.text) payload.text = '(Image not retained after restart)';
  }
  const createdAt = Number(payload.t) || Date.now();
  const expiresAt = createdAt + 60 * 60 * 1000;
  await pool.query(`
    INSERT INTO chat_messages (message_id, room_key, owner_key, payload, created_at, expires_at)
    VALUES ($1, $2, $3, $4::jsonb, $5, $6)
    ON CONFLICT (message_id) DO UPDATE SET
      room_key = EXCLUDED.room_key,
      owner_key = EXCLUDED.owner_key,
      payload = EXCLUDED.payload,
      expires_at = EXCLUDED.expires_at
  `, [message.mid, room, ownerKey, JSON.stringify(payload), createdAt, expiresAt]);
  await pool.query(`
    DELETE FROM chat_messages
    WHERE room_key = $1
      AND message_id NOT IN (
        SELECT message_id FROM chat_messages
        WHERE room_key = $1
        ORDER BY message_id DESC
        LIMIT 50
      )
  `, [room]);
}

async function deleteChatMessage(messageId) {
  if (!pool) return;
  await pool.query('DELETE FROM chat_messages WHERE message_id = $1', [messageId]);
}

async function deleteChatRoom(room) {
  if (!pool || room === 'announcements') return;
  await pool.query('DELETE FROM chat_messages WHERE room_key = $1', [room]);
}

async function clearChatMessages() {
  if (!pool) return;
  await pool.query("DELETE FROM chat_messages WHERE room_key <> 'announcements'");
}

async function pruneChatMessages(now = Date.now()) {
  if (!pool) return;
  await pool.query('DELETE FROM chat_messages WHERE expires_at <= $1', [now]);
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
  saveAccountSession,
  deleteAccountSession,
  deleteAccountSessionsExcept,
  updateAccountPassword,
  updateAccountPasswordAndRevokeSessions,
  deleteAccount,
  saveChatMessage,
  deleteChatMessage,
  deleteChatRoom,
  clearChatMessages,
  pruneChatMessages,
  saveAiConversation,
  saveAiShareAndConversation,
  deleteAiConversation,
  revokeAiShare,
  clearAiData,
  closeDatabase
};
