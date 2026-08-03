import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-origin-group-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const {
  activateWorkflowOriginGroup,
  cleanupSettledWorkflowRunChatDispatchPreparations,
  compactSettledWorkflowOriginGroup,
  createWorkflowChatDispatchPreparationAuthority,
  createWorkflowChatDispatchPreparedReceipt,
  createWorkflowOriginGroupCloseAuthority,
  createWorkflowOriginGroupClosedBatchReceipt,
  createWorkflowOriginGroupSettlementReceipt,
  finalizeWorkflowOriginGroupClosedBatch,
  readActiveExactWorkflowRunOriginRecords,
  readActiveWorkflowOriginGroup,
  readWorkflowOriginGroupClosedBatch,
  readWorkflowOriginGroupCloseIntent,
  readWorkflowOriginGroupSettlement,
  readWorkflowOriginGroupTombstone,
  recordWorkflowChatDispatchAdmission,
  recordWorkflowChatDispatchPreparation,
  recordWorkflowOriginGroupCloseIntent,
  recordWorkflowOriginGroupClosedBatch,
  recordWorkflowOriginGroupSettlement,
  reconcileActivatedWorkflowOriginGroups,
  recoverClosedWorkflowOriginGroups,
  registerWorkflowRunDrainKick,
  sealWorkflowOriginGroup,
  workflowRunHasPendingChatDispatchPreparation,
  workflowChatDispatchQueueRequestDigest,
  workflowOriginGroupMemberForRequest,
  workflowOriginSourceGroupId,
  workflowRunReportBackContentDigest,
  workflowRunOriginObserverId,
} = await import('./workflow-origin-group.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { exactOriginDeliveryReceiptForTarget } = await import('../runtime/exact-origin-delivery.js');

const observer = {
  sessionId: 'sess-origin-group',
  sourceUserSeq: 42,
  replyTarget: { type: 'discord_channel' as const, channelId: 'discord-exact' },
};
const testPublicationBarrier = { beforeMemberRelease: () => {} };

beforeEach(() => {
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  registerWorkflowRunDrainKick(null);
});

function writeRun(runId: string, status = 'awaiting_chat_dispatch_seal'): void {
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow: `workflow-${runId}`,
    inputs: {},
    status,
    createdAt: new Date().toISOString(),
  }), 'utf-8');
}

let evidenceSeq = 100;
function prepared(runId: string, source = observer, requestLabel = runId, index = true) {
  evidenceSeq += 1;
  const queueRequestDigest = workflowChatDispatchQueueRequestDigest({
    workflowName: `workflow-${requestLabel}`,
    normalizedInputs: { requestLabel },
  });
  const authority = createWorkflowChatDispatchPreparationAuthority({
    runId,
    observer: source,
    queueRequestDigest,
  });
  const receipt = createWorkflowChatDispatchPreparedReceipt(authority, {
    eventId: `event-${evidenceSeq}`,
    eventSeq: evidenceSeq,
    preparedAt: new Date(1_800_000_000_000 + evidenceSeq).toISOString(),
  });
  return index ? recordWorkflowChatDispatchPreparation(receipt) : receipt;
}

function closeGroup(receipts: ReturnType<typeof prepared>[]) {
  evidenceSeq += 1;
  const authority = createWorkflowOriginGroupCloseAuthority(receipts);
  const receipt = createWorkflowOriginGroupClosedBatchReceipt(authority, {
    eventId: `close-event-${evidenceSeq}`,
    eventSeq: evidenceSeq,
    closedAt: new Date(1_800_100_000_000 + evidenceSeq).toISOString(),
  });
  return recordWorkflowOriginGroupClosedBatch({ receipt, preparedReceipts: receipts });
}

function closeAndSeal(receipts: ReturnType<typeof prepared>[]) {
  const closed = closeGroup(receipts);
  return sealWorkflowOriginGroup(closed.preparedReceipts);
}

function status(runId: string): string {
  return (JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), 'utf-8')) as { status: string }).status;
}

