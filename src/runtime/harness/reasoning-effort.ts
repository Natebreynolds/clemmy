/**
 * Dynamic reasoning effort (per-turn). gpt-5.x reasoning models "think" before
 * emitting any token, and reasoning depth is the dominant per-turn latency knob.
 *
 * GROUND TRUTH (verified against @openai/agents-core 0.11.5 — same version the
 * live app ships — and the user's gpt-5.5 setup): the SDK's per-model default
 * for gpt-5.5 is `reasoning.effort: 'none'`. So simple turns are ALREADY at
 * minimum effort; there is no over-reasoning to cut on a calendar lookup. This
 * feature only ever RAISES effort above that baseline, and only where it helps.
 *
 * Explicit Plan requests high effort: the owner chose to invest in preparation.
 * Approved Execute uses the task's complexity tier, even in a chat session.
 * Otherwise the axis is "is a human waiting on this turn?" (real traffic:
 * across 1271 turns, 83% of `complex` turns were background WORKFLOW turns where
 * latency is invisible; only ~10% of interactive chat turns were complex):
 *   - Ordinary interactive turns: cap at 'medium'. 78% of chat is simple → 'none'
 *     (instant); the rest nudges to 'medium' at most.
 *   - Background turns (workflow / execution / goal-resume — no human waiting):
 *     may use 'high'. These are the multi-step prospect-prep / Salesforce
 *     workflows where depth aids task completion and the wait costs nothing.
 *
 * Complexity is NOT re-derived here — we reuse the harness's existing
 * `classifyComplexity` (context-packet.ts), already computed every turn, so this
 * is one source of truth, not a duplicate classifier.
 *
 * CLEMMY_DYNAMIC_REASONING=off disables automatic complexity-based selection.
 * Explicit Plan still requests high effort. Provider adapters translate only
 * supported controls; selecting a tier is not proof it reached the wire.
 */
import { getRuntimeEnv } from '../../config.js';
import type { AgentContextPacket } from './context-packet.js';
import type { TaskMode } from './task-mode.js';
import {
  READ_RE,
  SEQUENCE_RE,
  WRITE_RE,
  positiveActionSignalText,
} from './multi-item-intent.js';

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

export function dynamicReasoningEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_DYNAMIC_REASONING', 'on') ?? 'on').toLowerCase() !== 'off';
}

/**
 * Continuation-aware classification (CLEMMY_CONTINUATION_CLASSIFY, default on).
 * On a self-continuation turn the harness re-enters with a canned CONTINUATION
 * nudge as the input, which always classifies 'simple' → effort 'none' even when
 * the parked goal is a multi-step build. When enabled, the loop classifies the
 * context packet against the active goal's objective instead — so complexity
 * (and skill/workflow ranking) reflect the TASK she is mid-flight on, not the
 * boilerplate. `off` → classify the literal input (byte-identical to before).
 */
export function continuationClassifyEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_CONTINUATION_CLASSIFY', 'on') ?? 'on').toLowerCase() !== 'off';
}

export interface EffortSignals {
  /** Durable user-selected mode, never inferred from the request's wording. */
  taskMode?: TaskMode['kind'];
  /**
   * True when a human is waiting on this turn (interactive chat). Caps effort
   * at 'medium' for ordinary chat. Explicit Plan takes precedence.
   * Background turns (workflow / execution / goal-resume) leave this false and
   * may use 'high' — latency is invisible there and depth aids hard work.
   */
  interactive?: boolean;
  /**
   * True only for one bounded foreground action: no per-item work, no explicit
   * sequence, and no combined read/write plan. A moderate classifier result can
   * otherwise come from scalar request details (times, durations, versions),
   * which should not make an interactive single-action turn enter extended
   * deliberation before it can act.
   */
  boundedForegroundAction?: boolean;
}

export interface TurnEffortSignalInput {
  taskMode?: TaskMode['kind'];
  interactive: boolean;
  turnIntent: AgentContextPacket['turnIntent'];
  multiItem: boolean;
  text: string;
}

/**
 * Derive the foreground posture from the same provider-neutral request facts
 * already used by context assembly. This is latency policy only; it grants no
 * tool or effect authority.
 */
export function reasoningEffortSignalsForTurn(input: TurnEffortSignalInput): EffortSignals {
  const actionText = positiveActionSignalText(input.text);
  const hasRead = READ_RE.test(actionText);
  const hasWrite = WRITE_RE.test(actionText);
  return {
    taskMode: input.taskMode,
    interactive: input.interactive,
    boundedForegroundAction: input.interactive
      && input.turnIntent === 'action'
      && !input.multiItem
      && !SEQUENCE_RE.test(actionText)
      && !(hasRead && hasWrite),
  };
}

/** Base ladder: complexity → effort, before the interactive ceiling. */
function baseEffort(complexity: AgentContextPacket['complexity']): ReasoningEffort {
  switch (complexity) {
    case 'complex':
      return 'high';
    case 'moderate':
      return 'medium';
    case 'simple':
    default:
      return 'none';
  }
}

/**
 * Pick the reasoning effort for a turn. Pure + cheap (no LLM). `complexity`
 * comes from the harness context packet (`classifyComplexity`).
 */
export function selectReasoningEffort(
  complexity: AgentContextPacket['complexity'],
  signals: EffortSignals = {},
): { effort: ReasoningEffort; reason: string } {
  if (signals.taskMode === 'plan') {
    return { effort: 'high', reason: 'explicit-plan' };
  }
  const base = baseEffort(complexity);
  if (signals.taskMode === 'execute') {
    return { effort: base, reason: `explicit-execute/complexity:${complexity}` };
  }
  if (
    signals.interactive
    && signals.boundedForegroundAction
    && complexity === 'moderate'
  ) {
    // One foreground action should reach its tool path promptly. The moderate
    // tier is often carried by scalar details rather than multi-step work.
    return { effort: 'none', reason: 'moderate/interactive-single-action' };
  }
  if (signals.interactive && base === 'high') {
    // A person is waiting — cap the slowest tier.
    return { effort: 'medium', reason: 'complex/interactive-cap' };
  }
  return { effort: base, reason: `complexity:${complexity}` };
}
