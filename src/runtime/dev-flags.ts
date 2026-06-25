/**
 * Developer feature-flags registry + runtime store.
 *
 * A curated, labeled view over the CLEMMY_* kill-switches so they can be flipped
 * at runtime from the desktop "Developer" panel — no .env edit, no restart.
 *
 * Mechanism: every flag here is read through getRuntimeEnv() (config.ts), which
 * checks process.env BEFORE the .env files on every call. setDevFlag() routes
 * through updateEnvKey() — which writes BASE_DIR/.env AND mirrors process.env —
 * so a toggle takes effect on the very next read AND survives a restart.
 * clearDevFlag() uses removeEnvKey() to drop the override entirely, reverting to
 * the code default (so resetting never pins a stale default).
 *
 * Safety: only CLEMMY_* keys may be set/cleared (never secrets/auth/ports), and
 * the routes that call this are loopback + token gated like every console API.
 * A handful of boot-time `const` flags (e.g. DISCORD_ENABLED) are NOT live and
 * are deliberately excluded from the curated set — they aren't CLEMMY_*.
 */
import { getRuntimeEnv } from '../config.js';
import { readBaseEnv, updateEnvKey, removeEnvKey } from '../tools/shared.js';

export type DevFlagType = 'boolean' | 'string';

export interface DevFlagDef {
  key: string;
  label: string;
  category: string;
  type: DevFlagType;
  /** Documented code default — the display label AND the effective value when
   *  there is no override. Verified against each flag's enabling function. */
  default: string;
  description: string;
  /** Known value set, for string flags rendered as a picker. */
  options?: string[];
}

/** The master toggle that reveals the whole panel in the desktop UI. */
export const DEV_MODE_KEY = 'CLEMMY_DEV_MODE';

/**
 * Curated set — the notable behavioral on/off gates (plus the one string flag,
 * the rubric variant). Everything else is reachable via the panel's "set any
 * CLEMMY_ key" escape hatch. Defaults below were read from each enabling
 * function, but clearDevFlag reverts to the live code default regardless, so a
 * stale label here can never pin the wrong behavior.
 */
