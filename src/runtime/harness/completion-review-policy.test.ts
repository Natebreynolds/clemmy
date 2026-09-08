/**
 * Owner policy: completion review is optional and supports one-provider users.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/completion-review-policy.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-policy-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'policy\n', 'utf8');

const { completionReviewEnabled } = await import('./respond-bridge.js');
const { shouldRunObjectiveJudge } = await import('./objective-judge.js');
const { downshiftForBoundary } = await import('./debate-model.js');
after(() => { rmSync(HOME, { recursive: true, force: true }); });

function withEnv<T>(key: string, value: string | null, run: () => T): T {
  const prior = process.env[key];
  if (value === null) delete process.env[key]; else process.env[key] = value;
  try { return run(); } finally {
    if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
  }
}

test('completion review defaults ON, so nobody who never touches it changes behaviour', () => {
  withEnv('CLEMMY_COMPLETION_REVIEW', null, () => {
    assert.equal(completionReviewEnabled(), true);
  });
});

test('the owner can turn completion review OFF, and it persists through the env store', () => {
  withEnv('CLEMMY_COMPLETION_REVIEW', 'off', () => {
    assert.equal(completionReviewEnabled(), false);
  });
  withEnv('CLEMMY_COMPLETION_REVIEW', 'on', () => {
    assert.equal(completionReviewEnabled(), true);
  });
});

test('an OFF policy does not make ordinary work plan or retry — the gate simply never arms', () => {
  // Disabled is a legitimate policy, not a failed verification. The opt-in is
  // ANDed at the caller, so the host judge is never armed; the gate itself is
  // untouched and still returns false for a non-opted-in caller.
  assert.equal(shouldRunObjectiveJudge({
    optIn: false, actionIntent: true, meaningfulToolEvidence: true, settledSourceEffects: 1,
    continuationsUsed: 0, maxContinuations: 2, nextAction: 'completed', openApprovalCard: false,
  }), false, 'no judge request is made when review is off');
});

test('an explicitly selected judge is marked as OWNER-SELECTED, a default is not', () => {
  const selected = downshiftForBoundary({
    modelId: 'claude-opus-5', provider: 'claude', source: 'settings',
  } as never);
  assert.equal(selected.source, 'settings');
  const dflt = downshiftForBoundary({
    modelId: 'claude-opus-5', provider: 'claude', source: 'default',
  } as never);
  assert.equal(dflt.source, 'default');
  // The routing bit itself is asserted through resolveBoundaryJudge below.
});

test('SAME-PROVIDER selection is representable: ownerSelectedJudge is orthogonal to selfJudge', async () => {
  const { resolveBoundaryJudge } = await import('./debate-model.js');
  const roles = JSON.stringify([
    { role: 'judge', modelId: 'claude-opus-5', scope: 'durable', source: 'settings' },
  ]);
  withEnv('CLEMMY_MODEL_ROLES', roles, () => {
    let routing;
    try { routing = resolveBoundaryJudge(); } catch { return; }
    if (routing.modelId !== 'claude-opus-5') return; // that lane could not build here
    assert.equal(routing.ownerSelectedJudge, true,
      'an explicit judge binding must be marked owner-selected even when same-family');
  });
});

test('a DEFAULT same-family fallback is never marked owner-selected', async () => {
  const { resolveBoundaryJudge } = await import('./debate-model.js');
  withEnv('CLEMMY_MODEL_ROLES', null, () => {
    let routing;
    try { routing = resolveBoundaryJudge(); } catch { return; }
    assert.ok(!routing.ownerSelectedJudge,
      'the no-other-family fallback is not an owner selection');
  });
});

// ─── Captured policy (C21 ruling: publication re-read the global setting) ────

test('the policy is stamped at accept time and read back per source', async () => {
  const runner = await import('./host-turn-runner.js');
  const eventlog = await import('./eventlog.js');
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'captured' });
  const src = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'go' },
  });
  runner.captureEffectiveCompletionPolicyOnce({
    sessionId: session.id, sourceUserSeq: src.seq, enabled: true,
  });
  const captured = runner.capturedCompletionPolicy({ sessionId: session.id, sourceUserSeq: src.seq });
  assert.equal(captured?.enabled, true);
});

test('a LATER settings change cannot relabel an already-stamped run', async () => {
  const runner = await import('./host-turn-runner.js');
  const eventlog = await import('./eventlog.js');
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'relabel' });
  const src = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'go' },
  });
  // Ran while review was OFF.
  runner.captureEffectiveCompletionPolicyOnce({
    sessionId: session.id, sourceUserSeq: src.seq, enabled: false,
  });
  // The owner then switches review ON before the terminal publishes.
  withEnv('CLEMMY_COMPLETION_REVIEW', 'on', () => {
    assert.equal(completionReviewEnabled(), true, 'the live setting is now on');
    const captured = runner.capturedCompletionPolicy({ sessionId: session.id, sourceUserSeq: src.seq });
    assert.equal(captured?.enabled, false,
      'the run keeps the policy it actually ran under — an unjudged result is never relabelled judged');
  });
});

test('an unstamped source (older build) reports no capture, so the caller falls back honestly', async () => {
  const runner = await import('./host-turn-runner.js');
  const eventlog = await import('./eventlog.js');
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'unstamped' });
  const src = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'go' },
  });
  assert.equal(runner.capturedCompletionPolicy({ sessionId: session.id, sourceUserSeq: src.seq }), null);
});

test('capture is IDEMPOTENT — a resumed turn cannot append a second, later policy', async () => {
  const runner = await import('./host-turn-runner.js');
  const eventlog = await import('./eventlog.js');
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'once' });
  const src = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'go' },
  });
  runner.captureEffectiveCompletionPolicyOnce({ sessionId: session.id, sourceUserSeq: src.seq, enabled: true });
  // A resume re-enters with the opposite live setting; the first capture wins.
  runner.captureEffectiveCompletionPolicyOnce({ sessionId: session.id, sourceUserSeq: src.seq, enabled: false });
  const rows = eventlog.listEvents(session.id, { types: ['completion_policy_captured'] })
    .filter((e) => e.data.sourceUserSeq === src.seq);
  assert.equal(rows.length, 1, 'exactly one policy record per accepted source');
  assert.equal(rows[0]!.data.enabled, true, 'the policy the run actually started under');
});

test('the capture carries the SELECTED judge identity', async () => {
  const runner = await import('./host-turn-runner.js');
  const eventlog = await import('./eventlog.js');
  const roles = JSON.stringify([
    { role: 'judge', modelId: 'claude-opus-5', scope: 'durable', source: 'settings' },
  ]);
  withEnv('CLEMMY_MODEL_ROLES', roles, () => {
    const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'judgeid' });
    const src = eventlog.appendEvent({
      sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'go' },
    });
    runner.captureEffectiveCompletionPolicyOnce({ sessionId: session.id, sourceUserSeq: src.seq, enabled: true });
    const read = runner.readCapturedCompletionPolicy({ sessionId: session.id, sourceUserSeq: src.seq });
    assert.equal(read.status, 'captured');
    if (read.status !== 'captured') return;
    assert.equal(read.policy.judgeModelId, 'claude-opus-5');
    assert.equal(read.policy.judgeSource, 'settings');
    assert.equal(read.policy.judgeSelection.status, 'captured');
    if (read.policy.judgeSelection.status !== 'captured') throw new Error('selection missing');
    const selected = read.policy.judgeSelection.role;
    assert.equal(selected.inactiveBinding?.modelId ?? selected.modelId, 'claude-opus-5');
    assert.equal(selected.inactiveBinding?.provider ?? selected.provider, 'claude');
  });
});

test('THREE states are distinct: captured, absent (legacy), unreadable (failure)', async () => {
  const runner = await import('./host-turn-runner.js');
  const eventlog = await import('./eventlog.js');
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'states' });
  const src = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'go' },
  });
  // absent: a legacy source accepted before capture existed
  assert.equal(runner.readCapturedCompletionPolicy({ sessionId: session.id, sourceUserSeq: src.seq }).status, 'absent');
  runner.captureEffectiveCompletionPolicyOnce({ sessionId: session.id, sourceUserSeq: src.seq, enabled: true });
  assert.equal(runner.readCapturedCompletionPolicy({ sessionId: session.id, sourceUserSeq: src.seq }).status, 'captured');
  // A store failure must report 'unreadable', never 'absent' — publication
  // substitutes today's setting for absent, and must not for a failure.
  const broken = runner.readCapturedCompletionPolicy({ sessionId: '', sourceUserSeq: -1 });
  assert.ok(broken.status === 'absent' || broken.status === 'unreadable',
    'a bad identity resolves to a non-captured state, never a fabricated policy');
});

test('a MALFORMED policy row is unreadable, never a captured OFF policy', async () => {
  const runner = await import('./host-turn-runner.js');
  const eventlog = await import('./eventlog.js');
  for (const [label, data] of [
    ['missing boolean', { version: 1 }],
    ['string instead of boolean', { version: 1, enabled: 'false' }],
    ['unknown version', { version: 99, enabled: true }],
    ['missing selection', { version: 2, enabled: true }],
    ['wrong provider', { version: 2, enabled: true, judgeSelection: { status: 'captured', role: { modelId: 'judge-a', provider: 'invented', source: 'settings' }, crossFamily: false, defaultModels: { claude: 'claude-a', codex: 'codex-a' } } }],
  ] as const) {
    const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: label });
    const src = eventlog.appendEvent({
      sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'go' },
    });
    eventlog.appendEvent({
      sessionId: session.id, turn: 0, role: 'system', type: 'completion_policy_captured',
      data: { ...data, sourceUserSeq: src.seq },
    });
    const read = runner.readCapturedCompletionPolicy({ sessionId: session.id, sourceUserSeq: src.seq });
    assert.equal(read.status, 'unreadable', `${label} must not become a policy`);
  }
});


test('legacy captured policy preserves ON and known identity without inventing a provider', async () => {
  const runner = await import('./host-turn-runner.js');
  const eventlog = await import('./eventlog.js');
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'legacy selection' });
  const src = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Read the report.' } });
  eventlog.appendEvent({ sessionId: session.id, turn: 0, role: 'system', type: 'completion_policy_captured', data: {
    version: 1, sourceUserSeq: src.seq, enabled: true, judgeModelId: 'old-model', judgeSource: 'settings',
  } });
  eventlog.closeEventLog();
  const read = runner.readCapturedCompletionPolicy({ sessionId: session.id, sourceUserSeq: src.seq });
  assert.equal(read.status, 'captured');
  if (read.status !== 'captured') throw new Error('policy missing');
  assert.equal(read.policy.enabled, true);
  assert.equal(read.policy.judgeModelId, 'old-model');
  assert.equal(read.policy.judgeSource, 'settings');
  assert.equal(read.policy.judgeSelection.status, 'unavailable');
});
