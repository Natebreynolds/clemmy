import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  attestTerminalPhysicalDispatchOwner,
  isTerminalPhysicalDispatchOwner,
} = await import('./terminal-physical-dispatch-owner.js');
const { wrapToolForHarness } = await import('./brackets.js');

test('terminal dispatch ownership is opaque, callable-pinned, and copied only onto the harness wrapper', () => {
  const configured = attestTerminalPhysicalDispatchOwner({
    name: 'provider_adapter',
    execute: async () => 'ok',
  });
  assert.equal(isTerminalPhysicalDispatchOwner(configured), true);

  const structuralLookalike = { ...configured };
  assert.equal(isTerminalPhysicalDispatchOwner(structuralLookalike), false,
    'a spread copy with the same name and function cannot forge ownership');

  const wrapped = wrapToolForHarness(configured);
  assert.notEqual(wrapped, configured);
  assert.equal(isTerminalPhysicalDispatchOwner(wrapped), true,
    'the exact trusted harness wrapper carries the structural ownership');

  const originalExecute = wrapped.execute;
  wrapped.execute = async () => 'mutated';
  assert.equal(isTerminalPhysicalDispatchOwner(wrapped), false,
    'post-wrap executable mutation invalidates the attestation');
  wrapped.execute = originalExecute;
  assert.equal(isTerminalPhysicalDispatchOwner(wrapped), true);

  const ordinary = wrapToolForHarness({
    name: 'provider_adapter',
    execute: async () => 'ok',
  });
  assert.equal(isTerminalPhysicalDispatchOwner(ordinary), false,
    'a matching name has no authority without exact registration');
});

test('SDK invoke ownership is copied while a raw invoke lookalike remains untrusted', () => {
  const configured = attestTerminalPhysicalDispatchOwner({
    name: 'sdk_provider_adapter',
    invoke: async () => 'ok',
  });
  const wrapped = wrapToolForHarness(configured);
  assert.equal(isTerminalPhysicalDispatchOwner(wrapped), true);
  assert.equal(isTerminalPhysicalDispatchOwner({
    name: configured.name,
    invoke: configured.invoke,
  }), false);
});
