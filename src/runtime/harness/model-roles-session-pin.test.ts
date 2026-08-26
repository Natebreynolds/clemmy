/**
 * Run: npx tsx --test src/runtime/harness/model-roles-session-pin.test.ts
 *
 * B6 regression pins (gauntlet 2026-08-26): the active brain was ONE global
 * mutable setting (AUTH_MODE + friends in process.env). Concurrent sessions
 * flipped it under each other and silently re-routed each other's NEXT turn
 * (S3 found codex active when claude was expected). Design: the brain a
 * session is being served on PINS to that session at its first in-turn brain
 * resolution; the global setting is the default for NEW sessions only, and an
 * explicit per-session switch re-pins. Explicit role BINDINGS (CLEMMY_MODEL_ROLES)
 * still win over the pin — "applies on the next message" is that door's promise.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-session-pin-test-'));

const {
  resolveRoleModel,
  pinSessionBrain,
  releaseSessionBrainPin,
  pinnedBrainForSession,
  __sessionBrainPinTest__,
} = await import('./model-roles.js');
const { modelUsageAttributionStorage } = await import('../usage-log.js');

function inSessionTurn<T>(sessionId: string, fn: () => T): T {
  return modelUsageAttributionStorage.run({ sessionId, sourceUserSeq: 1 }, fn);
}

function withEnv(over: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(over)) {
    prev[k] = process.env[k];
    if (over[k] === undefined) delete process.env[k];
    else process.env[k] = over[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(over)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

beforeEach(() => {
  __sessionBrainPinTest__.reset();
  // The live-availability check consults connected-provider catalogs, which do
  // not exist in this isolated home; the pin's serve-truth is what is under test.
  __sessionBrainPinTest__.setValidatorForTests(() => true);
});

test('a session KEEPS its pinned brain across a concurrent global switch; a NEW session gets the new default', () => {
  withEnv({ AUTH_MODE: 'claude_oauth', CLAUDE_MODEL: 'claude-opus-4-8', CLEMMY_MODEL_ROLES: undefined, MODEL_ROUTING_MODE: undefined }, () => {
    const a1 = inSessionTurn('sess-pin-a', () => resolveRoleModel('brain'));
    assert.equal(a1.modelId, 'claude-opus-4-8', 'session A first turn resolves the global default');

    // Another session flips the GLOBAL active brain mid-flight.
    process.env.AUTH_MODE = 'codex_oauth';

    const a2 = inSessionTurn('sess-pin-a', () => resolveRoleModel('brain'));
    assert.equal(a2.modelId, 'claude-opus-4-8', 'session A is NOT silently re-routed by the global flip');
    assert.equal(a2.source, 'session', 'the pin reports itself honestly as session-scoped');

    const b1 = inSessionTurn('sess-pin-b', () => resolveRoleModel('brain'));
    assert.notEqual(b1.modelId, 'claude-opus-4-8', 'a NEW session starts on the new global default');
  });
});

test('two sessions interleaved each keep their own brain (the acceptance pin)', () => {
  withEnv({ AUTH_MODE: 'claude_oauth', CLAUDE_MODEL: 'claude-sonnet-5', CLEMMY_MODEL_ROLES: undefined, MODEL_ROUTING_MODE: undefined }, () => {
    const a1 = inSessionTurn('sess-inter-a', () => resolveRoleModel('brain'));
    process.env.AUTH_MODE = 'codex_oauth';
    const b1 = inSessionTurn('sess-inter-b', () => resolveRoleModel('brain'));
    process.env.AUTH_MODE = 'claude_oauth';
    process.env.CLAUDE_MODEL = 'claude-haiku-4-5';
    const a2 = inSessionTurn('sess-inter-a', () => resolveRoleModel('brain'));
    const b2 = inSessionTurn('sess-inter-b', () => resolveRoleModel('brain'));
    assert.equal(a2.modelId, a1.modelId, 'session A keeps its own brain across interleaved flips');
    assert.equal(b2.modelId, b1.modelId, 'session B keeps its own brain across interleaved flips');
    assert.notEqual(a1.modelId, b1.modelId, 'the two sessions genuinely diverged');
  });
});

test('outside a turn (no session context) resolution follows the live global — settings snapshots stay truthful', () => {
  withEnv({ AUTH_MODE: 'claude_oauth', CLAUDE_MODEL: 'claude-opus-4-8', CLEMMY_MODEL_ROLES: undefined, MODEL_ROUTING_MODE: undefined }, () => {
    inSessionTurn('sess-pin-out', () => resolveRoleModel('brain'));
    process.env.AUTH_MODE = 'codex_oauth';
    const outside = resolveRoleModel('brain');
    assert.notEqual(outside.modelId, 'claude-opus-4-8', 'no-session resolution reads the live global setting');
  });
});

test('an explicit per-session switch re-pins THIS session without touching others', () => {
  withEnv({ AUTH_MODE: 'claude_oauth', CLAUDE_MODEL: 'claude-opus-4-8', CLEMMY_MODEL_ROLES: undefined, MODEL_ROUTING_MODE: undefined }, () => {
    inSessionTurn('sess-repin-a', () => resolveRoleModel('brain'));
    inSessionTurn('sess-repin-b', () => resolveRoleModel('brain'));

    process.env.AUTH_MODE = 'codex_oauth';
    const repinned = pinSessionBrain('sess-repin-a');
    assert.ok(repinned, 'explicit re-pin stamps the CURRENT global resolution');
    const a = inSessionTurn('sess-repin-a', () => resolveRoleModel('brain'));
    assert.notEqual(a.modelId, 'claude-opus-4-8', 'the switched session serves the newly chosen brain');
    const b = inSessionTurn('sess-repin-b', () => resolveRoleModel('brain'));
    assert.equal(b.modelId, 'claude-opus-4-8', 'the OTHER session keeps its pin');
  });
});

// CHARACTERIZATION: the brain has NO binding door (roleModelCapability refuses
// role='brain' bindings by design — "set through the active-brain provider
// switch"). The pin therefore sits between the (never-winning) binding tier and
// the global default: the ONLY brain doors are the global switch (new sessions)
// and the explicit per-session re-pin. Worker/judge bindings are untouched.
test('a brain role "binding" stays refused by design; the session pin still serves; worker bindings are unaffected', () => {
  withEnv({
    AUTH_MODE: 'claude_oauth',
    CLAUDE_MODEL: 'claude-opus-4-8',
    MODEL_ROUTING_MODE: undefined,
    BYO_MODEL_BASE_URL: 'https://api.example.test',
    BYO_MODEL_API_KEY: 'k',
    BYO_MODEL_ID: 'minimax-01',
    OPENAI_MODEL_WORKER: 'minimax-01',
    CLEMMY_MODEL_ROLES_REGISTRY: 'on',
    CLEMMY_MODEL_ROLES: undefined,
  }, () => {
    const first = inSessionTurn('sess-bind-a', () => resolveRoleModel('brain'));
    assert.equal(first.modelId, 'claude-opus-4-8');
    process.env.CLEMMY_MODEL_ROLES = JSON.stringify([
      { role: 'brain', modelId: 'minimax-01', scope: 'durable', source: 'settings' },
      { role: 'worker', modelId: 'minimax-01', scope: 'durable', source: 'settings' },
    ]);
    const bound = inSessionTurn('sess-bind-a', () => resolveRoleModel('brain'));
    assert.equal(bound.modelId, 'claude-opus-4-8', 'the refused brain binding does not displace the session pin');
    assert.equal(bound.source, 'session');
    const worker = inSessionTurn('sess-bind-a', () => resolveRoleModel('worker'));
    assert.equal(worker.modelId, 'minimax-01', 'worker bindings keep their own door — pin is brain-only');
    assert.equal(worker.source, 'settings');
  });
});

test('a pin whose brain is no longer live falls back to the global default and re-stamps', () => {
  withEnv({ AUTH_MODE: 'claude_oauth', CLAUDE_MODEL: 'claude-opus-4-8', CLEMMY_MODEL_ROLES: undefined, MODEL_ROUTING_MODE: undefined }, () => {
    inSessionTurn('sess-dead-pin', () => resolveRoleModel('brain'));
    assert.ok(pinnedBrainForSession('sess-dead-pin'));
    // The pinned brain's login dies; the live-check now refuses it.
    __sessionBrainPinTest__.setValidatorForTests((modelId) => modelId !== 'claude-opus-4-8');
    process.env.AUTH_MODE = 'codex_oauth';
    const rescued = inSessionTurn('sess-dead-pin', () => resolveRoleModel('brain'));
    assert.notEqual(rescued.modelId, 'claude-opus-4-8', 'a dead pinned brain is not dispatched');
    const restamped = pinnedBrainForSession('sess-dead-pin');
    assert.equal(restamped?.modelId, rescued.modelId, 'the healthy fallback is re-stamped as the new pin');
  });
});

test('releaseSessionBrainPin clears the pin (session lifecycle end)', () => {
  withEnv({ AUTH_MODE: 'claude_oauth', CLAUDE_MODEL: 'claude-opus-4-8', CLEMMY_MODEL_ROLES: undefined, MODEL_ROUTING_MODE: undefined }, () => {
    inSessionTurn('sess-release', () => resolveRoleModel('brain'));
    assert.ok(pinnedBrainForSession('sess-release'));
    releaseSessionBrainPin('sess-release');
    assert.equal(pinnedBrainForSession('sess-release'), null);
  });
});
