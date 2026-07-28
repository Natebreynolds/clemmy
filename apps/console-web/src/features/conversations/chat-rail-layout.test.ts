import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatRailLayout } from './lib/chatRailLayout';

test('narrow chat defaults to a full-width conversation with history closed', () => {
  assert.equal(chatRailLayout(true, false, false), 'mobile-closed');
  assert.equal(chatRailLayout(true, true, false), 'mobile-closed');
});

test('narrow chat history opens as an overlay while desktop honors its preference', () => {
  assert.equal(chatRailLayout(true, false, true), 'mobile-overlay');
  assert.equal(chatRailLayout(false, false, false), 'desktop-open');
  assert.equal(chatRailLayout(false, true, true), 'desktop-collapsed');
});
