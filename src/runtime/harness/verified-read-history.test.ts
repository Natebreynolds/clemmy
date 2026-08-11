import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-verified-read-history-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  appendEvent,
  closeEventLog,
  createSession,
  openEventLog,
  resetEventLog,
  writeToolOutput,
} = await import('./eventlog.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { resolveLatestTrustedPriorVerifiedRead } = await import('./verified-read-history.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
type EventRow = import('./eventlog.js').EventRow;
type ExactVerifiedReadCompletionCertificate =
  import('./verified-read-completion.js').ExactVerifiedReadCompletionCertificate;

const TOOL = 'PROOF_LIST_TASKS';

test.after(() => {
  closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test.beforeEach(() => {
  resetEventLog();
});

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function acceptedSource(sessionId: string, turn: number, text = 'Read the queue.'): EventRow {
  return appendEvent({
    sessionId,
    turn,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
}

interface ReadPair {
  call: EventRow;
  returned: EventRow;
  callId: string;
  attemptId: string;
  effectiveTool: string;
  output: string;
}

function appendReadPair(input: {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  callId: string;
  attemptId: string;
  output: string;
  args?: unknown;
  outerTool?: string;
  effectiveTool?: string;
  invocationNonce?: string;
  returnedPatch?: Record<string, unknown>;
}): ReadPair {
  const outerTool = input.outerTool ?? 'call_tool';
  const effectiveTool = input.effectiveTool ?? TOOL;
  const call = appendEvent({
    sessionId: input.sessionId,
    turn: input.turn,
    role: 'Orchestrator',
    type: 'tool_called',
    data: {
      sourceUserSeq: input.sourceUserSeq,
      attemptId: input.attemptId,
      callId: input.callId,
      canonicalCallId: input.callId,
      accounting: 'top_level',
      effect: 'read',
      effectiveTool,
      tool: outerTool,
      arguments: JSON.stringify(input.args ?? { queue: 'proof-release' }),
    },
  });
  writeToolOutput({
    sessionId: input.sessionId,
    callId: input.callId,
    invocationNonce: input.invocationNonce ?? `nonce:${input.callId}`,
    tool: outerTool,
    output: input.output,
  });
  const returned = appendEvent({
    sessionId: input.sessionId,
    turn: input.turn,
    role: 'Orchestrator',
    type: 'tool_returned',
    parentEventId: call.id,
    data: {
      sourceUserSeq: input.sourceUserSeq,
      attemptId: input.attemptId,
      callId: input.callId,
      canonicalCallId: input.callId,
      accounting: 'top_level',
      effect: 'read',
      effectiveTool,
      tool: outerTool,
      ok: true,
      providerDispatched: true,
      result: input.output,
      ...input.returnedPatch,
    },
  });
  return { call, returned, callId: input.callId, attemptId: input.attemptId, effectiveTool, output: input.output };
}

function receiptFor(
  source: EventRow,
  read: ReadPair,
  reply: string,
  patch: Partial<ExactVerifiedReadCompletionCertificate> = {},
): ExactVerifiedReadCompletionCertificate {
  return {
    version: 1,
    kind: 'single_collection_read',
    sourceUserSeq: source.seq,
    attemptId: read.attemptId,
    callId: read.callId,
    toolName: read.effectiveTool,
    outputDigest: digest(read.output),
    objectiveDigest: digest('Read the proof release queue.'),
    presentationDigest: digest(reply),
    ...patch,
  };
}

function commitVerifiedRead(input: {
  sessionId: string;
  source: EventRow;
  read: ReadPair;
  reply?: string;
  receiptPatch?: Partial<ExactVerifiedReadCompletionCertificate>;
}): { terminal: EventRow; receipt: ExactVerifiedReadCompletionCertificate } {
  const reply = input.reply ?? 'The proof release queue contains one open item.';
  const identity = {
    sessionId: input.sessionId,
    turn: input.source.turn,
    sourceUserSeq: input.source.seq,
  };
  const receipt = receiptFor(input.source, input.read, reply, input.receiptPatch);
  const committed = commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text: reply },
  }, { metadata: { verifiedReadCompletionReceipt: receipt } });
  return { terminal: committed.event, receipt };
}

function resolve(
  sessionId: string,
  currentSourceUserSeq: number,
  expectedEffectiveTool = TOOL,
  currentCallSeq?: number,
) {
  return resolveLatestTrustedPriorVerifiedRead({
    sessionId,
    currentSourceUserSeq,
    expectedEffectiveTool,
    ...(currentCallSeq ? { currentCallSeq } : {}),
  });
}

function appendLearningReceipt(input: {
  sessionId: string;
  sourceUserSeq: number;
  attemptId: string;
  receiptId: string;
  evidenceDigest: string;
  accountIdentity?: string;
  effectiveTool?: string;
}): void {
  appendEvent({
    sessionId: input.sessionId,
    turn: 0,
    role: 'system',
    type: 'read_receipt',
    data: {
      record: {
        receiptId: input.receiptId,
        at: new Date().toISOString(),
        provider: 'proof',
        operation: 'list_tasks',
        effectClass: 'read',
        identifier: input.effectiveTool ?? TOOL,
        schemaFingerprint: 'schema-proof-v1',
        scope: { tenant: 'test-machine', workspace: TMP_HOME, accountIdentity: input.accountIdentity ?? '' },
        dispatchOutcome: 'succeeded',
        source: {
          sessionId: input.sessionId,
          sourceUserSeq: input.sourceUserSeq,
          attemptId: input.attemptId,
        },
        readEvidenceRef: `evt:${input.evidenceDigest}`,
      },
    },
  });
}

function appendCapabilityOrigin(input: {
  sessionId: string;
  sourceUserSeq: number;
  originSessionId: string;
  originSourceUserSeq: number;
  receiptId: string;
  evidenceDigest: string;
  authoritativeForTask?: boolean;
  accountIdentity?: string;
}): void {
  appendEvent({
    sessionId: input.sessionId,
    turn: 0,
    role: 'system',
    type: 'capability_resolution',
    data: {
      sourceUserSeq: input.sourceUserSeq,
      authoritativeForTask: input.authoritativeForTask ?? true,
      registryAvailable: true,
      entries: [{
        intent: 'proof.list_tasks',
        kind: 'composio',
        identifier: TOOL,
        status: 'proven',
        connection: 'active',
        effectClass: 'read',
        ...(input.accountIdentity ? { accountIdentity: input.accountIdentity } : {}),
        verifiedReadOrigin: {
          version: 1,
          sessionId: input.originSessionId,
          sourceUserSeq: input.originSourceUserSeq,
          receiptId: input.receiptId,
          evidenceDigest: input.evidenceDigest,
        },
      }],
    },
  });
}

function buildCrossSessionHistory(input: {
  coldSession: Parameters<typeof createSession>[0];
  learnedSession: Parameters<typeof createSession>[0];
  interveningSession?: Parameters<typeof createSession>[0];
}) {
  const cold = createSession(input.coldSession);
  const coldSource = acceptedSource(cold.id, 1);
  const args = { connected_account_id: null, queue: 'proof-release' };
  const coldRead = appendReadPair({
    sessionId: cold.id,
    sourceUserSeq: coldSource.seq,
    turn: 1,
    callId: `cold:${cold.id}`,
    attemptId: `attempt:${cold.id}`,
    args,
    output: JSON.stringify({ successful: true, revision: 1 }),
  });
  commitVerifiedRead({ sessionId: cold.id, source: coldSource, read: coldRead });
  const evidenceDigest = digest(`evidence:${cold.id}`).slice(0, 24);
  const receiptId = `rr_${digest(`receipt:${cold.id}`).slice(0, 32)}`;
  appendLearningReceipt({
    sessionId: cold.id,
    sourceUserSeq: coldSource.seq,
    attemptId: coldRead.attemptId,
    receiptId,
    evidenceDigest,
  });

  if (input.interveningSession) {
    const intervening = createSession(input.interveningSession);
    const source = acceptedSource(intervening.id, 1);
    appendReadPair({
      sessionId: intervening.id,
      sourceUserSeq: source.seq,
      turn: 1,
      callId: `intervening:${intervening.id}`,
      attemptId: `attempt:${intervening.id}`,
      args,
      output: JSON.stringify({ successful: true, revision: 2 }),
    });
  }

  const learned = createSession(input.learnedSession);
  const currentSource = acceptedSource(learned.id, 1);
  appendCapabilityOrigin({
    sessionId: learned.id,
    sourceUserSeq: currentSource.seq,
    originSessionId: cold.id,
    originSourceUserSeq: coldSource.seq,
    receiptId,
    evidenceDigest,
  });
  const currentRead = appendReadPair({
    sessionId: learned.id,
    sourceUserSeq: currentSource.seq,
    turn: 1,
    callId: `current:${learned.id}`,
    attemptId: `attempt:${learned.id}`,
    args,
    output: JSON.stringify({ successful: true, revision: 1 }),
  });
  return { coldRead, learned, currentSource, currentRead };
}

test('returns exact prior receipt lineage, decoded args, and raw authority bytes', () => {
  const session = createSession({ kind: 'chat' });
  const source = acceptedSource(session.id, 1);
  const output = `${JSON.stringify({ successful: true, items: [{ id: 'proof-release-1', status: 'open' }] })}\nraw suffix`;
  const read = appendReadPair({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    callId: 'verified-call-1',
    attemptId: 'verified-attempt-1',
    args: { queue: 'proof-release', limit: 25 },
    output,
  });
  const committed = commitVerifiedRead({ sessionId: session.id, source, read });
  const current = acceptedSource(session.id, 2, 'Refresh it.');

  const evidence = resolve(session.id, current.seq);
  assert.ok(evidence);
  assert.deepEqual(evidence.lineage.receipt, committed.receipt);
  assert.deepEqual(evidence.toolArgs, { queue: 'proof-release', limit: 25 });
  assert.equal(evidence.rawOutput, output, 'authority bytes are not trimmed or parsed into a snapshot');
  assert.deepEqual(evidence.lineage.terminal, {
    eventId: committed.terminal.id,
    seq: committed.terminal.seq,
    turn: 1,
  });
  assert.deepEqual(evidence.lineage.lifecycle, {
    callEventId: read.call.id,
    callSeq: read.call.seq,
    returnEventId: read.returned.id,
    returnSeq: read.returned.seq,
  });
});

test('chooses the latest trusted prior receipt for the expected effective tool', () => {
  const session = createSession({ kind: 'chat' });
  const firstSource = acceptedSource(session.id, 1);
  const first = appendReadPair({
    sessionId: session.id,
    sourceUserSeq: firstSource.seq,
    turn: 1,
    callId: 'verified-call-old',
    attemptId: 'verified-attempt-old',
    output: JSON.stringify({ successful: true, revision: 1 }),
  });
  commitVerifiedRead({ sessionId: session.id, source: firstSource, read: first });

  const secondSource = acceptedSource(session.id, 2);
  const second = appendReadPair({
    sessionId: session.id,
    sourceUserSeq: secondSource.seq,
    turn: 2,
    callId: 'verified-call-new',
    attemptId: 'verified-attempt-new',
    output: JSON.stringify({ successful: true, revision: 2 }),
  });
  commitVerifiedRead({ sessionId: session.id, source: secondSource, read: second });
  const current = acceptedSource(session.id, 3);

  const evidence = resolve(session.id, current.seq);
  assert.equal(evidence?.lineage.receipt.callId, second.callId);
  assert.equal(evidence?.rawOutput, second.output);
});

test('digest mismatch, failed output, and truncated authority each fail closed', async (t) => {
  await t.test('digest mismatch', () => {
    const session = createSession({ kind: 'chat' });
    const source = acceptedSource(session.id, 1);
    const read = appendReadPair({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: 1,
      callId: 'digest-mismatch',
      attemptId: 'attempt-digest',
      output: JSON.stringify({ successful: true, revision: 1 }),
    });
    commitVerifiedRead({
      sessionId: session.id,
      source,
      read,
      receiptPatch: { outputDigest: '0'.repeat(64) },
    });
    const current = acceptedSource(session.id, 2);
    assert.equal(resolve(session.id, current.seq), null);
  });

  await t.test('failure-shaped output', () => {
    resetEventLog();
    const session = createSession({ kind: 'chat' });
    const source = acceptedSource(session.id, 1);
    const read = appendReadPair({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: 1,
      callId: 'failed-output',
      attemptId: 'attempt-failed',
      output: JSON.stringify({ successful: false, error: 'provider unavailable' }),
      returnedPatch: { ok: false },
    });
    commitVerifiedRead({ sessionId: session.id, source, read });
    const current = acceptedSource(session.id, 2);
    assert.equal(resolve(session.id, current.seq), null);
  });

  await t.test('truncated authority marker', () => {
    resetEventLog();
    const session = createSession({ kind: 'chat' });
    const source = acceptedSource(session.id, 1);
    const read = appendReadPair({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: 1,
      callId: 'truncated-output',
      attemptId: 'attempt-truncated',
      output: JSON.stringify({ successful: true, items: [{ id: 'one' }] }),
    });
    openEventLog().prepare(`
      UPDATE tool_output_invocations
         SET truncated_at_write = 1
       WHERE session_id = ? AND call_id = ?
    `).run(session.id, read.callId);
    commitVerifiedRead({ sessionId: session.id, source, read });
    const current = acceptedSource(session.id, 2);
    assert.equal(resolve(session.id, current.seq), null);
  });
});

test('foreign effective tool or receipt source cannot satisfy the request', async (t) => {
  await t.test('foreign effective tool', () => {
    const session = createSession({ kind: 'chat' });
    const source = acceptedSource(session.id, 1);
    const read = appendReadPair({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: 1,
      callId: 'foreign-tool',
      attemptId: 'attempt-foreign-tool',
      effectiveTool: 'PROOF_LIST_USERS',
      output: JSON.stringify({ successful: true, users: [] }),
    });
    commitVerifiedRead({ sessionId: session.id, source, read });
    const current = acceptedSource(session.id, 2);
    assert.equal(resolve(session.id, current.seq, TOOL), null);
  });

  await t.test('foreign lifecycle source', () => {
    resetEventLog();
    const session = createSession({ kind: 'chat' });
    const receiptSource = acceptedSource(session.id, 1);
    const foreignSource = acceptedSource(session.id, 2);
    const read = appendReadPair({
      sessionId: session.id,
      sourceUserSeq: foreignSource.seq,
      turn: 2,
      callId: 'foreign-source',
      attemptId: 'attempt-foreign-source',
      output: JSON.stringify({ successful: true, items: [] }),
    });
    commitVerifiedRead({ sessionId: session.id, source: receiptSource, read });
    const current = acceptedSource(session.id, 3);
    assert.equal(resolve(session.id, current.seq), null);
  });
});

test('a receipt outside conversation_completed is uncommitted and has no authority', () => {
  const session = createSession({ kind: 'chat' });
  const source = acceptedSource(session.id, 1);
  const read = appendReadPair({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    callId: 'uncommitted-read',
    attemptId: 'attempt-uncommitted',
    output: JSON.stringify({ successful: true, items: [] }),
  });
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'conversation_recovery_candidate',
    data: {
      sourceUserSeq: source.seq,
      verifiedReadCompletionReceipt: receiptFor(source, read, 'Not committed.'),
    },
  });
  const current = acceptedSource(session.id, 2);
  assert.equal(resolve(session.id, current.seq), null);
});

