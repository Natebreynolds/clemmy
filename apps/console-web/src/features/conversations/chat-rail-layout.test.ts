import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatRailLayout } from './lib/chatRailLayout';

test('narrow chat defaults to a full-width conversation with history closed', () => {
  assert.equal(chatRailLayout(true, false), 'mobile-closed');
});

test('history overlays a narrow thread; desktop never adds a second navigation rail', () => {
  assert.equal(chatRailLayout(true, true), 'mobile-overlay');
  assert.equal(chatRailLayout(false, false), 'desktop');
  assert.equal(chatRailLayout(false, true), 'desktop');
});
