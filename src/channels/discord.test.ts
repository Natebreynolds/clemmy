/**
 * Run: npx tsx --test src/channels/discord.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-discord-test-'));
const PREV_HOME = process.env.CLEMENTINE_HOME;
const PREV_HARNESS_WEBHOOK = process.env.CLEMMY_HARNESS_WEBHOOK;
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_HARNESS_WEBHOOK = 'off';

const { __test__ } = await import('./discord.js');

after(() => {
  if (PREV_HARNESS_WEBHOOK === undefined) delete process.env.CLEMMY_HARNESS_WEBHOOK;
  else process.env.CLEMMY_HARNESS_WEBHOOK = PREV_HARNESS_WEBHOOK;
  if (PREV_HOME === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = PREV_HOME;
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('continue button resumes through the gateway with the original session id', async () => {
  let captured: { message: string; sessionId: string; userId?: string; channel?: string; runId?: string } | undefined;
  const assistant = {
    respond: async (req: typeof captured) => {
      captured = req;
      return { text: 'continued from gateway', sessionId: req!.sessionId };
    },
  };

  const response = await __test__.continueDiscordSessionFromButton({
    assistant: assistant as never,
    sessionId: 'sess-discord-original',
    userId: 'user-123',
    channelId: 'chan-456',
    guildId: 'guild-789',
  });

  assert.equal(response.text, 'continued from gateway');
  assert.equal(captured?.message, 'continue');
  assert.equal(captured?.sessionId, 'sess-discord-original');
  assert.equal(captured?.userId, 'user-123');
  assert.equal(captured?.channel, 'discord:guild-789:chan-456');
  assert.match(captured?.runId ?? '', /^run-/);
});