export const DEV_FLAG_REGISTRY: DevFlagDef[] = [
  // ── Write & safety gates (default ON — flip OFF to disable a guardrail) ──
  { key: 'CLEMMY_CONFIRM_FIRST', label: 'Confirm-first batch gate', category: 'Gates & safety', type: 'boolean', default: 'on', description: 'Pause for approval before a batch of same-shape irreversible writes (emails, posts).' },
  { key: 'CLEMMY_GOAL_FIDELITY_GATE', label: 'Goal-fidelity gate', category: 'Gates & safety', type: 'boolean', default: 'on', description: 'Pre-write judge: does this irreversible write advance the goal + honor the loaded skill?' },
  { key: 'CLEMMY_GROUNDING_GATE', label: 'Grounding gate', category: 'Gates & safety', type: 'boolean', default: 'on', description: 'Block a write whose payload contradicts the sources the agent gathered.' },
  { key: 'CLEMMY_OUTPUT_GROUNDING_GATE', label: 'Output-grounding (numeric) gate', category: 'Gates & safety', type: 'boolean', default: 'on', description: 'Bounce a deliverable whose figures cannot be traced to the session’s own tool results.' },
  { key: 'CLEMMY_DESTINATION_GATE', label: 'Destination gate', category: 'Gates & safety', type: 'boolean', default: 'on', description: 'Nudge to confirm the destination on an ambient-target publish/deploy.' },
  { key: 'CLEMMY_PARALLEL_PREWRITE_GATES', label: 'Parallel pre-write gates', category: 'Gates & safety', type: 'boolean', default: 'on', description: 'Run the pre-write judges concurrently (latency win, lossless).' },

  // ── Brain & judges ──
  { key: 'CLEMMY_BRAIN_FALLOVER', label: 'Brain fallover', category: 'Brain & judges', type: 'boolean', default: 'on', description: 'Fall over to an alternate brain provider on a transient/overload failure.' },
  { key: 'CLEMMY_JUDGE_CROSS_FAMILY', label: 'Cross-family judge', category: 'Brain & judges', type: 'boolean', default: 'on', description: 'Force the judge/checker to a different LLM family than the brain (never self-grade).' },
  { key: 'CLEMMY_DEBATE_MODE', label: 'Debate / verify mode', category: 'Brain & judges', type: 'boolean', default: 'off', description: 'Multi-brain debate + verify-checker on high-stakes turns.' },
  { key: 'CLEMMY_RUBRIC_VARIANT', label: 'Orchestrator rubric variant', category: 'Brain & judges', type: 'string', default: 'legacy', description: 'Which orchestrator rubric to inject. "lean" is ~80% smaller than legacy.', options: ['legacy', 'lean'] },

  // ── Tools & efficiency ──
  { key: 'CLEMMY_TOOL_JIT', label: 'JIT tool selection (Tool-RAG)', category: 'Tools & efficiency', type: 'boolean', default: 'on', description: 'Advertise only the turn-relevant tools to shrink the surface + token cost.' },
  { key: 'CLEMMY_CODE_MODE', label: 'Code Mode (run_tool_program)', category: 'Tools & efficiency', type: 'boolean', default: 'on', description: 'Let the model write ONE program that batches tool calls instead of serial loops.' },
  { key: 'CLEMMY_CODE_MODE_WRITES', label: 'Code Mode writes', category: 'Tools & efficiency', type: 'boolean', default: 'on', description: 'Allow gated external writes from inside a code-mode program (full gate chain still fires).' },
  { key: 'CLEMMY_MCP_ERROR_CORRECTIVE', label: 'MCP error self-correct', category: 'Tools & efficiency', type: 'boolean', default: 'on', description: 'Steer the model to a specific recovery move when an MCP tool errors.' },
  { key: 'CLEMMY_WORKER_THRASH_GUARD', label: 'Worker thrash guard', category: 'Tools & efficiency', type: 'boolean', default: 'on', description: 'Per-worker loop-detection so parallel workers don’t poison one tracker.' },
  { key: 'CLEMMY_DYNAMIC_REASONING', label: 'Dynamic reasoning effort', category: 'Tools & efficiency', type: 'boolean', default: 'on', description: 'Pick the per-turn reasoning effort tier from the turn’s intent.' },
  { key: 'CLEMMY_CONTINUATION_CLASSIFY', label: 'Continuation goal classify', category: 'Tools & efficiency', type: 'boolean', default: 'on', description: 'Classify the GOAL (not boilerplate) on continuation turns.' },

  // ── Goals & autonomy ──
  { key: 'CLEMMY_GOAL_CONTRACT', label: 'Goal contracts (master)', category: 'Goals & autonomy', type: 'boolean', default: 'on', description: 'The parked-goal contract loop. OFF disables self-drive + re-orient too.' },
  { key: 'CLEMMY_GOAL_SELF_DRIVE', label: 'Self-driving goal resume', category: 'Goals & autonomy', type: 'boolean', default: 'on', description: 'The daemon re-enters an active goal on a cadence across session ends / sleep.' },
  { key: 'CLEMMY_GOAL_REORIENT_OBS', label: 'Goal re-Orient (fresh observations)', category: 'Goals & autonomy', type: 'boolean', default: 'off', description: 'On resume, fold fresh, goal-relevant monitor observations into the directive (OODA feedback edge).' },
  { key: 'CLEMMY_ATTEMPT_RECORDS', label: 'Attempt records', category: 'Goals & autonomy', type: 'boolean', default: 'on', description: 'Record per-attempt change/cost on loopUntil retries for self-improvement.' },
  { key: 'CLEMMY_IMPROVEMENT_PROPOSER', label: 'Improvement proposer', category: 'Goals & autonomy', type: 'boolean', default: 'off', description: 'Nightly Phase-C proposals from run history (human-gated apply).' },

  // ── Proactive / ambient ──
  { key: 'CLEMMY_INBOX_MONITOR', label: 'Inbox monitor', category: 'Proactive & ambient', type: 'boolean', default: 'on', description: 'Ambient read-only inbox watch that surfaces needs-you mail.' },
  { key: 'CLEMMY_CALENDAR_MONITOR', label: 'Calendar monitor', category: 'Proactive & ambient', type: 'boolean', default: 'on', description: 'Ambient read-only calendar watch (conflicts, unanswered invites, imminent meetings).' },
  { key: 'CLEMMY_SURFACE_DECISION_V2', label: 'Surface-decision scorer v2', category: 'Proactive & ambient', type: 'boolean', default: 'off', description: 'Route monitor signals through the 7-axis act/ask/watch/ignore scorer.' },
  { key: 'CLEMMY_AUTO_FOCUS', label: 'Session auto-focus', category: 'Proactive & ambient', type: 'boolean', default: 'on', description: 'Auto-pin the session focus so recall favors facts about the active task.' },

  // ── Memory ──
  { key: 'CLEMMY_SEMANTIC_RECALL', label: 'Semantic recall', category: 'Memory', type: 'boolean', default: 'on', description: 'Embedding rerank on top of FTS for memory recall.' },
];

