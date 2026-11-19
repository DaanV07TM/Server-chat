'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
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
      WORLD_NEWS_ENABLED: '0',
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
  assert.equal(body.moderationEnabled, true);
  assert.equal(body.moderationActive, false);
});

test('World News status is private-cache safe and reports disabled test configuration', async () => {
  const response = await fetch(baseUrl + '/api/world-news/status');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') || '', /no-store/i);
  const body = await response.json();
  assert.equal(body.enabled, false);
  assert.equal(body.active, false);
  assert.equal(body.provider, 'Curated English-language publisher RSS feeds');
  assert.equal(typeof body.publishedSinceRestart, 'number');
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


test('World News includes an ask-only composer and live browser search', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(html, /Vraag iets over het nieuws/);
  assert.match(server, /const newsQuestion = text\\.match\\(\\/\\^\\\\\\/ask/);
  assert.match(server, /tools: \\[\\{ type: 'browser_search' \\}\\]/);
  assert.match(server, /model: AI_WEB_MODEL/);
});

test('local controlled-drug sale detection is wired before provider availability checks', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const moderation = fs.readFileSync(path.join(root, 'lib', 'ai-moderation.js'), 'utf8');
  assert.match(server, /detectIllegalDrugSale\\(message\\.text\\)/);
  assert.match(moderation, /ketamine/);
  assert.match(moderation, /directOffer/);
});