function settlementInput(
  active: ReturnType<typeof finalizeWorkflowOriginGroupClosedBatch>,
  overrides: {
    exactDeliveryReceipt?: string;
    notificationId?: string;
    terminalText?: string;
    terminalEventId?: string;
  } = {},
) {
  evidenceSeq += 1;
  const memberRunIds = active.sealed.members.map((member) => member.runId);
  const notificationId = memberRunIds.length === 1
    ? `workflow-${memberRunIds[0]}-origin-${active.sealed.observerId.replace(/^workflow-origin-v2:/, '')}`
    : `workflow-origin-group-${active.sealed.sourceGroupDigest}`;
  return {
    sourceGroupId: active.sealed.sourceGroupId,
    exactDeliveryReceipt: overrides.exactDeliveryReceipt
      ?? exactOriginDeliveryReceiptForTarget(active.sealed.replyTarget)!,
    notificationId: overrides.notificationId ?? notificationId,
    terminal: {
      eventId: overrides.terminalEventId ?? `terminal-event-${evidenceSeq}`,
      outcomeId: `turn:${active.sealed.sourceUserSeq}`,
      sessionId: active.sealed.originSessionId,
      turn: 1,
      sourceUserSeq: active.sealed.sourceUserSeq,
      runId: memberRunIds.length === 1 ? memberRunIds[0] : active.sealed.sourceGroupId,
      status: 'done' as const,
      text: overrides.terminalText ?? 'The exact workflow group completed.',
    },
    memberReportBackDigests: memberRunIds.map((runId) => ({
      runId,
      reportBackDigest: workflowRunReportBackContentDigest({
        workflowName: `workflow-${runId}`,
        outcome: 'done',
        detail: 'The exact workflow group completed.',
      }),
    })),
    settledAt: new Date(1_800_300_000_000 + evidenceSeq).toISOString(),
  };
}

function settleGroup(
  active: ReturnType<typeof finalizeWorkflowOriginGroupClosedBatch>,
  overrides: Parameters<typeof settlementInput>[1] = {},
) {
  return recordWorkflowOriginGroupSettlement(
    createWorkflowOriginGroupSettlementReceipt(settlementInput(active, overrides)),
  );
}

function acknowledgeRun(
  runId: string,
  observerId: string,
  detail = 'The exact workflow group completed.',
  settlementDigest?: string,
): void {
  const file = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  const run = JSON.parse(readFileSync(file, 'utf-8'));
  const report = {
    workflowName: run.workflow as string,
    outcome: 'done' as const,
    detail,
  };
  writeFileSync(file, JSON.stringify({
    ...run,
    reportBack: {
      version: 1,
      ...report,
      acknowledgedOriginSessionIds: [],
      acknowledgedOriginObserverIds: [observerId],
      ...(settlementDigest
        ? {
            acknowledgedOriginObserverSettlements: {
              [observerId]: {
                settlementDigest,
                reportBackDigest: workflowRunReportBackContentDigest(report),
              },
            },
          }
        : {}),
    },
    reportBackAcknowledgedAt: new Date(1_800_400_000_000 + evidenceSeq).toISOString(),
  }), 'utf-8');
}

test('two source runs stay held until one complete ordered group seal activates both', () => {
  writeRun('run-a');
  writeRun('run-b');
  const sealed = closeAndSeal([prepared('run-a'), prepared('run-b')]);

  assert.deepEqual(sealed.members.map((member) => member.runId), ['run-a', 'run-b']);
  assert.equal(status('run-a'), 'awaiting_chat_dispatch_seal');
  assert.equal(status('run-b'), 'awaiting_chat_dispatch_seal');
  assert.equal(readActiveWorkflowOriginGroup(sealed.sourceGroupId), null);
  assert.deepEqual(readActiveExactWorkflowRunOriginRecords('run-a'), []);

  const active = activateWorkflowOriginGroup(sealed, testPublicationBarrier);
  assert.equal(status('run-a'), 'queued');
  assert.equal(status('run-b'), 'queued');
  assert.deepEqual(active.activation.memberRunIds, ['run-a', 'run-b']);
  assert.deepEqual(active.publicDispatch.runIds, ['run-a', 'run-b']);
  assert.equal(active.publicDispatch.sourceUserSeq, observer.sourceUserSeq);
  assert.equal(readActiveExactWorkflowRunOriginRecords('run-a')[0]?.sourceGroupDigest, sealed.sourceGroupDigest);
  assert.equal(readActiveExactWorkflowRunOriginRecords('run-b')[0]?.observerId, workflowRunOriginObserverId(observer));
});

test('crash after first private member marker leaves every fresh run non-executable and retry finishes', () => {
  writeRun('run-crash-a');
  writeRun('run-crash-b');
  const sealed = closeAndSeal([prepared('run-crash-a'), prepared('run-crash-b')]);

  assert.throws(
    () => activateWorkflowOriginGroup(sealed, {
      ...testPublicationBarrier,
      failAfterMemberCountForTest: 1,
    }),
    /Injected workflow origin group activation crash/,
  );
  assert.equal(status('run-crash-a'), 'awaiting_chat_dispatch_seal');
  assert.equal(status('run-crash-b'), 'awaiting_chat_dispatch_seal');
  assert.equal(readActiveWorkflowOriginGroup(sealed.sourceGroupId), null);
  assert.deepEqual(readActiveExactWorkflowRunOriginRecords('run-crash-a'), []);

  const recovered = activateWorkflowOriginGroup(sealed, testPublicationBarrier);
  assert.equal(status('run-crash-a'), 'queued');
  assert.equal(status('run-crash-b'), 'queued');
  assert.equal(recovered.sealed.sourceGroupDigest, sealed.sourceGroupDigest);
});

