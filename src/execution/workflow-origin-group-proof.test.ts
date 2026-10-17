import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { exactOriginDeliveryReceiptForTarget } from '../runtime/exact-origin-delivery.js';
import type { ExactWorkflowRunOriginRecord, SealedWorkflowOriginGroup, WorkflowOriginGroupSettlementReceipt,
  WorkflowOriginGroupTombstone } from './workflow-origin-group.js';
import {
  activationDigest, createWorkflowChatDispatchPreparationAuthority, createWorkflowChatDispatchPreparedReceipt,
  createWorkflowOriginGroupClosedBatchReceipt, decodeSealedGroup, decodeWorkflowOriginGroupSettlementReceipt,
  decodeWorkflowOriginGroupTombstone, publicDispatch, readActiveWorkflowOriginGroupAtDirectory,
  readWorkflowOriginGroupAtDirectory, readWorkflowOriginGroupSettlementAtDirectory, sourceGroupDigest, workflowChatDispatchQueueRequestDigest,
  workflowOriginGroupCloseDigest, workflowOriginGroupNotificationId, workflowOriginGroupSettlementDigest,
  workflowOriginGroupTombstoneDigest, workflowOriginTerminalDigest, workflowRunReportBackContentDigest,
  type WorkflowOriginGroupProofOptions,
} from './workflow-origin-group-proof.js';

