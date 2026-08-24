/**
 * RED — a newly accepted ordinary source must not inherit an older source's
 * provider-protocol hold.
 *
 * Run:
 *   npx tsx --test src/runtime/harness/fresh-source-session-independence.red.test.ts
 *
 * The ingress seam pinned here is deliberately provider-neutral. A durable
 * request identity and an exact audience identity select a session BEFORE a
 * provider receipt, run attempt, or user-input event is claimed. Explicitly
 * bound controls (for example `approve apr-xxxx`) keep their exact target.
 *
 * Ingress inspection is read-only. The existing run-turn preparation remains
 * the invariant backstop, but it is too late to choose ownership: it may repair
 * a persisted transcript and the fresh source may already be bound to that
 * session. Any preview that is held OR would migrate/quarantine bytes therefore
 * branches the ordinary source to a clean successor and leaves the parent
 * byte-identical.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import type { AgentInputItem } from '@openai/agents';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-fresh-source-session-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const eventlog = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const protocolSession = await import('./conversation-protocol-session.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const dispatch = await import('./dispatch-ledger.js');
const settlements = await import('./logical-call-settlement-store.js');
const outcomes = await import('./attempt-outcome.js');
const approvalRegistry = await import('./approval-registry.js');
const composition = await import('./session-composition.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

type ProtocolPreview = ReturnType<typeof protocolSession.preparePersistedSessionConversationProtocol>;
type PreviewProtocol = (input: { sessionId: string; now?: () => string }) => ProtocolPreview;

interface ContinuityIdentity {
  /** Provider/surface namespace, not a model or tool choice. */
  provider: string;
  /** Guild/team/account boundary when present. */
  scopeId: string | null;
  /** Channel/thread/device conversation boundary. */
  conversationId: string;
  /** Exact human/audience boundary. */
  audienceId: string;
}

type SessionSelectionInput = {
  entrySessionId: string;
  /** Stable provider request/run identity available before receipt claim. */
  durableSourceId: string;
  continuity: ContinuityIdentity;
  validatedMount?: {
    version: 1;
    kind: 'workspace';
    rootSessionId: string;
    workspaceSlug: string;
  };
} & (
  | { kind: 'ordinary' }
  | { kind: 'bound_control'; targetSessionId: string }
);

interface SessionSelection {
  sessionId: string;
  rootSessionId: string;
  disposition: 'reused' | 'branched' | 'identity_split' | 'bound_control' | 'receipt_replay';
}

interface AcceptedSourceSessionBranchApi {
  selectSessionForAcceptedSource(
    input: SessionSelectionInput,
  ): SessionSelection | Promise<SessionSelection>;
  claimSessionForAcceptedSource(
    input: SessionSelectionInput & {
      receipt: { requestId: string; runId: string; inputHash: string; sinceSeq?: number };
    },
  ): {
    selection: SessionSelection;
    receipt: { sessionId: string };
    inserted: boolean;
  } | Promise<{
    selection: SessionSelection;
    receipt: { sessionId: string };
    inserted: boolean;
  }>;
}

const BRANCH_MODULE_PATH: string = './accepted-source-session-branch.js';
let branchApi: AcceptedSourceSessionBranchApi | null = null;
try {
  branchApi = await import(BRANCH_MODULE_PATH) as unknown as AcceptedSourceSessionBranchApi;
} catch (error) {
  const code = (error as { code?: unknown })?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code !== 'ERR_MODULE_NOT_FOUND' || !message.includes('accepted-source-session-branch')) {
    throw error;
  }
}

function requirePreview(): PreviewProtocol {
  const preview = (protocolSession as unknown as {
    previewPersistedSessionConversationProtocol?: PreviewProtocol;
  }).previewPersistedSessionConversationProtocol;
  assert.equal(
    typeof preview,
    'function',
    'fresh-source admission needs a read-only protocol preview; the mutating run-turn prepare function is not an ingress selector',
  );
  return preview!;
}

function requireBranchApi(): AcceptedSourceSessionBranchApi {
  assert.ok(
    branchApi,
    'provider-neutral accepted-source session branching is not implemented (expected accepted-source-session-branch.ts)',
  );
  return branchApi!;
}

function user(text: string): AgentInputItem {
  return { role: 'user', content: text } as AgentInputItem;
}

