'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  safeHttpsUrl,
  canonicalArticleUrl,
  parseGdeltDate,
  parseGdeltArticles,
  extractContextSnippet,
  parseNewsSummary,
  parseRssFeed,
  WORLD_NEWS_FEEDS
} = require('../lib/world-news');

test('accepts only safe external HTTPS URLs', () => {
  assert.equal(safeHttpsUrl('https://news.example.org/story').hostname, 'news.example.org');
  for (const value of [
    'http://news.example.org/story',
    'javascript:alert(1)',
    'https://localhost/private',
    'https://127.0.0.1/admin',
    'https://[::1]/admin',
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

  assert.equal(result.length, 2);
  assert.equal(result[0].title, 'A sufficiently long newer headline for testing');
  assert.equal(result[0].source, 'news.example.org');
  assert.equal(result[0].imageUrl, 'https://images.example.org/newer.jpg');
  assert.equal(result[1].canonicalUrl, 'https://news.example.org/older');
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


test('curated publisher feeds are English HTTPS feeds with explicit source allowlists', () => {
  assert.ok(WORLD_NEWS_FEEDS.length >= 8);
  for (const feed of WORLD_NEWS_FEEDS) {
    assert.ok(feed.publisher);
    assert.equal(new URL(feed.url).protocol, 'https:');
    assert.ok(Array.isArray(feed.allowedDomains) && feed.allowedDomains.length > 0);
  }
});

test('parses publisher RSS entries, keeps the publisher excerpt and optional preview image', () => {
  const feed = { publisher: 'BBC News', allowedDomains: ['bbc.com', 'bbc.co.uk'] };
  const xml = `<?xml version="1.0"?>
    <rss><channel><item>
      <title>Global leaders agree on a new international climate framework</title>
      <link>https://www.bbc.com/news/articles/example-123</link>
      <description><![CDATA[<p>Leaders reached an agreement after two days of talks.</p>]]></description>
      <media:thumbnail url="https://ichef.bbci.co.uk/images/example.jpg" />
      <pubDate>Wed, 19 Nov 2026 09:00:00 GMT</pubDate>
    </item><item>
      <title>A second trusted publisher story without a preview image</title>
      <link>https://www.bbc.co.uk/news/articles/example-456</link>
      <description>Publisher summary text for the second story.</description>
    </item></channel></rss>`;
  const stories = parseRssFeed(xml, feed, new Set(), 10);
  assert.equal(stories.length, 2);
  assert.equal(stories[0].source, 'BBC News');
  assert.match(stories[0].summary, /two days of talks/i);
  assert.equal(stories[0].imageUrl, 'https://ichef.bbci.co.uk/images/example.jpg');
  assert.equal(stories[1].imageUrl, null);
  assert.equal(stories[1].sourceDomain, 'bbc.co.uk');
});

test('RSS parser rejects links outside the selected publisher domain and deduplicates URLs', () => {
  const feed = { publisher: 'NPR', allowedDomains: ['npr.org'] };
  const xml = `<rss><channel>
    <item><title>A legitimate headline with enough descriptive text</title><link>https://www.npr.org/sections/world/123</link></item>
    <item><title>A fake headline hosted by an unrelated source</title><link>https://not-npr.example/story</link></item>
    <item><title>Duplicate link with another headline for testing</title><link>https://www.npr.org/sections/world/123?utm_source=rss</link></item>
  </channel></rss>`;
  const stories = parseRssFeed(xml, feed, new Set(), 10);
  assert.equal(stories.length, 1);
  assert.equal(stories[0].source, 'NPR');
});
