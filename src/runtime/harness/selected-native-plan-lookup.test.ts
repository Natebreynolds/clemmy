import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  _setConfiguredLocalPlanningToolObserverForTests,
  inspectAuthorizedLocalPlanningDisclosureCandidates,
  observeSelectedLocalPlanningDisclosureCandidate,
  revalidateLocalPlanningDefinition,
} from './local-planning-capability.js';

// Pure configured-surface observations: no database, fixture home, tool body,
// model request, or live application setting is created or reset here.
const schema = {
  type: 'object', properties: { slug: { type: 'string' } },
  required: ['slug'], additionalProperties: false,
};
afterEach(() => _setConfiguredLocalPlanningToolObserverForTests(null));

test('exact native nomination derives a host-issued current read contract', async () => {
  const observed: string[] = [];
  _setConfiguredLocalPlanningToolObserverForTests((name, carrier) => {
    observed.push(`${name}:${carrier}`);
    return name === 'space_preview' ? { name, parameters: schema } : null;
  });
  const candidate = await observeSelectedLocalPlanningDisclosureCandidate('cap:local:space_preview:read');
  assert.ok(candidate);
  assert.ok(observed.every(value => value === 'space_preview:work_call'));
  const definitions = inspectAuthorizedLocalPlanningDisclosureCandidates(candidate);
  assert.ok(definitions);
  assert.equal(definitions?.length, 1);
  assert.equal(definitions[0]?.descriptor.effect, 'read');
  assert.equal(definitions[0]?.destructive, false);
  assert.equal(definitions[0]?.accountIdentity, 'local_registry:host');
  assert.deepEqual(candidate.schema, schema);
  assert.equal(inspectAuthorizedLocalPlanningDisclosureCandidates({ ...candidate }), null,
    'copying candidate fields does not copy host issuance');
});

test('unknown names and noncanonical references never reach configured lookup', async () => {
  _setConfiguredLocalPlanningToolObserverForTests(() => { throw new Error('Unexpected lookup'); });
  for (const ref of [
    'cap:local:not_a_real_tool:read', 'cap:local:SPACE_PREVIEW:read',
    'cap:local:space_preview:read:extra', 'cap:composio:space_preview:read',
    'cap:local:space_preview:read ', 'space_preview',
  ]) assert.equal(await observeSelectedLocalPlanningDisclosureCandidate(ref), null, ref);
});

test('unavailable configured tools and invented effect variants cannot produce a candidate', async () => {
  _setConfiguredLocalPlanningToolObserverForTests(() => null);
  assert.equal(await observeSelectedLocalPlanningDisclosureCandidate('cap:local:space_preview:read'), null);
  _setConfiguredLocalPlanningToolObserverForTests(name => ({ name, parameters: schema }));
  assert.equal(await observeSelectedLocalPlanningDisclosureCandidate('cap:local:space_preview:reversible'), null);
});

test('a selected native definition fails revalidation after its configured schema changes', async () => {
  _setConfiguredLocalPlanningToolObserverForTests(name => ({ name, parameters: schema }));
  const candidate = await observeSelectedLocalPlanningDisclosureCandidate('cap:local:space_preview:read');
  assert.ok(candidate);
  const definition = inspectAuthorizedLocalPlanningDisclosureCandidates(candidate)?.[0];
  assert.ok(definition);
  _setConfiguredLocalPlanningToolObserverForTests(name => ({ name,
    parameters: { ...schema, properties: { slug: { type: 'integer' } } },
  }));
  assert.equal((await revalidateLocalPlanningDefinition(definition)).ok, false);
});