function call(callId: string, name: string, args: unknown): AgentInputItem {
  return {
    type: 'function_call',
    callId,
    name,
    arguments: JSON.stringify(args),
    status: 'completed',
  } as AgentInputItem;
}

function result(callId: string): AgentInputItem {
  return {
    type: 'function_call_result',
    callId,
    name: 'legacy_read',
    output: { type: 'text', text: '{}' },
    status: 'completed',
  } as AgentInputItem;
}

let serial = 0;

function acceptedSession(input: {
  text: string;
  id?: string;
  channel?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}) {
  const userId = input.userId ?? 'user-a';
  const session = HarnessSession.create({
    id: input.id ?? `fresh-source-parent-${++serial}`,
    kind: 'chat',
    channel: input.channel ?? 'home',
    userId,
    metadata: input.metadata ?? {
      source: 'test-provider',
      channelId: 'conversation-a',
      userId,
    },
  });
  const source = session.recordUserInput(input.text, 1);
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  return {
    session,
    source,
    task: {
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: 1,
      acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
    },
  };
}

function rawMetadataJson(sessionId: string): string {
  const row = eventlog.openEventLog().prepare(
    'SELECT metadata_json FROM sessions WHERE id = ?',
  ).get(sessionId) as { metadata_json: string } | undefined;
  assert.ok(row, `missing session ${sessionId}`);
  return row.metadata_json;
}

function ordinarySelection(
  entrySessionId: string,
  durableSourceId: string,
  continuity: Partial<ContinuityIdentity> = {},
): SessionSelectionInput {
  return {
    kind: 'ordinary',
    entrySessionId,
    durableSourceId,
    continuity: {
      provider: continuity.provider ?? 'test-provider',
      scopeId: continuity.scopeId ?? null,
      conversationId: continuity.conversationId ?? 'conversation-a',
      audienceId: continuity.audienceId ?? 'user-a',
    },
  };
}

function assertCleanSuccessor(
  parentId: string,
  selected: SessionSelection,
  expectedRootSessionId: string = parentId,
): HarnessSession {
  assert.notEqual(selected.sessionId, parentId);
  assert.equal(selected.rootSessionId, expectedRootSessionId);
  const child = HarnessSession.load(selected.sessionId);
  assert.ok(child, 'the selected successor must exist before source/receipt acceptance');
  assert.deepEqual(child!.toInputItems(), [], 'unsafe parent provider history must not be copied');
  assert.equal(child!.loadInterruptState(), null, 'a parked parent RunState must remain parent-owned');
  const prepared = child!.prepareProviderHistory();
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  if (prepared.status === 'ready') {
    assert.equal(prepared.migration, 'none');
    assert.deepEqual(prepared.providerHistory, []);
  }
  return child!;
}

async function claimInTwoWorkers(
  claims: Array<SessionSelectionInput & {
    receipt: { requestId: string; runId: string; inputHash: string; sinceSeq?: number };
  }>,
): Promise<Array<Awaited<ReturnType<AcceptedSourceSessionBranchApi['claimSessionForAcceptedSource']>>>> {
  assert.equal(claims.length, 2);
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workers = claims.map((claim) => new Worker(
    new URL('./accepted-source-session-claim.worker.ts', import.meta.url),
    { workerData: { gate, claim }, execArgv: ['--import', 'tsx'] },
  ));
  let ready = 0;
  const results = workers.map((worker) => new Promise<Awaited<ReturnType<
    AcceptedSourceSessionBranchApi['claimSessionForAcceptedSource']
  >>>((resolve, reject) => {
    worker.on('message', (message: {
      kind: 'ready' | 'result' | 'error';
      result?: Awaited<ReturnType<AcceptedSourceSessionBranchApi['claimSessionForAcceptedSource']>>;
      error?: string;
    }) => {
      if (message.kind === 'ready') {
        ready += 1;
        if (ready === workers.length) {
          Atomics.store(new Int32Array(gate), 0, 1);
          Atomics.notify(new Int32Array(gate), 0, workers.length);
        }
      } else if (message.kind === 'result' && message.result) {
        resolve(message.result);
      } else if (message.kind === 'error') {
        reject(new Error(message.error));
      }
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`accepted-source claim worker exited ${code}`));
    });
  }));
  try {
    return await Promise.all(results);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

test('read-only preview reports a settlement-backed repair without changing parent bytes', () => {
  eventlog.resetEventLog();
  const fixture = acceptedSession({ text: 'Read the current records.' });
  const logicalToolCallId = 'call-preview-repair';
  const tool = 'records_read';
  const args = { query: 'current' };
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      ...fixture.task,
      logicalToolCallId,
      physicalDispatchId: 'dispatch-preview-repair',
      ordinal: 0,
    },
    tool,
    args,
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun));
  if (begun.status !== 'inserted') return;
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool,
    outcome: 'returned',
  }).status, 'inserted');
  assert.equal(settlements.commitLogicalCallSettlement({
    identity: { ...fixture.task, logicalToolCallId },
    contract: { toolName: tool, args },
    execution: { kind: 'provider_execution' },
    result: { payload: { successful: true, data: { records: [{ id: 'record-1' }] } } },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: false, mutating: false },
    observer: { lane: 'agents_runner', callId: logicalToolCallId, turn: 1 },
  }).status, 'committed');
  fixture.session.recordTurnResult({
    history: [user('Read the current records.'), call(logicalToolCallId, tool, args)],
    lastResponseId: 'provider-chain-before-preview',
    turn: 1,
  });
  const before = rawMetadataJson(fixture.session.id);

  const preview = requirePreview()({ sessionId: fixture.session.id });

  assert.equal(preview.status, 'ready', JSON.stringify(preview));
  assert.equal(preview.migration, 'paired_exact_result');
  assert.equal(rawMetadataJson(fixture.session.id), before, 'ingress preview must never persist its repair');
});

