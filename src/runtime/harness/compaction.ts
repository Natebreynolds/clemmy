import type { AgentInputItem } from '@openai/agents';
import { Agent, Runner } from '@openai/agents';
import { MODELS } from '../../config.js';
import {
  appendEvent,
  getToolOutput,
  listEvents,
  type EventRow,
} from './eventlog.js';
import { HarnessSession } from './session.js';
import { estimateInputTokens } from './token-estimator.js';

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
 *             via a single Codex turn. Validates call_id references.
 *   Layer 3 — auto-fresh fork when even Layer 1+2 leaves the input above
 *             90% of budget. Returns a "fork to new session" signal so
 *             the channel layer can hand off.
 *
 * Trigger thresholds match the Codex CLI production defaults (180k cap,
 * retain ~20k recent). Defaults are tuned for the harness's 200k input
 * budget — see brackets.ts:331.
 */

// v0.5.22 — tightened all four numbers after sess-mplmvrqu (2026-05-25)
// hit a 1.4MB Codex request body that consistently SSE-truncated. The
// previous defaults were tuned for "stop the worst offenders"; the new
// defaults are tuned for "keep request bodies under Codex's truncation
// cliff." Concrete moves:
//   - Layer 1 trigger 0.5 → 0.3  (clip older tool outputs at 30% of
//     budget instead of waiting for 50%)
//   - Layer 1 retain turns 8 → 4  (keep less raw history; agent can
//     `recall_tool_result(callId)` to re-fetch any clipped output)
//   - Layer 1 item threshold 30 → 15  (kick in earlier on chatty turns)
//   - Layer 2 trigger 0.7 → 0.55 (summarize older messages sooner)
const DEFAULT_LAYER1_ITEM_THRESHOLD = 15;
const DEFAULT_LAYER1_RETAIN_TURNS = 4;
const DEFAULT_LAYER1_RETAIN_TOOL_PAIRS = 12;
const DEFAULT_LAYER2_RETAIN_MESSAGES = 6;
const DEFAULT_LAYER1_TOKEN_FRACTION = 0.3;
const DEFAULT_LAYER2_TOKEN_FRACTION = 0.55;
const DEFAULT_LAYER3_TOKEN_FRACTION = 0.9;
// The item-count trigger (>N input items) is a chatty-turn backstop, but it
// must NOT fire while there is abundant token headroom — otherwise a multi-tool
// run (e.g. researching 10 prospects) clips its freshly-fetched results to
// stubs even at ~12% of budget, throwing away the very data the model needs and
// forcing recall round-trips (observed sess-mpvujlni 2026-06-01: 14 outputs
// clipped at 30K/200K). So the item-count clause only applies once we're at
// least this fraction of budget; below it, ONLY genuine token pressure
// (layer1TokenFraction) triggers Layer 1. Token pressure, not item count, is
// the real signal.
const DEFAULT_LAYER1_ITEM_TRIGGER_MIN_FRACTION = 0.5;
const DEFAULT_INPUT_BUDGET_TOKENS = 200_000;
const COLLAPSED_TOOL_SUMMARY_MAX_CHARS = 12_000;
const COMPACTION_SYSTEM_SUMMARY_PREFIXES = [
  '[summary of older completed tool activity]',
  '[summary of earlier conversation]',
] as const;

type SummarizerTurnResult = { summary: string; modelUsed: string } | { error: string };

let summarizerTurnForTests: ((serializedOlder: string) => Promise<SummarizerTurnResult>) | null = null;

export function _setCompactionSummarizerForTests(
  fn: ((serializedOlder: string) => Promise<SummarizerTurnResult>) | null,
): void {
  summarizerTurnForTests = fn;
}

const CLIP_PLACEHOLDER = (
  toolName: string | null,
  chars: number,
  callId: string,
  iso: string,
): string =>
  `[clipped: ${toolName ?? 'tool'} returned ${chars} chars at ${iso} — call recall_tool_result("${callId}") for full output]`;

// Cheap, fast model for summarization. The fast tier is gpt-5.4-mini (or
// equivalent) — summarization is straightforward and doesn't need the
// primary's reasoning budget.
function getSummarizerModel(): string {
  return MODELS.fast || MODELS.primary || 'gpt-5.4-mini';
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
  /**
   * Age/idle-aware compaction (Phase 4a). Milliseconds since the session's last
   * turn (the caller reads session.lastActivityAt() BEFORE this turn writes
   * back). When the gap exceeds idleCompactionThresholdMs AND the transcript
   * carries real weight (> idleCompactionMinTokens), proactively run Layer 1 +
   * Layer 2 so a stale thread summarizes its old turns instead of dragging the
   * full transcript into the return turn — even when it's below token pressure.
   * Like forceLayer2, it summarizes IN PLACE (no Layer-3 fork). Omitted → no
   * idle trigger (byte-identical to today).
   */
  idleMs?: number;
  idleCompactionThresholdMs?: number;
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

    const output = item.output as { type?: string; text?: string } | string | undefined;
    let originalText = '';
    if (typeof output === 'string') {
      originalText = output;
    } else if (output && typeof output === 'object' && typeof output.text === 'string') {
      originalText = output.text;
    } else {
      continue; // empty output; nothing to clip
    }

    // Skip if the original is already small (clipping doesn't help and
    // adds tokens).
    if (originalText.length < 400) continue;

    // Tool name lives in metadata-ish places; pull from a `name` field
    // if present, otherwise null.
    const toolName = typeof item.name === 'string' ? item.name : null;

    const stub = CLIP_PLACEHOLDER(toolName, originalText.length, callId, iso);
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
    return getToolOutput(sessionId, callId) != null;
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
}

