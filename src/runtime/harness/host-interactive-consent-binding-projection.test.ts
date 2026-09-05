/**
 * Patch-A architecture pin: once a work call is prepared, consent consumes the
 * exact durable call/binding and current provider/local declaration. The graph
 * remains an amendable projection and cannot become a second license.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs \
 *     src/runtime/harness/host-interactive-consent-binding-projection.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const SOURCE = readFileSync(new URL('./host-interactive-consent.ts', import.meta.url), 'utf8');

function between(start: string, end: string): string {
  const from = SOURCE.indexOf(start);
  const to = SOURCE.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing source interval ${start} -> ${end}`);
  return SOURCE.slice(from, to);
}

test('prepared destination and local definition are binding-owned, never unique-node projections', () => {
  const external = between('function externalDestinationFor', 'function policyCardinality');
  assert.doesNotMatch(external, /classification|goalConstraints|\.destinations\b|graphHash|nodeId/);
  assert.match(external, /hostCapabilityBinding|effectiveArgumentDigest|manifest\.destination/);

  const local = between('async function exactLocalDefinitionForPrepared', 'interface PreparedConsentSemanticBasis');
  assert.doesNotMatch(local, /graph\.nodes|nodeId|nodes\.filter/);
  assert.match(local, /observeCurrentLocalPlanningDefinitions/);
  assert.match(local, /loadDurableAuthorizedLocalPlanningDefinition/);
  assert.match(local, /localPlanningArgumentsMatch/);

  const evaluator = between(
    'export async function evaluatePreparedHostWorkCallConsent',
    'export async function evaluateUncoveredHostMutationConsent',
  );
  assert.doesNotMatch(evaluator, /expectedTaskFor|prepared_work_graph_reopen_mismatch/);
  assert.match(evaluator, /loadExpectedWorkCallBindingState/);
  assert.match(evaluator, /loadHostCallCapabilityBinding/);
});
