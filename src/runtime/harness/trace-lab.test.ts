/**
 * Run: npx tsx --test src/runtime/harness/trace-lab.test.ts
 *
 * Trace Lab derives a deterministic operator/replay view from the canonical
 * harness event log. It must not invent a second trace store.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-trace-lab-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createSession, appendEvent, resetEventLog } = await import('./eventlog.js');
const { buildTraceDetail, buildTraceReplayPreview, listTraceSummaries } = await import('./trace-lab.js');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('buildTraceDetail classifies events, computes metrics, and links tool/approval edges', () => {
  resetEventLog();
  const sess = createSession({ id: 'trace-demo', kind: 'chat', title: 'Trace Demo', objective: 'Send a safe update' });
  appendEvent({ sessionId: sess.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Send Brooke the update.' } });
  appendEvent({ sessionId: sess.id, turn: 1, role: 'system', type: 'reasoning_effort', data: { effort: 'medium', reason: 'external write' } });
  appendEvent({ sessionId: sess.id, turn: 1, role: 'orchestrator', type: 'tool_called', data: { tool: 'composio_execute_tool', callId: 'call-send', arguments: '{"to":"brooke@example.com"}' } });
  appendEvent({ sessionId: sess.id, turn: 1, role: 'system', type: 'approval_requested', data: { approvalId: 'apr-1', subject: 'Send Brooke email' } });
  appendEvent({ sessionId: sess.id, turn: 1, role: 'user', type: 'approval_resolved', data: { approvalId: 'apr-1', resolution: 'approved' } });
  appendEvent({ sessionId: sess.id, turn: 1, role: 'system', type: 'external_write', data: { tool: 'composio_execute_tool', shapeKey: 'email:send', target: 'brooke@example.com' } });
  appendEvent({ sessionId: sess.id, turn: 1, role: 'orchestrator', type: 'tool_returned', data: { tool: 'composio_execute_tool', callId: 'call-send', output: 'sent' } });
  appendEvent({ sessionId: sess.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'Sent.' } });

  const trace = buildTraceDetail(sess.id);
  assert.ok(trace);
  assert.equal(trace.sessionId, sess.id);
  assert.equal(trace.metrics.events, 8);
  assert.equal(trace.metrics.toolCalls, 1);
  assert.equal(trace.metrics.toolReturns, 1);
  assert.equal(trace.metrics.approvalsRequested, 1);
  assert.equal(trace.metrics.approvalsResolved, 1);
  assert.equal(trace.metrics.externalWrites, 1);
  assert.equal(trace.metrics.modelRoutes, 1);
  assert.equal(trace.replay.riskLevel, 'high');
  assert.ok(trace.nodes.some((node) => node.category === 'external_write' && node.target === 'brooke@example.com'));
  assert.ok(trace.edges.some((edge) => edge.kind === 'tool_result' && edge.label === 'call-send'));
  assert.ok(trace.edges.some((edge) => edge.kind === 'approval_resolution' && edge.label === 'apr-1'));
});

test('buildTraceReplayPreview produces a safe replay prompt with risks and key timeline', () => {
  resetEventLog();
  const sess = createSession({ id: 'trace-fail', kind: 'chat', title: 'Trace Failure' });
  appendEvent({ sessionId: sess.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Publish the report.' } });
  appendEvent({ sessionId: sess.id, turn: 1, role: 'system', type: 'guardrail_tripped', data: { kind: 'output_grounding_blocked', reason: 'figure not traced' } });
  appendEvent({ sessionId: sess.id, turn: 1, role: 'system', type: 'run_failed', data: { error: 'grounding failed' } });

  const preview = buildTraceReplayPreview(sess.id);
  assert.ok(preview);
  assert.equal(preview.mode, 'safe_prompt');
  assert.equal(preview.riskLevel, 'high');
  assert.match(preview.prompt, /SAFE regression\/debugging/);
  assert.match(preview.prompt, /Do not perform external writes/);
  assert.match(preview.prompt, /output_grounding_blocked/);
  assert.ok(preview.risks.some((risk) => /failure events/.test(risk)));
});

test('Trace Lab counts logical top-level calls while retaining transport mirrors for audit', () => {
  resetEventLog();
  const sess = createSession({ id: 'trace-accounting', kind: 'chat', title: 'Trace Accounting' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: {
      tool: 'composio_execute_tool',
      callId: 'call-1',
      canonicalCallId: 'call-1',
      accounting: 'top_level',
      arguments: '{"tool_slug":"OUTLOOK_LIST_MESSAGES"}',
    },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 0,
    role: 'Clem',
    type: 'tool_called',
    data: { tool: 'composio_execute_tool', callId: 'call-1', accounting: 'transport_mirror' },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 0,
    role: 'tool',
    type: 'tool_returned',
    data: { tool: 'composio_execute_tool', callId: 'call-1', accounting: 'transport_mirror', ok: true },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    data: { tool: 'composio_execute_tool', callId: 'call-1', accounting: 'top_level', ok: true },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: { tool: 'mcp__gong__GONG_GET_CALL_TRANSCRIPT', callId: 'call-legacy' },
  });

  const trace = buildTraceDetail(sess.id);
  assert.ok(trace);
  assert.equal(trace.metrics.toolCalls, 2, 'one top-level gateway call + one legacy/native call');
  assert.equal(trace.metrics.toolReturns, 1);
  assert.equal(trace.nodes.filter((node) => node.type === 'tool_called').length, 3, 'mirror remains visible as audit detail');
  assert.match(buildTraceReplayPreview(sess.id)?.prompt ?? '', /tools: 2/);
});

test('listTraceSummaries returns newest sessions with replay posture', () => {
  resetEventLog();
  const a = createSession({ id: 'trace-a', kind: 'chat', title: 'A' });
  appendEvent({ sessionId: a.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'hello' } });
  const b = createSession({ id: 'trace-b', kind: 'workflow', title: 'B' });
  appendEvent({ sessionId: b.id, turn: 1, role: 'system', type: 'step_started', data: { title: 'Step' } });

  const summaries = listTraceSummaries({ limit: 10, status: 'any' });
  assert.ok(summaries.some((summary) => summary.sessionId === 'trace-a' && summary.replay.ready));
  assert.ok(summaries.some((summary) => summary.sessionId === 'trace-b' && summary.kind === 'workflow'));
});
