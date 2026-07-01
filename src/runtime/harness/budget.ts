/**
 * Pre-flight token budget primitives.
 *
 * Complementary to the post-hoc `TokenBudgetTracker` in brackets.ts:
 *   - TokenBudgetTracker: "how big WAS this turn?" (real Usage from
 *     the model response)
 *   - budget.ts (this file): "how big WOULD this turn be?" (estimate
 *     from text BEFORE we send the request)
 *
 * Both feed the pre-flight gate in loop.ts: the gate checks current
 * state size (Tracker) + estimated next-turn cost (budget.ts) and
 * decides whether to compact, force plan-mode, or proceed.
 *
 * Design tenets:
 *   - PURE functions. No side effects, no I/O, no SDK dependency.
 *     The pre-flight gate is the only caller; tests run in isolation.
 *   - CONSERVATIVE: when in doubt, over-estimate. Under-estimating
 *     causes the failure mode we're trying to prevent (request too
 *     big, upstream SSE drops).
 *   - LOG LOUDLY when model-context lookup falls back to a default.
 *     Six related Hermes issues (#19539, #20093, #21953, #26102,
 *     #26843, #30760) all root-cause to "silently used wrong limit
 *     for a custom provider." User override always wins.
 */

import pino from 'pino';

const logger = pino({ name: 'clementine.harness.budget' });

// ─────────────────────────────────────────────────────────────────
// Token estimation
// ─────────────────────────────────────────────────────────────────

/**
 * Estimated character-to-token ratios. Hybrid: plaintext averages
 * ~4 chars/token in English (OpenAI tokenizer empirical); JSON/code
 * averages ~3.5 because punctuation density inflates token count.
 * These are conservative (slightly higher token counts than reality)
 * by design — the gate's job is to refuse risky requests, not nail
 * the exact number.
 */
const CHARS_PER_TOKEN_TEXT = 4;
const CHARS_PER_TOKEN_JSON = 3.5;

/** Heuristic: does this content look like structured (JSON-shaped)
 *  data vs natural-language prose? Used to pick the chars/token
 *  ratio. Detects opening braces/brackets early in the content. */
function looksStructured(content: string): boolean {
  const head = content.slice(0, 100).trimStart();
  return head.startsWith('{') || head.startsWith('[');
}

/**
 * Estimate token count for a piece of content. Char-based fallback —
 * we intentionally don't pull in a tokenizer library (tiktoken etc.)
 * to keep this dependency-free and fast. The trade-off: ±15% accuracy
 * vs zero install cost + 1 µs per call. For the pre-flight gate's
 * "is this safe?" decision, ±15% is well within the safety margin.
 */
export function estimateTokens(content: string | null | undefined): number {
  if (!content) return 0;
  const ratio = looksStructured(content) ? CHARS_PER_TOKEN_JSON : CHARS_PER_TOKEN_TEXT;
  return Math.ceil(content.length / ratio);
}

/**
 * Estimate tokens for an array of message-shaped items. Each item is
 * treated as the concatenation of any `content`-like fields plus a
 * fixed framing overhead (role tag, separators, etc.). Conservative:
 * adds 4 tokens per item for framing.
 */
export function estimateMessagesTokens(items: ReadonlyArray<{ content?: unknown; role?: string }>): number {
  let total = 0;
  for (const item of items) {
    if (typeof item.content === 'string') {
      total += estimateTokens(item.content);
    } else if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (typeof part === 'string') total += estimateTokens(part);
        else if (part && typeof part === 'object' && 'text' in part && typeof (part as { text: unknown }).text === 'string') {
          total += estimateTokens((part as { text: string }).text);
        } else if (part) {
          // Unknown part shape (image, tool result, etc.) — estimate
          // by serialized JSON length. Image parts in particular can
          // be data-URLs; the estimate is conservative.
          try {
            total += estimateTokens(JSON.stringify(part));
          } catch {
            total += 100; // tiny fallback to avoid silent 0
          }
        }
      }
    } else if (item.content != null) {
      try {
        total += estimateTokens(JSON.stringify(item.content));
      } catch {
        total += 100;
      }
    }
    total += 4; // per-item framing overhead
  }
  return total;
}

// ─────────────────────────────────────────────────────────────────
// Model context limits
// ─────────────────────────────────────────────────────────────────

