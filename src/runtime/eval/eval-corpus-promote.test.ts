/**
 * Run: npx tsx --test src/runtime/eval/eval-corpus-promote.test.ts
 *
 * Lane A Phase 4b — production failures → eval cases. A real failure (guardrail
 * block, stall, run_failed) becomes a pending case; a clean run or an
 * advisory-only nudge (fanout_nudge) does NOT (no false corpus growth).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFailureCase } from './eval-corpus-promote.js';
import type { EventRow } from '../harness/eventlog.js';

let seq = 0;
const ev = (type: string, data: Record<string, unknown>, createdAt = '2026-06-21T00:00:00.000Z'): EventRow => ({
  seq: seq++, id: `e${seq}`, sessionId: 's', turn: 0, role: 'system', type: type as EventRow['type'],
  parentEventId: null, data, createdAt,
});

test('a guardrail block → a pending case carrying the gate kind + a trace', () => {
  const c = buildFailureCase('sess-1', [
    ev('turn_started', {}),
    ev('tool_called', { tool: 'composio_execute_tool', callId: 'c1' }),
    ev('guardrail_tripped', { kind: 'confirm_first_required', toolName: 'composio_execute_tool' }, '2026-06-21T00:00:09.000Z'),
  ]);
  assert.ok(c);
  assert.equal(c!.sessionId, 'sess-1');
  assert.deepEqual(c!.failureKinds, ['guardrail:confirm_first_required']);
  assert.equal(c!.capturedAt, '2026-06-21T00:00:09.000Z', 'capturedAt is the last event time (deterministic)');
  assert.equal(c!.toolCount, 1);
  assert.ok(c!.spans.length >= 1);
  assert.equal(c!.promoted, false);
});

test('stuck_detected / run_failed are real failures → a case', () => {
  assert.ok(buildFailureCase('s', [ev('stuck_detected', { reason: 'A_zero_tools' })]));
  assert.ok(buildFailureCase('s', [ev('run_failed', { reason: 'boom' })]));
});

test('a clean run → null (no false corpus growth)', () => {
  assert.equal(buildFailureCase('s', [ev('turn_started', {}), ev('tool_called', { tool: 'x', callId: 'c' }), ev('conversation_completed', {})]), null);
});

test('an ADVISORY-only nudge (fanout_nudge) is NOT a failure → null', () => {
  assert.equal(buildFailureCase('s', [ev('guardrail_tripped', { kind: 'fanout_nudge' })]), null);
});

test('mixed advisory + real → only the real kind is kept', () => {
  const c = buildFailureCase('s', [
    ev('guardrail_tripped', { kind: 'fanout_nudge' }),
    ev('guardrail_tripped', { kind: 'grounding_blocked' }),
  ]);
  assert.deepEqual(c?.failureKinds, ['guardrail:grounding_blocked']);
});
