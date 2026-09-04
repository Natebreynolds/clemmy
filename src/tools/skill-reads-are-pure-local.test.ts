import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hostReadOnlyExecutionContractFor, registeredToolSideEffect } from './tool-registry.js';

// WHO CALLS THIS: the declaration is inert unless the host provenance wall
// consults it. `provenTurnReadDescent` requires
// `hostReadOnlyExecutionContractFor(name) === 'pure_local'`, and
// `readOnlyCanaryRefusal` refuses exactly when that descent returns null. Pin
// the edge, not just the declaration — a green typecheck proves neither.
const RUNNER = readFileSync(
  new URL('../runtime/harness/host-turn-runner.ts', import.meta.url),
  'utf8',
);

test('reading an installed skill is declared pure-local host execution', () => {
  for (const name of ['skill_list', 'skill_read']) {
    assert.equal(registeredToolSideEffect(name), 'read', `${name} must stay a read`);
    assert.equal(
      hostReadOnlyExecutionContractFor(name),
      'pure_local',
      `${name} reads a SKILL.md off local disk — the same class as list_files`,
    );
  }
});

test('the provenance wall consults the pure-local contract, so the declaration is reachable', () => {
  assert.match(
    RUNNER,
    /hostReadOnlyExecutionContractFor\(name\) !== 'pure_local'/,
    'provenTurnReadDescent must gate on the contract',
  );
  assert.match(
    RUNNER,
    /&& !provenTurnReadDescent\(name, args, tool\)\s*\)\s*\)\s*\{\s*return `Tool '\$\{name\}' was refused before dispatch/,
    'the pre-dispatch refusal must be the branch the descent escapes',
  );
});

// The refusal named the refused tool as its own recovery — a loop by
// construction. Whatever else changes, a pure-local read must not land there.
test('a pure-local skill read is not a mutation under any registry reading', () => {
  for (const name of ['skill_list', 'skill_read']) {
    assert.notEqual(registeredToolSideEffect(name), 'write');
  }
});
