import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

import {
  armHostCallAuthority,
  acceptedTurnCallAuthorityFor,
  currentHostCallAttestation,
  withHostCallAttestation,
  type HostCallAttestation,
} from '../runtime/harness/accepted-turn-call-authority.js';
import { acceptedTaskIdFor } from '../runtime/harness/attempt-identity.js';
import {
  HarnessRunContext,
  ToolCallsCounter,
  withHarnessRunContext,
} from '../runtime/harness/brackets.js';
import {
  activateDispatchLease,
  revokeDispatchLease,
  type DispatchLeaseRef,
} from '../runtime/harness/dispatch-lease.js';
import {
  appendEvent,
  beginRunAttempt,
  bindRunAttemptSourceUserEvent,
  closeEventLog,
  createSession,
  finishRunAttempt,
  getRunAttemptBySourceUserSeq,
  isKillRequested,
  openEventLog,
  requestKill,
  type RunAttemptRef,
} from '../runtime/harness/eventlog.js';
import {
  hostCallAttestationBindingDigest,
} from '../runtime/harness/host-call-capability-binding.js';
import {
  invokeHostToolCall,
  HostToolInvocationUncertainError,
  type HostToolInvocationResult,
  type InvokeHostToolCallInput,
} from '../runtime/harness/host-tool-invocation.js';
import {
  durableLogicalCallContract,
} from '../runtime/harness/logical-call-contract.js';
import { redeemDurableLogicalCallSettlementForHost } from '../runtime/harness/logical-call-settlement-store.js';
import { retryDispositionFor } from '../runtime/harness/dispatch-ledger.js';

type Task = {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
};

type RunOwner = {
  parentLease: DispatchLeaseRef;
  context: HarnessRunContext;
  attempt?: RunAttemptRef;
};

type DurableCounts = {
  logical_n: number;
  call_lease_n: number;
  physical_n: number;
  settlement_n: number;
  result_handle_n: number;
};

type PhaseAResult = {
  phase: 'A';
  pid: number;
  task: Task;
  root: {
    authorityKind: 'host_v1';
    authorityDigest: string;
    sourceEventId: string;
    sourceEventDigest: string;
  };
  expected: {
    read: unknown;
    write: unknown;
  };
  counts: {
    read: DurableCounts;
    write: DurableCounts;
  };
  uncertain?: {
    stoppedAttemptId: string;
    counts: DurableCounts;
    frozenRows: string;
    state: 'unknown';
    outcome: 'uncertain_write';
    requiresReconciliation: true;
    retrySameCandidate: false;
    stopLatchCleared: true;
  };
};

const phase = process.env.CLEM_HOST_RESTART_PHASE;
const bodyLog = process.env.CLEM_HOST_RESTART_BODY_LOG;
if ((phase !== 'A' && phase !== 'B') || !bodyLog) {
  throw new Error('host restart fixture requires an exact phase and append-only body log');
}
const exactBodyLog: string = bodyLog;
const stopUncertainScenario = process.env.CLEM_HOST_RESTART_STOP_UNCERTAIN === '1';

const digest = (label: string): string => createHash('sha256').update(label, 'utf8').digest('hex');

const READ_CALL = Object.freeze({
  callId: 'restaurant-read',
  toolName: 'read_file',
  args: { path: '/fixtures/santa-clarita-restaurants.json' },
});
const WRITE_CALL = Object.freeze({
  callId: 'sheet-create',
  toolName: 'space_publish',
  args: {
    title: 'Santa Clarita Restaurants',
    rows: Array.from({ length: 10 }, (_, index) => ({
      name: `Restaurant ${index + 1}`,
      address: `${100 + index} Main St`,
    })),
  },
});
const SUCCESSOR_CALL = Object.freeze({
  callId: 'successor-read',
  toolName: 'read_file',
  args: { path: '/fixtures/santa-clarita-restaurants-successor.json' },
});
const UNCERTAIN_CALL = Object.freeze({
  callId: 'uncertain-sheet-create',
  toolName: 'space_publish',
  args: { title: 'Controlled draft awaiting reconciliation', rows: [{ name: 'Fixture restaurant' }] },
});

