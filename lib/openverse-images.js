'use strict';

const { cleanText, safeHttpsUrl } = require('./world-news');

const ALLOWED_OPENVERSE_LICENSES = new Set(['cc0', 'pdm', 'by', 'by-sa']);

function licenseLabel(image) {
  const license = String(image.license || '').toLowerCase();
  const version = cleanText(String(image.license_version || ''), 20);
  if (license === 'cc0') return 'CC0 1.0';
  if (license === 'pdm') return 'Public Domain Mark 1.0';
  if (license === 'by') return 'CC BY' + (version ? ' ' + version : '');
  if (license === 'by-sa') return 'CC BY-SA' + (version ? ' ' + version : '');
  return '';
}

function normalizeOpenverseImage(image) {
  if (!image || typeof image !== 'object') return null;
  const license = String(image.license || '').toLowerCase();
  if (!ALLOWED_OPENVERSE_LICENSES.has(license)) return null;

  const imageUrl = safeHttpsUrl(image.thumbnail) || safeHttpsUrl(image.url);
  const pageUrl = safeHttpsUrl(image.foreign_landing_url);
  const licenseUrl = safeHttpsUrl(image.license_url);
  if (!imageUrl || !pageUrl || !licenseUrl) return null;

  const creator = cleanText(String(image.creator || ''), 160);
  // Attribution is mandatory for CC BY / BY-SA. Do not use results with no creator.
  if ((license === 'by' || license === 'by-sa') && !creator) return null;

  const creatorUrl = safeHttpsUrl(image.creator_url);
  const title = cleanText(String(image.title || ''), 180);
  const provider = cleanText(String(image.provider || image.source || 'Openverse'), 80);

  return {
    imageUrl: imageUrl.toString(),
    pageUrl: pageUrl.toString(),
    title,
    creator: creator || 'Maker niet vermeld',
    creatorUrl: creatorUrl ? creatorUrl.toString() : null,
    license,
    licenseVersion: cleanText(String(image.license_version || ''), 20),
    licenseLabel: licenseLabel(image),
    licenseUrl: licenseUrl.toString(),
    provider
  };
}

async function searchOpenverseImage(query, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs) || 9000, 15000));
  const search = cleanText(String(query || ''), 180);
  if (!search || typeof fetchImpl !== 'function') return null;

  const params = new URLSearchParams({
    q: search,
    license: 'cc0,by,by-sa,pdm',
    license_type: 'commercial',
    page_size: '10',
    mature: 'false',
    filter_dead: 'true'
  });
  const endpoint = 'https://api.openverse.org/v1/images/?' + params.toString();

  try {
    const response = await fetchImpl(endpoint, {
      headers: { Accept: 'application/json', 'User-Agent': 'ServerChat/1.0 (openly licensed news imagery)' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response || !response.ok) return null;
    const payload = await response.json();
    const results = payload && Array.isArray(payload.results) ? payload.results : [];
    for (const result of results.slice(0, 10)) {
      const normalized = normalizeOpenverseImage(result);
      if (normalized) return normalized;
    }
    return null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  ALLOWED_OPENVERSE_LICENSES,
  normalizeOpenverseImage,
  searchOpenverseImage
};
