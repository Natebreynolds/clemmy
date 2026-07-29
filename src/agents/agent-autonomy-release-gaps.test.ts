/**
 * Red-first release contracts for the OAuth/runtime autonomy lane.
 *
 * Run:
 *   npx tsx --test src/agents/agent-autonomy-release-gaps.test.ts
 *
 * These tests intentionally describe the safe behavior that production does
 * not yet provide. Keep them isolated from agent-delegations.test.ts so fixes
 * under concurrent validation do not blur which contract remains red.
 */
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-autonomy-release-gaps-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.AUTH_MODE = 'api_key';
delete process.env.OPENAI_API_KEY;

const autonomy = await import('./autonomy-v2.js');
const { _setBridgeImplsForTests } = await import('../runtime/harness/respond-bridge.js');
const { resetEventLog } = await import('../runtime/harness/eventlog.js');

interface SeedAgentOptions {
  proactive?: boolean;
  allowedTools?: string[];
  wakeTriggers?: string[];
}

function seedAgent(slug: string, options: SeedAgentOptions = {}): void {
  const dir = path.join(TEST_HOME, 'vault', '00-System', 'agents', slug);
  mkdirSync(dir, { recursive: true });
  const allowedTools = options.allowedTools ?? [];
  const wakeTriggers = options.wakeTriggers ?? ['inbox', 'delegation'];
  writeFileSync(path.join(dir, 'agent.md'), [
    '---',
    `slug: ${slug}`,
    `name: ${slug}`,
    'description: Isolated release-contract agent.',
    'canMessage: []',
    `allowedTools: [${allowedTools.join(', ')}]`,
    'tier: 2',
    'autonomyEnabled: true',
    `proactive: ${options.proactive ?? true}`,
    'cadenceMinutes: 30',
    'wakeTriggers:',
    ...wakeTriggers.map((trigger) => `  - ${trigger}`),
    '---',
    `You are ${slug}. Work only within your configured authority.`,
  ].join('\n'), 'utf-8');
}

function seedDelegation(slug: string, id: string): void {
  const dir = path.join(TEST_HOME, 'delegations', slug);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    id,
    fromAgent: 'clementine',
    toAgent: slug,
    task: 'Return the number 42.',
    expectedOutput: 'The number 42.',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  }, null, 2), 'utf-8');
}

function decisionFor(delegationId: string): string {
  return JSON.stringify({
    summary: 'Completed the assigned calculation.',
    commitments: [],
    actions: [
      { type: 'claim_delegation', delegationId },
      { type: 'complete_delegation', delegationId, result: '42' },
    ],
  });
}

function fakeAssistantReturning(text: string, onCall?: () => void): unknown {
  return {
    async respond(request: { sessionId?: string }) {
      onCall?.();
      return {
        text,
        sessionId: request.sessionId ?? 'agent:test',
        stoppedReason: 'success' as const,
      };
    },
    getRuntime() {
      return {};
    },
  };
}

beforeEach(() => {
  resetEventLog();
  autonomy.clearAutonomyAgentCache();
  autonomy._testOnly_resetAutonomyUnavailableWarning();
  _setBridgeImplsForTests({});
  process.env.AUTH_MODE = 'api_key';
  process.env.CLEMMY_HARNESS_CRON = 'off';
  process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
  delete process.env.OPENAI_API_KEY;
});

after(() => {
  _setBridgeImplsForTests({});
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('delegation wake fires even when cadence proactivity is disabled', async () => {
  const slug = 'delegation-wake-only';
  const delegationId = 'wake1';
  seedAgent(slug, {
    proactive: false,
    allowedTools: [],
    wakeTriggers: ['delegation'],
  });
  seedDelegation(slug, delegationId);
  process.env.AUTONOMY_V2_AGENTS = slug;

  let assistantCalls = 0;
  process.env.CLEMMY_HARNESS_CRON = 'on';
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async (options: { sessionId: string }) => {
      assistantCalls += 1;
      return {
        sessionId: options.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: {
          summary: 'Completed the assigned calculation.',
          reply: decisionFor(delegationId),
          done: true,
          nextAction: 'completed',
          reason: null,
        },
      };
    }) as never,
  });
  const summary = await autonomy.processAgentAutonomyV2(
    fakeAssistantReturning(decisionFor(delegationId)) as never,
  );

  assert.equal(summary.skipped, 0, 'a configured delegation trigger must wake the assigned agent');
  assert.equal(summary.succeeded, 1);
  assert.equal(assistantCalls, 1, 'the delegated work must reach a model cycle');
  assert.equal(
    existsSync(path.join(TEST_HOME, 'agents-state', `${slug}.json`)),
    true,
    'a real wake records agent state',
  );
});

