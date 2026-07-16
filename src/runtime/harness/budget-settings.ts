import { getRuntimeEnv } from '../../config.js';
import { updateEnvKey } from '../../tools/shared.js';

export type HarnessBudgetPreset = 'standard' | 'long' | 'unlimited';

export interface HarnessBudgetSettings {
  preset: HarnessBudgetPreset;
  maxConversationSteps: number;
  maxConversationWallMinutes: number;
  maxTurns: number;
  toolCallsPerTurn: number;
  /** How many workers run in parallel per session when Clementine fans a big job out into a
   *  swarm (run_worker). Higher = faster on 100-item jobs; lower = gentler on rate limits. */
  maxParallelWorkers: number;
  checkInMinutes: number;
  autoContinueOnLimit: boolean;
  /** Stage 4 — aggregate run token budget (soft ceiling, UNCACHED tokens per
   *  run window). Catches RUNAWAY spend, never legit scale: a heavy worker
   *  turn is ~50-150k uncached tokens, a legit 100-worker 60-min run burns
   *  3-8M. 0 = no ceiling. Enforcement is kill-switched (CLEMMY_RUN_TOKEN_BUDGET);
   *  metering always runs. */
  maxRunTokens: number;
}

export interface HarnessBudgetRuntime extends HarnessBudgetSettings {
  maxConversationWallMs: number;
  unlimited: boolean;
}

const PRESETS: Record<HarnessBudgetPreset, HarnessBudgetSettings> = {
  standard: {
    preset: 'standard',
    maxConversationSteps: 40,
    maxConversationWallMinutes: 120,
    maxTurns: 40,
    // Phase 3 single-agent shape needs a higher per-turn ceiling than the
    // old orchestrator+sub-agent split did. A real multi-step turn now
    // looks like: 4 recalls (parallel) + 3 discovery (parallel) +
    // 3 remembers (parallel) + 4-8 mutating calls = 15-20 calls in
    // ONE response. The 16 ceiling killed the lunar-audit run on
    // 2026-05-21 — agent read SKILL.md + 6 source files and hit the
    // wall before doing any actual work. 40 leaves room for real
    // multi-step work while still catching runaway model behavior.
    toolCallsPerTurn: 40,
    maxParallelWorkers: 6,
    checkInMinutes: 10,
    autoContinueOnLimit: false,
    maxRunTokens: 10_000_000,
  },
  long: {
    preset: 'long',
    maxConversationSteps: 160,
    maxConversationWallMinutes: 480,
    maxTurns: 120,
    toolCallsPerTurn: 80,
    maxParallelWorkers: 8,
    checkInMinutes: 5,
    autoContinueOnLimit: true,
    maxRunTokens: 30_000_000,
  },
  unlimited: {
    preset: 'unlimited',
    // "Unlimited" is supervised unlimited: no wall-clock cutoff and
    // very high step/turn ceilings so normal workflows do not silently
    // end. Kill switch, approvals, tool timeouts, and stuck detection
    // still apply.
    maxConversationSteps: 1_000_000,
    maxConversationWallMinutes: 0,
    maxTurns: 500,
    toolCallsPerTurn: 64,
    maxParallelWorkers: 12,
    checkInMinutes: 3,
    autoContinueOnLimit: true,
    // No token ceiling on supervised-unlimited; env override can still set one.
    maxRunTokens: 0,
  },
};

const ENV_KEYS = {
  preset: 'HARNESS_BUDGET_PRESET',
  maxConversationSteps: 'HARNESS_MAX_CONVERSATION_STEPS',
  maxConversationWallMinutes: 'HARNESS_MAX_CONVERSATION_WALL_MINUTES',
  maxTurns: 'HARNESS_ORCHESTRATOR_MAX_TURNS',
  toolCallsPerTurn: 'HARNESS_TOOL_CALLS_PER_TURN',
  maxParallelWorkers: 'CLEMMY_WORKER_MAX_CONCURRENCY',
  checkInMinutes: 'HARNESS_CHECK_IN_MINUTES',
  autoContinueOnLimit: 'HARNESS_AUTO_CONTINUE_ON_LIMIT',
  maxRunTokens: 'HARNESS_MAX_RUN_TOKENS',
} as const;

