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
  _setBridgeImplsForTests,
} = await import('./respond-bridge.js');
// eslint-disable-next-line import/first
const { appendEvent, createSession, getSession, resetEventLog } = await import('./eventlog.js');
// eslint-disable-next-line import/first
const { AgentRuntimeCancelledError } = await import('../provider.js');
// eslint-disable-next-line import/first
const { ClaudeSdkProviderOverloadError } = await import('./claude-agent-sdk.js');

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
  _setBridgeImplsForTests({});
  delete process.env.CLEMMY_HARNESS_WEBHOOK;
  delete process.env.CLEMMY_HARNESS_CRON;
  delete process.env.CLEMMY_HARNESS_DASHBOARD;
  delete process.env.CLEMMY_HARNESS_HOME;
  delete process.env.CLEMMY_HARNESS_WORKFLOW;
  delete process.env.CLEMMY_HARNESS_DISCORD;
  delete process.env.CLEMMY_HARNESS_SLACK;
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

test('harnessSurfaceEnabled: ALL surfaces default ON (FORK-collapse complete); kill-switch reverts', () => {
  // 2026-06-13 audit #7: dashboard/home/workflow validated live → default ON
  // like every other surface (the gated loop is the ONE path). The per-surface
  // kill-switch still reverts to legacy for instant rollback.
  assert.equal(harnessSurfaceEnabled('dashboard'), true, 'dashboard default ON');
  assert.equal(harnessSurfaceEnabled('home'), true, 'home default ON');
  assert.equal(harnessSurfaceEnabled('workflow'), true, 'workflow default ON');
  assert.equal(harnessSurfaceEnabled('cli'), true, 'validated surface ON by default');
  assert.equal(harnessSurfaceEnabled('discord'), true, 'discord default ON');
  assert.equal(harnessSurfaceEnabled('slack'), true, 'slack default ON');
  process.env.CLEMMY_HARNESS_DASHBOARD = 'off';
  assert.equal(harnessSurfaceEnabled('dashboard'), false, 'kill-switch reverts to legacy');
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

test('home + dashboard ride the gated loop by default; the kill-switch still routes to legacy', async () => {
  assert.equal(harnessSurfaceEnabled('dashboard'), true, 'architect drafting surface ON');
  assert.equal(harnessSurfaceEnabled('home'), true, 'home chat surface ON');
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: fakeAgentBuilder, runConversation: fakeRun({ status: 'completed' }) });
  let legacyCalled = 0;
  await respondPreferHarness('home', { message: 'hi', sessionId: 'home-baked' }, async (req) => { legacyCalled += 1; return { text: 'legacy', sessionId: req.sessionId }; });
  assert.equal(legacyCalled, 0, 'home default-ON → gated harness loop');
  // kill-switch still reverts
  process.env.CLEMMY_HARNESS_HOME = 'off';
  try {
    await respondPreferHarness('home', { message: 'hi', sessionId: 'home-killed' }, async (req) => { legacyCalled += 1; return { text: 'legacy', sessionId: req.sessionId }; });
    assert.equal(legacyCalled, 1, 'kill-switch → legacy');
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

test('respondPreferHarness: kill-switch routes to legacy', async () => {
  process.env.CLEMMY_HARNESS_CRON = 'off';
  let legacyCalled = 0;
  const res = await respondPreferHarness('cron', { message: 'hi', sessionId: 'bridge-t1' }, async (req) => {
    legacyCalled += 1;
    return { text: 'legacy', sessionId: req.sessionId };
  });
  assert.equal(legacyCalled, 1);
  assert.equal(res.text, 'legacy');
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

test('respondPreferHarness: a NON-filterable exclude (external MCP tool) stays legacy — no silent surface widening', async () => {
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: fakeAgentBuilder, runConversation: fakeRun({ status: 'completed' }) });
  let legacyCalled = 0;
  const res = await respondPreferHarness(
    'cron',
    { message: 'hi', sessionId: 'bridge-excl-ext', excludeToolNames: ['dataforseo__serp_organic_live_advanced'] },
    async (req) => { legacyCalled += 1; return { text: 'legacy', sessionId: req.sessionId }; },
  );
  assert.equal(legacyCalled, 1, 'the harness cannot enforce an external-MCP exclude → legacy (invariant preserved)');
  assert.equal(res.text, 'legacy');
});

test('respondPreferHarness: harness auth unavailable falls back to legacy (pre-run only)', async () => {
  _setBridgeImplsForTests({ configure: (async () => ({ ok: false, reason: 'no auth' })) as never });
  let legacyCalled = 0;
  const res = await respondPreferHarness('webhook', { message: 'hi', sessionId: 'bridge-t3' }, async (req) => {
    legacyCalled += 1;
    return { text: 'legacy', sessionId: req.sessionId };
  });
  assert.equal(legacyCalled, 1);
  assert.equal(res.text, 'legacy');
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

test('respondPreferHarness: Claude SDK brain opt-in does not route execution surfaces', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  let claudeBrainCalled = 0;
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (opts: { sessionId: string }) => {
      runConversationCalled += 1;
      return { sessionId: opts.sessionId, status: 'completed', steps: 1, lastTurn: 1, lastDecision: { reply: 'harness', summary: 's', done: true, nextAction: 'completed' } };
    }) as never,
    claudeAgentBrain: (async (_surface, req) => {
      claudeBrainCalled += 1;
      return { text: 'claude', sessionId: req.sessionId };
    }) as never,
  });

  const res = await respondPreferHarness('workflow', { message: 'step', sessionId: 'claude-brain-workflow' }, async (req) => ({
    text: 'legacy',
    sessionId: req.sessionId,
  }));

  assert.equal(res.text, 'harness');
  assert.equal(runConversationCalled, 1);
  assert.equal(claudeBrainCalled, 0, 'workflow stays on the guarded harness until mutation parity is ported');
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