test('duplicate already-running and terminal runs gain exact authority only after the seal', () => {
  writeRun('run-running', 'running');
  writeRun('run-terminal', 'completed');
  const sealed = closeAndSeal([prepared('run-running'), prepared('run-terminal')]);

  assert.deepEqual(readActiveExactWorkflowRunOriginRecords('run-running'), []);
  assert.deepEqual(readActiveExactWorkflowRunOriginRecords('run-terminal'), []);
  activateWorkflowOriginGroup(sealed, testPublicationBarrier);
  assert.equal(status('run-running'), 'running');
  assert.equal(status('run-terminal'), 'completed');
  assert.equal(readActiveExactWorkflowRunOriginRecords('run-running').length, 1);
  assert.equal(readActiveExactWorkflowRunOriginRecords('run-terminal').length, 1);
});

test('retention waits for every member projection and recovers settlement compaction', () => {
  writeRun('run-ack-a', 'completed');
  writeRun('run-ack-b', 'completed');
  const active = finalizeWorkflowOriginGroupClosedBatch(closeGroup([
    prepared('run-ack-a'),
    prepared('run-ack-b'),
  ]).receipt.sourceGroupId, testPublicationBarrier);
  assert.equal(workflowRunHasPendingChatDispatchPreparation('run-ack-a'), true);
  assert.equal(workflowRunHasPendingChatDispatchPreparation('run-ack-b'), true);
  assert.equal(cleanupSettledWorkflowRunChatDispatchPreparations('run-ack-a'), 0);
  assert.equal(JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, 'run-ack-a.json'), 'utf-8')).reportBack, undefined);
  assert.equal(JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, 'run-ack-b.json'), 'utf-8')).reportBack, undefined);

  const settlement = settleGroup(active);
  assert.equal(readWorkflowOriginGroupSettlement(active.sealed.sourceGroupId)?.settlementDigest, settlement.settlementDigest);
  assert.equal(workflowRunHasPendingChatDispatchPreparation('run-ack-a'), true);
  assert.equal(workflowRunHasPendingChatDispatchPreparation('run-ack-b'), true);
  acknowledgeRun('run-ack-a', active.sealed.observerId, undefined, settlement.settlementDigest);
  assert.equal(
    workflowRunHasPendingChatDispatchPreparation('run-ack-a'),
    true,
    'an early member remains pinned while its sibling lacks a projection',
  );
  acknowledgeRun('run-ack-b', active.sealed.observerId, undefined, settlement.settlementDigest);
  assert.equal(
    workflowRunHasPendingChatDispatchPreparation('run-ack-a'),
    false,
    'the retention check recovers an ack-write to compaction crash',
  );
  assert.equal(workflowRunHasPendingChatDispatchPreparation('run-ack-b'), false);

  const pinRoot = path.join(WORKFLOW_RUNS_DIR, '.origin-preparation-pins');
  const pinDirA = path.join(pinRoot, createHash('sha256').update('run-ack-a').digest('hex'));
  const pinDirB = path.join(pinRoot, createHash('sha256').update('run-ack-b').digest('hex'));
  assert.equal(cleanupSettledWorkflowRunChatDispatchPreparations('run-ack-a'), 1);
  assert.equal(cleanupSettledWorkflowRunChatDispatchPreparations('run-ack-b'), 1);
  assert.equal(existsSync(pinDirA), false);
  assert.equal(existsSync(pinDirB), false);
  assert.equal(cleanupSettledWorkflowRunChatDispatchPreparations('run-ack-a'), 0, 'cleanup replay is idempotent');
});

test('a forged bare observer acknowledgement cannot settle a source group', () => {
  writeRun('run-forged-ack', 'completed');
  const active = finalizeWorkflowOriginGroupClosedBatch(closeGroup([
    prepared('run-forged-ack'),
  ]).receipt.sourceGroupId, testPublicationBarrier);
  acknowledgeRun('run-forged-ack', active.sealed.observerId, 'This bare ack has no provider receipt.');
  assert.equal(readWorkflowOriginGroupSettlement(active.sealed.sourceGroupId), null);
  assert.equal(workflowRunHasPendingChatDispatchPreparation('run-forged-ack'), true);
  assert.equal(cleanupSettledWorkflowRunChatDispatchPreparations('run-forged-ack'), 0);
});

