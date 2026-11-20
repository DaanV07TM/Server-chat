'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

function safeHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password ||
        !hostname || hostname === 'localhost' || hostname.endsWith('.localhost') ||
        hostname.endsWith('.local') || net.isIP(hostname)) return null;
    return url;
  } catch (_) {
    return null;
  }
}

function cleanText(value, maxLength = 500) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function canonicalArticleUrl(value) {
  const url = safeHttpsUrl(value);
  if (!url) return '';
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.+|fbclid|gclid|mc_cid|mc_eid|ref_src|ref_url)$/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  return url.toString().replace(/\/$/, '');
}

function parseGdeltDate(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!match) return null;
  const date = new Date(Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6])
  ));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function parseGdeltArticles(payload, seenIds = new Set(), limit = 20) {
  const sourceItems = payload && (Array.isArray(payload.articles) ? payload.articles :
    Array.isArray(payload.results) ? payload.results : []);
  const candidates = [];
  const collectedIds = new Set(seenIds);
  for (const item of sourceItems) {
    if (!item || typeof item !== 'object') continue;
    const canonicalUrl = canonicalArticleUrl(item.url);
    const articleUrl = safeHttpsUrl(item.url);
    const imageUrl = safeHttpsUrl(item.socialimage || item.image || item.imageUrl);
    const title = cleanText(item.title, 240);
    if (!canonicalUrl || !articleUrl || !imageUrl || title.length < 24) continue;
    const id = crypto.createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 32);
    if (collectedIds.has(id)) continue;
    collectedIds.add(id);
    const seenAt = parseGdeltDate(item.seendate);
    const domain = articleUrl.hostname.replace(/^www\./i, '').toLowerCase();
    candidates.push({
      id,
      url: articleUrl.toString(),
      canonicalUrl,
      title,
      imageUrl: imageUrl.toString(),
      source: domain,
      seenAt,
      sourceCountry: cleanText(item.sourcecountry || '', 40) || null
    });
  }
  candidates.sort((a, b) => (Date.parse(b.seenAt || '') || 0) - (Date.parse(a.seenAt || '') || 0));
  return candidates.slice(0, Math.max(0, Math.min(50, Number(limit) || 20)));
}

function extractContextSnippet(payload, candidate) {
  const sourceItems = payload && (Array.isArray(payload.articles) ? payload.articles :
    Array.isArray(payload.results) ? payload.results : []);
  const expected = candidate && candidate.canonicalUrl;
  if (!expected) return '';
  const exact = sourceItems.find(item => item && canonicalArticleUrl(item.url) === expected);
  if (!exact) return '';
  return cleanText(
    exact.context || exact.snippet || exact.sentence || exact.match || exact.description || '',
    700
  );
}

function parseNewsSummary(content) {
  if (typeof content !== 'string' || content.length > 3000) return '';
  let parsed;
  try {
    parsed = JSON.parse(content.trim());
  } catch (_) {
    return '';
  }
  const summary = cleanText(parsed && parsed.summary, 480);
  if (!summary || summary.length < 30) return '';
  return summary;
}