test('a raw OpenAI utility key never overrides the selected Claude or BYO brain', () => {
  const envKeys = [
    'OPENAI_API_KEY',
    'AUTH_MODE',
    'MODEL_ROUTING_MODE',
    'BYO_MODEL_BASE_URL',
    'BYO_MODEL_API_KEY',
    'BYO_MODEL_ID',
    'BYO_BRAIN_MODEL_ID',
    'CLEMMY_MODEL_ROLES',
  ] as const;
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));

  try {
    process.env.OPENAI_API_KEY = 'sk-utility-only';
    delete process.env.CLEMMY_MODEL_ROLES;
    delete process.env.BYO_BRAIN_MODEL_ID;

    process.env.AUTH_MODE = 'claude_oauth';
    process.env.MODEL_ROUTING_MODE = 'off';
    assert.equal(
      autonomy.shouldUseOpenAiSdkAutonomy(),
      false,
      'a voice/embedding key must not reroute a Claude-selected autonomy cycle through billed OpenAI SDK calls',
    );

    process.env.AUTH_MODE = 'api_key';
    process.env.MODEL_ROUTING_MODE = 'all_in';
    process.env.BYO_MODEL_BASE_URL = 'https://byo.example.test/v1';
    process.env.BYO_MODEL_API_KEY = 'byo-test-key';
    process.env.BYO_MODEL_ID = 'custom-byo-brain';
    assert.equal(
      autonomy.shouldUseOpenAiSdkAutonomy(),
      false,
      'an all-in BYO brain remains authoritative even when a raw OpenAI utility key is present',
    );

    process.env.MODEL_ROUTING_MODE = 'off';
    delete process.env.BYO_MODEL_BASE_URL;
    delete process.env.BYO_MODEL_API_KEY;
    delete process.env.BYO_MODEL_ID;
    assert.equal(
      autonomy.shouldUseOpenAiSdkAutonomy(),
      true,
      'api_key auth with the Codex brain may use the OpenAI Agents SDK lane',
    );
  } finally {
    for (const key of envKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('an available assistant runtime always owns autonomy, even when raw OpenAI SDK credentials are usable', () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousAuth = process.env.AUTH_MODE;
  const previousRouting = process.env.MODEL_ROUTING_MODE;
  try {
    process.env.OPENAI_API_KEY = 'sk-runtime-still-wins';
    process.env.AUTH_MODE = 'api_key';
    process.env.MODEL_ROUTING_MODE = 'off';
    assert.equal(
      (autonomy.shouldUseOpenAiSdkAutonomy as unknown as (assistantPresent: boolean) => boolean)(true),
      false,
      'assistant-present cycles must use the selected-brain decision runtime; raw SDK is fallback only',
    );
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousAuth === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = previousAuth;
    if (previousRouting === undefined) delete process.env.MODEL_ROUTING_MODE;
    else process.env.MODEL_ROUTING_MODE = previousRouting;
  }
});

test('raw SDK fallback exposes no direct tools, MCP servers, or handoffs', () => {
  const candidate = autonomy as unknown as {
    _testOnly_rawSdkDecisionOnlySurface?: () => {
      tools: unknown[];
      mcpServers: unknown[];
    };
  };
  assert.equal(
    typeof candidate._testOnly_rawSdkDecisionOnlySurface,
    'function',
    'the raw fallback needs one testable fail-closed authority boundary',
  );
  assert.deepEqual(
    candidate._testOnly_rawSdkDecisionOnlySurface!(),
    { tools: [], mcpServers: [] },
    'the fallback only returns the same bounded action JSON that code validates and executes',
  );
});

test('OAuth autonomy uses an explicit empty tool allowlist instead of generic cron authority', async () => {
  const slug = 'authority-empty';
  const delegationId = 'auth1';
  seedAgent(slug, {
    proactive: true,
    allowedTools: [],
    wakeTriggers: ['delegation'],
  });
  seedDelegation(slug, delegationId);
  process.env.AUTONOMY_V2_AGENTS = slug;
  delete process.env.CLEMMY_HARNESS_CRON;
  delete process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;

  let builtWith: Record<string, unknown> | undefined;
  const decision = decisionFor(delegationId);
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    buildAgent: (async (options: Record<string, unknown>) => {
      builtWith = options;
      return {};
    }) as never,
    runConversation: (async (options: { sessionId: string }) => ({
      sessionId: options.sessionId,
      status: 'completed',
      steps: 1,
      lastTurn: 1,
      lastDecision: {
        summary: 'Completed the assigned calculation.',
        reply: decision,
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    })) as never,
  });

  const summary = await autonomy.processAgentAutonomyV2({
    async respond() {
      throw new Error('legacy assistant must not serve this harness-path test');
    },
    getRuntime() {
      return {};
    },
  } as never);

  assert.equal(summary.succeeded, 1, 'precondition: the runtime cycle itself completed');
  assert.ok(builtWith, 'precondition: the OAuth cycle constructed its model lane');
  assert.deepEqual(
    builtWith.allowedToolNames,
    [],
    'decision-only autonomy must bind an explicit empty allowlist; omission means generic full cron authority',
  );
});