test('settlement first-writer rejects conflicting target receipt, notification, and terminal', () => {
  writeRun('run-settlement-conflict', 'completed');
  const active = finalizeWorkflowOriginGroupClosedBatch(closeGroup([
    prepared('run-settlement-conflict'),
  ]).receipt.sourceGroupId, testPublicationBarrier);
  assert.throws(
    () => createWorkflowOriginGroupSettlementReceipt(settlementInput(active, {
      exactDeliveryReceipt: 'exact-origin/v1/discord-channel/wrong-channel',
    })),
    /exact target receipt does not match/,
  );
  assert.throws(
    () => createWorkflowOriginGroupSettlementReceipt(settlementInput(active, {
      notificationId: 'workflow-conflicting-notification',
    })),
    /notification id is not canonical/,
  );
  const winner = settleGroup(active, { terminalText: 'The first immutable terminal.' });
  const conflicting = createWorkflowOriginGroupSettlementReceipt(settlementInput(active, {
    terminalText: 'A conflicting terminal body.',
    terminalEventId: 'conflicting-terminal-event',
  }));
  assert.notEqual(conflicting.terminalDigest, winner.terminalDigest);
  assert.throws(
    () => recordWorkflowOriginGroupSettlement(conflicting),
    /conflicting immutable settlement/,
  );
  assert.equal(readWorkflowOriginGroupSettlement(active.sealed.sourceGroupId)?.settlementDigest, winner.settlementDigest);
});

test('closed batch rejects a proper subset of the durable preparation index', () => {
  writeRun('run-incomplete-a');
  writeRun('run-incomplete-b');
  const first = prepared('run-incomplete-a');
  prepared('run-incomplete-b');
  evidenceSeq += 1;
  const authority = createWorkflowOriginGroupCloseAuthority([first]);
  const receipt = createWorkflowOriginGroupClosedBatchReceipt(authority, {
    eventId: `close-event-${evidenceSeq}`,
    eventSeq: evidenceSeq,
    closedAt: new Date(1_800_100_000_000 + evidenceSeq).toISOString(),
  });
  assert.throws(
    () => recordWorkflowOriginGroupClosedBatch({ receipt, preparedReceipts: [first] }),
    /complete ordered preparation index matches/,
  );
  assert.equal(readWorkflowOriginGroupClosedBatch(authority.sourceGroupId), null);
});

test('close intent cannot exclude a staged callback-crash owner and then freezes later admission', () => {
  writeRun('run-staged-before-callback');
  writeRun('run-already-prepared');
  const stagedReceipt = prepared('run-staged-before-callback', observer, 'run-staged-before-callback', false);
  recordWorkflowChatDispatchAdmission(stagedReceipt);
  const alreadyPrepared = prepared('run-already-prepared');

  assert.throws(
    () => recordWorkflowOriginGroupCloseIntent(
      createWorkflowOriginGroupCloseAuthority([alreadyPrepared]),
    ),
    /excludes or conflicts with a staged admission|complete ordered preparation index matches/,
  );
  const recoveredPrepared = recordWorkflowChatDispatchPreparation(stagedReceipt);
  const authority = createWorkflowOriginGroupCloseAuthority([recoveredPrepared, alreadyPrepared]);
  assert.equal(recordWorkflowOriginGroupCloseIntent(authority).closeDigest, authority.closeDigest);
  assert.equal(readWorkflowOriginGroupCloseIntent(authority.sourceGroupId)?.closeDigest, authority.closeDigest);

  writeRun('run-after-close-fence');
  const late = prepared('run-after-close-fence', observer, 'run-after-close-fence', false);
  assert.throws(
    () => recordWorkflowChatDispatchAdmission(late),
    /membership is already closing and cannot be widened/,
  );
});