/**
 * Per-model context-window limits in tokens. These are the model's
 * TOTAL input + output capacity. Pre-flight gate compares estimated
 * turn size against a configurable fraction of this.
 *
 * Sources: OpenAI model spec sheets + Codex CLI release notes (May
 * 2026). When a new model lands, add it here. The gate falls back
 * to a conservative DEFAULT_CONTEXT_LIMIT if the model id isn't in
 * the table — and logs the fallback at WARN so it's visible.
 *
 * IMPORTANT: never reduce a limit silently. If a model id matches
 * a known family but a newer version exists, conservatively use the
 * smaller of (known limit, default).
 */
const MODEL_CONTEXT_LIMITS: ReadonlyMap<string, number> = new Map([
  // gpt-5.5 family — current frontier (Apr 2026 release).
  // The 1M-token API context is API-KEY ONLY. Through Codex oauth
  // (any tier — Plus, Pro, Business, Enterprise) the effective
  // ceiling is 400K total (~272K input + 128K reserved output).
  // If a user moves to AUTH_MODE=api_key + an OpenAI key, set
  // CLEMMY_MODEL_CONTEXT_LIMIT_GPT_5_5=1000000 to unlock 1M.
  ['gpt-5.5', 400_000],
  ['gpt-5.5-codex', 400_000],
  ['gpt-5.5-pro', 400_000], // Pro variant; same ceiling, unlocks the model not the window
  ['gpt-5.5-mini', 200_000],
  // gpt-5.4 family — prior frontier
  ['gpt-5.4', 200_000],
  ['gpt-5.4-mini', 128_000],
  ['gpt-5.4-nano', 64_000],
  // codex-mini / codex-medium — Codex-flavored variants
  ['codex-mini', 200_000],
  ['codex-medium', 200_000],
  // Claude subscription/API models exposed through the Claude Agent SDK.
  // Keep this conservative at the standard 200K Claude context window; users
  // can override future larger SKUs via CLEMMY_MODEL_CONTEXT_LIMIT_<id>.
  ['claude-opus-4-8', 200_000],
  ['claude-opus-4.8', 200_000],
  ['claude-opus-4-7', 200_000],
  ['claude-opus-4.7', 200_000],
  ['claude-opus-4', 200_000],
  ['claude-sonnet-5', 200_000],
  ['claude-sonnet-4-6', 200_000],
  ['claude-sonnet-4.6', 200_000],
  ['claude-sonnet-4', 200_000],
  ['claude-fable-5', 200_000],
  // Legacy fallbacks for older configs that may still appear
  ['gpt-4.1', 128_000],
  ['gpt-4.1-mini', 128_000],
  ['gpt-4o', 128_000],
  ['gpt-4o-mini', 128_000],
  // BYO OpenAI-compatible backends (worker / all-in routing). Providers'
  // published context windows; override per-id via CLEMMY_MODEL_CONTEXT_LIMIT_<id>.
  // Longest-prefix match resolves "MiniMax-M3" before the generic "MiniMax".
  ['MiniMax-M3', 1_000_000],
  ['MiniMax', 200_000],
  ['deepseek', 128_000],
  // GLM (Z.ai). Longest-prefix match resolves "glm-5.2" before the generic "glm".
  ['glm-5.2', 1_000_000],
  ['glm', 128_000],
]);

/** Hard floor for the budget threshold. Smaller models with tiny
 *  context windows would otherwise see "75% capacity" warnings at
 *  trivially small payloads — pointless friction. */
export const MINIMUM_CONTEXT_FLOOR = 64_000;

/** Conservative default when a model id isn't in the table. Chosen
 *  to match the smallest current frontier model so we don't over-
 *  promise on unknown models. */
const DEFAULT_CONTEXT_LIMIT = 128_000;

/**
 * Look up the context limit for a model id. If not found, return
 * the conservative default and log loudly so the gap is visible.
 * User override (via env CLEMMY_MODEL_CONTEXT_LIMIT_<MODEL_ID>) wins
 * over both — see `getEffectiveContextLimit`.
 */
