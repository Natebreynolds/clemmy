/**
 * A native tool's typed negative must not settle as a succeeded mutation.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/local-typed-negative.test.ts
 *
 * Live 2026-09-07, session sess-desktop-fce6c66a55e3ce932d425f0f: after a crash
 * and resume, workflow_create was called again for a name that already existed
 * and returned {ok:false, status:'duplicate'}. Both settlements recorded
 * `outcome=succeeded, mutating=1`, so the ledger showed two writes where one
 * had happened, and the committer told the owner their unchanged file no longer
 * matched its receipt.
 *
 * `hostExecuted` proves the CALL completed. It never proved the OPERATION did.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyAttemptOutcome } from './attempt-outcome.js';
import { nonWriteTextResult, localNonWriteStatus, textResult } from '../../tools/shared.js';

test('an explicit ok:false is not a succeeded write', () => {
  const out = classifyAttemptOutcome({
    hostExecuted: true,
    mutating: true,
    hostReportedFailure: true,
    hostFailureStatus: 'duplicate',
  });
  assert.notEqual(out.kind, 'succeeded');
  assert.equal(out.kind, 'invalid_arguments', 'repairable: the model gets the schema back');
  assert.equal(out.detail, 'host_reported:duplicate');
  assert.equal(out.evidence, 'structured', 'the tool said so in a field, not a sentence');
});

test('it must NOT become uncertain_write — nothing crossed', () => {
  // The host ran the tool in-process and holds the bytes. Calling this
  // uncertain would send the model reconciling an effect that never existed.
  const out = classifyAttemptOutcome({
    hostExecuted: true,
    mutating: true,
    hostReportedFailure: true,
    hostFailureStatus: 'empty',
  });
  assert.notEqual(out.kind, 'uncertain_write');
});

test('ABSENCE of a success flag is still not failure', () => {
  // The deliberate pre-existing rule: a local result that simply carries no
  // success flag stays a success. Only a PRESENT negative changes the reading.
  const out = classifyAttemptOutcome({ hostExecuted: true, mutating: true });
  assert.equal(out.kind, 'succeeded');
  assert.equal(out.detail, 'host_execution');
});

test('an ok:true local result is unaffected', () => {
  const out = classifyAttemptOutcome({ hostExecuted: true, mutating: true, hostReportedFailure: false });
  assert.equal(out.kind, 'succeeded');
});

test('an empty local result keeps its own class', () => {
  const out = classifyAttemptOutcome({ hostExecuted: true, emptyResult: true });
  assert.equal(out.kind, 'empty_result');
});

test('a non-token status never reaches the durable row', () => {
  // Prose in `detail` is how a tool message ends up in durable state.
  const out = classifyAttemptOutcome({
    hostExecuted: true,
    hostReportedFailure: true,
    hostFailureStatus: 'A workflow named "X" already exists — pick another name.',
  });
  assert.equal(out.detail, 'host_reported_failure');
});


/* ------------------------------------------------------------------ *
 * THE COMPLETE PATH. The previous fix recognised only a top-level
 * `ok:false`, a shape the real producers never emit — it passed a
 * hypothetical object and left the actual MCP/flattened returns
 * settling as succeeded mutations.
 * ------------------------------------------------------------------ */

test('PRODUCER: a real non-write result carries its status', () => {
  const result = nonWriteTextResult('duplicate', 'Workflow "X" already exists. Nothing was created.');
  assert.equal(localNonWriteStatus(result), 'duplicate');
  assert.equal(result.isError, true, 'a reshaped carrier still sees a structured failure');
  assert.match(result.content[0]!.text, /already exists/);
});

test('PRODUCER: ordinary text results are untouched', () => {
  assert.equal(localNonWriteStatus(textResult('Created the workflow.')), null);
  assert.equal(localNonWriteStatus({ content: [{ type: 'text', text: 'copied shape' }], isError: true }), null,
    'isError alone is not a non-write claim');
  assert.equal(localNonWriteStatus(null), null);
});

test('A non-token status degrades safely', () => {
  const result = nonWriteTextResult('Workflow "X" already exists!', 'text');
  assert.equal(localNonWriteStatus(result), 'non_write', 'prose never becomes the status token');
});

test('CLASSIFIER: the nominal refusal outranks the generic MCP error flag', () => {
  // isError alone reaches only `unknown` — inert, but with no repair route.
  // The in-process identity is the stronger fact and must win.
  const withFlag = classifyAttemptOutcome({
    hostExecuted: true,
    mutating: true,
    providerReportedError: true,
    hostReportedFailure: true,
    hostFailureStatus: 'duplicate',
  });
  assert.equal(withFlag.kind, 'invalid_arguments');
  assert.equal(withFlag.detail, 'host_reported:duplicate');

  const flagOnly = classifyAttemptOutcome({
    hostExecuted: true, mutating: true, providerReportedError: true,
  });
  assert.equal(flagOnly.kind, 'unknown', 'and a bare error flag still authorizes nothing');
});

