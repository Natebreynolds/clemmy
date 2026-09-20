import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAdmittedCapabilityRef } from './admitted-capability-ref.js';

test('a revalidated local planning ref survives a similarly prefixed execution manifest', () => {
  const ref = 'cap:local:read_file:read';
  let lookups = 0;
  const result = resolveAdmittedCapabilityRef(ref, new Set([ref]), () => {
    lookups += 1;
    return `${ref}:exec:other-surface`;
  });
  assert.equal(result, ref);
  assert.equal(lookups, 0);
});

test('unvalidated lookalikes and ordinary provider refs retain successor resolution', () => {
  const verified = new Set(['cap:local:read_file:read']);
  for (const ref of ['cap:local:read_file:read:unknown', 'cap:provider:records']) {
    assert.equal(resolveAdmittedCapabilityRef(ref, verified, () => `${ref}:v2`), `${ref}:v2`);
  }
  assert.equal(resolveAdmittedCapabilityRef('cap:unknown', undefined, () => undefined), 'cap:unknown');
});