function collapsedPairLine(pair: CompletedToolPair): string {
  const args = pair.args ? oneLine(pair.args, 180) : '{}';
  const clippedMarker = pair.resultText.match(/\[clipped:[^\]]*recall_tool_result\("[^"]+"\)[^\]]*\]/)?.[0];
  const result = clippedMarker ?? oneLine(pair.resultText, 220);
  return `- ${pair.name} [${pair.callId}] args: ${args}; result: ${result || '(empty)'} [clipped: ${pair.name} collapsed before this turn - call recall_tool_result("${pair.callId}") for full output]`;
}

function buildCollapsedToolPairsSummary(pairs: CompletedToolPair[]): AgentInputItem {
  const lines: string[] = [
    '[summary of older completed tool activity]',
    `${pairs.length} older completed tool call/result pairs were collapsed before this turn to keep the first model request small. Recent tool calls remain verbatim. Exact older outputs remain available with recall_tool_result("call_id").`,
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
  const calls = new Map<string, { index: number; item: Record<string, unknown> }>();
  const results = new Map<string, { index: number; item: Record<string, unknown> }>();
  const resultOrder: string[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>;
    const callId = typeof item.callId === 'string' ? item.callId : null;
    if (!callId) continue;
    if (item.type === 'function_call' && !calls.has(callId)) {
      calls.set(callId, { index: i, item });
    } else if (item.type === 'function_call_result' && !results.has(callId)) {
      results.set(callId, { index: i, item });
      resultOrder.push(callId);
    }
  }

  const completedIds = resultOrder.filter((callId) => calls.has(callId));
  if (completedIds.length <= normalizedRetain) {
    return { nextItems: items, collapsed: 0, callIds: [] };
  }

  const keepIds = new Set(completedIds.slice(-normalizedRetain));
  const pairs: CompletedToolPair[] = [];
  for (const callId of completedIds) {
    if (keepIds.has(callId)) continue;
    const call = calls.get(callId);
    const result = results.get(callId);
    if (!call || !result) continue;
    if (call.index > result.index) continue;
    if (!recallableToolOutputExists(sessionId, callId)) continue;

    pairs.push({
      callId,
      callIndex: call.index,
      resultIndex: result.index,
      name: typeof call.item.name === 'string' ? call.item.name : 'tool',
      args: typeof call.item.arguments === 'string' ? call.item.arguments : '',
      resultText: outputTextOf(result.item),
    });
  }

  if (pairs.length === 0) return { nextItems: items, collapsed: 0, callIds: [] };

  const collapseIds = new Set(pairs.map((pair) => pair.callId));
  const summary = buildCollapsedToolPairsSummary(pairs);
  const nextItems: AgentInputItem[] = [];
  let inserted = false;

  for (const item of items) {
    const any = item as Record<string, unknown>;
    const callId = typeof any.callId === 'string' ? any.callId : null;
    const shouldCollapse = callId != null
      && collapseIds.has(callId)
      && (any.type === 'function_call' || any.type === 'function_call_result');

    if (shouldCollapse) {
      if (!inserted) {
        nextItems.push(summary);
        inserted = true;
      }
      continue;
    }
    nextItems.push(item);
  }

  return {
    nextItems,
    collapsed: pairs.length,
    callIds: pairs.map((pair) => pair.callId),
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
 * Run a single summarization turn against the cheap mini model. Returns
 * the bullet-summary text, or null on failure. Failures are non-fatal
 * for the outer compaction loop — Layer 2 is best-effort, and Layer 3
 * can still take over if needed.
 */
async function runSummarizerTurn(serializedOlder: string): Promise<SummarizerTurnResult> {
  if (summarizerTurnForTests) return summarizerTurnForTests(serializedOlder);

  const model = getSummarizerModel();
  try {
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
    return { summary: text.trim(), modelUsed: model };
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
  // Age/idle trigger (Phase 4a): a long-idle thread with real weight proactively
  // summarizes so the return turn isn't dragged by the full stale transcript.
  // Disabled by CLEMMY_IDLE_COMPACT=off. Default threshold 30 min idle, 6k tokens.
  const idleDisabled = (process.env.CLEMMY_IDLE_COMPACT ?? 'on').toLowerCase() === 'off';
  const idleThresholdMs = opts.idleCompactionThresholdMs ?? 30 * 60 * 1000;
  const idleMinTokens = opts.idleCompactionMinTokens ?? 6000;
  const idleTrigger =
    !idleDisabled
    && typeof opts.idleMs === 'number'
    && opts.idleMs > idleThresholdMs
    && beforeTokens > idleMinTokens;

  const layer1Trigger =
    opts.forceLayer2
    || idleTrigger
    || beforeTokens > budget * l1Frac
    || (items.length > itemThreshold && beforeTokens > budget * l1ItemMinFrac);
  if (layer1Trigger) {
    const clipped = clipOldToolResults(nextItems, retainTurns, opts);
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
  if (opts.forceLayer2 || idleTrigger || postL1Tokens > budget * l2Frac) {
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

  // Layer 3 — fork. Suppressed during a forced stage checkpoint OR an idle
  // summarize: those passes reset IN PLACE, so we never also recommend a session
  // fork on the same pass (idle summarizing shouldn't yank the user into a new
  // session; if it's still huge, the next active turn's token pressure forks).
  let forkRequest: ForkRequest | undefined;
  if (!opts.forceLayer2 && !idleTrigger && postL1Tokens > budget * l3Frac) {
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