const REGISTRY_KEYS = new Set(DEV_FLAG_REGISTRY.map((d) => d.key));
const SAFE_KEY_RE = /^CLEMMY_[A-Z0-9_]+$/;
/** A sentinel that cannot occur as a real value, so we can tell "unset" from "". */
const UNSET = ' __dev_flag_unset__';

/** Only CLEMMY_* keys may be toggled — never secrets, auth, ports, or the
 *  dev-mode master toggle (which has its own setter). */
export function isSafeDevFlagKey(key: string): boolean {
  return SAFE_KEY_RE.test(key) && key !== DEV_MODE_KEY;
}

export function isDevModeEnabled(): boolean {
  return (getRuntimeEnv(DEV_MODE_KEY, 'off') || 'off').trim().toLowerCase() === 'on';
}

export function setDevMode(on: boolean): void {
  updateEnvKey(DEV_MODE_KEY, on ? 'on' : 'off');
}

export interface DevFlagState extends DevFlagDef {
  /** Effective value: the override if present, else the code default. */
  value: string;
  /** True when an explicit override exists (process.env or a .env file). */
  overridden: boolean;
  /** False for escape-hatch keys discovered in .env but not in the registry. */
  curated: boolean;
}

function effectiveValue(key: string, fallback: string): { value: string; overridden: boolean } {
  const raw = getRuntimeEnv(key, UNSET);
  if (raw === UNSET) return { value: fallback, overridden: false };
  return { value: raw, overridden: true };
}

export interface DevFlagsSnapshot {
  devMode: boolean;
  flags: DevFlagState[];
  /** CLEMMY_* keys set in .env that aren't in the curated registry (escape-hatch
   *  overrides), so the panel can show + clear what the user has pinned. */
  custom: DevFlagState[];
}

export function buildDevFlagsSnapshot(): DevFlagsSnapshot {
  const flags: DevFlagState[] = DEV_FLAG_REGISTRY.map((def) => {
    const { value, overridden } = effectiveValue(def.key, def.default);
    return { ...def, value, overridden, curated: true };
  });

  // Escape-hatch overrides the user has pinned in .env (visible + clearable).
  let custom: DevFlagState[] = [];
  try {
    const baseEnv = readBaseEnv();
    custom = Object.keys(baseEnv)
      .filter((k) => SAFE_KEY_RE.test(k) && k !== DEV_MODE_KEY && !REGISTRY_KEYS.has(k))
      .sort()
      .map((key) => ({
        key,
        label: key,
        category: 'Custom (.env)',
        type: 'string' as const,
        default: '',
        description: 'Set via the advanced "any CLEMMY_ key" field.',
        value: baseEnv[key],
        overridden: true,
        curated: false,
      }));
  } catch {
    custom = [];
  }

  return { devMode: isDevModeEnabled(), flags, custom };
}

/** Set an override (writes .env + live process.env). CLEMMY_* keys only. */
export function setDevFlag(key: string, value: string): void {
  if (!isSafeDevFlagKey(key)) throw new Error('only CLEMMY_* keys may be set here');
  updateEnvKey(key, value);
}

/** Clear an override, reverting to the code default. CLEMMY_* keys only. */
export function clearDevFlag(key: string): void {
  if (!isSafeDevFlagKey(key)) throw new Error('only CLEMMY_* keys may be cleared here');
  removeEnvKey(key);
}
