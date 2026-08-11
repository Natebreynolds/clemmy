/**
 * Run: npx tsx --test src/runtime/harness/completed-answer-replay.test.ts
 *
 * Exercises the production completed-answer replay authority reader against a
 * fully isolated durable home. No injected protection seam is used here: a
 * replay is admitted only when the real event log and every ownership store
 * inspected by readCompletedAnswerReplayProtection are clear.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-completed-answer-replay-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const {
  assessCompletedAnswerReplay,
  isExplicitCompletedAnswerReplay,
  readCompletedAnswerReplayProtection,
} = await import('./completed-answer-replay.js');
const {
  appendEvent,
  beginRunAttempt,
  closeEventLog,
  createSession,
  finishRunAttempt,
  openEventLog,
  recordRunAttemptUserInput,
} = await import('./eventlog.js');
const { exactTerminalForAcceptedSource } = await import('./accepted-source-terminal.js');
const { acceptedSourceOutcome } = await import('./accepted-source-outcome.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
const { currentAcceptedReadAuthority } = await import('../read-path/accepted-read-authority.js');

let sessionSequence = 0;

function seedCompletedAnswerReplay(answerRequest = 'Repeat the last answer.') {
  sessionSequence += 1;
  const sessionId = `completed-answer-replay-production-${sessionSequence}`;
  createSession({ id: sessionId, kind: 'chat' });

  const priorAttempt = beginRunAttempt(sessionId, { runId: `${sessionId}:prior` });
  const priorSource = recordRunAttemptUserInput(priorAttempt, {
    turn: 1,
    role: 'user',
    data: { text: 'Inspect the workspace and report its roots.' },
  }, { armRunInFlight: true });
  const priorIdentity = {
    sessionId,
    turn: priorSource.turn,
    sourceUserSeq: priorSource.seq,
  } as const;
  const priorCommit = commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(priorIdentity),
    identity: priorIdentity,
    status: 'done',
    resumable: false,
    presentation: {
      kind: 'answer',
      text: 'The durable workspace inspection is complete.',
    },
  });
  finishRunAttempt(priorAttempt, 'completed');

  const currentAttempt = beginRunAttempt(sessionId, { runId: `${sessionId}:current` });
  const currentSource = recordRunAttemptUserInput(currentAttempt, {
    turn: 2,
    role: 'user',
    data: { text: answerRequest },
  }, { armRunInFlight: true });
  const authority = currentAcceptedReadAuthority(
    sessionId,
    currentSource.seq,
    currentAttempt.runId ?? undefined,
    answerRequest,
  );
  assert.ok(authority, 'the current answer-repeat request must own exact accepted-read authority');

  return {
    authority,
    currentAttempt,
    currentSource,
    priorCommit,
    priorSource,
    protectionInput: {
      sessionId,
      currentSource,
      currentAttemptId: currentAttempt.attemptId,
      currentRunId: currentAttempt.runId,
      priorSource,
      priorTerminal: priorCommit.event,
    },
    sessionId,
  };
}

async function expectDurableBlocker(
  expected: string,
  arrange: (seed: ReturnType<typeof seedCompletedAnswerReplay>) => (() => void) | void,
): Promise<void> {
  const seed = seedCompletedAnswerReplay();
  const cleanup = arrange(seed);
  try {
    const blockers = await readCompletedAnswerReplayProtection(seed.protectionInput);
    assert.ok(blockers.includes(expected), `expected ${expected}; got ${JSON.stringify(blockers)}`);
    assert.equal(
      await assessCompletedAnswerReplay({ authority: seed.authority }),
      null,
      `${expected} must make the production assessor decline zero-work replay`,
    );
  } finally {
    cleanup?.();
  }
}

test('explicit completed-answer replay syntax is narrow and conversational continuations are ordinary turns', () => {
  for (const value of [
    'Repeat the last answer.',
    'Repeat your previous answer!',
    '/repeat-answer',
    'Show me the last answer again.',
    'Send me your previous answer again?',
  ]) {
    assert.equal(isExplicitCompletedAnswerReplay(value), true, value);
  }
  for (const value of [
    'Continue.',
    'Resume!',
    'Keep going!',
    'Repeat that.',
    'Repeat the task.',
    'Repeat the last answer and refresh it.',
  ]) {
    assert.equal(isExplicitCompletedAnswerReplay(value), false, value);
  }
});

test('production protection admits a clean typed completed-answer replay', async () => {
  const seed = seedCompletedAnswerReplay('Repeat the last answer.');

  assert.deepEqual(
    exactTerminalForAcceptedSource(seed.priorSource),
    acceptedSourceOutcome(seed.priorSource),
    'the narrow terminal reducer must preserve the composite reducer projection',
  );

  assert.deepEqual(
    await readCompletedAnswerReplayProtection(seed.protectionInput),
    [],
    'a clean current attempt has no durable unfinished-work owner',
  );

  const candidate = await assessCompletedAnswerReplay({ authority: seed.authority });
  assert.ok(candidate);
  assert.equal(candidate.text, 'The durable workspace inspection is complete.');
  assert.equal(candidate.priorSource.seq, seed.priorSource.seq);
  assert.equal(candidate.priorTerminal.id, seed.priorCommit.event.id);
  assert.equal(candidate.priorPresentationId, seed.priorCommit.presentation.id);
});

test('narrow terminal resolution preserves fail-closed corrupt-row behavior', () => {
  sessionSequence += 1;
  const sessionId = `completed-answer-replay-corrupt-${sessionSequence}`;
  createSession({ id: sessionId, kind: 'chat' });
  const attempt = beginRunAttempt(sessionId, { runId: `${sessionId}:run` });
  const source = recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: 'Inspect the workspace.' },
  }, { armRunInFlight: true });
  appendEvent({
    sessionId,
    turn: source.turn,
    role: 'assistant',
    type: 'conversation_completed',
    parentEventId: source.id,
    data: {
      terminalKey: `turn:${source.seq}`,
      sourceUserSeq: source.seq,
      presentation: {
        identity: {
          sessionId,
          turn: source.turn,
          sourceUserSeq: source.seq,
        },
      },
    },
  });
  finishRunAttempt(attempt, 'completed');

  assert.equal(exactTerminalForAcceptedSource(source), null);
  assert.equal(acceptedSourceOutcome(source), null);
});

test('production protection blocks material durable unfinished-work owners', async (t) => {
  await t.test('pending approval', async () => {
    await expectDurableBlocker('approval', ({ sessionId }) => {
      const approvalId = `apr-${sessionSequence}`;
      const now = new Date().toISOString();
      openEventLog().prepare(`
        INSERT INTO pending_approvals
          (approval_id, session_id, requested_at, expires_at, subject, status)
        VALUES (?, ?, ?, ?, ?, 'pending')
      `).run(approvalId, sessionId, now, new Date(Date.now() + 60_000).toISOString(), 'Approve test work');
      return () => {
        openEventLog().prepare('DELETE FROM pending_approvals WHERE approval_id = ?').run(approvalId);
      };
    });
  });

  await t.test('active background task', async () => {
    await expectDurableBlocker('background_task', ({ sessionId }) => {
      const directory = path.join(TEST_HOME, 'state', 'background-tasks');
      const file = path.join(directory, `bg-${sessionSequence}.json`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(file, JSON.stringify({
        id: `bg-${sessionSequence}`,
        sessionId,
        status: 'running',
      }), 'utf-8');
      return () => rmSync(file, { force: true });
    });
  });

  await t.test('completed background task with no outcome delivery', async () => {
    await expectDurableBlocker('background_task_report_back', ({ sessionId }) => {
      const directory = path.join(TEST_HOME, 'state', 'background-tasks');
      const file = path.join(directory, `bg-done-${sessionSequence}.json`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(file, JSON.stringify({
        id: `bg-done-${sessionSequence}`,
        originSessionId: sessionId,
        status: 'done',
      }), 'utf-8');
      return () => rmSync(file, { force: true });
    });
  });

  await t.test('unsettled foreground handoff', async () => {
    const { advanceHandoff } = await import('../../execution/handoff-store.js');
    await expectDurableBlocker('handoff', ({ sessionId, priorSource }) => {
      const result = advanceHandoff({
        logicalTaskId: `logical-${sessionSequence}`,
        acceptedAttemptId: `handoff-attempt-${sessionSequence}`,
        sessionId,
        sourceUserSeq: priorSource.seq,
        state: 'requested',
      }, { expectedRevision: 0 });
      assert.equal(result.ok, true);
    });
  });

  await t.test('approved pending action', async () => {
    await expectDurableBlocker('pending_action', ({ sessionId }) => {
      const directory = path.join(TEST_HOME, 'pending-actions');
      const file = path.join(directory, `pa-${sessionSequence}.json`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(file, JSON.stringify({
        id: `pa-${sessionSequence}`,
        sessionId,
        status: 'approved',
      }), 'utf-8');
      return () => rmSync(file, { force: true });
    });
  });

  await t.test('active plan proposal', async () => {
    await expectDurableBlocker('plan_or_goal', ({ sessionId }) => {
      const directory = path.join(TEST_HOME, 'state', 'plan-proposals');
      const file = path.join(directory, `plan-${sessionSequence}.json`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(file, JSON.stringify({
        id: `plan-${sessionSequence}`,
        sessionId,
        status: 'active',
      }), 'utf-8');
      return () => rmSync(file, { force: true });
    });
  });

  await t.test('running workflow', async () => {
    await expectDurableBlocker('workflow_run', ({ sessionId }) => {
      const directory = path.join(TEST_HOME, 'workflows', 'runs');
      const file = path.join(directory, `workflow-${sessionSequence}.json`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(file, JSON.stringify({
        id: `workflow-${sessionSequence}`,
        workflow: 'production protection test',
        originSessionId: sessionId,
        status: 'running',
      }), 'utf-8');
      return () => rmSync(file, { force: true });
    });
  });

  await t.test('terminal workflow with no report-back envelope', async () => {
    await expectDurableBlocker('workflow_report_back', ({ sessionId }) => {
      const directory = path.join(TEST_HOME, 'workflows', 'runs');
      const file = path.join(directory, `workflow-terminal-${sessionSequence}.json`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(file, JSON.stringify({
        id: `workflow-terminal-${sessionSequence}`,
        workflow: 'production protection test',
        originSessionId: sessionId,
        status: 'completed',
        finishedAt: new Date().toISOString(),
      }), 'utf-8');
      return () => rmSync(file, { force: true });
    });
  });
});

test('production assessor fails closed when a durable authority file is corrupt', async () => {
  const seed = seedCompletedAnswerReplay();
  const directory = path.join(TEST_HOME, 'state', 'background-tasks');
  const file = path.join(directory, 'corrupt.json');
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, '{', 'utf-8');

  try {
    await assert.rejects(
      readCompletedAnswerReplayProtection(seed.protectionInput),
      /JSON|Unexpected|malformed/i,
    );
    assert.equal(
      await assessCompletedAnswerReplay({ authority: seed.authority }),
      null,
      'unreadable durable state is never permission to replay a prior answer',
    );
  } finally {
    rmSync(file, { force: true });
  }
});

test.after(async () => {
  closeEventLog();
  const { closeHandoffStoreForTests } = await import('../../execution/handoff-store.js');
  closeHandoffStoreForTests();
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});
