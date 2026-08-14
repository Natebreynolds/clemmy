/**
 * RED — the verification downgrade must not erase a grounded partial result.
 *
 * Run: npx tsx --test src/runtime/harness/delivery-committer-grounded-partial.red.test.ts
 *
 * Invariant under pin: when a `done` proposal is refused by terminal
 * preparation (needs_verification), the committed blocked presentation must
 * still PRESERVE or REFERENCE the settled partial work through its typed
 * evidence carrier. Today `unverifiedCompletionOutcome` replaces the entire
 * reply with one canned line and derives nothing from the settlement/manifest
 * ledgers — a task with real durably-checkpointed item results reads to the
 * user as "nothing verifiable happened" (live 2026-08-11 class: a fully
 * grounded partial replaced by the bare verification hold).
 *
 * The guard below pins the part that already works: caller-supplied
 * evidenceRefs survive the downgrade. The red test pins the missing half:
 * the downgraded terminal must reference the durable partial even when the
 * reducing caller supplied none, because the evidence exists in the host's own
 * ledgers at commit time.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-committer-grounded-partial-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-grounded-partial\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const admission = await import('./expected-work-admission.js');
const workManifest = await import('./work-manifest.js');
const preparation = await import('./accepted-task-terminal-preparation.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
type TurnOutcome = import('./turn-outcome.js').TurnOutcome;
type TurnEvidenceRef = import('./turn-outcome.js').TurnEvidenceRef;

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

/** An accepted, durably activated action turn (chat act lane). */
function acceptActivatedAction(text: string) {
  serial += 1;
  const session = eventlog.createSession({ id: `grounded-partial-${serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  const activated = admission.activateActionExpectedWork({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.ok(
    activated.status === 'activated' || activated.status === 'replayed',
    `fixture precondition: ${JSON.stringify(activated)}`,
  );
  return { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
}

/** Real settled partial work: 2 of 3 declared item-phases durably succeeded
 * with evidence; the third is still open, so preparation refuses `done`. */
function settlePartialManifest(task: ReturnType<typeof acceptActivatedAction>, manifestId: string): string[] {
  workManifest.declareWorkManifest({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    manifestId,
    contractVersion: '1',
    phases: [{ id: 'deliver' }],
    items: [{ id: 'record-001' }, { id: 'record-002' }, { id: 'record-003' }],
  });
  const evidence: string[] = [];
  for (const itemId of ['record-001', 'record-002']) {
    const ref = `worker:deliver:${itemId}`;
    workManifest.checkpointWorkItem({
      sessionId: task.sessionId,
      manifestId,
      contractVersion: '1',
      phase: 'deliver',
      itemId,
      status: 'succeeded',
      evidence: [{ kind: 'worker_result', ref }],
    });
    evidence.push(ref);
  }
  return evidence;
}

function doneOutcome(
  task: ReturnType<typeof acceptActivatedAction>,
  text: string,
  evidenceRefs?: TurnEvidenceRef[],
): TurnOutcome {
  const identity = { sessionId: task.sessionId, turn: task.turn, sourceUserSeq: task.sourceUserSeq };
  return {
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text },
    ...(evidenceRefs ? { evidenceRefs } : {}),
  };
}

test('the downgraded blocked terminal references the settled partial, not the bare canned line alone', () => {
  const task = acceptActivatedAction('Email alex@example.com the update for every record.');
  settlePartialManifest(task, 'grounded-partial-manifest');

  // FIXTURE PROOF — the host refuses this done for verification reasons while
  // owning REAL durable partial evidence (2/3 item-phases settled with refs).
  const prepared = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(prepared.status, 'needs_verification', `fixture precondition: ${JSON.stringify(prepared)}`);
  const summary = workManifest.summarizeWorkManifest(task.sessionId, 'grounded-partial-manifest');
  assert.equal(summary?.completed, 2, 'fixture precondition: two grounded item results exist');
  assert.ok((summary?.evidenceCount ?? 0) >= 2, 'fixture precondition: the partial work has durable evidence');

  const committed = commitTurnOutcome(doneOutcome(
    task,
    'Sent the update for record-001 and record-002; record-003 is still pending review.',
  ));
  assert.equal(
    committed.presentation.status,
    'blocked',
    'fixture precondition: the verification downgrade fired (the done claim was refused)',
  );

  // TARGET — the committed blocked presentation must carry the grounded partial
  // through its typed carrier (evidenceRefs), derived from the durable manifest
  // evidence at commit time. Erasing it leaves only the canned hold line.
  assert.ok(
    (committed.presentation.evidenceRefs?.length ?? 0) > 0,
    'the verification downgrade erased the grounded partial: the committed blocked '
    + 'presentation carries ZERO evidenceRefs while 2 item-phases are durably settled '
    + `with evidence in the work manifest — committed text: ${JSON.stringify(committed.presentation.text)}`,
  );
});

test('GUARD — caller-supplied evidenceRefs survive the verification downgrade', () => {
  const task = acceptActivatedAction('Email alex@example.com the update for every record.');
  const refs = settlePartialManifest(task, 'grounded-partial-guard-manifest');

  const committed = commitTurnOutcome(doneOutcome(
    task,
    'Sent the update for record-001 and record-002; record-003 is still pending review.',
    refs.map((ref) => ({ kind: 'tool_result' as const, id: ref })),
  ));
  assert.equal(committed.presentation.status, 'blocked', 'the downgrade still fires');
  assert.deepEqual(
    (committed.presentation.evidenceRefs ?? []).map((ref) => ref.id).sort(),
    [...refs].sort(),
    'evidence references supplied by the reducing caller must never be dropped by the downgrade',
  );
});
