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

// ONE LOOP, EVERY CARRIER. How work was SENT OFF must not decide which
// reasoning engine runs it: a workflow step, a cron occurrence and a chat turn
// differ in context, not in engine. Before this, 15 of 1,121+ real turns ever
// reached the host loop, and four scheduled workflows blocked in one batch on
// the lane chat had already left behind.
test('every fresh carrier selects the host engine, not just chat', () => {
  delete process.env[TURN_ENGINE_ENV_KEY];
  for (const sessionKind of ['chat', 'workflow', 'execution', 'cron', 'background']) {
    assert.equal(
      selectTurnEngine({ sessionKind }),
      'host_v1',
      `${sessionKind} must not be routed to a second reasoning engine`,
    );
  }
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

test('invalid fresh configuration is rejected on every carrier, and cannot disturb persisted resume ownership', () => {
  // An unusable engine name must fail loudly on a workflow exactly as it does
  // on chat -- silently downgrading a carrier to the legacy owner is how the
  // fork got reintroduced by accident before.
  assert.throws(
    () => selectTurnEngine({ sessionKind: 'execution', configuredValue: 'future-engine' }),
    InvalidFreshTurnEngineError,
  );
  assert.equal(selectTurnEngine({
    sessionKind: 'chat',
    persistedState: 'legacy_sdk',
    configuredValue: 'future-engine',
  }), 'legacy_sdk');
});

test('host_v1_read_only applies to every carrier', () => {
  process.env[TURN_ENGINE_ENV_KEY] = 'host_v1_read_only';
  for (const sessionKind of ['chat', 'workflow', 'execution']) {
    assert.equal(selectTurnEngine({ sessionKind }), 'host_v1_read_only');
  }
});

test('host_v1 applies to every carrier', () => {
  process.env[TURN_ENGINE_ENV_KEY] = 'host_v1';
  for (const sessionKind of ['chat', 'workflow', 'execution']) {
    assert.equal(selectTurnEngine({ sessionKind }), 'host_v1');
  }
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

// legacy_sdk survives only as a persisted resume identity. A turn serialized by
// the old engine must still resume through it -- on any carrier -- but nothing
// may SELECT it fresh.
test('legacy_sdk is resume-only and reachable on no fresh carrier', () => {
  delete process.env[TURN_ENGINE_ENV_KEY];
  for (const sessionKind of ['chat', 'workflow', 'execution']) {
    assert.equal(
      selectTurnEngine({ sessionKind, persistedState: 'legacy_sdk' }),
      'legacy_sdk',
      'a turn the legacy engine serialized must resume through it',
    );
    assert.notEqual(
      selectTurnEngine({ sessionKind }),
      'legacy_sdk',
      'no fresh carrier may select the legacy engine',
    );
  }
});
