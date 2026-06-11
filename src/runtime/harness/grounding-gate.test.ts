/**
 * Run: npx tsx --test src/runtime/harness/grounding-gate.test.ts
 *
 * Grounding gate — integrity verification at the irreversible-write
 * boundary (the 2026-06-11 Eley incident class: correct extraction,
 * orchestrator re-wrote drafts in a compacted context, wrong city sent;
 * plus the all-17-recipients double-send).
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-grounding-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resetEventLog, createSession, writeToolOutput } = await import('./eventlog.js');
const {
  extractTargetKeys,
  rankSources,
  detectDuplicateTarget,
  markDuplicateWarned,
  buildGroundingPrompt,
  renderPayloadForJudge,
  evaluateGrounding,
  _setGroundingJudgeForTests,
  _resetGroundingStateForTests,
  _resetDuplicateStateForTests,
  GroundingCheckFailedError,
} = await import('./grounding-gate.js');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ─── extractTargetKeys ────────────────────────────────────────────

test('extractTargetKeys: pulls recipient email + org domain from nested composio args', () => {
  const keys = extractTargetKeys({
    tool_slug: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
    arguments: JSON.stringify({ user_id: 'me', to_email: 'cliff@eleylawfirm.com', to_name: 'Clifford E. Eley', subject: 'x', body: 'y' }),
  });
  assert.ok(keys.includes('cliff@eleylawfirm.com'));
  assert.ok(keys.includes('eleylawfirm.com'));
  assert.ok(keys.includes('clifford e. eley'), 'to_name is a target key');
  assert.ok(!keys.includes('me'), 'user_id placeholder is never a target');
});

test('extractTargetKeys: generic mail providers are not org identities', () => {
  const keys = extractTargetKeys({ to_email: 'somebody@gmail.com' });
  assert.ok(keys.includes('somebody@gmail.com'));
  assert.ok(!keys.includes('gmail.com'));
});

test('extractTargetKeys: no identity → empty (gate stays out of the way)', () => {
  assert.deepEqual(extractTargetKeys({ tool_slug: 'X_SEND_THING', arguments: '{"text":"hello"}' }), []);
});

// ─── rankSources ──────────────────────────────────────────────────

test('rankSources: research artifacts outrank send-confirmations and excerpts are clipped', () => {
  const ranked = rankSources([
    { callId: 'c1', tool: 'run_worker', output: 'SUCCESS: sent to cliff, subject "Houston workers comp search"', createdAt: '2026-06-11T22:18:00Z' },
    { callId: 'c2', tool: 'run_worker', output: `Eley Law Firm; verified search term: "workers compensation lawyer Denver"${'x'.repeat(6000)}`, createdAt: '2026-06-11T21:59:00Z' },
  ], { clipChars: 100 });
  assert.equal(ranked[0].callId, 'c2', 'research artifact ranks before the send confirmation');
  assert.ok(ranked[0].excerpt.length < 150, 'excerpt clipped');
});

// ─── prompt assembly ──────────────────────────────────────────────

test('buildGroundingPrompt: includes payload, sources, conflict + confirmation rules', () => {
  const p = buildGroundingPrompt(renderPayloadForJudge('composio_execute_tool', { to: 'a@b.co' }), [
    { callId: 'c2', tool: 'run_worker', excerpt: 'Denver', createdAt: 'now' },
  ]);
  assert.match(p, /a@b\.co/);
  assert.match(p, /Denver/);
  assert.match(p, /NOT evidence its content was correct/, 'send confirmations are not ground truth');
  assert.match(p, /CONTRADICT each other/, 'source-conflict rule present');
});

// ─── evaluateGrounding (fail-open + block paths) ──────────────────

test('evaluateGrounding: Eley-shape contradiction blocks; consistent payload allows; no sources fails open', async () => {
  resetEventLog();
  _resetGroundingStateForTests();
  const sess = createSession({ kind: 'chat' });
  // Seed the CORRECT extraction artifact for the target.
  writeToolOutput({
    sessionId: sess.id,
    callId: 'call_extract_eley',
    tool: 'run_worker',
    output: 'Eley Law Firm; verified search term: "workers compensation lawyer Denver"; contact cliff@eleylawfirm.com',
  });
  const houstonArgs = {
    tool_slug: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
    arguments: JSON.stringify({ to_email: 'cliff@eleylawfirm.com', subject: 'Houston workers comp search', body: 'Houston searches…' }),
  };
  // Stubbed judge mimics the integrity verdict.
  _setGroundingJudgeForTests(async (payload) => payload.includes('Houston')
    ? { grounded: false, reason: 'Payload says Houston; the extraction artifact for this target says Denver.' }
    : { grounded: true, reason: 'Consistent with the Denver extraction.' });
  try {
    const blocked = await evaluateGrounding(sess.id, 'composio_execute_tool', houstonArgs);
    assert.equal(blocked.action, 'block');
    assert.match(blocked.reason, /Denver/);
    assert.equal(blocked.failureCount, 1);
    assert.ok(blocked.sourceCallIds.includes('call_extract_eley'));

    // Second failure for the same target escalates the count (→ ask-user wording).
    const blocked2 = await evaluateGrounding(sess.id, 'composio_execute_tool', houstonArgs);
    assert.equal(blocked2.failureCount, 2);
    const err = new GroundingCheckFailedError({ toolName: 'composio_execute_tool', reason: blocked2.reason, targets: blocked2.targets, sourceCallIds: blocked2.sourceCallIds, failureCount: blocked2.failureCount! });
    assert.match(err.message, /ask_user_question/, 'repeated failure instructs a user check-in');

    const denverArgs = { ...houstonArgs, arguments: JSON.stringify({ to_email: 'cliff@eleylawfirm.com', subject: 'Denver comp search gap', body: 'Denver…' }) };
    const allowed = await evaluateGrounding(sess.id, 'composio_execute_tool', denverArgs);
    assert.equal(allowed.action, 'allow');

    // Unknown target with zero artifacts → fail open, judge never consulted.
    let judged = false;
    _setGroundingJudgeForTests(async () => { judged = true; return { grounded: false, reason: 'x' }; });
    const open = await evaluateGrounding(sess.id, 'composio_execute_tool', {
      tool_slug: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
      arguments: JSON.stringify({ to_email: 'nobody@neverresearched.example' }),
    });
    assert.equal(open.action, 'allow');
    assert.equal(judged, false, 'no sources → no judge call');
  } finally {
    _setGroundingJudgeForTests(null);
  }
});

test('evaluateGrounding: judge infra error fails open', async () => {
  resetEventLog();
  _resetGroundingStateForTests();
  const sess = createSession({ kind: 'chat' });
  writeToolOutput({ sessionId: sess.id, callId: 'c1', tool: 'run_worker', output: 'research about target@firm.com' });
  _setGroundingJudgeForTests(async () => { throw new Error('model down'); });
  try {
    const r = await evaluateGrounding(sess.id, 'composio_execute_tool', { arguments: JSON.stringify({ to_email: 'target@firm.com' }) });
    assert.equal(r.action, 'allow');
    assert.match(r.reason, /fail open/);
  } finally {
    _setGroundingJudgeForTests(null);
  }
});

// ─── duplicate-target speed bump ──────────────────────────────────

test('detectDuplicateTarget: same shape+target trips once, passes after warned (speed bump not wall)', () => {
  _resetDuplicateStateForTests();
  const input = {
    sessionId: 's1',
    shapeKey: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
    targets: ['cliff@eleylawfirm.com'],
    priorWrites: [{ shapeKey: 'OUTLOOK_OUTLOOK_SEND_EMAIL', targets: ['cliff@eleylawfirm.com'] }],
  };
  const first = detectDuplicateTarget(input);
  assert.equal(first.duplicate, true);
  assert.equal(first.target, 'cliff@eleylawfirm.com');
  // After warning, the conscious retry passes.
  markDuplicateWarned(first.warnedKey!);
  assert.equal(detectDuplicateTarget(input).duplicate, false);
});

test('detectDuplicateTarget: different target or shape is not a duplicate', () => {
  _resetDuplicateStateForTests();
  const prior = [{ shapeKey: 'OUTLOOK_OUTLOOK_SEND_EMAIL', targets: ['a@x.com'] }];
  assert.equal(detectDuplicateTarget({ sessionId: 's', shapeKey: 'OUTLOOK_OUTLOOK_SEND_EMAIL', targets: ['b@y.com'], priorWrites: prior }).duplicate, false);
  assert.equal(detectDuplicateTarget({ sessionId: 's', shapeKey: 'GMAIL_SEND_EMAIL', targets: ['a@x.com'], priorWrites: prior }).duplicate, false);
  assert.equal(detectDuplicateTarget({ sessionId: 's', shapeKey: undefined, targets: ['a@x.com'], priorWrites: prior }).duplicate, false);
});
