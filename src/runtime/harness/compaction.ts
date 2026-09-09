import type { AgentInputItem } from '@openai/agents';
import { Agent, Runner } from '@openai/agents';
import { createHash } from 'node:crypto';
import {
  appendEvent,
  getToolOutput,
  listEvents,
  openEventLog,
  type EventRow,
} from './eventlog.js';
import { HarnessSession } from './session.js';
import { estimateInputTokens } from './token-estimator.js';
import { effectiveContextWindow, windowScaleForModel } from './model-window-observations.js';
import { resolveModelCapability } from './model-wire-registry.js';
import { toolCallHint } from './tool-call-hint.js';
import { unwrapRuntimeEffectiveToolIdentity } from './tool-effect.js';
import { durableLogicalCallContract } from './logical-call-contract.js';

/**
 * Auto-compact for the harness loop. See plan v0.5.10.
 *
 * Three layers + lossless recall (via the `recall_tool_result` tool the
 * agent calls separately). This module owns the in-memory mutation of
 * `AgentInputItem[]` between turns; the persistence step in
 * `session.recordTurnResult` then writes the mutated history back to the
 * conversation snapshot.
 *
 *   Layer 1 — clip `function_call_result.output.text` for items older
 *             than the last N turns. Deterministic, no LLM call.
 *   Layer 2 — summarize older messages into a single `system` message
 *             via the configured worker model. Validates call_id references.
 *   Layer 3 — auto-fresh fork when even Layer 1+2 leaves the input above
 *             90% of budget. Returns a "fork to new session" signal so
 *             the channel layer can hand off.
 *
 * Trigger thresholds match the Codex CLI production defaults (180k cap,
 * retain ~20k recent). Defaults are tuned for the harness's 200k input
 * budget — see brackets.ts:331.
 */

// Tightened all four numbers after the plan-timeout regression.
// hit a 1.4MB Codex request body that consistently SSE-truncated. The
// previous defaults were tuned for "stop the worst offenders"; the new
// defaults are tuned for "keep request bodies under Codex's truncation
// cliff." Concrete moves:
//   - Layer 1 trigger 0.5 → 0.3  (clip older tool outputs at 30% of
//     budget instead of waiting for 50%)
//   - Layer 1 retain turns 8 → 4  (keep less raw history; agent can
//     use recall_tool_result to re-fetch any clipped output)
//     [re-loosened 4 → 6 on 2026-08-05 — see DEFAULT_LAYER1_RETAIN_TURNS]
//   - Layer 1 item threshold 30 → 15  (kick in earlier on chatty turns)
//   - Layer 2 trigger 0.7 → 0.55 (summarize older messages sooner)
const DEFAULT_LAYER1_ITEM_THRESHOLD = 15;
// Retain turns 4 → 6 (2026-08-05): 4 was tuned alongside a FIXED 200K budget;
// now that the budget tracks the routed model's real context window (see
// compactionBudgetForModel) the fractions fire at honest pressure, and keeping
// 6 turns of verbatim recent history trades a little headroom for fewer
// recall round-trips (a live scrape run went back via recall_tool_result 44×).
const DEFAULT_LAYER1_RETAIN_TURNS = 6;
const DEFAULT_LAYER1_RETAIN_TOOL_PAIRS = 12;
const DEFAULT_LAYER2_RETAIN_MESSAGES = 6;
const DEFAULT_LAYER1_TOKEN_FRACTION = 0.3;
const DEFAULT_LAYER2_TOKEN_FRACTION = 0.55;
const DEFAULT_LAYER3_TOKEN_FRACTION = 0.9;
// The item-count trigger (>N input items) is a chatty-turn backstop, but it
// must NOT fire while there is abundant token headroom — otherwise a multi-tool
// run (e.g. researching 10 prospects) clips its freshly-fetched results to
// stubs even at ~12% of budget, throwing away the very data the model needs and
// forcing recall round-trips (the observed regression had 14 outputs
// clipped at 30K/200K). So the item-count clause only applies once we're at
// least this fraction of budget; below it, ONLY genuine token pressure
// (layer1TokenFraction) triggers Layer 1. Token pressure, not item count, is
// the real signal.
const DEFAULT_LAYER1_ITEM_TRIGGER_MIN_FRACTION = 0.5;
const DEFAULT_INPUT_BUDGET_TOKENS = 200_000;

/**
 * Input budget derived from the ROUTED model's context window, not a constant.
 * The fixed 200K assumption was wrong in both directions (2026-08-05 audit):
 * a 128K-window BYO model hit provider overflow BEFORE the Layer 3 fork
 * (90% of 200K = 180K > the real window), while a 1M-window model clipped
 * verbatim history at 60K tokens with ~940K of headroom. The registry is the
 * single owner of window facts (resolveModelCapability; unknown wires resolve
 * to its conservative 128K default). Fractions are unchanged — they now just
 * apply to an honest denominator.
 */
export function compactionBudgetForModel(modelId: string | undefined | null): number {
  try {
    // Evidence-first: provider catalog listings / live acceptances / overflow
    // rejections override the static registry seed, so budgets track model
    // changes without a code release (see model-window-observations.ts).
    const window = effectiveContextWindow(modelId);
    return Number.isFinite(window) && window > 0 ? window : DEFAULT_INPUT_BUDGET_TOKENS;
  } catch {
    return DEFAULT_INPUT_BUDGET_TOKENS;
  }
}
const COLLAPSED_TOOL_SUMMARY_MAX_CHARS = 12_000;
const DEFAULT_IN_FLIGHT_RESULT_TRIGGER_TOKENS = 32_000;
const DEFAULT_IN_FLIGHT_RESULT_BUDGET_TOKENS = 20_000;
const DEFAULT_IN_FLIGHT_MIN_RETAIN_PAIRS = 3;
const DEFAULT_IN_FLIGHT_MAX_RETAIN_PAIRS = 8;

export interface InFlightCompactionThresholds {
  resultTriggerTokens: number;
  retainedResultBudgetTokens: number;
  minRetainPairs: number;
  maxRetainPairs: number;
}

/** Window scale for mid-turn compaction: 1 unless the routed wire caches the
 * prompt, because collapsing a cached prefix costs more prefill than it saves. */
export function inFlightPromptCacheScale(routedModelId?: string | null): number {
  try {
    if (!resolveModelCapability(routedModelId).supportsPromptCache) return 1;
    return windowScaleForModel(routedModelId);
  } catch {
    return 1;
  }
}

/**
 * Mid-turn (in-flight) compaction thresholds.
 *
 * The reason to compact mid-turn is per-frame prefill cost, which grows with
 * absolute prompt bytes — so on a wire with NO prompt cache these stay
 * absolute. Window-scaling them (2026-08-05) meant GLM's 512k needed 82k
 * tokens of results before the first collapse, so the host lane never
 * compacted the 27-read workflow steps that then composed 58k-token prompts
 * and timed out on first byte (live 2026-09-01).
 *
 * On a wire that DOES cache the prompt, the same arithmetic runs backwards:
 * collapsing results rewrites the prefix, so the next call re-prefills from
 * scratch. Live 2026-09-03, platform-49 run 6 on Sonnet 5 (1M window,
 * cacheMin 2048) — each collapse turned a cache hit into a cold prefill:
 *
 *     03:04:29  input 63,071  cached 57,911  uncached  5,160
 *     03:04:29  → collapse fires at the absolute 32k result trigger
 *     03:04:36  input 47,816  cached 12,287  uncached 35,529   (7x more)
 *
 * It fired three times; ~126k of the run's ~139k uncached tokens were the
 * cache busts it caused. It cost latency and money to save 15k of prompt, and
 * the collapsed results were the data the model then died trying to recall.
 *
 * So the trigger is gated on the ROUTED WIRE's cache support, which the
 * registry already owns. Non-caching wires (grok, GLM, gpt, kimi — every brain
 * the 2026-09-01 fix was measured on) keep today's absolute thresholds
 * byte-identically. Caching wires (the Claude family) scale with the real
 * window, the same `windowScaleForModel` its neighbours already use
 * (fanoutDigestThreshold, envelopeDigestMax, recall slices).
 *
 * Between-turn budgets still track the real window (compactionBudgetForModel);
 * env overrides still win here.
 */