function appendBody(callId: string): void {
  appendFileSync(exactBodyLog, `${JSON.stringify({ phase, pid: process.pid, callId })}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function createAcceptedTask(): Task {
  const session = createSession({
    id: `host-process-restart-${randomUUID()}`,
    kind: 'chat',
  });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Find 10 restaurants in Santa Clarita and put them in a new Google Sheet.',
    },
  });
  const armed = armHostCallAuthority({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    catalogRevisionDigest: digest(`restart-host-catalog:${session.id}`),
    bindingRevisionDigest: digest(`restart-host-binding:${session.id}`),
    maxLogicalCalls: 20,
    maxParallelCalls: 20,
  });
  assert.equal(armed.status, 'armed', JSON.stringify(armed));
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId: acceptedTaskIdFor(session.id, source.seq),
  };
}

function openRunOwner(task: Task, generation: string, registeredAttempt = false): RunOwner {
  const attempt = registeredAttempt ? beginRunAttempt(task.sessionId, {
    runId: `${task.sessionId}:${generation}`,
  }) : undefined;
  if (attempt) bindRunAttemptSourceUserEvent(attempt, task.sourceUserSeq);
  const parentLease = activateDispatchLease({
    sessionId: task.sessionId,
    scopeId: `${task.sessionId}::run:${generation}:${randomUUID()}`,
    ...(attempt ? { runAttemptId: attempt.attemptId } : {}),
  });
  return {
    parentLease,
    ...(attempt ? { attempt } : {}),
    context: {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      turn: 1,
      counter: new ToolCallsCounter(20),
      dispatchLease: parentLease,
      ...(attempt ? { runAttemptId: attempt.attemptId } : {}),
    },
  };
}

function reconstructedRoot(task: Task): PhaseAResult['root'] {
  const loaded = acceptedTurnCallAuthorityFor(task.sessionId, task.sourceUserSeq);
  assert.equal(loaded.status, 'ok', JSON.stringify(loaded));
  assert.equal(loaded.authority.authorityKind, 'host_v1');
  return {
    authorityKind: 'host_v1',
    authorityDigest: loaded.authority.authorityDigest,
    sourceEventId: loaded.authority.sourceEventId,
    sourceEventDigest: loaded.authority.sourceEventDigest,
  };
}

function exactAttestation(input: {
  task: Task;
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  effect: 'read' | 'external_write';
  attestationCallId?: string;
}): HostCallAttestation {
  const root = acceptedTurnCallAuthorityFor(input.task.sessionId, input.task.sourceUserSeq);
  assert.equal(root.status, 'ok', JSON.stringify(root));
  assert.equal(root.authority.authorityKind, 'host_v1');
  const contract = durableLogicalCallContract(
    input.task.acceptedTaskId,
    input.toolName,
    input.args,
  );
  assert.ok(contract, 'fixture only crosses recognized host tool contracts');
  if (!contract) throw new Error('fixture tool contract was unsafe');
  const operation = contract.toolName;
  const base = {
    sessionId: input.task.sessionId,
    sourceUserSeq: input.task.sourceUserSeq,
    acceptedTaskId: input.task.acceptedTaskId,
    sourceEventId: root.authority.sourceEventId,
    sourceEventDigest: root.authority.sourceEventDigest,
    logicalToolCallId: input.attestationCallId ?? input.callId,
    toolName: contract.toolName,
    argumentDigest: contract.argumentDigest,
    effect: input.effect,
    bindingKind: 'catalog_manifest' as const,
    capabilityId: `cap:process-restart:${operation}`,
    schemaFingerprint: digest(`restart-schema:${operation}`),
    accountId: 'account.process-restart.fixture',
    invokePortId: 'port.process-restart.fixture',
    operationId: operation,
    manifestId: `manifest.process-restart.${operation}`,
    manifestDigest: digest(`restart-manifest:${operation}`),
    engineVersion: root.authority.engineVersion,
    surfaceVersion: root.authority.surfaceVersion,
    authorityDigest: root.authority.authorityDigest,
    authorityRevision: root.authority.revision,
    surfaceDigest: root.authority.surfaceDigest,
    catalogRevisionDigest: root.authority.catalogRevisionDigest!,
    bindingRevisionDigest: root.authority.bindingRevisionDigest!,
  };
  return {
    ...base,
    bindingDigest: hostCallAttestationBindingDigest(base),
  };
}

function runHostCall<T>(input: {
  task: Task;
  owner: RunOwner;
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  effect: 'read' | 'external_write';
  attestationCallId?: string;
  body: InvokeHostToolCallInput<T>['invoke'];
}): Promise<HostToolInvocationResult<T>> {
  const attestation = exactAttestation(input);
  assert.equal(currentHostCallAttestation(), undefined);
  return withHostCallAttestation(attestation, () =>
    withHarnessRunContext(input.owner.context, () =>
      invokeHostToolCall({
        identity: {
          sessionId: input.task.sessionId,
          sourceUserSeq: input.task.sourceUserSeq,
          modelCallId: input.callId,
          toolName: input.toolName,
          args: input.args,
          turn: 1,
        },
        parentLease: input.owner.parentLease,
        effect: input.effect,
        boundary: 'host_owned_external',
        deadlineMs: 2_000,
        ...(input.owner.attempt ? {
          isKillRequested: () => isKillRequested(input.task.sessionId, { attemptId: input.owner.attempt!.attemptId }),
          killPollMs: 5,
        } : {}),
        invoke: input.body,
      }))) as Promise<HostToolInvocationResult<T>>;
}

function durableCounts(task: Task, callId: string): DurableCounts {
  return openEventLog().prepare(`
    SELECT
      (SELECT COUNT(*) FROM logical_tool_calls
        WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?) AS logical_n,
      (SELECT COUNT(*) FROM run_dispatch_leases
        WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?) AS call_lease_n,
      (SELECT COUNT(*) FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?) AS physical_n,
      (SELECT COUNT(*) FROM logical_call_settlements
        WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?) AS settlement_n,
      (SELECT COUNT(*) FROM durable_result_handles
        WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?) AS result_handle_n
  `).get(
    task.sessionId, task.sourceUserSeq, callId,
    task.sessionId, task.sourceUserSeq, callId,
    task.sessionId, task.sourceUserSeq, callId,
    task.sessionId, task.sourceUserSeq, callId,
    task.sessionId, task.sourceUserSeq, callId,
  ) as DurableCounts;
}

function exactDenial(error: unknown): string {
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'HostToolInvocationAuthorityError');
  return `${error.name}: ${error.message}`;
}

function uncertainRows(task: Task): string {
  const db = openEventLog();
  const parameters = [task.sessionId, task.sourceUserSeq, UNCERTAIN_CALL.callId] as const;
  return JSON.stringify({
    logical: db.prepare('SELECT * FROM logical_tool_calls WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?').all(...parameters),
    physical: db.prepare('SELECT * FROM physical_dispatches WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?').all(...parameters),
    settlement: db.prepare('SELECT * FROM logical_call_settlements WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?').all(...parameters),
  });
}

async function stopAfterUncertainCrossing(task: Task, owner: RunOwner): Promise<NonNullable<PhaseAResult['uncertain']>> {
  assert.ok(owner.attempt, 'Stop must own an actual registered attempt for the retained source');
  const attempt = owner.attempt;
  assert.equal(getRunAttemptBySourceUserSeq(task.sessionId, task.sourceUserSeq)?.attemptId, attempt.attemptId);
  let entered!: () => void;
  let resolveLate!: (value: unknown) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const late = new Promise<unknown>(resolve => { resolveLate = resolve; });
  const pending = runHostCall({ task, owner, ...UNCERTAIN_CALL, effect: 'external_write', body: () => {
    appendBody(UNCERTAIN_CALL.callId);
    entered();
    return late;
  } });
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof HostToolInvocationUncertainError && error.reason === 'kill');
  await started;
  requestKill(task.sessionId, 'controlled exact-attempt Stop after provider body entry', { attemptId: attempt.attemptId });
  await rejected;
  const rows = openEventLog().prepare(`SELECT state FROM physical_dispatches
    WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?`)
    .all(task.sessionId, task.sourceUserSeq, UNCERTAIN_CALL.callId) as Array<{ state: string }>;
  assert.deepEqual(rows, [{ state: 'unknown' }], 'Stop does not claim the entered mutation had no effect');
  const retained = redeemDurableLogicalCallSettlementForHost({ sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId, logicalToolCallId: UNCERTAIN_CALL.callId });
  assert.equal(retained.status, 'ok');
  if (retained.status !== 'ok') throw new Error('the exact uncertain settlement is unavailable');
  assert.equal(retained.settlement.outcome.kind, 'uncertain_write');
  assert.equal(retained.settlement.outcome.directive.requiresReconciliation, true);
  assert.equal(retained.settlement.outcome.directive.retrySameCandidate, false);
  assert.equal(retained.settlement.resultHandleId, undefined, 'an unacknowledged write cannot gain a successful result handle');
  assert.equal(retryDispositionFor('unknown', 'external_write', 'explicit_retry'), 'require_reconciliation');
  const frozenRows = uncertainRows(task);
  resolveLate({ successful: true, data: { id: 'late-fixture-result' } });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(uncertainRows(task), frozenRows, 'late provider success cannot rewrite the frozen uncertainty');
  finishRunAttempt(attempt, 'cancelled');
  assert.equal(isKillRequested(task.sessionId, { attemptId: attempt.attemptId }), false);
  assert.equal(getRunAttemptBySourceUserSeq(task.sessionId, task.sourceUserSeq)?.status, 'cancelled');
  assert.equal(uncertainRows(task), frozenRows, 'finishing the exact stopped attempt preserves its effect settlement');
  return { stoppedAttemptId: attempt.attemptId, counts: durableCounts(task, UNCERTAIN_CALL.callId), frozenRows,
    state: 'unknown', outcome: 'uncertain_write', requiresReconciliation: true, retrySameCandidate: false, stopLatchCleared: true };
}

async function runPhaseA(): Promise<PhaseAResult> {
  const task = createAcceptedTask();
  const owner = openRunOwner(task, 'A', stopUncertainScenario);
  const readExpected = {
    successful: true,
    data: {
      records: WRITE_CALL.args.rows,
      complete: true,
      providerPid: process.pid,
      durableNonce: randomUUID(),
    },
  };
  const writeExpected = {
    successful: true,
    data: {
      spreadsheetId: `sheet_${randomUUID()}`,
      url: `https://docs.google.com/spreadsheets/d/${randomUUID()}/edit`,
      rowsWritten: 10,
      providerPid: process.pid,
      durableReceipt: randomUUID(),
    },
  };
  try {
    const read = await runHostCall({
      task,
      owner,
      ...READ_CALL,
      effect: 'read',
      body: async () => {
        appendBody(READ_CALL.callId);
        return readExpected;
      },
    });
    assert.deepEqual(read.value, readExpected);
    assert.equal(read.settlement.duplicate, false);

    const write = await runHostCall({
      task,
      owner,
      ...WRITE_CALL,
      effect: 'external_write',
      body: async () => {
        appendBody(WRITE_CALL.callId);
        return writeExpected;
      },
    });
    assert.deepEqual(write.value, writeExpected);
    assert.equal(write.settlement.duplicate, false);

    const uncertain = stopUncertainScenario ? await stopAfterUncertainCrossing(task, owner) : undefined;

    return {
      phase: 'A',
      pid: process.pid,
      task,
      root: reconstructedRoot(task),
      expected: { read: readExpected, write: writeExpected },
      counts: {
        read: durableCounts(task, READ_CALL.callId),
        write: durableCounts(task, WRITE_CALL.callId),
      },
      ...(uncertain ? { uncertain } : {}),
    };
  } finally {
    revokeDispatchLease(owner.parentLease);
  }
}

