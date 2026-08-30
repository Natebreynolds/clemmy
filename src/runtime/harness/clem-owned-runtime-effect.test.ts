/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/clem-owned-runtime-effect.test.ts
 *
 * Clementine-owned focus and durable-memory bookkeeping writes mutate audited
 * host state, not user artifacts or an external provider. Keep their durable
 * registry taxonomy as writes while projecting host_only at the runtime effect
 * boundary, including through the deferred call_tool carrier.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideToolApproval } from '../../agents/tool-taxonomy.js';
import { TOOL_REGISTRY } from '../../tools/tool-registry.js';
import { classifyRuntimeToolEffect } from './tool-effect.js';

const CLEM_OWNED_WRITERS = [
  'focus_activate',
  'focus_clear',
  'focus_park',
  'focus_set',
  'focus_touch',
  'focus_update',
  'memory_forget',
  'memory_pin',
  'memory_remember',
  'memory_restore',
] as const;

const HOST_ONLY = {
  effect: 'host_only',
  mutating: true,
  dangerousWrite: false,
  source: 'registry',
} as const;

test('Clem-owned focus and memory writers remain durable writes with a host-only runtime effect', () => {
  for (const name of CLEM_OWNED_WRITERS) {
    const declaration = TOOL_REGISTRY.find((candidate) => candidate.name === name);
    assert.ok(declaration, `${name} must remain registered`);
    assert.equal(declaration.sideEffect, 'write', `${name} must remain an audited durable write`);
    assert.equal(declaration.runtimeEffect, 'host_only', `${name} must not enter business-write consent`);
  }
});

test('Clem-owned focus and memory writers classify host-only directly and through call_tool', () => {
  for (const name of CLEM_OWNED_WRITERS) {
    const args = name === 'memory_remember'
      ? { kind: 'user', content: 'The user prefers concise updates.' }
      : { id: 17 };
    assert.deepEqual(classifyRuntimeToolEffect(name, args), HOST_ONLY, `${name} direct`);
    assert.deepEqual(classifyRuntimeToolEffect('call_tool', {
      name,
      args_json: JSON.stringify(args),
    }), HOST_ONLY, `${name} through call_tool`);
  }
});

test('the legacy SDK approval taxonomy also treats every host-only bookkeeping write as local', () => {
  for (const name of CLEM_OWNED_WRITERS) {
    const decision = decideToolApproval({ toolName: name, args: { id: 17 } });
    assert.equal(decision.kind, 'write', `${name} must remain a write in the durable taxonomy`);
    assert.equal(decision.needsApproval, false, `${name} must not manufacture a legacy approval`);
    assert.equal(decision.reason, 'read-always-auto', `${name} must use the exact local-memory exception`);
  }
});

test('host-only bookkeeping does not weaken local-artifact or external-write classification', () => {
  const localArtifact = {
    effect: 'local_write',
    mutating: true,
    dangerousWrite: false,
    source: 'registry',
  } as const;
  const externalWrite = {
    effect: 'external_write',
    mutating: true,
    dangerousWrite: true,
    source: 'composio',
  } as const;
  const fileArgs = { path: '/workspace/report.md', content: 'updated', mode: 'overwrite' };
  const providerArgs = {
    tool_slug: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
    arguments: JSON.stringify({ to: 'recipient@example.test', subject: 'Hello' }),
  };

  assert.deepEqual(classifyRuntimeToolEffect('write_file', fileArgs), localArtifact);
  assert.deepEqual(classifyRuntimeToolEffect('call_tool', {
    name: 'write_file',
    args_json: JSON.stringify(fileArgs),
  }), localArtifact);
  assert.deepEqual(classifyRuntimeToolEffect('composio_execute_tool', providerArgs), externalWrite);
  assert.deepEqual(classifyRuntimeToolEffect('call_tool', {
    name: 'composio_execute_tool',
    args_json: JSON.stringify(providerArgs),
  }), externalWrite);
});