const at = (second: number) => new Date(Date.parse('2026-10-17T00:00:00.000Z') + second * 1000).toISOString();
const options: WorkflowOriginGroupProofOptions = { isWorkflowParentTerminalIdentity: () => false };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function proof(runIds = ['fixture-run-a', 'fixture-run-b']): SealedWorkflowOriginGroup {
  const observer = { sessionId: 'fixture-origin', sourceUserSeq: 10, replyTarget: { type: 'origin_chat' as const } };
  const receipts = runIds.map((runId, index) => createWorkflowChatDispatchPreparedReceipt(
    createWorkflowChatDispatchPreparationAuthority({ runId, observer,
      queueRequestDigest: workflowChatDispatchQueueRequestDigest({ workflowName: 'Fixture workflow', normalizedInputs: { fixture: runId } }) }),
    { eventId: `fixture-prepared-${index}`, eventSeq: 11 + index, preparedAt: at(index + 1) }));
  const first = receipts[0]!;
  const members = receipts.map(row => ({ runId: row.runId, queueRequestDigest: row.queueRequestDigest,
    preparationDigest: row.preparationDigest, preparedEventId: row.preparedEventId, preparedEventSeq: row.preparedEventSeq,
    preparedAt: row.preparedAt, receiptDigest: row.receiptDigest }));
  const body = { sourceGroupId: first.sourceGroupId, observerId: first.observerId,
    originSessionId: first.originSessionId, sourceUserSeq: first.sourceUserSeq,
    replyTarget: first.replyTarget, replyTargetDigest: first.replyTargetDigest, members };
  return decodeSealedGroup({ version: 1, ...body, sourceGroupDigest: sourceGroupDigest(body), sealedAt: at(4) });
}
function settlement(sealed: SealedWorkflowOriginGroup, detail = 'Fixture retained result.', parentRunId?: string): WorkflowOriginGroupSettlementReceipt {
  const memberRunIds = sealed.members.map(member => member.runId);
  const terminalIdentity = { eventId: 'fixture-terminal', outcomeId: `turn:${sealed.sourceUserSeq}`,
    sessionId: sealed.originSessionId, sourceUserSeq: sealed.sourceUserSeq, turn: 1,
    runId: parentRunId ?? (memberRunIds.length === 1 ? memberRunIds[0]! : sealed.sourceGroupId) };
  const body: Omit<WorkflowOriginGroupSettlementReceipt, 'version' | 'settlementDigest'> = {
    sourceGroupId: sealed.sourceGroupId, sourceGroupDigest: sealed.sourceGroupDigest,
    observerId: sealed.observerId, replyTargetDigest: sealed.replyTargetDigest,
    exactDeliveryReceipt: exactOriginDeliveryReceiptForTarget(sealed.replyTarget),
    notificationId: workflowOriginGroupNotificationId({ sourceGroupDigest: sealed.sourceGroupDigest,
      observerId: sealed.observerId, memberRunIds }), terminalIdentity, terminalStatus: 'done',
    terminalDigest: workflowOriginTerminalDigest({ ...terminalIdentity, status: 'done', text: detail }),
    memberRunIds, memberReportBackDigests: memberRunIds.map(runId => ({ runId,
      reportBackDigest: workflowRunReportBackContentDigest({ workflowName: 'Fixture workflow', outcome: 'done', detail }) })), settledAt: at(10),
  };
  return { version: 1, ...body, settlementDigest: workflowOriginGroupSettlementDigest(body) };
}
function tombstone(sealed: SealedWorkflowOriginGroup, receipt: WorkflowOriginGroupSettlementReceipt): WorkflowOriginGroupTombstone {
  const closeBody = { version: 1 as const, sourceGroupId: sealed.sourceGroupId, observerId: sealed.observerId,
    originSessionId: sealed.originSessionId, sourceUserSeq: sealed.sourceUserSeq,
    replyTarget: sealed.replyTarget, replyTargetDigest: sealed.replyTargetDigest, members: sealed.members };
  const closed = createWorkflowOriginGroupClosedBatchReceipt({ ...closeBody, closeDigest: workflowOriginGroupCloseDigest(closeBody) },
    { eventId: 'fixture-closed', eventSeq: 15, closedAt: at(3) });
  const body: Omit<WorkflowOriginGroupTombstone, 'version' | 'kind' | 'tombstoneDigest'> = {
    sourceGroupId: sealed.sourceGroupId, sourceGroupDigest: sealed.sourceGroupDigest, observerId: sealed.observerId,
    originSessionId: sealed.originSessionId, sourceUserSeq: sealed.sourceUserSeq,
    replyTarget: sealed.replyTarget, replyTargetDigest: sealed.replyTargetDigest, members: sealed.members,
    closeDigest: closed.closeDigest, closedEventId: closed.closedEventId, closedEventSeq: closed.closedEventSeq,
    closedAt: closed.closedAt, closeReceiptDigest: closed.closeReceiptDigest, closedRecordedAt: at(3), sealedAt: sealed.sealedAt,
    activatedAt: at(5), activationDigest: activationDigest(sealed, at(5)), settlement: receipt, compactedAt: at(20),
  };
  return { version: 1, kind: 'settled_workflow_origin_group', ...body, tombstoneDigest: workflowOriginGroupTombstoneDigest(body) };
}
function fixture(runIds?: string[]) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-origin-proof-explicit-home-'));
  const runs = path.join(home, 'workflows', 'runs');
  const sealed = proof(runIds);
  const groupDir = path.join(runs, '.origin-groups', sha(sealed.sourceGroupId));
  const groupFile = (name: string) => path.join(groupDir, name);
  const runFile = (runId: string) => path.join(runs, `${runId}.json`);
  const markerFile = (runId: string) => path.join(runs, '.run-origins', sha(runId), `${sealed.observerId.slice('workflow-origin-v2:'.length)}.json`);
  const write = (file: string, value: unknown) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value, null, 2)); };
  const marker = (runId: string): ExactWorkflowRunOriginRecord => ({ version: 2, runId, observerId: sealed.observerId,
    originSessionId: sealed.originSessionId, sourceUserSeq: sealed.sourceUserSeq, replyTarget: sealed.replyTarget,
    replyTargetDigest: sealed.replyTargetDigest, sourceGroupId: sealed.sourceGroupId,
    sourceGroupDigest: sealed.sourceGroupDigest, recordedAt: at(5) });
  write(groupFile('sealed.json'), sealed);
  write(groupFile('activated.json'), { version: 1, sourceGroupId: sealed.sourceGroupId,
    sourceGroupDigest: sealed.sourceGroupDigest, memberRunIds: sealed.members.map(member => member.runId),
    activatedAt: at(5), activationDigest: activationDigest(sealed, at(5)) });
  for (const member of sealed.members) { write(runFile(member.runId), { id: member.runId }); write(markerFile(member.runId), marker(member.runId)); }
  return { home, runs, sealed, groupFile, runFile, markerFile, marker, write,
    cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file); else result[path.relative(root, file)] = sha(readFileSync(file, 'utf8'));
    }
  };
  walk(root); return result;
}

