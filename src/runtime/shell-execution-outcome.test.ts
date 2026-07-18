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

test.beforeEach(() => _resetShellExecutionOutcomesForTests());

test('npx cache permission failure is materialization with provider dispatch not started', () => {
  const outcome = classifyShellExecutionOutcome({
    command: 'npx netlify-cli sites:create --name clementine-harness',
    externalMutation: true,
    exitCode: 1,
    stdout: '',
    stderr: [
      'npm error code EACCES',
      'npm error syscall mkdir',
      'npm error path /Users/nate/.npm/_cacache/content-v2/sha512/aa',
      'npm error Error: EACCES: permission denied, mkdir',
    ].join('\n'),
  });

  assert.deepEqual(outcome, {
    phase: 'materialize',
    dispatch: 'not_started',
    effect: 'none',
    externalMutation: true,
    exitCode: 1,
    errorKind: 'package_materialization_failed',
    executable: 'npx',
  });
});

test('the exact run EEXIST/EACCES npm-cache failure is local materialization, not provider execution', () => {
  const outcome = classifyShellExecutionOutcome({
    command: 'npx --yes netlify-cli sites:create --name clementine-multi-mode-harness --account-slug nathan-reynolds',
    externalMutation: true,
    exitCode: 1,
    stdout: '',
    stderr: [
      'npm error code EEXIST',
      'npm error syscall rename',
      'npm error path /Users/nathan.reynolds/.npm/_cacache/tmp/7e49db14',
      'npm error dest /Users/nathan.reynolds/.npm/_cacache/content-v2/sha512/38/ed/68f8b4e0fe91de8888b5413e6950311e12ce85f8440d83128d746d7a4bea9f6e27d82fcd00aee09ece29faae2337b4432f33d8dea3eff041a1f671276333',
      'npm error errno EEXIST',
      "npm error Invalid response body while trying to fetch https://registry.npmjs.org/gopd: EACCES: permission denied, rename '/Users/nathan.reynolds/.npm/_cacache/tmp/7e49db14' -> '/Users/nathan.reynolds/.npm/_cacache/content-v2/sha512/38/ed/68f8b4e0fe91de8888b5413e6950311e12ce85f8440d83128d746d7a4bea9f6e27d82fcd00aee09ece29faae2337b4432f33d8dea3eff041a1f671276333'",
      'npm error File exists: /Users/nathan.reynolds/.npm/_cacache/content-v2/sha512/38/ed/68f8b4e0fe91de8888b5413e6950311e12ce85f8440d83128d746d7a4bea9f6e27d82fcd00aee09ece29faae2337b4432f33d8dea3eff041a1f671276333',
    ].join('\n'),
  });
  assert.equal(outcome.phase, 'materialize');
  assert.equal(outcome.dispatch, 'not_started');
  assert.equal(outcome.effect, 'none');
  assert.equal(outcome.errorKind, 'package_materialization_failed');
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

test('authoritative Netlify account rejection uses the provider adapter and proves no effect', () => {
  const outcome = classifyShellExecutionOutcome({
    command: 'netlify sites:create --name clementine-harness --account-slug wrong-team --json',
    externalMutation: true,
    exitCode: 1,
    stdout: '',
    stderr: 'createSiteInTeam error: 404: Not Found',
  });
  assert.equal(outcome.phase, 'provider_execution');
  assert.equal(outcome.dispatch, 'acknowledged');
  assert.equal(outcome.effect, 'none');
  assert.equal(outcome.errorKind, 'provider_precondition_rejected');
  assert.equal(outcome.providerAdapterId, 'netlify.account_precondition');
});

test('authoritative Netlify account rejection matches a discovered absolute CLI path', () => {
  const outcome = classifyShellExecutionOutcome({
    command: '/Users/nathan.reynolds/.nvm/versions/node/v22.22.0/bin/netlify api createSite --data \'{"account_slug":"wrong-team","body":{"name":"clementine-harness"}}\'',
    externalMutation: true,
    exitCode: 1,
    stdout: '',
    stderr: ' › Error: createSiteInTeam error: 404: Not Found',
  });
  assert.equal(outcome.dispatch, 'acknowledged');
  assert.equal(outcome.effect, 'none');
  assert.equal(outcome.errorKind, 'provider_precondition_rejected');
  assert.equal(outcome.providerAdapterId, 'netlify.account_precondition');
});

test('a bare 404 on an account-bound Netlify create remains uncertain without authoritative rejection text', () => {
  const outcome = classifyShellExecutionOutcome({
    command: '/Users/nathan.reynolds/.nvm/versions/node/v22.22.0/bin/netlify api createSite --data \'{"account_slug":"wrong-team","body":{"name":"clementine-harness"}}\'',
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

test('a command-not-found external mutation is explicit no-dispatch', () => {
  const outcome = classifyShellExecutionOutcome({
    command: 'missing-cli publish --prod',
    externalMutation: true,
    exitCode: 127,
    stdout: '',
    stderr: '/bin/sh: missing-cli: command not found',
  });
  assert.equal(outcome.phase, 'resolve');
  assert.equal(outcome.dispatch, 'not_started');
  assert.equal(outcome.effect, 'none');
});

test('outcome side channel is call-scoped and consumed exactly once', () => {
  const outcome = classifyShellExecutionOutcome({
    command: 'provider publish', externalMutation: true, exitCode: 0,
  });
  recordShellExecutionOutcome('call-1', outcome);
  assert.deepEqual(takeShellExecutionOutcome('call-1'), outcome);
  assert.equal(takeShellExecutionOutcome('call-1'), undefined);
});
