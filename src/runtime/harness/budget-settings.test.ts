import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-budget-settings-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const ENV_KEYS = [
  'HARNESS_BUDGET_PRESET',
  'HARNESS_MAX_CONVERSATION_STEPS',
  'HARNESS_MAX_CONVERSATION_WALL_MINUTES',
  'HARNESS_ORCHESTRATOR_MAX_TURNS',
  'HARNESS_TOOL_CALLS_PER_TURN',
  'HARNESS_CHECK_IN_MINUTES',
  'HARNESS_AUTO_CONTINUE_ON_LIMIT',
] as const;

function resetBudgetEnv(): void {
  for (const key of ENV_KEYS) {
    process.env[key] = '';
  }
}

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('getHarnessBudgetSettings uses the long-workflow preset defaults', async () => {
  resetBudgetEnv();
  process.env.HARNESS_BUDGET_PRESET = 'long';
  const { getHarnessBudgetSettings } = await import('./budget-settings.js');

  const settings = getHarnessBudgetSettings();

  assert.equal(settings.preset, 'long');
  assert.equal(settings.maxConversationSteps, 160);
  assert.equal(settings.maxConversationWallMinutes, 480);
  assert.equal(settings.maxTurns, 120);
  // long preset's toolCallsPerTurn was bumped 32 → 80 to support
  // 80+-call tasks without burning sub-tests on overflow.
  assert.equal(settings.toolCallsPerTurn, 80);
  assert.equal(settings.checkInMinutes, 5);
  assert.equal(settings.autoContinueOnLimit, true);
  assert.equal(settings.unlimited, false);
});

test('getHarnessBudgetSettings treats unlimited as supervised no-wall-clock mode', async () => {
  resetBudgetEnv();
  process.env.HARNESS_BUDGET_PRESET = 'unlimited';
  const { getHarnessBudgetSettings } = await import('./budget-settings.js');

  const settings = getHarnessBudgetSettings();

  assert.equal(settings.preset, 'unlimited');
  assert.equal(settings.maxConversationSteps, 1_000_000);
  assert.equal(settings.maxConversationWallMinutes, 0);
  assert.equal(settings.maxConversationWallMs, 0);
  assert.equal(settings.maxTurns, 500);
  assert.equal(settings.toolCallsPerTurn, 64);
  assert.equal(settings.checkInMinutes, 3);
  assert.equal(settings.autoContinueOnLimit, true);
  assert.equal(settings.unlimited, true);
});

test('saveHarnessBudgetSettings persists to Clementine home and updates process env', async () => {
  resetBudgetEnv();
  const { saveHarnessBudgetSettings } = await import('./budget-settings.js');

  const settings = saveHarnessBudgetSettings({
    preset: 'unlimited',
    maxConversationSteps: 5000,
    maxConversationWallMinutes: 0,
    maxTurns: 777,
    toolCallsPerTurn: 48,
    checkInMinutes: 2,
    autoContinueOnLimit: true,
  });

  assert.equal(settings.preset, 'unlimited');
  assert.equal(settings.maxConversationSteps, 5000);
  assert.equal(settings.maxConversationWallMinutes, 0);
  assert.equal(settings.maxTurns, 777);
  assert.equal(settings.toolCallsPerTurn, 48);
  assert.equal(settings.checkInMinutes, 2);
  assert.equal(settings.autoContinueOnLimit, true);
  assert.equal(process.env.HARNESS_ORCHESTRATOR_MAX_TURNS, '777');

  const envPath = path.join(TMP_HOME, '.env');
  assert.equal(existsSync(envPath), true);
  const saved = readFileSync(envPath, 'utf-8');
  assert.match(saved, /^HARNESS_BUDGET_PRESET=unlimited$/m);
  assert.match(saved, /^HARNESS_ORCHESTRATOR_MAX_TURNS=777$/m);
  assert.match(saved, /^HARNESS_AUTO_CONTINUE_ON_LIMIT=true$/m);
});
