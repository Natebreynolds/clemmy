/**
 * Run: npx tsx --test src/runtime/harness/confirm-first-gate.test.ts
 *
 * Pure-function tests for the confirm-first gate. No SDK, no DB, no
 * eventlog — classification + the batch-threshold decision only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyExternalWrite,
  decideInstructionReview,
  ConfirmFirstRequiredError,
} from './confirm-first-gate.js';

// ─── classifyExternalWrite ────────────────────────────────────────

test('classifyExternalWrite: a mutating composio write gets a shapeKey = slug', () => {
  const s = classifyExternalWrite('composio_execute_tool', { tool_slug: 'GMAIL_SEND_EMAIL' });
  assert.equal(s.mutating, true);
  assert.equal(s.shapeKey, 'GMAIL_SEND_EMAIL');
});

test('classifyExternalWrite: SEND/PUBLISH are irreversible, CREATE/UPDATE are not', () => {
  assert.equal(classifyExternalWrite('composio_execute_tool', { tool_slug: 'GMAIL_SEND_EMAIL' }).irreversible, true);
  assert.equal(classifyExternalWrite('composio_execute_tool', { tool_slug: 'SLACK_SEND_MESSAGE' }).irreversible, true);
  assert.equal(classifyExternalWrite('composio_execute_tool', { tool_slug: 'OUTLOOK_CREATE_DRAFT' }).irreversible, false);
  assert.equal(classifyExternalWrite('composio_execute_tool', { tool_slug: 'GOOGLESHEETS_VALUES_UPDATE' }).irreversible, false);
});

test('classifyExternalWrite: a read is not mutating and has no shapeKey', () => {
  const s = classifyExternalWrite('composio_execute_tool', { tool_slug: 'GOOGLESHEETS_VALUES_GET' });
  assert.equal(s.mutating, false);
  assert.equal(s.shapeKey, undefined);
});

test('classifyExternalWrite: tolerates a JSON-string args payload', () => {
  const s = classifyExternalWrite('composio_execute_tool', JSON.stringify({ tool_slug: 'SALESFORCE_CREATE_RECORD' }));
  assert.equal(s.mutating, true);
  assert.equal(s.shapeKey, 'SALESFORCE_CREATE_RECORD');
});

// ─── decideInstructionReview (batch threshold) ────────────────────

test('decideInstructionReview: below threshold → not required, count is 1-based', () => {
  // 0 prior → this is write #1, threshold 5 → allowed
  const d = decideInstructionReview({ priorSameShapeCount: 0, threshold: 5 });
  assert.equal(d.required, false);
  assert.equal(d.count, 1);
  assert.equal(d.reason, 'below_threshold');
});

test('decideInstructionReview: the Nth same-shape write trips the batch gate', () => {
  // 4 prior → this is write #5, threshold 5 → required
  const d = decideInstructionReview({ priorSameShapeCount: 4, threshold: 5 });
  assert.equal(d.required, true);
  assert.equal(d.count, 5);
  assert.equal(d.reason, 'batch_threshold');
});

test('decideInstructionReview: writes 1..4 pass, write 5 blocks (threshold 5)', () => {
  const required = [0, 1, 2, 3, 4].map((prior) => decideInstructionReview({ priorSameShapeCount: prior, threshold: 5 }).required);
  assert.deepEqual(required, [false, false, false, false, true]);
});

test('decideInstructionReview: threshold floored at 2 — a 0/1 config cannot gate every single write', () => {
  // threshold 1 would otherwise force review on write #1; floor protects against that.
  const d = decideInstructionReview({ priorSameShapeCount: 0, threshold: 1 });
  assert.equal(d.required, false, 'first write must not be gated even with a misconfigured threshold');
  // but the SECOND write (prior 1 → count 2) does trip the floored threshold of 2
  assert.equal(decideInstructionReview({ priorSameShapeCount: 1, threshold: 1 }).required, true);
});

// ─── ConfirmFirstRequiredError message ────────────────────────────

test('ConfirmFirstRequiredError: message guides the model to surface a plan and stop', () => {
  const err = new ConfirmFirstRequiredError({
    toolName: 'composio_execute_tool',
    shapeKey: 'GMAIL_SEND_EMAIL',
    count: 5,
    threshold: 5,
    sessionId: 'sess-x',
  });
  assert.match(err.message, /CONFIRM_FIRST_REQUIRED/);
  assert.match(err.message, /draft_plan/);
  assert.match(err.message, /surface_plan/);
  assert.match(err.message, /GMAIL_SEND_EMAIL/);
  assert.equal(err.name, 'ConfirmFirstRequiredError');
});
