/**
 * When Jev's completion screen is worth asking, learned from its own record.
 *
 * Jev settles a completion review only on a small, fully visible reply; a
 * large one carries more specifics than it can be sure of, and one whose
 * evidence would be clipped can never settle as done. Every such call is paid
 * and then handed to the configured reviewer anyway. The bar is not a
 * constant: it is the largest call Jev has actually settled, plus a margin,
 * and it applies only once enough larger calls have been seen settling none.
 * A few calls above the bar are still made, so if Jev starts settling bigger
 * reviews the bar rises on its own.
 *
 * Sizes are compared in Jev's own reported input tokens. Before a call only
 * the request text exists, so its estimate is scaled by the ratio Jev has
 * actually reported for earlier calls that recorded both.
 */
import { createHash } from 'node:crypto';
import type { JevDecisionRecord } from './decision-log.js';

/** Calls above the bar that must have settled none before the bar applies. */
export const COMPLETION_GATE_MIN_OBSERVATIONS = 20;
/** Room above the largest settled call before a call counts as larger. */
export const COMPLETION_GATE_MARGIN = 0.15;
/** One in this many calls above the bar is still made, to keep learning. */
export const COMPLETION_GATE_REPROBE_EVERY = 8;
/** Earlier calls that recorded an estimate before the ratio is trusted. */
const CALIBRATION_MIN_ROWS = 5;

/** Outcomes where Jev's reading closed the review. */
const SETTLED = new Set(['done', 'awaiting']);

export interface CompletionSizeGate {
  /** Calls expected above this many input tokens are not made; null = no bar yet. */
  skipAboveTokens: number | null;
  largestSettledTokens: number | null;
  /** Calls seen above the bar (none of them settled). */
  observedAbove: number;
  /** Jev's reported input tokens per estimated token. */
  calibration: number;
}

/** A dependency-free size estimate; the calibration absorbs its bias. */
export function estimateRequestTokens(requestText: string): number {
  return Math.ceil(requestText.length / 4);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function learnCompletionSizeGate(records: readonly JevDecisionRecord[]): CompletionSizeGate {
  const calls = records.filter((row) => row.ok && typeof row.inputTokens === 'number' && row.inputTokens > 0);
  const ratios = calls
    .map((row) => {
      const estimated = Number(row.context?.estimatedTokens);
      return Number.isFinite(estimated) && estimated > 0 ? row.inputTokens! / estimated : null;
    })
    .filter((ratio): ratio is number => ratio !== null);
  const calibration = ratios.length >= CALIBRATION_MIN_ROWS ? median(ratios) : 1;
  const settled = calls.filter((row) => row.outcome && SETTLED.has(row.outcome));
  // With nothing settled there is no evidence of what Jev can do; ask as before.
  if (settled.length === 0) {
    return { skipAboveTokens: null, largestSettledTokens: null, observedAbove: 0, calibration };
  }
  const largest = Math.max(...settled.map((row) => row.inputTokens!));
  const bar = Math.ceil(largest * (1 + COMPLETION_GATE_MARGIN));
  const observedAbove = calls.filter((row) => row.inputTokens! > bar).length;
  return {
    skipAboveTokens: observedAbove >= COMPLETION_GATE_MIN_OBSERVATIONS ? bar : null,
    largestSettledTokens: largest,
    observedAbove,
    calibration,
  };
}

export type CompletionCallDecision =
  | { call: true; expectedTokens: number; reprobe: boolean }
  | { call: false; expectedTokens: number };

/** Whether to make this call. `probeKey` picks the re-probes deterministically. */
export function decideCompletionCall(input: {
  estimatedTokens: number;
  gate: CompletionSizeGate;
  probeKey: string;
}): CompletionCallDecision {
  const expectedTokens = Math.ceil(input.estimatedTokens * input.gate.calibration);
  const bar = input.gate.skipAboveTokens;
  if (bar === null || expectedTokens <= bar) return { call: true, expectedTokens, reprobe: false };
  const pick = createHash('sha256').update(input.probeKey).digest()[0] % COMPLETION_GATE_REPROBE_EVERY === 0;
  return pick ? { call: true, expectedTokens, reprobe: true } : { call: false, expectedTokens };
}
