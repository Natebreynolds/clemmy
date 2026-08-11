/**
 * Run: npx tsx --test scripts/proof/provision.test.ts
 *
 * The live proof matrix must provision the same BYO provider registry the app
 * uses. This catches drift between Settings' BYO_PROVIDERS store and the
 * isolated GLM proof home.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  'OPENAI_API_KEY',
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
  proofProviderRequirements,
  assertProofModelAccessValidity,
  proofModelAccessValidityError,
  seedProofModelAccess,
  restartProofDaemonWithSanitation,
  terminateProofProviderProcess,
  proofStopMustRetainHome,
  provisionDaemon,
} = await import('./provision.js');

const { ISOLATED_CODEX_ACCESS_FILE } = await import('../lib/isolated-codex-auth.js');
const {
  captureProofHomeIdentity,
  captureProofStateIdentity,
  proofDaemonStopChecks,
  sanitizeProofHomeForForensics,
  trackProofChildOutput,
} = await import('./runtime-safety.js');

function jwtWithExp(expSeconds: number): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({
    exp: expSeconds,
    'https://api.openai.com/auth': { chatgpt_account_id: 'proof-account' },
  })}.sig`;
}

test.after(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

test('failed runtime-safety preflight creates no proof home, credentials, or provider child', async () => {
  const prefix = 'clemmy-proof-glm-';
  const before = readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(prefix)).sort();
  let preflightCalls = 0;
  await assert.rejects(
    () => provisionDaemon(planBrain('glm'), {
      runtimeSafetyPreflight: () => {
        preflightCalls += 1;
        throw new Error('injected native helper unavailable');
      },
    }),
    /injected native helper unavailable/i,
  );
  assert.equal(preflightCalls, 1);
  assert.deepEqual(
    readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(prefix)).sort(),
    before,
    'preflight refusal occurs before mkdtemp and therefore before credential copy or spawn',
  );
});

test('terminal provider with failed output drain still receives native restart sanitation and a red check', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-restart-drain-'));
  const credential = path.join(home, 'state', 'claude-auth.json');
  const child = spawn(process.execPath, ['-e', 'process.exit(23)'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const actualOutput = trackProofChildOutput(child, () => {});
  let cleanup: ReturnType<typeof sanitizeProofHomeForForensics> | undefined;
  try {
    mkdirSync(path.dirname(credential));
    writeFileSync(credential, '{"accessToken":"must-be-sanitized-after-exit"}', 'utf8');
    const identity = captureProofStateIdentity(captureProofHomeIdentity(home));
    await actualOutput.drained;
    assert.equal(child.exitCode, 23, 'the provider process is terminal before the injected drain fault');

    let providerLifecycle: 'active' | 'terminated' = 'active';
    const outputWithFailedIntegrity = {
      ...actualOutput,
      errors: () => ['stderr read failed after provider exit'],
    };
    const terminate = (): Promise<void> => terminateProofProviderProcess({
      child,
      output: outputWithFailedIntegrity,
      markProviderTerminated: () => { providerLifecycle = 'terminated'; },
      outputDrainTimeoutMs: 25,
    });
    let restartError = '';
    try {
      await restartProofDaemonWithSanitation({
        terminate,
        start: async () => { assert.fail('a failed drain must not start the replacement daemon'); },
        sanitize: () => {
          cleanup = sanitizeProofHomeForForensics(home, {
            identity,
            operations: {
              assertProviderTerminated: () => {
                if (providerLifecycle !== 'terminated') {
                  throw new Error('provider termination is unproven');
                }
              },
            },
          });
          return cleanup;
        },
      });
      assert.fail('restart must preserve the output-drain failure');
    } catch (error) {
      restartError = error instanceof Error ? error.message : String(error);
    }

    assert.match(restartError, /daemon output was not fully drained.*stderr read failed/i);
    assert.equal(providerLifecycle, 'terminated');
    assert.equal(cleanup?.status, 'succeeded');
    assert.equal(existsSync(credential), false, 'native sanitation removed the credential after terminal exit');
    const checks = proofDaemonStopChecks('codex', {
      retainedHome: true,
      forensicLog: { status: 'persisted', path: path.join(home, 'proof-daemon.log') },
      cleanup: cleanup ?? {
        intent: 'sanitize-and-retain', status: 'failed', homeExists: true,
      },
      shutdownError: restartError,
    });
    const shutdownCheck = checks.find((check) => check.name.includes('output closed'));
    assert.equal(shutdownCheck?.pass, false, 'incomplete drain remains report-visible red evidence');
    assert.match(shutdownCheck?.detail ?? '', /stderr read failed/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('proof log overflow forces sanitized retention even without a scenario failure', () => {
  assert.equal(proofStopMustRetainHome({ requested: false }), false);
  assert.equal(proofStopMustRetainHome({ requested: true }), true);
  assert.equal(proofStopMustRetainHome({
    requested: false,
    shutdownError: 'pipe integrity uncertain',
  }), true);
  assert.equal(proofStopMustRetainHome({
    requested: false,
    logCaptureError: 'semantic log window overflowed',
  }), true, 'sticky log evidence loss retains a sanitized forensic home');
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

test('glm proof expects the explicit cross-family worker binding preserved in the isolated daemon', () => {
  const priorRoles = process.env.CLEMMY_MODEL_ROLES;
  const priorWorker = process.env.OPENAI_MODEL_WORKER;
  process.env.CLEMMY_MODEL_ROLES = JSON.stringify([
    { role: 'worker', modelId: 'claude-sonnet-5', scope: 'durable', source: 'settings' },
    { role: 'judge', modelId: 'deepseek-chat', scope: 'durable', source: 'settings' },
  ]);
  process.env.OPENAI_MODEL_WORKER = 'gpt-5.4';
  try {
    const plan = planBrain('glm');
    assert.deepEqual(plan.expectedWorker, {
      modelId: 'claude-sonnet-5', provider: 'claude', source: 'role-binding',
    });
    assert.equal(
      plan.env.OPENAI_MODEL_WORKER,
      'glm-5.2',
      'the isolated daemon must not cold-probe the stale Codex slot on the BYO endpoint',
    );
    assert.equal(
      (JSON.parse(plan.env.CLEMMY_MODEL_ROLES) as Array<{ role: string; modelId: string }>)
        .some((binding) => binding.role === 'worker' && binding.modelId === 'claude-sonnet-5'),
      true,
      'proof provisioning keeps the binding that determines the worker route',
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

test('proof auth plan seeds provider families only for selected live routes', () => {
  const glm = planBrain('glm');
  assert.deepEqual(proofProviderRequirements(glm), { codex: false, claude: false });

  const codexWorker = {
    ...glm,
    expectedWorker: { modelId: 'gpt-5.6-sol', provider: 'codex' as const, source: 'role-binding' as const },
  };
  assert.deepEqual(
    proofProviderRequirements(codexWorker),
    { codex: false, claude: false },
    'an unselected worker route does not receive cross-family auth',
  );
  assert.deepEqual(
    proofProviderRequirements(codexWorker, { requireWorkerProvider: true }),
    { codex: true, claude: false },
    'an explicitly selected Codex worker route receives access-only auth',
  );

  const codexChecker = {
    ...glm,
    expectedFusionChecker: { modelId: 'gpt-5.6-sol', provider: 'codex' as const, source: 'fusion-fallback' as const },
  };
  assert.deepEqual(proofProviderRequirements(codexChecker, { fusionMode: 'off' }), { codex: false, claude: false });
  assert.deepEqual(proofProviderRequirements(codexChecker, { fusionMode: 'all' }), { codex: true, claude: false });

  const apiKeyCodex = {
    ...codexChecker,
    kind: 'codex' as const,
    env: { ...codexChecker.env, AUTH_MODE: 'api_key', OPENAI_API_KEY: 'test-only' },
    expectedBrain: { modelId: 'gpt-5.6-sol', provider: 'codex' as const, source: 'provider-slot' as const },
  };
  assert.deepEqual(proofProviderRequirements(apiKeyCodex), { codex: false, claude: false });
});

test('non-Codex proof legs do not receive a Codex file until an exact selected route requires it', () => {
  const sourceAuth = path.join(tmpHome, 'state', 'auth.json');
  const target = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-provider-seed-'));
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60;
  mkdirSync(path.dirname(sourceAuth), { recursive: true });
  writeFileSync(sourceAuth, JSON.stringify({
    source: 'native',
    codexOauth: {
      accessToken: jwtWithExp(expiresAt),
      refreshToken: 'real-refresh-token-must-stay-home',
      idToken: 'real-id-token-must-stay-home',
    },
  }), 'utf-8');

  try {
    const glm = planBrain('glm');
    seedProofModelAccess(target, glm, { codexAccessMinValidityMs: 5 * 60_000 });
    const accessFile = path.join(target, 'state', ISOLATED_CODEX_ACCESS_FILE);
    assert.equal(existsSync(accessFile), false, 'BYO-only plan receives no Codex credential');

    const codexWorker = {
      ...glm,
      expectedWorker: { modelId: 'gpt-5.6-sol', provider: 'codex' as const, source: 'role-binding' as const },
    };
    seedProofModelAccess(target, codexWorker, {
      requireWorkerProvider: true,
      codexAccessMinValidityMs: 5 * 60_000,
    });
    assert.equal(existsSync(accessFile), true);
    const raw = readFileSync(accessFile, 'utf-8');
    assert.doesNotMatch(raw, /refreshToken|real-refresh|idToken|real-id/);
    assert.equal(existsSync(path.join(target, 'state', 'auth.json')), false);
  } finally {
    rmSync(sourceAuth, { force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('Codex proof planning fails closed when the source access token is too near expiry', () => {
  const sourceAuth = path.join(tmpHome, 'state', 'auth.json');
  mkdirSync(path.dirname(sourceAuth), { recursive: true });
  try {
    writeFileSync(sourceAuth, JSON.stringify({
      source: 'native',
      codexOauth: {
        accessToken: jwtWithExp(Math.floor(Date.now() / 1000) + 60 * 60),
        refreshToken: 'stays-in-source-home',
      },
    }), 'utf-8');
    assert.equal(planBrain('codex').skipReason, undefined);

    writeFileSync(sourceAuth, JSON.stringify({
      source: 'native',
      codexOauth: {
        accessToken: jwtWithExp(Math.floor(Date.now() / 1000) + 5 * 60),
        refreshToken: 'stays-in-source-home',
      },
    }), 'utf-8');
    assert.match(planBrain('codex').skipReason ?? '', /at least 20 minutes remaining/i);
  } finally {
    rmSync(sourceAuth, { force: true });
  }
});

test('selected subscription access is revalidated against the next paid-call window', () => {
  const nowMs = Date.parse('2026-08-09T00:00:00.000Z');
  const access = {
    requirements: { codex: true, claude: false },
    codex: {
      source: 'clementine-vault' as const,
      expiresAt: new Date(nowMs + 17 * 60_000).toISOString(),
    },
    claude: null,
  };
  assert.equal(proofModelAccessValidityError(access, {
    nowMs,
    requiredValidityMs: 16 * 60_000,
  }), null);
  assert.match(proofModelAccessValidityError(access, {
    nowMs: nowMs + 2 * 60_000,
    requiredValidityMs: 16 * 60_000,
  }) ?? '', /Codex proof access expires.*safety window/i);
  assert.throws(
    () => assertProofModelAccessValidity(access, 16 * 60_000, nowMs + 2 * 60_000),
    /refused to start or continue.*Codex proof access expires/i,
  );

  assert.match(proofModelAccessValidityError({
    requirements: { codex: false, claude: true },
    codex: null,
    claude: { source: 'claude-code' as const },
  }, {
    nowMs,
    requiredValidityMs: 16 * 60_000,
  }) ?? '', /Claude proof access has no verifiable expiration/i);

  assert.equal(proofModelAccessValidityError({
    requirements: { codex: false, claude: false },
    codex: null,
    claude: null,
  }, {
    nowMs,
    requiredValidityMs: 16 * 60_000,
  }), null, 'unselected provider families do not block a BYO-only leg');
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
  });
  assert.equal(proofRuntimeOverrides('all').CLEMMY_DEBATE_MODE, 'all');
  assert.equal(proofRuntimeOverrides('all').CLEMMY_FUSION_STRATEGY, 'verify');
});

test('live proof gives spawned processes only the disposable home and never the real macOS keychain', () => {
  assert.deepEqual(proofProcessIsolationEnv('/tmp/proof-home'), {
    HOME: '/tmp/proof-home',
    ZDOTDIR: '/tmp/proof-home',
    CLEMMY_TEST_ISOLATED_HOME: '1',
  });
  assert.deepEqual(proofProcessIsolationEnv('C:\\proof-home', 'win32'), {
    HOME: 'C:\\proof-home',
    ZDOTDIR: 'C:\\proof-home',
    CLEMMY_TEST_ISOLATED_HOME: '1',
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

test('proof-local CLI search exposes one schema-grounded read and mutable provider state', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-search-feed-'));
  try {
    const shim = createProofComposioShim(home);
    writeFileSync(path.join(home, 'proof-composio-connected'), 'connected\n', 'utf8');
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const searched = JSON.parse(execFileSync(
      process.execPath,
      [shim, 'search', 'proof release queue current items', '--limit', '5'],
      { encoding: 'utf8', env },
    )) as {
      results?: Array<{ primary_tool_slugs?: string[] }>;
      tool_schemas?: { primary?: Record<string, string> };
    };
    assert.deepEqual(searched.results?.[0]?.primary_tool_slugs, ['PROOF_LIST_TASKS']);
    assert.equal(
      searched.tool_schemas?.primary?.PROOF_LIST_TASKS,
      '~/.composio/tool_definitions/PROOF_LIST_TASKS.json',
    );
    const storedSchema = JSON.parse(readFileSync(
      path.join(home, '.composio', 'tool_definitions', 'PROOF_LIST_TASKS.json'),
      'utf8',
    )) as { inputSchema?: unknown };
    assert.deepEqual(storedSchema.inputSchema, {
      type: 'object', properties: {}, additionalProperties: false,
    });

    writeFileSync(path.join(home, 'proof-task-feed-state.json'), JSON.stringify({
      revision: 2,
      id: 'proof-release-1',
      title: 'Review the Clementine 4 release proof',
      status: 'done',
    }), 'utf8');
    const read = JSON.parse(execFileSync(
      process.execPath,
      [shim, 'execute', 'PROOF_LIST_TASKS', '-d', '{}'],
      { encoding: 'utf8', env },
    )) as { successful?: boolean; data?: { revision?: number; items?: Array<{ status?: string }>; total?: number } };
    assert.equal(read.successful, true);
    assert.equal(read.data?.revision, 2);
    assert.equal(read.data?.items?.[0]?.status, 'done');
    assert.equal(read.data?.total, 1, 'proof provider emits an unambiguous collection total');
    assert.equal(readFileSync(path.join(home, 'proof-composio-searches.log'), 'utf8').trim().split('\n').length, 1);
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(home, 'proof-composio-successes.log'), 'utf8').trim()),
      { slug: 'PROOF_LIST_TASKS', payload: '{}' },
      'success evidence is appended only after exact payload validation and provider-state read',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