test('conflicting source, target, membership, and request ownership fail closed', () => {
  writeRun('run-conflict-a');
  writeRun('run-conflict-b');
  const first = prepared('run-conflict-a');
  const otherSource = prepared('run-conflict-b', { ...observer, sourceUserSeq: 43 }, 'run-conflict-b', false);
  assert.throws(() => createWorkflowOriginGroupCloseAuthority([first, otherSource]), /disagree on source/);

  const otherTarget = prepared('run-conflict-b', {
    ...observer,
    replyTarget: { type: 'discord_channel' as const, channelId: 'different-channel' },
  }, 'run-conflict-b', false);
  assert.throws(() => createWorkflowOriginGroupCloseAuthority([first, otherTarget]), /disagree on source or immutable reply target/);

  const sealed = closeAndSeal([first]);
  assert.throws(() => prepared('run-conflict-b'), /closed and cannot admit a later preparation/);
  assert.equal(sealed.sourceGroupId, workflowOriginSourceGroupId(observer));

  const sameRequestDifferentRun = createWorkflowChatDispatchPreparationAuthority({
    runId: 'run-conflict-b',
    observer,
    queueRequestDigest: first.queueRequestDigest,
  });
  const conflictingReceipt = createWorkflowChatDispatchPreparedReceipt(sameRequestDifferentRun, {
    eventId: 'event-conflicting-request',
    eventSeq: 999,
    preparedAt: new Date(1_800_000_999_000).toISOString(),
  });
  assert.throws(
    () => createWorkflowOriginGroupCloseAuthority([first, conflictingReceipt]),
    /request digest is bound to conflicting runs/,
  );
});

test('seal and activation retries are idempotent and kick only after the complete release pass', () => {
  writeRun('run-retry-a');
  writeRun('run-retry-b');
  const receipts = [prepared('run-retry-a'), prepared('run-retry-b')];
  closeGroup(receipts);
  const sealed = sealWorkflowOriginGroup(receipts);
  assert.equal(sealWorkflowOriginGroup(receipts).sourceGroupDigest, sealed.sourceGroupDigest);

  const kicks: string[][] = [];
  registerWorkflowRunDrainKick((runIds) => kicks.push([...runIds]));
  assert.throws(
    () => activateWorkflowOriginGroup(sealed, {
      ...testPublicationBarrier,
      failAfterMemberCountForTest: 1,
    }),
    /Injected/,
  );
  assert.deepEqual(kicks, []);
  const first = activateWorkflowOriginGroup(sealed, testPublicationBarrier);
  const retry = activateWorkflowOriginGroup(sealed, testPublicationBarrier);
  assert.equal(retry.activation.activationDigest, first.activation.activationDigest);
  assert.deepEqual(kicks, [
    ['run-retry-a', 'run-retry-b'],
    ['run-retry-a', 'run-retry-b'],
  ]);
});

test('boot/timer reconciler releases a group whose receipt won before the process crashed', () => {
  writeRun('run-reconcile-a');
  writeRun('run-reconcile-b');
  const sealed = closeAndSeal([prepared('run-reconcile-a'), prepared('run-reconcile-b')]);
  assert.throws(
    () => activateWorkflowOriginGroup(sealed, {
      ...testPublicationBarrier,
      failAfterActivationReceiptForTest: true,
    }),
    /after durable activation receipt/,
  );
  assert.ok(readActiveWorkflowOriginGroup(sealed.sourceGroupId), 'complete authority is durable');
  assert.equal(status('run-reconcile-a'), 'awaiting_chat_dispatch_seal');
  assert.equal(status('run-reconcile-b'), 'awaiting_chat_dispatch_seal');

  let publicationBarrierCalls = 0;
  const recoveryBarrier = {
    beforeMemberRelease: () => { publicationBarrierCalls += 1; },
  };
  const recovered = reconcileActivatedWorkflowOriginGroups(recoveryBarrier);
  assert.deepEqual(recovered, {
    groupsExamined: 1,
    groupsRecovered: 1,
    membersReleased: 2,
    rejected: 0,
  });
  assert.equal(publicationBarrierCalls, 1, 'one group verifies publication once before held release');
  assert.equal(status('run-reconcile-a'), 'queued');
  assert.equal(status('run-reconcile-b'), 'queued');

  const settledRetry = reconcileActivatedWorkflowOriginGroups(recoveryBarrier);
  assert.deepEqual(settledRetry, {
    groupsExamined: 1,
    groupsRecovered: 0,
    membersReleased: 0,
    rejected: 0,
  });
  assert.equal(
    publicationBarrierCalls,
    1,
    'a fully released historical group pays no repeated publication verification',
  );
});