export function modelContextLimit(modelId: string): number {
  const normalizedId = modelId.trim();
  // Some preflight callers intentionally do not know the final concrete model
  // yet (for example before role routing resolves). Use the conservative
  // default silently for an absent id; it is not an unknown configured model and
  // should not create noisy daemon warnings.
  if (!normalizedId) return DEFAULT_CONTEXT_LIMIT;
  const direct = MODEL_CONTEXT_LIMITS.get(normalizedId);
  if (direct !== undefined) return direct;
  // Try a prefix match for model variants we haven't enumerated
  // (e.g. "gpt-5.4-mini-2026-05" → "gpt-5.4-mini"). Pick the longest
  // matching known prefix to avoid e.g. "gpt-5.4" eating "gpt-5.4-mini".
  let bestKey: string | null = null;
  for (const key of MODEL_CONTEXT_LIMITS.keys()) {
    if (normalizedId.startsWith(key) && (!bestKey || key.length > bestKey.length)) {
      bestKey = key;
    }
  }
  if (bestKey) {
    return MODEL_CONTEXT_LIMITS.get(bestKey)!;
  }
  logger.warn(
    { modelId: normalizedId, fallback: DEFAULT_CONTEXT_LIMIT },
    'modelContextLimit: unknown model id, falling back to conservative default. Add it to MODEL_CONTEXT_LIMITS or set CLEMMY_MODEL_CONTEXT_LIMIT_<id> env.',
  );
  return DEFAULT_CONTEXT_LIMIT;
}

/**
 * User-override-aware context limit. Reads
 * `CLEMMY_MODEL_CONTEXT_LIMIT_<NORMALIZED_ID>` from env first (where
 * NORMALIZED_ID is the model id uppercased with non-alphanumerics
 * replaced by underscores). Falls back to the table.
 *
 * Override wins because custom providers / fine-tuned models /
 * future SKUs often have non-standard limits that we can't enumerate
 * statically. Hermes issues #19539+ root-caused to this exact gap.
 */