test('runtime cycle timeout actively cancels the underlying Claude turn', async () => {
  const slug = 'timeout-aborts-runtime';
  seedAgent(slug, { proactive: true, allowedTools: [] });
  process.env.AUTONOMY_V2_AGENTS = slug;
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_HARNESS_CRON = 'on';
  delete process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;

  let capturedRequest: { shouldCancel?: () => boolean | Promise<boolean> } | undefined;
  let releaseRuntime: (() => void) | undefined;
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    claudeAgentBrain: (async (_surface: string, request: { shouldCancel?: () => boolean | Promise<boolean> }) => {
      capturedRequest = request;
      return await new Promise<never>((_resolve, reject) => {
        releaseRuntime = () => reject(new Error('test cleanup: release timed-out Claude stub'));
      });
    }) as never,
  });

  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    realSetTimeout(callback, (delay ?? 0) >= 60_000 ? 1 : delay, ...args)) as typeof setTimeout;

  try {
    const summary = await autonomy.processAgentAutonomyV2({
      async respond() {
        throw new Error('legacy assistant must not serve the Claude SDK path');
      },
      getRuntime() {
        return {};
      },
    } as never);

    assert.equal(summary.failed, 1, 'precondition: the caller wait budget expired');
    assert.ok(capturedRequest, 'precondition: the Claude runtime turn started');
    assert.equal(
      typeof capturedRequest.shouldCancel,
      'function',
      'the underlying turn needs an abort predicate, not only a Promise wrapper timeout',
    );
    assert.equal(
      await capturedRequest.shouldCancel?.(),
      true,
      'the timeout must flip the abort predicate before returning control to the daemon',
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
    releaseRuntime?.();
  }
});

test('a timed-out cycle remains single-flight until its underlying run actually settles', async () => {
  const slug = 'timeout-single-flight';
  seedAgent(slug, { proactive: true, allowedTools: [] });
  process.env.AUTONOMY_V2_AGENTS = slug;

  let assistantCalls = 0;
  process.env.CLEMMY_HARNESS_CRON = 'on';
  let releaseConversation: (() => void) | undefined;
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async () => {
      assistantCalls += 1;
      return await new Promise<never>((_resolve, reject) => {
        releaseConversation = () => reject(new Error('test cleanup: release single-flight stub'));
      });
    }) as never,
  });
  const neverSettles = {
    async respond() { throw new Error('legacy assistant must not serve this harness-path test'); },
    getRuntime() {
      return {};
    },
  };

  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    realSetTimeout(callback, (delay ?? 0) >= 60_000 ? 1 : delay, ...args)) as typeof setTimeout;

  try {
    const first = await autonomy.processAgentAutonomyV2(neverSettles as never);
    assert.equal(first.failed, 1, 'precondition: the wrapper timeout fired');

    const second = await autonomy.processAgentAutonomyV2(neverSettles as never);
    assert.equal(second.skipped, 1, 'the still-running cycle owns the slug until it actually settles or is aborted');
    assert.equal(assistantCalls, 1, 'a second model/tool loop must not overlap the timed-out first loop');
  } finally {
    globalThis.setTimeout = realSetTimeout;
    releaseConversation?.();
  }
});