test('pending approval branches a new ordinary source before receipt claim; replay is deterministic and exact control stays on the parent', async () => {
  eventlog.resetEventLog();
  const fixture = acceptedSession({
    text: 'Prepare the protected action.',
    channel: 'discord',
    userId: 'user-a',
    metadata: { source: 'discord', channelId: 'channel-a', userId: 'user-a', guildId: 'guild-a' },
  });
  fixture.session.recordTurnResult({
    history: [user('Prepare the protected action.')],
    lastResponseId: 'parent-provider-chain',
    turn: 1,
  });
  fixture.session.saveInterruptState(JSON.stringify({
    __clemHostInterrupt: 2,
    history: [user('Prepare the protected action.')],
    pending: [{
      callId: 'call-pending',
      name: 'protected_action',
      rawItem: { callId: 'call-pending', name: 'protected_action', arguments: '{}' },
    }],
    turnEngine: 'host_v1',
  }));
  const approval = approvalRegistry.register({
    sessionId: fixture.session.id,
    channel: 'discord',
    channelId: 'channel-a',
    subject: 'Protected action',
  });
  const before = rawMetadataJson(fixture.session.id);
  const api = requireBranchApi();
  const pendingContinuity: ContinuityIdentity = {
    provider: 'discord',
    scopeId: 'guild-a',
    conversationId: 'channel-a',
    audienceId: 'user-a',
  };
  const input = ordinarySelection(fixture.session.id, 'provider-run-pending', pendingContinuity);

  const [first, concurrentReplay] = await Promise.all([
    api.selectSessionForAcceptedSource(input),
    api.selectSessionForAcceptedSource(input),
  ]);

  assert.equal(first.disposition, 'branched');
  assert.equal(concurrentReplay.sessionId, first.sessionId, 'one durable source must select one successor under concurrency');
  const child = assertCleanSuccessor(fixture.session.id, first);
  assert.equal(child.sessionRow.userId, 'user-a');
  assert.equal(rawMetadataJson(fixture.session.id), before, 'branch selection must not clear or repair the parked parent');
  assert.equal(fixture.session.loadInterruptState() !== null, true);
  assert.equal(approvalRegistry.get(approval.approvalId)?.sessionId, fixture.session.id);
  assert.equal(approvalRegistry.get(approval.approvalId)?.status, 'pending');

  // Two different provider sources can enter before either one has appended
  // its user edge. Receipt claim + occupancy selection serialize into a head
  // chain, so they can never begin overlapping attempts on one clean child.
  const [distinctOne, distinctTwo] = await claimInTwoWorkers([
    {
      ...ordinarySelection(fixture.session.id, 'provider-run-distinct-1', pendingContinuity),
      receipt: {
        requestId: 'request-distinct-1',
        runId: 'provider-run-distinct-1',
        inputHash: 'hash-distinct-1',
      },
    },
    {
      ...ordinarySelection(fixture.session.id, 'provider-run-distinct-2', pendingContinuity),
      receipt: {
        requestId: 'request-distinct-2',
        runId: 'provider-run-distinct-2',
        inputHash: 'hash-distinct-2',
      },
    },
  ]);
  assert.notEqual(distinctOne.selection.sessionId, first.sessionId);
  assert.notEqual(distinctTwo.selection.sessionId, first.sessionId);
  assert.notEqual(distinctTwo.selection.sessionId, distinctOne.selection.sessionId);
  assert.equal(distinctOne.receipt.sessionId, distinctOne.selection.sessionId);
  assert.equal(distinctTwo.receipt.sessionId, distinctTwo.selection.sessionId);
  const pointerAfterRace = eventlog.openEventLog().prepare(`
    SELECT head_session_id, revision FROM accepted_source_session_pointers WHERE root_session_id = ?
  `).get(fixture.session.id) as { head_session_id: string; revision: number };
  assert.equal(pointerAfterRace.revision, 3);
  const headClaim = [
    { claim: distinctOne, runId: 'provider-run-distinct-1' },
    { claim: distinctTwo, runId: 'provider-run-distinct-2' },
  ].find((candidate) => candidate.claim.selection.sessionId === pointerAfterRace.head_session_id);
  assert.ok(headClaim, 'one serialized claimant owns the durable head');

  const headAttempt = eventlog.beginRunAttempt(headClaim!.claim.selection.sessionId, {
    runId: headClaim!.runId,
  });
  const headSource = eventlog.recordRunAttemptUserInput(headAttempt, {
    turn: 1,
    role: 'user',
    data: { text: 'Serialized head source', runId: headClaim!.runId },
  });
  eventlog.appendEvent({
    sessionId: headClaim!.claim.selection.sessionId,
    turn: 1,
    role: 'Clem',
    type: 'conversation_completed',
    data: {
      sourceUserSeq: headSource.seq,
      terminalKey: `turn:${headSource.seq}`,
      status: 'done',
      reply: 'Finished second serialized source.',
    },
  });
  eventlog.finishRunAttempt(headAttempt, 'completed');

  // The pointer is durable, not a warm process-map optimization.
  eventlog.closeEventLog();
  const afterRestart = await api.selectSessionForAcceptedSource(
    ordinarySelection(fixture.session.id, 'provider-run-after-restart', pendingContinuity),
  );
  assert.equal(afterRestart.sessionId, headClaim!.claim.selection.sessionId);

  const receipt = eventlog.claimHarnessChatRequest({
    requestId: 'request-pending',
    sessionId: first.sessionId,
    runId: 'provider-run-pending',
    inputHash: 'input-hash-pending',
    sinceSeq: 0,
  });
  assert.equal(receipt.receipt.sessionId, first.sessionId, 'selection must precede and own the receipt claim');
  assert.notEqual(receipt.receipt.sessionId, fixture.session.id);

  // Once a receipt exists it wins even if the current head becomes held; a
  // replay never re-previews or follows a later pointer.
  approvalRegistry.register({ sessionId: first.sessionId, subject: 'Later child approval' });
  const receiptReplay = await api.claimSessionForAcceptedSource({
    ...ordinarySelection(fixture.session.id, 'provider-run-pending', pendingContinuity),
    receipt: {
      requestId: 'request-pending',
      runId: 'provider-run-pending',
      inputHash: 'input-hash-pending',
    },
  });
  assert.equal(receiptReplay.inserted, false);
  assert.equal(receiptReplay.selection.disposition, 'receipt_replay');
  assert.equal(receiptReplay.selection.sessionId, first.sessionId);
  await assert.rejects(
    async () => api.claimSessionForAcceptedSource({
      ...ordinarySelection(fixture.session.id, 'provider-run-pending', {
        ...pendingContinuity,
        audienceId: 'different-user',
      }),
      receipt: {
        requestId: 'request-pending',
        runId: 'provider-run-pending',
        inputHash: 'input-hash-pending',
      },
    }),
    /continuity principal/,
    'a receipt ID never reveals or reopens another principal session',
  );

  const control = await api.selectSessionForAcceptedSource({
    kind: 'bound_control',
    entrySessionId: first.sessionId,
    targetSessionId: approval.sessionId,
    durableSourceId: 'provider-run-approval-reply',
    continuity: {
      provider: 'discord',
      scopeId: 'guild-a',
      conversationId: 'channel-a',
      audienceId: 'user-a',
    },
  });
  assert.equal(control.disposition, 'bound_control');
  assert.equal(control.sessionId, fixture.session.id, 'an exact approval ID targets detached A, never the fresh successor');
  assert.equal(rawMetadataJson(fixture.session.id), before);
  await assert.rejects(
    async () => api.selectSessionForAcceptedSource({
      kind: 'bound_control',
      entrySessionId: first.sessionId,
      targetSessionId: approval.sessionId,
      durableSourceId: 'provider-run-forged-control',
      continuity: {
        provider: 'discord',
        scopeId: 'guild-a',
        conversationId: 'channel-a',
        audienceId: 'different-user',
      },
    }),
    /audience|principal/,
    'targetSessionId alone is never authority for a detached control',
  );
  for (const [label, continuity] of [
    ['provider', { provider: 'slack', scopeId: 'guild-a', conversationId: 'channel-a', audienceId: 'user-a' }],
    ['scope', { provider: 'discord', scopeId: 'guild-b', conversationId: 'channel-a', audienceId: 'user-a' }],
    ['conversation', { provider: 'discord', scopeId: 'guild-a', conversationId: 'channel-b', audienceId: 'user-a' }],
  ] as const) {
    await assert.rejects(
      async () => api.selectSessionForAcceptedSource({
        kind: 'bound_control',
        entrySessionId: first.sessionId,
        targetSessionId: approval.sessionId,
        durableSourceId: `provider-run-forged-${label}`,
        continuity,
      }),
      /provider|scope|conversation|principal/,
      `${label} mismatch must reject a detached control`,
    );
  }
  const incompleteControlTarget = HarnessSession.create({
    id: 'incomplete-control-target',
    kind: 'chat',
    channel: 'discord',
    userId: 'user-a',
    metadata: { source: 'discord', userId: 'user-a' },
  });
  await assert.rejects(
    async () => api.selectSessionForAcceptedSource({
      kind: 'bound_control',
      entrySessionId: first.sessionId,
      targetSessionId: incompleteControlTarget.id,
      durableSourceId: 'provider-run-incomplete-control-target',
      continuity: {
        provider: 'discord',
        scopeId: 'guild-a',
        conversationId: 'channel-a',
        audienceId: 'user-a',
      },
    }),
    /conversation|scope/,
    'a target missing required scope/conversation identity is not authoritative',
  );
});