export function inFlightCompactionThresholds(
  read: (key: string) => string | undefined = (key) => process.env[key],
  routedModelId?: string | null,
): InFlightCompactionThresholds {
  const positive = (key: string, fallback: number): number => {
    const raw = read(key);
    const parsed = raw === undefined || raw === '' ? NaN : Number.parseInt(raw, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  // 1 on a non-caching wire (byte-identical to the absolute defaults), the
  // real window ratio on a caching one. An unknown id resolves to the
  // registry's conservative default, whose supportsPromptCache is false — so
  // "unknown" fails safe onto the absolute thresholds.
  const cacheScale = inFlightPromptCacheScale(routedModelId);
  return {
    resultTriggerTokens: positive(
      'CLEMMY_INFLIGHT_RESULT_TRIGGER_TOKENS',
      Math.round(DEFAULT_IN_FLIGHT_RESULT_TRIGGER_TOKENS * cacheScale),
    ),
    retainedResultBudgetTokens: positive(
      'CLEMMY_INFLIGHT_RESULT_BUDGET_TOKENS',
      Math.round(DEFAULT_IN_FLIGHT_RESULT_BUDGET_TOKENS * cacheScale),
    ),
    minRetainPairs: positive('CLEMMY_INFLIGHT_MIN_RETAIN_PAIRS', DEFAULT_IN_FLIGHT_MIN_RETAIN_PAIRS),
    maxRetainPairs: positive('CLEMMY_INFLIGHT_MAX_RETAIN_PAIRS', DEFAULT_IN_FLIGHT_MAX_RETAIN_PAIRS),
  };
}
const COMPACTION_SYSTEM_SUMMARY_PREFIXES = [
  '[summary of older completed tool activity]',
  '[summary of byte-identical completed tool activity]',
  '[summary of earlier conversation]',
] as const;

type SummarizerTurnResult = { summary: string; modelUsed: string } | { error: string };

let summarizerTurnForTests: ((serializedOlder: string) => Promise<SummarizerTurnResult>) | null = null;

export function _setCompactionSummarizerForTests(
  fn: ((serializedOlder: string) => Promise<SummarizerTurnResult>) | null,
): void {
  summarizerTurnForTests = fn;
}

export const canonicalToolResultClipPlaceholder = (
  toolName: string | null,
  chars: number,
  callId: string,
  iso: string,
): string =>
  `[clipped: ${toolName ?? 'tool'} returned ${chars} chars at ${iso} — ${toolCallHint('recall_tool_result', { call_id: callId })} returns the full output]`;

export interface CanonicalClippedToolResult {
  callId: string;
  toolName: string | null;
  originalChars: number;
  clippedAt: string;
}

/** Parse only the exact deterministic Layer-1 result shape emitted below.
 * This is syntax, not authority: a caller must still prove the immutable
 * settlement/receipt, the recallable original bytes, and the durable
 * `condenser_applied` event before treating the projection as host-compacted. */
export function describeCanonicalClippedToolResult(
  item: AgentInputItem,
): CanonicalClippedToolResult | null {
  const row = item as Record<string, unknown>;
  if (
    row.type !== 'function_call_result'
    || row.status !== 'completed'
    || row.__clipped !== true
    || typeof row.callId !== 'string'
    || !row.callId
    || (row.name !== undefined && typeof row.name !== 'string')
    || !row.output
    || typeof row.output !== 'object'
    || Array.isArray(row.output)
    || !row.__clippedMeta
    || typeof row.__clippedMeta !== 'object'
    || Array.isArray(row.__clippedMeta)
  ) return null;
  const output = row.output as Record<string, unknown>;
  const meta = row.__clippedMeta as Record<string, unknown>;
  if (
    Object.keys(output).sort().join('|') !== 'text|type'
    || output.type !== 'text'
    || typeof output.text !== 'string'
    || Object.keys(meta).sort().join('|') !== 'at|bytes|callId|tool'
    || (meta.tool !== null && typeof meta.tool !== 'string')
    || !Number.isSafeInteger(meta.bytes)
    || Number(meta.bytes) < 400
    || meta.callId !== row.callId
    || typeof meta.at !== 'string'
  ) return null;
  const clippedAt = meta.at;
  try {
    if (new Date(clippedAt).toISOString() !== clippedAt) return null;
  } catch {
    return null;
  }
  const toolName = typeof row.name === 'string' ? row.name : null;
  const originalChars = Number(meta.bytes);
  if (
    meta.tool !== toolName
    || output.text !== canonicalToolResultClipPlaceholder(
      toolName,
      originalChars,
      row.callId,
      clippedAt,
    )
  ) return null;
  return { callId: row.callId, toolName, originalChars, clippedAt };
}

// Summarization is delegated work. Use the canonical worker assignment,
// whose default follows the configured brain and whose explicit assignments
// retain their provider. A legacy fast-tier id can name an unsupported or
// unrelated provider even while the user's selected brain works normally.
async function getSummarizerModel(): Promise<string> {
  const { resolveRoleModel } = await import('./model-roles.js');
  return resolveRoleModel('worker').modelId;
}

export interface CompactionOptions {
  inputBudgetTokens?: number;
  layer1ItemThreshold?: number;
  layer1RetainTurns?: number;
  layer1RetainToolPairs?: number;
  layer2RetainMessages?: number;
  layer1TokenFraction?: number;
  /** Min budget fraction before the item-count trigger may fire (headroom guard). */
  layer1ItemTriggerMinFraction?: number;
  layer2TokenFraction?: number;
  layer3TokenFraction?: number;
  /** Disable specific layers via CLEMMY_AUTO_COMPACT=off|layer1_only. */
  disable?: 'off' | 'layer1_only' | undefined;
  /**
   * Stage-checkpoint (D2): force Layer 1 + Layer 2 unconditionally, regardless
   * of token pressure. Used at a goal stage boundary to reset the context for
   * the next milestone while the goal's ledger + criteria carry forward. Layer 3
   * (fork) is suppressed — the checkpoint IS the reset.
   */
  forceLayer2?: boolean;
  /** @deprecated Accepted for caller compatibility only. Elapsed idle time
   * is not context pressure and never authorizes information loss. */
  idleMs?: number;
  /** @deprecated Ignored; compaction follows model context pressure. */
  idleCompactionThresholdMs?: number;
  /** @deprecated Ignored; compaction follows model context pressure. */
  idleCompactionMinTokens?: number;
  /** Test injection. */
  now?: () => string;
}

export interface CompactionResult {
  /** True if anything changed; caller should persist via session.recordTurnResult. */
  modified: boolean;
  layer1: { applied: boolean; clipped: number; collapsedToolPairs: number };
  layer2: { applied: boolean; removedItems: number; summaryItems: number; callIdsReferenced: string[]; hallucinatedCallIds: string[]; modelUsed: string | null; error?: string };
  layer3: { applied: boolean; forkRequested: boolean };
  beforeTokens: number;
  afterTokens: number;
  budgetTokens: number;
}

function readDisableFlag(): CompactionOptions['disable'] {
  const raw = (process.env.CLEMMY_AUTO_COMPACT ?? '').trim().toLowerCase();
  if (raw === 'off') return 'off';
  if (raw === 'layer1_only' || raw === 'layer1' || raw === 'l1') return 'layer1_only';
  return undefined;
}

function nowIso(opts?: CompactionOptions): string {
  return opts?.now ? opts.now() : new Date().toISOString();
}

/**
 * Layer-1-clipped marker. Attached to function_call_result items via
 * direct property mutation so Layer 2 can detect them and skip re-
 * summarizing the stub.
 */
function isClippedItem(item: AgentInputItem): boolean {
  return (item as Record<string, unknown>).__clipped === true;
}

/**
 * Layer 1 — deterministic tool-output trim.
 *
 * Walks items in order and identifies the LAST `retainTurns` tool
 * results to keep verbatim. Everything earlier (any `function_call_result`
 * before that boundary) gets its `output.text` replaced with a stub that
 * names the call_id for recall.
 *
 * Why count by tool result rather than user message: a single user
 * message can trigger 30+ tool calls in one turn (parallel discovery /
 * fan-out work). Retaining by "user turn boundary" then keeps the full
 * 30+ KB of tool output verbatim. Tool-result count is the right unit
 * because tool returns are the dominant context cost — exactly what we
 * want to trim.
 *
 * Idempotent: re-running on an already-clipped item does nothing because
 * the `__clipped` marker short-circuits.
 *
 * Returns the count of items just clipped (excluding those already
 * clipped on a prior pass).
 */
export function clipOldToolResults(
  items: AgentInputItem[],
  retainTurns: number = DEFAULT_LAYER1_RETAIN_TURNS,
  opts?: CompactionOptions,
  sessionId?: string,
): number {
  if (items.length === 0) return 0;

  // Identify function_call_result indices in order. The LAST N stay
  // verbatim, the rest are clipping candidates.
  const resultIndices: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const any = items[i] as Record<string, unknown>;
    if (any.type === 'function_call_result') resultIndices.push(i);
  }

  // If we have fewer than retainTurns results, nothing to clip.
  if (resultIndices.length <= retainTurns) return 0;

  // First index NOT eligible for clipping = the (count - retainTurns)th
  // result. Anything strictly before this index is eligible.
  const keepFromIndex = resultIndices[resultIndices.length - retainTurns];
  let clipped = 0;
  const iso = nowIso(opts);

  for (let i = 0; i < keepFromIndex; i++) {
    const item = items[i] as Record<string, unknown>;
    if (item.type !== 'function_call_result') continue;
    if (isClippedItem(item as AgentInputItem)) continue;

    const callId = typeof item.callId === 'string' ? item.callId : null;
    if (!callId) continue; // can't clip what we can't recall
    if (!recallableToolOutputExists(sessionId, callId)) continue;

    const output = item.output as { type?: string; text?: string } | string | undefined;
    let originalText = '';
    if (typeof output === 'string') {
      originalText = output;
    } else if (
      output
      && typeof output === 'object'
      && output.type === 'text'
      && typeof output.text === 'string'
      && Object.keys(output).every((key) => key === 'type' || key === 'text')
    ) {
      originalText = output.text;
    } else {
      continue; // empty output; nothing to clip
    }

    // Skip if the original is already small (clipping doesn't help and
    // adds tokens).
    if (originalText.length < 400) continue;
    // Never clip a host disposition (a pre-dispatch refusal or host-settled
    // verdict): it is a few hundred bytes the model must keep reading verbatim,
    // and it is the frame provenance guards most tightly. Live 2026-09-05: two
    // clipped refusals made every resume of a parked task die pre-dispatch.
    if (originalText.includes('"protocol":"host_tool_disposition_v1"')) continue;

    // Tool name lives in metadata-ish places; pull from a `name` field
    // if present, otherwise null.
    const toolName = typeof item.name === 'string' ? item.name : null;

    const stub = canonicalToolResultClipPlaceholder(toolName, originalText.length, callId, iso);
    // Mutate in-place. Keep structure shape (output.type === 'text')
    // so downstream serializer (codex-model.ts:481) renders it verbatim.
    item.output = { type: 'text', text: stub };
    item.__clipped = true;
    item.__clippedMeta = {
      tool: toolName,
      bytes: originalText.length,
      callId,
      at: iso,
    };
    clipped += 1;
  }

  return clipped;
}

function oneLine(value: string, maxChars: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars).trimEnd()}...`;
}

function outputTextOf(item: Record<string, unknown>): string {
  const output = item.output as { type?: string; text?: string } | string | undefined;
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object' && typeof output.text === 'string') return output.text;
  return '';
}

function isCompactionSystemSummary(item: AgentInputItem): boolean {
  const any = item as Record<string, unknown> & { role?: unknown; content?: unknown };
  const content = any.content;
  return any.role === 'system'
    && typeof content === 'string'
    && COMPACTION_SYSTEM_SUMMARY_PREFIXES.some((prefix) => content.startsWith(prefix));
}

function isLayer2PreservedItem(item: AgentInputItem): boolean {
  const any = item as Record<string, unknown> & { type?: string; role?: string };
  return any.role === 'user'
    || any.type === 'function_call'
    || any.type === 'function_call_result'
    || isCompactionSystemSummary(item);
}

function recallableToolOutputExists(sessionId: string | undefined, callId: string): boolean {
  if (!sessionId) return true;
  try {
    const stored = getToolOutput(sessionId, callId);
    return stored != null && !stored.truncatedAtWrite;
  } catch {
    return false;
  }
}

interface CompletedToolPair {
  callId: string;
  callIndex: number;
  resultIndex: number;
  name: string;
  args: string;
  resultText: string;
  storedResultText: string | null;
}

function completedToolPairs(
  items: AgentInputItem[],
  sessionId?: string,
  requireRecallable = true,
): CompletedToolPair[] {
  const calls = new Map<string, { index: number; item: Record<string, unknown> }>();
  const results = new Map<string, { index: number; item: Record<string, unknown> }>();
  const resultOrder: string[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] as Record<string, unknown>;
    const callId = typeof item.callId === 'string' ? item.callId : null;
    if (!callId) continue;
    if (item.type === 'function_call' && !calls.has(callId)) {
      calls.set(callId, { index, item });
    } else if (item.type === 'function_call_result' && !results.has(callId)) {
      results.set(callId, { index, item });
      resultOrder.push(callId);
    }
  }

  const pairs: CompletedToolPair[] = [];
  for (const callId of resultOrder) {
    const call = calls.get(callId);
    const result = results.get(callId);
    if (!call || !result || call.index > result.index) continue;
    if (requireRecallable && !recallableToolOutputExists(sessionId, callId)) continue;
    let storedResultText: string | null = null;
    if (sessionId) {
      try {
        const stored = getToolOutput(sessionId, callId);
        storedResultText = stored && !stored.truncatedAtWrite ? stored.output : null;
      } catch {
        storedResultText = null;
      }
    }
    pairs.push({
      callId,
      callIndex: call.index,
      resultIndex: result.index,
      name: typeof call.item.name === 'string' ? call.item.name : 'tool',
      args: typeof call.item.arguments === 'string' ? call.item.arguments : '',
      resultText: outputTextOf(result.item),
      storedResultText,
    });
  }
  return pairs;
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

interface DuplicateToolPairGroup {
  canonical: CompletedToolPair;
  duplicates: CompletedToolPair[];
  sha256: string;
}

/**
 * Place a collapse summary without splitting an open call/result pair.
 *
 * Both collapse passes want the summary where the first collapsed item stood.
 * In a SEQUENTIAL frame (call, result, call, result) that position is always a
 * closed boundary. In a PARALLEL frame (call, call, result, result) it is not:
 * dropping the second pair leaves `call A | summary | result A`, and the
 * provider protocol boundary rejects that as `conversation_advanced_with_open_call`
 * (live 2026-08-24: two concurrent tool_search calls returned identical bytes,
 * dedup fired, and the next model step failed the assertion even though every
 * call had settled cleanly).
 *
 * So advance the insertion point to the first index at or after the desired one
 * where no function_call is still awaiting its result. Ordering of surviving
 * items is never changed.
 */
function insertAtClosedCallBoundary(
  items: AgentInputItem[],
  desiredIndex: number,
  summary: AgentInputItem,
): AgentInputItem[] {
  const open = new Set<string>();
  let index = 0;
  for (; index < items.length; index += 1) {
    if (index >= desiredIndex && open.size === 0) break;
    const any = items[index] as Record<string, unknown>;
    const callId = typeof any.callId === 'string' ? any.callId : null;
    if (!callId) continue;
    if (any.type === 'function_call') open.add(callId);
    else if (any.type === 'function_call_result') open.delete(callId);
  }
  return [...items.slice(0, index), summary, ...items.slice(index)];
}

function buildDuplicateToolPairsSummary(groups: DuplicateToolPairGroup[]): AgentInputItem {
  const duplicateCount = groups.reduce((sum, group) => sum + group.duplicates.length, 0);
  const lines = [
    '[summary of byte-identical completed tool activity]',
    `${duplicateCount} completed calls returned bytes already visible in ${groups.length} canonical result${groups.length === 1 ? '' : 's'}. The duplicate calls remain independently recallable; no durable output was discarded.`,
  ];
  for (const group of groups) {
    for (const pair of group.duplicates) {
      const args = pair.args ? oneLine(pair.args, 120) : '{}';
      lines.push(
        `- ${pair.name} [${pair.callId}] args: ${args}; output is byte-identical to [${group.canonical.callId}] sha256=${group.sha256}; ${toolCallHint('recall_tool_result', { call_id: pair.callId })} returns its exact stored bytes.`,
      );
    }
  }
  return { role: 'system', content: lines.join('\n') } as unknown as AgentInputItem;
}

/**
 * Collapse byte-identical completed results before pressure-based compaction.
 * The first pair stays verbatim; later pairs become a compact, call-id-complete
 * recall ledger. Raw outputs remain independently parked under every original
 * call id.
 */
export function collapseDuplicateCompletedToolPairs(
  items: AgentInputItem[],
  sessionId?: string,
): { nextItems: AgentInputItem[]; collapsed: number; callIds: string[] } {
  if (items.length === 0) return { nextItems: items, collapsed: 0, callIds: [] };

  const byDigest = new Map<string, DuplicateToolPairGroup[]>();
  for (const pair of completedToolPairs(items, sessionId)) {
    // Deduplication claims byte identity, so prove it from the durable raw
    // store and require the canonical visible value to be those same bytes.
    // Two equal clipping/digest stubs must never collapse distinct raw output.
    if (!pair.storedResultText || pair.resultText !== pair.storedResultText) continue;
    const digest = sha256Text(pair.storedResultText);
    const bucket = byDigest.get(digest) ?? [];
    const exact = bucket.find((group) => group.canonical.storedResultText === pair.storedResultText);
    if (exact) {
      exact.duplicates.push(pair);
    } else {
      bucket.push({ canonical: pair, duplicates: [], sha256: digest });
      byDigest.set(digest, bucket);
    }
  }

  const groups: DuplicateToolPairGroup[] = [];
  for (const bucket of byDigest.values()) {
    for (const group of bucket) {
      if (group.duplicates.length === 0) continue;
      const ledgerChars = group.duplicates.reduce((sum, pair) =>
        sum + pair.callId.length + pair.name.length + Math.min(pair.args.length, 120) + 180, 0);
      const removedChars = group.duplicates.reduce((sum, pair) =>
        sum + pair.resultText.length + pair.args.length + pair.callId.length + pair.name.length + 120, 0);
      if (ledgerChars < removedChars) groups.push(group);
    }
  }
  if (groups.length === 0) return { nextItems: items, collapsed: 0, callIds: [] };

  const duplicates = groups.flatMap((group) => group.duplicates);
  const collapseIds = new Set(duplicates.map((pair) => pair.callId));
  const summary = buildDuplicateToolPairsSummary(groups);
  const nextItems: AgentInputItem[] = [];
  let desiredIndex = -1;
  for (const item of items) {
    const any = item as Record<string, unknown>;
    const callId = typeof any.callId === 'string' ? any.callId : null;
    const shouldCollapse = callId != null
      && collapseIds.has(callId)
      && (any.type === 'function_call' || any.type === 'function_call_result');
    if (shouldCollapse) {
      if (desiredIndex < 0) desiredIndex = nextItems.length;
      continue;
    }
    nextItems.push(item);
  }
  return {
    nextItems: desiredIndex < 0
      ? nextItems
      : insertAtClosedCallBoundary(nextItems, desiredIndex, summary),
    collapsed: duplicates.length,
    callIds: duplicates.map((pair) => pair.callId),
  };
}

function collapsedPairLine(pair: CompletedToolPair): string {
  const args = pair.args ? oneLine(pair.args, 180) : '{}';
  // Match BOTH clip-marker generations: the current valid-JSON hint form and
  // the legacy paren form (persisted snapshots from older versions replay
  // through here — detection must stay lenient even though we only EMIT the
  // JSON form).
  const clippedMarker = pair.resultText.match(/\[clipped:[^\]]*recall_tool_result[^\]]*\]/)?.[0];
  const result = clippedMarker ?? oneLine(pair.resultText, 220);
  // The summary header already explains collapse and lossless recall. Keep
  // each exact invocation beside its result, without repeating that paragraph
  // for every parked pair. Existing clip markers and call IDs stay readable.
  return `- ${pair.name} [${pair.callId}] args: ${args}; result: ${result || '(empty)'} [clipped: ${toolCallHint('recall_tool_result', { call_id: pair.callId })}]`;
}

function completedWriteLines(pairs: CompletedToolPair[], sessionId?: string): string[] {
  if (!sessionId) return [];
  try {
    const settled = openEventLog().prepare(`
      SELECT s.logical_tool_call_id, s.result_handle_id, s.outcome_kind, s.mutating,
             l.accepted_task_id, l.argument_digest, l.tool_name
        FROM logical_call_settlements s JOIN logical_tool_calls l
          ON l.session_id = s.session_id AND l.source_user_seq = s.source_user_seq
         AND l.logical_tool_call_id = s.logical_tool_call_id
       WHERE s.session_id = ?
    `).all(sessionId) as Array<{ logical_tool_call_id: string; result_handle_id: string | null; outcome_kind: string;
      mutating: number; accepted_task_id: string; argument_digest: string; tool_name: string }>;
    const byCall = new Map<string, typeof settled>();
    for (const row of settled) byCall.set(row.logical_tool_call_id, [...(byCall.get(row.logical_tool_call_id) ?? []), row]);
    return pairs.flatMap(pair => {
      const matches = byCall.get(pair.callId);
      if (matches?.length !== 1) return [];
      const settlement = matches[0]!;
      if (settlement.mutating !== 1 || !['succeeded', 'empty_result'].includes(settlement.outcome_kind)) return [];
      let args: unknown = pair.args;
      try { args = JSON.parse(pair.args); } catch { /* retain the exact input */ }
      const contract = durableLogicalCallContract(settlement.accepted_task_id, pair.name, args);
      if (!contract || contract.toolName !== settlement.tool_name || contract.argumentDigest !== settlement.argument_digest) return [];
      const effective = args && typeof args === 'object' && !Array.isArray(args)
        ? unwrapRuntimeEffectiveToolIdentity(pair.name, args as Record<string, unknown>) : null;
      // Full completed-call arguments are the work inventory. A 180-character
      // carrier prefix often contains no recipient/target at all. Keep every
      // settled write here, outside the generic history prose budget; only
      // its verbose provider response is parked in the existing result store.
      return [JSON.stringify({
        callId: pair.callId,
        tool: effective?.toolName ?? pair.name,
        outcome: settlement.outcome_kind,
        arguments: effective?.args ?? args,
        resultHandle: settlement.result_handle_id,
      })];
    });
  } catch {
    // Never replace an unreadable ledger with an invented success claim.
    return [];
  }
}

function buildCollapsedToolPairsSummary(pairs: CompletedToolPair[], sessionId?: string): AgentInputItem {
  const completeCallIdIndex = `[complete collapsed call-id index JSON] ${JSON.stringify(pairs.map((pair) => pair.callId))}`;
  const lines: string[] = [
    '[summary of older completed tool activity]',
    `${pairs.length} older completed tool call/result pairs were collapsed to keep the active model context small. Recent tool calls remain verbatim. Exact older outputs remain available with ${toolCallHint('recall_tool_result', { call_id: '<call id>' })}.`,
    completeCallIdIndex,
  ];

  let chars = lines.join('\n').length;
  let omitted = 0;
  for (let i = 0; i < pairs.length; i++) {
    const line = collapsedPairLine(pairs[i]);
    if (chars + line.length + 1 > COLLAPSED_TOOL_SUMMARY_MAX_CHARS) {
      omitted = pairs.length - i;
      break;
    }
    lines.push(line);
    chars += line.length + 1;
  }
  if (omitted > 0) {
    lines.push(`- ${omitted} additional older completed tool calls were also collapsed; use the visible recent context first, then ask for a specific recall if needed.`);
  }
  const writes = completedWriteLines(pairs, sessionId);
  if (writes.length > 0) {
    lines.push('', '[Durable completed writes — already done]',
      'These exact calls settled successfully. Use this inventory to continue unfinished work; do not recreate these outputs because their full provider responses were compacted. Read the original call_id to recover an object ID or verify its current state.',
      ...writes);
  }

  return {
    role: 'system',
    content: lines.join('\n'),
  } as unknown as AgentInputItem;
}

/**
 * Layer 1b - deterministic pair collapse.
 *
 * Clipping shrinks old tool outputs, but the SDK history can still carry
 * dozens of completed function_call/function_call_result pairs. Codex
 * only requires paired structure for items we actually replay. For old,
 * completed, recallable pairs we can remove BOTH sides and replace them
 * with one system summary that points back to recall_tool_result.
 *
 * Safety rules:
 *   - keep the most recent retainPairs pairs verbatim
 *   - collapse only pairs with both call and result present
 *   - when sessionId is provided, collapse only if tool_outputs has a
 *     recallable full payload for the call_id
 *   - remove call and result together, so no orphan outputs are created
 */
export function collapseOldCompletedToolPairs(
  items: AgentInputItem[],
  retainPairs: number = DEFAULT_LAYER1_RETAIN_TOOL_PAIRS,
  sessionId?: string,
): { nextItems: AgentInputItem[]; collapsed: number; callIds: string[] } {
  if (items.length === 0) return { nextItems: items, collapsed: 0, callIds: [] };

  const normalizedRetain = Math.max(0, Math.floor(retainPairs));
  const completed = completedToolPairs(items, sessionId, false);
  const completedIds = completed.map((pair) => pair.callId);
  if (completedIds.length <= normalizedRetain) {
    return { nextItems: items, collapsed: 0, callIds: [] };
  }

  const keepIds = new Set(completedIds.slice(-normalizedRetain));
  const pairs: CompletedToolPair[] = [];
  for (const pair of completed) {
    if (keepIds.has(pair.callId)) continue;
    if (!recallableToolOutputExists(sessionId, pair.callId)) continue;
    pairs.push(pair);
  }

  if (pairs.length === 0) return { nextItems: items, collapsed: 0, callIds: [] };

  const collapseIds = new Set(pairs.map((pair) => pair.callId));
  const summary = buildCollapsedToolPairsSummary(pairs, sessionId);
  const nextItems: AgentInputItem[] = [];
  let desiredIndex = -1;

  for (const item of items) {
    const any = item as Record<string, unknown>;
    const callId = typeof any.callId === 'string' ? any.callId : null;
    const shouldCollapse = callId != null
      && collapseIds.has(callId)
      && (any.type === 'function_call' || any.type === 'function_call_result');

    if (shouldCollapse) {
      if (desiredIndex < 0) desiredIndex = nextItems.length;
      continue;
    }
    nextItems.push(item);
  }

  return {
    nextItems: desiredIndex < 0
      ? nextItems
      : insertAtClosedCallBoundary(nextItems, desiredIndex, summary),
    collapsed: pairs.length,
    callIds: pairs.map((pair) => pair.callId),
  };
}

export interface InFlightToolContextOptions {
  /** Begin compacting once completed tool-result payloads exceed this estimate. */
  resultTriggerTokens?: number;
  /** Keep as many newest result pairs as fit within this estimate. */
  retainedResultBudgetTokens?: number;
  /** Always keep at least this many newest completed pairs verbatim. */
  minRetainPairs?: number;
  /** Never keep more than this many completed pairs once pressure triggers. */
  maxRetainPairs?: number;
}

export interface InFlightToolContextResult {
  nextItems: AgentInputItem[];
  applied: boolean;
  collapsed: number;
  callIds: string[];
  retainedPairs: number;
  resultTokensBefore: number;
  beforeTokens: number;
  afterTokens: number;
  triggerTokens: number;
}

/**
 * Model-only compaction for a tool-heavy Runner loop.
 *
 * `compactSessionIfNeeded` runs between user turns, but one SDK Runner call can
 * itself contain dozens of model→tool→model rounds. Without this seam, every
 * later round resends every earlier raw result from the same turn. Once result
 * payloads cross a bounded threshold, retain an adaptive recent tail and
 * replace older, durably parked pairs with a recall ledger.
 *
 * This helper is intentionally pure: unlike between-turn Layer 1, it never
 * mutates or persists `items`. The full transcript remains available to the
 * Runner and every collapsed result remains losslessly recallable.
 */
export function compactInFlightToolContext(
  items: AgentInputItem[],
  sessionId?: string,
  opts: InFlightToolContextOptions = {},
): InFlightToolContextResult {
  const triggerTokens = Math.max(1, Math.floor(
    opts.resultTriggerTokens ?? DEFAULT_IN_FLIGHT_RESULT_TRIGGER_TOKENS,
  ));
  const retainedBudget = Math.max(1, Math.floor(
    opts.retainedResultBudgetTokens ?? DEFAULT_IN_FLIGHT_RESULT_BUDGET_TOKENS,
  ));
  const minRetain = Math.max(0, Math.floor(
    opts.minRetainPairs ?? DEFAULT_IN_FLIGHT_MIN_RETAIN_PAIRS,
  ));
  const maxRetain = Math.max(minRetain, Math.floor(
    opts.maxRetainPairs ?? DEFAULT_IN_FLIGHT_MAX_RETAIN_PAIRS,
  ));
  const beforeTokens = estimateInputTokens(items);

  const completedResultTokens = (sourceItems: AgentInputItem[]) => {
    const callIds = new Set<string>();
    for (const item of sourceItems) {
      const any = item as Record<string, unknown>;
      if (any.type === 'function_call' && typeof any.callId === 'string') callIds.add(any.callId);
    }
    const results: Array<{ callId: string; tokens: number }> = [];
    for (const item of sourceItems) {
      const any = item as Record<string, unknown>;
      const callId = typeof any.callId === 'string' ? any.callId : '';
      if (any.type !== 'function_call_result' || !callId || !callIds.has(callId)) continue;
      results.push({ callId, tokens: estimateInputTokens([item]) });
    }
    return results;
  };

  const originalCompletedResults = completedResultTokens(items);
  const resultTokensBefore = originalCompletedResults.reduce((sum, pair) => sum + pair.tokens, 0);
  const unchanged = (): InFlightToolContextResult => ({
    nextItems: items,
    applied: false,
    collapsed: 0,
    callIds: [],
    retainedPairs: originalCompletedResults.length,
    resultTokensBefore,
    beforeTokens,
    afterTokens: beforeTokens,
    triggerTokens,
  });

  // Equal bytes do not make a fresh observation interchangeable with an old
  // one. Removing the newest call/result pair can leave the assistant's
  // pre-read message as the conversation tail and cause another identical
  // read (live workflow UPDATE, source 134776). Below pressure preserve the
  // exact frame; above pressure collapse only older pairs, retaining the tail.
  const completedResults = originalCompletedResults;
  if (resultTokensBefore <= triggerTokens || completedResults.length <= minRetain) return unchanged();

  let retainedPairs = 0;
  let retainedTokens = 0;
  for (let i = completedResults.length - 1; i >= 0; i--) {
    const nextTokens = completedResults[i].tokens;
    if (retainedPairs < minRetain) {
      retainedPairs += 1;
      retainedTokens += nextTokens;
      continue;
    }
    if (retainedPairs >= maxRetain || retainedTokens + nextTokens > retainedBudget) break;
    retainedPairs += 1;
    retainedTokens += nextTokens;
  }

  const collapsed = collapseOldCompletedToolPairs(items, retainedPairs, sessionId);
  if (collapsed.collapsed === 0) return unchanged();
  return {
    nextItems: collapsed.nextItems,
    applied: true,
    collapsed: collapsed.collapsed,
    callIds: collapsed.callIds,
    retainedPairs,
    resultTokensBefore,
    beforeTokens,
    afterTokens: estimateInputTokens(collapsed.nextItems),
    triggerTokens,
  };
}

/**
 * Build the prompt for Layer 2's single summarization turn. We instruct
 * the model to:
 *   - bullet-format the summary (5-15 bullets)
 *   - retain call_id references in [call_xxx] markers for recall
 *   - preserve verbatim user messages, approval decisions, errors
 *   - be precise with details (URLs, IDs, exact figures)
 */
function buildSummarizerPrompt(serializedOlder: string): string {
  return [
    `You are summarizing the older portion of a multi-turn agent conversation so the next turn can fit in its context window.`,
    ``,
    `Produce 5-15 bullets. For each tool call you reference, INCLUDE the original call_id in brackets like [call_abc123] so the agent can recall the full output via recall_tool_result. Preserve verbatim where possible: user messages, approval decisions, errors. Be precise with details that may matter later (URLs, IDs, exact figures, page numbers, ranking positions, named entities).`,
    ``,
    `Do not include any apology or meta-comment. Output ONLY the bullet list. The bullets will be inserted as a system message before the most recent turn.`,
    ``,
    `---`,
    serializedOlder,
    `---`,
  ].join('\n');
}

/**
 * Serialize older items into a flat plain-text representation for the
 * summarizer. The summarizer doesn't need to see encrypted reasoning
 * blobs or full structural shapes — it needs the semantic content:
 * what was said, what was called, what came back.
 */
function serializeForSummarizer(items: AgentInputItem[]): string {
  const lines: string[] = [];
  for (const item of items) {
    const any = item as Record<string, unknown> & { type?: string; role?: string };
    if (any.role && (any.type === 'message' || 'content' in any)) {
      const content = any.content;
      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (part && typeof part === 'object') {
            const p = part as { text?: string };
            if (typeof p.text === 'string') text += p.text;
          }
        }
      }
      if (text) lines.push(`[${String(any.role).toUpperCase()}] ${text}`);
      continue;
    }
    if (any.type === 'function_call') {
      const name = typeof any.name === 'string' ? any.name : 'tool';
      const callId = typeof any.callId === 'string' ? any.callId : '';
      const args = typeof any.arguments === 'string' ? any.arguments.slice(0, 500) : '';
      lines.push(`[TOOL_CALL ${name} call_id=${callId}] ${args}`);
      continue;
    }
    if (any.type === 'function_call_result') {
      const callId = typeof any.callId === 'string' ? any.callId : '';
      const output = any.output as { type?: string; text?: string } | string | undefined;
      let text = '';
      if (typeof output === 'string') text = output;
      else if (output && typeof output === 'object' && typeof output.text === 'string') text = output.text;
      // Cap at 4KB per result for the summarizer's input — we don't need
      // the full content to summarize, and shorter input keeps the
      // summarizer turn cheap.
      const capped = text.length > 4000 ? `${text.slice(0, 4000)}…[+${text.length - 4000} chars]` : text;
      lines.push(`[TOOL_RESULT call_id=${callId}] ${capped}`);
      continue;
    }
    // Skip reasoning + unknown — they don't help the summarizer.
  }
  return lines.join('\n');
}

/**
 * Run a single summarization turn against the selected worker model. Returns
 * the bullet-summary text, or null on failure. Failures are non-fatal
 * for the outer compaction loop — Layer 2 is best-effort, and Layer 3
 * can still take over if needed.
 */
/**
 * Cap the summarizer's INPUT to a safe fraction of the summarizer model's OWN
 * window. Latent until window-aware budgets (2026-08-05): on a 200K-budget
 * session Layer 2 fired at ~110K tokens of history and the per-item caps kept
 * the serialized blob far under the fast model's 272K window — but on an
 * 880K/1M-budget session the 55% trigger can serialize MORE history than the
 * summarizer itself can read, and the overflowing call would fail Layer 2
 * every turn until the Layer 3 fork. Truncate from the HEAD (oldest lines):
 * Layer 2 is lossy by design, parked tool outputs stay recallable by call_id,
 * and the omission is stated so the summary never silently claims coverage.
 * 60% of the window (×4 chars/token) leaves room for the prompt + output.
 */
export function capSummarizerInput(serializedOlder: string, summarizerModelId: string): string {
  const maxChars = Math.floor(effectiveContextWindow(summarizerModelId) * 4 * 0.6);
  if (serializedOlder.length <= maxChars) return serializedOlder;
  const kept = serializedOlder.slice(-maxChars);
  // Start at a line boundary so the first kept line isn't a severed fragment.
  const firstNewline = kept.indexOf('\n');
  const clean = firstNewline > 0 && firstNewline < 2_000 ? kept.slice(firstNewline + 1) : kept;
  const droppedChars = serializedOlder.length - clean.length;
  return `[NOTE: the ${droppedChars.toLocaleString()} oldest chars of this history were omitted from summarization — their exact tool outputs remain recallable by call_id.]\n${clean}`;
}

async function runSummarizerTurn(serializedOlder: string): Promise<SummarizerTurnResult> {
  try {
    const modelId = await getSummarizerModel();
    // Cap to the selected worker's window before the test hook or transport.
    serializedOlder = capSummarizerInput(serializedOlder, modelId);
    if (summarizerTurnForTests) return await summarizerTurnForTests(serializedOlder);
    // Resolve through the same credential router as other host model calls;
    // a utility Runner must not inherit the SDK's ambient OpenAI provider.
    const { resolveHarnessModel } = await import('./codex-client.js');
    const model = await resolveHarnessModel(modelId);
    const agent = new Agent({
      name: 'Compaction Summarizer',
      model,
      // Bullet-summary compression is a mechanical transform, not a reasoning
      // task — low effort keeps the (often large) compaction call fast.
      modelSettings: { reasoning: { effort: 'low' } },
      instructions: 'You compress agent conversation history into bullet summaries that preserve actionable detail.',
    });
    const runner = new Runner({ workflowName: 'clementine-compaction' });
    const result = await runner.run(agent, buildSummarizerPrompt(serializedOlder));
    const text = typeof (result as { finalOutput?: unknown }).finalOutput === 'string'
      ? (result as { finalOutput: string }).finalOutput
      : String((result as { finalOutput?: unknown }).finalOutput ?? '');
    if (!text || !text.trim()) {
      return { error: 'summarizer returned empty output' };
    }
    return { summary: text.trim(), modelUsed: modelId };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Validate that every [call_xxx] reference in the summary text exists
 * in the session's actual tool_called events. Rewrite hallucinated ids
 * to `[invalid call_id]` so the agent doesn't waste a recall budget on
 * something that isn't there.
 */
export function validateCallIdReferences(
  summary: string,
  validCallIds: ReadonlySet<string>,
): { sanitized: string; referenced: string[]; hallucinated: string[] } {
  const referenced: string[] = [];
  const hallucinated: string[] = [];
  // Match [call_xxx] — call_ids from the SDK are alphanumeric.
  const sanitized = summary.replace(/\[(call_[A-Za-z0-9_-]+)\]/g, (match, id: string) => {
    if (validCallIds.has(id)) {
      if (!referenced.includes(id)) referenced.push(id);
      return match;
    }
    if (!hallucinated.includes(id)) hallucinated.push(id);
    return '[invalid call_id]';
  });
  return { sanitized, referenced, hallucinated };
}

function listValidCallIdsForSession(sessionId: string): Set<string> {
  const ids = new Set<string>();
  try {
    const events: EventRow[] = listEvents(sessionId, { types: ['tool_called'] });
    for (const ev of events) {
      const callId = (ev.data as { callId?: unknown }).callId;
      if (typeof callId === 'string' && callId) ids.add(callId);
    }
  } catch {
    // best-effort
  }
  return ids;
}

/**
 * Layer 2 — summarize older messages into a single system message.
 *
 * Algorithm:
 *   1. Identify the "older" range: everything before the last
 *      `retainMessages` items.
 *   2. Split older items into PRESERVE (verbatim) vs SUMMARIZE (replaceable):
 *        - user messages → preserve
 *        - compaction system summaries        → preserve (recall map + summary drift)
 *        - function_call (tool calls)         → preserve (Codex pairing)
 *        - function_call_result (tool returns) → preserve (Codex pairing)
 *        - assistant/system messages          → summarize
 *        - reasoning                          → drop (we can't replay it
 *                                                  meaningfully anyway)
 *      Note: we KEEP tool_call/result pairs verbatim because dropping
 *      them would break Codex's call_id pairing (codex-model.ts:438).
 *      Layer 1 already shrunk the result.text content; that's where the
 *      token savings come from.
 *   3. Send the summarizable slice (with light context for the
 *      summarizer) to the mini model.
 *   4. Validate returned call_ids against tool_called events.
 *   5. Replace the summarizable items with a single
 *      `{ role: 'system', content: '[summary]...' }` message at their
 *      original position in the array.
 */
export async function summarizeOlderMessages(
  items: AgentInputItem[],
  sessionId: string,
  retainMessages: number = DEFAULT_LAYER2_RETAIN_MESSAGES,
): Promise<{
  applied: boolean;
  removedItems: number;
  summaryItems: number;
  callIdsReferenced: string[];
  hallucinatedCallIds: string[];
  modelUsed: string | null;
  error?: string;
  mutatedItems?: AgentInputItem[];
}> {
  if (items.length <= retainMessages + 2) {
    return { applied: false, removedItems: 0, summaryItems: 0, callIdsReferenced: [], hallucinatedCallIds: [], modelUsed: null };
  }

  const olderEnd = items.length - retainMessages;
  const older = items.slice(0, olderEnd);
  const tail = items.slice(olderEnd);

  // Partition: keep exact state out of the summarizer, summarize only natural
  // language assistant/system context, and drop replay-only reasoning.
  const summarizable: AgentInputItem[] = [];
  for (const item of older) {
    const any = item as Record<string, unknown> & { type?: string; role?: string };
    if (isLayer2PreservedItem(item)) {
      continue;
    }
    if (any.type === 'reasoning') {
      // Drop reasoning — we can't meaningfully replay it and it bloats input.
      continue;
    }
    summarizable.push(item);
  }

  if (summarizable.length === 0) {
    return { applied: false, removedItems: 0, summaryItems: 0, callIdsReferenced: [], hallucinatedCallIds: [], modelUsed: null };
  }

  const serialized = serializeForSummarizer(summarizable);
  const summarizerResult = await runSummarizerTurn(serialized);
  if ('error' in summarizerResult) {
    return {
      applied: false,
      removedItems: 0,
      summaryItems: 0,
      callIdsReferenced: [],
      hallucinatedCallIds: [],
      modelUsed: null,
      error: summarizerResult.error,
    };
  }

  const validIds = listValidCallIdsForSession(sessionId);
  const { sanitized, referenced, hallucinated } = validateCallIdReferences(
    summarizerResult.summary,
    validIds,
  );

  const summaryMessage: AgentInputItem = {
    role: 'system',
    content: `[summary of earlier conversation]\n${sanitized}`,
  } as unknown as AgentInputItem;

  // Reassemble in original order, replacing the first summarizable run with
  // the new summary and preserving exact tool/recall state where it already was.
  const mutatedOlder: AgentInputItem[] = [];
  let insertedSummary = false;
  for (const item of older) {
    const any = item as Record<string, unknown> & { type?: string };
    if (isLayer2PreservedItem(item)) {
      mutatedOlder.push(item);
      continue;
    }
    if (any.type === 'reasoning') {
      continue;
    }
    if (!insertedSummary) {
      mutatedOlder.push(summaryMessage);
      insertedSummary = true;
    }
  }

  const mutated: AgentInputItem[] = [...mutatedOlder, ...tail];

  return {
    applied: true,
    removedItems: summarizable.length,
    summaryItems: 1,
    callIdsReferenced: referenced,
    hallucinatedCallIds: hallucinated,
    modelUsed: summarizerResult.modelUsed,
    mutatedItems: mutated,
  };
}

export interface ForkRequest {
  reason: 'auto_compacted_fork';
  oldSessionId: string;
  /** The summary + user message to seed the new session. */
  seed: { summary: string; lastUserMessage: string | null };
}

/**
 * Layer 3 — fork to a fresh session. We don't actually create the new
 * session here (the channel layer owns session creation and the
 * in-memory channelSessions map). Instead we return a ForkRequest that
 * the loop / channel layer hands off.
 *
 * Importantly, we DO NOT mark the old session `completed` — that would
 * trip the reaper. We leave it `active` and the channel layer writes
 * `auto_compacted_to=<new-id>` metadata.
 */
export function buildForkRequest(
  items: AgentInputItem[],
  sessionId: string,
): ForkRequest {
  // Pull a summary block from the items if Layer 2 already inserted one.
  let summary = '';
  let lastUserMessage: string | null = null;
  for (const item of items) {
    const any = item as Record<string, unknown> & { type?: string; role?: string };
    if (any.role === 'system' && typeof any.content === 'string' && any.content.startsWith('[summary')) {
      summary = any.content as string;
    }
    if (any.role === 'user' && typeof any.content === 'string') {
      lastUserMessage = any.content as string;
    }
  }
  return {
    reason: 'auto_compacted_fork',
    oldSessionId: sessionId,
    seed: { summary, lastUserMessage },
  };
}

/**
 * Main entry. Called from loop.ts BEFORE building the items array for
 * the next runner.run() call. Wraps Layer 1 (always-safe), Layer 2 (LLM
 * call when threshold met), and Layer 3 (fork request).
 *
 * Returns CompactionResult with the new items + change flags. The caller
 * is responsible for persisting via session.recordTurnResult() and acting
 * on `forkRequested`.
 *
 * Mutates `items` in place for Layer 1 (because items are persisted by
 * reference in session.metadata['__conversation']). Layer 2 returns a
 * replacement array.
 */
export async function compactSessionIfNeeded(
  session: HarnessSession,
  items: AgentInputItem[],
  opts: CompactionOptions = {},
): Promise<{ result: CompactionResult; nextItems: AgentInputItem[]; forkRequest?: ForkRequest }> {
  const disable = opts.disable ?? readDisableFlag();
  const budget = opts.inputBudgetTokens ?? DEFAULT_INPUT_BUDGET_TOKENS;
  const itemThreshold = opts.layer1ItemThreshold ?? DEFAULT_LAYER1_ITEM_THRESHOLD;
  const retainTurns = opts.layer1RetainTurns ?? DEFAULT_LAYER1_RETAIN_TURNS;
  const retainToolPairs = opts.layer1RetainToolPairs ?? Math.max(DEFAULT_LAYER1_RETAIN_TOOL_PAIRS, retainTurns * 3);
  const retainMessages = opts.layer2RetainMessages ?? DEFAULT_LAYER2_RETAIN_MESSAGES;
  const l1Frac = opts.layer1TokenFraction ?? DEFAULT_LAYER1_TOKEN_FRACTION;
  const l1ItemMinFrac = opts.layer1ItemTriggerMinFraction ?? DEFAULT_LAYER1_ITEM_TRIGGER_MIN_FRACTION;
  const l2Frac = opts.layer2TokenFraction ?? DEFAULT_LAYER2_TOKEN_FRACTION;
  const l3Frac = opts.layer3TokenFraction ?? DEFAULT_LAYER3_TOKEN_FRACTION;

  const beforeTokens = estimateInputTokens(items);
  const result: CompactionResult = {
    modified: false,
    layer1: { applied: false, clipped: 0, collapsedToolPairs: 0 },
    layer2: { applied: false, removedItems: 0, summaryItems: 0, callIdsReferenced: [], hallucinatedCallIds: [], modelUsed: null },
    layer3: { applied: false, forkRequested: false },
    beforeTokens,
    afterTokens: beforeTokens,
    budgetTokens: budget,
  };

  if (disable === 'off') {
    return { result, nextItems: items };
  }

  let nextItems = items;

  // Layer 1 — fire on genuine token pressure, OR (chatty-turn backstop) on item
  // count BUT ONLY once we're partway to budget. The item-count clause used to
  // be unconditional, which clipped freshly-fetched tool outputs during a
  // multi-tool run while 85-99% of context was free. Token pressure is the real
  // signal; item count only matters when those items are actually filling the
  // window.
  // Returning after a break preserves the same working context. Only
  // context pressure or an explicit stage checkpoint can trigger compaction.
  const layer1Trigger =
    opts.forceLayer2
    || beforeTokens > budget * l1Frac
    || (items.length > itemThreshold && beforeTokens > budget * l1ItemMinFrac);
  if (layer1Trigger) {
    const clipped = clipOldToolResults(nextItems, retainTurns, opts, session.id);
    const collapsed = collapseOldCompletedToolPairs(nextItems, retainToolPairs, session.id);
    nextItems = collapsed.nextItems;
    result.layer1.applied = clipped > 0 || collapsed.collapsed > 0;
    result.layer1.clipped = clipped;
    result.layer1.collapsedToolPairs = collapsed.collapsed;
    if (clipped > 0 || collapsed.collapsed > 0) result.modified = true;
  }

  let postL1Tokens = estimateInputTokens(nextItems);
  result.afterTokens = postL1Tokens;

  // Stop if disabled past Layer 1.
  if (disable === 'layer1_only') {
    if (result.modified) {
      appendCondenserEvent(session.id, result);
    }
    return { result, nextItems };
  }

  // Layer 2
  if (opts.forceLayer2 || postL1Tokens > budget * l2Frac) {
    const l2 = await summarizeOlderMessages(nextItems, session.id, retainMessages);
    result.layer2 = {
      applied: l2.applied,
      removedItems: l2.removedItems,
      summaryItems: l2.summaryItems,
      callIdsReferenced: l2.callIdsReferenced,
      hallucinatedCallIds: l2.hallucinatedCallIds,
      modelUsed: l2.modelUsed,
      error: l2.error,
    };
    if (l2.applied && l2.mutatedItems) {
      nextItems = l2.mutatedItems;
      result.modified = true;
    }
    result.afterTokens = estimateInputTokens(nextItems);
    postL1Tokens = result.afterTokens;
  }

  // A forced stage checkpoint resets in place. Ordinary overflow remains
  // governed by the routed context budget, independent of session age.
  let forkRequest: ForkRequest | undefined;
  if (!opts.forceLayer2 && postL1Tokens > budget * l3Frac) {
    forkRequest = buildForkRequest(nextItems, session.id);
    result.layer3 = { applied: true, forkRequested: true };
  }

  if (result.modified || forkRequest) {
    appendCondenserEvent(session.id, result);
  }

  return { result, nextItems, forkRequest };
}

/**
 * Stage-checkpoint compaction (D2): at a goal stage boundary, force a Layer 1 +
 * Layer 2 pass so the next milestone starts with a lean context instead of
 * dragging the whole prior-stage transcript. The goal's objective + criteria +
 * ledger are re-injected fresh every turn from the store, so the summary
 * carries everything needed. Persists the compacted snapshot. Best-effort:
 * returns the compaction result (or null if disabled / nothing to do / error).
 * Kill-switch CLEMMY_STAGE_CHECKPOINT=off.
 */
export async function checkpointGoalStage(session: HarnessSession): Promise<CompactionResult | null> {
  if ((process.env.CLEMMY_STAGE_CHECKPOINT || 'on').toLowerCase() === 'off') return null;
  try {
    const items = session.toInputItems();
    if (items.length <= 2) return null; // nothing worth checkpointing
    const { result, nextItems } = await compactSessionIfNeeded(session, items, {
      forceLayer2: true,
      // Keep only the last couple of messages live; the rest distills to the
      // summary + the goal ledger.
      layer2RetainMessages: 2,
    });
    if (result.modified) session.updateConversationSnapshot(nextItems);
    return result;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[harness] checkpointGoalStage failed', err instanceof Error ? err.message : err);
    return null;
  }
}

function appendCondenserEvent(sessionId: string, result: CompactionResult): void {
  try {
    appendEvent({
      sessionId,
      turn: 0,
      role: 'system',
      type: 'condenser_applied',
      data: {
        layer1: result.layer1,
        layer2: result.layer2,
        layer3: result.layer3,
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
        budgetTokens: result.budgetTokens,
      },
    });
  } catch {
    // best-effort
  }
}
