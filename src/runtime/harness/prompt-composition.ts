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
import { CACHE_BREAK_SENTINEL } from './model-wire-registry.js';
import { createHash } from 'node:crypto';
import { appendEvent } from './eventlog.js';

/** Does this bucket survive unchanged into the next turn's prompt? */
export type PromptBucketStability = 'stable' | 'variable';

export interface PromptBucket {
  name: string;
  tokens: number;
  stability: PromptBucketStability;
  /** Exact byte length of the bucket's text (0 for estimated-only buckets). */
  bytes?: number;
  /** sha256 of the bucket's exact bytes — the byte-stability pin's authority
   *  (a STABLE bucket whose sha moves between consecutive steps is a cache
   *  bust the estimate would hide). */
  sha256?: string;
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
  /** MEASURED first-class tool schema tokens (name + description + parameters),
   *  when the caller has the real serialized schemas in hand. Wins over the
   *  toolNames x perSchema approximation. Measured 2026-08-25: the codex lane
   *  passed neither, so a wire that carried 9,198 tokens was recorded as 6,850 —
   *  ~1,939 tokens of tool schemas counted NOWHERE, and the meter was off by
   *  34% of its own figure on the exact turn used to justify a trim. */
  measuredToolSchemaTokens?: number;
  /** MEASURED deferred-tool index tokens (name + description only), the
   *  schema-on-demand catalog advertisement. Stable: same catalog every turn. */
  deferredToolIndexTokens?: number;
  /** MEASURED history tokens for callers whose history is structured items
   *  rather than one string. Wins over estimating the history string. */
  measuredHistoryTokens?: number;
}

const DEFAULT_TOKENS_PER_TOOL_SCHEMA = 120;

export function summarizePromptComposition(input: PromptCompositionInput): PromptCompositionSummary {
  const toolNames = input.toolNames ?? [];
  const perSchema = Number.isFinite(input.approxTokensPerToolSchema)
    ? Math.max(0, Math.trunc(input.approxTokensPerToolSchema as number))
    : DEFAULT_TOKENS_PER_TOOL_SCHEMA;

  const digest = (text: string): { bytes: number; sha256: string } => ({
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
  });
  // Instructions are split at the cache-break sentinel the wire adapters
  // already use: the half BEFORE it is the invariant system prompt; the half
  // AFTER it is the per-turn memory context, which carries a minute-resolution
  // clock and is deliberately kept OUT of the cacheable prefix by the codex
  // adapter. Scoring the whole thing "stable" produced the 97%-fixed-overhead
  // reading that nearly justified cutting the wrong bucket — ~2,950 of those
  // "stable" tokens change every turn.
  const instructionsText = input.instructions ?? '';
  const sentinelAt = instructionsText.indexOf(CACHE_BREAK_SENTINEL);
  const staticInstructions = sentinelAt >= 0 ? instructionsText.slice(0, sentinelAt) : instructionsText;
  const memoryContext = sentinelAt >= 0 ? instructionsText.slice(sentinelAt + CACHE_BREAK_SENTINEL.length) : '';
  const measuredTools = Number.isFinite(input.measuredToolSchemaTokens)
    ? Math.max(0, Math.trunc(input.measuredToolSchemaTokens as number))
    : null;
  const measuredHistory = Number.isFinite(input.measuredHistoryTokens)
    ? Math.max(0, Math.trunc(input.measuredHistoryTokens as number))
    : null;
  const deferredIndex = Number.isFinite(input.deferredToolIndexTokens)
    ? Math.max(0, Math.trunc(input.deferredToolIndexTokens as number))
    : 0;
  const raw: Array<[string, number, PromptBucketStability, string | null]> = [
    // STABLE: same bytes every turn for a given session, so the provider keeps
    // them warm. Large is FINE here — that is the whole point of the split.
    ['instructions', estimateTokens(staticInstructions), 'stable', staticInstructions],
    ['memoryContext', estimateTokens(memoryContext), 'variable', memoryContext],
    // The measured serialized schemas win; the names x 120 guess is only for
    // callers that never had the real schemas in hand.
    ['toolSchemas', measuredTools ?? toolNames.length * perSchema, 'stable', null],
    ['deferredToolIndex', deferredIndex, 'stable', null],
    // History is a stable PREFIX in principle (it only appends) but any change
    // upstream of it re-pays the lot, so it is scored with the variable side
    // where it will be noticed.
    ['history', measuredHistory ?? estimateTokens(input.history ?? ''), 'variable', measuredHistory !== null ? null : input.history ?? ''],
    ['contextPacket', estimateTokens(input.contextPacket ?? ''), 'variable', input.contextPacket ?? ''],
    ['currentMessage', estimateTokens(input.currentMessage ?? ''), 'variable', input.currentMessage ?? ''],
    ['outputSchema', estimateTokens(input.outputSchema ?? ''), 'variable', input.outputSchema ?? ''],
  ];

  const buckets = raw
    .filter(([, tokens]) => tokens > 0)
    .map(([name, tokens, stability, text]) => ({
      name,
      tokens,
      stability,
      ...(text !== null ? digest(text) : {}),
    }))
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
