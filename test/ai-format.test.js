'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanAIAnswerText } = require('../lib/ai-format');

test('removes Groq browser-search line citation markers without removing the answer', () => {
  const answer = 'De situatie is gespannen 〖2†L6-L10〗.\nMeer details staan hier [1†L8-L-L13].';
  assert.equal(cleanAIAnswerText(answer), 'De situatie is gespannen.\nMeer details staan hier.');
});

test('removes source tokens and normalizes excessive whitespace', () => {
  const answer = 'Eerste alinea【2†source】.\n\n\nTweede alinea.  \n';
  assert.equal(cleanAIAnswerText(answer), 'Eerste alinea.\n\nTweede alinea.');
});

test('keeps normal markdown links and formatting intact', () => {
  const answer = '**Samenvatting**\n\nBron: [BBC News](https://www.bbc.com/news/world)';
  assert.equal(cleanAIAnswerText(answer), answer);
});

test('rejects non-text values and caps oversized responses', () => {
  assert.equal(cleanAIAnswerText(null), '');
  assert.equal(cleanAIAnswerText('x'.repeat(5000)).length, 4000);
});
