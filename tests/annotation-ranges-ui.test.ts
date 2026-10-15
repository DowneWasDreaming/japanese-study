import test from 'node:test';
import assert from 'node:assert/strict';
import { findTextOccurrences, highlightTextSegments, validTextAnchor } from '../src/annotation-ranges.js';

test('annotation offsets retain UTF-16 emoji, combining marks and exact repeated positions', () => {
  const source = '😀日本語、日本語 e\u0301';
  assert.deepEqual(findTextOccurrences(source, '日本語').map(anchor => [anchor.start, anchor.end]), [[2, 5], [6, 9]]);
  assert.equal(validTextAnchor(source, { start: 0, end: 2, text: '😀' }), true);
  assert.equal(validTextAnchor(source, { start: 1, end: 2, text: source.slice(1, 2) }), false);
  assert.equal(validTextAnchor(source, { start: 0, end: 1, text: source.slice(0, 1) }), false);
  assert.equal(findTextOccurrences(source, 'é').length, 0);
  assert.equal(findTextOccurrences(source, 'e\u0301').length, 1);
});

test('overlapping highlights preserve original text once, including nested and adjacent ranges', () => {
  const source = '私は日本語を勉強する。';
  const segments = highlightTextSegments(source, [
    { id: 'wide', start: 2, end: 8, text: source.slice(2, 8) },
    { id: 'nested', start: 2, end: 5, text: source.slice(2, 5) },
    { id: 'cross', start: 6, end: 10, text: source.slice(6, 10) },
    { id: 'invalid', start: 0, end: 2, text: '違う' },
  ]);
  assert.equal(segments.map(segment => segment.text).join(''), source);
  assert.deepEqual(segments.find(segment => segment.start === 2)?.ids, ['wide', 'nested']);
  assert.deepEqual(segments.find(segment => segment.start === 6)?.ids, ['wide', 'cross']);
  assert.equal(segments.some(segment => segment.ids.includes('invalid')), false);
});

test('manual matching supports overlapping occurrences and rejects empty or oversized selections', () => {
  assert.deepEqual(findTextOccurrences('あああ', 'ああ').map(anchor => anchor.start), [0, 1]);
  assert.equal(findTextOccurrences('　 \n', ' ').length, 0);
  assert.equal(validTextAnchor('a'.repeat(501), { start: 0, end: 501, text: 'a'.repeat(501) }), false);
  assert.equal(validTextAnchor('日本語', { start: -1, end: 2, text: '日本' }), false);
  assert.equal(validTextAnchor('日本語', { start: 0.5, end: 2, text: '日本' }), false);
  assert.equal(validTextAnchor('日本語', { start: 0, end: 4, text: '日本語' }), false);
});
