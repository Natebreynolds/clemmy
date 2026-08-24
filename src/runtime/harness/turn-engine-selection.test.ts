import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  InvalidFreshTurnEngineError,
  TURN_ENGINE_ENV_KEY,
  configuredTurnEngineMode,
  selectTurnEngine,
} from './turn-engine-selection.js';

const original = process.env[TURN_ENGINE_ENV_KEY];

afterEach(() => {
  if (original === undefined) delete process.env[TURN_ENGINE_ENV_KEY];
  else process.env[TURN_ENGINE_ENV_KEY] = original;
});

test('fresh chat defaults to production host_v1 while non-chat retains legacy ownership', () => {
  delete process.env[TURN_ENGINE_ENV_KEY];
  assert.equal(selectTurnEngine({ sessionKind: 'chat' }), 'host_v1');
  assert.equal(selectTurnEngine({ sessionKind: 'workflow' }), 'legacy_sdk');
  assert.equal(selectTurnEngine({ sessionKind: 'execution' }), 'legacy_sdk');
});

test('fresh interactive configuration rejects legacy, unknown, and blank values', () => {
  for (const configuredValue of ['legacy_sdk', 'future-engine', '']) {
    assert.throws(
      () => configuredTurnEngineMode(configuredValue),
      InvalidFreshTurnEngineError,
    );
    assert.throws(
      () => selectTurnEngine({ sessionKind: 'chat', configuredValue }),
      InvalidFreshTurnEngineError,
    );
  }
});

test('invalid fresh configuration cannot disturb non-chat or persisted resume ownership', () => {
  assert.equal(selectTurnEngine({
    sessionKind: 'execution',
    configuredValue: 'future-engine',
  }), 'legacy_sdk');
  assert.equal(selectTurnEngine({
    sessionKind: 'chat',
    persistedState: 'legacy_sdk',
    configuredValue: 'future-engine',
  }), 'legacy_sdk');
});

test('the host canary selects only fresh interactive chat', () => {
  process.env[TURN_ENGINE_ENV_KEY] = 'host_v1_read_only';
  assert.equal(selectTurnEngine({ sessionKind: 'chat' }), 'host_v1_read_only');
  assert.equal(selectTurnEngine({ sessionKind: 'workflow' }), 'legacy_sdk');
  assert.equal(selectTurnEngine({ sessionKind: 'execution' }), 'legacy_sdk');
});

test('production host_v1 selects only fresh interactive chat', () => {
  process.env[TURN_ENGINE_ENV_KEY] = 'host_v1';
  assert.equal(selectTurnEngine({ sessionKind: 'chat' }), 'host_v1');
  assert.equal(selectTurnEngine({ sessionKind: 'workflow' }), 'legacy_sdk');
  assert.equal(selectTurnEngine({ sessionKind: 'execution' }), 'legacy_sdk');
});

test('persisted interruption state owns resume selection across flag changes', () => {
  assert.equal(selectTurnEngine({
    sessionKind: 'chat',
    persistedState: 'host',
    configuredValue: 'legacy_sdk',
  }), 'host_v1_read_only');
  assert.equal(selectTurnEngine({
    sessionKind: 'chat',
    persistedState: 'legacy_sdk',
    configuredValue: 'host_v1_read_only',
  }), 'legacy_sdk');
  assert.equal(selectTurnEngine({
    sessionKind: 'chat',
    persistedState: 'host_v1',
    configuredValue: 'host_v1_read_only',
  }), 'host_v1');
  assert.equal(selectTurnEngine({
    sessionKind: 'chat',
    persistedState: 'host_v1_read_only',
    configuredValue: 'host_v1',
  }), 'host_v1_read_only');
});
