import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-standing-policy-kernel-permuted';
process.env.CLEMENTINE_HOME = TEST_HOME;

const { openMemoryDb } = await import('../../memory/db.js');
const { rememberFact } = await import('../../memory/facts.js');
const {
  STANDING_POLICY_COMPILER_PROTOCOL,
  STANDING_POLICY_SCHEMA_VERSION,
  sealStandingPolicyDescriptor,
  standingPolicySourceSha256,
} = await import('../../memory/policy-enforcement.js');
const { checkStandingPolicyViolation } = await import('./constraint-guard.js');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

test('generic kernel evaluates generated adapter/tag permutations without provider allowlists', () => {
  const permutations = [
    { adapterId: 'adapter-alpha', namespace: 'nebula' },
    { adapterId: 'adapter-bravo', namespace: 'quartz' },
    { adapterId: 'adapter-x9', namespace: 'willow' },
  ];
  for (const fixture of permutations) {
    openMemoryDb().prepare('DELETE FROM consolidated_facts').run();
    const content = `Fixture standing rule ${fixture.adapterId}/${fixture.namespace}`;
    const fact = rememberFact({ kind: 'constraint', content });
    const descriptor = sealStandingPolicyDescriptor({
      schemaVersion: STANDING_POLICY_SCHEMA_VERSION,
      contract: 'standing_policy',
      compiler: {
        protocol: STANDING_POLICY_COMPILER_PROTOCOL,
        adapterId: fixture.adapterId,
        version: 1,
      },
      sourceSha256: standingPolicySourceSha256(content),
      deterministic: true,
      policyClass: 'fixture-denial',
      gateways: ['fixture_gateway'],
      bindings: [],
      directives: [{
        kind: 'deny',
        selector: { adapterId: fixture.adapterId, allTags: [`namespace:${fixture.namespace}`] },
        reason: `sealed ${fixture.namespace} route denied`,
        violatingField: 'route',
        overrideAllowed: false,
        recovery: `use ${fixture.namespace}-safe`,
      }],
      capabilityHints: [],
      reason: 'generated fixture',
    });
    openMemoryDb().prepare(`
      UPDATE memory_policies
      SET policy_type = 'hard_constraint', enforcement = 'dispatch', applies_to_json = ?
      WHERE fact_id = ?
    `).run(JSON.stringify(descriptor), fact.id);

    const denied = checkStandingPolicyViolation({
      adapterId: fixture.adapterId,
      toolName: 'fixture_gateway',
      tags: [`namespace:${fixture.namespace}`],
      fields: {},
    });
    assert.equal(denied?.constraint.id, fact.id);
    assert.equal(denied?.overrideAllowed, false);

    const unrelated = checkStandingPolicyViolation({
      adapterId: fixture.adapterId,
      toolName: 'fixture_gateway',
      tags: ['namespace:unrelated'],
      fields: {},
    });
    assert.equal(unrelated, null);
  }
});