test('compaction installs its replay tombstone before removing bulky authority and recovers after a crash', () => {
  writeRun('run-compact-a', 'completed');
  writeRun('run-compact-b', 'completed');
  const receipts = [prepared('run-compact-a'), prepared('run-compact-b')];
  const active = finalizeWorkflowOriginGroupClosedBatch(
    closeGroup(receipts).receipt.sourceGroupId,
    testPublicationBarrier,
  );
  const settlement = settleGroup(active);
  acknowledgeRun('run-compact-a', active.sealed.observerId, undefined, settlement.settlementDigest);
  acknowledgeRun('run-compact-b', active.sealed.observerId, undefined, settlement.settlementDigest);

  const groupKey = createHash('sha256').update(active.sealed.sourceGroupId).digest('hex');
  const dir = path.join(WORKFLOW_RUNS_DIR, '.origin-groups', groupKey);
  assert.throws(
    () => compactSettledWorkflowOriginGroup(active.sealed.sourceGroupId, {
      failAfterTombstoneForTest: true,
    }),
    /after durable tombstone/,
  );
  const crashWinner = readWorkflowOriginGroupTombstone(active.sealed.sourceGroupId);
  assert.ok(crashWinner, 'tombstone is the first durable compaction write');
  assert.equal(existsSync(path.join(dir, 'closed.json')), true, 'bulky records survive the injected crash');
  assert.equal(readActiveExactWorkflowRunOriginRecords('run-compact-a').length, 1);

  const compacted = compactSettledWorkflowOriginGroup(active.sealed.sourceGroupId);
  assert.equal(compacted.tombstoneDigest, crashWinner.tombstoneDigest);
  assert.deepEqual(
    readdirSync(dir).sort(),
    ['tombstone.json'],
    'successful replay leaves only the compact replay authority',
  );
  assert.equal(readWorkflowOriginGroupSettlement(active.sealed.sourceGroupId)?.settlementDigest, settlement.settlementDigest);
  assert.equal(readWorkflowOriginGroupClosedBatch(active.sealed.sourceGroupId)?.preparedReceipts.length, 2);
  assert.equal(readActiveWorkflowOriginGroup(active.sealed.sourceGroupId)?.activation.activationDigest, active.activation.activationDigest);
  assert.equal(workflowRunHasPendingChatDispatchPreparation('run-compact-a'), false);
  assert.equal(workflowRunHasPendingChatDispatchPreparation('run-compact-b'), false);
  assert.equal(cleanupSettledWorkflowRunChatDispatchPreparations('run-compact-a'), 1);
  assert.equal(cleanupSettledWorkflowRunChatDispatchPreparations('run-compact-b'), 1);
  assert.equal(
    workflowOriginGroupMemberForRequest(
      active.sealed.sourceGroupId,
      receipts[0].queueRequestDigest,
      active.sealed.replyTarget,
    )?.runId,
    'run-compact-a',
  );
  assert.equal(recordWorkflowChatDispatchPreparation(receipts[0]).receiptDigest, receipts[0].receiptDigest);
  assert.equal(existsSync(path.join(dir, 'prepared')), false, 'settled preparation replay cannot rehydrate bulky indexes');
  assert.equal(sealWorkflowOriginGroup(receipts).sourceGroupDigest, active.sealed.sourceGroupDigest);
  assert.equal(
    activateWorkflowOriginGroup(active.sealed, testPublicationBarrier).activation.activationDigest,
    active.activation.activationDigest,
  );
});

test('compaction refuses to erase a malformed close fence', () => {
  writeRun('run-malformed-fence', 'completed');
  const receipt = prepared('run-malformed-fence');
  const active = finalizeWorkflowOriginGroupClosedBatch(
    closeGroup([receipt]).receipt.sourceGroupId,
    testPublicationBarrier,
  );
  const settlement = settleGroup(active);
  acknowledgeRun('run-malformed-fence', active.sealed.observerId, undefined, settlement.settlementDigest);
  const groupKey = createHash('sha256').update(active.sealed.sourceGroupId).digest('hex');
  const dir = path.join(WORKFLOW_RUNS_DIR, '.origin-groups', groupKey);
  const fence = path.join(dir, 'closing.json');
  writeFileSync(fence, '{"version":1,"corrupt":true}', 'utf-8');

  assert.throws(
    () => compactSettledWorkflowOriginGroup(active.sealed.sourceGroupId),
    /close authority is invalid/,
  );
  assert.equal(readWorkflowOriginGroupTombstone(active.sealed.sourceGroupId), null);
  assert.equal(existsSync(fence), true);
  assert.equal(existsSync(path.join(dir, 'closed.json')), true);
});

