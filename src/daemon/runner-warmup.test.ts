/**
 * Run: npx tsx --test src/daemon/runner-warmup.test.ts
 *
 * Focused boot-warmup gate tests. These do not start the daemon loop or call a
 * model provider.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-daemon-warmup-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.DISCORD_ENABLED = 'false';
process.env.SLACK_ENABLED = 'false';
process.env.WEBHOOK_ENABLED = 'false';

const { resolveBootModelWarmupGate } = await import('./runner.js');

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('resolveBootModelWarmupGate runs when the harness router configures', async () => {
  const gate = await resolveBootModelWarmupGate(
    async () => ({ ok: true }),
    () => '',
  );

  assert.deepEqual(gate, {
    run: true,
    harnessConfigured: true,
    directOpenAiKey: false,
  });
});

test('resolveBootModelWarmupGate skips cleanly when no model runtime or direct key is available', async () => {
  const gate = await resolveBootModelWarmupGate(
    async () => ({ ok: false, reason: 'No AI model is signed in yet.' }),
    () => '',
  );

  assert.deepEqual(gate, {
    run: false,
    harnessConfigured: false,
    directOpenAiKey: false,
    reason: 'No AI model is signed in yet.',
  });
});

test('resolveBootModelWarmupGate preserves direct OpenAI-key fallback compatibility', async () => {
  const gate = await resolveBootModelWarmupGate(
    async () => ({ ok: false, reason: 'No AI model is signed in yet.' }),
    () => 'sk-test',
  );

  assert.deepEqual(gate, {
    run: true,
    harnessConfigured: false,
    directOpenAiKey: true,
    reason: 'No AI model is signed in yet.',
  });
});

test('resolveBootModelWarmupGate treats configure exceptions as skip unless a direct key exists', async () => {
  const gate = await resolveBootModelWarmupGate(
    async () => { throw new Error('router not ready'); },
    () => '',
  );

  assert.deepEqual(gate, {
    run: false,
    harnessConfigured: false,
    directOpenAiKey: false,
    reason: 'router not ready',
  });
});
