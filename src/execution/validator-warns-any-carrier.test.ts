/**
 * STEP 2, site 4 of docs/SPELLING-IS-NOT-IDENTITY-PLAN-2026-09-18.md.
 *
 * The workflow validator warns when a `call.tool` cannot be verified against
 * the tool catalog — "a wrong slug fails on first fire". That warning was gated
 * on the name being composio-SHAPED.
 *
 * So a step calling a lower_snake operation with a wrong id — every reviewed
 * CLI read — got no warning at all, and found out at dispatch. The validator
 * was silent about exactly the family it could not recognise.
 *
 * Identity widens the warning to any declared operation, and keeps the advice
 * carrier-correct: `composio_search_tools` is right for a provider slug and
 * wrong for a local binary.
 *
 * NOT changed here, deliberately: the autonomous-send eligibility check at
 * `workflow-validator.ts:941` also shape-tests, but it is a conservative FLOOR
 * — failing it refuses autonomy rather than granting it. Making that one
 * identity-based would widen which send tools may fire unattended, which is a
 * safety decision and not part of this wave.
 *
 * Run: node scripts/run-tests-isolated.mjs src/execution/validator-warns-any-carrier.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-validator-any-carrier-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-validator-any-carrier\n', 'utf8');

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { checkCallNode } = await import('./workflow-validator.js');

const CLI_READ = 'salesforce_sf_soql_query';

const check = (tool: string) => checkCallNode(
  { id: 'pull_pipeline', call: { tool, args: {} } } as never,
  undefined,
);

test.after(() => { rmSync(TMP_HOME, { recursive: true, force: true }); });

test('an unverifiable reviewed-CLI operation is warned about', () => {
  const { warnings } = check(CLI_READ);
  assert.equal(
    warnings.length,
    1,
    'THE REGRESSION: a lower_snake operation got no warning, so a wrong id surfaced at dispatch',
  );
  assert.match(warnings[0]!, /tool_search/, 'the advice names the right discovery surface for a local carrier');
  assert.doesNotMatch(warnings[0]!, /composio_search_tools/, 'never send a local binary to the composio catalog');
});

test('an unverifiable composio slug keeps its original advice', () => {
  const { warnings } = check('OUTLOOK_OUTLOOK_SEND_EMAIL');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /composio_search_tools/, 'a provider slug is confirmed through the provider catalog');
});

test('a name that identifies no operation is not warned about as one', () => {
  // The hard error for prose already covers nonsense; a bare unknown token is
  // not an operation and must not acquire an operation-shaped warning.
  const { warnings, errors } = check('totally_unknown_local_thing');
  assert.deepEqual(errors, [], 'a single identifier token is still not a hard error');
  assert.deepEqual(warnings, [], 'and identity does not manufacture a catalog warning for it');
});

test('prose is still a hard error, not a warning', () => {
  const { errors } = check('please send the email to the team');
  assert.equal(errors.length, 1, 'sentence-shaped hallucinations still fail validation outright');
});