test('the typed negative outranks a prose/isError execution-failed inference', () => {
  // Live 2026-09-07 on frozen C32: the duplicate settled `unknown /
  // execution_failed, mutating=1`. The non-write result carries `isError:true`
  // on purpose, and its own message reads like failure prose, so the very
  // signals meant as a safety net were inferring OVER the tool's typed field.
  const out = classifyAttemptOutcome({
    hostExecuted: true,
    mutating: true,
    executionFailed: true,
    providerReportedError: true,
    hostReportedFailure: true,
    hostFailureStatus: 'duplicate',
  });
  assert.equal(out.kind, 'invalid_arguments');
  assert.equal(out.detail, 'host_reported:duplicate');
});


test('a RESERIALIZED copy is NOT no-effect proof', () => {
  // This deliberately reverses an earlier attempt of mine. A serialized
  // `ok:false` marker looks exactly like an ordinary failed write, so reading
  // it back as proof that nothing changed would let a mutation of unknown fate
  // be retried. The bridge carries the outcome in a nominal class instead.
  const original = nonWriteTextResult('duplicate', 'Workflow "X" already exists. Nothing was created.');
  const reshaped = JSON.parse(JSON.stringify(original));
  assert.equal(localNonWriteStatus(original), 'duplicate', 'in-process identity holds');
  assert.equal(localNonWriteStatus(reshaped), null, 'a copy proves nothing about effects');
});

test('THE BRIDGE: a non-write survives local text flattening', async () => {
  // `local-runtime-tools` flattens every local result to text before the
  // settlement ever sees it, so neither the WeakMap identity nor
  // structuredContent reached the classifier. Live 2026-09-07 the duplicate
  // create settled `unknown / execution_failed, mutating=1` three builds
  // running while both earlier markers were in place.
  const { HostLocalNonWriteResult, HostLocalExecutionFailureResult, unwrapHostLocalExecutionFailureResult } =
    await import('./attempt-settlement.js');

  const carried = new HostLocalNonWriteResult('Workflow "X" already exists.', 'duplicate');
  assert.equal(carried.status, 'duplicate');
  assert.equal(String(carried), 'Workflow "X" already exists.');
  assert.deepEqual(carried.toJSON(), {
    ok: false, status: 'duplicate', error: 'Workflow "X" already exists.',
  });

  // The model still reads plain text at the tool boundary.
  assert.equal(unwrapHostLocalExecutionFailureResult(carried), 'Workflow "X" already exists.');

  // And it is NOT the failure carrier: a non-write is not an execution failure.
  assert.ok(!(carried instanceof HostLocalExecutionFailureResult));
});

/* ------------------------------------------------------------------ *
 * UNCERTAINTY MUST SURVIVE. A failed write may already have changed
 * something; only trusted no-effect evidence permits a safe retry.
 * ------------------------------------------------------------------ */

test('a generic ok:false is NOT no-effect proof', () => {
  // Exactly what an ordinary failed write looks like. Accepting it as proof
  // was the regression: repair_arguments / retrySameCandidate on a mutation
  // whose fate nobody established.
  assert.equal(localNonWriteStatus({ ok: false, status: 'duplicate' }), null);
  assert.equal(localNonWriteStatus({ structuredContent: { ok: false, status: 'duplicate' } }), null);
  assert.equal(localNonWriteStatus({ ok: false, error: 'write failed halfway' }), null);
});

test('an UNCERTAIN write keeps its directive', () => {
  const uncertain = classifyAttemptOutcome({ mutating: true, acknowledged: false });
  assert.equal(uncertain.kind, 'uncertain_write');
  assert.equal(uncertain.directive.requiresReconciliation, true,
    'reconcile the same effect identity before another mutation');
  assert.equal(uncertain.directive.retrySameCandidate, false);
});

test('the repairable non-write directive is only for a KNOWN non-write', () => {
  const known = classifyAttemptOutcome({
    hostExecuted: true, mutating: true,
    hostReportedFailure: true, hostFailureStatus: 'duplicate',
  });
  assert.equal(known.kind, 'invalid_arguments');
  assert.equal(known.directive.retrySameCandidate, true);
  assert.equal(known.directive.requiresReconciliation, false,
    'safe only because the tool returned before attempting any write');
});