test('reconciliation-required history branches without synthesizing an effect result into the parent', async () => {
  eventlog.resetEventLog();
  const fixture = acceptedSession({ text: 'Apply the change once.' });
  const logicalToolCallId = 'call-effect-unknown';
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      ...fixture.task,
      logicalToolCallId,
      physicalDispatchId: 'dispatch-effect-unknown',
      ordinal: 0,
    },
    tool: 'records_update',
    args: { id: 'record-1' },
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun));
  fixture.session.recordTurnResult({
    history: [user('Apply the change once.'), call(logicalToolCallId, 'records_update', { id: 'record-1' })],
    lastResponseId: 'provider-chain-effect-unknown',
    turn: 1,
  });
  const before = rawMetadataJson(fixture.session.id);

  const preview = requirePreview()({ sessionId: fixture.session.id });
  assert.equal(preview.status, 'held');
  if (preview.status === 'held') assert.equal(preview.disposition, 'reconciliation_required');
  assert.equal(rawMetadataJson(fixture.session.id), before, 'preview must not persist synthetic effect_unknown bytes');

  const selected = await requireBranchApi().selectSessionForAcceptedSource(
    ordinarySelection(fixture.session.id, 'provider-run-reconciliation'),
  );
  assert.equal(selected.disposition, 'branched');
  assertCleanSuccessor(fixture.session.id, selected);
  assert.equal(rawMetadataJson(fixture.session.id), before, 'successor creation must leave reconciliation ownership on A');
  eventlog.openEventLog().prepare('DELETE FROM sessions WHERE id = ?').run(fixture.session.id);
  assert.equal(eventlog.getSession(fixture.session.id), null, 'the historical parent may be reaped after branching');
  const replayAfterParentDelete = await requireBranchApi().selectSessionForAcceptedSource(
    ordinarySelection(fixture.session.id, 'provider-run-reconciliation'),
  );
  assert.equal(replayAfterParentDelete.sessionId, selected.sessionId);
  assert.ok(eventlog.getSession(selected.sessionId), 'opaque lineage keeps the selected successor and replay binding live');
  assert.throws(
    () => eventlog.openEventLog().prepare('DELETE FROM sessions WHERE id = ?').run(selected.sessionId),
    /FOREIGN KEY/,
    'the selected session cannot be deleted while its immutable replay binding exists',
  );
});

