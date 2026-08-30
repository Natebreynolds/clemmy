import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STANDING_POLICY_COMPILER_PROTOCOL,
  STANDING_POLICY_SCHEMA_VERSION,
  parseStandingPolicyDescriptor,
  sealStandingPolicyDescriptor,
  standingPolicySourceSha256,
  type StandingPolicyDescriptorBody,
} from './policy-enforcement.js';

function fixtureBody(source: string, adapterId: string, tag: string): StandingPolicyDescriptorBody {
  return {
    schemaVersion: STANDING_POLICY_SCHEMA_VERSION,
    contract: 'standing_policy',
    compiler: { protocol: STANDING_POLICY_COMPILER_PROTOCOL, adapterId, version: 1 },
    sourceSha256: standingPolicySourceSha256(source),
    deterministic: true,
    policyClass: 'fixture-denial',
    gateways: ['fixture_gateway'],
    bindings: [{ adapterId, kind: 'namespace', value: tag }],
    directives: [{
      kind: 'deny',
      selector: { adapterId, allTags: [`namespace:${tag}`] },
      reason: `fixture ${tag} is denied`,
      violatingField: 'route',
      overrideAllowed: false,
      recovery: `use fixture route ${tag}-safe`,
    }],
    capabilityHints: [],
    reason: 'fixture deterministic policy',
  };
}

test('sealed provider-neutral descriptors accept permuted adapter and namespace data', () => {
  const permutations = [
    ['adapter-alpha', 'nebula'],
    ['adapter-bravo', 'quartz'],
    ['adapter-x9', 'willow'],
  ] as const;
  for (const [adapterId, tag] of permutations) {
    const source = `fixture source for ${adapterId}/${tag}`;
    const descriptor = sealStandingPolicyDescriptor(fixtureBody(source, adapterId, tag));
    assert.deepEqual(parseStandingPolicyDescriptor(JSON.stringify(descriptor), source), descriptor);
  }
});

test('read-side contract rejects stale source and byte-tampered descriptors', () => {
  const source = 'fixture source';
  const descriptor = sealStandingPolicyDescriptor(fixtureBody(source, 'adapter-alpha', 'nebula'));
  assert.equal(parseStandingPolicyDescriptor(JSON.stringify(descriptor), 'changed fixture source'), null);

  const tampered = structuredClone(descriptor);
  tampered.directives[0]!.reason = 'silently allow it now';
  assert.equal(parseStandingPolicyDescriptor(JSON.stringify(tampered), source), null);
});

test('read-side contract rejects unknown directive kinds even when freshly sealed', () => {
  const source = 'fixture source';
  const body = fixtureBody(source, 'adapter-alpha', 'nebula');
  body.directives = [{
    ...(body.directives[0] as object),
    kind: 'unknown_future_authority',
  } as never];
  const unknown = sealStandingPolicyDescriptor(body);
  assert.equal(parseStandingPolicyDescriptor(JSON.stringify(unknown), source), null);
});

test('read-side contract rejects an unknown compiler protocol version', () => {
  const source = 'fixture source';
  const body = fixtureBody(source, 'adapter-alpha', 'nebula');
  body.compiler.version = 2;
  const unknown = sealStandingPolicyDescriptor(body);
  assert.equal(parseStandingPolicyDescriptor(JSON.stringify(unknown), source), null);
});
