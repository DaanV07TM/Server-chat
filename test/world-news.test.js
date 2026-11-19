'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  safeHttpsUrl,
  canonicalArticleUrl,
  parseGdeltDate,
  parseGdeltArticles,
  extractContextSnippet,
  parseNewsSummary
} = require('../lib/world-news');

test('accepts only safe external HTTPS URLs', () => {
  assert.equal(safeHttpsUrl('https://news.example.org/story').hostname, 'news.example.org');
  for (const value of [
    'http://news.example.org/story',
    'javascript:alert(1)',
    'https://localhost/private',
    'https://127.0.0.1/admin',
    'https://user:pass@news.example.org/story',
    'not a URL'
  ]) assert.equal(safeHttpsUrl(value), null);
});

test('canonicalizes article links without tracking parameters', () => {
  assert.equal(
    canonicalArticleUrl('https://news.example.org/story?utm_source=feed&id=7#top'),
    'https://news.example.org/story?id=7'
  );
});

test('parses GDELT timestamps as UTC', () => {
  assert.equal(parseGdeltDate('20261119T083015Z'), '2026-11-19T08:30:15.000Z');
  assert.equal(parseGdeltDate('invalid'), null);
});

test('parses, sanitizes, deduplicates and sorts GDELT articles', () => {
  const result = parseGdeltArticles({
    articles: [
      {
        url: 'https://news.example.org/older?utm_source=rss',
        title: 'A sufficiently long older headline for testing',
        socialimage: 'https://images.example.org/older.jpg',
        seendate: '20261118T080000Z',
        sourcecountry: 'Belgium'
      },
      {
        url: 'https://news.example.org/newer',
        title: 'A sufficiently long <b>newer</b> headline for testing',
        socialimage: 'https://images.example.org/newer.jpg',
        seendate: '20261119T080000Z'
      },
      {
        url: 'https://news.example.org/no-photo',
        title: 'This article has no photo and should be skipped',
        seendate: '20261119T090000Z'
      },
      {
        url: 'http://news.example.org/insecure',
        title: 'This insecure article should also be skipped',
        socialimage: 'https://images.example.org/test.jpg'
      },
      {
        url: 'https://news.example.org/newer?utm_campaign=duplicate',
        title: 'Duplicate of the newer article',
        socialimage: 'https://images.example.org/newer.jpg',
        seendate: '20261119T080000Z'
      }
    ]
  }, new Set(), 10);

  assert.equal(result.length, 3);
  assert.equal(result[0].title, 'A sufficiently long newer headline for testing');
  assert.equal(result[0].source, 'news.example.org');
  assert.equal(result[0].imageUrl, 'https://images.example.org/newer.jpg');
  assert.equal(result[1].canonicalUrl, 'https://news.example.org/newer');
});

test('extracts a matching context sentence but never borrows another article excerpt', () => {
  const candidate = { canonicalUrl: 'https://news.example.org/story' };
  const payload = {
    articles: [
      { url: 'https://news.example.org/other', context: 'This is a different story excerpt.' },
      { url: 'https://news.example.org/story?utm_source=feed', context: 'A relevant sentence from the selected report.' }
    ]
  };
  assert.equal(extractContextSnippet(payload, candidate), 'A relevant sentence from the selected report.');
  assert.equal(extractContextSnippet({ articles: [] }, candidate), '');
});

test('rejects malformed or unhelpful AI summaries', () => {
  assert.equal(parseNewsSummary('not json'), '');
  assert.equal(parseNewsSummary('{"summary":"too short"}'), '');
  assert.equal(parseNewsSummary(JSON.stringify({
    summary: 'De uitgever meldt dat het parlement vandaag een nieuw voorstel heeft goedgekeurd.'
  })), 'De uitgever meldt dat het parlement vandaag een nieuw voorstel heeft goedgekeurd.');
});
