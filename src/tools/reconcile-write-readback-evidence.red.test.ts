/**
 * Run: npx tsx --test src/tools/reconcile-write-readback-evidence.red.test.ts
 *
 * INVARIANT — reconciliation evidence eligibility is about what WAS inspected.
 *
 * execution_reconcile_write settles an ambiguous external write from a
 * read-back. Its evidence gate inspects the read's envelope with the bounded
 * provider-envelope inspector. Hitting an inspection bound (depth/node/entry)
 * means the envelope is UNINSPECTED, never CONTRADICTED: a large, perfectly
 * clean read-back that names the write target must be allowed to prove
 * PRESENT. Today the bounded inspector reports the limit as a contradiction
 * and the gate refuses with "the provider read envelope contradicts success" —
 * so the one verb that could resolve an uncertain mutation is vetoed by
 * envelope size, and the duplicate-safety hold wedges (live class,
 * 2026-08-11). A GENUINE structured contradiction within bounds must keep
 * being refused; that guard is pinned here too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-reconcile-readback-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-reconcile-readback\n', 'utf8');
writeFileSync(path.join(TMP_HOME, 'state', 'executions.json'), '[]', 'utf-8');

const { registerExecutionTools } = await import('./execution-tools.js');
const { ExecutionStore } = await import('../execution/store.js');
const {
  appendEvent,
  createSession,
  listEvents,
  writeToolOutput,
} = await import('../runtime/harness/eventlog.js');
const {
  ToolCallsCounter,
  withHarnessRunContext,
} = await import('../runtime/harness/brackets.js');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function registeredToolHandlers(): Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>> {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>>();
  const server = {
    tool(name: string, ...args: unknown[]) {
      const handler = args.at(-1);
      if (typeof handler !== 'function') throw new Error(`tool ${name} missing handler`);
      handlers.set(name, handler as (input: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>);
    },
  };
  registerExecutionTools(server as never);
  return handlers;
}

/** One exact, parented, read-only provider lifecycle — settlement authority. */
function appendExactToolLifecycle(input: {
  sessionId: string;
  callId: string;
  arguments: unknown;
  output: string;
}): void {
  const tool = 'composio_execute_tool';
  const called = appendEvent({
    sessionId: input.sessionId,
    turn: 2,
    role: 'system',
    type: 'tool_called',
    data: {
      tool,
      callId: input.callId,
      canonicalCallId: input.callId,
      effect: 'read',
      arguments: input.arguments,
    },
  });
  writeToolOutput({
    sessionId: input.sessionId,
    callId: input.callId,
    tool,
    invocationNonce: `nonce-${input.callId}`,
    output: input.output,
  });
  appendEvent({
    sessionId: input.sessionId,
    turn: 2,
    role: 'tool',
    type: 'tool_returned',
    parentEventId: called.id,
    data: {
      tool,
      callId: input.callId,
      canonicalCallId: input.callId,
      effect: 'read',
      ok: true,
    },
  });
}

function fixture(label: string) {
  const sessionId = `sess-reconcile-readback-${label}`;
  createSession({ id: sessionId, kind: 'chat', title: `reconcile read-back ${label}` });
  const source = appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Create the growth-pod-449 channel and confirm it exists.' },
  });
  const execution = new ExecutionStore().create({
    sessionId,
    sourceUserSeq: source.seq,
    status: 'active',
    title: 'Create the channel',
    objective: 'Create the growth-pod-449 channel and verify it',
    reason: 'test',
    startedFromMessage: 'create it',
    confidence: 0.9,
    reasons: ['test'],
    successCriteria: 'The channel exists',
    nextStep: 'Create and verify',
  } as never);
  // The ambiguous write attempt: dispatch started, outcome never settled.
  appendEvent({
    sessionId, turn: 1, role: 'system', type: 'external_write',
    data: {
      sourceUserSeq: source.seq,
      callId: `channel-create-${label}`, canonicalCallId: `channel-create-${label}`,
      actionKey: 'chat:channel_create', shapeKey: 'SLACK_CREATE_CHANNEL',
      targets: ['growth-pod-449'], preDispatch: true,
    },
  });
  return { sessionId, sourceUserSeq: source.seq, execution, callId: `channel-create-${label}` };
}

