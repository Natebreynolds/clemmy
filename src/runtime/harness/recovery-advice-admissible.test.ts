/**
 * Recovery may never name a tool the turn cannot call.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/recovery-advice-admissible.test.ts
 *
 * Three live contradictions, three different doors, one shared cause — the stop
 * text named `recoveryToolNames` verbatim:
 *   146042  Plan refused check_in, then recovery recommended check_in
 *   146537  file_query failed 11x on arguments, then recovery recommended file_query
 *   147007  composio_execute_tool refused ABSENT (catalog candidates=0),
 *           then recovery recommended composio_execute_tool
 * Each had been patched at its own door. This pins the door they share.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostNoProgressBlockedText } from './host-turn-runner.js';
import { createNoProgressConsequence, initializeNoProgressGovernor } from './no-progress-governor.js';

function stateNaming(tools: string[], recovery: 'repair_model' = 'repair_model') {
  const base = initializeNoProgressGovernor({
    taskKey: 'task-advice',
    authority: { operation: [], account: [], target: [], evidence: [], effect: [] },
  });
  return {
    ...base,
    lastConsequence: createNoProgressConsequence({
      stage: 'execution:test',
      recovery,
      effectState: 'not_started',
      recoveryToolNames: tools,
    }),
  };
}

test('THE 147007 CASE: an unavailable tool is not recommended', () => {
  const text = hostNoProgressBlockedText(
    stateNaming(['composio_execute_tool']),
    'host_disposition:refused_pre_dispatch',
    new Set<string>(),   // nothing admissible — the catalog had zero candidates
  );
  assert.doesNotMatch(text, /Use composio_execute_tool/,
    'never name the tool that was just refused as absent');
  assert.match(text, /available discovery or read tools/,
    'fall back to an honest generic instruction');
});

test('an ADMISSIBLE tool is still named exactly', () => {
  const text = hostNoProgressBlockedText(
    stateNaming(['salesforce_sf_soql_query']),
    'execution:unknown_read',
    new Set(['salesforce_sf_soql_query']),
  );
  assert.match(text, /Use salesforce_sf_soql_query to resolve this step/);
});

test('a partly-available set names only what remains callable', () => {
  const text = hostNoProgressBlockedText(
    stateNaming(['file_query', 'tool_search']),
    'execution:test',
    new Set(['tool_search']),
  );
  assert.match(text, /Use tool_search to resolve this step/);
  assert.doesNotMatch(text, /file_query/, 'the failing reader is dropped');
});

test('with no admissible set supplied, behaviour is unchanged', () => {
  // Callers that cannot compute the surface must not silently lose their advice.
  const text = hostNoProgressBlockedText(stateNaming(['workflow_get']), 'execution:test');
  assert.match(text, /Use workflow_get to resolve this step/);
});

test('the stop still states where it stopped', () => {
  const text = hostNoProgressBlockedText(stateNaming(['x']), 'execution:unknown_read', new Set<string>());
  assert.match(text, /Stopped at: execution:unknown_read/);
});

test('a no-progress stop says what actually stopped it when the ledger holds a concrete tool error', () => {
  // Live 2026-09-08: the stop read "Stopped at: authority_acquisition" while
  // the row above it read "No default environment found. Use --target-org".
  const because = 'ReviewedCliProcessError: NoDefaultEnvError: No default environment found. Use -o or --target-org to specify an environment.';
  const text = hostNoProgressBlockedText(null, 'authority_acquisition:no_new_evidence', undefined, because);
  assert.match(text, /What stopped me: ReviewedCliProcessError: NoDefaultEnvError: No default environment found/);
  assert.match(text, /Stopped at: authority_acquisition:no_new_evidence/);
  const silent = hostNoProgressBlockedText(null, 'authority_acquisition:no_new_evidence', undefined, null);
  assert.doesNotMatch(silent, /What stopped me/);
});