test('compaction refuses to erase a valid but conflicting close fence', () => {
  writeRun('run-conflicting-fence-a', 'completed');
  writeRun('run-conflicting-fence-b', 'completed');
  const receipts = [prepared('run-conflicting-fence-a'), prepared('run-conflicting-fence-b')];
  const active = finalizeWorkflowOriginGroupClosedBatch(
    closeGroup(receipts).receipt.sourceGroupId,
    testPublicationBarrier,
  );
  const settlement = settleGroup(active);
  acknowledgeRun('run-conflicting-fence-a', active.sealed.observerId, undefined, settlement.settlementDigest);
  acknowledgeRun('run-conflicting-fence-b', active.sealed.observerId, undefined, settlement.settlementDigest);
  const groupKey = createHash('sha256').update(active.sealed.sourceGroupId).digest('hex');
  const dir = path.join(WORKFLOW_RUNS_DIR, '.origin-groups', groupKey);
  const fence = path.join(dir, 'closing.json');
  const conflicting = createWorkflowOriginGroupCloseAuthority([receipts[0]]);
  writeFileSync(fence, JSON.stringify(conflicting), 'utf-8');

  assert.throws(
    () => compactSettledWorkflowOriginGroup(active.sealed.sourceGroupId),
    /conflicting immutable close intent/,
  );
  assert.equal(readWorkflowOriginGroupTombstone(active.sealed.sourceGroupId), null);
  assert.equal(readWorkflowOriginGroupCloseIntent(active.sealed.sourceGroupId)?.closeDigest, conflicting.closeDigest);
  assert.equal(existsSync(path.join(dir, 'closed.json')), true);
});

test('compaction replay refuses to erase corrupt staged admission evidence after tombstone wins', () => {
  writeRun('run-corrupt-staged-compaction', 'completed');
  const unindexed = prepared(
    'run-corrupt-staged-compaction',
    observer,
    'run-corrupt-staged-compaction',
    false,
  );
  recordWorkflowChatDispatchAdmission(unindexed);
  const receipt = recordWorkflowChatDispatchPreparation(unindexed);
  const active = finalizeWorkflowOriginGroupClosedBatch(
    closeGroup([receipt]).receipt.sourceGroupId,
    testPublicationBarrier,
  );
  const settlement = settleGroup(active);
  acknowledgeRun(
    'run-corrupt-staged-compaction',
    active.sealed.observerId,
    undefined,
    settlement.settlementDigest,
  );
  assert.throws(
    () => compactSettledWorkflowOriginGroup(active.sealed.sourceGroupId, {
      failAfterTombstoneForTest: true,
    }),
    /after durable tombstone/,
  );
  const groupKey = createHash('sha256').update(active.sealed.sourceGroupId).digest('hex');
  const dir = path.join(WORKFLOW_RUNS_DIR, '.origin-groups', groupKey);
  const admissionFile = path.join(dir, 'admissions', `${receipt.queueRequestDigest}.json`);
  writeFileSync(admissionFile, '{"version":1,"corrupt":true}', 'utf-8');

  assert.throws(
    () => compactSettledWorkflowOriginGroup(active.sealed.sourceGroupId),
    /preparation authority is invalid/,
  );
  assert.ok(readWorkflowOriginGroupTombstone(active.sealed.sourceGroupId));
  assert.equal(existsSync(admissionFile), true);
  assert.equal(existsSync(path.join(dir, 'closed.json')), true);
});

test('compaction requires every present member ack but treats a missing member record as already reaped', () => {
  writeRun('run-compact-present', 'completed');
  writeRun('run-compact-reaped', 'completed');
  const active = finalizeWorkflowOriginGroupClosedBatch(closeGroup([
    prepared('run-compact-present'),
    prepared('run-compact-reaped'),
  ]).receipt.sourceGroupId, testPublicationBarrier);
  const settlement = settleGroup(active);
  acknowledgeRun(
    'run-compact-present',
    active.sealed.observerId,
    undefined,
    settlement.settlementDigest,
  );
  assert.throws(
    () => compactSettledWorkflowOriginGroup(active.sealed.sourceGroupId),
    /member run-compact-reaped has not acknowledged settlement/,
  );

  rmSync(path.join(WORKFLOW_RUNS_DIR, 'run-compact-reaped.json'), { force: true });
  rmSync(path.join(
    WORKFLOW_RUNS_DIR,
    '.run-origins',
    createHash('sha256').update('run-compact-reaped').digest('hex'),
  ), { recursive: true, force: true });
  const compacted = compactSettledWorkflowOriginGroup(active.sealed.sourceGroupId);
  assert.deepEqual(compacted.members.map((member) => member.runId), [
    'run-compact-present',
    'run-compact-reaped',
  ]);
  assert.equal(readActiveExactWorkflowRunOriginRecords('run-compact-present').length, 1);
});

