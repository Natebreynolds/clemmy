/**
 * Run: npx tsx --test src/runtime/harness/respond-bridge.test.ts
 *
 * Isolated CLEMENTINE_HOME so harness sessions/events don't touch the real
 * vault. The bridge's model/agent layers are injected via
 * _setBridgeImplsForTests — these tests cover ROUTING and CONTRACT mapping,
 * not the model.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-respond-bridge';
process.env.CLEMENTINE_HOME = TEST_HOME;

// eslint-disable-next-line import/first
const {
  respondPreferHarness,
  respondViaHarness,
  harnessSurfaceEnabled,
  isChatBrainFalloverEligible,
  _setBridgeImplsForTests,
} = await import('./respond-bridge.js');
// eslint-disable-next-line import/first
const { appendEvent, createSession, getSession, resetEventLog } = await import('./eventlog.js');
// eslint-disable-next-line import/first
const { AgentRuntimeCancelledError } = await import('../provider.js');
// eslint-disable-next-line import/first
const { ClaudeSdkProviderOverloadError } = await import('./claude-agent-sdk.js');
// eslint-disable-next-line import/first
const capabilityHealth = await import('./capability-health.js');

const FAKE_AGENT = {} as never;
const okConfigure = (async () => ({ ok: true })) as never;
const fakeAgentBuilder = (async () => FAKE_AGENT) as never;

function fakeRun(result: Record<string, unknown>): never {
  return (async (opts: { sessionId: string }) => ({
    sessionId: opts.sessionId,
    steps: 1,
    lastTurn: 1,
    ...result,
  })) as never;
}

beforeEach(() => {
  resetEventLog();
  capabilityHealth._resetHarnessCapabilityHealthForTest();
  _setBridgeImplsForTests({});
  delete process.env.CLEMMY_HARNESS_WEBHOOK;
  delete process.env.CLEMMY_HARNESS_CRON;
  delete process.env.CLEMMY_HARNESS_DASHBOARD;
  delete process.env.CLEMMY_HARNESS_HOME;
  delete process.env.CLEMMY_HARNESS_WORKFLOW;
  delete process.env.CLEMMY_HARNESS_DISCORD;
  delete process.env.CLEMMY_HARNESS_SLACK;
  delete process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN;
  process.env.AUTH_MODE = 'api_key';
});

after(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('harnessSurfaceEnabled: default on, kill-switch values off', () => {
  assert.equal(harnessSurfaceEnabled('webhook'), true, 'default is ON');
  process.env.CLEMMY_HARNESS_WEBHOOK = 'off';
  assert.equal(harnessSurfaceEnabled('webhook'), false);
  process.env.CLEMMY_HARNESS_WEBHOOK = '0';
  assert.equal(harnessSurfaceEnabled('webhook'), false);
  process.env.CLEMMY_HARNESS_WEBHOOK = 'on';
  assert.equal(harnessSurfaceEnabled('webhook'), true);
});

test('harnessSurfaceEnabled: ALL surfaces default ON (FORK-collapse complete); kill-switch disables the lane', () => {
  // 2026-06-13 audit #7: dashboard/home/workflow validated live → default ON
  // like every other surface (the gated loop is the ONE path). The per-surface
  // kill-switch disables the harness lane; legacy requires explicit break-glass.
  assert.equal(harnessSurfaceEnabled('dashboard'), true, 'dashboard default ON');
  assert.equal(harnessSurfaceEnabled('home'), true, 'home default ON');
  assert.equal(harnessSurfaceEnabled('workflow'), true, 'workflow default ON');
  assert.equal(harnessSurfaceEnabled('cli'), true, 'validated surface ON by default');
  assert.equal(harnessSurfaceEnabled('discord'), true, 'discord default ON');
  assert.equal(harnessSurfaceEnabled('slack'), true, 'slack default ON');
  process.env.CLEMMY_HARNESS_DASHBOARD = 'off';
  assert.equal(harnessSurfaceEnabled('dashboard'), false, 'kill-switch disables the lane');
  delete process.env.CLEMMY_HARNESS_DASHBOARD;
});

test('respondPreferHarness: dashboard rides the gated harness loop by DEFAULT (architect conversion baked in)', async () => {
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: fakeAgentBuilder, runConversation: fakeRun({ status: 'completed' }) });
  let legacyCalled = 0;
  await respondPreferHarness(
    'dashboard',
    { message: 'draft a workflow', sessionId: 'arch-baked', excludeToolNames: ['workflow_create', 'workflow_run'] },
    async (req) => { legacyCalled += 1; return { text: 'legacy', sessionId: req.sessionId }; },
  );
  assert.equal(legacyCalled, 0, 'default-ON → gated harness loop, not legacy');
});

test('home + dashboard ride the gated loop by default; the kill-switch blocks unless legacy fallback is explicit', async () => {
  assert.equal(harnessSurfaceEnabled('dashboard'), true, 'architect drafting surface ON');
  assert.equal(harnessSurfaceEnabled('home'), true, 'home chat surface ON');
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: fakeAgentBuilder, runConversation: fakeRun({ status: 'completed' }) });
  let legacyCalled = 0;
  await respondPreferHarness('home', { message: 'hi', sessionId: 'home-baked' }, async (req) => { legacyCalled += 1; return { text: 'legacy', sessionId: req.sessionId }; });
  assert.equal(legacyCalled, 0, 'home default-ON → gated harness loop');
  // The old automatic revert is gone: disabled harness lanes block by default
  // instead of silently bypassing the gates through assistant.respond().
  process.env.CLEMMY_HARNESS_HOME = 'off';
  try {
    const res = await respondPreferHarness('home', { message: 'hi', sessionId: 'home-killed' }, async (req) => { legacyCalled += 1; return { text: 'legacy', sessionId: req.sessionId }; });
    assert.equal(legacyCalled, 0, 'kill-switch blocks by default');
    assert.equal(res.stoppedReason, 'error');
    assert.match(res.text, /harness lane is disabled/i);
  } finally {
    delete process.env.CLEMMY_HARNESS_HOME;
  }
});

test('workflow surface: default ON + honorModel forwards step.model on the gated loop', async () => {
  assert.equal(harnessSurfaceEnabled('workflow'), true, 'workflow surface default ON');
  // The worker model is forwarded to the agent builder (so a converted forEach
  // step keeps its cheaper model). Other surfaces ignore model.
  let capturedModel: string | undefined;
  const recordingBuilder = (async (opts: { model?: string }) => { capturedModel = opts.model; return FAKE_AGENT; }) as never;
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: recordingBuilder, runConversation: fakeRun({ status: 'completed' }) });
  await respondPreferHarness('workflow', { message: 'step', sessionId: 'wf-1', model: 'gpt-5.4-mini' }, async (req) => ({ text: 'legacy', sessionId: req.sessionId }));
  assert.equal(capturedModel, 'gpt-5.4-mini', 'honorModel surface forwards step.model');
});

test('non-honorModel surface ignores request.model (cron/gateway byte-identical)', async () => {
  let capturedModel: string | undefined = 'unset';
  const recordingBuilder = (async (opts: { model?: string }) => { capturedModel = opts.model; return FAKE_AGENT; }) as never;
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: recordingBuilder, runConversation: fakeRun({ status: 'completed' }) });
  await respondPreferHarness('cron', { message: 'job', sessionId: 'cron-1', model: 'gpt-5.4-deep' }, async (req) => ({ text: 'legacy', sessionId: req.sessionId }));
  assert.equal(capturedModel, undefined, 'cron does NOT forward model — harness keeps its configured model');
});

test('respondPreferHarness: kill-switch blocks by default, legacy fallback requires explicit break-glass', async () => {
  process.env.CLEMMY_HARNESS_CRON = 'off';
  let legacyCalled = 0;
  const res = await respondPreferHarness('cron', { message: 'hi', sessionId: 'bridge-t1' }, async (req) => {
    legacyCalled += 1;
    return { text: 'legacy', sessionId: req.sessionId };
  });
  assert.equal(legacyCalled, 0);
  assert.equal(res.stoppedReason, 'error');
  assert.match(res.text, /harness lane is disabled/i);

  process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
  const legacy = await respondPreferHarness('cron', { message: 'hi', sessionId: 'bridge-t1-legacy' }, async (req) => {
    legacyCalled += 1;
    return { text: 'legacy', sessionId: req.sessionId };
  });
  assert.equal(legacyCalled, 1);
  assert.equal(legacy.text, 'legacy');
});

test('respondPreferHarness: preflight blocks are recorded in harness capability health', async () => {
  process.env.CLEMMY_HARNESS_CRON = 'off';
  const res = await respondPreferHarness('cron', { message: 'hi', sessionId: 'bridge-health-block' }, async (req) => ({
    text: 'legacy',
    sessionId: req.sessionId,
  }));

  assert.equal(res.stoppedReason, 'error');
  const rec = capabilityHealth.readHarnessCapabilityHealth('respond_bridge_surface_disabled');
  assert.ok(rec, 'preflight block is persisted for harness_status/model context');
  assert.equal(rec.state, 'unavailable');
  assert.equal(rec.sessionId, 'bridge-health-block');
  assert.match(rec.reason ?? '', /cron: The cron harness lane is disabled/);
  assert.equal(rec.details?.surface, 'cron');
  assert.equal(rec.details?.reason, 'surface_disabled');
});

test('respondPreferHarness: harness-FILTERABLE excludeToolNames ride the gated loop (exclusion passed to the builder)', async () => {
  // The FORK-collapse capability: callers excluding only harness tools (architect
  // workflow_*, autonomy composio_execute_tool+workflow_*) now run on the gated
  // harness loop instead of the legacy ungated core, with the exclusion enforced.
  let captured: string[] | undefined;
  const recordingBuilder = (async (opts: { excludeToolNames?: string[] }) => { captured = opts.excludeToolNames; return FAKE_AGENT; }) as never;
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: recordingBuilder, runConversation: fakeRun({ status: 'completed' }) });
  let legacyCalled = 0;
  await respondPreferHarness(
    'cron',
    { message: 'hi', sessionId: 'bridge-excl-ok', excludeToolNames: ['composio_execute_tool', 'workflow_run'] },
    async (req) => { legacyCalled += 1; return { text: 'legacy', sessionId: req.sessionId }; },
  );
  assert.equal(legacyCalled, 0, 'harness-filterable excludes ride the loop, not legacy');
  assert.deepEqual(captured, ['composio_execute_tool', 'workflow_run'], 'exclusion forwarded to the agent builder');
});

test('respondPreferHarness: a NON-filterable exclude blocks by default — no silent surface widening or legacy bypass', async () => {
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: fakeAgentBuilder, runConversation: fakeRun({ status: 'completed' }) });
  let legacyCalled = 0;
  const res = await respondPreferHarness(
    'cron',
    { message: 'hi', sessionId: 'bridge-excl-ext', excludeToolNames: ['dataforseo__serp_organic_live_advanced'] },
    async (req) => { legacyCalled += 1; return { text: 'legacy', sessionId: req.sessionId }; },
  );
  assert.equal(legacyCalled, 0, 'the harness cannot enforce an external-MCP exclude → block before run');
  assert.equal(res.stoppedReason, 'error');
  assert.match(res.text, /tool exclusions cannot be enforced/i);
});

test('respondPreferHarness: harness auth unavailable blocks by default instead of falling back to legacy', async () => {
  _setBridgeImplsForTests({ configure: (async () => ({ ok: false, reason: 'no auth' })) as never });
  let legacyCalled = 0;
  const res = await respondPreferHarness('webhook', { message: 'hi', sessionId: 'bridge-t3' }, async (req) => {
    legacyCalled += 1;
    return { text: 'legacy', sessionId: req.sessionId };
  });
  assert.equal(legacyCalled, 0);
  assert.equal(res.stoppedReason, 'error');
  assert.match(res.text, /model runtime is not configured/i);
  assert.match(res.text, /no auth/i);
});

test('respondPreferHarness: Claude auth + SDK brain opt-in routes chat through Claude Agent SDK brain', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  let legacyCalled = 0;
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async () => { runConversationCalled += 1; return { status: 'completed' }; }) as never,
    claudeAgentBrain: (async (_surface, req) => ({
      text: 'claude sdk brain',
      sessionId: req.sessionId,
      stoppedReason: 'success',
    })) as never,
  });

  const res = await respondPreferHarness('home', { message: 'hi', sessionId: 'claude-brain-route' }, async (req) => {
    legacyCalled += 1;
    return { text: 'legacy', sessionId: req.sessionId };
  });

  assert.equal(res.text, 'claude sdk brain');
  assert.equal(legacyCalled, 0);
  assert.equal(runConversationCalled, 0, 'Claude SDK brain is a distinct route from the OpenAI SDK runner');
});

test('respondPreferHarness: Discord and Slack are first-class chat bridge surfaces', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const seenSurfaces: string[] = [];
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: fakeRun({ status: 'completed' }),
    claudeAgentBrain: (async (surface, req) => {
      seenSurfaces.push(surface);
      return { text: `claude:${surface}`, sessionId: req.sessionId, stoppedReason: 'success' };
    }) as never,
  });

  const discord = await respondPreferHarness('discord', { message: 'hi', sessionId: 'discord-bridge' }, async (req) => ({ text: 'legacy', sessionId: req.sessionId }));
  const slack = await respondPreferHarness('slack', { message: 'hi', sessionId: 'slack-bridge' }, async (req) => ({ text: 'legacy', sessionId: req.sessionId }));

  assert.equal(discord.text, 'claude:discord');
  assert.equal(slack.text, 'claude:slack');
  assert.deepEqual(seenSurfaces, ['discord', 'slack']);
});

test('respondPreferHarness: Claude SDK brain relays harness tool/progress events to legacy callbacks', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  const seenTools: Array<{ toolName: string; input: Record<string, unknown> }> = [];
  const seenReasoning: string[] = [];
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: fakeRun({ status: 'completed' }),
    claudeAgentBrain: (async (_surface, req) => {
      if (!getSession(req.sessionId)) {
        createSession({ id: req.sessionId, kind: 'chat', title: 'claude progress' });
      }
      appendEvent({
        sessionId: req.sessionId,
        turn: 1,
        role: 'agent',
        type: 'turn_started',
        data: {},
      });
      appendEvent({
        sessionId: req.sessionId,
        turn: 1,
        role: 'agent',
        type: 'tool_called',
        data: { tool: 'run_shell_command', args: { command: 'npm test' } },
      });
      return { text: 'claude sdk brain', sessionId: req.sessionId, stoppedReason: 'success' };
    }) as never,
  });

  await respondPreferHarness('home', {
    message: 'run the local check',
    sessionId: 'claude-brain-progress',
    onToolActivity: (activity) => { seenTools.push(activity); },
    onReasoning: (text) => { seenReasoning.push(text); },
  }, async (req) => ({ text: 'legacy', sessionId: req.sessionId }));

  assert.deepEqual(seenTools, [
    { toolName: 'run_shell_command', input: { command: 'npm test' } },
  ]);
  assert.ok(seenReasoning.some((text) => /planning the next step/i.test(text)));
});

test('respondPreferHarness: Claude SDK brain opt-in routes background, while workflow stays on its dedicated path', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  const claudeBrainSurfaces: string[] = [];
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (opts: { sessionId: string }) => {
      runConversationCalled += 1;
      return { sessionId: opts.sessionId, status: 'completed', steps: 1, lastTurn: 1, lastDecision: { reply: 'harness', summary: 's', done: true, nextAction: 'completed' } };
    }) as never,
    claudeAgentBrain: (async (surface, req) => {
      claudeBrainSurfaces.push(surface);
      return { text: 'claude', sessionId: req.sessionId };
    }) as never,
  });

  const background = await respondPreferHarness('background', { message: 'count files', sessionId: 'claude-brain-background' }, async (req) => ({
    text: 'legacy',
    sessionId: req.sessionId,
  }));
  const workflow = await respondPreferHarness('workflow', { message: 'step', sessionId: 'claude-brain-workflow' }, async (req) => ({
    text: 'legacy',
    sessionId: req.sessionId,
  }));

  assert.equal(background.text, 'claude');
  assert.equal(workflow.text, 'harness');
  assert.equal(runConversationCalled, 1);
  assert.deepEqual(claudeBrainSurfaces, ['background']);
});

test('Claude SDK brain overload (uncommitted) falls the turn over to the harness brain (Codex→GLM)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (opts: { sessionId: string }) => {
      runConversationCalled += 1;
      return { sessionId: opts.sessionId, status: 'completed', steps: 1, lastTurn: 1, lastDecision: { reply: 'harness-fallover', summary: 's', done: true, nextAction: 'completed' } };
    }) as never,
    // Overloaded with NOTHING committed (no tool, no stream) → safe to re-run elsewhere.
    claudeAgentBrain: (async () => { throw new ClaudeSdkProviderOverloadError('API Error: 529 Overloaded', false); }) as never,
  });

  const res = await respondPreferHarness('home', { message: 'hi', sessionId: 'fallover-ok' }, async (req) => ({ text: 'legacy', sessionId: req.sessionId }));
  assert.equal(res.text, 'harness-fallover', 'turn ran on the harness brain after Claude overloaded');
  assert.equal(runConversationCalled, 1);
  assert.equal(res.route?.routeKind, 'harness');
  assert.equal(res.route?.falloverFrom, 'claude_agent_sdk_brain');
  assert.equal(res.route?.surface, 'home');
});

test('Claude SDK brain fallover forces a non-Claude harness model when one is configured', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const oldByoUrl = process.env.BYO_MODEL_BASE_URL;
  const oldByoKey = process.env.BYO_MODEL_API_KEY;
  const oldByoId = process.env.BYO_MODEL_ID;
  const oldRouting = process.env.MODEL_ROUTING_MODE;
  process.env.BYO_MODEL_BASE_URL = 'https://example.invalid/v1';
  process.env.BYO_MODEL_API_KEY = 'test-key';
  process.env.BYO_MODEL_ID = 'glm-bridge-fallback';
  process.env.MODEL_ROUTING_MODE = 'off';
  let capturedModel: string | undefined;
  try {
    _setBridgeImplsForTests({
      configure: okConfigure,
      buildAgent: (async (opts: { model?: string }) => {
        capturedModel = opts.model;
        return FAKE_AGENT;
      }) as never,
      runConversation: (async (opts: { sessionId: string }) => ({
        sessionId: opts.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { reply: 'recovered with tools', summary: 's', done: true, nextAction: 'completed' },
      })) as never,
      claudeAgentBrain: (async () => {
        throw new Error('Claude Agent SDK local MCP surface is missing required tool: memory_recall');
      }) as never,
    });

    const res = await respondPreferHarness('discord', { message: 'check my calendar', sessionId: 'fallover-model-override' }, async (req) => ({ text: 'legacy', sessionId: req.sessionId }));

    assert.equal(res.text, 'recovered with tools');
    assert.equal(capturedModel, 'glm-bridge-fallback', 'recovery must not re-enter the Claude headless text-only harness');
    assert.equal(res.route?.effectiveModel, 'glm-bridge-fallback');
    assert.equal(res.route?.provider, 'byo');
    assert.equal(res.route?.falloverFrom, 'claude_agent_sdk_brain');
  } finally {
    if (oldByoUrl === undefined) delete process.env.BYO_MODEL_BASE_URL; else process.env.BYO_MODEL_BASE_URL = oldByoUrl;
    if (oldByoKey === undefined) delete process.env.BYO_MODEL_API_KEY; else process.env.BYO_MODEL_API_KEY = oldByoKey;
    if (oldByoId === undefined) delete process.env.BYO_MODEL_ID; else process.env.BYO_MODEL_ID = oldByoId;
    if (oldRouting === undefined) delete process.env.MODEL_ROUTING_MODE; else process.env.MODEL_ROUTING_MODE = oldRouting;
  }
});

test('Claude SDK brain UNPARSEABLE-TOOL-CALL (parse failure) also falls the turn over to the harness brain', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (opts: { sessionId: string }) => {
      runConversationCalled += 1;
      return { sessionId: opts.sessionId, status: 'completed', steps: 1, lastTurn: 1, lastDecision: { reply: 'harness-fallover', summary: 's', done: true, nextAction: 'completed' } };
    }) as never,
    // The exact error that killed the 2026-06-29 turn — now fallover-eligible.
    claudeAgentBrain: (async () => { throw new Error("Claude Code returned an error result: The model's tool call could not be parsed (retry also failed)."); }) as never,
  });

  const res = await respondPreferHarness('home', { message: 'hi', sessionId: 'fallover-parse' }, async (req) => ({ text: 'legacy', sessionId: req.sessionId }));
  assert.equal(res.text, 'harness-fallover', 'a parse failure now recovers on the harness brain instead of "Didn\'t finish"');
  assert.equal(runConversationCalled, 1);
});

test('Claude SDK uncommitted fallover reuses the pre-recorded user input row', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  let reuseRecordedUserInput: boolean | undefined;
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (opts: { sessionId: string; reuseRecordedUserInput?: boolean }) => {
      reuseRecordedUserInput = opts.reuseRecordedUserInput;
      return {
        sessionId: opts.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 2,
        lastDecision: { reply: 'fallback done', summary: 's', done: true, nextAction: 'completed' },
      };
    }) as never,
    claudeAgentBrain: (async (_surface, req) => {
      if (!getSession(req.sessionId)) {
        createSession({ id: req.sessionId, kind: 'chat', title: 'fallover test' });
      }
      appendEvent({
        sessionId: req.sessionId,
        turn: 1,
        role: 'user',
        type: 'user_input_received',
        data: { text: req.message },
      });
      appendEvent({
        sessionId: req.sessionId,
        turn: 1,
        role: 'system',
        type: 'turn_started',
        data: {},
      });
      throw new ClaudeSdkProviderOverloadError('API Error: 529 Overloaded', false);
    }) as never,
  });

  const res = await respondPreferHarness('home', { message: 'same turn', sessionId: 'fallover-reuse' }, async (req) => ({ text: 'legacy', sessionId: req.sessionId }));

  assert.equal(res.text, 'fallback done');
  assert.equal(reuseRecordedUserInput, true, 'fallback harness turn reuses the Claude-recorded user row');
});

test('Claude SDK brain overload AFTER committing surfaces the error (no double-act)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async () => { runConversationCalled += 1; return { status: 'completed' }; }) as never,
    // committed=true (a tool ran / text streamed) → must NOT re-run on another brain.
    claudeAgentBrain: (async () => { throw new ClaudeSdkProviderOverloadError('API Error: 529 Overloaded', true); }) as never,
  });

  await assert.rejects(
    respondPreferHarness('home', { message: 'hi', sessionId: 'fallover-unsafe' }, async (req) => ({ text: 'legacy', sessionId: req.sessionId })),
    /529 Overloaded/,
  );
  assert.equal(runConversationCalled, 0, 'no fallover once the turn committed work');
});

test('CLEMMY_BRAIN_FALLOVER=off disables the chat-brain fallover (overload surfaces)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'off';
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async () => ({ status: 'completed' })) as never,
    claudeAgentBrain: (async () => { throw new ClaudeSdkProviderOverloadError('API Error: 529 Overloaded', false); }) as never,
  });
  await assert.rejects(
    respondPreferHarness('home', { message: 'hi', sessionId: 'fallover-off' }, async (req) => ({ text: 'legacy', sessionId: req.sessionId })),
    /529 Overloaded/,
  );
  delete process.env.CLEMMY_BRAIN_FALLOVER;
});

test('respondPreferHarness: harness run errors PROPAGATE — no post-start legacy retry', async () => {
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async () => { throw new Error('mid-run boom'); }) as never,
  });
  let legacyCalled = 0;
  await assert.rejects(
    respondPreferHarness('webhook', { message: 'hi', sessionId: 'bridge-t4' }, async (req) => {
      legacyCalled += 1;
      return { text: 'legacy', sessionId: req.sessionId };
    }),
    /mid-run boom/,
  );
  assert.equal(legacyCalled, 0, 'a started harness run must never retry on legacy (double-send class)');
});

test('respondViaHarness: completed maps to AssistantResponse with reply preferred over summary', async () => {
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: fakeRun({ status: 'completed', lastDecision: { summary: 'meta', reply: 'hello user', done: true, nextAction: 'completed' }, lastTurn: 3 }),
  });
  const res = await respondViaHarness('webhook', { message: 'hi', sessionId: 'bridge-t5', channel: 'webhook' });
  assert.equal(res.text, 'hello user');
  assert.equal(res.stoppedReason, 'success');
  assert.equal(res.turnsUsed, 3);
  assert.equal(res.route?.routeKind, 'harness');
  assert.equal(res.route?.surface, 'webhook');
  assert.equal(res.route?.transport, 'openai_agents_harness');
  assert.ok(res.route?.effectiveModel, 'effective model is recorded for diagnostics');
  const session = getSession('bridge-t5');
  assert.ok(session, 'harness session created');
  assert.equal(session?.kind, 'chat', 'webhook surface creates a chat-kind session');
});

test('respondViaHarness: relays harness tool/progress events to legacy callbacks', async () => {
  const seenTools: Array<{ toolName: string; input: Record<string, unknown> }> = [];
  const seenReasoning: string[] = [];
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (opts: { sessionId: string }) => {
      appendEvent({
        sessionId: opts.sessionId,
        turn: 1,
        role: 'agent',
        type: 'turn_started',
        data: {},
      });
      appendEvent({
        sessionId: opts.sessionId,
        turn: 1,
        role: 'agent',
        type: 'tool_called',
        data: { tool: 'memory_search', arguments: JSON.stringify({ query: 'status' }) },
      });
      appendEvent({
        sessionId: opts.sessionId,
        turn: 1,
        role: 'agent',
        type: 'tool_called',
        data: { tool: 'run_shell_command', args: { command: 'npm test' } },
      });
      appendEvent({
        sessionId: opts.sessionId,
        turn: 1,
        role: 'agent',
        type: 'tool_called',
        data: { toolName: 'browser_open', input: { url: 'http://127.0.0.1:3000' } },
      });
      appendEvent({
        sessionId: opts.sessionId,
        turn: 1,
        role: 'agent',
        type: 'tool_called',
        data: { tool: 'debug_probe', args: 'not-json' },
      });
      return {
        sessionId: opts.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { summary: 's', reply: 'r', done: true, nextAction: 'completed' },
      };
    }) as never,
  });

  await respondViaHarness('background', {
    message: 'work',
    sessionId: 'bridge-progress',
    onToolActivity: (activity) => { seenTools.push(activity); },
    onReasoning: (text) => { seenReasoning.push(text); },
  });

  assert.deepEqual(seenTools, [
    { toolName: 'memory_search', input: { query: 'status' } },
    { toolName: 'run_shell_command', input: { command: 'npm test' } },
    { toolName: 'browser_open', input: { url: 'http://127.0.0.1:3000' } },
    { toolName: 'debug_probe', input: { value: 'not-json' } },
  ]);
  assert.ok(seenReasoning.some((text) => /planning the next step/i.test(text)));
});

test('respondViaHarness: cron surface creates an execution-kind session', async () => {
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: fakeRun({ status: 'completed', lastDecision: { summary: 's', reply: 'r', done: true, nextAction: 'completed' } }),
  });
  await respondViaHarness('cron', { message: 'nightly job', sessionId: 'cron:test-job' });
  assert.equal(getSession('cron:test-job')?.kind, 'execution');
});

test('respondViaHarness: awaiting_approval maps to pending-approval stoppedReason', async () => {
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: fakeRun({ status: 'awaiting_approval', lastDecision: null }),
  });
  const res = await respondViaHarness('background', { message: 'do it', sessionId: 'bridge-t6' });
  assert.equal(res.stoppedReason, 'pending-approval');
  assert.match(res.text, /approval/i);
});

test('respondViaHarness: limit_exceeded maps to max-turns-with-grace', async () => {
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: fakeRun({ status: 'limit_exceeded' }),
  });
  const res = await respondViaHarness('webhook', { message: 'big task', sessionId: 'bridge-t7' });
  assert.equal(res.stoppedReason, 'max-turns-with-grace');
});

test('respondViaHarness: failed status throws (legacy callers own error handling)', async () => {
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: fakeRun({ status: 'failed', error: 'runtime exploded' }),
  });
  await assert.rejects(
    respondViaHarness('cron', { message: 'job', sessionId: 'bridge-t8' }),
    /runtime exploded/,
  );
});

test('respondViaHarness: caller-driven cancel throws AgentRuntimeCancelledError (background abort contract)', async () => {
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    // Run long enough for the 2s cancel poll to fire, then report killed.
    runConversation: (async (opts: { sessionId: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 2600));
      return { sessionId: opts.sessionId, status: 'killed', steps: 1, lastTurn: 1 };
    }) as never,
  });
  await assert.rejects(
    respondViaHarness('background', {
      message: 'long task',
      sessionId: 'bridge-t9',
      shouldCancel: () => true,
    }),
    (err: unknown) => err instanceof AgentRuntimeCancelledError,
  );
});

test('isChatBrainFalloverEligible: ANY genuine Claude-brain failure switches brains; intentional stops do NOT', () => {
  const prev = process.env.CLEMMY_BRAIN_FALLOVER;
  try {
    process.env.CLEMMY_BRAIN_FALLOVER = 'on';
    // Broadened: a generic terminal error (SDK internal throw, tool-surface, unknown 4xx)
    // is now fallover-eligible — a DIFFERENT brain often succeeds. (Was a dead turn.)
    assert.equal(isChatBrainFalloverEligible(new Error('SDK internal failure: something broke')), true);
    assert.equal(isChatBrainFalloverEligible(new Error('The usage limit has been reached')), true);
    // Uncommitted overload still eligible; committed overload is handled by salvage (not here).
    assert.equal(isChatBrainFalloverEligible(new ClaudeSdkProviderOverloadError('529 Overloaded', false)), true);
    assert.equal(isChatBrainFalloverEligible(new ClaudeSdkProviderOverloadError('529 Overloaded', true)), false);
    // Intentional stops are NOT brain failures — never switch/re-run them.
    assert.equal(isChatBrainFalloverEligible(new AgentRuntimeCancelledError('Run cancelled by caller.')), false);
    const killErr = new Error('stopped'); killErr.name = 'KillRequested';
    assert.equal(isChatBrainFalloverEligible(killErr), false);
    // Kill-switch off ⇒ never fall over (prior behavior preserved).
    process.env.CLEMMY_BRAIN_FALLOVER = 'off';
    assert.equal(isChatBrainFalloverEligible(new Error('SDK internal failure')), false);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_BRAIN_FALLOVER; else process.env.CLEMMY_BRAIN_FALLOVER = prev;
  }
});

test('parse-exhaustion completion re-runs ONCE on the next brain instead of shipping the apology', async () => {
  // Seed a connected Claude so falloverBrainModelIds('codex') has a target
  // (the harness brain under AUTH_MODE=api_key resolves to the codex class).
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const path = await import('node:path');
  mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
  writeFileSync(path.join(TEST_HOME, 'state', 'claude-auth.json'), JSON.stringify({
    accessToken: 'sk-ant-oat01-test', refreshToken: 'r', expiresAt: Date.now() + 3_600_000,
  }), 'utf-8');

  const models: Array<string | undefined> = [];
  const recordingBuilder = (async (opts: { model?: string }) => { models.push(opts.model); return FAKE_AGENT; }) as never;
  let calls = 0;
  const run = (async (opts: { sessionId: string }) => {
    calls += 1;
    if (calls === 1) {
      // Dead turn: parse retries exhausted, apology summary, completedReason set.
      return { sessionId: opts.sessionId, status: 'completed', steps: 3, lastTurn: 3, completedReason: 'no_structured_output' };
    }
    return {
      sessionId: opts.sessionId, status: 'completed', steps: 1, lastTurn: 1,
      lastDecision: { summary: 's', reply: 'recovered on the other brain', done: true, nextAction: 'completed', reason: null },
    };
  }) as never;
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: recordingBuilder, runConversation: run });

  const res = await respondViaHarness('webhook', { message: 'do the thing', sessionId: 'parse-exhaustion-fallover' });
  assert.equal(calls, 2, 'the dead turn must be re-run exactly once');
  assert.match(res.text, /recovered on the other brain/, 'the recovered reply ships, not the apology');
  assert.ok(models[1], 'the re-run pinned a modelOverride (the next brain)');
  assert.notEqual(models[1], models[0], 'the re-run must not use the same model');

  // And the guard: a re-run that ALSO dead-ends must NOT recurse.
  calls = 0;
  const alwaysDead = (async (opts: { sessionId: string }) => {
    calls += 1;
    return { sessionId: opts.sessionId, status: 'completed', steps: 3, lastTurn: 3, completedReason: 'no_structured_output', lastDecision: { summary: 'apology', reply: null, done: true, nextAction: 'completed', reason: null } };
  }) as never;
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: recordingBuilder, runConversation: alwaysDead });
  await respondViaHarness('webhook', { message: 'do the thing', sessionId: 'parse-exhaustion-no-recurse' });
  assert.equal(calls, 2, 'exactly one recovery hop — never a loop');
});

test('narration give-up is fallover-eligible; without fallover it ships the graceful copy, never a raw error', async () => {
  const { ClaudeSdkNarrationGiveUpError } = await import('./claude-agent-brain.js');
  const err = new ClaudeSdkNarrationGiveUpError('I started to turn that into an action but it did not go through as a real tool call. Say the word and I will run it properly.');
  // Eligible for the cross-brain re-run (zero tools ran ⇒ side-effect-safe).
  assert.equal(isChatBrainFalloverEligible(err), true);
  // And the bridge's catch converts it to a graceful reply when fallover is unavailable
  // (kill-switch off ⇒ recoverChatBrainFailure returns null ⇒ text floor).
  process.env.CLEMMY_BRAIN_FALLOVER = 'off';
  try {
    assert.equal(isChatBrainFalloverEligible(err), false, 'fallover disabled');
    assert.equal((err as { narrationGiveUp?: boolean }).narrationGiveUp, true, 'floor marker present for the bridge catch');
    assert.match(err.message, /did not go through as a real tool call/);
  } finally {
    delete process.env.CLEMMY_BRAIN_FALLOVER;
  }
});

test('awaiting_user_input surfaces THE QUESTION (+ numbered options), never the "asked a question" summary', async () => {
  const sessionId = 'ask-question-visible';
  createSession({ id: sessionId, kind: 'chat' });
  appendEvent({
    sessionId, turn: 1, role: 'Clem', type: 'awaiting_user_input',
    data: { question: 'Which pipeline do you mean, and where should the update go?', options: ['Sales pipeline → email', 'Sales pipeline → Slack', 'Just clean it up'] },
  });
  const run = (async (opts: { sessionId: string }) => ({
    sessionId: opts.sessionId, status: 'awaiting_user_input', steps: 1, lastTurn: 1,
    lastDecision: { summary: 'Asked a clarifying question to identify the pipeline.', reply: null, done: false, nextAction: 'awaiting_user_input', reason: null },
  })) as never;
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: fakeAgentBuilder, runConversation: run });

  const res = await respondViaHarness('webhook', { message: 'clean up my pipeline and tell the team', sessionId });
  assert.match(res.text, /Which pipeline do you mean/, 'the user sees the actual question');
  assert.match(res.text, /1\. Sales pipeline → email/, 'options are numbered so a channel user can reply "1"');
  assert.ok(!/Asked a clarifying question to identify/.test(res.text), 'the internal summary never ships as the reply');
  assert.equal(res.stoppedReason, 'awaiting-input');

  // A decision whose reply ALREADY asks keeps its own wording (no override).
  const runWithReply = (async (opts: { sessionId: string }) => ({
    sessionId: opts.sessionId, status: 'awaiting_user_input', steps: 1, lastTurn: 1,
    lastDecision: { summary: 's', reply: 'Quick check — email or Slack?', done: false, nextAction: 'awaiting_user_input', reason: null },
  })) as never;
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: fakeAgentBuilder, runConversation: runWithReply });
  const res2 = await respondViaHarness('webhook', { message: 'again', sessionId });
  assert.equal(res2.text, 'Quick check — email or Slack?');
});

test('parse-exhaustion recovery is GATED on external writes — a run that committed a write ships the honest completion, never a blind re-run', async () => {
  // The invariant (mirror of loop.ts step-boundary canSwitch): only rerun
  // across brains when the external_write count did not increase during the
  // run. If anything was sent/updated/created, re-driving the turn on another
  // brain could double-act — salvage or ask instead.
  const sessionId = 'parse-exhaustion-write-gate';
  createSession({ id: sessionId, kind: 'chat' });
  let calls = 0;
  const runThatWrites = (async (opts: { sessionId: string }) => {
    calls += 1;
    // The run commits an external write BEFORE dying at parse exhaustion.
    appendEvent({
      sessionId: opts.sessionId, turn: 1, role: 'system', type: 'external_write',
      data: { tool: 'composio_execute_tool', shapeKey: 'salesforce:update' },
    });
    return {
      sessionId: opts.sessionId, status: 'completed', steps: 3, lastTurn: 3,
      completedReason: 'no_structured_output',
      lastDecision: { summary: 'apology', reply: null, done: true, nextAction: 'completed', reason: null },
    };
  }) as never;
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: fakeAgentBuilder, runConversation: runThatWrites });
  const res = await respondViaHarness('webhook', { message: 'update the account', sessionId });
  assert.equal(calls, 1, 'NO recovery hop — the run committed an external write');
  assert.match(res.text, /apology/, 'the honest completion ships instead of a blind re-run');

  // Control: the SAME dead turn with no external write still recovers.
  const sessionId2 = 'parse-exhaustion-no-write-recovers';
  createSession({ id: sessionId2, kind: 'chat' });
  let calls2 = 0;
  const cleanDeadThenRecover = (async (opts: { sessionId: string }) => {
    calls2 += 1;
    if (calls2 === 1) {
      return { sessionId: opts.sessionId, status: 'completed', steps: 3, lastTurn: 3, completedReason: 'no_structured_output' };
    }
    return {
      sessionId: opts.sessionId, status: 'completed', steps: 1, lastTurn: 1,
      lastDecision: { summary: 's', reply: 'recovered cleanly', done: true, nextAction: 'completed', reason: null },
    };
  }) as never;
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: fakeAgentBuilder, runConversation: cleanDeadThenRecover });
  const res2 = await respondViaHarness('webhook', { message: 'update the account', sessionId: sessionId2 });
  assert.equal(calls2, 2, 'clean dead turn still gets the recovery hop');
  assert.match(res2.text, /recovered cleanly/);
});
