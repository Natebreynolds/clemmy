/**
 * Run: npx tsx --test src/runtime/harness/loop-tool-accounting.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-loop-tool-accounting-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { appendEvent, createSession, resetEventLog } = await import('./eventlog.js');
const { inferTurnPriors } = await import('./loop.js');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function appendCanonicalPair(sessionId: string, callId: string): void {
  appendEvent({
    sessionId,
    turn: 0,
    role: 'Clem',
    type: 'tool_called',
    data: {
      tool: 'composio_execute_tool',
      callId,
      canonicalCallId: callId,
      accounting: 'top_level',
      arguments: '{"tool_slug":"OUTLOOK_LIST_MESSAGES","arguments":"{}"}',
    },
  });
  appendEvent({
    sessionId,
    turn: 0,
    role: 'tool',
    type: 'tool_returned',
    data: {
      tool: 'composio_execute_tool',
      callId,
      canonicalCallId: callId,
      accounting: 'top_level',
      ok: true,
      output: 'canonical result '.repeat(80),
    },
  });
}

function appendTransportMirrorPair(sessionId: string, callId: string): void {
  appendEvent({
    sessionId,
    turn: 0,
    role: 'Clem',
    type: 'tool_called',
    data: {
      tool: 'composio_execute_tool',
      callId,
      accounting: 'transport_mirror',
      args: '{"tool_slug":"OUTLOOK_LIST_MESSAGES","arguments":"{}"}',
    },
  });
  appendEvent({
    sessionId,
    turn: 0,
    role: 'tool',
    type: 'tool_returned',
    data: {
      tool: 'composio_execute_tool',
      callId,
      accounting: 'transport_mirror',
      ok: true,
      preview: 'inner gateway payload '.repeat(2_000),
    },
  });
}

test('preflight priors are invariant to MCP mirror calls and oversized mirror returns', () => {
  resetEventLog();
  const canonical = createSession({ kind: 'chat', title: 'canonical prior' });
  const mirrored = createSession({ kind: 'chat', title: 'mirrored prior' });
  for (let index = 1; index <= 2; index += 1) {
    appendCanonicalPair(canonical.id, `canonical-${index}`);
    appendCanonicalPair(mirrored.id, `mirrored-${index}`);
    appendTransportMirrorPair(mirrored.id, `mirrored-${index}`);
  }
  const options = { fallbackToolCount: 1, fallbackAvgReturn: 1, safetyFactor: 1 };
  const canonicalPrior = inferTurnPriors(canonical.id, 2, options);
  const mirroredPrior = inferTurnPriors(mirrored.id, 2, options);

  assert.equal(canonicalPrior.plannedToolCallCount, 2);
  assert.deepEqual(mirroredPrior, canonicalPrior);
});

test('preflight priors continue to count legacy native calls', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat', title: 'legacy native prior' });
  for (let index = 1; index <= 3; index += 1) {
    appendEvent({
      sessionId: sess.id,
      turn: 1,
      role: 'Clem',
      type: 'tool_called',
      data: {
        tool: 'GONG_GET_CALL_TRANSCRIPT',
        callId: `gong-${index}`,
        arguments: '{"call_id":"recording-123"}',
      },
    });
  }
  const prior = inferTurnPriors(sess.id, 2, {
    fallbackToolCount: 1,
    fallbackAvgReturn: 1,
    safetyFactor: 1,
  });
  assert.equal(prior.plannedToolCallCount, 3);
});
