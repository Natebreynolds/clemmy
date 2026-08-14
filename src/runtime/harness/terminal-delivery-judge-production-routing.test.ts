/**
 * Production connection topology for the independent terminal-delivery judge.
 *
 * Run: npx tsx --test src/runtime/harness/terminal-delivery-judge-production-routing.test.ts
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-terminal-judge-routing-'));
const STATE_DIR = path.join(TEST_HOME, 'state');
const CODEX_AUTH_FILE = path.join(STATE_DIR, 'auth.json');
const CLAUDE_AUTH_FILE = path.join(STATE_DIR, 'claude-auth.json');
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(STATE_DIR, { recursive: true });

const {
  evaluateTerminalDelivery,
  resolveProductionTerminalDeliveryJudgeRoute,
  selectIndependentTerminalDeliveryJudgeRoute,
} = await import('./terminal-delivery-judge.js');

after(() => rmSync(TEST_HOME, { recursive: true, force: true }));

function writeConnections(codex: boolean): void {
  writeFileSync(CLAUDE_AUTH_FILE, JSON.stringify({
    accessToken: 'sk-ant-oat01-terminal-judge-routing',
    refreshToken: 'claude-refresh',
    expiresAt: Date.now() + 60 * 60 * 1000,
  }), 'utf8');
  writeFileSync(CODEX_AUTH_FILE, codex
    ? JSON.stringify({
      source: 'native',
      codexOauth: { accessToken: 'codex-access', refreshToken: 'codex-refresh' },
    })
    : '{}', 'utf8');
}

async function withRouteEnv<T>(
  brain: 'claude_oauth' | 'codex_oauth',
  work: () => Promise<T>,
): Promise<T> {
  const values: Record<string, string> = {
    AUTH_MODE: brain,
    CLEMMY_JUDGE_CROSS_FAMILY: 'on',
    CLEMMY_JUDGE_CHAIN: 'on',
    CLEMMY_DEBATE_JUDGE: 'claude',
    CLEMMY_MODEL_ROLES: '',
    CLEMMY_MODEL_ROLES_REGISTRY: 'on',
    MODEL_ROUTING_MODE: 'off',
    BYO_MODEL_BASE_URL: '',
    BYO_MODEL_API_KEY: '',
    BYO_MODEL_ID: '',
    BYO_MODEL_JUDGE_ID: '',
    OPENAI_MODEL_PRIMARY: 'gpt-5.4',
    CLAUDE_MODEL: 'claude-sonnet-5',
    CLEMMY_DEBATE_CHECKER_MODEL: 'claude-sonnet-4-6',
  };
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await work();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('Claude brain with a Claude-configured judge selects connected Codex', async () => {
  writeConnections(true);
  await withRouteEnv('claude_oauth', async () => {
    const route = await resolveProductionTerminalDeliveryJudgeRoute();
    assert.ok(route);
    assert.equal(route.brainFamily, 'claude');
    assert.equal(route.judgeFamily, 'codex');
    assert.equal(route.selfJudge, false);
    assert.ok(route.model);
  });
});

test('Claude brain with no Codex connection returns null instead of Claude self-judging', async () => {
  writeConnections(false);
  await withRouteEnv('claude_oauth', async () => {
    assert.equal(await resolveProductionTerminalDeliveryJudgeRoute(), null);
  });
});

test('Codex brain with a connected Claude judge selects Claude', async () => {
  writeConnections(true);
  await withRouteEnv('codex_oauth', async () => {
    const route = await resolveProductionTerminalDeliveryJudgeRoute();
    assert.ok(route);
    assert.equal(route.brainFamily, 'codex');
    assert.equal(route.judgeFamily, 'claude');
    assert.equal(route.selfJudge, false);
    assert.ok(route.model);
  });
});

test('a Claude-self then Codex-independent chain executes only Codex once', async () => {
  const claudeSelf = {
    model: {},
    modelId: 'claude-sonnet-4-6',
    judgeFamily: 'claude',
    brainFamily: 'claude',
    transport: 'claude_subscription',
    selfJudge: true,
  } as const;
  const independentCodex = {
    model: {},
    modelId: 'gpt-5.4-mini',
    judgeFamily: 'codex',
    brainFamily: 'claude',
    transport: 'codex_responses',
    selfJudge: false,
  } as const;
  const selected = selectIndependentTerminalDeliveryJudgeRoute([
    claudeSelf as never,
    independentCodex as never,
  ]);
  assert.equal(selected, independentCodex);

  const executed: unknown[] = [];
  const result = await evaluateTerminalDelivery({
    objective: 'Return the verified result.',
    authoredText: 'The verified result is ready.',
    deliveryConcern: { reason: 'independent terminal review is required' },
    settlementAudit: {
      status: 'clean',
      reason: 'all accepted work is durably settled',
      facts: {
        openLogicalCalls: 0,
        conflictingLogicalCalls: 0,
        startedDispatches: 0,
        businessSettlements: 1,
        successfulBusinessSettlements: 1,
        successfulSdkBusinessResults: 0,
        unrecoveredBusinessFailures: 0,
        confirmedWrites: 0,
        uncertainWrites: 0,
        blockingUncertainWrites: 0,
        successfulBusinessIdentities: [],
        unrecoveredBusinessFailureIdentities: [],
      },
    },
    priorConsecutiveResumes: 0,
  }, {
    port: {
      async resolveRoute() { return selected; },
      async run(request) {
        executed.push(request.route);
        return {
          verb: 'deliver',
          reason: 'the verified result is complete',
          publicText: 'The verified result is ready.',
        };
      },
    },
    timeoutMs: 100,
  });

  assert.equal(result.status, 'decided');
  assert.equal(executed.length, 1);
  assert.equal(executed[0], independentCodex);
});