test('a committed receipt with any non-v1 field fails exact-shape validation', () => {
  const session = createSession({ kind: 'chat' });
  const source = acceptedSource(session.id, 1);
  const read = appendReadPair({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    callId: 'widened-receipt',
    attemptId: 'attempt-widened',
    output: JSON.stringify({ successful: true, items: [] }),
  });
  const { terminal } = commitVerifiedRead({ sessionId: session.id, source, read });
  openEventLog().prepare(`
    UPDATE events
       SET data_json = json_set(
         data_json,
         '$.verifiedReadCompletionReceipt.untrustedExtension',
         1
       )
     WHERE id = ?
  `).run(terminal.id);
  const current = acceptedSource(session.id, 2);
  assert.equal(resolve(session.id, current.seq), null);
});

test('a later physical read of the same effective tool stales the prior receipt', () => {
  const session = createSession({ kind: 'chat' });
  const source = acceptedSource(session.id, 1);
  const prior = appendReadPair({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    callId: 'prior-read',
    attemptId: 'attempt-prior',
    output: JSON.stringify({ successful: true, revision: 1 }),
  });
  commitVerifiedRead({ sessionId: session.id, source, read: prior });
  const interveningSource = acceptedSource(session.id, 2);
  appendReadPair({
    sessionId: session.id,
    sourceUserSeq: interveningSource.seq,
    turn: 2,
    callId: 'intervening-read',
    attemptId: 'attempt-intervening',
    output: JSON.stringify({ successful: true, revision: 2 }),
  });
  const current = acceptedSource(session.id, 3);
  assert.equal(resolve(session.id, current.seq), null);
});

