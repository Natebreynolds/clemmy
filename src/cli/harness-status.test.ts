import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { RunConversationStatus } from '../runtime/harness/loop.js';
import {
  HARNESS_HELD_EXIT_CODE,
  harnessBridgeStatus,
  harnessRunExitCode,
} from './harness-status.js';

test('harness blocked and failed statuses are never exit zero', () => {
  assert.equal(harnessRunExitCode({ status: 'blocked' }), 1);
  assert.equal(harnessRunExitCode({ status: 'failed' }), 1);
});

test('harness held status has a distinct retryable-owner exit code', () => {
  assert.equal(harnessRunExitCode({
    status: 'held',
    hold: { owner: 'host', wake: 'peer', reason: 'peer_in_progress' },
  }), HARNESS_HELD_EXIT_CODE);
  assert.notEqual(HARNESS_HELD_EXIT_CODE, 0);
  assert.notEqual(HARNESS_HELD_EXIT_CODE, 1);
});

test('harness existing success/input/approval/control exit behavior stays stable', () => {
  const zeroStatuses: RunConversationStatus[] = [
    'completed',
    'dispatched',
    'awaiting_user_input',
    'awaiting_approval',
    'killed',
    'limit_exceeded',
  ];
  for (const status of zeroStatuses) {
    assert.equal(harnessRunExitCode({ status }), 0, status);
  }
});

test('shared bridge stop reasons preserve the harness CLI status and exit contract', () => {
  const cases = [
    [undefined, 'completed', 0],
    ['success', 'completed', 0],
    ['pending-approval', 'awaiting_approval', 0],
    ['awaiting-input', 'awaiting_user_input', 0],
    ['max-turns-with-grace', 'limit_exceeded', 0],
    ['token-budget', 'limit_exceeded', 0],
    ['cancelled', 'killed', 0],
    ['blocked', 'blocked', 1],
    ['unverified', 'blocked', 1],
    ['error', 'failed', 1],
    ['in-progress', 'held', HARNESS_HELD_EXIT_CODE],
  ] as const;
  for (const [reason, expectedStatus, expectedExit] of cases) {
    const status = harnessBridgeStatus(reason);
    assert.equal(status, expectedStatus, String(reason));
    assert.equal(harnessRunExitCode({
      status,
      ...(status === 'held'
        ? { hold: { owner: 'host' as const, wake: 'peer' as const, reason: 'peer_in_progress' as const } }
        : {}),
    }), expectedExit, String(reason));
  }
});

test('harness run enters the shared fresh-chat bridge and has no private runConversation route', () => {
  const source = readFileSync(new URL('./harness.ts', import.meta.url), 'utf8');
  assert.match(source, /respondPreferHarness\(\s*['"]cli['"]/);
  assert.doesNotMatch(source, /import\s*\{[^}]*runConversation[^}]*\}/s);
  assert.doesNotMatch(source, /await\s+runConversation\s*\(/);
});
