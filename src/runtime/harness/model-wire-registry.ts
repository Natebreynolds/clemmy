/**
 * model-wire-registry — per-model WIRE capabilities, the single source of truth
 * for how to call a given model id (NOT to be confused with
 * src/runtime/capability-registry.ts, which routes TOOLS/intents).
 *
 * Why this exists (the multi-model strategy, CLAUDE-MULTI-MODEL-ABSTRACTION-
 * STRATEGY-2026-06-16.md): mature multi-model harnesses (pi-ai, LiteLLM,
 * models.dev, Goose) keep WHAT a model can do as *data* and HOW to call it as a
 * small set of adapters. Clementine had the data scattered/implicit, which is
 * why the Claude brain was a second-class thin passthrough while Codex got all
 * the resilience + tuning. This registry is that data layer: one declarative
 * entry per model family, consumed by the provider-agnostic resilience wrapper
 * (resilient-model.ts) and the Anthropic wire envelope (claude-model.ts).
 *
 * It is legitimately DATA (the same shape models.dev / LiteLLM publish), not a
 * curated tool allowlist — so it honors "no hardcoded tool lists / global, no
 * curated lists": ids are matched by family regex and unknown ids fail LOUD to
 * conservative defaults, never silently.
 *
 * Seed values verified 2026-06-16 against the `claude-api` skill's authoritative
 * tables + @ai-sdk/anthropic@3.0.82 / @openai/agents-extensions@0.11.6 source.
 * Refresh via an OFFLINE script (never a runtime/build-time network fetch) when
 * model families change.
 */
import type { ReasoningEffort } from './reasoning-effort.js';
import { getRuntimeEnv } from '../../config.js';
import pino from 'pino';

const logger = pino({ name: 'clementine.model-wire-registry' });

/**
 * Umbrella kill-switch for the whole multi-model parity layer (resilience
 * wrapper + reasoning translation + prompt caching + the system-prompt reorder).
 * Default ON (validated behavior is the default); `CLEMMY_MODEL_PARITY=off`
 * restores byte-identical legacy behavior. TEMPORARY tripwire — delete once
 * parity is confirmed live. Lives here (neutral module) so the Claude and BYO
 * adapters and the prompt assembler can all read one flag without coupling.
 */
export function modelParityEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_MODEL_PARITY', 'on') || 'on').trim().toLowerCase() !== 'off';
}

/**
 * Sentinel the prompt assembler (harness-context.ts) emits between the STABLE
 * prefix (role instructions) and the per-turn DYNAMIC memory context, so the
 * Anthropic wire (claude-model.ts) can place a cache_control breakpoint exactly
 * on the stable boundary. Padded plain text (no control chars — some transports
 * reject NUL) chosen to never collide with real content; always stripped before
 * the wire by every brain that doesn't cache (codex/byo) and split-on by Claude.
 */
export const CACHE_BREAK_SENTINEL = '<<<CLEM_CACHE_BREAK>>>';

/** The exact delimiter the assembler inserts between the STABLE prefix and the
 *  DYNAMIC context (harness-context.ts). Brains that restore legacy order split
 *  on this precise string so the reconstruction is byte-identical to legacy. */
export const INSTRUCTION_CACHE_DELIM = `\n\n${CACHE_BREAK_SENTINEL}\n\n`;

/** Bare strip: drop the sentinel, leaving a `---` separator. Defensive fallback
 *  for a sentinel that isn't wrapped in the exact delimiter. */
export function stripCacheBreakSentinel(text: string | undefined | null): string {
  const s = text ?? '';
  return s.includes(CACHE_BREAK_SENTINEL) ? s.split(CACHE_BREAK_SENTINEL).join('---') : s;
}

/**
 * Restore the LEGACY (dynamic-first) instruction order for brains that don't use
 * the Anthropic cache breakpoint (Codex / BYO). The parity assembler emits
 * `${role}${DELIM}${ctx}` (stable-first, so Claude can cache the prefix); this
 * rebuilds the exact pre-parity `${ctx}\n\n---\n\n${role}`, making the Codex/BYO
 * wire BYTE-IDENTICAL to legacy whether parity is on or off — so a default-on
 * rollout cannot change the primary (Codex) path. No-op when no sentinel is
 * present (e.g. a sub-agent prompt that didn't pass through the assembler).
 */