test('an exact no-dispatch replay does not stale prior physical evidence, but replay cannot originate it', async (t) => {
  await t.test('later replay is ignored', () => {
    const session = createSession({ kind: 'chat' });
    const source = acceptedSource(session.id, 1);
    const physical = appendReadPair({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: 1,
      callId: 'physical-origin',
      attemptId: 'attempt-physical',
      output: JSON.stringify({ successful: true, revision: 1 }),
    });
    commitVerifiedRead({ sessionId: session.id, source, read: physical });
    const replaySource = acceptedSource(session.id, 2);
    appendReadPair({
      sessionId: session.id,
      sourceUserSeq: replaySource.seq,
      turn: 2,
      callId: 'logical-replay',
      attemptId: 'attempt-replay',
      output: physical.output,
      returnedPatch: {
        providerDispatched: false,
        replayKind: 'same_source_settled_read_replay',
        canonicalCallId: physical.callId,
      },
    });
    const current = acceptedSource(session.id, 3);
    assert.equal(resolve(session.id, current.seq)?.lineage.receipt.callId, physical.callId);
  });

  await t.test('replay receipt is rejected', () => {
    resetEventLog();
    const session = createSession({ kind: 'chat' });
    const source = acceptedSource(session.id, 1);
    const replay = appendReadPair({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: 1,
      callId: 'replay-origin',
      attemptId: 'attempt-replay-origin',
      output: JSON.stringify({ successful: true, revision: 1 }),
      returnedPatch: {
        providerDispatched: false,
        replayKind: 'same_source_settled_read_replay',
      },
    });
    commitVerifiedRead({ sessionId: session.id, source, read: replay });
    const current = acceptedSource(session.id, 2);
    assert.equal(resolve(session.id, current.seq), null);
  });
});