const WORLD_NEWS_FEEDS = Object.freeze([
  { publisher: 'BBC News', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', allowedDomains: ['bbc.co.uk', 'bbc.com'] },
  { publisher: 'NPR', url: 'https://feeds.npr.org/1001/rss.xml', allowedDomains: ['npr.org'] },
  { publisher: 'The Guardian', url: 'https://www.theguardian.com/world/rss', allowedDomains: ['theguardian.com'] },
  { publisher: 'Al Jazeera English', url: 'https://www.aljazeera.com/xml/rss/all.xml', allowedDomains: ['aljazeera.com'] },
  { publisher: 'Deutsche Welle', url: 'https://rss.dw.com/rdf/rss-en-all', allowedDomains: ['dw.com'] },
  { publisher: 'France 24', url: 'https://www.france24.com/en/top-stories/rss', allowedDomains: ['france24.com'] },
  { publisher: 'Sky News', url: 'https://feeds.skynews.com/feeds/rss/home.xml', allowedDomains: ['sky.com'] },
  { publisher: 'CBS News', url: 'https://www.cbsnews.com/latest/rss/main', allowedDomains: ['cbsnews.com'] },
  { publisher: 'NBC News', url: 'https://feeds.nbcnews.com/feeds/topstories', allowedDomains: ['nbcnews.com'] },
  { publisher: 'ProPublica', url: 'https://www.propublica.org/feeds/propublica/main', allowedDomains: ['propublica.org'] }
]);

function xmlElement(block, tagName) {
  const match = block.match(new RegExp('<' + tagName + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tagName + '\\s*>', 'i'));
  return match ? match[1] : '';
}

function xmlAttribute(tag, name) {
  const doubleQuoted = tag.match(new RegExp('\\b' + name + '\\s*=\\s*"([^"]+)"', 'i'));
  const singleQuoted = tag.match(new RegExp("\\b" + name + "\\s*=\\s*'([^']+)'", "i"));
  const match = doubleQuoted || singleQuoted;
  return match ? cleanText(match[1], 2048) : '';
}

function extractRssImageUrl(block) {
  if (typeof block !== 'string' || !block) return null;
  const candidates = [];
  const add = value => {
    if (typeof value === 'string' && value.trim() && value.length <= 2048) {
      const candidate = value.trim();
      candidates.push(candidate.startsWith('//') ? 'https:' + candidate : candidate);
    }
  };

  const mediaTags = [...block.matchAll(/<(?:media:content|media:thumbnail|itunes:image|enclosure|link)\b[^>]*\/?>/gi)];
  for (const match of mediaTags) {
    const tag = match[0];
    const tagName = (tag.match(/^<\s*([\w:.-]+)/) || [])[1] || '';
    const type = xmlAttribute(tag, 'type').toLowerCase();
    const rel = xmlAttribute(tag, 'rel').toLowerCase();
    const medium = xmlAttribute(tag, 'medium').toLowerCase();
    if (tagName.toLowerCase() === 'enclosure' && !type.startsWith('image/')) continue;
    if (tagName.toLowerCase() === 'link' && !(rel === 'enclosure' && type.startsWith('image/'))) continue;
    if (/^media:content$/i.test(tagName) && type && !type.startsWith('image/') && medium !== 'image') continue;
    if (/^media:thumbnail$/i.test(tagName) && type && !type.startsWith('image/')) continue;
    add(xmlAttribute(tag, 'url') || xmlAttribute(tag, 'href'));
  }

  // Some publishers put the preview image in an HTML description instead of a
  // media:content element. Also handle XML-escaped HTML from Atom/RSS summaries.
  const expandedHtml = block
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
  for (const match of expandedHtml.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    add(xmlAttribute(tag, 'src') || xmlAttribute(tag, 'data-src') || xmlAttribute(tag, 'data-original'));
    const srcset = xmlAttribute(tag, 'srcset');
    if (srcset) add(srcset.split(',')[0].trim().split(/\s+/)[0]);
  }

  for (const candidate of candidates) {
    const imageUrl = safeHttpsUrl(candidate);
    if (imageUrl) return imageUrl.toString();
  }
  return null;
}

function parseRssFeed(xml, feed, seenIds = new Set(), limit = 30) {
  if (typeof xml !== 'string' || xml.length > 2_500_000 || !feed ||
      typeof feed.publisher !== 'string' || !Array.isArray(feed.allowedDomains)) return [];
  const blocks = [...xml.matchAll(/<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)\s*>/gi)];
  const output = [];
  const localIds = new Set(seenIds);
  for (const match of blocks) {
    const block = match[1];
    const title = cleanText(xmlElement(block, 'title'), 240);
    if (title.length < 18) continue;

    const linkTags = [...block.matchAll(/<(?:[a-z0-9_.-]+:)?link\b[^>]*(?:\/>|>[\s\S]*?<\/(?:[a-z0-9_.-]+:)?link\s*>)/gi)];
    let rawLink = '';
    for (const linkMatch of linkTags) {
      const tag = linkMatch[0];
      const href = xmlAttribute(tag, 'href');
      const rel = xmlAttribute(tag, 'rel').toLowerCase();
      if (href && (!rel || rel === 'alternate')) { rawLink = href; break; }
      const body = tag.match(/^[^>]*>([\s\S]*?)<\/[^>]+>$/);
      if (body && !rawLink) rawLink = cleanText(body[1], 2048);
    }
    if (!rawLink) rawLink = xmlElement(block, 'guid');
    const articleUrl = safeHttpsUrl(rawLink);
    if (!articleUrl) continue;
    const hostname = articleUrl.hostname.toLowerCase().replace(/^www\./, '');
    const allowed = feed.allowedDomains.some(domain => hostname === domain || hostname.endsWith('.' + domain));
    if (!allowed) continue;
    const canonicalUrl = canonicalArticleUrl(articleUrl.toString());
    if (!canonicalUrl) continue;
    const id = crypto.createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 32);
    if (localIds.has(id)) continue;
    localIds.add(id);

    const imageUrl = extractRssImageUrl(block);

    const rawDescription = xmlElement(block, 'content:encoded') ||
      xmlElement(block, 'description') ||
      xmlElement(block, 'summary') ||
      xmlElement(block, 'content');
    const description = cleanText(rawDescription, 900);
    const rawDate = xmlElement(block, 'pubDate') || xmlElement(block, 'published') ||
      xmlElement(block, 'updated') || xmlElement(block, 'dc:date');
    const parsedTime = Date.parse(cleanText(rawDate, 100));
    output.push({
      id,
      url: articleUrl.toString(),
      canonicalUrl,
      title,
      summary: description,
      imageUrl: imageUrl ? imageUrl.toString() : null,
      source: feed.publisher.slice(0, 60),
      sourceDomain: hostname,
      seenAt: Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : null
    });
  }
  output.sort((a, b) => (Date.parse(b.seenAt || '') || 0) - (Date.parse(a.seenAt || '') || 0));
  return output.slice(0, Math.max(0, Math.min(100, Number(limit) || 30)));
}

module.exports = {
  safeHttpsUrl,
  cleanText,
  canonicalArticleUrl,
  parseGdeltDate,
  parseGdeltArticles,
  extractContextSnippet,
  parseNewsSummary,
  WORLD_NEWS_FEEDS,
  parseRssFeed
};
