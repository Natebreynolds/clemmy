/**
 * Focused contract for a cron observer of host-owned nonterminal work.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/daemon/cron-held-ownership.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-cron-held-owner-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.AUTH_MODE = 'claude_oauth';
process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'off';
process.env.CLEMMY_HARNESS_CRON = 'on';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.CLEMMY_VERIFY_DELIVERED = 'off';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';

mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'claude-auth.json'), JSON.stringify({
  accessToken: 'sk-ant-oat01-cron-held-owner',
  refreshToken: 'cron-held-owner-refresh',
  expiresAt: Date.now() + 60 * 60_000,
  scopes: ['user:inference'],
}), 'utf8');

const {
  _testOnly_processCronSchedules: processCronSchedules,
  _testOnly_waitForCronScheduleIdle: waitForCronScheduleIdle,
  cronOccurrenceSessionId,
} = await import('./runner.js');
const { CRON_FILE } = await import('../memory/vault.js');
const { CRON_RUNS_DIR } = await import('../tools/shared.js');
const {
  getLatestRunAttempt,
  listEvents,
  resetEventLog,
} = await import('../runtime/harness/eventlog.js');
const { _setBridgeImplsForTests } = await import('../runtime/harness/respond-bridge.js');
const { resetHarnessRuntimeConfig } = await import('../runtime/harness/codex-client.js');
const { closePlanScope, getPlanScope } = await import('../agents/plan-scope.js');
const { listNotifications } = await import('../runtime/notifications.js');

const HOLD = {
  owner: 'host' as const,
  wake: 'recovery' as const,
  reason: 'recovery_pending' as const,
};

test('cron persists a typed hold without completing or settling its owner', async () => {
  resetEventLog();
  resetHarnessRuntimeConfig();
  const jobName = 'cron-held-owner-contract';
  const now = new Date(Date.UTC(2026, 7, 27, 21, 17, 10));
  const occurrenceAtMs = Math.floor(now.getTime() / 60_000) * 60_000;
  const sessionId = cronOccurrenceSessionId(jobName, occurrenceAtMs);
  let loopEntries = 0;
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    buildAgent: (async () => {
      throw new Error('held cron ownership must not build a second model');
    }) as never,
    runConversation: (async (options: { sessionId: string; sourceUserSeq?: number }) => {
      loopEntries += 1;
      assert.equal(options.sessionId, sessionId);
      const source = listEvents(options.sessionId, { types: ['user_input_received'] })
        .find((event) => event.seq === options.sourceUserSeq);
      assert.ok(source, 'cron hold remains bound to its exact accepted source');
      return {
        sessionId: options.sessionId,
        status: 'held',
        steps: 0,
        lastTurn: source.turn,
        hold: HOLD,
      };
    }) as never,
  });

  mkdirSync(path.dirname(CRON_FILE), { recursive: true });
  writeFileSync(CRON_FILE, [
    '---',
    'jobs:',
    `  - name: ${jobName}`,
    '    schedule: "* * * * *"',
    '    prompt: "Continue the exact held cron task."',
    '    enabled: true',
    '---',
    '',
  ].join('\n'), 'utf8');
  await processCronSchedules({
    async respond() { throw new Error('held cron must not enter the legacy assistant'); },
  } as never, {
    lastCronRunByMinute: {},
    lastCronEvaluatedAtMs: now.getTime() - 60_000,
  } as never, now);
  await waitForCronScheduleIdle();

  assert.equal(loopEntries, 1);
  const records = readFileSync(path.join(CRON_RUNS_DIR, `${jobName}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.status, 'held');
  assert.equal(records[0]?.finishedAt, undefined, 'a nonterminal observation has no finish timestamp');
  assert.deepEqual(records[0]?.nonterminal, {
    version: 1,
    kind: 'held',
    terminal: false,
    stoppedReason: 'in-progress',
    ownership: HOLD,
  });
  const notification = listNotifications(20).find((item) => item.metadata?.job === jobName);
  assert.ok(notification);
  assert.equal(notification.metadata?.status, 'held');
  assert.deepEqual(notification.metadata?.nonterminal, records[0]?.nonterminal);
  assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 0);
  const attempt = getLatestRunAttempt(sessionId);
  assert.ok(attempt);
  assert.equal(attempt.status, 'active');
  assert.equal(attempt.finishedAt, null);
  assert.ok(getPlanScope(sessionId), 'the held owner keeps its admitted execution scope');
  closePlanScope(sessionId, 'focused-test-cleanup');
});

test.after(async () => {
  await waitForCronScheduleIdle();
  _setBridgeImplsForTests({});
  resetHarnessRuntimeConfig();
  resetEventLog();
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});
