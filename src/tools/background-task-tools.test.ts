/**
 * Run: npx tsx --test src/tools/background-task-tools.test.ts
 *
 * Focused provenance tests for dispatch_background_task. The tool should carry
 * the origin chat's surface/channel into the durable task record so report-back,
 * notifications, and stale-channel reply routing behave like manual promotion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-bg-tools-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { backgroundRouteForOriginSession, registerBackgroundTaskTools } = await import('./background-task-tools.js');
const {
  appendConversationPreambleOnce,
  appendEvent,
  createSession,
} = await import('../runtime/harness/eventlog.js');
const {
  createBackgroundTask,
  getBackgroundTask,
  listBackgroundTasks,
  markBackgroundTaskDone,
} = await import('../execution/background-tasks.js');
const { createFocus, getActiveFocus, getFocusWorkstate } = await import('../memory/focus.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { ToolCallsCounter, withHarnessRunContext } = await import('../runtime/harness/brackets.js');
const { recordTurnPreflightDecision } = await import('../runtime/harness/turn-control.js');
const { publishPreflightConversation } = await import('../runtime/harness/preflight-conversation.js');

type ToolHandler = (input: Record<string, unknown>) => Promise<{ content?: Array<{ text?: string }> }>;

function registeredDispatch(): ToolHandler {
  const handlers = new Map<string, ToolHandler>();
  registerBackgroundTaskTools({
    tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
      handlers.set(name, handler);
    },
  } as never);
  const dispatch = handlers.get('dispatch_background_task');
  assert.ok(dispatch);
  return dispatch;
}

function alignedDispatchFixture(label: string) {
  const session = createSession({ kind: 'chat', channel: 'desktop', title: label });
  const objective = `Create the ${label} artifact, then email its link.`;
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: objective },
  });
  const decision: import('../runtime/harness/turn-control.js').TurnPreflightDecision = {
    phase: 'align',
    consequential: true,
    destination: 'Google Sheet',
    objective,
    intentKey: `intent:${label}`,
    allowedMutationEffects: ['external_write'],
    allowedDestinations: ['google_sheets', 'email'],
    allowedActionFamilies: ['create', 'send'],
    reason: 'external_action',
  };
  recordTurnPreflightDecision(session.id, decision, source.seq);
  return { session, source, decision };
}

async function invokeDispatch(
  dispatch: ToolHandler,
  fixture: ReturnType<typeof alignedDispatchFixture>,
): Promise<string> {
  const result = await withHarnessRunContext({
    sessionId: fixture.session.id,
    turn: fixture.source.turn,
    sourceUserSeq: fixture.source.seq,
    counter: new ToolCallsCounter(20),
  }, () => withToolOutputContext({
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
  }, () => dispatch({
    objective: fixture.decision.objective,
    handoff_note: 'I’m handling this in the background and will report back here.',
    plan: '- Create the artifact\n- Verify it\n- Send the link once',
    success_criteria: ['The artifact is verified', 'The link is sent once'],
    context_refs: [],
    max_minutes: 15,
    manifest: null,
  })));
  return result.content?.[0]?.text ?? '';
}

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('backgroundRouteForOriginSession derives Discord source/channel/user', () => {
  const session = createSession({
    kind: 'chat',
    channel: 'discord',
    userId: 'user-1',
    metadata: { source: 'discord', channelId: 'chan-1' },
  });

  assert.deepEqual(backgroundRouteForOriginSession(session.id), {
    source: 'discord',
    channel: 'discord:chan-1',
    userId: 'user-1',
  });
});

test('backgroundRouteForOriginSession supports Slack sessions with historical discordChannelId metadata', () => {
  const session = createSession({
    kind: 'chat',
    channel: 'slack',
    metadata: { source: 'slack', discordChannelId: 'slack-thread-1', userId: 'slack-user-1' },
  });

  assert.deepEqual(backgroundRouteForOriginSession(session.id), {
    source: 'slack',
    channel: 'slack:slack-thread-1',
    userId: 'slack-user-1',
  });
});

test('backgroundRouteForOriginSession preserves explicit Slack thread metadata', () => {
  const session = createSession({
    kind: 'chat',
    channel: 'slack',
    metadata: {
      source: 'slack',
      slackChannelId: 'C123',
      slackThreadTs: '1700000000.000100',
      slackUserId: 'U123',
    },
  });

  assert.deepEqual(backgroundRouteForOriginSession(session.id), {
    source: 'slack',
    channel: 'slack:C123:1700000000.000100',
    userId: 'U123',
  });
});

test('backgroundRouteForOriginSession falls back to desktop for unknown or missing sessions', () => {
  assert.deepEqual(backgroundRouteForOriginSession('missing-session'), { source: 'desktop' });

  const session = createSession({ kind: 'chat', channel: 'electron' });
  assert.deepEqual(backgroundRouteForOriginSession(session.id), {
    source: 'desktop',
    channel: 'electron',
    userId: undefined,
  });
});

test('background_task_revise versions the same durable task through the model-facing tool', async () => {
  type ToolHandler = (input: Record<string, unknown>) => Promise<{ content?: Array<{ text?: string }> }>;
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
      handlers.set(name, handler);
    },
  };
  registerBackgroundTaskTools(server as never);
  const revise = handlers.get('background_task_revise');
  assert.ok(revise);

  const task = createBackgroundTask({
    title: 'Research the shortlist',
    prompt: 'Research the approved shortlist.',
  });
  const output = await revise!({
    id: task.id,
    instruction: 'Use the corrected source list and revalidate prior research.',
    evidence_policy: 'revalidate',
  });

  assert.match(output.content?.[0]?.text ?? '', /contract v2/i);
  const updated = getBackgroundTask(task.id);
  assert.equal(updated?.id, task.id);
  assert.equal(updated?.runSessionId, task.runSessionId);
  assert.equal(updated?.contractVersion, 2);
  assert.equal(updated?.contractRevisions?.[0]?.instruction, 'Use the corrected source list and revalidate prior research.');
});

test('dispatch_background_task links and terminally reconciles the shared conversation workstate', async () => {
  const handlers = new Map<string, ToolHandler>();
  registerBackgroundTaskTools({
    tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
      handlers.set(name, handler);
    },
  } as never);
  const dispatch = handlers.get('dispatch_background_task');
  assert.ok(dispatch);

  const session = createSession({ kind: 'chat', channel: 'desktop', title: 'meal planning' });
  createFocus({
    resourceRef: `session:${session.id}`,
    title: 'Meal planning',
    summary: 'Update the recipe base after choosing this week’s meals.',
    resourceKind: 'thread',
    relatedSessionId: session.id,
  });

  const output = await withToolOutputContext({ sessionId: session.id }, () => dispatch!({
    objective: 'Add the three selected dinners to the recipe base.',
    handoff_note: 'I’m updating the recipe base now and will report back here.',
    plan: '- Add only the selected recipes\n- Verify all three saved records',
    success_criteria: ['Exactly three verified records exist'],
    context_refs: [],
    max_minutes: 15,
  }));
  const text = output.content?.[0]?.text ?? '';
  const taskId = text.match(/task (bg-[a-zA-Z0-9_-]+)/)?.[1];
  assert.ok(taskId, `dispatch returns a durable task id (got: ${text.slice(0, 240)})`);

  const running = getFocusWorkstate(getActiveFocus())?.actions.find((action) => action.ref === taskId);
  assert.equal(running?.kind, 'background');
  assert.equal(running?.status, 'running');

  markBackgroundTaskDone(taskId!, 'Verified three selected recipes in the base.');
  const completed = getFocusWorkstate(getActiveFocus())?.actions.find((action) => action.ref === taskId);
  assert.equal(completed?.status, 'done');
  assert.equal(completed?.note, 'Completed and reported back.');
});

test('dispatch_background_task accepts the exact settled same-turn conversation preamble as its structural opening', async () => {
  const dispatch = registeredDispatch();
  const fixture = alignedDispatchFixture('settled-background-dispatch');
  appendConversationPreambleOnce({
    source: fixture.source,
    text: 'I have the requested artifact, verification, and delivery steps. I’m starting them now.',
    intentKey: fixture.decision.intentKey,
  });

  const before = listBackgroundTasks({ includeArchived: true }).length;
  const output = await invokeDispatch(dispatch, fixture);

  assert.doesNotMatch(output, /alignment beat owed/i);
  assert.match(output, /Dispatched .* to the background/i);
  assert.equal(listBackgroundTasks({ includeArchived: true }).length, before + 1);
});

test('dispatch_background_task cannot cross a genuine OPEN needs-input terminal', async () => {
  const dispatch = registeredDispatch();
  const fixture = alignedDispatchFixture('open-background-dispatch');
  const disposition = await publishPreflightConversation({
    identity: {
      sessionId: fixture.session.id,
      turn: fixture.source.turn,
      sourceUserSeq: fixture.source.seq,
    },
    decision: fixture.decision,
    openness: { open: ['which connected workspace should own the artifact'] },
    port: { async render() { return 'Which connected workspace should own the artifact?'; } },
    transport: 'openai_agents_harness',
  });
  assert.equal(disposition.kind, 'ask');
  // Impossible through the normal discriminated publisher, but pin the safety
  // order at the dispatch gate: an exact needs-input terminal wins even if a
  // stale/fallover writer also left preamble-shaped evidence for this source.
  appendConversationPreambleOnce({
    source: fixture.source,
    text: 'A stale writer claimed this request was settled.',
    intentKey: fixture.decision.intentKey,
  });

  const before = listBackgroundTasks({ includeArchived: true }).length;
  const output = await invokeDispatch(dispatch, fixture);

  assert.match(output, /alignment beat owed/i);
  assert.equal(listBackgroundTasks({ includeArchived: true }).length, before);
});

test('dispatch_background_task still refuses a legacy unsafe align row with no structural opening', async () => {
  const dispatch = registeredDispatch();
  const fixture = alignedDispatchFixture('legacy-background-dispatch');

  const before = listBackgroundTasks({ includeArchived: true }).length;
  const output = await invokeDispatch(dispatch, fixture);

  assert.match(output, /alignment beat owed/i);
  assert.equal(listBackgroundTasks({ includeArchived: true }).length, before);
});