test('evidence-unavailable and quarantine-required history both branch without rewriting the parent', async () => {
  const cases: Array<{
    label: string;
    history: (text: string) => AgentInputItem[];
    preview: { status: 'held' | 'ready'; disposition?: string; migration: string };
  }> = [
    {
      label: 'evidence-unavailable',
      history: (text) => [user(text), call('call-no-evidence', 'unknown_operation', {})],
      preview: { status: 'held', disposition: 'evidence_unavailable', migration: 'none' },
    },
    {
      label: 'quarantine-required',
      history: (text) => [user(text), result('orphan-result')],
      preview: { status: 'ready', migration: 'quarantined' },
    },
  ];

  for (const fixtureCase of cases) {
    eventlog.resetEventLog();
    const fixture = acceptedSession({ text: `Parent ${fixtureCase.label}` });
    fixture.session.recordTurnResult({
      history: fixtureCase.history(`Parent ${fixtureCase.label}`),
      lastResponseId: `provider-chain-${fixtureCase.label}`,
      turn: 1,
    });
    const before = rawMetadataJson(fixture.session.id);
    const preview = requirePreview()({ sessionId: fixture.session.id });
    assert.equal(preview.status, fixtureCase.preview.status, `${fixtureCase.label}: ${JSON.stringify(preview)}`);
    assert.equal(preview.migration, fixtureCase.preview.migration, `${fixtureCase.label}: ${JSON.stringify(preview)}`);
    if (preview.status === 'held') {
      assert.equal(preview.disposition, fixtureCase.preview.disposition);
    }
    assert.equal(rawMetadataJson(fixture.session.id), before, `${fixtureCase.label}: preview mutated A`);

    const selected = await requireBranchApi().selectSessionForAcceptedSource(
      ordinarySelection(fixture.session.id, `provider-run-${fixtureCase.label}`),
    );
    assert.equal(selected.disposition, 'branched', fixtureCase.label);
    assertCleanSuccessor(fixture.session.id, selected);
    assert.equal(rawMetadataJson(fixture.session.id), before, `${fixtureCase.label}: selection mutated A`);
  }

  eventlog.resetEventLog();
  const corrupt = acceptedSession({ text: 'Corrupt legacy parent.' });
  eventlog.openEventLog().prepare(`UPDATE sessions SET metadata_json = ? WHERE id = ?`)
    .run('{not-json', corrupt.session.id);
  const corruptBefore = rawMetadataJson(corrupt.session.id);
  const corruptSplit = await requireBranchApi().selectSessionForAcceptedSource(
    ordinarySelection(corrupt.session.id, 'provider-run-corrupt-parent'),
  );
  assert.equal(corruptSplit.disposition, 'identity_split');
  assert.equal(corruptSplit.rootSessionId, corruptSplit.sessionId);
  assertCleanSuccessor(corrupt.session.id, corruptSplit, corruptSplit.sessionId);
  assert.equal(rawMetadataJson(corrupt.session.id), corruptBefore, 'malformed parent bytes stay untouched');

  eventlog.resetEventLog();
  const readFault = acceptedSession({ text: 'Preview read fault parent.' });
  readFault.session.recordTurnResult({
    history: [user('Preview read fault parent.')],
    lastResponseId: 'preview-read-fault-chain',
    turn: 1,
  });
  const readFaultBefore = rawMetadataJson(readFault.session.id);
  const db = eventlog.openEventLog();
  db.exec('ALTER TABLE pending_approvals RENAME TO pending_approvals_fault');
  const faultSplit = await requireBranchApi().selectSessionForAcceptedSource(
    ordinarySelection(readFault.session.id, 'provider-run-preview-read-fault'),
  );
  db.exec('ALTER TABLE pending_approvals_fault RENAME TO pending_approvals');
  assert.equal(faultSplit.disposition, 'branched');
  assertCleanSuccessor(readFault.session.id, faultSplit);
  assert.equal(rawMetadataJson(readFault.session.id), readFaultBefore, 'preview read faults branch without mutating A');
});

