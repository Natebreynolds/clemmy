import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectReasoningEffort } from './reasoning-effort.js';
import { buildAgentContextPacket } from './context-packet.js';

const primer = { enabled: false, hitCount: 0, source: null, injected: false, skippedReason: null };
const complexityOf = (input: string) =>
  buildAgentContextPacket(input, primer, { sessionKind: 'chat', sessionId: 's' }).complexity;

test('background: simple→none, moderate→medium, complex→high', () => {
  assert.equal(selectReasoningEffort('simple').effort, 'none');
  assert.equal(selectReasoningEffort('moderate').effort, 'medium');
  assert.equal(selectReasoningEffort('complex').effort, 'high');
});

test('interactive caps complex at medium (never make a human wait on high)', () => {
  assert.equal(selectReasoningEffort('complex', { interactive: true }).effort, 'medium');
  assert.match(selectReasoningEffort('complex', { interactive: true }).reason, /interactive/);
});

test('interactive leaves simple/moderate unchanged (cap only bites at high)', () => {
  assert.equal(selectReasoningEffort('simple', { interactive: true }).effort, 'none');
  assert.equal(selectReasoningEffort('moderate', { interactive: true }).effort, 'medium');
});

test('simple is byte-identical (none) interactive or not — fastest path untouched', () => {
  assert.equal(selectReasoningEffort('simple').effort, 'none');
  assert.equal(selectReasoningEffort('simple', { interactive: true }).effort, 'none');
});

test('every result carries a reason tag', () => {
  assert.ok(selectReasoningEffort('complex').reason);
  assert.ok(selectReasoningEffort('simple', { interactive: true }).reason);
});

test('effort ladder is monotonic in complexity (background)', () => {
  const rank = { none: 0, minimal: 1, low: 2, medium: 3, high: 4 } as const;
  const s = rank[selectReasoningEffort('simple').effort];
  const m = rank[selectReasoningEffort('moderate').effort];
  const c = rank[selectReasoningEffort('complex').effort];
  assert.ok(s < m && m < c, `expected simple<moderate<complex, got ${s},${m},${c}`);
});

// Integration with the real classifier.
test('a short calendar lookup → none through the real classifier', () => {
  assert.equal(selectReasoningEffort(complexityOf("what's on my calendar today?")).effort, 'none');
});

test('a multi-domain read+write request → high background / capped medium interactive', () => {
  const input =
    'Pull my unread Outlook emails and the open Salesforce leads, then update each Airtable contact record and draft outreach for the warm ones';
  const c = complexityOf(input);
  assert.equal(selectReasoningEffort(c).effort, 'high');
  assert.equal(selectReasoningEffort(c, { interactive: true }).effort, 'medium');
});