test('ambiguous reused call ids fail closed even when one output matches the receipt', () => {
  const session = createSession({ kind: 'chat' });
  const source = acceptedSource(session.id, 1);
  const first = appendReadPair({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    callId: 'ambiguous-call',
    attemptId: 'attempt-ambiguous',
    invocationNonce: 'nonce:ambiguous:first',
    output: JSON.stringify({ successful: true, revision: 1 }),
  });
  appendReadPair({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    callId: 'ambiguous-call',
    attemptId: 'attempt-ambiguous',
    invocationNonce: 'nonce:ambiguous:second',
    output: JSON.stringify({ successful: true, revision: 2 }),
  });
  commitVerifiedRead({ sessionId: session.id, source, read: first });
  const current = acceptedSource(session.id, 2);
  assert.equal(resolve(session.id, current.seq), null);
});

test('a runtime-owned learned-capability origin authorizes one exact cross-session prior', () => {
  const cold = createSession({ kind: 'chat', channel: 'cli', userId: 'console' });
  const coldSource = acceptedSource(cold.id, 1, 'Read the proof release queue.');
  const coldRead = appendReadPair({
    sessionId: cold.id,
    sourceUserSeq: coldSource.seq,
    turn: 1,
    callId: 'cross-session-origin-call',
    attemptId: 'cross-session-origin-attempt',
    args: { connected_account_id: null, queue: 'proof-release' },
    output: JSON.stringify({ successful: true, revision: 1, items: [{ id: 'one', status: 'open' }] }),
  });
  commitVerifiedRead({ sessionId: cold.id, source: coldSource, read: coldRead });
  const evidenceDigest = digest('cross-session-learning').slice(0, 24);
  const receiptId = `rr_${digest('cross-session-receipt').slice(0, 32)}`;
  appendLearningReceipt({
    sessionId: cold.id,
    sourceUserSeq: coldSource.seq,
    attemptId: coldRead.attemptId,
    receiptId,
    evidenceDigest,
  });

  const learned = createSession({ kind: 'chat', channel: 'cli', userId: 'console' });
  const currentSource = acceptedSource(learned.id, 1, 'Refresh the same queue.');
  appendCapabilityOrigin({
    sessionId: learned.id,
    sourceUserSeq: currentSource.seq,
    originSessionId: cold.id,
    originSourceUserSeq: coldSource.seq,
    receiptId,
    evidenceDigest,
  });
  const currentRead = appendReadPair({
    sessionId: learned.id,
    sourceUserSeq: currentSource.seq,
    turn: 1,
    callId: 'cross-session-current-call',
    attemptId: 'cross-session-current-attempt',
    args: { connected_account_id: null, queue: 'proof-release' },
    output: JSON.stringify({ successful: true, revision: 1, items: [{ id: 'one', status: 'open' }] }),
  });

  const evidence = resolve(learned.id, currentSource.seq, TOOL, currentRead.call.seq);
  assert.equal(evidence?.lineage.receipt.callId, coldRead.callId);
  assert.equal(evidence?.rawOutput, coldRead.output);
});