async function runPhaseB(prior: PhaseAResult) {
  const task = prior.task;
  const owner = openRunOwner(task, 'B', Boolean(prior.uncertain));
  try {
    const root = reconstructedRoot(task);
    assert.deepEqual(root, prior.root, 'fresh process reopened different root authority bytes');
    const readBefore = durableCounts(task, READ_CALL.callId);
    const writeBefore = durableCounts(task, WRITE_CALL.callId);

    let tamperedArgs = '';
    try {
      await runHostCall({
        task,
        owner,
        ...READ_CALL,
        args: { path: '/fixtures/tampered.json' },
        effect: 'read',
        body: async () => {
          appendBody('TAMPERED-ARGS-BODY');
          return { duplicate: true };
        },
      });
      assert.fail('tampered arguments unexpectedly redeemed settled bytes');
    } catch (error) {
      tamperedArgs = exactDenial(error);
    }

    let tamperedCallIdentity = '';
    try {
      await runHostCall({
        task,
        owner,
        ...WRITE_CALL,
        attestationCallId: `${WRITE_CALL.callId}:forged-attestation`,
        effect: 'external_write',
        body: async () => {
          appendBody('TAMPERED-CALL-IDENTITY-BODY');
          return { duplicate: true };
        },
      });
      assert.fail('tampered attestation call identity unexpectedly redeemed settled bytes');
    } catch (error) {
      tamperedCallIdentity = exactDenial(error);
    }

    const read = await runHostCall({
      task,
      owner,
      ...READ_CALL,
      effect: 'read',
      body: async () => {
        appendBody('DUPLICATE-READ-BODY');
        return { duplicate: true };
      },
    });
    const write = await runHostCall({
      task,
      owner,
      ...WRITE_CALL,
      effect: 'external_write',
      body: async () => {
        appendBody('DUPLICATE-WRITE-BODY');
        return { duplicate: true };
      },
    });
    assert.deepEqual(read.value, prior.expected.read);
    assert.deepEqual(write.value, prior.expected.write);

    const readAfter = durableCounts(task, READ_CALL.callId);
    const writeAfter = durableCounts(task, WRITE_CALL.callId);
    assert.deepEqual(readAfter, readBefore);
    assert.deepEqual(writeAfter, writeBefore);

    let uncertain: { continuedAttemptId: string; denials: string[]; countsBefore: DurableCounts; countsAfter: DurableCounts;
      frozenRows: string; outcome: 'uncertain_write' } | undefined;
    if (prior.uncertain) {
      assert.ok(owner.attempt);
      assert.notEqual(owner.attempt.attemptId, prior.uncertain.stoppedAttemptId);
      assert.equal(getRunAttemptBySourceUserSeq(task.sessionId, task.sourceUserSeq)?.sourceUserSeq, task.sourceUserSeq);
      assert.equal(uncertainRows(task), prior.uncertain.frozenRows, 'new process reopened different uncertain effect bytes');
      const countsBefore = durableCounts(task, UNCERTAIN_CALL.callId);
      const denials: string[] = [];
      for (let replay = 0; replay < 2; replay++) {
        try {
          await runHostCall({ task, owner, ...UNCERTAIN_CALL, effect: 'external_write', body: async () => {
            appendBody('DUPLICATE-UNCERTAIN-WRITE-BODY');
            return { successful: true, data: { id: 'duplicate-fixture-write' } };
          } });
          assert.fail('a continued uncertain write crossed without reconciliation');
        } catch (error) { denials.push(exactDenial(error)); }
      }
      assert.ok(denials.every(reason => /uncertain_write is not replayable/.test(reason)));
      assert.equal(uncertainRows(task), prior.uncertain.frozenRows);
      const countsAfter = durableCounts(task, UNCERTAIN_CALL.callId);
      assert.deepEqual(countsAfter, countsBefore);
      const retained = redeemDurableLogicalCallSettlementForHost({ sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq,
        acceptedTaskId: task.acceptedTaskId, logicalToolCallId: UNCERTAIN_CALL.callId });
      assert.equal(retained.status, 'ok');
      assert.equal(retained.status === 'ok' && retained.settlement.outcome.kind, 'uncertain_write');
      uncertain = { continuedAttemptId: owner.attempt.attemptId, denials, countsBefore, countsAfter,
        frozenRows: uncertainRows(task), outcome: 'uncertain_write' };
    }

    const successorExpected = {
      successful: true,
      data: {
        records: [{ id: 'successor.restaurant.1' }],
        complete: true,
        providerPid: process.pid,
        durableNonce: randomUUID(),
      },
    };
    const successor = await runHostCall({
      task,
      owner,
      ...SUCCESSOR_CALL,
      effect: 'read',
      body: async () => {
        appendBody(SUCCESSOR_CALL.callId);
        return successorExpected;
      },
    });
    assert.deepEqual(successor.value, successorExpected);
    assert.equal(successor.settlement.duplicate, false);
    const successorAfterFirst = durableCounts(task, SUCCESSOR_CALL.callId);

    const successorReplay = await runHostCall({
      task,
      owner,
      ...SUCCESSOR_CALL,
      effect: 'read',
      body: async () => {
        appendBody('DUPLICATE-SUCCESSOR-BODY');
        return { duplicate: true };
      },
    });
    assert.deepEqual(successorReplay.value, successorExpected);

    return {
      phase: 'B' as const,
      pid: process.pid,
      reconstructedRoot: root,
      replayed: { read: read.value, write: write.value },
      duplicate: {
        read: read.settlement.duplicate,
        write: write.settlement.duplicate,
        successor: successorReplay.settlement.duplicate,
      },
      denials: { tamperedArgs, tamperedCallIdentity },
      counts: {
        readBefore,
        readAfter,
        writeBefore,
        writeAfter,
        successorAfterFirst,
        successorAfterReplay: durableCounts(task, SUCCESSOR_CALL.callId),
      },
      ...(uncertain ? { uncertain } : {}),
    };
  } finally {
    revokeDispatchLease(owner.parentLease);
  }
}

try {
  const result = phase === 'A'
    ? await runPhaseA()
    : await runPhaseB(JSON.parse(
      Buffer.from(process.env.CLEM_HOST_RESTART_PRIOR ?? '', 'base64url').toString('utf8'),
    ) as PhaseAResult);
  closeEventLog();
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  try { closeEventLog(); } catch { /* best effort fixture teardown */ }
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