test('an audience mismatch splits before protocol preview and never imports raw cross-session context', async () => {
  eventlog.resetEventLog();
  const fixture = acceptedSession({
    text: 'Private work owned by user A.',
    channel: 'discord',
    userId: 'user-a',
    metadata: { source: 'discord', channelId: 'shared-channel', userId: 'user-a', guildId: 'guild-a' },
  });
  fixture.session.recordTurnResult({
    history: [user('Private work owned by user A.'), call('call-user-a', 'unknown_operation', {})],
    lastResponseId: 'private-provider-chain',
    turn: 1,
  });
  eventlog.appendEvent({
    sessionId: fixture.session.id,
    turn: 1,
    role: 'Clem',
    type: 'conversation_completed',
    data: { reply: 'PRIVATE-A-CONTEXT-MUST-NOT-CROSS' },
  });
  const before = rawMetadataJson(fixture.session.id);

  const selected = await requireBranchApi().selectSessionForAcceptedSource(
    ordinarySelection(fixture.session.id, 'provider-run-user-b', {
      provider: 'discord',
      scopeId: 'guild-a',
      conversationId: 'shared-channel',
      audienceId: 'user-b',
    }),
  );

  assert.equal(selected.disposition, 'identity_split');
  const child = assertCleanSuccessor(fixture.session.id, selected, selected.sessionId);
  assert.equal(child.sessionRow.userId, 'user-b', 'the successor audience comes from the accepted source, not A');
  assert.equal(rawMetadataJson(fixture.session.id), before, 'identity split must not prepare or mutate A');
  assert.equal(
    eventlog.listEvents(child.id, { types: ['cross_session_prefix'] }).length,
    0,
    'held/identity successors must not invoke the raw cross-session prefix/focus seeder',
  );
  assert.doesNotMatch(JSON.stringify(eventlog.listEvents(child.id)), /PRIVATE-A-CONTEXT-MUST-NOT-CROSS/);

  for (const [label, continuity] of [
    ['provider', { provider: 'slack', scopeId: 'guild-a', conversationId: 'shared-channel', audienceId: 'user-a' }],
    ['scope', { provider: 'discord', scopeId: 'guild-b', conversationId: 'shared-channel', audienceId: 'user-a' }],
    ['conversation', { provider: 'discord', scopeId: 'guild-a', conversationId: 'other-channel', audienceId: 'user-a' }],
  ] as const) {
    const split = await requireBranchApi().selectSessionForAcceptedSource(
      ordinarySelection(fixture.session.id, `provider-run-${label}-split`, continuity),
    );
    assert.equal(split.disposition, 'identity_split', label);
    assert.equal(split.rootSessionId, split.sessionId, `${label}: a new principal must own an independent root`);
    assert.equal(rawMetadataJson(fixture.session.id), before, `${label}: identity mismatch must not preview A`);
  }

  const anonymous = HarnessSession.create({
    id: 'legacy-null-audience',
    kind: 'chat',
    channel: 'discord',
    metadata: { source: 'discord', channelId: 'anonymous-channel', guildId: 'guild-a' },
  });
  const nullAudienceSplit = await requireBranchApi().selectSessionForAcceptedSource(
    ordinarySelection(anonymous.id, 'provider-run-null-audience', {
      provider: 'discord',
      scopeId: 'guild-a',
      conversationId: 'anonymous-channel',
      audienceId: 'user-a',
    }),
  );
  assert.equal(nullAudienceSplit.disposition, 'identity_split');
  assert.equal(nullAudienceSplit.rootSessionId, nullAudienceSplit.sessionId);
});

