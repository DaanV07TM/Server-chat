'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const database = require('../database');

const hasDatabase = Boolean(String(process.env.DATABASE_URL || '').trim());

test('PostgreSQL restores accounts, AI conversations and share links', { skip: !hasDatabase }, async t => {
  const ownerKey = 'test-' + crypto.randomBytes(12).toString('hex');
  const conversationId = crypto.randomBytes(16).toString('hex');
  const shareId = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  const account = {
    key: ownerKey,
    username: ownerKey,
    salt: crypto.randomBytes(16).toString('hex'),
    passwordHash: crypto.randomBytes(64),
    token: crypto.randomBytes(32).toString('hex'),
    createdAt: now,
    legalAcceptedAt: now,
    legalTermsVersion: 'integration-test'
  };

  t.after(async () => {
    if (database.isEnabled()) await database.deleteAccount(ownerKey).catch(() => {});
    await database.closeDatabase().catch(() => {});
  });

  const initial = await database.initializeDatabase();
  assert.equal(initial.enabled, true);

  await database.saveAccount(account);
  const conversation = {
    id: conversationId,
    title: 'PostgreSQL integration test',
    createdAt: now,
    updatedAt: now,
    pinned: true,
    shareId: null,
    messages: [{ role: 'user', content: 'Persistence check', createdAt: now }]
  };
  await database.saveAiConversation(ownerKey, conversation);

  const share = {
    id: shareId,
    ownerKey,
    conversationId,
    title: conversation.title,
    messages: conversation.messages,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 60 * 60 * 1000
  };
  await database.saveAiShareAndConversation(share, { ...conversation, shareId });

  await database.closeDatabase();
  const restored = await database.initializeDatabase();
  const restoredAccount = restored.accounts.find(item => item.key === ownerKey);
  const restoredConversation = restored.conversations.find(item =>
    item.ownerKey === ownerKey && item.conversation.id === conversationId
  );
  const restoredShare = restored.shares.find(item => item.id === shareId);

  assert.ok(restoredAccount, 'account record should survive a fresh database connection');
  assert.equal(restoredAccount.username, account.username);
  assert.deepEqual(restoredAccount.passwordHash, account.passwordHash);
  assert.ok(restoredConversation, 'AI conversation should survive a fresh database connection');
  assert.equal(restoredConversation.conversation.pinned, true);
  assert.deepEqual(restoredConversation.conversation.messages, conversation.messages);
  assert.ok(restoredShare, 'active share link should survive a fresh database connection');
  assert.deepEqual(restoredShare.messages, conversation.messages);

  await database.revokeAiShare(ownerKey, shareId);
  await database.closeDatabase();
  const afterRevoke = await database.initializeDatabase();
  assert.equal(afterRevoke.shares.some(item => item.id === shareId), false);
  const conversationAfterRevoke = afterRevoke.conversations.find(item =>
    item.ownerKey === ownerKey && item.conversation.id === conversationId
  );
  assert.ok(conversationAfterRevoke);
  assert.equal(conversationAfterRevoke.conversation.shareId, null);

  await database.deleteAccount(ownerKey);
  await database.closeDatabase();
  const afterDelete = await database.initializeDatabase();
  assert.equal(afterDelete.accounts.some(item => item.key === ownerKey), false);
  assert.equal(afterDelete.conversations.some(item => item.ownerKey === ownerKey), false);
  assert.equal(afterDelete.shares.some(item => item.ownerKey === ownerKey), false);
});
