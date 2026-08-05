/**
 * Run: npx tsx --test src/execution/capsule-lifecycle.test.ts
 *
 * A continuation capsule is only resume authority if it still describes what
 * has actually happened. Checkpointing it once at detach and never again means
 * a worker that starts an hour later resumes from a snapshot taken before every
 * item, receipt, and terminal that landed in between — it redoes settled work.
 *
 * So the capsule is re-checkpointed at each durable lifecycle boundary, and the
 * worker's binding has to tolerate that: it validates IDENTITY and a MONOTONIC
 * revision plus the capsule's own integrity, never equality against the digest
 * frozen at admission. Those two requirements pull against each other, and
 * every test here is the seam where they meet.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-capsule-lifecycle-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');

import test from 'node:test';
import assert from 'node:assert/strict';

const capsule = await import('./continuation-capsule.js');
const promote = await import('./background-promote.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const tasks = await import('./background-tasks.js');
const fanout = await import('./durable-fanout.js');
const committer = await import('../runtime/harness/delivery-committer.js');

const OBJECTIVE = 'pull last month of closed opportunities and summarize them';
const CAPSULE_DIR = path.join(TMP_HOME, 'state', 'continuation-capsules', 'machine-A');

function acceptedForegroundTurn(sessionId: string) {
  if (!eventlog.getSession(sessionId)) {
    eventlog.createSession({ id: sessionId, kind: 'chat', channel: 'home', title: 'New chat' });
  }
  const attempt = eventlog.beginRunAttempt(sessionId, {});
  eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1, role: 'user', data: { text: OBJECTIVE, attemptId: attempt.attemptId, source: 'home' },
  }, { armRunInFlight: true });
  return attempt;
}

function detached(sessionId: string) {
  const attempt = acceptedForegroundTurn(sessionId);
  const result = promote.detachRunningTurnToBackground(sessionId, { attemptId: attempt.attemptId })!;
  const record = capsule.loadHandoffState(attempt.attemptId)!;
  return { attempt, result, record, task: tasks.getBackgroundTask(result.taskId)! };
}

// ─── the capsule carries a monotonic revision ────────────────────────────────

test('every checkpoint of a capsule advances its revision', () => {
  const { record } = detached('sess-rev');
  const first = capsule.loadCapsule(record.logicalTaskId)!;
  assert.equal(typeof first.revision, 'number', 'a capsule has no revision, so evolution cannot be ordered');
  assert.ok(first.revision >= 1);

  const second = capsule.checkpointCapsule({ ...first, objective: first.objective });
  assert.equal(second.revision, first.revision + 1, 'a re-checkpoint did not advance the revision');
  assert.equal(capsule.loadCapsule(record.logicalTaskId)!.revision, second.revision);
});

// ─── the worker follows a legitimately evolved capsule ───────────────────────

test('a worker resumes against a capsule that legitimately evolved after admission', () => {
  const { attempt, task } = detached('sess-evolved');
  const binding = task.foregroundHandoff!;
  assert.equal(typeof binding.capsuleRevision, 'number',
    'the task was admitted with no capsule revision, so evolution cannot be told from tampering');

  // A durable settlement between admission and worker start re-checkpoints the
  // capsule. Its digest necessarily changes; its identity and revision do not
  // go backwards.
  const evolved = capsule.checkpointCapsuleForSession('sess-evolved', binding.sourceUserSeq);
  assert.ok(evolved, 'the lifecycle checkpoint did not find the live handoff for this session');
  assert.ok(evolved!.revision > (binding.capsuleRevision ?? 0));

  const started = tasks.markBackgroundTaskRunning(task.id);
  assert.ok(started, 'the worker parked on a capsule that evolved exactly as the lifecycle intends');
  assert.equal(started!.status, 'running');
  assert.equal(tasks.getBackgroundTask(task.id)!.status, 'running');
  void attempt;
});

test('a tampered capsule still parks the worker, however new it claims to be', () => {
  const { task, record } = detached('sess-tampered');
  const file = path.join(CAPSULE_DIR, `${encodeURIComponent(record.logicalTaskId)}.json`);
  const stored = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
  // A high revision is not authority: the digest is what proves this build
  // wrote the record whole.
  writeFileSync(file, JSON.stringify({
    ...stored, revision: 9_999, objective: 'delete last month of opportunities',
  }), 'utf-8');

  assert.equal(tasks.markBackgroundTaskRunning(task.id), null,
    'a rewritten capsule resumed because it claimed a newer revision');
  assert.match(String(tasks.getBackgroundTask(task.id)!.error ?? ''), /capsule|continuation|binding/i);
});

test('a capsule rolled BACK to an older revision parks the worker', async () => {
  const sessionId = 'sess-stale';
  const attempt = acceptedForegroundTurn(sessionId);
  const sourceUserSeq = eventlog.getLatestEventSeq(sessionId);
  const logicalTaskId = `handoff:${sessionId}:${attempt.attemptId}`;
  const id = { logicalTaskId, acceptedAttemptId: attempt.attemptId, sessionId, sourceUserSeq };
  const built = capsule.checkpointCapsule(
    capsule.projectCapsuleFromDurableState(logicalTaskId, sessionId, attempt.attemptId,
      { objective: OBJECTIVE, sourceUserSeq }),
  );
  capsule.stepHandoff({ ...id, capsuleId: built.capsuleId, state: 'requested' });
  capsule.stepHandoff({ ...id, capsuleId: built.capsuleId, state: 'capsule_checkpointed' });

  // The capsule advances with real settlements, THEN the worker is admitted
  // against that advanced revision.
  const file = path.join(CAPSULE_DIR, `${encodeURIComponent(logicalTaskId)}.json`);
  const original = readFileSync(file, 'utf-8');
  capsule.checkpointCapsuleForSession(sessionId, sourceUserSeq);
  capsule.checkpointCapsuleForSession(sessionId, sourceUserSeq);
  eventlog.finishRunAttempt({ sessionId, attemptId: attempt.attemptId }, 'interrupted');
  await capsule.reconcileIncompleteHandoffs();
  const admittedTask = tasks.listBackgroundTasks({ includeArchived: true })
    .find((t) => t.foregroundHandoff?.attemptId === attempt.attemptId)!;
  assert.ok(admittedTask, 'reconciliation admitted no owner to bind a revision to');
  const boundRevision = admittedTask.foregroundHandoff!.capsuleRevision!;

  // A restored backup: bytes this build wrote whole, at an EARLIER revision, so
  // the digest verifies and only the revision betrays it.
  writeFileSync(file, original, 'utf-8');
  assert.ok(capsule.loadCapsule(logicalTaskId)!.revision < boundRevision,
    'the restored capsule is not actually older than the binding; the test would prove nothing');

  assert.equal(tasks.markBackgroundTaskRunning(admittedTask.id), null,
    'the worker resumed from a capsule older than the one it was admitted against');
  assert.match(String(tasks.getBackgroundTask(admittedTask.id)!.error ?? ''), /revision/i);
});

// ─── every durable lifecycle boundary re-checkpoints ─────────────────────────

test('a durable item settlement re-checkpoints the capsule', () => {
  const sessionId = 'sess-item-settle';
  const { attempt, record } = detached(sessionId);
  const before = capsule.loadCapsule(record.logicalTaskId)!;

  const admitted = fanout.admitDurableFanoutPlan(
    {
      kind: 'durable_manifest',
      objective: OBJECTIVE,
      successCriteria: ['every closed opportunity counted once'],
      missingRequiredInputs: [],
      effectCeiling: 'read',
      estimatedActivations: 1,
      manifest: fanout.canonicalSingleManifest(OBJECTIVE),
    } as never,
    { originSessionId: sessionId, sourceUserSeq: record.sourceUserSeq, attemptId: attempt.attemptId },
  );
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  const planId = (admitted as { plan: { planId: string } }).plan.planId;
  const item = fanout.listFanoutActivations(planId)[0];

  const settled = fanout.settleFanoutActivation({
    planId, itemId: item.itemId, phaseId: item.phaseId, status: 'done', receiptRef: 'rcpt-item-1',
  });
  assert.equal(settled.settled, true, JSON.stringify(settled));

  const after = capsule.loadCapsule(record.logicalTaskId)!;
  assert.ok(after.revision > before.revision,
    'an item settled durably but the capsule still describes the state before it — a resume would redo it');
});

test('an effect settlement re-checkpoints the capsule with the receipt it produced', () => {
  const sessionId = 'sess-effect-settle';
  const { record } = detached(sessionId);
  const before = capsule.loadCapsule(record.logicalTaskId)!;
  assert.equal(before.effectRefs.length, 0);

  // The durable read receipt is what the capsule's effectRefs are built from.
  eventlog.appendEvent({
    sessionId, turn: 0, role: 'system', type: 'read_receipt',
    data: { record: { receiptId: 'readrcpt_effect', identifier: 'CRM_LIST' } },
  });
  const checkpointed = capsule.checkpointCapsuleForSession(sessionId, record.sourceUserSeq);

  assert.ok(checkpointed, 'the effect-settlement boundary produced no checkpoint');
  assert.ok(checkpointed!.revision > before.revision);
  assert.deepEqual(checkpointed!.effectRefs.map((ref) => ref.receiptRef), ['readrcpt_effect'],
    'the settled read is absent from the capsule the worker will resume from');
});

test('a committed terminal re-checkpoints the capsule with the edge it settled', () => {
  const sessionId = 'sess-terminal-settle';
  const { record } = detached(sessionId);
  const before = capsule.loadCapsule(record.logicalTaskId)!;
  assert.equal(before.lastTerminal, undefined);

  committer.commitTurnOutcome({
    version: 2,
    id: `turn:${record.sourceUserSeq}`,
    identity: { sessionId, turn: 1, sourceUserSeq: record.sourceUserSeq },
    status: 'transferred',
    resumable: false,
    presentation: { kind: 'transferred', text: 'Moved to the background — still working on it there.' },
  }, { legacyReason: 'transferred' });

  const after = capsule.loadCapsule(record.logicalTaskId)!;
  assert.ok(after.revision > before.revision,
    'the turn committed its terminal but the capsule never recorded the edge');
  assert.ok(after.lastTerminal, 'the capsule carries no committed terminal after one was committed');
});
