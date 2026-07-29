/**
 * Run: npx tsx --test scripts/proof/provision.test.ts
 *
 * The live proof matrix must provision the same BYO provider registry the app
 * uses. This catches drift between Settings' BYO_PROVIDERS store and the
 * isolated GLM proof home.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-provision-test-'));
mkdirSync(tmpHome, { recursive: true });
process.env.CLEMENTINE_HOME = tmpHome;

const ENV_KEYS = [
  'BYO_MODEL_ID',
  'BYO_MODEL_BASE_URL',
  'BYO_MODEL_API_KEY',
  'BYO_PROVIDERS',
  'BYO_PROVIDERS_JSON',
  'BYO_PROVIDER_DEEPSEEK_API_KEY',
  'CLAUDE_MODEL',
  'OPENAI_MODEL_PRIMARY',
  'OPENAI_MODEL_WORKER',
  'CLEMMY_MODEL_ROLES',
  'CLEMMY_MODEL_ROLES_REGISTRY',
  'CLEMMY_DEBATE_JUDGE',
];
for (const k of ENV_KEYS) delete process.env[k];

const registry = JSON.stringify([
  { id: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com', modelIds: ['deepseek-chat'] },
]);
writeFileSync(path.join(tmpHome, '.env'), [
  'CLAUDE_MODEL=claude-sonnet-5',
  'OPENAI_MODEL_PRIMARY=gpt-5.6-sol',
  'BYO_MODEL_ID=glm-5.2',
  'BYO_MODEL_BASE_URL=https://api.z.ai/api/paas/v4',
  'BYO_MODEL_API_KEY=zai-secret',
  `BYO_PROVIDERS=${registry}`,
  'BYO_PROVIDER_DEEPSEEK_API_KEY=deepseek-secret',
  `CLEMMY_MODEL_ROLES=${JSON.stringify([
    { role: 'brain', modelId: 'deepseek-chat', scope: 'durable', source: 'settings' },
    { role: 'worker', modelId: 'deepseek-chat', scope: 'durable', source: 'settings' },
    { role: 'judge', modelId: 'deepseek-chat', scope: 'durable', source: 'settings' },
  ])}`,
  'CLEMMY_MODEL_ROLES_REGISTRY=on',
  'CLEMMY_DEBATE_JUDGE=claude',
  '',
].join('\n'));

const {
  planBrain,
  proofProcessIsolationEnv,
  proofRuntimeOverrides,
  createProofComposioShim,
  PROOF_COMPOSIO_DEFAULT_ACCOUNT_TOOLKITS,
  seedProofComposioDefaultAccountAuthorities,
} = await import('./provision.js');

test.after(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

test('glm proof plan copies BYO_PROVIDERS and per-provider key slots', () => {
  const plan = planBrain('glm');
  assert.equal(plan.skipReason, undefined);
  assert.equal(plan.env.BYO_MODEL_ID, 'glm-5.2');
  assert.equal(plan.env.BYO_MODEL_API_KEY, 'zai-secret');
  assert.equal(plan.env.BYO_PROVIDERS, registry);
  assert.equal(plan.env.BYO_PROVIDER_DEEPSEEK_API_KEY, 'deepseek-secret');
  assert.equal(plan.expectedBrain.modelId, 'glm-5.2', 'global brain binding cannot override the GLM matrix lane');
  assert.deepEqual(plan.expectedWorker, {
    modelId: 'deepseek-chat', provider: 'byo', source: 'role-binding',
  });
  assert.equal(
    plan.env.OPENAI_MODEL_WORKER,
    'glm-5.2',
    'the legacy fallback stays on the default BYO provider; the durable named-provider binding wins separately',
  );
  assert.deepEqual(plan.expectedFusionChecker, {
    modelId: 'deepseek-chat', provider: 'byo', source: 'role-binding',
  });
  assert.equal(
    (JSON.parse(plan.env.CLEMMY_MODEL_ROLES) as Array<{ role: string }>).some((binding) => binding.role === 'brain'),
    false,
    'the isolated matrix removes only global brain bindings',
  );
});

test('glm proof ignores an inactive Codex worker binding and pins the all-in BYO worker', () => {
  const priorRoles = process.env.CLEMMY_MODEL_ROLES;
  const priorWorker = process.env.OPENAI_MODEL_WORKER;
  process.env.CLEMMY_MODEL_ROLES = JSON.stringify([
    { role: 'worker', modelId: 'gpt-5.6-luna', scope: 'durable', source: 'settings' },
    { role: 'judge', modelId: 'deepseek-chat', scope: 'durable', source: 'settings' },
  ]);
  process.env.OPENAI_MODEL_WORKER = 'gpt-5.4';
  try {
    const plan = planBrain('glm');
    assert.deepEqual(plan.expectedWorker, {
      modelId: 'glm-5.2', provider: 'byo', source: 'provider-slot',
    });
    assert.equal(
      plan.env.OPENAI_MODEL_WORKER,
      'glm-5.2',
      'the isolated daemon must not cold-probe the stale Codex slot on the BYO endpoint',
    );
    assert.equal(
      (JSON.parse(plan.env.CLEMMY_MODEL_ROLES) as Array<{ role: string; modelId: string }>)
        .some((binding) => binding.role === 'worker' && binding.modelId === 'gpt-5.6-luna'),
      true,
      'proof provisioning does not mutate durable role bindings; all-in merely leaves this one inactive',
    );
  } finally {
    if (priorRoles === undefined) delete process.env.CLEMMY_MODEL_ROLES;
    else process.env.CLEMMY_MODEL_ROLES = priorRoles;
    if (priorWorker === undefined) delete process.env.OPENAI_MODEL_WORKER;
    else process.env.OPENAI_MODEL_WORKER = priorWorker;
  }
});

test('codex proof copies non-secret role selection while pinning the exact configured brain slot', () => {
  const plan = planBrain('codex');
  assert.equal(plan.env.OPENAI_MODEL_PRIMARY, 'gpt-5.6-sol');
  assert.equal(plan.expectedBrain.modelId, 'gpt-5.6-sol');
  assert.equal(plan.expectedBrain.provider, 'codex');
  assert.equal(plan.expectedWorker.modelId, 'deepseek-chat');
  assert.equal(plan.expectedFusionChecker.modelId, 'deepseek-chat');
});

test('live proof defaults Fusion off and only enables it through an explicit canary mode', () => {
  assert.deepEqual(proofRuntimeOverrides(), {
    CLEMMY_BRAIN_FALLOVER: 'off',
    CLEMMY_AUTH_FALLOVER: 'off',
    CLEMMY_CLAUDE_OVERLOAD_FALLBACK: 'off',
    CLEMMY_LEGACY_RESPOND_FALLBACK: 'off',
    CLEMMY_ROUTE_POLICY: 'off',
    CLEMMY_DEBATE_MODE: 'off',
    CLEMMY_FUSION_STRATEGY: 'verify',
    CLEMMY_JUDGE_CROSS_FAMILY: 'off',
    CLEMMY_LONGTASK_APPROACH_BEAT: 'off',
  });
  assert.equal(proofRuntimeOverrides('all').CLEMMY_DEBATE_MODE, 'all');
  assert.equal(proofRuntimeOverrides('all').CLEMMY_FUSION_STRATEGY, 'verify');
});

test('live proof gives spawned CLIs only the disposable home and dotfiles', () => {
  assert.deepEqual(proofProcessIsolationEnv('/tmp/proof-home'), {
    HOME: '/tmp/proof-home',
    ZDOTDIR: '/tmp/proof-home',
  });
  assert.deepEqual(proofProcessIsolationEnv('C:\\proof-home', 'win32'), {
    HOME: 'C:\\proof-home',
    ZDOTDIR: 'C:\\proof-home',
    USERPROFILE: 'C:\\proof-home',
    HOMEDRIVE: 'C:',
    HOMEPATH: '\\proof-home',
  });
});

test('selectable proof toolkits load as real durable CLI-default authorities', async () => {
  const file = seedProofComposioDefaultAccountAuthorities(tmpHome);
  const stored = JSON.parse(readFileSync(file, 'utf8')) as {
    version?: number;
    grants?: Record<string, { kind?: string; toolkit?: string; label?: string; grantId?: string }>;
  };
  assert.equal(stored.version, 1);
  assert.deepEqual(Object.keys(stored.grants ?? {}).sort(), [...PROOF_COMPOSIO_DEFAULT_ACCOUNT_TOOLKITS].sort());

  const {
    listComposioCliDefaultAccountAuthorities,
    verifyComposioCliDefaultAccountAuthority,
  } = await import('../../src/integrations/composio/cli-default-account-authority.js');
  const loaded = listComposioCliDefaultAccountAuthorities();
  assert.deepEqual(loaded.map((row) => row.toolkit).sort(), [...PROOF_COMPOSIO_DEFAULT_ACCOUNT_TOOLKITS].sort());
  for (const row of loaded) {
    assert.equal(row.kind, 'composio_cli_default_account');
    assert.match(row.label, /^isolated-proof /);
    assert.equal(verifyComposioCliDefaultAccountAuthority(row).ok, true);
  }
});

test('proof-local task feed is a dynamic read result with no real provider', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-task-feed-'));
  try {
    const shim = createProofComposioShim(home);
    writeFileSync(path.join(home, 'proof-composio-connected'), 'connected\n', 'utf8');
    const raw = execFileSync(
      process.execPath,
      [shim, 'execute', 'PROOF_TASKS_LIST', '-d', '{"scope":"isolated-proof"}'],
      {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, USERPROFILE: home },
      },
    );
    const result = JSON.parse(raw) as {
      successful?: boolean;
      data?: { tasks?: Array<{ id?: string; status?: string }>; count?: number };
    };
    assert.equal(result.successful, true);
    assert.equal(result.data?.count, 1);
    assert.deepEqual(result.data?.tasks?.map((task) => [task.id, task.status]), [
      ['proof-task-1', 'open'],
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
