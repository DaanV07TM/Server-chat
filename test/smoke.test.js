'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const database = require('../database');
const { once } = require('node:events');
const {
  after,
  before,
  test
} = require('node:test');

const root = path.resolve(__dirname, '..');
let child;
let baseUrl = '';
let output = '';

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('Server exited before becoming healthy. Output: ' + output);
    }
    try {
      const response = await fetch(baseUrl + '/healthz', {
        signal: AbortSignal.timeout(1000),
        headers: { Accept: 'application/json' }
      });
      if (response.ok) return;
      lastError = new Error('Health endpoint returned HTTP ' + response.status);
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw new Error('Server did not become healthy: ' + String(lastError) + '. Output: ' + output);
}

before(async () => {
  const port = await reservePort();
  baseUrl = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      ADMIN_PASSWORD: 'server-chat-smoke-test-password-not-used-for-login',
      AI_ENABLED: '0',
      GROQ_API_KEY: '',
      TURNSTILE_SITE_KEY: '',
      TURNSTILE_SECRET_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  await waitForHealth();
}, { timeout: 20000 });

after(async () => {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit').catch(() => []);
  child.kill('SIGTERM');
  await Promise.race([exited, wait(3000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
});

test('health endpoint returns a no-cache success response', async () => {
  const response = await fetch(baseUrl + '/healthz');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') || '', /no-store/i);
  assert.deepEqual(await response.json(), { ok: true });
});

test('serves the chat shell with basic security headers', async () => {
  const response = await fetch(baseUrl + '/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/html/i);
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const html = await response.text();
  assert.match(html, /Server Chat/i);
  assert.match(html, /botApprovalScreen/);
});

test('sidebar latency probe supports valid administrator sessions', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  assert.match(html, /socket\.connected \|\| \(!accountAuthenticated && !moderator\)/);
});

test('security configuration is not cached and does not expose secret values', async () => {
  const response = await fetch(baseUrl + '/api/security-config');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') || '', /no-store/i);
  const body = await response.json();
  assert.equal(typeof body.termsVersion, 'string');
  assert.equal(body.turnstileEnabled, false);
  assert.equal(body.turnstileSiteKey, '');
  assert.equal(JSON.stringify(body).includes('server-chat-smoke-test-password'), false);
});

test('public server status returns only public channel metadata', async () => {
  const response = await fetch(baseUrl + '/api/server-status');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') || '', /no-store/i);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.checkedAt, 'number');
  assert.ok(Array.isArray(body.channels));
  assert.ok(body.channels.every(channel =>
    typeof channel.key === 'string' &&
    !channel.key.startsWith('private-') &&
    typeof channel.online === 'number'
  ));
});

test('AI status accurately reflects the disabled smoke-test configuration', async () => {
  const response = await fetch(baseUrl + '/api/ai/status');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.enabled, false);
  assert.equal(body.configured, false);
  assert.equal(body.available, false);
  assert.equal(body.model, null);
});

test('private AI conversation creation requires an account session', async () => {
  const response = await fetch(baseUrl + '/api/ai/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.match(body.error, /Sign in again/i);
});


test('account persistence hashes session tokens before storing them', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const dbSource = fs.readFileSync(path.join(root, 'database.js'), 'utf8');
  const migration = fs.readFileSync(path.join(root, 'migrations', '001_account_persistence.sql'), 'utf8');
  assert.match(server, /function sessionTokenKey\(token\)/);
  assert.match(server, /const sessionHash = sessionTokenKey\(token\)/);
  assert.match(server, /await database\.saveSession\(sessionHash, account\.key/);
  assert.match(dbSource, /session_hash/);
  assert.doesNotMatch(migration, /session_token\s+text/i);
  assert.match(dbSource, /ON DELETE CASCADE/);
});

test('PostgreSQL stores accounts and hashed sessions and cascades account deletion', {
  skip: !process.env.DATABASE_URL
}, async () => {
  assert.equal(await database.initialize(), true);
  const suffix = crypto.randomBytes(6).toString('hex');
  const accountKey = 'smoke-' + suffix;
  const rawSessionToken = crypto.randomBytes(32).toString('hex');
  const sessionHash = crypto.createHash('sha256').update(rawSessionToken).digest('hex');
  const secondRawToken = crypto.randomBytes(32).toString('hex');
  const secondSessionHash = crypto.createHash('sha256').update(secondRawToken).digest('hex');
  const now = Date.now();
  const account = {
    key: accountKey,
    username: accountKey,
    salt: crypto.randomBytes(16).toString('hex'),
    passwordHash: crypto.randomBytes(64),
    token: crypto.randomBytes(32).toString('hex'),
    createdAt: now,
    legalAcceptedAt: now,
    legalTermsVersion: 'smoke-test'
  };

  try {
    await database.saveAccount(account);
    await database.saveSession(sessionHash, accountKey, now);
    await database.saveSession(secondSessionHash, accountKey, now + 1);

    const saved = (await database.loadAccounts(2000)).find(item => item.key === accountKey);
    assert.ok(saved, 'the account should be readable after insertion');
    assert.equal(saved.username, account.username);
    assert.deepEqual(saved.passwordHash, account.passwordHash);

    const sessionsBeforeChange = (await database.loadSessions(10000))
      .filter(item => item.accountKey === accountKey);
    assert.equal(sessionsBeforeChange.length, 2);
    assert.ok(sessionsBeforeChange.some(item => item.sessionHash === sessionHash));
    assert.ok(sessionsBeforeChange.some(item => item.sessionHash === secondSessionHash));
    assert.notEqual(sessionHash, rawSessionToken);

    const newSalt = crypto.randomBytes(16).toString('hex');
    const newPasswordHash = crypto.randomBytes(64);
    await database.updateAccountPassword({ ...account, salt: newSalt, passwordHash: newPasswordHash }, sessionHash);
    const updated = (await database.loadAccounts(2000)).find(item => item.key === accountKey);
    assert.equal(updated.salt, newSalt);
    assert.deepEqual(updated.passwordHash, newPasswordHash);

    const sessionsAfterChange = (await database.loadSessions(10000))
      .filter(item => item.accountKey === accountKey);
    assert.deepEqual(sessionsAfterChange.map(item => item.sessionHash), [sessionHash]);

    await database.deleteAccount(accountKey);
    const remainingSessions = (await database.loadSessions(10000))
      .filter(item => item.accountKey === accountKey);
    assert.equal(remainingSessions.length, 0);
    const remainingAccount = (await database.loadAccounts(2000))
      .find(item => item.key === accountKey);
    assert.equal(remainingAccount, undefined);
  } finally {
    await database.deleteAccount(accountKey);
    await database.close();
  }
});
