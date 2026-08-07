/**
 * PROMPT COMPOSITION — what actually occupies a turn's prompt, split by whether
 * it can be cached.
 *
 * Measured on a real client-class run (2026-08-07): ~19 minutes wall clock, of
 * which ~1 minute was tool execution and the rest was the model thinking
 * between roughly a hundred steps — about eleven seconds each. One model call
 * carried 753,000 input tokens at a 94% cache hit. Step latency at that scale
 * is not deliberation, it is prompt assembly and processing, paid once per
 * step and therefore a hundred times per task.
 *
 * The instinct "load less every turn" is half right, and the wrong half is
 * expensive. Under prompt caching a LARGE STABLE prefix is cheap and fast —
 * the provider keeps it warm. A SMALL VARYING prefix is not: every variation
 * invalidates the cache and the whole prefix is re-paid at full price. So the
 * discipline is not "smaller", it is:
 *
 *     anything LARGE must be INVARIANT across turns,
 *     anything VARIABLE must be SMALL,
 *     and the variable part must come LAST so it cannot invalidate the stable
 *     prefix ahead of it.
 *
 * This module makes that auditable instead of arguable. It does not change a
 * single byte of any prompt; it measures what is already being sent and labels
 * each bucket STABLE (identical turn to turn, cacheable) or VARIABLE (changes
 * per turn, must stay small). Cutting decisions come from the numbers, not
 * from anyone's model of where the tokens went — including mine, which was
 * wrong twice tonight before the ledger corrected it.
 *
 * Deliberately NOT solved here: growth WITHIN a turn. Each tool result the
 * agent SDK accumulates rides every subsequent step of that same turn, and
 * that accumulation is invisible from outside the SDK. This measures what the
 * harness hands over at turn start — the part we control and can cut.
 */
import { estimateTokens } from './budget.js';
import { appendEvent } from './eventlog.js';

/** Does this bucket survive unchanged into the next turn's prompt? */
export type PromptBucketStability = 'stable' | 'variable';

export interface PromptBucket {
  name: string;
  tokens: number;
  stability: PromptBucketStability;
}

export interface PromptCompositionSummary {
  buckets: PromptBucket[];
  totalTokens: number;
  stableTokens: number;
  variableTokens: number;
  /** Share of the measured prompt that can be served from cache when nothing
   *  else changes. Low means the turn is re-paying for a prefix it could have
   *  kept — the single most actionable number here. */
  stableShare: number;
  /** Advertised tool schemas are a real prompt cost that no existing telemetry
   *  captured; carried separately so schema-on-demand can be scored. */
  toolCount: number;
}

export interface PromptCompositionInput {
  /** System instructions / persona / standing rules — should be invariant. */
  instructions?: string;
  /** Prior-turn transcript. Grows monotonically; stable as a PREFIX only if
   *  nothing earlier in the prompt shifted. */
  history?: string;
  /** The per-turn preflight packet (capability facts, memory primer, beat,
   *  openness). Rebuilt every turn by construction — this is the bucket the
   *  "small and variable" half of the rule is about. */
  contextPacket?: string;
  /** The user's actual message. */
  currentMessage?: string;
  /** Any structured-output schema shipped with the call. */
  outputSchema?: string;
  /** Names of tools advertised with first-class schemas this turn. */
  toolNames?: readonly string[];
  /** Rough per-schema cost when the real schemas are not in hand. Tool schemas
   *  are not free and pretending they are is how a "lean" prompt stays fat. */
  approxTokensPerToolSchema?: number;
}

const DEFAULT_TOKENS_PER_TOOL_SCHEMA = 120;

export function summarizePromptComposition(input: PromptCompositionInput): PromptCompositionSummary {
  const toolNames = input.toolNames ?? [];
  const perSchema = Number.isFinite(input.approxTokensPerToolSchema)
    ? Math.max(0, Math.trunc(input.approxTokensPerToolSchema as number))
    : DEFAULT_TOKENS_PER_TOOL_SCHEMA;

  const raw: Array<[string, number, PromptBucketStability]> = [
    // STABLE: same bytes every turn for a given session, so the provider keeps
    // them warm. Large is FINE here — that is the whole point of the split.
    ['instructions', estimateTokens(input.instructions ?? ''), 'stable'],
    ['toolSchemas', toolNames.length * perSchema, 'stable'],
    // History is a stable PREFIX in principle (it only appends) but any change
    // upstream of it re-pays the lot, so it is scored with the variable side
    // where it will be noticed.
    ['history', estimateTokens(input.history ?? ''), 'variable'],
    ['contextPacket', estimateTokens(input.contextPacket ?? ''), 'variable'],
    ['currentMessage', estimateTokens(input.currentMessage ?? ''), 'variable'],
    ['outputSchema', estimateTokens(input.outputSchema ?? ''), 'variable'],
  ];

  const buckets = raw
    .filter(([, tokens]) => tokens > 0)
    .map(([name, tokens, stability]) => ({ name, tokens, stability }))
    .sort((a, b) => b.tokens - a.tokens);

  const stableTokens = buckets.filter((b) => b.stability === 'stable').reduce((sum, b) => sum + b.tokens, 0);
  const variableTokens = buckets.filter((b) => b.stability === 'variable').reduce((sum, b) => sum + b.tokens, 0);
  const totalTokens = stableTokens + variableTokens;

  return {
    buckets,
    totalTokens,
    stableTokens,
    variableTokens,
    stableShare: totalTokens > 0 ? Math.round((stableTokens / totalTokens) * 1000) / 1000 : 0,
    toolCount: toolNames.length,
  };
}

/**
 * Persist one composition reading. Best-effort by construction: measurement
 * must never be able to cost a turn it is only observing.
 */
export function recordPromptComposition(
  sessionId: string | undefined,
  lane: string,
  summary: PromptCompositionSummary,
  sourceUserSeq?: number,
): void {
  if (!sessionId || summary.totalTokens <= 0) return;
  try {
    appendEvent({
      sessionId,
      turn: 0,
      role: 'system',
      type: 'prompt_composition',
      data: {
        lane,
        totalTokens: summary.totalTokens,
        stableTokens: summary.stableTokens,
        variableTokens: summary.variableTokens,
        stableShare: summary.stableShare,
        toolCount: summary.toolCount,
        buckets: summary.buckets,
        ...(Number.isSafeInteger(sourceUserSeq) && (sourceUserSeq ?? 0) > 0 ? { sourceUserSeq } : {}),
      },
    });
  } catch { /* telemetry never breaks a turn */ }
}
