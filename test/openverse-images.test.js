'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOpenverseImage, searchOpenverseImage } = require('../lib/openverse-images');

const reusableImage = {
  title: 'Brussels skyline',
  creator: 'Jane Photographer',
  creator_url: 'https://example.org/photographer',
  license: 'by',
  license_version: '4.0',
  license_url: 'https://creativecommons.org/licenses/by/4.0/',
  url: 'https://images.example.org/brussels.jpg',
  thumbnail: 'https://api.openverse.org/v1/images/123/thumb/',
  foreign_landing_url: 'https://source.example.org/photos/brussels',
  provider: 'example'
};

test('normalizes a licensed Openverse image and keeps all attribution links', () => {
  const image = normalizeOpenverseImage(reusableImage);
  assert.equal(image.imageUrl, reusableImage.thumbnail);
  assert.equal(image.pageUrl, reusableImage.foreign_landing_url);
  assert.equal(image.creator, 'Jane Photographer');
  assert.equal(image.licenseLabel, 'CC BY 4.0');
  assert.equal(image.licenseUrl, reusableImage.license_url);
});

test('rejects non-commercial, unknown and incomplete image licenses', () => {
  assert.equal(normalizeOpenverseImage({ ...reusableImage, license: 'by-nc' }), null);
  assert.equal(normalizeOpenverseImage({ ...reusableImage, license: 'unknown' }), null);
  assert.equal(normalizeOpenverseImage({ ...reusableImage, license: 'by', creator: '' }), null);
  assert.equal(normalizeOpenverseImage({ ...reusableImage, foreign_landing_url: 'http://example.org/photo' }), null);
});

test('allows CC0 and Public Domain Mark images without a named creator', () => {
  assert.equal(normalizeOpenverseImage({ ...reusableImage, license: 'cc0', creator: '' }).licenseLabel, 'CC0 1.0');
  assert.equal(normalizeOpenverseImage({ ...reusableImage, license: 'pdm', creator: '' }).licenseLabel, 'Public Domain Mark 1.0');
});

test('queries Openverse for commercially reusable images and returns normalized attribution', async () => {
  let requestedUrl = '';
  const fetchImpl = async url => {
    requestedUrl = String(url);
    return {
      ok: true,
      async json() { return { results: [reusableImage] }; }
    };
  };
  const image = await searchOpenverseImage('Belgium federal government news', { fetchImpl });
  const parsed = new URL(requestedUrl);
  assert.equal(parsed.hostname, 'api.openverse.org');
  assert.equal(parsed.searchParams.get('license_type'), 'commercial');
  assert.equal(parsed.searchParams.get('license'), 'cc0,by,by-sa,pdm');
  assert.equal(image.creator, 'Jane Photographer');
});

test('returns no image when Openverse is unavailable', async () => {
  const image = await searchOpenverseImage('Belgian parliament', {
    fetchImpl: async () => ({ ok: false, status: 429 })
  });
  assert.equal(image, null);
});
