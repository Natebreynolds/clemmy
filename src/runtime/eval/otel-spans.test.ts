/**
 * Run: npx tsx --test src/runtime/eval/otel-spans.test.ts
 *
 * Lane A Phase 4 — event log → OTel GenAI spans (export-on-read). A failure must
 * resolve to an exact causal span: a blocked write → an ERROR `guardrail` span,
 * a failed tool result → an ERROR `execute_tool` span. Pure + deterministic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGenAiSpans } from './otel-spans.js';
import type { EventRow } from '../harness/eventlog.js';

let seq = 0;
const ev = (type: string, data: Record<string, unknown>, createdAt: string, turn = 0): EventRow => ({
  seq: seq++, id: `e${seq}`, sessionId: 's', turn, role: 'system', type: type as EventRow['type'],
  parentEventId: null, data, createdAt,
});

test('tool_called + tool_returned → an execute_tool CLIENT span with timing + tool name', () => {
  const spans = toGenAiSpans([
    ev('tool_called', { tool: 'composio_execute_tool', callId: 'c1', arguments: '{}' }, '2026-06-21T00:00:00.000Z'),
    ev('tool_returned', { tool: 'composio_execute_tool', callId: 'c1', result: 'sent ok' }, '2026-06-21T00:00:02.000Z'),
  ]);
  const t = spans.find((s) => s.name.startsWith('execute_tool'));
  assert.ok(t);
  assert.equal(t!.kind, 'CLIENT');
  assert.equal(t!.attributes['gen_ai.tool.name'], 'composio_execute_tool');
  assert.equal(t!.attributes['gen_ai.tool.call.id'], 'c1');
  assert.equal(t!.startTime, '2026-06-21T00:00:00.000Z');
  assert.equal(t!.endTime, '2026-06-21T00:00:02.000Z');
  assert.equal(t!.status, undefined, 'a successful tool has no ERROR status');
});

test('a failed tool result → ERROR status on the execute_tool span (failure resolves to a span)', () => {
  const spans = toGenAiSpans([
    ev('tool_called', { tool: 'GMAIL_SEND', callId: 'c2' }, '2026-06-21T00:00:00.000Z'),
    ev('tool_returned', { tool: 'GMAIL_SEND', callId: 'c2', result: 'EXECUTION_WRAP_REQUIRED: open a lane' }, '2026-06-21T00:00:01.000Z'),
  ]);
  const t = spans.find((s) => s.attributes['gen_ai.tool.call.id'] === 'c2');
  assert.equal(t?.status?.code, 'ERROR');
});

test('guardrail_tripped → ERROR guardrail span carrying the gate kind', () => {
  const spans = toGenAiSpans([
    ev('guardrail_tripped', { kind: 'duplicate_external_write', toolName: 'composio_execute_tool' }, '2026-06-21T00:00:03.000Z'),
  ]);
  const g = spans.find((s) => s.name.startsWith('guardrail'));
  assert.equal(g?.status?.code, 'ERROR');
  assert.equal(g?.attributes['clem.guardrail.kind'], 'duplicate_external_write');
});

test('turn_started + turn_ended → invoke_agent span; run_failed → ERROR span; spans sorted by start', () => {
  const spans = toGenAiSpans([
    ev('turn_started', {}, '2026-06-21T00:00:00.000Z', 1),
    ev('turn_ended', {}, '2026-06-21T00:00:05.000Z', 1),
    ev('run_failed', { reason: 'boom' }, '2026-06-21T00:00:06.000Z'),
  ]);
  assert.ok(spans.find((s) => s.name === 'invoke_agent turn:1'));
  assert.equal(spans.find((s) => s.name === 'run_failed')?.status?.code, 'ERROR');
  const times = spans.map((s) => s.startTime);
  assert.deepEqual(times, [...times].sort(), 'spans are start-ordered');
});

test('empty event list → no spans', () => {
  assert.deepEqual(toGenAiSpans([]), []);
});
