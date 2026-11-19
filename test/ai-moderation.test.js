'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseModerationVerdict, moderationAction, classifyPublicMessage } = require('../lib/ai-moderation');

test('parses a valid non-violation verdict', () => {
  assert.deepEqual(parseModerationVerdict('{"violation":false}'), {
    violation: false, category: 'none', severity: 'none', confidence: 1, reason: ''
  });
});

test('parses a valid violation and sanitizes its reason', () => {
  const verdict = parseModerationVerdict(JSON.stringify({
    violation: true, category: 'harassment', severity: 'high',
    confidence: 0.96, reason: 'Targeted\n personal abuse'
  }));
  assert.equal(verdict.category, 'harassment');
  assert.equal(verdict.reason, 'Targeted personal abuse');
});

test('rejects invalid or incomplete provider output', () => {
  assert.equal(parseModerationVerdict('not json'), null);
  assert.equal(parseModerationVerdict('{"violation":true,"category":"unknown","severity":"high","confidence":0.99}'), null);
  assert.equal(parseModerationVerdict('{"violation":true,"category":"hate","severity":"high","confidence":2}'), null);
  assert.equal(parseModerationVerdict(null), null);
});

test('removes only clear, high-confidence serious violations', () => {
  assert.equal(moderationAction({
    violation: true, category: 'threat', severity: 'critical', confidence: 0.97
  }), 'remove');
  assert.equal(moderationAction({
    violation: true, category: 'spam', severity: 'medium', confidence: 0.99
  }), 'warn');
});

test('warns on likely violations without automatically deleting them', () => {
  assert.equal(moderationAction({
    violation: true, category: 'harassment', severity: 'medium', confidence: 0.80
  }), 'warn');
  assert.equal(moderationAction({
    violation: true, category: 'harassment', severity: 'high', confidence: 0.89
  }), 'warn');
});

test('does not act on uncertain or non-violating messages', () => {
  assert.equal(moderationAction({
    violation: true, category: 'hate', severity: 'critical', confidence: 0.71
  }), 'none');
  assert.equal(moderationAction({ violation: false, confidence: 1 }), 'none');
  assert.equal(moderationAction(null), 'none');
});

test('sends bounded public message content and parses Groq JSON response', async () => {
  let request;
  const verdict = await classifyPublicMessage({
    apiKey: 'test-key',
    model: 'test-model',
    text: 'hello',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"violation":false}' } }]
        })
      };
    }
  });
  assert.equal(verdict.violation, false);
  assert.match(request.url, /api\.groq\.com/);
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.equal(JSON.parse(request.options.body).response_format.type, 'json_object');
  assert.equal(JSON.parse(request.options.body).reasoning_format, 'hidden');
});

test('reports provider failures instead of fabricating a safe verdict', async () => {
  await assert.rejects(
    classifyPublicMessage({
      apiKey: 'test-key',
      model: 'test-model',
      text: 'hello',
      fetchImpl: async () => ({ ok: false, status: 429 })
    }),
    /status 429/
  );
});
