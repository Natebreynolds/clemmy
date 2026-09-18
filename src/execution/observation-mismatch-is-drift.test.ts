/**
 * A PUBLISH-TIME MISMATCH IS DRIFT, NOT A MISSING CAPABILITY.
 *
 * `prepareWorkflowStepExternalCatalog` compares the live provider definition
 * against the stored manifest TWICE, across different field sets:
 *
 *   - revalidation, whose drift codes cover input schema, output schema,
 *     fingerprint, operation version and semantic contract;
 *   - `publishRevalidatedObservation`, which checks those AND `invokePortId`
 *     AND `accountIdentity`.
 *
 * Only the first had a repair path. When `invokePortId` or `accountIdentity`
 * moved, revalidation returned ok, publish disagreed, and the step took a
 * terminal `selected_definition_observation_refused` — surfaced to the user as
 * "either the toolkit is not connected or the operation name is wrong", and
 * collapsed in the daemon log to `reason: not-connected`.
 *
 * Live: `daily-standup-email` blocked every morning from 2026-09-16 on
 * OUTLOOK_LIST_EVENTS while Outlook had three ACTIVE connections, the operation
 * was the first result from the live toolkit, and its pinned connection id was
 * still valid. It has successCount 17 — it worked until the provider moved
 * underneath it, then parked forever rather than re-observing.
 *
 * This is the 2026-09-02 Apify/Facebook-trends failure recorded in the source,
 * one comparison later. The successor path already exists; it simply was not
 * reachable from the publish comparison.
 *
 * Run: node scripts/run-tests-isolated.mjs src/execution/observation-mismatch-is-drift.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-observation-drift-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-observation-drift\n', 'utf8');

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { prepareWorkflowStepExternalCatalog } = await import('./workflow-step-external-catalog.js');

/** Reads the source to prove the publish comparison can reach the successor
 *  path. The full provisioning round-trip needs a live Composio broker; what is
 *  pinned here is the CONTROL FLOW that was missing, plus the guards that keep
 *  it from becoming a loop. */
const SRC = path.join(process.cwd(), 'src/execution/workflow-step-external-catalog.ts');
const { readFileSync } = await import('node:fs');
const src = readFileSync(SRC, 'utf8');

test.after(() => { rmSync(TMP_HOME, { recursive: true, force: true }); });

test('a failed publish routes into exact provisioning instead of refusing', () => {
  const idx = src.indexOf('const unpublished = selected');
  assert.ok(idx > 0, 'the publish comparison collects its mismatches');
  const after = src.slice(idx, idx + 2600);
  assert.match(
    after,
    /provisionExactOperations \?\? provisionExactWorkflowProviderOperations/,
    'THE REGRESSION: a publish mismatch returned terminally with no successor path',
  );
  assert.match(after, /observation_mismatch_rebind/,
    'a provisioning failure on this path is labelled as its own cause');
});

test('it re-provisions at most once, never in a loop', () => {
  const idx = src.indexOf('const unpublished = selected');
  const after = src.slice(idx, idx + 2600);
  assert.match(after, /!reboundOperationIds\.includes\(operationId\)/,
    'an operation already re-provisioned this call is not re-provisioned again');
  assert.match(after, /retryable\.length === 0 \|\| !input\.acceptedSource/,
    'with nothing retryable, or no accepted source, the refusal stands');
});

test('the second pass still has to prove itself', () => {
  const idx = src.indexOf('const secondPass = await revalidate');
  assert.ok(idx > 0, 'the successor is revalidated, not assumed');
  const after = src.slice(idx, idx + 1200);
  assert.match(after, /selected_definition_revalidation_refused/,
    'a successor that fails revalidation is refused');
  assert.match(after, /selected_definition_observation_refused/,
    'and a successor that still mismatches on publish is refused');
});

test('an operation no registry carries still refuses without provisioning', async () => {
  // The repair path must not make an unknown operation look provisionable.
  const prepared = await prepareWorkflowStepExternalCatalog({
    immutablePrompt: 'Do the authored work.',
    allowedTools: ['totally_unknown_local_thing'],
  });
  assert.equal(prepared.status, 'none', 'nothing named, nothing provisioned');
});

test('the refusal names the field that moved', () => {
  // The comparison knew which of eight fields disagreed and threw it away, so a
  // live block could only say "not connected or the name is wrong" — both of
  // which were false for daily-standup-email. A comparison that knows why must
  // say why, or the next diagnosis is guesswork again.
  assert.match(src, /function publishRevalidatedObservation\([\s\S]{0,200}\): string \| null/,
    'the comparison returns a reason, not a bare boolean');
  for (const field of ['account_identity', 'invoke_port_id', 'operation_version', 'definition_fingerprint', 'input_schema_digest', 'output_schema_digest']) {
    assert.match(src, new RegExp(`'${field}'`), `${field} is nameable in a refusal`);
  }
  assert.match(src, /detail: unpublished\[0\]!\.mismatch/, 'and the first mismatch reaches the refusal detail');
  assert.match(src, /after_rebind:\$\{mismatch\}/, 'a post-rebind mismatch is labelled as such');
});