export const HARNESS_BUDGET_PRESETS = Object.freeze([
  { id: 'standard', label: 'Standard', description: '40 steps, 120 minutes, regular approvals.' },
  { id: 'long', label: 'Long workflow', description: 'Higher turn/tool budget with 5-minute check-ins.' },
  { id: 'unlimited', label: 'Unlimited supervised', description: 'No wall-clock cutoff, high ceilings, frequent visible check-ins.' },
] satisfies Array<{ id: HarnessBudgetPreset; label: string; description: string }>);

function presetFromEnv(raw: string): HarnessBudgetPreset {
  return raw === 'long' || raw === 'unlimited' || raw === 'standard' ? raw : 'standard';
}

function intEnv(key: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(getRuntimeEnv(key, String(fallback)), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function boolEnv(key: string, fallback: boolean): boolean {
  const raw = getRuntimeEnv(key, fallback ? 'true' : 'false').trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return fallback;
}

export function getHarnessBudgetSettings(): HarnessBudgetRuntime {
  const preset = presetFromEnv(getRuntimeEnv(ENV_KEYS.preset, 'standard'));
  const defaults = PRESETS[preset];
  const maxConversationWallMinutes = intEnv(
    ENV_KEYS.maxConversationWallMinutes,
    defaults.maxConversationWallMinutes,
    0,
    525_600,
  );
  return {
    preset,
    maxConversationSteps: intEnv(ENV_KEYS.maxConversationSteps, defaults.maxConversationSteps, 1, 1_000_000),
    maxConversationWallMinutes,
    maxConversationWallMs: maxConversationWallMinutes > 0 ? maxConversationWallMinutes * 60 * 1000 : 0,
    maxTurns: intEnv(ENV_KEYS.maxTurns, defaults.maxTurns, 1, 2_000),
    toolCallsPerTurn: intEnv(ENV_KEYS.toolCallsPerTurn, defaults.toolCallsPerTurn, 1, 256),
    maxParallelWorkers: intEnv(ENV_KEYS.maxParallelWorkers, defaults.maxParallelWorkers, 1, 64),
    checkInMinutes: intEnv(ENV_KEYS.checkInMinutes, defaults.checkInMinutes, 1, 240),
    autoContinueOnLimit: boolEnv(ENV_KEYS.autoContinueOnLimit, defaults.autoContinueOnLimit),
    maxRunTokens: intEnv(ENV_KEYS.maxRunTokens, defaults.maxRunTokens, 0, 1_000_000_000),
    unlimited: preset === 'unlimited' || maxConversationWallMinutes === 0,
  };
}

/**
 * v0.5.19 F2 — return an "elevated" version of the current budget
 * runtime when the conversation looks like it'll need more headroom.
 *
 * Triggered by the preflight gate seeing `fractionUsed > 0.5` early
 * in a `standard`-preset chat session. Standard's 40 steps / 40
 * turns / 40 tools-per-turn caps trap a long-running task with no
 * recourse (autoContinueOnLimit=false). The elevated runtime applies
 * the `long` preset's defaults (160 / 120 / 80, autoContinue=true)
 * for the remainder of THIS conversation only — no env mutation, no
 * settings.json write. One-way ratchet: never downgrades.
 *
 * Honors env override `CLEMMY_AUTOBUMP_BUDGET=off` (default on).
 */
export function getElevatedBudget(current: HarnessBudgetRuntime): HarnessBudgetRuntime {
  if ((getRuntimeEnv('CLEMMY_AUTOBUMP_BUDGET', 'on') ?? 'on').toLowerCase() === 'off') {
    return current;
  }
  // Only elevate from standard. Already on long/unlimited? No change.
  if (current.preset !== 'standard') return current;
  const long = PRESETS.long;
  const elevatedWallMinutes = Math.max(current.maxConversationWallMinutes, long.maxConversationWallMinutes);
  return {
    // Preset stays as the operator-selected named default — but the
    // runtime caps reflect the elevated shape so the rest of the run
    // gets headroom.
    preset: current.preset,
    maxConversationSteps: Math.max(current.maxConversationSteps, long.maxConversationSteps),
    maxConversationWallMinutes: elevatedWallMinutes,
    maxConversationWallMs: elevatedWallMinutes > 0 ? elevatedWallMinutes * 60 * 1000 : 0,
    maxTurns: Math.max(current.maxTurns, long.maxTurns),
    toolCallsPerTurn: Math.max(current.toolCallsPerTurn, long.toolCallsPerTurn),
    maxParallelWorkers: Math.max(current.maxParallelWorkers, long.maxParallelWorkers),
    checkInMinutes: Math.min(current.checkInMinutes, long.checkInMinutes),
    autoContinueOnLimit: true, // critical — the standard preset's `false` is the trap
    maxRunTokens: current.maxRunTokens === 0 || long.maxRunTokens === 0
      ? 0
      : Math.max(current.maxRunTokens, long.maxRunTokens),
    unlimited: current.unlimited,
  };
}

export function getHarnessBudgetSnapshot(): {
  settings: HarnessBudgetRuntime;
  presets: typeof HARNESS_BUDGET_PRESETS;
  envKeys: typeof ENV_KEYS;
} {
  return {
    settings: getHarnessBudgetSettings(),
    presets: HARNESS_BUDGET_PRESETS,
    envKeys: ENV_KEYS,
  };
}

export function saveHarnessBudgetSettings(input: Partial<Record<keyof HarnessBudgetSettings, unknown>>): HarnessBudgetRuntime {
  const requestedPreset = typeof input.preset === 'string' ? presetFromEnv(input.preset) : getHarnessBudgetSettings().preset;
  const base = PRESETS[requestedPreset];
  const next: HarnessBudgetSettings = {
    preset: requestedPreset,
    maxConversationSteps: clampNumber(input.maxConversationSteps, base.maxConversationSteps, 1, 1_000_000),
    maxConversationWallMinutes: clampNumber(input.maxConversationWallMinutes, base.maxConversationWallMinutes, 0, 525_600),
    maxTurns: clampNumber(input.maxTurns, base.maxTurns, 1, 2_000),
    toolCallsPerTurn: clampNumber(input.toolCallsPerTurn, base.toolCallsPerTurn, 1, 256),
    maxParallelWorkers: clampNumber(input.maxParallelWorkers, base.maxParallelWorkers, 1, 64),
    checkInMinutes: clampNumber(input.checkInMinutes, base.checkInMinutes, 1, 240),
    autoContinueOnLimit: typeof input.autoContinueOnLimit === 'boolean'
      ? input.autoContinueOnLimit
      : base.autoContinueOnLimit,
    maxRunTokens: clampNumber(input.maxRunTokens, base.maxRunTokens, 0, 1_000_000_000),
  };

  updateEnvKey(ENV_KEYS.preset, next.preset);
  updateEnvKey(ENV_KEYS.maxConversationSteps, String(next.maxConversationSteps));
  updateEnvKey(ENV_KEYS.maxConversationWallMinutes, String(next.maxConversationWallMinutes));
  updateEnvKey(ENV_KEYS.maxTurns, String(next.maxTurns));
  updateEnvKey(ENV_KEYS.toolCallsPerTurn, String(next.toolCallsPerTurn));
  updateEnvKey(ENV_KEYS.maxParallelWorkers, String(next.maxParallelWorkers));
  updateEnvKey(ENV_KEYS.checkInMinutes, String(next.checkInMinutes));
  updateEnvKey(ENV_KEYS.autoContinueOnLimit, next.autoContinueOnLimit ? 'true' : 'false');
  updateEnvKey(ENV_KEYS.maxRunTokens, String(next.maxRunTokens));
  process.env[ENV_KEYS.preset] = next.preset;
  process.env[ENV_KEYS.maxConversationSteps] = String(next.maxConversationSteps);
  process.env[ENV_KEYS.maxConversationWallMinutes] = String(next.maxConversationWallMinutes);
  process.env[ENV_KEYS.maxTurns] = String(next.maxTurns);
  process.env[ENV_KEYS.toolCallsPerTurn] = String(next.toolCallsPerTurn);
  process.env[ENV_KEYS.maxParallelWorkers] = String(next.maxParallelWorkers);
  process.env[ENV_KEYS.checkInMinutes] = String(next.checkInMinutes);
  process.env[ENV_KEYS.autoContinueOnLimit] = next.autoContinueOnLimit ? 'true' : 'false';
  process.env[ENV_KEYS.maxRunTokens] = String(next.maxRunTokens);
  return getHarnessBudgetSettings();
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