export function restoreLegacyInstructionOrder(text: string | undefined | null): string {
  const s = text ?? '';
  const idx = s.indexOf(INSTRUCTION_CACHE_DELIM);
  if (idx >= 0) {
    const role = s.slice(0, idx);
    const ctx = s.slice(idx + INSTRUCTION_CACHE_DELIM.length);
    return `${ctx}\n\n---\n\n${role}`;
  }
  // Sentinel present but not in the exact delimiter shape → safe bare strip.
  return stripCacheBreakSentinel(s);
}

/** Which native wire protocol a model speaks. ~40 vendors collapse onto these
 *  three (the pi-ai/Hermes "api_mode" idea). */
export type ApiShape = 'codex_responses' | 'anthropic_messages' | 'openai_completions';

/** How the harness's generic reasoning-effort tier reaches the provider. */
export type ThinkingMode = 'effort' | 'budget_tokens' | 'none';

/** How transient failures should be classified for retry. */
export type RetryClass = 'codex' | 'anthropic' | 'openai_compat';

export interface ModelCapability {
  /** Human-facing family label (diagnostics only). */
  family: string;
  apiShape: ApiShape;
  /** Total context window (tokens). Budgeting / clamp use only — advisory. */
  contextWindow: number;
  /** Max output tokens the model accepts. ADVISORY / budgeting-only — the wire
   *  max_tokens clamp lives in @ai-sdk/anthropic's OWN per-model table, not here
   *  (the harness leaves maxTokens unset, so the SDK's default governs). Setting
   *  this does NOT change the request. NOTE: an unrecognized claude-* id the SDK
   *  hasn't shipped support for is silently capped at 4096 output tokens by the
   *  SDK even though a broad /claude-/ family row here may claim more. */
  maxOutput: number;
  /** True when the model accepts a reasoning-effort knob at all. */
  supportsEffort: boolean;
  /** Generic harness tier -> provider wire value (null = omit / use default).
   *  For anthropic_messages this is the `output_config.effort` string. */
  effortMap: Record<ReasoningEffort, string | null>;
  /** How effort is delivered. 'effort' = output_config.effort (Anthropic GA);
   *  'budget_tokens' = legacy thinking budget (older Sonnet only); 'none'. */
  thinkingMode: ThinkingMode;
  /** True when explicit prompt-cache breakpoints help (Anthropic). OpenAI/codex
   *  cache automatically server-side, so they set this false (nothing to emit). */
  supportsPromptCache: boolean;
  /** Minimum cacheable prefix size (tokens) below which a breakpoint is wasted
   *  (Anthropic returns it uncached). Verified: Opus 4.x + Haiku 4.5 = 4096;
   *  Fable 5 + Sonnet 4.6 = 2048; older Sonnet = 1024. */
  cacheMinTokens: number;
  retryClass: RetryClass;
}

/** Conservative fallback for an unrecognized model id — never silently trust a
 *  stale map. No effort, no cache breakpoints, generic retry. */
export const DEFAULT_CAPABILITY: ModelCapability = {
  family: 'unknown',
  apiShape: 'openai_completions',
  contextWindow: 128_000,
  maxOutput: 8192,
  supportsEffort: false,
  effortMap: { none: null, minimal: null, low: null, medium: null, high: null },
  thinkingMode: 'none',
  supportsPromptCache: false,
  cacheMinTokens: 1024,
  retryClass: 'openai_compat',
};

// Anthropic `output_config.effort` enum is low|medium|high|xhigh|max. We map the
// harness tiers conservatively (high -> 'high', never xhigh/max, to avoid
// runaway latency/spend); 'none' omits so the model uses its adaptive default.
const ANTHROPIC_EFFORT_MAP: Record<ReasoningEffort, string | null> = {
  none: null,
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
};

// Codex (gpt-5*) speaks the effort tiers natively in codex-model.ts; the map is
// identity-ish and unused by the wrapper (codex is not a wrap site), kept for
// completeness/telemetry.
const CODEX_EFFORT_MAP: Record<ReasoningEffort, string | null> = {
  none: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
};

interface RegistryRow {
  idMatch: RegExp;
  cap: ModelCapability;
}

