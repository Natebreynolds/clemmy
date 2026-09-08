/**
 * A settled external write is an effect, and completion must be able to see it.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/external-write-evidence.test.ts
 *
 * Live 2026-09-07, source 146393 — the ten-row Google Sheet that genuinely
 * worked. Two mutations settled succeeded: googlesheets_create_google_sheet1
 * and googlesheets_batch_update, 88 cells across A1:H11, independently read
 * back. The completion verdict recorded:
 *
 *   settledEffectCount: 0        judgedArtifacts: []
 *   settledEvidenceAvailable: true          fulfills: true
 *
 * A confident claim that a task which wrote 88 cells produced nothing.
 * `settledSourceArtifacts` enumerated from `outcome_kind='succeeded' AND
 * mutating=1` — durable host-authored facts — and then dropped every row whose
 * tool had no STATIC registry entry. Composio, reviewed-CLI and MCP writes are
 * all dynamic, so external work was invisible to the verifier and a green
 * completion could not distinguish "wrote correctly" from "wrote nothing".
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./host-turn-runner.ts', import.meta.url), 'utf8');
const fn = SRC.slice(
  SRC.indexOf('export function settledSourceArtifacts'),
  SRC.indexOf('export function plannedWriteOperationIds'),
);

test('a non-registry settled mutation is RETAINED, never silently skipped', () => {
  const branch = fn.slice(fn.indexOf("registeredToolSideEffect(settlement.toolName) !== 'write'"));
  const nextContinue = branch.indexOf('continue;');
  const body = branch.slice(0, nextContinue);
  assert.match(body, /collected\.push\(/,
    'the external branch must record the effect before continuing');
});

test('it is discharged of the local-file contract, not marked unresolved', () => {
  const branch = fn.slice(fn.indexOf("registeredToolSideEffect(settlement.toolName) !== 'write'"));
  const body = branch.slice(0, branch.indexOf('continue;'));
  assert.match(body, /evidenceContract: 'none'/,
    "an external write never owed a host-local receipt — its settlement is its evidence");
  assert.doesNotMatch(body, /unresolvedReason/,
    'marking it unresolved would block legitimate provider writes');
});

test('the enumeration still keys on the durable mutation facts', () => {
  assert.match(fn, /outcome_kind = 'succeeded'/);
  assert.match(fn, /s\.mutating = 1/);
});

test('the local-write path keeps its full provenance conjunction', () => {
  // The external branch must not weaken host-local verification.
  for (const guard of [
    'redemption_', 'outcome_not_succeeded', 'execution_site_not_host',
    'tool_name_disagreement', 'not_a_registered_write',
  ]) {
    assert.ok(fn.includes(guard), `local-write guard ${guard} must survive`);
  }
});
