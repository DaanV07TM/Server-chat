'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseModerationVerdict, moderationAction, detectIllegalDrugSale, classifyPublicMessage } = require('../lib/ai-moderation');

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
  assert.equal(JSON.parse(request.options.body).include_reasoning, false);
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


test('detects direct offers to sell controlled drugs in Dutch and English', () => {
  for (const message of [
    'Ik verkoop ketamine.',
    'Ik kan nu vrij zeggen dat ik ketamine verkoop.',
    'I sell ketamine, DM me for prices.',
    'Cocaine for sale, contact me.',
    'MDMA te koop, stuur me een bericht.'
  ]) {
    const verdict = detectIllegalDrugSale(message);
    assert.equal(verdict.violation, true, message);
    assert.equal(verdict.category, 'illegal');
    assert.equal(verdict.severity, 'critical');
    assert.equal(verdict.confidence, 1);
    assert.equal(moderationAction(verdict), 'remove');
  }
});

test('does not flag ordinary medical, educational or news discussion as a sale offer', () => {
  for (const message of [
    'Ketamine is used as an anaesthetic in hospitals.',
    'Our class discussed the risks of ketamine misuse.',
    'Police arrested a suspect accused of selling ketamine.',
    'I read an article about ketamine treatment for depression.'
  ]) assert.equal(detectIllegalDrugSale(message), null, message);
});

test('deterministic drug-sale detection works without a Groq key', async () => {
  const verdict = await classifyPublicMessage({
    apiKey: '',
    model: '',
    text: 'Ik verkoop ketamine',
    fetchImpl: async () => { throw new Error('The provider should not be called'); }
  });
  assert.equal(verdict.category, 'illegal');
  assert.equal(moderationAction(verdict), 'remove');
});