test('compaction rejects a stale or canonically contradictory member acknowledgement', () => {
  writeRun('run-compact-invalid-ack', 'completed');
  const active = finalizeWorkflowOriginGroupClosedBatch(closeGroup([
    prepared('run-compact-invalid-ack'),
  ]).receipt.sourceGroupId, testPublicationBarrier);
  const settlement = settleGroup(active);
  acknowledgeRun('run-compact-invalid-ack', active.sealed.observerId);
  assert.throws(
    () => compactSettledWorkflowOriginGroup(active.sealed.sourceGroupId),
    /has not acknowledged settlement/,
    'a bare observer id is not durable settlement authority',
  );
  acknowledgeRun(
    'run-compact-invalid-ack',
    active.sealed.observerId,
    undefined,
    settlement.settlementDigest,
  );

  const file = path.join(WORKFLOW_RUNS_DIR, 'run-compact-invalid-ack.json');
  const contradictory = JSON.parse(readFileSync(file, 'utf-8'));
  contradictory.reportBack.outcome = 'failed';
  writeFileSync(file, JSON.stringify(contradictory), 'utf-8');
  assert.throws(
    () => compactSettledWorkflowOriginGroup(active.sealed.sourceGroupId),
    /has not acknowledged settlement/,
  );

  acknowledgeRun(
    'run-compact-invalid-ack',
    active.sealed.observerId,
    undefined,
    settlement.settlementDigest,
  );
  const retrying = JSON.parse(readFileSync(file, 'utf-8'));
  retrying.reportBackRetry = {
    version: 1,
    kind: 'delivery',
    failureCount: 1,
    lastFailureAt: new Date(1_800_500_000_000 + evidenceSeq).toISOString(),
    lastError: 'stale delivery retry',
  };
  writeFileSync(file, JSON.stringify(retrying), 'utf-8');
  assert.throws(
    () => compactSettledWorkflowOriginGroup(active.sealed.sourceGroupId),
    /has not acknowledged settlement/,
  );

  delete retrying.reportBackRetry;
  writeFileSync(file, JSON.stringify(retrying), 'utf-8');
  assert.equal(
    compactSettledWorkflowOriginGroup(active.sealed.sourceGroupId).settlement.sourceGroupId,
    active.sealed.sourceGroupId,
  );
});

test('durable closed batch recovers without the model and freezes later membership', () => {
  writeRun('run-closed-a');
  writeRun('run-closed-b');
  const receipts = [prepared('run-closed-a'), prepared('run-closed-b')];
  assert.equal(workflowRunHasPendingChatDispatchPreparation('run-closed-a'), true);
  assert.equal(workflowRunHasPendingChatDispatchPreparation('run-closed-b'), true);
  const closed = closeGroup(receipts);
  assert.deepEqual(closed.receipt.members.map((member) => ({
    runId: member.runId,
    eventId: member.preparedEventId,
    receiptDigest: member.receiptDigest,
  })), receipts.map((receipt) => ({
    runId: receipt.runId,
    eventId: receipt.preparedEventId,
    receiptDigest: receipt.receiptDigest,
  })));
  assert.ok(readWorkflowOriginGroupClosedBatch(closed.receipt.sourceGroupId));
  assert.equal(status('run-closed-a'), 'awaiting_chat_dispatch_seal');
  assert.equal(status('run-closed-b'), 'awaiting_chat_dispatch_seal');
  assert.equal(workflowRunHasPendingChatDispatchPreparation('run-closed-a'), true);

  const recovered = recoverClosedWorkflowOriginGroups(testPublicationBarrier);
  assert.deepEqual(recovered, { groupsExamined: 1, groupsFinalized: 1, rejected: 0 });
  assert.equal(status('run-closed-a'), 'queued');
  assert.equal(status('run-closed-b'), 'queued');
  assert.equal(workflowRunHasPendingChatDispatchPreparation('run-closed-a'), true);
  assert.equal(workflowRunHasPendingChatDispatchPreparation('run-closed-b'), true);
  assert.throws(() => prepared('run-closed-late'), /closed and cannot admit a later preparation/);
});

test('unknown run-origin marker versions fail closed instead of disappearing', () => {
  writeRun('run-unknown-origin', 'queued');
  const runKey = createHash('sha256').update('run-unknown-origin').digest('hex');
  const markerDir = path.join(WORKFLOW_RUNS_DIR, '.run-origins', runKey);
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(path.join(markerDir, 'unknown.json'), JSON.stringify({
    version: 99,
    runId: 'run-unknown-origin',
    originSessionId: observer.sessionId,
  }), 'utf-8');
  assert.throws(
    () => readActiveExactWorkflowRunOriginRecords('run-unknown-origin'),
    /unknown origin observer marker version/,
  );
});
