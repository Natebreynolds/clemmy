/**
 * Run: npx tsx --test src/runtime/harness/model-roles.test.ts
 *
 * CHARACTERIZATION: with no bindings, resolveRoleModel('X') must report the
 * model id the registered provider will actually dispatch for that role.
 * Defaults follow the active brain, except explicit BYO worker/all-in modes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getActiveAuthMode,
  getClaudeBrainModel,
  getDebateCheckerModel,
  getWorkerModel,
  getModelRoutingMode,
  judgeChoice,
  MODELS,
} from '../../config.js';
import { resolveRoleModel, defaultForRole, modelRolesRegistryEnabled } from './model-roles.js';
import { resolveProvider } from './model-wire-registry.js';

/** Set env keys for a permutation, run fn, restore. */
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

// The legacy brain id for the non-all_in permutations (all_in needs byo setup,
// covered when the brain call site is repointed).
function legacyBrain(): string {
  return getActiveAuthMode() === 'claude_oauth' ? getClaudeBrainModel() : MODELS.primary;
}
function legacyJudge(): string {
  return judgeChoice() === 'claude' ? getDebateCheckerModel() : MODELS.primary;
}

test('resolveProvider: claude-* → claude, gpt-5/o# → codex, byo families + unknown → byo', () => {
  assert.equal(resolveProvider('claude-opus-4-8'), 'claude');
  assert.equal(resolveProvider('claude-sonnet-4-6'), 'claude');
  assert.equal(resolveProvider('claude-haiku-4-5'), 'claude');
  assert.equal(resolveProvider('gpt-5.4'), 'codex');
  assert.equal(resolveProvider('gpt-5.5'), 'codex');
  assert.equal(resolveProvider('o3'), 'codex');
  assert.equal(resolveProvider('deepseek-chat'), 'byo');
  assert.equal(resolveProvider('minimax-01'), 'byo');
  assert.equal(resolveProvider('some-unknown-model'), 'byo', 'unknown id is a legitimate BYO model, not a misconfig');
  assert.equal(resolveProvider(''), 'byo');
});

test('worker default follows the active brain unless worker BYO offload is enabled', () => {
  withEnv({ AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: undefined, OPENAI_MODEL_WORKER: undefined, CLEMMY_MODEL_ROLES: undefined }, () => {
    assert.equal(resolveRoleModel('worker').modelId, MODELS.primary, 'codex default worker == codex primary');
  });
  withEnv({ AUTH_MODE: 'claude_oauth', CLAUDE_MODEL: 'claude-sonnet-4-6', MODEL_ROUTING_MODE: undefined, OPENAI_MODEL_WORKER: undefined, CLEMMY_MODEL_ROLES: undefined }, () => {
    assert.equal(resolveRoleModel('worker').modelId, 'claude-sonnet-4-6', 'claude default worker follows the claude brain');
    assert.equal(resolveRoleModel('worker').provider, 'claude');
  });
  withEnv({ AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'worker', BYO_MODEL_BASE_URL: 'https://api.example.test', BYO_MODEL_API_KEY: 'k', BYO_MODEL_ID: 'deepseek-chat', OPENAI_MODEL_WORKER: 'deepseek-chat', CLEMMY_MODEL_ROLES: undefined }, () => {
    assert.equal(resolveRoleModel('worker').modelId, getWorkerModel());
    assert.equal(resolveRoleModel('worker').modelId, 'deepseek-chat');
    assert.equal(resolveRoleModel('worker').provider, 'byo');
  });
});

test('GOLDEN: judge resolves to the checker model (claude) or codex primary', () => {
  withEnv({ CLEMMY_DEBATE_JUDGE: 'claude', CLEMMY_DEBATE_CHECKER_MODEL: undefined }, () => {
    assert.equal(resolveRoleModel('judge').modelId, legacyJudge());
    assert.equal(resolveRoleModel('judge').modelId, getDebateCheckerModel());
    assert.equal(resolveRoleModel('judge').provider, 'claude');
  });
  withEnv({ CLEMMY_DEBATE_JUDGE: 'codex' }, () => {
    assert.equal(resolveRoleModel('judge').modelId, legacyJudge());
    assert.equal(resolveRoleModel('judge').provider, 'codex');
  });
  withEnv({ CLEMMY_DEBATE_JUDGE: 'claude', CLEMMY_DEBATE_CHECKER_MODEL: 'claude-haiku-4-5' }, () => {
    assert.equal(resolveRoleModel('judge').modelId, 'claude-haiku-4-5');
  });
});