test('shared group proof uses the explicit directory and preserves exact direct bytes without runtime home binding', () => {
  const a = fixture(); const b = fixture(['foreign-home-run']);
  const previous = process.env.CLEMENTINE_HOME;
  try {
    process.env.CLEMENTINE_HOME = b.home;
    const beforeA = snapshot(a.home); const beforeB = snapshot(b.home);
    const active = readActiveWorkflowOriginGroupAtDirectory(a.runs, a.sealed.sourceGroupId, options);
    assert.deepEqual(active?.sealed, a.sealed);
    assert.deepEqual(active?.publicDispatch, publicDispatch(a.sealed));
    assert.deepEqual(snapshot(a.home), beforeA); assert.deepEqual(snapshot(b.home), beforeB);
    const absent = path.join(a.home, 'absent');
    assert.equal(readActiveWorkflowOriginGroupAtDirectory(absent, a.sealed.sourceGroupId, options), null);
    assert.equal(existsSync(absent), false);
  } finally {
    if (previous === undefined) delete process.env.CLEMENTINE_HOME; else process.env.CLEMENTINE_HOME = previous;
    a.cleanup(); b.cleanup();
  }
});

test('shared group proof retains valid settled reaped members and fully compacted tombstones', () => {
  const f = fixture();
  try {
    const reaped = f.sealed.members[1]!.runId;
    unlinkSync(f.runFile(reaped)); unlinkSync(f.markerFile(reaped));
    assert.throws(() => readActiveWorkflowOriginGroupAtDirectory(f.runs, f.sealed.sourceGroupId, options), /missing member/);
    const receipt = settlement(f.sealed);
    f.write(f.groupFile('settlement.json'), receipt);
    assert.deepEqual(readActiveWorkflowOriginGroupAtDirectory(f.runs, f.sealed.sourceGroupId, options)?.sealed, f.sealed);
    const compacted = tombstone(f.sealed, receipt);
    f.write(f.groupFile('tombstone.json'), compacted);
    assert.deepEqual(decodeWorkflowOriginGroupTombstone(compacted, options), compacted);
    for (const name of ['sealed.json', 'activated.json', 'settlement.json']) unlinkSync(f.groupFile(name));
    const survivor = f.sealed.members[0]!.runId;
    unlinkSync(f.runFile(survivor)); unlinkSync(f.markerFile(survivor));
    const before = snapshot(f.home);
    assert.deepEqual(readWorkflowOriginGroupAtDirectory(f.runs, f.sealed.sourceGroupId, options), f.sealed,
      'the public sealed-reader path preserves its compacted fallback too');
    assert.deepEqual(readActiveWorkflowOriginGroupAtDirectory(f.runs, f.sealed.sourceGroupId, options)?.sealed, f.sealed);
    assert.deepEqual(readWorkflowOriginGroupSettlementAtDirectory(f.runs, f.sealed.sourceGroupId, options), receipt);
    assert.deepEqual(snapshot(f.home), before);
    f.write(f.runFile(survivor), { id: survivor });
    assert.throws(() => readActiveWorkflowOriginGroupAtDirectory(f.runs, f.sealed.sourceGroupId, options), /missing member/,
      'a surviving canonical run still needs its exact observer');
    f.write(f.markerFile(survivor), f.marker(survivor));
    assert.ok(readActiveWorkflowOriginGroupAtDirectory(f.runs, f.sealed.sourceGroupId, options));
  } finally { f.cleanup(); }
});

test('shared group proof rejects seal, activation, member and malformed-byte tampering', () => {
  for (const variant of ['seal', 'activation', 'member', 'malformed'] as const) {
    const f = fixture();
    try {
      if (variant === 'seal') f.write(f.groupFile('sealed.json'), { ...f.sealed, sourceGroupDigest: 'f'.repeat(64) });
      else if (variant === 'activation') f.write(f.groupFile('activated.json'), { version: 1, sourceGroupId: f.sealed.sourceGroupId,
        sourceGroupDigest: f.sealed.sourceGroupDigest, memberRunIds: [...f.sealed.members].reverse().map(member => member.runId),
        activatedAt: at(5), activationDigest: activationDigest(f.sealed, at(5)) });
      else if (variant === 'member') f.write(f.markerFile(f.sealed.members[0]!.runId),
        { ...f.marker(f.sealed.members[0]!.runId), sourceGroupDigest: 'f'.repeat(64) });
      else writeFileSync(f.groupFile('activated.json'), '{"fixture-private-invalid-json":');
      const before = snapshot(f.home);
      assert.throws(() => readActiveWorkflowOriginGroupAtDirectory(f.runs, f.sealed.sourceGroupId, options), undefined, variant);
      assert.deepEqual(snapshot(f.home), before);
    } finally { f.cleanup(); }
  }
});

