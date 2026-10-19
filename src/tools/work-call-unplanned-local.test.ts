/**
 * Run: node scripts/run-tests-isolated.mjs src/tools/work-call-unplanned-local.test.ts
 *
 * Owner 2026-09-04: a plan refusal is SAFETY or SHAPE, and a shape refusal
 * must not stop the turn. A reversible local change the request's frozen plan
 * did not list is shape: it runs on the host's exact per-call local
 * admission. Everything else keeps the plan's refusal.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-unplanned-local-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

const { unplannedLocalChangeMayRun } = await import('./work-call.js');

test('a reversible local change the plan has no step for runs on its exact local admission', () => {
  let asked = 0;
  assert.equal(unplannedLocalChangeMayRun({ effect: 'local_write', refusal: 'work_requirement_unknown',
    exactLocalAdmission: () => { asked += 1; return true; } }), true);
  assert.equal(asked, 1);
});

test('without exact local admission, outside or unknown effects, and every other plan refusal keep the plan', () => {
  let asked = 0;
  const admitted = () => { asked += 1; return true; };
  assert.equal(unplannedLocalChangeMayRun({ effect: 'local_write', refusal: 'work_requirement_unknown',
    exactLocalAdmission: () => false }), false, 'the host\'s per-call local admission still decides');
  for (const effect of ['external_write', 'admin', 'destructive', undefined]) {
    assert.equal(unplannedLocalChangeMayRun({ effect, refusal: 'work_requirement_unknown', exactLocalAdmission: admitted }), false, String(effect));
  }
  for (const refusal of ['work_effect_mismatch', 'work_cardinality_mismatch', 'work_dependency_pending',
    'work_attempt_budget_exhausted', 'work_already_satisfied'] as const) {
    assert.equal(unplannedLocalChangeMayRun({ effect: 'local_write', refusal, exactLocalAdmission: admitted }), false, refusal);
  }
  assert.equal(asked, 0, 'admission is only asked about a change the plan has no step for');
});