test('workspace successors preserve the workspace mount without copying the held transcript', async () => {
  eventlog.resetEventLog();
  const workspaceSlug = 'fresh-source-workspace';
  const fixture = acceptedSession({
    id: `space-${workspaceSlug}`,
    text: 'Edit this workspace after approval.',
    userId: 'workspace-user',
    metadata: { source: 'workspace', spaceSlug: workspaceSlug },
  });
  approvalRegistry.register({
    sessionId: fixture.session.id,
    subject: 'Workspace action',
  });
  const before = rawMetadataJson(fixture.session.id);
  const untrusted = await requireBranchApi().selectSessionForAcceptedSource(
    ordinarySelection(fixture.session.id, 'workspace-untrusted-metadata', {
      provider: 'mobile',
      conversationId: fixture.session.id,
      audienceId: 'workspace-user',
    }),
  );
  assert.equal(
    composition.composeSessionFromStore(untrusted.sessionId).kind,
    'chat',
    'raw parent spaceSlug/mount metadata is not cross-principal workspace authority',
  );
  const selected = await requireBranchApi().selectSessionForAcceptedSource(
    {
      ...ordinarySelection(fixture.session.id, 'workspace-request-2', {
        provider: 'mobile',
        conversationId: fixture.session.id,
        audienceId: 'workspace-user',
      }),
      validatedMount: {
        version: 1,
        kind: 'workspace',
        rootSessionId: fixture.session.id,
        workspaceSlug,
      },
    },
  );

  assert.equal(selected.disposition, 'identity_split');
  const child = assertCleanSuccessor(fixture.session.id, selected, selected.sessionId);
  const mount = composition.composeSessionFromStore(child.id);
  assert.equal(mount.kind, 'workspace');
  assert.equal(mount.workspaceSlug, workspaceSlug);
  assert.equal(rawMetadataJson(fixture.session.id), before);
});

