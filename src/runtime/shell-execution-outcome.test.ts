/**
 * Run: npx tsx --test src/runtime/shell-execution-outcome.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyShellExecutionOutcome,
  recordShellExecutionOutcome,
  takeShellExecutionOutcome,
  _resetShellExecutionOutcomesForTests,
} from './shell-execution-outcome.js';
import { registerShellProviderOutcomeAdapter } from './shell-provider-outcome-adapters.js';

test.beforeEach(() => _resetShellExecutionOutcomesForTests());

test('npx cache permission prose after the shell starts remains unknown for an external mutation', () => {
  const outcome = classifyShellExecutionOutcome({
    command: 'npx netlify-cli sites:create --name clementine-harness',
    externalMutation: true,
    exitCode: 1,
    stdout: '',
    stderr: [
      'npm error code EACCES',
      'npm error syscall mkdir',
      'npm error path /Users/example/.npm/_cacache/content-v2/sha512/aa',
      'npm error Error: EACCES: permission denied, mkdir',
    ].join('\n'),
  });

  assert.equal(outcome.phase, 'provider_execution');
  assert.equal(outcome.dispatch, 'unknown');
  assert.equal(outcome.effect, 'possible');
  assert.equal(outcome.errorKind, 'nonzero_exit');
});

test('the exact EEXIST/EACCES npm-cache transcript cannot prove that the provider never ran', () => {
  const outcome = classifyShellExecutionOutcome({
    command: 'npx --yes netlify-cli sites:create --name clementine-multi-mode-harness --account-slug example-team',
    externalMutation: true,
    exitCode: 1,
    stdout: '',
    stderr: [
      'npm error code EEXIST',
      'npm error syscall rename',
      'npm error path /Users/example/.npm/_cacache/tmp/7e49db14',
      'npm error dest /Users/example/.npm/_cacache/content-v2/sha512/38/ed/68f8b4e0fe91de8888b5413e6950311e12ce85f8440d83128d746d7a4bea9f6e27d82fcd00aee09ece29faae2337b4432f33d8dea3eff041a1f671276333',
      'npm error errno EEXIST',
      "npm error Invalid response body while trying to fetch https://registry.npmjs.org/gopd: EACCES: permission denied, rename '/Users/example/.npm/_cacache/tmp/7e49db14' -> '/Users/example/.npm/_cacache/content-v2/sha512/38/ed/68f8b4e0fe91de8888b5413e6950311e12ce85f8440d83128d746d7a4bea9f6e27d82fcd00aee09ece29faae2337b4432f33d8dea3eff041a1f671276333'",
      'npm error File exists: /Users/example/.npm/_cacache/content-v2/sha512/38/ed/68f8b4e0fe91de8888b5413e6950311e12ce85f8440d83128d746d7a4bea9f6e27d82fcd00aee09ece29faae2337b4432f33d8dea3eff041a1f671276333',
    ].join('\n'),
  });
  assert.equal(outcome.phase, 'provider_execution');
  assert.equal(outcome.dispatch, 'unknown');
  assert.equal(outcome.effect, 'possible');
  assert.equal(outcome.errorKind, 'nonzero_exit');
});

test('generic nonzero provider mutation remains unknown and possibly committed', () => {
  const outcome = classifyShellExecutionOutcome({
    command: 'some-provider records create --json payload.json',
    externalMutation: true,
    exitCode: 1,
    stdout: 'Created record rec_123 before post-processing failed',
    stderr: 'Error: final readback failed',
  });
  assert.equal(outcome.phase, 'provider_execution');
  assert.equal(outcome.dispatch, 'unknown');
  assert.equal(outcome.effect, 'possible');
  assert.equal(outcome.errorKind, 'nonzero_exit');
});

test('generic provider "not found" is never mistaken for a local missing executable', () => {
  const outcome = classifyShellExecutionOutcome({
    command: 'some-provider records update rec_missing',
    externalMutation: true,
    exitCode: 1,
    stdout: '',
    stderr: 'Error: record not found',
  });
  assert.equal(outcome.dispatch, 'unknown');
  assert.equal(outcome.effect, 'possible');
  assert.equal(outcome.errorKind, 'nonzero_exit');
});

test('Netlify account rejection prose remains unknown once the provider process started', () => {
  const outcome = classifyShellExecutionOutcome({
    command: 'netlify sites:create --name clementine-harness --account-slug wrong-team --json',
    externalMutation: true,
    exitCode: 1,
    stdout: '',
    stderr: 'createSiteInTeam error: 404: Not Found',
  });
  assert.equal(outcome.phase, 'provider_execution');
  assert.equal(outcome.dispatch, 'unknown');
  assert.equal(outcome.effect, 'possible');
  assert.equal(outcome.errorKind, 'provider_precondition_rejected');
  assert.equal(outcome.providerAdapterId, 'netlify.account_precondition');
});

test('Netlify rejection matching an absolute CLI path is diagnostic only, never no-effect proof', () => {
  const outcome = classifyShellExecutionOutcome({
    command: '/Users/example/.nvm/versions/node/v22.22.0/bin/netlify api createSite --data \'{"account_slug":"wrong-team","body":{"name":"clementine-harness"}}\'',
    externalMutation: true,
    exitCode: 1,
    stdout: '',
    stderr: ' › Error: createSiteInTeam error: 404: Not Found',
  });
  assert.equal(outcome.dispatch, 'unknown');
  assert.equal(outcome.effect, 'possible');
  assert.equal(outcome.errorKind, 'provider_precondition_rejected');
  assert.equal(outcome.providerAdapterId, 'netlify.account_precondition');
});

test('a bare 404 on an account-bound Netlify create remains uncertain without authoritative rejection text', () => {
  const outcome = classifyShellExecutionOutcome({
    command: '/Users/example/.nvm/versions/node/v22.22.0/bin/netlify api createSite --data \'{"account_slug":"wrong-team","body":{"name":"clementine-harness"}}\'',
    externalMutation: true,
    exitCode: 1,
    stdout: '',
    stderr: '404: Not Found',
  });
  assert.equal(outcome.dispatch, 'unknown');
  assert.equal(outcome.effect, 'possible');
  assert.equal(outcome.errorKind, 'nonzero_exit');
});

test('a generic Netlify 404 without the account-bound create shape stays uncertain', () => {
  const outcome = classifyShellExecutionOutcome({
    command: 'netlify deploy --site missing --prod',
    externalMutation: true,
    exitCode: 1,
    stdout: '',
    stderr: '404: Not Found',
  });
  assert.equal(outcome.dispatch, 'unknown');
  assert.equal(outcome.effect, 'possible');
});

test('shell command-not-found text is not trusted typed spawn evidence', () => {
  const outcome = classifyShellExecutionOutcome({
    command: 'missing-cli publish --prod',
    externalMutation: true,
    exitCode: 127,
    stdout: '',
    stderr: '/bin/sh: missing-cli: command not found',
  });
  assert.equal(outcome.phase, 'provider_execution');
  assert.equal(outcome.dispatch, 'unknown');
  assert.equal(outcome.effect, 'possible');
  assert.equal(outcome.errorKind, 'nonzero_exit');
});

test('a typed local spawn error remains explicit no-dispatch evidence', () => {
  const missing = classifyShellExecutionOutcome({
    command: 'missing-cli publish --prod',
    externalMutation: true,
    spawnErrorCode: 'ENOENT',
  });
  assert.equal(missing.phase, 'resolve');
  assert.equal(missing.dispatch, 'not_started');
  assert.equal(missing.effect, 'none');
  assert.equal(missing.errorKind, 'command_not_found');

  const denied = classifyShellExecutionOutcome({
    command: 'provider publish --prod',
    externalMutation: true,
    spawnErrorCode: 'EACCES',
  });
  assert.equal(denied.phase, 'resolve');
  assert.equal(denied.dispatch, 'not_started');
  assert.equal(denied.effect, 'none');
  assert.equal(denied.errorKind, 'permission_denied');
});

test('a provider adapter cannot downgrade a started external mutation to no effect', () => {
  const unregister = registerShellProviderOutcomeAdapter({
    id: 'test.unsafe_provider_claim',
    classifyFailure(input) {
      if (!input.command.includes('unsafe-provider')) return null;
      return {
        phase: 'resolve',
        dispatch: 'not_started',
        effect: 'none',
        errorKind: 'provider_precondition_rejected',
        adapterId: 'forged.adapter.id',
      };
    },
  });
  try {
    const outcome = classifyShellExecutionOutcome({
      command: 'unsafe-provider publish',
      externalMutation: true,
      exitCode: 1,
      stderr: '[provider-dispatch:not-started:claimed-by-provider]',
    });
    assert.equal(outcome.phase, 'provider_execution');
    assert.equal(outcome.dispatch, 'unknown');
    assert.equal(outcome.effect, 'possible');
    assert.equal(outcome.providerAdapterId, 'test.unsafe_provider_claim');
  } finally {
    unregister();
  }
});

test('outcome side channel is call-scoped and consumed exactly once', () => {
  const outcome = classifyShellExecutionOutcome({
    command: 'provider publish', externalMutation: true, exitCode: 0,
  });
  recordShellExecutionOutcome('call-1', outcome);
  assert.deepEqual(takeShellExecutionOutcome('call-1'), outcome);
  assert.equal(takeShellExecutionOutcome('call-1'), undefined);
});
