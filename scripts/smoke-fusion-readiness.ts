/**
 * Fusion readiness smoke.
 *
 * Default mode is offline and deterministic:
 *   - validates model-role routing/picker truth
 *   - validates stale binding fallback
 *   - validates memory write -> recall -> harness primer injection
 *   - runs the targeted model-role/debate/failover tests
 *   - runs TypeScript typecheck
 *
 * Optional:
 *   --full runs production builds too.
 *   --live also runs the existing Claude tool-turn and debate live smokes using
 *   the user's real Clementine home/auth. Live mode spends model calls.
 *
 * Run:
 *   npm run smoke:fusion-readiness
 *   npm run smoke:fusion-readiness -- --full
 *   npm run smoke:fusion-readiness -- --live
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentInputItem, Runner } from '@openai/agents';
type RunRunnerFn = import('../src/runtime/harness/loop.js').RunRunnerFn;

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const REAL_CLEMENTINE_HOME = process.env.CLEMENTINE_HOME;
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-fusion-readiness-'));
const args = new Set(process.argv.slice(2));
const full = args.has('--full');
const live = args.has('--live') || process.env.CLEMMY_READINESS_LIVE === '1';

process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HARNESS_TOOL_BRACKETS = 'off';
process.env.CLEMMY_TURN_MEMORY_PRIMER = 'on';
process.env.CLEMMY_TURN_MEMORY_PRIMER_HYBRID = 'off';
process.env.CLEMMY_SEMANTIC_RECALL = 'off';
process.env.CLEMMY_MODEL_ROLES_REGISTRY = 'on';

mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
mkdirSync(path.join(TMP_HOME, 'vault', '02-Projects'), { recursive: true });
writeFileSync(
  path.join(TMP_HOME, 'vault', '02-Projects', 'fusion-readiness.md'),
  [
    '# Fusion readiness',
    '',
    'Clementine fusion readiness marker: BLUE LANTERN 917.',
    'Use this file to prove local memory search reaches the harness primer.',
  ].join('\n'),
  'utf-8',
);
writeFileSync(
  path.join(TMP_HOME, 'state', 'auth.json'),
  JSON.stringify({ codexOauth: { accessToken: 'codex-access', refreshToken: 'codex-refresh' } }),
  'utf-8',
);
writeFileSync(
  path.join(TMP_HOME, 'state', 'claude-auth.json'),
  JSON.stringify({
    accessToken: 'sk-ant-oat01-readiness',
    refreshToken: 'claude-refresh',
    expiresAt: Date.now() + 60 * 60 * 1000,
  }),
  'utf-8',
);

type CheckResult = { name: string; ok: boolean; detail: string };
const results: CheckResult[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} - ${detail}`);
}

async function check(name: string, fn: () => Promise<string> | string): Promise<void> {
  try {
    record(name, true, await fn());
  } catch (err) {
    record(name, false, err instanceof Error ? err.message : String(err));
  }
}

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    prev[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

function runCommand(name: string, command: string, commandArgs: string[], env = process.env): boolean {
  console.log(`\n$ ${[command, ...commandArgs].join(' ')}`);
  const res = spawnSync(command, commandArgs, {
    cwd: ROOT,
    env: { ...env },
    stdio: 'inherit',
  });
  const ok = res.status === 0;
  record(name, ok, ok ? `exit ${res.status}` : `exit ${res.status ?? 'signal ' + String(res.signal)}`);
  return ok;
}

function makeRunnerStub(): Runner {
  return new EventEmitter() as unknown as Runner;
}

function makeAgentStub(): import('@openai/agents').Agent<any, any> {
  return {} as import('@openai/agents').Agent<any, any>;
}

async function main(): Promise<void> {
  console.log('\n=== Clementine Fusion Readiness Smoke ===\n');
  console.log(`Temp CLEMENTINE_HOME: ${TMP_HOME}`);
  console.log(`Mode: offline${full ? ' + full builds' : ''}${live ? ' + live model smokes' : ''}\n`);

  const { MODELS } = await import('../src/config.js');
  const {
    connectedModelGroupsForRole,
    validateRoleModelBinding,
  } = await import('../src/runtime/harness/model-role-options.js');
  const { resolveRoleModel } = await import('../src/runtime/harness/model-roles.js');
  const { rememberFact, searchFactsByText, setFactPinned } = await import('../src/memory/facts.js');
  const { renderHarnessMemoryContext } = await import('../src/agents/harness-context.js');
  const { HarnessSession } = await import('../src/runtime/harness/session.js');
  const { runTurn } = await import('../src/runtime/harness/loop.js');
  const { listEvents, resetEventLog } = await import('../src/runtime/harness/eventlog.js');
  const { closeMemoryDb } = await import('../src/memory/db.js');

  await check('role picker filters BYO worker/judge capabilities', () => {
    withEnv({
      AUTH_MODE: 'codex_oauth',
      MODEL_ROUTING_MODE: 'off',
      BYO_MODEL_BASE_URL: 'https://api.example.test',
      BYO_MODEL_API_KEY: 'k',
      BYO_MODEL_ID: 'deepseek-chat',
      BYO_MODEL_JUDGE_ID: 'minimax-judge',
      OPENAI_MODEL_WORKER: 'qwen-worker',
      CLEMMY_MODEL_ROLES: '',
    }, () => {
      const workerIds = new Set(connectedModelGroupsForRole('worker').flatMap((g) => g.models.map((m) => m.id)));
      const judgeIds = new Set(connectedModelGroupsForRole('judge').flatMap((g) => g.models.map((m) => m.id)));
      assert.equal(workerIds.has('qwen-worker'), true);
      assert.equal(workerIds.has('minimax-judge'), false);
      assert.equal(judgeIds.has('minimax-judge'), true);
      assert.equal(judgeIds.has('qwen-worker'), false);
      assert.equal(validateRoleModelBinding('worker', 'minimax-judge').ok, false);
      assert.equal(validateRoleModelBinding('judge', 'qwen-worker').ok, false);
    });
    return 'worker-only and judge-only BYO ids stay in their lanes';
  });

  await check('stale role binding falls back instead of dispatching dead BYO', () => {
    withEnv({
      AUTH_MODE: 'codex_oauth',
      MODEL_ROUTING_MODE: 'off',
      BYO_MODEL_BASE_URL: '',
      BYO_MODEL_API_KEY: '',
      BYO_MODEL_ID: 'deepseek-chat',
      OPENAI_MODEL_WORKER: 'deepseek-chat',
      CLEMMY_MODEL_ROLES: JSON.stringify([{ role: 'worker', modelId: 'deepseek-chat', scope: 'durable', source: 'settings' }]),
    }, () => {
      const r = resolveRoleModel('worker');
      assert.equal(r.modelId, MODELS.primary);
      assert.equal(r.provider, 'codex');
      assert.equal(r.source, 'default');
      assert.equal(r.inactiveBinding?.modelId, 'deepseek-chat');
      assert.match(r.inactiveBinding?.reason ?? '', /No BYO backend is configured/);
    });
    return 'inactive binding is reported and runtime uses the default';
  });

  await check('live BYO worker binding wins when backend is configured', () => {
    withEnv({
      AUTH_MODE: 'codex_oauth',
      MODEL_ROUTING_MODE: 'off',
      BYO_MODEL_BASE_URL: 'https://api.example.test',
      BYO_MODEL_API_KEY: 'k',
      BYO_MODEL_ID: 'deepseek-chat',
      OPENAI_MODEL_WORKER: 'deepseek-chat',
      CLEMMY_MODEL_ROLES: JSON.stringify([{ role: 'worker', modelId: 'deepseek-chat', scope: 'durable', source: 'settings' }]),
    }, () => {
      const r = resolveRoleModel('worker');
      assert.equal(r.modelId, 'deepseek-chat');
      assert.equal(r.provider, 'byo');
      assert.equal(r.source, 'settings');
      assert.equal(r.inactiveBinding, undefined);
    });
    return 'configured worker binding resolves to BYO';
  });

  await check('memory fact write -> text recall -> prompt injection', () => {
    const fact = rememberFact({
      kind: 'user',
      content: 'Fusion readiness direct fact marker is ORANGE BRIDGE 729.',
      importance: 8,
    });
    setFactPinned(fact.id, true);
    const hits = searchFactsByText('What is the fusion readiness direct fact marker?', 5);
    assert.ok(hits.some((h) => h.content.includes('ORANGE BRIDGE 729')), 'direct fact was not retrieved by text search');
    const ctx = renderHarnessMemoryContext();
    assert.match(ctx, /ORANGE BRIDGE 729/);
    return 'fact is retrievable and appears in harness memory context';
  });

  await check('harness turn injects memory primer before model call', async () => {
    resetEventLog();
    const sess = HarnessSession.create({ kind: 'chat', title: 'readiness-memory-primer' });
    let filteredInput: AgentInputItem[] = [];
    const runRunner: RunRunnerFn = async (_runner, _agent, items, opts) => {
      const filter = opts.callModelInputFilter as
        | ((args: { modelData: { input: AgentInputItem[]; instructions?: string } }) => { input: AgentInputItem[]; instructions?: string })
        | undefined;
      assert.equal(typeof filter, 'function');
      filteredInput = filter!({ modelData: { input: items, instructions: 'base instructions' } }).input;
      return {
        history: [...items, { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] }],
        lastResponseId: undefined,
        finalOutput: 'ok',
      };
    };
    await runTurn({
      agent: makeAgentStub(),
      sessionId: sess.id,
      input: 'Please recall the fusion readiness marker BLUE LANTERN 917 and ORANGE BRIDGE 729.',
      makeRunner: makeRunnerStub,
      runRunner,
    });
    const primer = filteredInput.find((item) =>
      (item as { role?: unknown }).role === 'system'
      && typeof (item as { content?: unknown }).content === 'string'
      && (item as { content: string }).content.includes('[MEMORY PRIMER]'),
    ) as { content: string } | undefined;
    assert.ok(primer, 'memory primer was not injected into model input');
    assert.match(primer.content, /ORANGE BRIDGE 729|BLUE LANTERN 917/);
    const events = listEvents(sess.id, { types: ['turn_memory_primer'] });
    assert.equal(events.length, 1);
    assert.equal(events[0].data.injected, true);
    assert.ok(Number(events[0].data.hitCount ?? 0) >= 0);
    return 'turn_memory_primer event emitted and model input includes memory';
  });

  runCommand('targeted role/debate/failover tests', 'npx', [
    'tsx',
    '--test',
    'src/runtime/harness/model-role-options.test.ts',
    'src/runtime/harness/model-roles.test.ts',
    'src/runtime/harness/debate-model.test.ts',
    'src/runtime/harness/fallback-model.test.ts',
  ]);

  runCommand('typescript typecheck', 'npm', ['run', 'typecheck']);

  if (full) {
    runCommand('server build', 'npm', ['run', 'build']);
    runCommand('console web build', 'npm', ['run', 'build:console-web']);
  }

  if (live) {
    const liveEnv: NodeJS.ProcessEnv = { ...process.env };
    if (REAL_CLEMENTINE_HOME === undefined) delete liveEnv.CLEMENTINE_HOME;
    else liveEnv.CLEMENTINE_HOME = REAL_CLEMENTINE_HOME;
    runCommand('live Claude tool-turn smoke', 'npx', ['tsx', 'scripts/diag-claude-toolturn.ts'], liveEnv);
    runCommand('live fusion debate smoke', 'npx', ['tsx', 'scripts/debate-smoke.ts'], liveEnv);
  } else {
    console.log('\nLive model smokes skipped. Run with --live or CLEMMY_READINESS_LIVE=1 to spend real Claude/Codex calls.');
  }

  closeMemoryDb();
  const failed = results.filter((r) => !r.ok);
  console.log('\n=== Readiness Summary ===');
  console.log(`${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`- ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log('Fusion readiness gate passed.');
  }
}

try {
  await main();
} finally {
  try {
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    // best effort
  }
}