test('cross-session origin fails closed without exact task, learning, and ordering authority', async (t) => {
  function topology(options: {
    authoritativeForTask?: boolean;
    receiptTool?: string;
    addInterveningRead?: boolean;
  } = {}) {
    const cold = createSession({ kind: 'chat', channel: 'cli', userId: 'console' });
    const coldSource = acceptedSource(cold.id, 1);
    const coldRead = appendReadPair({
      sessionId: cold.id,
      sourceUserSeq: coldSource.seq,
      turn: 1,
      callId: `cold-${cold.id}`,
      attemptId: `attempt-${cold.id}`,
      args: { connected_account_id: null, queue: 'proof-release' },
      output: JSON.stringify({ successful: true, revision: 1 }),
    });
    commitVerifiedRead({ sessionId: cold.id, source: coldSource, read: coldRead });
    const evidenceDigest = digest(cold.id).slice(0, 24);
    const receiptId = `rr_${digest(`receipt:${cold.id}`).slice(0, 32)}`;
    appendLearningReceipt({
      sessionId: cold.id,
      sourceUserSeq: coldSource.seq,
      attemptId: coldRead.attemptId,
      receiptId,
      evidenceDigest,
      effectiveTool: options.receiptTool,
    });
    if (options.addInterveningRead) {
      const other = createSession({ kind: 'chat', channel: 'cli', userId: 'console' });
      const otherSource = acceptedSource(other.id, 1);
      appendReadPair({
        sessionId: other.id,
        sourceUserSeq: otherSource.seq,
        turn: 1,
        callId: `intervening-${other.id}`,
        attemptId: `intervening-attempt-${other.id}`,
        args: { connected_account_id: null, queue: 'proof-release' },
        output: JSON.stringify({ successful: true, revision: 2 }),
      });
    }
    const learned = createSession({ kind: 'chat', channel: 'cli', userId: 'console' });
    const currentSource = acceptedSource(learned.id, 1);
    appendCapabilityOrigin({
      sessionId: learned.id,
      sourceUserSeq: currentSource.seq,
      originSessionId: cold.id,
      originSourceUserSeq: coldSource.seq,
      receiptId,
      evidenceDigest,
      authoritativeForTask: options.authoritativeForTask,
    });
    const currentRead = appendReadPair({
      sessionId: learned.id,
      sourceUserSeq: currentSource.seq,
      turn: 1,
      callId: `current-${learned.id}`,
      attemptId: `current-attempt-${learned.id}`,
      args: { connected_account_id: null, queue: 'proof-release' },
      output: JSON.stringify({ successful: true, revision: 2 }),
    });
    return { learned, currentSource, currentRead };
  }

  await t.test('non-authoritative capability resolution', () => {
    const built = topology({ authoritativeForTask: false });
    assert.equal(resolve(built.learned.id, built.currentSource.seq, TOOL, built.currentRead.call.seq), null);
  });
  await t.test('learning receipt bound to another tool', () => {
    resetEventLog();
    const built = topology({ receiptTool: 'PROOF_LIST_USERS' });
    assert.equal(resolve(built.learned.id, built.currentSource.seq, TOOL, built.currentRead.call.seq), null);
  });
  await t.test('intervening unreceipted physical read', () => {
    resetEventLog();
    const built = topology({ addInterveningRead: true });
    assert.equal(resolve(built.learned.id, built.currentSource.seq, TOOL, built.currentRead.call.seq), null);
  });
});