test('retention authority gap is closed: unrelated same-source settlement cannot waive missing active members', () => {
  const f = fixture();
  try {
    const other = proof(['different-member']);
    assert.equal(other.sourceGroupId, f.sealed.sourceGroupId);
    const unrelated = settlement(other);
    assert.deepEqual(decodeWorkflowOriginGroupSettlementReceipt(unrelated, options), unrelated,
      'the contradictory receipt is independently well formed, not malformed test data');
    f.write(f.groupFile('settlement.json'), unrelated);
    for (const member of f.sealed.members) { unlinkSync(f.runFile(member.runId)); unlinkSync(f.markerFile(member.runId)); }
    const before = snapshot(f.home);
    assert.throws(() => readActiveWorkflowOriginGroupAtDirectory(f.runs, f.sealed.sourceGroupId, options), /does not match its active authority/);
    assert.deepEqual(snapshot(f.home), before);
  } finally { f.cleanup(); }
});

test('retention authority gap is closed: compacted proof rejects every contradictory residual direct authority', () => {
  for (const variant of ['settlement', 'seal', 'activation'] as const) {
    const f = fixture();
    try {
      const retained = settlement(f.sealed);
      f.write(f.groupFile('tombstone.json'), tombstone(f.sealed, retained));
      if (variant === 'settlement') f.write(f.groupFile('settlement.json'), settlement(f.sealed, 'Contradictory retained result.'));
      else if (variant === 'seal') f.write(f.groupFile('sealed.json'), proof(['different-member']));
      else f.write(f.groupFile('activated.json'), { version: 1, sourceGroupId: f.sealed.sourceGroupId,
        sourceGroupDigest: f.sealed.sourceGroupDigest, memberRunIds: f.sealed.members.map(member => member.runId),
        activatedAt: at(6), activationDigest: activationDigest(f.sealed, at(6)) });
      const before = snapshot(f.home);
      assert.throws(() => readActiveWorkflowOriginGroupAtDirectory(f.runs, f.sealed.sourceGroupId, options), /conflicting/);
      assert.deepEqual(snapshot(f.home), before);
    } finally { f.cleanup(); }
  }
});

test('retained parent-terminal exceptions require the injected exact proof, including after compaction', () => {
  const f = fixture();
  try {
    const receipt = settlement(f.sealed, 'Parent retained result.', 'actual-parent-run');
    f.write(f.groupFile('tombstone.json'), tombstone(f.sealed, receipt));
    assert.throws(() => readActiveWorkflowOriginGroupAtDirectory(f.runs, f.sealed.sourceGroupId, options), /terminal identity does not match/);
    const observations: unknown[] = [];
    const exact: WorkflowOriginGroupProofOptions = { isWorkflowParentTerminalIdentity: input => {
      observations.push(input);
      return input.sourceGroupId === f.sealed.sourceGroupId && input.sourceGroupDigest === f.sealed.sourceGroupDigest
        && isDeepStrictEqual(input.terminal, receipt.terminalIdentity);
    } };
    const before = snapshot(f.home);
    assert.ok(readActiveWorkflowOriginGroupAtDirectory(f.runs, f.sealed.sourceGroupId, exact));
    assert.ok(observations.length > 0);
    assert.deepEqual(snapshot(f.home), before);
    assert.throws(() => readActiveWorkflowOriginGroupAtDirectory(f.runs, f.sealed.sourceGroupId,
      { isWorkflowParentTerminalIdentity: () => { throw new Error('fixture parent proof unavailable'); } }), /fixture parent proof unavailable/);
  } finally { f.cleanup(); }
});
