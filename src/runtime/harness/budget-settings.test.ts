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

test('UI-correctness defect 1: a partial save PRESERVES fields it omits (no silent maxRunTokens wipe)', async () => {
  resetBudgetEnv();
  const { saveHarnessBudgetSettings, getHarnessBudgetSettings } = await import('./budget-settings.js');

  // A run-token ceiling set from chat / an explicit prior save.
  saveHarnessBudgetSettings({ preset: 'standard', maxRunTokens: 250_000 });
  assert.equal(getHarnessBudgetSettings().maxRunTokens, 250_000);

  // The Run-limits form saves WITHOUT maxRunTokens (a partial save, same preset).
  saveHarnessBudgetSettings({ maxConversationSteps: 55, maxTurns: 30 });
  const after = getHarnessBudgetSettings();
  assert.equal(after.maxRunTokens, 250_000, 'the omitted ceiling survives — this was the data-loss bug');
  assert.equal(after.maxConversationSteps, 55, 'the sent field applies');
  assert.equal(after.maxTurns, 30);
});

test('UI-correctness defect 1: a deliberate PRESET SWITCH still resets omitted fields to that preset', async () => {
  resetBudgetEnv();
  const { saveHarnessBudgetSettings, getHarnessBudgetSettings } = await import('./budget-settings.js');
  saveHarnessBudgetSettings({ preset: 'standard', maxConversationSteps: 999 });
  assert.equal(getHarnessBudgetSettings().maxConversationSteps, 999);
  // Switching to 'long' is an intentional reshape — omitted fields take the new preset's shape.
  const long = saveHarnessBudgetSettings({ preset: 'long' });
  assert.notEqual(long.maxConversationSteps, 999, 'a preset switch legitimately resets omitted fields');
});

// ─── Supervised-unlimited is the DEFAULT ─────────────────────────────────────
//
// A run stops for a terminal outcome, a user-owned gate, a user stop, or zero
// progress — never because a ceiling was reached while the work was still
// going. The old default shipped a 120-minute wall clock and a 40-turn ceiling
// to every new install, so a long agentic task ended on the clock rather than
// on the work.
test('the default preset is supervised-unlimited', async () => {
  const { getHarnessBudgetSettings } = await import('./budget-settings.js');
  // resetBudgetEnv blanks the key; a blank is "unset" to presetFromEnv, while
  // deleting it would let a previously PERSISTED preset in this fixture home
  // answer instead of the built-in default under test. The unlimited preset's
  // own shape (no wall clock, no token ceiling) is pinned separately above.
  resetBudgetEnv();
  assert.equal(getHarnessBudgetSettings().preset, 'unlimited');
});

test('an explicit preset still wins — the caps remain selectable', async () => {
  const { getHarnessBudgetSettings } = await import('./budget-settings.js');
  const previous = process.env.HARNESS_BUDGET_PRESET;
  resetBudgetEnv();
  process.env.HARNESS_BUDGET_PRESET = 'standard';
  try {
    const budget = getHarnessBudgetSettings();
    assert.equal(budget.preset, 'standard');
    assert.ok(budget.maxRunTokens > 0, 'a user who asks for a ceiling still gets one');
  } finally {
    if (previous === undefined) delete process.env.HARNESS_BUDGET_PRESET;
    else process.env.HARNESS_BUDGET_PRESET = previous;
  }
});
