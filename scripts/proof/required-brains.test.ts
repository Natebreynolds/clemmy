import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertRequiredBrainsSelected,
  parseRequiredBrains,
  unavailableBrainDisposition,
} from './required-brains.js';

test('required brain parsing is strict and deduplicates the release contract', () => {
  assert.deepEqual(parseRequiredBrains(' claude,codex,glm,codex '), ['claude', 'codex', 'glm']);
  assert.throws(
    () => parseRequiredBrains(undefined),
    /requires a comma-separated list/,
  );
  assert.throws(
    () => parseRequiredBrains(' , '),
    /requires at least one/,
  );
  assert.throws(
    () => parseRequiredBrains('claude,other'),
    /unknown brain\(s\): other/,
  );
});

test('required brains must also be selected by the matrix', () => {
  assert.doesNotThrow(() => assertRequiredBrainsSelected(
    ['claude', 'codex', 'glm'],
    ['claude', 'codex', 'glm'],
  ));
  assert.throws(
    () => assertRequiredBrainsSelected(['codex'], ['claude', 'codex', 'glm']),
    /not selected: claude, glm/,
  );
});

test('generic unavailable brains remain skips', () => {
  assert.deepEqual(
    unavailableBrainDisposition('claude', 'no Claude credentials', []),
    { status: 'SKIP', error: 'no Claude credentials' },
  );
});

test('an unavailable required brain is a report-visible failure', () => {
  assert.deepEqual(
    unavailableBrainDisposition('glm', 'no BYO model configured', ['claude', 'codex', 'glm']),
    { status: 'FAIL', error: 'required brain unavailable: no BYO model configured' },
  );
  assert.deepEqual(
    unavailableBrainDisposition('glm', 'no BYO model configured', ['codex']),
    { status: 'SKIP', error: 'no BYO model configured' },
  );
});
