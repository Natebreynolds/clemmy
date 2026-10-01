import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fragment, h } from 'preact';

// Same loader note as Settings.connections.test.ts: classic JSX runtime.
(globalThis as { React?: unknown }).React = { createElement: h, Fragment };
const { modeSummary } = await import('./Settings.js');

test('the Approvals row says which mode is on and what Ask has learned', () => {
  assert.equal(modeSummary(undefined), '');
  assert.equal(modeSummary({ mode: 'auto', learned: [] }), 'Auto · anything non-disruptive runs');
  assert.equal(modeSummary({ mode: 'ask', learned: [] }), 'Ask · nothing learned yet');
  const kind = { operationId: 'EXAMPLE_CREATE_ROW', accountId: null, grantedAt: '2026-09-30T00:00:00Z', lastUsedAt: '2026-09-30T00:00:00Z' };
  assert.equal(modeSummary({ mode: 'ask', learned: [kind] }), 'Ask · 1 kind of change learned');
  assert.equal(modeSummary({ mode: 'ask', learned: [kind, { ...kind, operationId: 'EXAMPLE_UPDATE_ROW' }] }), 'Ask · 2 kinds of change learned');
});
