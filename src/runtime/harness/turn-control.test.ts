/**
 * Run: npx tsx --test src/runtime/harness/turn-control.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-turn-control-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const {
  beginRunAttempt,
  createSession,
  requestKill,
  clearKill,
  accrueSessionTokens,
  listEvents,
  recordRunAttemptUserInput,
} = await import('./eventlog.js');
const { openRunTokenWindow } = await import('./run-token-budget.js');
const {
  killGateVerdict,
  grindGateVerdict,
  composeKillAwareShouldCancel,
  evaluateTurnBoundary,
  effectiveTurnObjective,
} = await import('./turn-control.js');
const { appendEvent } = await import('./eventlog.js');

let seq = 0;
function freshSession(kind = 'chat'): string {
  seq += 1;
  const id = `turn-control-test-${Date.now().toString(36)}-${seq}`;
  createSession({ id, kind } as never);
  return id;
}

afterEach(() => {
  delete process.env.CLEMMY_GUARDRAIL_MUT_WARN;
  delete process.env.CLEMMY_GUARDRAIL_MUT_HALT;
  delete process.env.CLEMMY_GUARDRAIL_EXACT_BLOCK;
});

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

// ── kill gate ────────────────────────────────────────────────────────────────

test('killGateVerdict: null normally; a hard interrupt deny once the kill row exists', () => {
  const sess = freshSession();
  assert.equal(killGateVerdict(sess), null);
  requestKill(sess, 'user stop');
  const verdict = killGateVerdict(sess);
  assert.equal(verdict?.behavior, 'deny');
  assert.equal(verdict?.interrupt, true, 'interrupt:true is the only reliable in-loop stop');
  clearKill(sess);
  assert.equal(killGateVerdict(sess), null);
  assert.equal(killGateVerdict(undefined), null);
});

test('composeKillAwareShouldCancel: ORs the kill switch with the base', async () => {
  const sess = freshSession();
  const base = { value: false };
  const fn = composeKillAwareShouldCancel(sess, () => base.value);
  assert.equal(await fn(), false);
  requestKill(sess, 'stop');
  assert.equal(await fn(), true, 'kill row cancels');
  clearKill(sess);
  assert.equal(await fn(), false);
  base.value = true;
  assert.equal(await fn(), true, 'base caller-cancel still works');
});

test('kill readers stay bound to their physical attempt after a newer turn becomes active', async () => {
  const sess = freshSession();
  const first = beginRunAttempt(sess, { runId: 'turn-a' });
  const firstInput = recordRunAttemptUserInput(first, {
    turn: 1, role: 'user', data: { text: 'first turn' },
  });
  const second = beginRunAttempt(sess, { runId: 'turn-b' });
  const secondInput = recordRunAttemptUserInput(second, {
    turn: 2, role: 'user', data: { text: 'second turn' },
  });
  requestKill(sess, 'stop only A', first);

  assert.equal(killGateVerdict(sess, { sourceUserSeq: firstInput.seq })?.behavior, 'deny');
  assert.equal(killGateVerdict(sess, { sourceUserSeq: secondInput.seq }), null);
  assert.equal(await composeKillAwareShouldCancel(
    sess,
    undefined,
    { sourceUserSeq: firstInput.seq },
  )(), true);
  assert.equal(await composeKillAwareShouldCancel(
    sess,
    undefined,
    { sourceUserSeq: secondInput.seq },
  )(), false);
  clearKill(sess, first);
});

// ── grind gate (the incident: 15 ignored advisories) ────────────────────────

test('grindGateVerdict: a mutating tool ground across DISTINCT args HALTS at the threshold (never 15 ignored advisories)', () => {
  process.env.CLEMMY_GUARDRAIL_MUT_WARN = '2';
  process.env.CLEMMY_GUARDRAIL_MUT_HALT = '4';
  const sess = freshSession();
  // Production-shaped native MCP sends bypass the local wrapper, so this host
  // gate must classify and stop them directly.
  const tool = 'outlook__send_mail';
  let firstDeny: number | null = null;
  let denyMessage = '';
  for (let i = 1; i <= 12; i++) {
    const v = grindGateVerdict(sess, tool, { to: `firm${i}@example.com`, subject: `Follow-up ${i}`, body: 'Hello' });
    if (v && firstDeny === null) { firstDeny = i; denyMessage = v.message; break; }
  }
  assert.ok(firstDeny !== null && firstDeny <= 5, `the halt must actually deny at the threshold (first deny at ${firstDeny})`);
  assert.match(denyMessage, /run_worker|fan out|batch|program/i, 'the deny steers to the structural alternative');
});

test('grindGateVerdict: benign read/build/test/render shell work never enters the dangerous-write halt', () => {
  process.env.CLEMMY_GUARDRAIL_MUT_HALT = '4';
  const sess = freshSession();
  const commands = [
    'rg TODO src',
    'npm test -- --runInBand',
    'npm run build',
    'npx tsc --noEmit',
    'ffmpeg -i input.mov -vf scale=1280:-2 output.mp4',
    'git status --short',
    'node scripts/render-preview.mjs',
    'ls -la dist',
  ];
  for (const command of commands) {
    assert.equal(grindGateVerdict(sess, 'run_shell_command', { command }), null, command);
  }
});

test('grindGateVerdict: an IDENTICAL-args mutating loop reaches the terminal escalate', () => {
  process.env.CLEMMY_GUARDRAIL_EXACT_BLOCK = '3';
  const sess = freshSession();
  let sawTerminal = false;
  for (let i = 1; i <= 15; i++) {
    const v = grindGateVerdict(sess, 'run_shell_command', { command: 'netlify deploy --prod' });
    if (v?.interrupt) { sawTerminal = true; break; }
  }
  assert.ok(sawTerminal, 'identical mutating repeats end the turn (escalate)');
});

test('grindGateVerdict: a fanout refuse fires only for honorFanout callers, silently allows otherwise', () => {
  const sess = freshSession();
  // Distinct-args read grinding trips the fanout block (entity-gated ≥6 distinct).
  let fanout: ReturnType<typeof grindGateVerdict> = null;
  for (let i = 1; i <= 12; i++) {
    const v = grindGateVerdict(sess, 'dataforseo__serp_organic_live_advanced', { keyword: `firm ${i} san antonio`, url: `https://firm${i}.com` }, { honorFanout: true });
    if (v?.fanout) { fanout = v; break; }
  }
  if (fanout) {
    assert.equal(fanout.interrupt, false, 'fanout steer is a soft deny the model reads');
    assert.match(fanout.message, /REFUSED|one-at-a-time|program/i);
  }
  // A caller WITHOUT run_tool_program (worker/step) gets a silent allow — no
  // deny and no phantom guardrail_tripped event (review wf_2ed83f94 #6).
  const sess2 = freshSession();
  for (let i = 1; i <= 12; i++) {
    const v = grindGateVerdict(sess2, 'dataforseo__serp_organic_live_advanced', { keyword: `firm ${i} austin`, url: `https://tx${i}.com` });
    assert.ok(!v?.fanout, 'un-honored fanout verdicts never surface');
  }
});

test('grindGateVerdict: normal varied usage is untouched', () => {
  const sess = freshSession();
  assert.equal(grindGateVerdict(sess, 'notion__search', { q: 'alpha' }), null);
  assert.equal(grindGateVerdict(sess, 'linear__list_issues', { team: 'eng' }), null);
});

// ── boundary verdict ─────────────────────────────────────────────────────────

test('evaluateTurnBoundary precedence: kill → wall-clock → token budget → max-steps', () => {
  const sess = freshSession();
  const base = { sessionId: sess, startedAt: Date.now(), maxWallMs: 0, stepIndex: 1, maxSteps: 100, tokenWindow: null };
  assert.equal(evaluateTurnBoundary(base).kind, 'continue');

  requestKill(sess, 'x');
  assert.equal(evaluateTurnBoundary(base).kind, 'killed');
  clearKill(sess);

  const wallHit = evaluateTurnBoundary({ ...base, startedAt: Date.now() - 10_000, maxWallMs: 5_000 });
  assert.deepEqual({ kind: wallHit.kind, limit: (wallHit as { limit?: string }).limit }, { kind: 'limit', limit: 'wall_clock' });

  const window = openRunTokenWindow({ sessionId: sess, ceiling: 1_000 });
  accrueSessionTokens(sess, 2_000);
  const both = evaluateTurnBoundary({ ...base, startedAt: Date.now() - 10_000, maxWallMs: 5_000, tokenWindow: window });
  assert.equal((both as { limit?: string }).limit, 'wall_clock', 'wall-clock wins a dual breach (loop precedence)');
  const budgetOnly = evaluateTurnBoundary({ ...base, tokenWindow: window });
  assert.equal((budgetOnly as { limit?: string }).limit, 'token_budget');

  const steps = evaluateTurnBoundary({ ...base, stepIndex: 100 });
  assert.equal((steps as { limit?: string }).limit, 'max_steps');
});

test('legacy objective reader recovers only an exact, immediately-following acknowledgement without writing new preflight rows', () => {
  const sessionId = freshSession('chat');
  const objective = 'Create two separate Google Docs: a client brief and a technical appendix.';
  const request = appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: objective },
  });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'turn_preflight_decision',
    data: {
      phase: 'align',
      objective,
      intentKey: 'legacy-intent',
      sourceUserSeq: request.seq,
    },
  });
  // Synthetic replay notes do not break immediate real-user adjacency.
  appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: '[legacy replay note]', synthetic: true },
  });
  const approval = appendEvent({
    sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Go ahead.' },
  });
  const before = listEvents(sessionId, { types: ['turn_preflight_decision'] }).length;

  // A newer ambient input cannot steal the exact accepted attempt's objective.
  appendEvent({
    sessionId, turn: 3, role: 'user', type: 'user_input_received', data: { text: 'Unrelated newer question.' },
  });
  assert.equal(effectiveTurnObjective(sessionId, 'Go ahead.', approval.seq), objective);
  assert.equal(
    listEvents(sessionId, { types: ['turn_preflight_decision'] }).length,
    before,
    'the compatibility path is read-only',
  );
});

test('legacy objective reader rejects stale, non-acknowledgement, and unbound inputs', () => {
  const sessionId = freshSession('chat');
  const objective = 'Send the approved client update.';
  const request = appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: objective },
  });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'turn_preflight_decision',
    data: { phase: 'align', objective, sourceUserSeq: request.seq },
  });
  appendEvent({
    sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'What time is it?' },
  });
  const staleApproval = appendEvent({
    sessionId, turn: 3, role: 'user', type: 'user_input_received', data: { text: 'yes' },
  });

  assert.equal(effectiveTurnObjective(sessionId, 'yes', staleApproval.seq), 'yes');
  assert.equal(effectiveTurnObjective(sessionId, 'yes'), 'yes', 'an exact accepted source row is required');
  assert.equal(
    effectiveTurnObjective(sessionId, 'go ahead', staleApproval.seq),
    'go ahead',
    'a different control phrase cannot borrow the exact source row',
  );
  assert.equal(effectiveTurnObjective(sessionId, 'different text', staleApproval.seq), 'different text');
});
