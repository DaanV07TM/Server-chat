'use strict';

function cleanAIAnswerText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/(?:〖|\[)\s*\d+\s*†\s*L[\dL-]+\s*(?:〗|\])/g, '')
    .replace(/【\s*\d+\s*†\s*[^】]{1,120}】/g, '')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000);
}

module.exports = { cleanAIAnswerText };