test('cross-session history is isolated to one immutable chat principal', async (t) => {
  const resolveBuilt = (built: ReturnType<typeof buildCrossSessionHistory>) => resolve(
    built.learned.id,
    built.currentSource.seq,
    TOOL,
    built.currentRead.call.seq,
  );

  await t.test('same identified principal succeeds', () => {
    const built = buildCrossSessionHistory({
      coldSession: { kind: 'chat', channel: 'home', userId: 'proof-user' },
      learnedSession: { kind: 'chat', channel: 'home', userId: 'proof-user' },
    });
    assert.equal(resolveBuilt(built)?.lineage.receipt.callId, built.coldRead.callId);
  });
  await t.test('same user on another channel is foreign', () => {
    resetEventLog();
    const built = buildCrossSessionHistory({
      coldSession: { kind: 'chat', channel: 'home', userId: 'proof-user' },
      learnedSession: { kind: 'chat', channel: 'cli', userId: 'proof-user' },
    });
    assert.equal(resolveBuilt(built), null);
  });
  await t.test('another user or a missing user is foreign', () => {
    resetEventLog();
    const anotherUser = buildCrossSessionHistory({
      coldSession: { kind: 'chat', channel: 'home', userId: 'proof-user' },
      learnedSession: { kind: 'chat', channel: 'home', userId: 'other-user' },
    });
    assert.equal(resolveBuilt(anotherUser), null);

    resetEventLog();
    const missingUser = buildCrossSessionHistory({
      coldSession: { kind: 'chat', channel: 'home', userId: 'proof-user' },
      learnedSession: { kind: 'chat', channel: 'home' },
    });
    assert.equal(resolveBuilt(missingUser), null);
  });
  await t.test('non-chat, null-channel, and external sessions decline', () => {
    resetEventLog();
    const nonChat = buildCrossSessionHistory({
      coldSession: { kind: 'workflow', channel: 'home', userId: 'proof-user' },
      learnedSession: { kind: 'chat', channel: 'home', userId: 'proof-user' },
    });
    assert.equal(resolveBuilt(nonChat), null);

    resetEventLog();
    const nullChannel = buildCrossSessionHistory({
      coldSession: { kind: 'chat', userId: 'proof-user' },
      learnedSession: { kind: 'chat', userId: 'proof-user' },
    });
    assert.equal(resolveBuilt(nullChannel), null);

    resetEventLog();
    const external = buildCrossSessionHistory({
      coldSession: { kind: 'chat', channel: 'webhook' },
      learnedSession: { kind: 'chat', channel: 'webhook' },
    });
    assert.equal(resolveBuilt(external), null);

    resetEventLog();
    const identifiedExternal = buildCrossSessionHistory({
      coldSession: { kind: 'chat', channel: 'slack', userId: 'proof-user' },
      learnedSession: { kind: 'chat', channel: 'slack', userId: 'proof-user' },
    });
    assert.equal(resolveBuilt(identifiedExternal), null);
  });
  await t.test('userless local exact-channel sessions succeed', () => {
    resetEventLog();
    const built = buildCrossSessionHistory({
      coldSession: { kind: 'chat', channel: 'home' },
      learnedSession: { kind: 'chat', channel: 'home' },
    });
    assert.equal(resolveBuilt(built)?.lineage.receipt.callId, built.coldRead.callId);
  });
  await t.test('a foreign principal read does not stale the origin', () => {
    resetEventLog();
    const built = buildCrossSessionHistory({
      coldSession: { kind: 'chat', channel: 'home', userId: 'proof-user' },
      interveningSession: { kind: 'chat', channel: 'home', userId: 'other-user' },
      learnedSession: { kind: 'chat', channel: 'home', userId: 'proof-user' },
    });
    assert.equal(resolveBuilt(built)?.lineage.receipt.callId, built.coldRead.callId);
  });
});