// Order matters: first match wins. More specific families first.
const REGISTRY: RegistryRow[] = [
  // ---- Claude (anthropic_messages) ------------------------------------------
  // Opus 4.7/4.8 + Fable 5: budget_tokens thinking is REMOVED (HTTP 400) — must
  // use output_config.effort. cacheMin 4096 (Opus/Haiku) or 2048 (Fable/Sonnet4.6).
  {
    idMatch: /claude-opus-4-(7|8)|claude-opus-4\.(7|8)/i,
    cap: {
      family: 'claude-opus-4.7/4.8', apiShape: 'anthropic_messages',
      contextWindow: 200_000, maxOutput: 64_000, supportsEffort: true,
      effortMap: ANTHROPIC_EFFORT_MAP, thinkingMode: 'effort',
      supportsPromptCache: true, cacheMinTokens: 4096, retryClass: 'anthropic',
    },
  },
  {
    idMatch: /claude-opus-4-(5|6)|claude-opus-4\.(5|6)|claude-opus/i,
    cap: {
      family: 'claude-opus-4.5/4.6', apiShape: 'anthropic_messages',
      contextWindow: 200_000, maxOutput: 64_000, supportsEffort: true,
      effortMap: ANTHROPIC_EFFORT_MAP, thinkingMode: 'effort',
      supportsPromptCache: true, cacheMinTokens: 4096, retryClass: 'anthropic',
    },
  },
  {
    // Haiku 4.5 has NO effort knob — it 400s on output_config.effort at every
    // level (live-verified: "This model does not support the effort parameter").
    // Opus/Sonnet accept it, so the bug is invisible on the default Opus brain.
    idMatch: /claude-haiku-4-5|claude-haiku/i,
    cap: {
      family: 'claude-haiku-4.5', apiShape: 'anthropic_messages',
      contextWindow: 200_000, maxOutput: 32_000, supportsEffort: false,
      effortMap: { none: null, minimal: null, low: null, medium: null, high: null },
      thinkingMode: 'none',
      supportsPromptCache: true, cacheMinTokens: 4096, retryClass: 'anthropic',
    },
  },
  {
    idMatch: /claude-fable-5|claude-sonnet-4-6|claude-sonnet-4\.6/i,
    cap: {
      family: 'fable-5/sonnet-4.6', apiShape: 'anthropic_messages',
      contextWindow: 200_000, maxOutput: 64_000, supportsEffort: true,
      effortMap: ANTHROPIC_EFFORT_MAP, thinkingMode: 'effort',
      supportsPromptCache: true, cacheMinTokens: 2048, retryClass: 'anthropic',
    },
  },
  {
    // Older Sonnet (4.5/4.1/4/3.7): effort errors; legacy budget_tokens path.
    idMatch: /claude-sonnet|claude-3|claude-/i,
    cap: {
      family: 'claude-sonnet-legacy', apiShape: 'anthropic_messages',
      contextWindow: 200_000, maxOutput: 32_000, supportsEffort: false,
      effortMap: { none: null, minimal: null, low: null, medium: null, high: null },
      thinkingMode: 'budget_tokens',
      supportsPromptCache: true, cacheMinTokens: 1024, retryClass: 'anthropic',
    },
  },
  // ---- Codex (codex_responses) ----------------------------------------------
  {
    idMatch: /gpt-5|^o[0-9]/i,
    cap: {
      family: 'gpt-5', apiShape: 'codex_responses',
      contextWindow: 272_000, maxOutput: 128_000, supportsEffort: true,
      effortMap: CODEX_EFFORT_MAP, thinkingMode: 'effort',
      supportsPromptCache: false, cacheMinTokens: 0, retryClass: 'codex',
    },
  },
  // ---- BYO OpenAI-compatible (openai_completions) ---------------------------
  {
    idMatch: /deepseek|minimax|qwen|kimi|moonshot|glm|llama|mistral|gemini/i,
    cap: {
      family: 'byo-openai-compat', apiShape: 'openai_completions',
      contextWindow: 128_000, maxOutput: 16_000, supportsEffort: false,
      effortMap: { none: null, minimal: null, low: null, medium: null, high: null },
      thinkingMode: 'none',
      supportsPromptCache: false, cacheMinTokens: 1024, retryClass: 'openai_compat',
    },
  },
];

/**
 * Resolve the wire capability for a model id. First family match wins; an
 * unknown id warns LOUD and returns a conservative default (never a silent
 * wrong assumption). Pure + cheap — safe to call per request.
 */
export function resolveModelCapability(modelId: string | undefined | null): ModelCapability {
  const id = (modelId ?? '').trim();
  if (id) {
    for (const row of REGISTRY) {
      if (row.idMatch.test(id)) return row.cap;
    }
  }
  logger.warn({ modelId: id || '(empty)' }, 'model-wire-registry: unknown model id — using conservative defaults');
  return DEFAULT_CAPABILITY;
}

/** Rough token estimate (chars/4) for cache-min gating. Intentionally cheap +
 *  conservative — only used to decide whether a cache breakpoint is worth it. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Test/introspection helper. */
export const __test__ = { REGISTRY };
