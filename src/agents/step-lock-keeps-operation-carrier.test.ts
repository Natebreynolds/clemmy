/**
 * NAMING WHAT YOU WANT MUST NEVER REMOVE WHAT PERFORMS IT.
 *
 * A step's `allowedTools` lock prunes its tool surface to the named set plus
 * the structural baseline plus the carrier for any provider OPERATION named.
 * "Is this an operation?" was answered by SHAPE — UPPER_SNAKE — which is true
 * of composio slugs and of nothing else. A reviewed CLI read is lower_snake,
 * so `salesforce_sf_soql_query` read as an ordinary tool NAME: no carrier was
 * kept, and no tool object of that name exists to keep either.
 *
 * Live 2026-09-18: friday-sales-leadership-email's Salesforce step reached the
 * model with toolCount: 0. It called workflow_step_result to report the CLI
 * "unavailable in this execution context" while `sf` was authenticated and
 * `sf org list --json` exited 0. It was advertised nothing to call.
 *
 * This is the 2026-09-11 inbox-triage failure one carrier over: that one kept
 * the composio gateway for UPPER_SNAKE slugs and left every other carrier
 * holding a name it could not reach.
 *
 * Run: node scripts/run-tests-isolated.mjs src/agents/step-lock-keeps-operation-carrier.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-step-lock-carrier-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-step-lock-carrier\n', 'utf8');

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { makeStepToolAllow, lockToolsForStep } = await import('./workflow-step-agent.js');

/** The exact operation the owner's Friday workflow cites. */
const CLI_READ = 'salesforce_sf_soql_query';

/** A realistic step surface: the acquisition kernel and the composio gateway
 *  exist as tool objects; the cited OPERATION never does — that is the point. */
const SURFACE = [
  { name: 'tool_search' },
  { name: 'call_tool' },
  { name: 'composio_execute_tool' },
  { name: 'composio_status' },
  { name: 'workflow_step_result' },
  { name: 'read_file' },
  { name: 'some_unrelated_tool' },
];

test.after(() => { rmSync(TMP_HOME, { recursive: true, force: true }); });

test('a lock naming a reviewed-CLI operation keeps a way to reach it', () => {
  const kept = lockToolsForStep(SURFACE, [CLI_READ]).map((t) => t.name);
  assert.ok(
    kept.includes('tool_search') && kept.includes('call_tool'),
    `THE REGRESSION: the step kept ${JSON.stringify(kept)} — a name and no carrier, so toolCount collapsed to the baseline`,
  );
  assert.ok(kept.includes('workflow_step_result'), 'the structural baseline survives');
  assert.ok(!kept.includes('some_unrelated_tool'), 'the lock still prunes what was not named');
});

test('an UPPER_SNAKE provider slug still keeps the composio gateway', () => {
  const kept = lockToolsForStep(SURFACE, ['OUTLOOK_OUTLOOK_SEND_EMAIL']).map((t) => t.name);
  assert.ok(kept.includes('composio_execute_tool'), 'the 2026-09-11 fix still holds');
  assert.ok(kept.includes('composio_status'));
});

test('the acquisition kernel rides along for ANY named operation, whatever its carrier', () => {
  for (const operation of [CLI_READ, 'OUTLOOK_OUTLOOK_SEND_EMAIL']) {
    const allow = makeStepToolAllow([operation]);
    assert.equal(allow('tool_search'), true, `${operation}: acquisition must be reachable`);
    assert.equal(allow('call_tool'), true, `${operation}: the call path must be reachable`);
  }
});

test('a lock naming only ordinary tools grants no carrier', () => {
  // The carrier set is earned by naming an operation — it is not a blanket
  // widening of every locked step.
  const allow = makeStepToolAllow(['read_file']);
  assert.equal(allow('read_file'), true);
  assert.equal(allow('tool_search'), false, 'a plain tool lock stays exactly as tight as it was');
  assert.equal(allow('composio_execute_tool'), false);
});

test('an unlocked surface is untouched', () => {
  assert.deepEqual(
    lockToolsForStep(SURFACE, ['*']).map((t) => t.name),
    SURFACE.map((t) => t.name),
    'a wildcard is not a lock',
  );
  assert.deepEqual(lockToolsForStep(SURFACE, []).map((t) => t.name), SURFACE.map((t) => t.name));
});