export function getEffectiveContextLimit(modelId: string): number {
  const envKey = `CLEMMY_MODEL_CONTEXT_LIMIT_${modelId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  const overrideRaw = process.env[envKey];
  if (overrideRaw) {
    const parsed = Number.parseInt(overrideRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      logger.info({ modelId, envKey, limit: parsed }, 'modelContextLimit: using env override');
      return parsed;
    }
    logger.warn({ modelId, envKey, raw: overrideRaw }, 'modelContextLimit: env override is not a positive integer, ignoring');
  }
  return modelContextLimit(modelId);
}

// ─────────────────────────────────────────────────────────────────
// Turn-cost prediction + budget check
// ─────────────────────────────────────────────────────────────────

export interface PredictTurnCostInput {
  /** Tokens already in the conversation state (system prompt + history). */
  currentStateTokens: number;
  /** Tokens of the user's NEW input on this turn. */
  userInputTokens: number;
  /** Expected number of tool calls THIS turn will fire. The model
   *  hasn't decided yet, so this is the orchestrator's prior. */
  plannedToolCallCount?: number;
  /** Expected average size of each tool return, in tokens. For
   *  external APIs (Composio, web search) this is often 500-5000;
   *  for local file reads it's smaller. Conservative default 2000. */
  avgToolReturnTokens?: number;
  /** Expected output (model response) size in tokens. Conservative
   *  default 1500 — large enough to cover a typical structured reply
   *  + reasoning trace. */
  expectedOutputTokens?: number;
  /** Static-overhead floor for the agent's framing — system prompt,
   *  tool definitions, output schema. The caller can measure this
   *  precisely if it has the agent reference; the conservative
   *  default (20_000) covers a typical 50-tool orchestrator with a
   *  ~5K system prompt. Without this, the gate massively
   *  under-predicts and approves turns that blow upstream. Observed
   *  2026-05-24: gate said 21%, real request was 90%+. */
  staticOverheadTokens?: number;
}

/** Default static-overhead estimate. Tunable via env
 *  `CLEMMY_PREFLIGHT_STATIC_OVERHEAD`. */
const DEFAULT_STATIC_OVERHEAD = 20_000;

/**
 * Predict the total tokens this turn will consume. Adds:
 *   - current state (history we already pay to re-send)
 *   - user input
 *   - tool calls × avg tool return (the returns land in the next
 *     model call, hence count toward turn cost)
 *   - expected output
 *
 * Conservative on every dimension. The gate's job is to NOT take a
 * turn that's risky; better to mis-classify a safe turn as warn than
 * to mis-classify a risky turn as ok.
 */
export function predictTurnCost(input: PredictTurnCostInput): number {
  const toolCalls = Math.max(0, input.plannedToolCallCount ?? 0);
  const avgReturn = Math.max(0, input.avgToolReturnTokens ?? 2_000);
  const expectedOutput = Math.max(0, input.expectedOutputTokens ?? 1_500);
  // Static overhead: framing the SDK sends on every request
  // (system prompt + tool definitions + structured-output schema).
  // The conservative default catches the most common miss; callers
  // with a precise measurement should override. Env override:
  // `CLEMMY_PREFLIGHT_STATIC_OVERHEAD=<int>` wins over both.
  const envOverride = (() => {
    const raw = (process.env.CLEMMY_PREFLIGHT_STATIC_OVERHEAD ?? '').trim();
    if (!raw) return undefined;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  })();
  const staticOverhead = Math.max(
    0,
    envOverride ?? input.staticOverheadTokens ?? DEFAULT_STATIC_OVERHEAD,
  );
  return (
    staticOverhead +
    Math.max(0, input.currentStateTokens) +
    Math.max(0, input.userInputTokens) +
    toolCalls * avgReturn +
    expectedOutput
  );
}

export type BudgetStatus = 'ok' | 'warn' | 'block';

export interface CheckBudgetInput {
  /** Total predicted tokens for the turn. */
  predictedTokens: number;
  /** Model id (for context-limit lookup). */
  modelId: string;
  /** Warn threshold as fraction of effective context limit. Default 0.75. */
  warnFraction?: number;
  /** Block threshold as fraction of effective context limit. Default 0.85. */
  blockFraction?: number;
}

export interface CheckBudgetResult {
  status: BudgetStatus;
  predictedTokens: number;
  effectiveLimit: number;
  fractionUsed: number;
  warnFraction: number;
  blockFraction: number;
  /** Human-readable reason — useful for telemetry + user-facing
   *  messages when the gate refuses a turn. */
  reason: string;
}

/**
 * Check whether a predicted turn cost is safe to run.
 *
 * Floor + percentage (Hermes pattern, issue learnings): the
 * thresholds apply against the LARGER of (modelLimit * pct,
 * MINIMUM_CONTEXT_FLOOR). Without the floor, small-context models
 * would trip warnings at trivial payload sizes — pointless friction.
 */
export function checkBudget(input: CheckBudgetInput): CheckBudgetResult {
  const limit = getEffectiveContextLimit(input.modelId);
  const warnFraction = input.warnFraction ?? 0.75;
  const blockFraction = input.blockFraction ?? 0.85;
  if (warnFraction <= 0 || warnFraction >= 1) {
    throw new Error(`checkBudget: warnFraction must be in (0,1), got ${warnFraction}`);
  }
  if (blockFraction <= warnFraction || blockFraction >= 1) {
    throw new Error(`checkBudget: blockFraction (${blockFraction}) must be in (warnFraction, 1)`);
  }
  // Floor applies to BOTH thresholds — i.e. the effective limit
  // that thresholds are computed against can be larger than the
  // model's actual limit when the model is small. The actual model
  // limit is still the hard cap.
  const effectiveLimit = Math.max(limit, MINIMUM_CONTEXT_FLOOR);
  const fractionUsed = input.predictedTokens / effectiveLimit;
  let status: BudgetStatus;
  let reason: string;
  if (fractionUsed < warnFraction) {
    status = 'ok';
    reason = `${(fractionUsed * 100).toFixed(0)}% of effective limit — well under the ${(warnFraction * 100).toFixed(0)}% warn threshold`;
  } else if (fractionUsed < blockFraction) {
    status = 'warn';
    reason = `${(fractionUsed * 100).toFixed(0)}% of effective limit — crossed the ${(warnFraction * 100).toFixed(0)}% warn threshold; recommend preemptive compaction`;
  } else {
    status = 'block';
    reason = `${(fractionUsed * 100).toFixed(0)}% of effective limit — exceeds the ${(blockFraction * 100).toFixed(0)}% block threshold; turn should be refused or routed through plan-mode`;
  }
  return {
    status,
    predictedTokens: input.predictedTokens,
    effectiveLimit,
    fractionUsed,
    warnFraction,
    blockFraction,
    reason,
  };
}
