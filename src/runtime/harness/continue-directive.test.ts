/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/continue-directive.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-continue-directive-'));
process.env.CLEMENTINE_HOME = HOME;
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-continue-directive\n', 'utf8');

const {
  buildContinueInput,
  chatAutoContinueCap,
  chatAutoContinueDecision,
  isContinueCompletionReason,
} = await import('./continue-directive.js');

test('the human directive is byte-identical to the historical builders', () => {
  // discord-harness and console-routes carried this text verbatim; the lift
  // must not change what resuming models have been reading.
  assert.equal(buildContinueInput('did three things'), [
    'You hit a step / time budget on the previous turn and the user has now replied `continue`.',
    'Pick up where you left off; do not restart the workflow from scratch.',
    'Your last summary on the prior turn was: "did three things".',
    'Continue with the next step of your plan. If you have nothing left to do, set done=true and nextAction=completed.',
  ].join('\n\n'));
  assert.match(buildContinueInput(undefined), /Use the conversation history above/);
  // The auto variant differs ONLY in who authorized the continuation.
  const auto = buildContinueInput('did three things', { auto: true });
  assert.match(auto, /continuing automatically under your budget preset/);
  assert.doesNotMatch(auto, /replied `continue`/);
});

test('auto-continue decision: preset off, cap, and zero progress all park to a human', () => {
  const base = { autoContinueOnLimit: true, attempts: 0, cap: 24, stepsThisActivation: 3 };
  assert.deepEqual(chatAutoContinueDecision(base), { resume: true });
  assert.deepEqual(
    chatAutoContinueDecision({ ...base, autoContinueOnLimit: false }),
    { resume: false, reason: 'preset_asks' },
  );
  assert.deepEqual(
    chatAutoContinueDecision({ ...base, attempts: 24 }),
    { resume: false, reason: 'cap_exhausted' },
  );
  // A zero-step activation made no progress; resuming it can only spin.
  assert.deepEqual(
    chatAutoContinueDecision({ ...base, stepsThisActivation: 0 }),
    { resume: false, reason: 'no_progress' },
  );
});

test('the cap is bounded and env-tunable, mirroring the background hard cap', () => {
  // NEVER-RESTING (2026-08-18): the cap is a runaway backstop, not a work
  // budget — a full day of checkpointed passes fits under the default.
  assert.equal(chatAutoContinueCap(), 200);
  process.env.CLEMMY_CHAT_AUTO_CONTINUE_CAP = '3';
  assert.equal(chatAutoContinueCap(), 3);
  process.env.CLEMMY_CHAT_AUTO_CONTINUE_CAP = '9999';
  assert.equal(chatAutoContinueCap(), 1000, 'ceiling clamps runaway configs');
  process.env.CLEMMY_CHAT_AUTO_CONTINUE_CAP = 'nonsense';
  assert.equal(chatAutoContinueCap(), 200);
  delete process.env.CLEMMY_CHAT_AUTO_CONTINUE_CAP;
});

test('continue-shaped completion reasons are recognized', () => {
  assert.equal(isContinueCompletionReason('awaiting_continue'), true);
  assert.equal(isContinueCompletionReason('limit_exceeded'), true);
  assert.equal(isContinueCompletionReason('local_work_incomplete'), true);
  assert.equal(isContinueCompletionReason('budget_checkpoint_auto_resume'), false,
    'an auto checkpoint is not a human-continue prompt');
  assert.equal(isContinueCompletionReason('done'), false);
});

test('local continuation names only missing accepted items and keeps settled siblings retained', () => {
  const text = buildContinueInput('Seven receipts are retained.', { auto: true, missing: ['nonce-batch/read_nonce/audit-8'] });
  assert.match(text, /Remaining accepted local items: \["nonce-batch\/read_nonce\/audit-8"\]/);
  assert.doesNotMatch(text, /audit-[1-7]/);
  assert.doesNotMatch(text, /hit a step \/ time budget/);
  assert.match(text, /do not rerun successful siblings or replay prior writes/);
});

test('a replayed auto-checkpoint terminal survives the legacy-winner adapter as blocked+resumable', async () => {
  // The durable first writer wins on a same-key retry, and the legacy adapter
  // used to rewrite anything smelling of a limit back into needs_input and
  // hardcode resumable=false — which would silently convert the never-resting
  // checkpoint back into a question on process-upgrade replays.
  const { createSession, appendEvent } = await import('./eventlog.js');
  const { recordTurnGraphShadow } = await import('../graph/turn-graph-shadow.js');
  const { commitTurnOutcome } = await import('./delivery-committer.js');
  const { turnOutcomeId } = await import('./turn-outcome.js');

  const sess = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: sess.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text: 'run the long task' },
  });
  recordTurnGraphShadow({ identity: { sessionId: sess.id, sourceUserSeq: source.seq, turn: 1 } });
  const identity = { sessionId: sess.id, turn: 1, sourceUserSeq: source.seq };
  const first = commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'blocked',
    resumable: true,
    presentation: { kind: 'blocked', text: 'checkpointing and continuing automatically (pass 1 of 24)' },
  }, {
    legacyReason: 'budget_checkpoint_auto_resume',
    metadata: { autoResume: true, autoResumeAttempt: 1, limitKind: 'max_steps' },
  });
  assert.equal(first.presentation.kind, 'blocked');

  // Retry with the same outcome id: the stored row is authority and must be
  // adapted, not replaced — and must stay a blocked, resumable checkpoint.
  const replay = commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'continue' },
    presentation: { kind: 'continue', text: 'this losing proposal must not win' },
  }, { legacyReason: 'awaiting_continue' });
  assert.equal(replay.presentation.kind, 'blocked', 'stored checkpoint must not be rewritten to a question');
  assert.equal(replay.presentation.text.includes('continuing automatically'), true);
});