test('GOLDEN: brain resolves to the Codex primary (api_key/codex) or the Claude brain (claude_oauth)', () => {
  withEnv({ AUTH_MODE: 'api_key', MODEL_ROUTING_MODE: undefined }, () => {
    assert.equal(resolveRoleModel('brain').modelId, legacyBrain());
    assert.equal(resolveRoleModel('brain').modelId, MODELS.primary);
    assert.equal(resolveRoleModel('brain').provider, 'codex');
  });
  withEnv({ AUTH_MODE: 'claude_oauth', CLAUDE_MODEL: undefined }, () => {
    assert.equal(resolveRoleModel('brain').modelId, legacyBrain());
    assert.equal(resolveRoleModel('brain').modelId, getClaudeBrainModel());
    assert.equal(resolveRoleModel('brain').provider, 'claude');
  });
  withEnv({ AUTH_MODE: 'claude_oauth', CLAUDE_MODEL: 'claude-opus-4-8' }, () => {
    assert.equal(resolveRoleModel('brain').modelId, 'claude-opus-4-8');
  });
});

test('all_in BYO defaults report the BYO models the router will actually use', () => {
  withEnv({
    AUTH_MODE: 'api_key',
    MODEL_ROUTING_MODE: 'all_in',
    BYO_MODEL_BASE_URL: 'https://api.example.test',
    BYO_MODEL_API_KEY: 'k',
    BYO_MODEL_ID: 'deepseek-chat',
    BYO_MODEL_JUDGE_ID: 'minimax-judge',
    OPENAI_MODEL_WORKER: 'deepseek-worker',
    CLEMMY_MODEL_ROLES: undefined,
  }, () => {
    assert.equal(resolveRoleModel('brain').modelId, 'deepseek-chat');
    assert.equal(resolveRoleModel('worker').modelId, 'deepseek-worker');
    assert.equal(resolveRoleModel('judge').modelId, 'minimax-judge');
    assert.equal(resolveRoleModel('brain').provider, 'byo');
    assert.equal(resolveRoleModel('worker').provider, 'byo');
    assert.equal(resolveRoleModel('judge').provider, 'byo');
  });
});

test('all_in BYO with an UNSET worker reports the BYO primary, not a phantom gpt id (BUG 2)', () => {
  withEnv({
    AUTH_MODE: 'api_key',
    MODEL_ROUTING_MODE: 'all_in',
    BYO_MODEL_BASE_URL: 'https://api.example.test',
    BYO_MODEL_API_KEY: 'k',
    BYO_MODEL_ID: 'deepseek-chat',
    OPENAI_MODEL_WORKER: undefined, // getWorkerModel() falls back to a gpt-* id…
    CLEMMY_MODEL_ROLES: undefined,
  }, () => {
    // …but the router collapses it to the BYO primary in all_in, so the snapshot
    // must report what the wire actually sends.
    assert.equal(resolveRoleModel('worker').modelId, 'deepseek-chat');
    assert.equal(resolveRoleModel('worker').provider, 'byo');
  });
});

test('a durable role-wide binding overrides the default and carries the derived provider', () => {
  withEnv({ CLEMMY_MODEL_ROLES_REGISTRY: 'on', CLEMMY_MODEL_ROLES: JSON.stringify([{ role: 'worker', modelId: 'minimax-01', scope: 'durable', source: 'settings' }]) }, () => {
    const r = resolveRoleModel('worker');
    assert.equal(r.modelId, 'minimax-01');
    assert.equal(r.provider, 'byo');
    assert.equal(r.source, 'settings');
  });
});

test('kill-switch off: bindings ignored, pure default', () => {
  withEnv({ AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: undefined, CLEMMY_MODEL_ROLES_REGISTRY: 'off', CLEMMY_MODEL_ROLES: JSON.stringify([{ role: 'worker', modelId: 'minimax-01', scope: 'durable', source: 'settings' }]) }, () => {
    assert.equal(modelRolesRegistryEnabled(), false);
    assert.equal(resolveRoleModel('worker').modelId, MODELS.primary, 'binding ignored → default');
    assert.equal(resolveRoleModel('worker').source, 'default');
  });
});

test('bad/empty CLEMMY_MODEL_ROLES → no bindings → pure defaults (never throws)', () => {
  for (const bad of ['', 'not json', '{}', '[{"role":"nope"}]', '[42]']) {
    withEnv({ AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: undefined, CLEMMY_MODEL_ROLES_REGISTRY: 'on', CLEMMY_MODEL_ROLES: bad }, () => {
      assert.equal(resolveRoleModel('worker').modelId, MODELS.primary);
      assert.equal(resolveRoleModel('worker').source, 'default');
    });
  }
});

test('defaultForRole matches resolveRoleModel default path for every role', () => {
  withEnv({ CLEMMY_MODEL_ROLES: undefined }, () => {
    for (const role of ['brain', 'worker', 'judge'] as const) {
      assert.equal(resolveRoleModel(role).modelId, defaultForRole(role));
    }
  });
});
