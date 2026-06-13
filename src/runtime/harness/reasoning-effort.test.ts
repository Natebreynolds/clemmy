import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectReasoningEffort } from './reasoning-effort.js';
import { buildAgentContextPacket } from './context-packet.js';

const primer = { enabled: false, hitCount: 0, source: null, injected: false, skippedReason: null };
const complexityOf = (input: string) =>
  buildAgentContextPacket(input, primer, { sessionKind: 'chat', sessionId: 's' }).complexity;

test('simple turns stay at none (fastest; byte-identical to today)', () => {
  assert.equal(selectReasoningEffort('simple').effort, 'none');
});

test('moderate turns → medium', () => {
  assert.equal(selectReasoningEffort('moderate').effort, 'medium');
});

test('complex turns → high', () => {
  assert.equal(selectReasoningEffort('complex').effort, 'high');
});

test('active goal forces high regardless of complexity', () => {
  assert.equal(selectReasoningEffort('simple', { hasActiveGoal: true }).effort, 'high');
  assert.equal(selectReasoningEffort('moderate', { hasActiveGoal: true }).effort, 'high');
});

test('every result carries a reason tag', () => {
  const r = selectReasoningEffort('complex');
  assert.ok(r.reason && typeof r.reason === 'string');
});

test('effort ladder is monotonic in complexity', () => {
  const rank = { none: 0, minimal: 1, low: 2, medium: 3, high: 4 } as const;
  const s = rank[selectReasoningEffort('simple').effort];
  const m = rank[selectReasoningEffort('moderate').effort];
  const c = rank[selectReasoningEffort('complex').effort];
  assert.ok(s < m && m < c, `expected simple<moderate<complex, got ${s},${m},${c}`);
});

// Integration with the real classifier: short lookups classify simple → none;
// multi-domain read+write work classifies complex → high.
test('a short calendar lookup resolves to none through the real classifier', () => {
  assert.equal(selectReasoningEffort(complexityOf("what's on my calendar today?")).effort, 'none');
});

test('a multi-domain read+write request resolves to high through the real classifier', () => {
  const input =
    'Pull my unread Outlook emails and the open Salesforce leads, then update each Airtable contact record and draft outreach for the warm ones';
  const effort = selectReasoningEffort(complexityOf(input)).effort;
  assert.ok(effort === 'high' || effort === 'medium', `expected medium/high, got ${effort}`);
});