test('Discord continuity is keyed by provider + guild/channel + user', async () => {
  eventlog.resetEventLog();
  const discordHarness = await import('../../channels/discord-harness.js');
  const harnessTest = discordHarness.__test__ as typeof discordHarness.__test__ & {
    resolveOrCreateSessionForTest?: (input: {
      channel: string;
      channelId: string;
      guildId: string | null;
      userId: string;
      prompt: string;
      durableSourceId: string;
    }) => Promise<{ id: string; isContinuation: boolean }>;
  };
  assert.equal(
    typeof harnessTest.resolveOrCreateSessionForTest,
    'function',
    'the real Discord ingress resolver must be testable at the pre-receipt session-selection seam',
  );

  const channelId = 'shared-discord-channel';
  const guildId = 'discord-guild';
  const parent = HarnessSession.create({
    id: 'discord-a-held-parent',
    kind: 'chat',
    channel: 'discord',
    userId: 'discord-user-a',
    metadata: { source: 'discord', channelId, userId: 'discord-user-a', guildId },
  });
  parent.recordUserInput('A private earlier request.', 1);
  parent.recordTurnResult({
    history: [user('A private earlier request.')],
    lastResponseId: 'discord-a-chain',
    turn: 1,
  });
  approvalRegistry.register({
    sessionId: parent.id,
    channel: 'discord',
    channelId,
    subject: 'A pending decision',
  });
  assert.equal(discordHarness.bindDiscordHarnessSession({
    channelId,
    sessionId: parent.id,
    userId: 'discord-user-a',
    guildId,
  }), true);
  const parentBefore = rawMetadataJson(parent.id);

  const userB = await harnessTest.resolveOrCreateSessionForTest!({
    channel: 'discord',
    channelId,
    guildId,
    userId: 'discord-user-b',
    prompt: 'A completely unrelated request from B.',
    durableSourceId: 'discord-message-b-1',
  });
  assert.notEqual(userB.id, parent.id, 'B must never inherit A through a channel-only pointer');
  assert.equal(HarnessSession.load(userB.id)?.sessionRow.userId, 'discord-user-b');
  assert.equal(rawMetadataJson(parent.id), parentBefore, 'direct identity mismatch bypasses A without protocol preparation');
  assert.equal(eventlog.listEvents(userB.id, { types: ['cross_session_prefix'] }).length, 0);

  const userA = await harnessTest.resolveOrCreateSessionForTest!({
    channel: 'discord',
    channelId,
    guildId,
    userId: 'discord-user-a',
    prompt: 'A new unrelated request while the old approval stays parked.',
    durableSourceId: 'discord-message-a-2',
  });
  assert.notEqual(userA.id, parent.id);
  assert.notEqual(userA.id, userB.id, 'audiences in one channel keep independent continuity pointers');
  assert.equal(eventlog.listEvents(userA.id, { types: ['cross_session_prefix'] }).length, 0);
  assert.equal(rawMetadataJson(parent.id), parentBefore);
});
