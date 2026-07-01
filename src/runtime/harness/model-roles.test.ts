/**
 * Run: npx tsx --test src/runtime/harness/model-roles.test.ts
 *
 * CHARACTERIZATION: with no bindings, resolveRoleModel('X') must report the
 * model id the registered provider will actually dispatch for that role.
 * Defaults follow the active brain, except explicit BYO worker/all-in modes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate from the host's ~/.clementine-next/.env: getRuntimeEnv() falls back to
// BASE_DIR/.env, so the per-test withEnv() permutations below must not inherit
// the operator's live AUTH_MODE / OPENAI_MODEL_PRIMARY / MODEL_ROUTING_MODE / BYO
// config (which made these characterization assertions fail on a configured dev
// box while passing in clean CI). Point BASE_DIR at an empty temp dir BEFORE
// config.js loads — hence the dynamic import (matches debate-model.test.ts).
process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-model-roles-test-'));
const {
  getActiveAuthMode,
  getClaudeBrainModel,
  getDebateCheckerModel,
  getWorkerModel,
  getModelRoutingMode,
  judgeChoice,
  MODELS,
} = await import('../../config.js');
const { resolveRoleModel, defaultForRole, modelRolesRegistryEnabled, judgeDefaultModel, codexSafeFast } = await import('./model-roles.js');
const { resolveProvider } = await import('./model-wire-registry.js');

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

// The judge should be a DIFFERENT LLM family than the brain when possible
// (feedback_judge_different_family). judgeDefaultModel is the PURE decision.
test('judgeDefaultModel: a Claude brain defaults to a cheap CODEX judge when Codex is logged in', () => {
  const m = judgeDefaultModel('claude', { claude: true, codex: true }, { crossFamilyEnabled: true, explicitJudgeChoice: '' });
  assert.equal(m, 'gpt-5.4-mini', 'cross-family cheap judge, not Claude-on-Claude');
});

test('judgeDefaultModel: a Codex brain defaults to a cheap CLAUDE judge when Claude is logged in', () => {
  const m = judgeDefaultModel('codex', { claude: true, codex: true }, { crossFamilyEnabled: true, explicitJudgeChoice: '' });
  assert.equal(m, 'claude-haiku-4-5');
});

test('judgeDefaultModel: FAILS OPEN to legacy ("") for a single-family user (no regression)', () => {
  // Claude brain, only Claude logged in → no different family → fall through.
  assert.equal(judgeDefaultModel('claude', { claude: true, codex: false }, { crossFamilyEnabled: true, explicitJudgeChoice: '' }), '');
  // Codex brain, only Codex logged in → fall through.
  assert.equal(judgeDefaultModel('codex', { claude: false, codex: true }, { crossFamilyEnabled: true, explicitJudgeChoice: '' }), '');
});

test('judgeDefaultModel: an EXPLICIT CLEMMY_DEBATE_JUDGE pin is honored (returns "" → legacy path)', () => {
  assert.equal(judgeDefaultModel('claude', { claude: true, codex: true }, { crossFamilyEnabled: true, explicitJudgeChoice: 'codex' }), '');
  assert.equal(judgeDefaultModel('claude', { claude: true, codex: true }, { crossFamilyEnabled: true, explicitJudgeChoice: 'claude' }), '');
});

test('judgeDefaultModel: kill-switch off → legacy ("") byte-identical', () => {
  assert.equal(judgeDefaultModel('claude', { claude: true, codex: true }, { crossFamilyEnabled: false, explicitJudgeChoice: '' }), '');
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

test('a durable role-wide binding overrides the default while its provider is live', () => {
  withEnv({
    BYO_MODEL_BASE_URL: 'https://api.example.test',
    BYO_MODEL_API_KEY: 'k',
    BYO_MODEL_ID: 'minimax-01',
    OPENAI_MODEL_WORKER: 'minimax-01',
    CLEMMY_MODEL_ROLES_REGISTRY: 'on',
    CLEMMY_MODEL_ROLES: JSON.stringify([{ role: 'worker', modelId: 'minimax-01', scope: 'durable', source: 'settings' }]),
  }, () => {
    const r = resolveRoleModel('worker');
    assert.equal(r.modelId, 'minimax-01');
    assert.equal(r.provider, 'byo');
    assert.equal(r.source, 'settings');
    assert.equal(r.inactiveBinding, undefined);
  });
});

test('a stale role-wide binding falls back to default and reports the inactive binding', () => {
  withEnv({
    AUTH_MODE: 'codex_oauth',
    MODEL_ROUTING_MODE: 'off',
    BYO_MODEL_BASE_URL: '',
    BYO_MODEL_API_KEY: '',
    BYO_MODEL_ID: 'deepseek-chat',
    OPENAI_MODEL_WORKER: 'deepseek-chat',
    CLEMMY_MODEL_ROLES_REGISTRY: 'on',
    CLEMMY_MODEL_ROLES: JSON.stringify([{ role: 'worker', modelId: 'deepseek-chat', scope: 'durable', source: 'settings' }]),
  }, () => {
    const r = resolveRoleModel('worker');
    assert.equal(r.modelId, MODELS.primary);
    assert.equal(r.provider, 'codex');
    assert.equal(r.source, 'default');
    assert.equal(r.inactiveBinding?.modelId, 'deepseek-chat');
    assert.equal(r.inactiveBinding?.provider, 'byo');
    assert.equal(r.inactiveBinding?.source, 'settings');
    assert.match(r.inactiveBinding?.reason ?? '', /No BYO backend is configured/);
  });
});

// ── Intent-scoped routing (Phase A) ──────────────────────────────
const BYO_ENV = { BYO_MODEL_BASE_URL: 'https://api.example.test', BYO_MODEL_API_KEY: 'k' };

test('intent-scoped worker binding wins over default; matchedIntent is set; a different intent misses', () => {
  withEnv({
    AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: undefined, ...BYO_ENV, BYO_MODEL_ID: 'minimax-01',
    CLEMMY_MODEL_ROLES_REGISTRY: 'on',
    CLEMMY_MODEL_ROLES: JSON.stringify([{ role: 'worker', modelId: 'minimax-01', whenIntent: 'design', scope: 'durable', source: 'chat-rule' }]),
  }, () => {
    const hit = resolveRoleModel('worker', 'design');
    assert.equal(hit.modelId, 'minimax-01');
    assert.equal(hit.provider, 'byo');
    assert.equal(hit.matchedIntent, 'design');
    // raw word slugifies to the stored slug → still matches
    assert.equal(resolveRoleModel('worker', 'Design').modelId, 'minimax-01');
    // a different intent → no match → default; no matchedIntent
    const miss = resolveRoleModel('worker', 'research');
    assert.equal(miss.modelId, MODELS.primary);
    assert.equal(miss.matchedIntent, undefined);
    // NO intent → byte-identical to before (default, since no role-wide rule)
    assert.equal(resolveRoleModel('worker').modelId, MODELS.primary);
    assert.equal(resolveRoleModel('worker').matchedIntent, undefined);
  });
});

test('two distinct-intent worker rules coexist with a role-wide rule; precedence is intent > role-wide > default', () => {
  withEnv({
    AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: undefined, ...BYO_ENV, BYO_MODEL_ID: 'minimax-01', OPENAI_MODEL_WORKER: 'deepseek-chat',
    CLEMMY_MODEL_ROLES_REGISTRY: 'on',
    CLEMMY_MODEL_ROLES: JSON.stringify([
      { role: 'worker', modelId: 'minimax-01', whenIntent: 'design', scope: 'durable', source: 'chat-rule' },
      { role: 'worker', modelId: 'deepseek-chat', whenIntent: 'research', scope: 'durable', source: 'chat-rule' },
      { role: 'worker', modelId: 'deepseek-chat', scope: 'durable', source: 'settings' },
    ]),
  }, () => {
    assert.equal(resolveRoleModel('worker', 'design').modelId, 'minimax-01');
    assert.equal(resolveRoleModel('worker', 'research').modelId, 'deepseek-chat');
    assert.equal(resolveRoleModel('worker', 'something-else').modelId, 'deepseek-chat', 'unmatched intent → role-wide');
    assert.equal(resolveRoleModel('worker').modelId, 'deepseek-chat', 'no intent → role-wide');
  });
});

test('a stale intent binding falls through to default and reports the inactive binding', () => {
  withEnv({
    AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'off', BYO_MODEL_BASE_URL: '', BYO_MODEL_API_KEY: '',
    CLEMMY_MODEL_ROLES_REGISTRY: 'on',
    CLEMMY_MODEL_ROLES: JSON.stringify([{ role: 'worker', modelId: 'minimax-01', whenIntent: 'design', scope: 'durable', source: 'chat-rule' }]),
  }, () => {
    const r = resolveRoleModel('worker', 'design');
    assert.equal(r.modelId, MODELS.primary, 'byo unconfigured → intent binding stale → default');
    assert.equal(r.source, 'default');
    assert.equal(r.inactiveBinding?.modelId, 'minimax-01');
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

// ── Codex-brain guard: a BYO model id leaked into the OPENAI_MODEL_* slot must
//    not silently route a Codex brain back to the BYO endpoint (the 2026-06-29
//    "switched the brain to Codex but everything still ran on GLM" incident). ──
test('codex_oauth brain: a BYO id polluting OPENAI_MODEL_PRIMARY falls back to the Codex default', () => {
  withEnv({ AUTH_MODE: 'codex_oauth', OPENAI_MODEL_PRIMARY: 'glm-5.2', MODEL_ROUTING_MODE: 'off' }, () => {
    assert.equal(getActiveAuthMode(), 'codex_oauth');
    assert.equal(defaultForRole('brain'), 'gpt-5.4', 'brain steers to the Codex default, not glm-5.2');
    assert.equal(resolveProvider(defaultForRole('brain')), 'codex', 'and it actually routes to Codex');
    // worker default follows the same guard
    assert.equal(resolveProvider(defaultForRole('worker')), 'codex', 'untagged worker also runs on Codex');
  });
});

test('codex_oauth brain: a healthy gpt primary is unchanged (byte-identical, not forced to the default)', () => {
  withEnv({ AUTH_MODE: 'codex_oauth', OPENAI_MODEL_PRIMARY: 'gpt-5.5', MODEL_ROUTING_MODE: 'off' }, () => {
    assert.equal(defaultForRole('brain'), 'gpt-5.5');
  });
});

test('the guard ONLY fires for codex_oauth — an api_key brain still reports its BYO primary', () => {
  withEnv({ AUTH_MODE: 'api_key', OPENAI_MODEL_PRIMARY: 'glm-5.2', MODEL_ROUTING_MODE: 'off' }, () => {
    assert.equal(defaultForRole('brain'), 'glm-5.2', 'api_key brain is untouched by the Codex guard');
  });
});

// ── P1: brain-safe fast fail-open (stop the GLM/BYO judge + warmup storm) ──
// The boundary judges and boot warmup fail open to MODELS.fast. When OPENAI_MODEL_FAST
// is repurposed to a BYO/GLM id, those (parallel) lanes stormed the BYO endpoint even
// though the user picked Codex for the brain — the observed 429 burst. codexSafeFast()
// keeps the fail-open on the brain's own family.
test('codexSafeFast: codex brain + a repurposed GLM fast slot NEVER fails open to BYO', () => {
  withEnv({ AUTH_MODE: 'codex_oauth', OPENAI_MODEL_PRIMARY: 'gpt-5.5', OPENAI_MODEL_FAST: 'glm-5.2', MODEL_ROUTING_MODE: 'off', BYO_MODEL_BASE_URL: undefined, BYO_MODEL_API_KEY: undefined }, () => {
    assert.equal(resolveProvider(MODELS.fast), 'byo', 'precondition: the fast slot holds a GLM/BYO id');
    const fast = codexSafeFast();
    assert.equal(resolveProvider(fast), 'codex', 'the judge/warmup fail-open stays on the Codex family, never BYO');
    assert.equal(fast, 'gpt-5.4-mini', 'uses the cheap code-level Codex judge id');
  });
});

test('codexSafeFast: a healthy codex fast slot is byte-identical (no rewrite)', () => {
  withEnv({ AUTH_MODE: 'codex_oauth', OPENAI_MODEL_PRIMARY: 'gpt-5.5', OPENAI_MODEL_FAST: 'gpt-5.4-mini', MODEL_ROUTING_MODE: 'off' }, () => {
    assert.equal(codexSafeFast(), 'gpt-5.4-mini', 'a codex fast slot is untouched');
  });
});

test('codexSafeFast: claude brain + GLM fast slot fails open to the cheap Claude judge, not BYO', () => {
  withEnv({ AUTH_MODE: 'claude_oauth', CLAUDE_MODEL: 'claude-opus-4-8', OPENAI_MODEL_FAST: 'glm-5.2', MODEL_ROUTING_MODE: 'off' }, () => {
    const fast = codexSafeFast();
    assert.equal(resolveProvider(fast), 'claude', 'a Claude brain fails open on the Claude family, never BYO');
  });
});

test('codexSafeFast: a genuine all_in BYO brain KEEPS the BYO fast slot (intended, not a storm)', () => {
  withEnv({
    AUTH_MODE: 'api_key', MODEL_ROUTING_MODE: 'all_in',
    BYO_MODEL_BASE_URL: 'https://api.example.test', BYO_MODEL_API_KEY: 'k', BYO_MODEL_ID: 'glm-5.2',
    OPENAI_MODEL_FAST: 'glm-5.2',
  }, () => {
    assert.equal(codexSafeFast(), 'glm-5.2', 'when the user really is on BYO, the fast slot is what they intend');
  });
});
