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
import { createHash } from 'node:crypto';
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
const capabilityManifests = await import('../runtime/harness/capability-manifest.js');
const capabilityCatalog = await import('../runtime/harness/host-capability-catalog-factory.js');

const READ_OPERATION = 'SLACK_LIST_ALL_CHANNELS';
const WRITE_OPERATION = 'OPAQUE_PROVIDER_OPERATION_7';
const priorCapabilityCatalog = capabilityCatalog.peekHostCapabilityCatalogFactory();

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function providerManifest(
  operationId: string,
  effect: 'read' | 'external_write',
) {
  const write = effect === 'external_write';
  return capabilityManifests.attachSemanticContract({
    version: 1,
    manifestId: `cap:reconcile:${digest(operationId).slice(0, 20)}`,
    providerKind: 'composio',
    operationId,
    providerIdentity: 'fixture:provider',
    providerVersion: 'fixture-v1',
    operationVersion: '1',
    definitionFingerprint: digest(`schema:${operationId}`),
    effect,
    ...(write ? {
      operationSemantics: { version: 1 as const, reversibility: 'reversible' as const },
      destination: { family: 'generic-records', posture: 'create_new' as const },
    } : {}),
    accountId: 'account:reconcile-fixture',
    idempotency: { required: write, policy: write ? 'key_before_dispatch' as const : 'none' as const },
    reconciliation: { supported: write, policy: write ? 'exact_artifact' as const : 'none' as const },
    outputContract: { kind: write ? 'created_resource' : 'records' },
    evidenceContract: {
      kinds: write ? ['receipt', 'readback'] : ['payload'],
      readbackRequired: write,
    },
    provenance: { issuer: 'host:test', issuedAt: '2026-08-27T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: write ? ['destination'] : ['source'],
  });
}

const providerManifests = [
  providerManifest(READ_OPERATION, 'read'),
  providerManifest(WRITE_OPERATION, 'external_write'),
];
capabilityCatalog.installHostCapabilityCatalogFactory(
  capabilityCatalog.createHostCapabilityCatalogFactory(providerManifests.map((manifest) => ({
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    ...(manifest.destination ? { destination: manifest.destination } : {}),
    account: manifest.accountId,
    manifestDigest: capabilityManifests.capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => ({ successful: true }),
  }))),
);

test.after(() => {
  capabilityCatalog.installHostCapabilityCatalogFactory(priorCapabilityCatalog);
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
  effect?: 'read' | 'external_write';
  effectiveTool?: string;
}): void {
  const tool = 'composio_execute_tool';
  const args = input.arguments && typeof input.arguments === 'object' && !Array.isArray(input.arguments)
    ? input.arguments as Record<string, unknown>
    : null;
  const effectiveTool = input.effectiveTool
    ?? (typeof args?.tool_slug === 'string' ? args.tool_slug : undefined);
  const effect = input.effect ?? 'read';
  const called = appendEvent({
    sessionId: input.sessionId,
    turn: 2,
    role: 'system',
    type: 'tool_called',
    data: {
      tool,
      callId: input.callId,
      canonicalCallId: input.callId,
      effect,
      ...(effectiveTool ? { effectiveTool } : {}),
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
      effect,
      ...(effectiveTool ? { effectiveTool } : {}),
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
    arguments: { tool_slug: READ_OPERATION, arguments: { limit: 220 } },
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
    arguments: { tool_slug: READ_OPERATION, arguments: { limit: 20 } },
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

test('the canonical effective operation re-opens manifest authority when the bounded outer argument preview is unreadable', async () => {
  const { sessionId, sourceUserSeq, execution, callId } = fixture('bounded-args');
  await new Promise((resolve) => setTimeout(resolve, 10));
  appendExactToolLifecycle({
    sessionId,
    callId: 'bounded-args-readback',
    effectiveTool: READ_OPERATION,
    // Production stores only a bounded preview of top-level SDK arguments. A
    // large request can therefore end mid-JSON even though effectiveTool was
    // derived from the complete input before clipping.
    arguments: `{"tool_slug":"${READ_OPERATION}","arguments":{"query":"${'x'.repeat(8_000)}`,
    output: JSON.stringify({
      successful: true,
      error: null,
      data: { ok: true, channel: { id: 'C0999', name: 'growth-pod-449' } },
    }),
  });
  const reconcile = registeredToolHandlers().get('execution_reconcile_write')!;
  const ctx = { sessionId, sourceUserSeq, counter: new ToolCallsCounter(20) };
  const result = await withHarnessRunContext(ctx, () => reconcile({
    id: execution.id,
    call_id: callId,
    verdict: 'present',
    evidence_call_id: 'bounded-args-readback',
  }));
  assert.equal(
    listEvents(sessionId, { types: ['external_write_succeeded'] })
      .filter((event) => event.data.callId === callId).length,
    1,
    result.content[0]?.text,
  );
});

test('GUARD: a lifecycle read label cannot turn an unknown or manifest-declared write operation into read-back authority', async () => {
  for (const [label, operation] of [
    ['unknown-effect', 'UNREGISTERED_OPAQUE_PROVIDER_OPERATION_9'],
    ['manifest-write', WRITE_OPERATION],
  ] as const) {
    const { sessionId, sourceUserSeq, execution, callId } = fixture(label);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const evidenceCallId = `${label}-readback`;
    appendExactToolLifecycle({
      sessionId,
      callId: evidenceCallId,
      // Deliberately pin the durable label to `read`: current manifest
      // authority must still win, and an absent manifest must fail closed.
      effect: 'read',
      arguments: { tool_slug: operation, arguments: { exact: 'growth-pod-449' } },
      output: JSON.stringify({
        successful: true,
        error: null,
        data: { ok: true, channel: { id: 'C0999', name: 'growth-pod-449' } },
      }),
    });
    const reconcile = registeredToolHandlers().get('execution_reconcile_write')!;
    const ctx = { sessionId, sourceUserSeq, counter: new ToolCallsCounter(20) };
    const result = await withHarnessRunContext(ctx, () => reconcile({
      id: execution.id,
      call_id: callId,
      verdict: 'present',
      evidence_call_id: evidenceCallId,
    }));
    assert.equal(
      listEvents(sessionId, { types: ['external_write_succeeded'] })
        .filter((event) => event.data.callId === callId).length,
      0,
      `${label} settles nothing`,
    );
    assert.match(result.content[0]?.text ?? '', /not a provably read-only tool call/i, label);
  }
});
