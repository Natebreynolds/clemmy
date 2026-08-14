/**
 * Connection pin: a Claude SDK brain terminal that cannot be verified must
 * settle through processBackgroundTasks/finishWorkerRun as blocked work. It is
 * not a clarifying question, and therefore must not acquire awaiting-input or
 * approval authority on the shared RunRecord.
 *
 * Run: npx tsx --test src/execution/background-unverified-terminal-connection.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-bg-unverified-terminal-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.AUTH_MODE = 'claude_oauth';
process.env.CLEMMY_HARNESS_BACKGROUND = 'on';
process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  createBackgroundTask,
  getBackgroundTask,
  processBackgroundTasks,
} = await import('./background-tasks.js');
const { getRun } = await import('../runtime/run-events.js');
const { _setBridgeImplsForTests } = await import('../runtime/harness/respond-bridge.js');

test.after(() => {
  _setBridgeImplsForTests({});
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('Claude unverified terminal parks blocked without minting user-input or approval authority', async () => {
  const task = createBackgroundTask({
    title: 'Create and verify the restaurant sheet',
    prompt: 'Create the sheet and verify its contents before reporting success.',
    source: 'discord',
    model: 'claude-opus-4-8',
  });
  const terminalText = 'The sheet operation returned, but I could not verify the resulting rows.';
  let claudeBrainCalls = 0;
  let legacyCalls = 0;

  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    claudeAgentBrain: (async (_surface: string, request: { sessionId: string }) => {
      claudeBrainCalls += 1;
      return {
        text: terminalText,
        sessionId: request.sessionId,
        stoppedReason: 'unverified' as const,
        raw: {
          transport: 'claude_agent_sdk_brain',
          model: 'claude-opus-4-8',
        },
      };
    }) as never,
  });

  const processed = await processBackgroundTasks({
    getRuntime() { return {} as never; },
    async respond(request: { sessionId: string }) {
      legacyCalls += 1;
      return { text: 'unsafe legacy response', sessionId: request.sessionId };
    },
  } as never, 1);

  assert.equal(processed, 1);
  assert.equal(claudeBrainCalls, 1, 'the Claude SDK brain supplied the terminal response');
  assert.equal(legacyCalls, 0, 'the test did not obtain the result through legacy fallback');

  const blocked = getBackgroundTask(task.id);
  assert.equal(blocked?.status, 'blocked', 'unverified work is not complete or waiting on a phantom answer');
  assert.equal(blocked?.pendingQuestionId, undefined);
  assert.equal(blocked?.pendingQuestion, undefined);
  assert.equal(blocked?.pendingApprovalId, undefined);
  assert.equal(blocked?.error, terminalText);
  assert.equal(blocked?.modelProvider, 'claude');
  assert.equal(blocked?.modelRouteKind, 'claude_agent_sdk_brain');
  assert.equal(blocked?.modelTransport, 'claude_agent_sdk_brain');
  assert.equal(blocked?.outcomeSnapshot?.blocker, terminalText);
  assert.equal(blocked?.outcomeSnapshot?.resumable, true, 'the saved task remains explicitly resumable');

  const run = getRun(`run-${task.id}`);
  assert.equal(run?.status, 'failed', 'the tracked run is terminal and needs attention');
  assert.equal(run?.pendingInput, undefined, 'no question authority was minted from verification prose');
  assert.equal(run?.pendingApprovalId, undefined, 'no approval authority was minted from verification prose');
  assert.equal(run?.outputPreview, terminalText);
});