test('bounded mature history keeps the newest valid receipt usable', () => {
  const session = createSession({ kind: 'chat' });
  let newestCallId = '';
  for (let turn = 1; turn <= 65; turn += 1) {
    const source = acceptedSource(session.id, turn);
    const read = appendReadPair({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn,
      callId: `mature-call-${turn}`,
      attemptId: `mature-attempt-${turn}`,
      output: JSON.stringify({ successful: true, revision: turn }),
    });
    commitVerifiedRead({ sessionId: session.id, source, read });
    newestCallId = read.callId;
  }
  const current = acceptedSource(session.id, 66);
  assert.equal(resolve(session.id, current.seq)?.lineage.receipt.callId, newestCallId);
});

test('staleness bounds ignore ancient settled reads but reject a saturated later window', async (t) => {
  await t.test('129 ancient settled reads do not consume the later-read window', () => {
    const session = createSession({ kind: 'chat' });
    for (let turn = 1; turn <= 129; turn += 1) {
      const source = acceptedSource(session.id, turn);
      appendReadPair({
        sessionId: session.id,
        sourceUserSeq: source.seq,
        turn,
        callId: `ancient-${turn}`,
        attemptId: `ancient-attempt-${turn}`,
        output: JSON.stringify({ successful: true, revision: turn }),
      });
    }
    const source = acceptedSource(session.id, 130);
    const candidate = appendReadPair({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: 130,
      callId: 'post-ancient-candidate',
      attemptId: 'post-ancient-attempt',
      output: JSON.stringify({ successful: true, revision: 130 }),
    });
    commitVerifiedRead({ sessionId: session.id, source, read: candidate });
    const current = acceptedSource(session.id, 131);
    assert.equal(resolve(session.id, current.seq)?.lineage.receipt.callId, candidate.callId);
  });

  await t.test('129 genuinely later physical reads abstain', () => {
    resetEventLog();
    const session = createSession({ kind: 'chat' });
    const source = acceptedSource(session.id, 1);
    const candidate = appendReadPair({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: 1,
      callId: 'saturated-candidate',
      attemptId: 'saturated-candidate-attempt',
      output: JSON.stringify({ successful: true, revision: 1 }),
    });
    commitVerifiedRead({ sessionId: session.id, source, read: candidate });
    for (let turn = 2; turn <= 130; turn += 1) {
      const laterSource = acceptedSource(session.id, turn);
      appendReadPair({
        sessionId: session.id,
        sourceUserSeq: laterSource.seq,
        turn,
        callId: `later-${turn}`,
        attemptId: `later-attempt-${turn}`,
        output: JSON.stringify({ successful: true, revision: turn }),
      });
    }
    const current = acceptedSource(session.id, 131);
    assert.equal(resolve(session.id, current.seq), null);
  });

  await t.test('129 exact no-dispatch replays do not consume the physical-read bound', () => {
    resetEventLog();
    const session = createSession({ kind: 'chat' });
    const source = acceptedSource(session.id, 1);
    const candidate = appendReadPair({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: 1,
      callId: 'replay-saturated-candidate',
      attemptId: 'replay-saturated-attempt',
      output: JSON.stringify({ successful: true, revision: 1 }),
    });
    commitVerifiedRead({ sessionId: session.id, source, read: candidate });
    for (let turn = 2; turn <= 130; turn += 1) {
      const replaySource = acceptedSource(session.id, turn);
      appendReadPair({
        sessionId: session.id,
        sourceUserSeq: replaySource.seq,
        turn,
        callId: `bounded-replay-${turn}`,
        attemptId: `bounded-replay-attempt-${turn}`,
        output: candidate.output,
        returnedPatch: {
          providerDispatched: false,
          replayKind: 'same_source_settled_read_replay',
          canonicalCallId: candidate.callId,
        },
      });
    }
    const current = acceptedSource(session.id, 131);
    assert.equal(resolve(session.id, current.seq)?.lineage.receipt.callId, candidate.callId);
  });
});

