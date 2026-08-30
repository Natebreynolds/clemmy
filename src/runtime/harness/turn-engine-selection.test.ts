import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  InvalidFreshTurnEngineError,
  TURN_ENGINE_ENV_KEY,
  configuredTurnEngineMode,
  requireFreshHostTurnEngine,
  selectTurnEngine,
} from './turn-engine-selection.js';

const original = process.env[TURN_ENGINE_ENV_KEY];

afterEach(() => {
  if (original === undefined) delete process.env[TURN_ENGINE_ENV_KEY];
  else process.env[TURN_ENGINE_ENV_KEY] = original;
});

test('every fresh session kind defaults to production host_v1', () => {
  delete process.env[TURN_ENGINE_ENV_KEY];
  for (const sessionKind of ['chat', 'workflow', 'execution', 'agent']) {
    assert.equal(selectTurnEngine({ sessionKind }), 'host_v1', sessionKind);
  }
});

test('fresh configuration and direct owner injection reject legacy, unknown, and blank values', () => {
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
  assert.throws(
    () => requireFreshHostTurnEngine('legacy_sdk'),
    InvalidFreshTurnEngineError,
  );
});

test('invalid fresh configuration is rejected on every lane but cannot disturb persisted resume ownership', () => {
  for (const sessionKind of ['chat', 'workflow', 'execution', 'agent']) {
    assert.throws(
      () => selectTurnEngine({ sessionKind, configuredValue: 'future-engine' }),
      InvalidFreshTurnEngineError,
      sessionKind,
    );
  }
  assert.equal(selectTurnEngine({
    sessionKind: 'execution',
    persistedState: 'legacy_sdk',
    configuredValue: 'future-engine',
  }), 'legacy_sdk');
});

test('the host canary selects every fresh lane', () => {
  process.env[TURN_ENGINE_ENV_KEY] = 'host_v1_read_only';
  for (const sessionKind of ['chat', 'workflow', 'execution', 'agent']) {
    assert.equal(selectTurnEngine({ sessionKind }), 'host_v1_read_only', sessionKind);
  }
});

test('production host_v1 selects every fresh lane', () => {
  process.env[TURN_ENGINE_ENV_KEY] = 'host_v1';
  for (const sessionKind of ['chat', 'workflow', 'execution', 'agent']) {
    assert.equal(selectTurnEngine({ sessionKind }), 'host_v1', sessionKind);
  }
});

test('persisted interruption state owns resume selection across flag changes', () => {
  assert.equal(selectTurnEngine({
    sessionKind: 'chat',
    persistedState: 'host',
    configuredValue: 'legacy_sdk',
  }), 'host_v1_read_only');
  for (const sessionKind of ['chat', 'workflow', 'execution', 'agent']) {
    assert.equal(selectTurnEngine({
      sessionKind,
      persistedState: 'legacy_sdk',
      configuredValue: 'host_v1_read_only',
    }), 'legacy_sdk', `${sessionKind}: serialized legacy owner resumes exactly`);
  }
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
