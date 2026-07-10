/**
 * Run: npx tsx --test src/daemon/runner-warmup.test.ts
 *
 * Focused boot-warmup gate tests. These do not start the daemon loop or call a
 * model provider.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-daemon-warmup-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.DISCORD_ENABLED = 'false';
process.env.SLACK_ENABLED = 'false';
process.env.WEBHOOK_ENABLED = 'false';

const { bootAuthSetupSatisfied, bootModelWarmupEnabled, resolveBootModelWarmupGate } = await import('./runner.js');

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('boot model warmup is explicit opt-in', () => {
  const prior = process.env.CLEMMY_BOOT_WARMUP;
  try {
    delete process.env.CLEMMY_BOOT_WARMUP;
    assert.equal(bootModelWarmupEnabled(), false);
    process.env.CLEMMY_BOOT_WARMUP = 'on';
    assert.equal(bootModelWarmupEnabled(), true);
    process.env.CLEMMY_BOOT_WARMUP = 'off';
    assert.equal(bootModelWarmupEnabled(), false);
  } finally {
    if (prior === undefined) delete process.env.CLEMMY_BOOT_WARMUP;
    else process.env.CLEMMY_BOOT_WARMUP = prior;
  }
});

test('BYO all_in satisfies the boot auth check without an OpenAI key', () => {
  const keys = ['MODEL_ROUTING_MODE', 'BYO_MODEL_BASE_URL', 'BYO_MODEL_API_KEY', 'BYO_MODEL_ID'] as const;
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    delete process.env.MODEL_ROUTING_MODE;
    delete process.env.BYO_MODEL_BASE_URL;
    delete process.env.BYO_MODEL_API_KEY;
    delete process.env.BYO_MODEL_ID;
    assert.equal(bootAuthSetupSatisfied(false), false);

    process.env.MODEL_ROUTING_MODE = 'all_in';
    process.env.BYO_MODEL_BASE_URL = 'https://byo.example.test/v1';
    process.env.BYO_MODEL_API_KEY = 'byo-key';
    process.env.BYO_MODEL_ID = 'byo-brain';
    assert.equal(bootAuthSetupSatisfied(false), true);
  } finally {
    for (const key of keys) {
      const value = prior[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Claude OAuth satisfies the boot auth check without Codex credentials', () => {
  const priorMode = process.env.AUTH_MODE;
  const vault = path.join(TMP_HOME, 'state', 'claude-auth.json');
  try {
    process.env.AUTH_MODE = 'claude_oauth';
    mkdirSync(path.dirname(vault), { recursive: true });
    writeFileSync(vault, JSON.stringify({
      accessToken: 'sk-ant-oat01-boot-auth-test',
      refreshToken: 'refresh-test',
      expiresAt: Date.now() + 3_600_000,
    }), 'utf-8');
    assert.equal(bootAuthSetupSatisfied(false), true);
  } finally {
    rmSync(vault, { force: true });
    if (priorMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = priorMode;
  }
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