test('an unresolved earlier call from the candidate turn is ambiguous', () => {
  const session = createSession({ kind: 'chat' });
  const source = acceptedSource(session.id, 1);
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'Orchestrator',
    type: 'tool_called',
    data: {
      sourceUserSeq: source.seq,
      attemptId: 'unresolved-overlap-attempt',
      callId: 'unresolved-overlap-a',
      accounting: 'top_level',
      effect: 'read',
      effectiveTool: TOOL,
      tool: 'call_tool',
      arguments: '{}',
    },
  });
  const candidate = appendReadPair({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    callId: 'unresolved-overlap-b',
    attemptId: 'unresolved-overlap-attempt',
    output: JSON.stringify({ successful: true, revision: 2 }),
  });
  commitVerifiedRead({ sessionId: session.id, source, read: candidate });
  const current = acceptedSource(session.id, 2);
  assert.equal(resolve(session.id, current.seq), null);
});

test('same-tool overlap is ambiguous when another call starts or returns after the candidate', () => {
  const session = createSession({ kind: 'chat' });
  const source = acceptedSource(session.id, 1);
  const overlappingCall = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'Orchestrator',
    type: 'tool_called',
    data: {
      sourceUserSeq: source.seq,
      attemptId: 'overlap-attempt',
      callId: 'overlap-a',
      accounting: 'top_level',
      effect: 'read',
      effectiveTool: TOOL,
      tool: 'call_tool',
      arguments: '{}',
    },
  });
  const candidate = appendReadPair({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    callId: 'overlap-b',
    attemptId: 'overlap-attempt',
    output: JSON.stringify({ successful: true, revision: 2 }),
  });
  writeToolOutput({
    sessionId: session.id,
    callId: 'overlap-a',
    invocationNonce: 'nonce:overlap-a',
    tool: 'call_tool',
    output: JSON.stringify({ successful: true, revision: 3 }),
  });
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'Orchestrator',
    type: 'tool_returned',
    parentEventId: overlappingCall.id,
    data: {
      sourceUserSeq: source.seq,
      attemptId: 'overlap-attempt',
      callId: 'overlap-a',
      accounting: 'top_level',
      effect: 'read',
      effectiveTool: TOOL,
      tool: 'call_tool',
      ok: true,
      providerDispatched: true,
    },
  });
  commitVerifiedRead({ sessionId: session.id, source, read: candidate });
  const current = acceptedSource(session.id, 2);
  assert.equal(resolve(session.id, current.seq), null);
});

test('prior receipt source and lifecycle must share exact immutable lineage', async (t) => {
  await t.test('receipt source must be accepted user input', () => {
    const session = createSession({ kind: 'chat' });
    const source = acceptedSource(session.id, 1);
    const read = appendReadPair({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: 1,
      callId: 'non-user-origin',
      attemptId: 'non-user-attempt',
      output: JSON.stringify({ successful: true, revision: 1 }),
    });
    commitVerifiedRead({ sessionId: session.id, source, read });
    openEventLog().prepare(`
      UPDATE events
         SET type = 'heartbeat', role = 'system'
       WHERE id = ?
    `).run(source.id);
    const current = acceptedSource(session.id, 2);
    assert.equal(resolve(session.id, current.seq), null);
  });
  await t.test('physical provider step may differ from the logical terminal turn', () => {
    resetEventLog();
    const session = createSession({ kind: 'chat' });
    const source = acceptedSource(session.id, 1);
    const read = appendReadPair({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: 99,
      callId: 'foreign-turn-origin',
      attemptId: 'foreign-turn-attempt',
      output: JSON.stringify({ successful: true, revision: 1 }),
    });
    commitVerifiedRead({ sessionId: session.id, source, read });
    const current = acceptedSource(session.id, 2);
    assert.equal(resolve(session.id, current.seq)?.lineage.receipt.callId, 'foreign-turn-origin');
  });
  await t.test('physical call and return must remain in one provider step', () => {
    resetEventLog();
    const session = createSession({ kind: 'chat' });
    const source = acceptedSource(session.id, 1);
    const read = appendReadPair({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: 2,
      callId: 'split-physical-turn',
      attemptId: 'split-physical-attempt',
      output: JSON.stringify({ successful: true, revision: 1 }),
    });
    openEventLog().prepare('UPDATE events SET turn = ? WHERE id = ?').run(3, read.returned.id);
    commitVerifiedRead({ sessionId: session.id, source, read });
    const current = acceptedSource(session.id, 2);
    assert.equal(resolve(session.id, current.seq), null);
  });
});
