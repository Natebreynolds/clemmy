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
  isConfirmFirstEnabled,
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

// SEVERITY GATE (2026-05-30, brackets.ts:696) — the confirm-first batch
// gate fires only when the batch crosses the threshold AND the write is
// genuinely irreversible. A reversible batch (a Google Sheets edit you
// can undo) must NOT gate, even far past the threshold: gating it in a
// chat session where nothing opens a plan scope wedged the agent with no
// reachable exit (live: the 48-row Closed-Won sheet; the email-analysis
// writes were dropped and the run falsely reported "Done"). These tests
// pin the decision the gate now makes, composing the two pure helpers
// exactly as brackets.ts does.
function gateFires(slug: string, priorSameShapeCount: number, threshold = 5, gateAllMutating = false): boolean {
  const shape = classifyExternalWrite('composio_execute_tool', { tool_slug: slug });
  if (!shape.mutating || !shape.shapeKey) return false;
  const review = decideInstructionReview({ priorSameShapeCount, threshold });
  const severityRequiresGate = gateAllMutating || shape.irreversible;
  return review.required && severityRequiresGate;
}

test('severity gate: reversible Sheets batch never gates, even far past threshold', () => {
  assert.equal(gateFires('GOOGLESHEETS_BATCH_UPDATE', 4), false);
  assert.equal(gateFires('GOOGLESHEETS_BATCH_UPDATE', 50), false);
});

test('severity gate: irreversible email send gates at threshold', () => {
  assert.equal(gateFires('GMAIL_SEND_EMAIL', 3), false, 'below threshold: no gate');
  assert.equal(gateFires('GMAIL_SEND_EMAIL', 4), true, 'at threshold: gate');
});

test('severity gate: escape hatch re-gates all mutating writes when enabled', () => {
  assert.equal(gateFires('GOOGLESHEETS_BATCH_UPDATE', 4, 5, true), true);
});

test('isConfirmFirstEnabled: defaults on with an explicit off escape hatch', () => {
  const previous = process.env.CLEMMY_CONFIRM_FIRST;
  try {
    delete process.env.CLEMMY_CONFIRM_FIRST;
    assert.equal(isConfirmFirstEnabled(), true);
    process.env.CLEMMY_CONFIRM_FIRST = 'off';
    assert.equal(isConfirmFirstEnabled(), false);
    process.env.CLEMMY_CONFIRM_FIRST = 'true';
    assert.equal(isConfirmFirstEnabled(), true);
  } finally {
    if (previous === undefined) delete process.env.CLEMMY_CONFIRM_FIRST;
    else process.env.CLEMMY_CONFIRM_FIRST = previous;
  }
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