/**
 * A clean, wide conversations-list read-back (~50KB) that RETURNS the write
 * target. The bulk sits under `data.channels` DELIBERATELY: the inspector's
 * result-array skip list spares `data.messages`/`records`/`items`, so a
 * fixture under one of those keys would never reach the 512-node traversal
 * bound. 220 channel objects x 3 nodes each exceed the bound; every
 * inspectable field is clean and channel growth-pod-449 is in the list.
 */
function wideCleanReadbackNamingTarget(): string {
  return JSON.stringify({
    successful: true,
    error: null,
    data: {
      ok: true,
      channels: Array.from({ length: 220 }, (_, i) => ({
        id: `C0${1300 + i}`,
        name: `growth-pod-${300 + i}`,
        is_channel: true,
        topic: { value: `Weekly growth sync ${300 + i}`, creator: 'U02QGK9AL', last_set: 1719430000 + i },
        purpose: { value: 'Pipeline reviews and follow-ups', creator: 'U02QGK9AL', last_set: 1719430000 + i },
      })),
      response_metadata: { next_cursor: '' },
    },
  });
}

test('a large clean read-back naming the write target reconciles PRESENT — an uninspectable envelope is not "contradicts success"', async () => {
  const { sessionId, sourceUserSeq, execution, callId } = fixture('present');
  // The evidence read must postdate the ambiguous attempt.
  await new Promise((resolve) => setTimeout(resolve, 10));
  appendExactToolLifecycle({
    sessionId,
    callId: 'list-channels-readback',
    arguments: { tool_slug: 'SLACK_LIST_ALL_CHANNELS', arguments: { limit: 220 } },
    output: wideCleanReadbackNamingTarget(),
  });
  const reconcile = registeredToolHandlers().get('execution_reconcile_write');
  assert.ok(reconcile, 'execution_reconcile_write should be registered');
  const ctx = { sessionId, sourceUserSeq, counter: new ToolCallsCounter(20) };
  const result = await withHarnessRunContext(ctx, () => reconcile!({
    id: execution.id,
    call_id: callId,
    verdict: 'present',
    evidence_call_id: 'list-channels-readback',
  }));
  // TARGET: today the bounded inspector reports its node limit as a
  // contradiction and the gate refuses ("the provider read envelope
  // contradicts success"), so no settlement lands and the duplicate-safety
  // hold never resolves.
  const settlements = listEvents(sessionId, { types: ['external_write_succeeded'] })
    .filter((event) => event.data.callId === callId);
  assert.equal(
    settlements.length,
    1,
    `the read-back settles the write as PRESENT; reconcile answered: ${result.content[0]?.text}`,
  );
  assert.equal(settlements[0]?.data.reason, 'reconciled_present');
});

test('GUARD: a read-back with a genuine structured contradiction WITHIN bounds still cannot prove PRESENT', async () => {
  const { sessionId, sourceUserSeq, execution, callId } = fixture('contradicted');
  await new Promise((resolve) => setTimeout(resolve, 10));
  // Fully inspectable, genuinely contradicted: successful:true beside an
  // explicit 5-digit failure status. This must KEEP refusing after inspection
  // limits become 'uninspected'.
  appendExactToolLifecycle({
    sessionId,
    callId: 'contradicted-readback',
    arguments: { tool_slug: 'SLACK_LIST_ALL_CHANNELS', arguments: { limit: 20 } },
    output: JSON.stringify({
      successful: true,
      error: null,
      data: { ok: true, channel: { id: 'C0999', name: 'growth-pod-449' }, status: 40401 },
    }),
  });
  const reconcile = registeredToolHandlers().get('execution_reconcile_write')!;
  const ctx = { sessionId, sourceUserSeq, counter: new ToolCallsCounter(20) };
  const result = await withHarnessRunContext(ctx, () => reconcile({
    id: execution.id,
    call_id: callId,
    verdict: 'present',
    evidence_call_id: 'contradicted-readback',
  }));
  assert.equal(
    listEvents(sessionId, { types: ['external_write_succeeded'] })
      .filter((event) => event.data.callId === callId).length,
    0,
    'a contradicted read-back settles nothing',
  );
  assert.match(result.content[0]?.text ?? '', /contradicts success/i);
});
