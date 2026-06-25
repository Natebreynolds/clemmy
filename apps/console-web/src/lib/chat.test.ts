import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTerminalEvent } from './chat';

test('chat stream keeps budget-limit telemetry non-terminal', () => {
  assert.equal(isTerminalEvent('conversation_limit_exceeded'), false);
  assert.equal(isTerminalEvent('conversation_completed'), true);
  assert.equal(isTerminalEvent('run_failed'), true);
});
