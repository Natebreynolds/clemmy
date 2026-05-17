/**
 * Run: npx tsx --test src/agents/verifier.test.ts
 *
 * Contracts the deterministic verifier dispatcher must keep, one test
 * per kind:
 *   file_exists      — pass for present file, fail for missing
 *   file_contains    — pass when substring present, fail when absent
 *   shell_exit_zero  — pass for `true`, fail for `false`
 *   tool_returns     — reads tool_returned events from the log
 *   event_emitted    — reads the named event type from the log
 *   user_confirms    — reads approval_resolved / user_input_received
 *
 * Each result carries a humanly-readable evidence string that the
 * loop can drop into the step_verified event payload as-is.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-verifier-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Dynamic imports — BASE_DIR is read at module load.
const { resetEventLog, createSession, appendEvent } = await import(
  '../runtime/harness/eventlog.js'
);
const { runVerifier } = await import('./verifier.js');

test.after(() => {
  try {
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

test('file_exists: pass when the file is on disk', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  const target = path.join(TMP_HOME, 'present.txt');
  writeFileSync(target, 'hello');
  const result = await runVerifier(
    { kind: 'file_exists', spec: target },
    { sessionId: sess.id },
  );
  assert.equal(result.passed, true);
  assert.equal(result.kind, 'file_exists');
  assert.ok(result.evidence.includes('exists'));
});

test('file_exists: fail when the file is missing', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  const result = await runVerifier(
    { kind: 'file_exists', spec: path.join(TMP_HOME, 'nope.txt') },
    { sessionId: sess.id },
  );
  assert.equal(result.passed, false);
  assert.ok(result.evidence.includes('does not exist'));
});

test('file_contains: pass when the substring is present', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  const target = path.join(TMP_HOME, 'has-token.txt');
  writeFileSync(target, 'line one\nthe magic string is here\nline three');
  const result = await runVerifier(
    { kind: 'file_contains', spec: target, expected: 'magic string' },
    { sessionId: sess.id },
  );
  assert.equal(result.passed, true);
  assert.ok(result.evidence.includes('contains'));
});

test('file_contains: fail when the substring is absent', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  const target = path.join(TMP_HOME, 'no-token.txt');
  writeFileSync(target, 'nothing useful here');
  const result = await runVerifier(
    { kind: 'file_contains', spec: target, expected: 'absent' },
    { sessionId: sess.id },
  );
  assert.equal(result.passed, false);
  assert.ok(result.evidence.includes('does NOT contain'));
});

test('file_contains: fail when the file does not exist', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  const result = await runVerifier(
    { kind: 'file_contains', spec: path.join(TMP_HOME, 'ghost.txt'), expected: 'x' },
    { sessionId: sess.id },
  );
  assert.equal(result.passed, false);
  assert.ok(result.evidence.includes('does not exist'));
});

test('shell_exit_zero: pass for `true`', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  const result = await runVerifier(
    { kind: 'shell_exit_zero', spec: 'true' },
    { sessionId: sess.id, shellTimeoutMs: 5_000 },
  );
  assert.equal(result.passed, true);
  assert.ok(result.evidence.includes('exited 0'));
});

test('shell_exit_zero: fail for `false`', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  const result = await runVerifier(
    { kind: 'shell_exit_zero', spec: 'false' },
    { sessionId: sess.id, shellTimeoutMs: 5_000 },
  );
  assert.equal(result.passed, false);
  assert.ok(result.evidence.includes('exited'));
});

test('shell_exit_zero: captures stdout for evidence', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  const result = await runVerifier(
    { kind: 'shell_exit_zero', spec: 'echo verified-output-marker' },
    { sessionId: sess.id, shellTimeoutMs: 5_000 },
  );
  assert.equal(result.passed, true);
  assert.ok(result.evidence.includes('verified-output-marker'));
});

test('tool_returns: pass when matching tool_returned in the log', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'executor',
    type: 'tool_returned',
    data: { tool: 'write_file', result: 'wrote 200 bytes' },
  });
  const result = await runVerifier(
    { kind: 'tool_returns', spec: 'write_file' },
    { sessionId: sess.id },
  );
  assert.equal(result.passed, true);
  assert.ok(result.evidence.includes('wrote 200 bytes'));
});

test('tool_returns: fail when the tool was not called', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  const result = await runVerifier(
    { kind: 'tool_returns', spec: 'write_file' },
    { sessionId: sess.id },
  );
  assert.equal(result.passed, false);
  assert.ok(result.evidence.includes('never called'));
});

test('tool_returns: respects `expected` substring on the result', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'executor',
    type: 'tool_returned',
    data: { tool: 'http_request', result: '{"status":200,"body":"hello"}' },
  });
  const pass = await runVerifier(
    { kind: 'tool_returns', spec: 'http_request', expected: '"status":200' },
    { sessionId: sess.id },
  );
  assert.equal(pass.passed, true);
  const fail = await runVerifier(
    { kind: 'tool_returns', spec: 'http_request', expected: '"status":500' },
    { sessionId: sess.id },
  );
  assert.equal(fail.passed, false);
});

test('event_emitted: pass when the event type is in the log', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'orchestrator',
    type: 'plan_approved',
    data: {},
  });
  const result = await runVerifier(
    { kind: 'event_emitted', spec: 'plan_approved' },
    { sessionId: sess.id },
  );
  assert.equal(result.passed, true);
  assert.ok(result.evidence.includes('1 plan_approved'));
});

test('event_emitted: fail when the event type is absent', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  const result = await runVerifier(
    { kind: 'event_emitted', spec: 'plan_approved' },
    { sessionId: sess.id },
  );
  assert.equal(result.passed, false);
  assert.ok(result.evidence.includes('no plan_approved'));
});

test('event_emitted: fail with a clear message for unknown event types', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  const result = await runVerifier(
    { kind: 'event_emitted', spec: 'totally_made_up_event' },
    { sessionId: sess.id },
  );
  assert.equal(result.passed, false);
  assert.ok(result.evidence.includes('unknown event type'));
});

test('user_confirms: pass when approval_resolved.approved=true', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'system',
    type: 'approval_resolved',
    data: { approved: true, subject: 'deploy to staging' },
  });
  const result = await runVerifier(
    { kind: 'user_confirms', spec: 'deploy to staging' },
    { sessionId: sess.id },
  );
  assert.equal(result.passed, true);
  assert.ok(result.evidence.includes('approval_resolved'));
});

test('user_confirms: fail when approval_resolved.approved=false', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'system',
    type: 'approval_resolved',
    data: { approved: false, subject: 'deploy to staging' },
  });
  const result = await runVerifier(
    { kind: 'user_confirms', spec: 'deploy to staging' },
    { sessionId: sess.id },
  );
  assert.equal(result.passed, false);
});

test('user_confirms: pass via user_input_received text match', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Yes, go ahead and ship it.' },
  });
  const result = await runVerifier(
    { kind: 'user_confirms', spec: 'ship_confirmation', expected: 'go ahead' },
    { sessionId: sess.id },
  );
  assert.equal(result.passed, true);
  assert.ok(result.evidence.includes('user_input_received'));
});

test('user_confirms: fail when nothing matches', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  const result = await runVerifier(
    { kind: 'user_confirms', spec: 'subject', expected: 'go ahead' },
    { sessionId: sess.id },
  );
  assert.equal(result.passed, false);
});
