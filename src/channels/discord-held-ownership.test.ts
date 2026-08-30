/**
 * Focused contract for a Discord observer of host-owned nonterminal work.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/channels/discord-held-ownership.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-discord-held-owner-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.AUTH_MODE = 'claude_oauth';
process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'off';
process.env.CLEMMY_HARNESS_DISCORD = 'on';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.CLEMMY_PLAN_FIRST = 'off';
process.env.CLEMMY_VERIFY_DELIVERED = 'off';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';

mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'claude-auth.json'), JSON.stringify({
  accessToken: 'sk-ant-oat01-discord-held-owner',
  refreshToken: 'discord-held-owner-refresh',
  expiresAt: Date.now() + 60 * 60_000,
  scopes: ['user:inference'],
}), 'utf8');

const {
  resolveActiveDiscordHarnessRuns,
  runDiscordHarnessConversation,
} = await import('./discord-harness.js');
const {
  getLatestRunAttempt,
  listEvents,
  resetEventLog,
} = await import('../runtime/harness/eventlog.js');
const { HarnessSession } = await import('../runtime/harness/session.js');
const { _setBridgeImplsForTests } = await import('../runtime/harness/respond-bridge.js');
const {
  resetHarnessRuntimeConfig,
} = await import('../runtime/harness/codex-client.js');

const HOLD = {
  owner: 'host' as const,
  wake: 'peer' as const,
  reason: 'peer_in_progress' as const,
};

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Discord held response exceeded ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test('Discord reports a typed hold promptly without settling its durable owner', async () => {
  resetEventLog();
  resetHarnessRuntimeConfig();
  const loopEntries: Array<{ sessionId: string; sourceUserSeq: number }> = [];
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    buildAgent: (async () => {
      throw new Error('held ownership must not build a second model');
    }) as never,
    runConversation: (async (options: { sessionId: string; sourceUserSeq?: number }) => {
      const sourceUserSeq = Number(options.sourceUserSeq);
      const source = listEvents(options.sessionId, { types: ['user_input_received'] })
        .find((event) => event.seq === sourceUserSeq);
      assert.ok(source, 'the held loop remains bound to its exact accepted source');
      loopEntries.push({ sessionId: options.sessionId, sourceUserSeq });
      return {
        sessionId: options.sessionId,
        status: 'held',
        steps: 0,
        lastTurn: source.turn,
        hold: HOLD,
      };
    }) as never,
  });

  const channelId = 'discord-held-owner-channel';
  const userId = 'discord-held-owner-user';
  const guildId = 'discord-held-owner-guild';
  const initial: string[] = [];
  const edits: string[] = [];
  const typedHolds: unknown[] = [];

  await within(runDiscordHarnessConversation({
    prompt: 'Continue the exact held task.',
    rawPrompt: 'Continue the exact held task.',
    channelId,
    userId,
    guildId,
    transport: {
      async sendInitial(content) {
        initial.push(content);
        return {
          async edit(next) { edits.push(next); },
        };
      },
      async sendError(content) { assert.fail(`unexpected Discord error: ${content}`); },
      onState(state) {
        if (state.typedExecutionHold) typedHolds.push(state.typedExecutionHold);
      },
    },
  }), 2_000);

  assert.equal(loopEntries.length, 1);
  const [{ sessionId, sourceUserSeq }] = loopEntries;
  assert.equal(initial.length, 1, 'Discord owns one placeholder for the held request');
  assert.ok(edits.some((text) => /did not start a duplicate attempt/i.test(text)),
    'the placeholder is promptly replaced with the canonical nonterminal acknowledgement');
  assert.deepEqual(typedHolds.at(-1), HOLD, 'the transport receives the exact typed owner/wake/reason');
  assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 0,
    'held ownership never forges a terminal');
  assert.equal(listEvents(sessionId, { types: ['user_input_received'] })[0]?.seq, sourceUserSeq);
  const attempt = getLatestRunAttempt(sessionId);
  assert.ok(attempt);
  assert.equal(attempt.status, 'active');
  assert.equal(attempt.finishedAt, null);
  assert.ok(HarnessSession.load(sessionId)?.runInFlightSince(),
    'the exact durable owner remains armed for peer/recovery continuation');
  assert.equal(resolveActiveDiscordHarnessRuns({ channelId, userId, guildId }).length, 0,
    'the completed transport observer is released without settling the durable owner');
});

test.after(() => {
  _setBridgeImplsForTests({});
  resetHarnessRuntimeConfig();
  resetEventLog();
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});
