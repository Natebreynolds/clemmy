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
const { createSession } = await import('../runtime/harness/eventlog.js');
const { createBackgroundTask, getBackgroundTask, markBackgroundTaskDone } = await import('../execution/background-tasks.js');
const { createFocus, getActiveFocus, getFocusWorkstate } = await import('../memory/focus.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');

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
  type ToolHandler = (input: Record<string, unknown>) => Promise<{ content?: Array<{ text?: string }> }>;
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
