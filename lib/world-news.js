'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

function safeHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password ||
        !url.hostname || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') ||
        url.hostname.endsWith('.local') || net.isIP(url.hostname)) return null;
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
  for (const item of sourceItems) {
    if (!item || typeof item !== 'object') continue;
    const canonicalUrl = canonicalArticleUrl(item.url);
    const articleUrl = safeHttpsUrl(item.url);
    const imageUrl = safeHttpsUrl(item.socialimage || item.image || item.imageUrl);
    const title = cleanText(item.title, 240);
    if (!canonicalUrl || !articleUrl || !imageUrl || title.length < 24) continue;
    const id = crypto.createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 32);
    if (seenIds.has(id)) continue;
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

module.exports = {
  safeHttpsUrl,
  cleanText,
  canonicalArticleUrl,
  parseGdeltDate,
  parseGdeltArticles,
  extractContextSnippet,
  parseNewsSummary
};