test('a denied runtime action fails the cycle and leaves delegated input available for retry', async () => {
  const slug = 'action-denial-retries';
  const delegationId = 'owned1';
  seedAgent(slug, { proactive: false, allowedTools: [], wakeTriggers: ['delegation'] });
  seedDelegation(slug, delegationId);
  process.env.AUTONOMY_V2_AGENTS = slug;
  process.env.CLEMMY_HARNESS_CRON = 'on';

  const decision = JSON.stringify({
    summary: 'Tried to act on an assignment outside my queue.',
    commitments: [],
    actions: [{ type: 'claim_delegation', delegationId: 'not-in-my-queue' }],
  });
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async (options: { sessionId: string }) => ({
      sessionId: options.sessionId,
      status: 'completed',
      steps: 1,
      lastTurn: 1,
      lastDecision: {
        summary: decision,
        reply: decision,
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    })) as never,
  });

  const summary = await autonomy.processAgentAutonomyV2(
    fakeAssistantReturning(decision) as never,
  );

  assert.equal(summary.failed, 1, 'an action denial is a failed cycle, not a successful narration');
  const delegation = JSON.parse(
    await import('node:fs').then(({ readFileSync }) =>
      readFileSync(path.join(TEST_HOME, 'delegations', slug, `${delegationId}.json`), 'utf-8')
    ),
  ) as { status: string };
  assert.equal(delegation.status, 'pending', 'the actual assigned input remains untouched for retry');
  const state = JSON.parse(
    await import('node:fs').then(({ readFileSync }) =>
      readFileSync(path.join(TEST_HOME, 'agents-state', `${slug}.json`), 'utf-8')
    ),
  ) as { lastError?: string; nextWakeAt?: string };
  assert.match(state.lastError ?? '', /action|delegation/i);
  assert.ok(Date.parse(state.nextWakeAt ?? '') > Date.now(), 'failure schedules bounded retry backoff');
});

test('a delegation wake cannot succeed as an empty no-op cycle', async () => {
  const slug = 'delegation-no-progress';
  const delegationId = 'still-open';
  seedAgent(slug, { proactive: false, allowedTools: [], wakeTriggers: ['delegation'] });
  seedDelegation(slug, delegationId);
  process.env.AUTONOMY_V2_AGENTS = slug;
  process.env.CLEMMY_HARNESS_CRON = 'on';

  const decision = JSON.stringify({
    summary: 'Nothing to do.',
    commitments: [],
    actions: [],
  });
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async (options: { sessionId: string }) => ({
      sessionId: options.sessionId,
      status: 'completed',
      steps: 1,
      lastTurn: 1,
      lastDecision: {
        summary: decision,
        reply: decision,
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    })) as never,
  });

  const summary = await autonomy.processAgentAutonomyV2(
    fakeAssistantReturning(decision) as never,
  );

  assert.equal(summary.failed, 1, 'assigned work requires a real transition or explicit escalation');
  const state = JSON.parse(
    await import('node:fs').then(({ readFileSync }) =>
      readFileSync(path.join(TEST_HOME, 'agents-state', `${slug}.json`), 'utf-8')
    ),
  ) as { lastError?: string; nextWakeAt?: string };
  assert.match(state.lastError ?? '', /no.progress/i);
  assert.ok(Date.parse(state.nextWakeAt ?? '') > Date.now());
});

test('an ordinary cadence wake may still succeed as a truthful no-op', async () => {
  const slug = 'cadence-noop';
  seedAgent(slug, { proactive: true, allowedTools: [], wakeTriggers: ['inbox'] });
  process.env.AUTONOMY_V2_AGENTS = slug;
  process.env.CLEMMY_HARNESS_CRON = 'on';

  const decision = JSON.stringify({
    summary: 'No queued work needs action this cycle.',
    commitments: [],
    actions: [],
  });
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async (options: { sessionId: string }) => ({
      sessionId: options.sessionId,
      status: 'completed',
      steps: 1,
      lastTurn: 1,
      lastDecision: {
        summary: decision,
        reply: decision,
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    })) as never,
  });

  const summary = await autonomy.processAgentAutonomyV2(
    fakeAssistantReturning(decision) as never,
  );

  assert.equal(summary.succeeded, 1);
  assert.equal(summary.failed, 0, 'the no-progress rule is scoped to assigned delegation work');
});

test('both autonomy engines use the same bounded failure-state backoff patch', () => {
  const candidate = autonomy as unknown as {
    _testOnly_buildCycleFailureState?: (
      state: Record<string, unknown>,
      slug: string,
      message: string,
      nowMs: number,
    ) => Record<string, unknown>;
  };
  assert.equal(
    typeof candidate._testOnly_buildCycleFailureState,
    'function',
    'SDK and runtime failures need one shared state transition',
  );
  const now = Date.now();
  const patch = candidate._testOnly_buildCycleFailureState!({}, 'sdk-backoff', 'provider down', now);
  assert.equal(patch.lastError, 'provider down');
  const retryAt = Date.parse(String(patch.nextWakeAt));
  assert.ok(retryAt >= now + 89_000 && retryAt <= now + 91_000, 'failure retry is paced at roughly 90 seconds');
});
