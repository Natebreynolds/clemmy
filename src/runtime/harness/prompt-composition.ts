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
import { CACHE_BREAK_SENTINEL, splitCacheDynamicContext, splitCacheDynamicLayers } from './model-wire-registry.js';
import { MEMORY_CONTEXT_SECTION_TITLES } from '../../agents/memory-context-sections.js';
import { createHash } from 'node:crypto';
import { appendEvent } from './eventlog.js';
import { serializeAdvertisedTools, toolsOnAdvertisedWire, type AdvertisableTool } from './advertised-tool-wire.js';

export interface ToolSchemaCost {
  name: string;
  tokens: number;
  bytes?: number;
  deferred: boolean;
}

/** Measure one advertised schema entry as the provider adapters receive it:
 *  name, description, compacted parameters and the strict flag. Never include
 *  schema contents in telemetry. */
function measureAdvertisedEntry(raw: unknown): ToolSchemaCost {
  const tool = (raw ?? {}) as Record<string, unknown>;
  const name = typeof tool.name === 'string' ? tool.name : String(tool.type ?? 'unnamed');
  try {
    const serialized = JSON.stringify({
      type: tool.type, name: tool.name, description: tool.description,
      parameters: tool.parameters, strict: tool.strict,
    });
    return { name, deferred: false, tokens: estimateTokens(serialized), bytes: Buffer.byteLength(serialized) };
  } catch {
    return { name, deferred: false, tokens: 50 };
  }
}

function summarizeToolCosts(costs: ToolSchemaCost[]) {
  const sent = costs.filter((cost) => !cost.deferred);
  return {
    toolNames: sent.map((cost) => cost.name),
    measuredToolSchemaTokens: sent.reduce((sum, cost) => sum + cost.tokens, 0),
    // Nothing about a deferred tool is sent: its schema is off the wire and it
    // is not listed in the names-only catalog either. An index bucket is only
    // non-zero for a caller that measured index text it actually sends.
    deferredToolIndexTokens: 0,
    toolSchemaCosts: costs,
  };
}

/** Measure the exact schemas one request advertises (the host runner's wire,
 *  already compacted, already without the tools it left off). */
export function measureAdvertisedToolSurface(wire: readonly unknown[]) {
  return summarizeToolCosts(wire.map(measureAdvertisedEntry));
}

/** Measure an agent's tools as the host runner would advertise them: a
 *  deferLoading tool left off the wire costs nothing, and every schema is
 *  measured on the compacted projection the runner sends. For callers that
 *  do not have the runner's per-request wire in hand. `compactionBudgetTokens`
 *  is the in-flight compaction and archive budget's own estimate of the same
 *  tools (see estimateAgentToolBudgetTokens), never the meter's reading. */
export function measureToolPromptSurface(tools: readonly unknown[]) {
  const named = tools.map((raw) => (raw ?? {}) as AdvertisableTool);
  const onWire = new Set(toolsOnAdvertisedWire(named));
  const costs = named.map((tool): ToolSchemaCost => {
    if (!onWire.has(tool)) return { name: tool.name, deferred: true, tokens: 0, bytes: 0 };
    try {
      return measureAdvertisedEntry(serializeAdvertisedTools([tool])[0]);
    } catch {
      return { name: typeof tool.name === 'string' ? tool.name : 'unnamed', deferred: false, tokens: 50 };
    }
  });
  return { ...summarizeToolCosts(costs), compactionBudgetTokens: estimateAgentToolBudgetTokens(tools) };
}

/** The in-flight compaction and archive budget's estimate of an agent's
 *  tools: every schema on its raw JSON, and each deferLoading tool's name and
 *  description as an index entry whether or not the runner sends it. This is
 *  the budget's own reading, kept apart from the meter's advertised-wire
 *  measurement so that correcting the meter never moves when history is
 *  compacted or archived. */
function estimateAgentToolBudgetTokens(tools: readonly unknown[]): number {
  let total = 0;
  for (const raw of tools) {
    const tool = (raw ?? {}) as Record<string, unknown>;
    const deferred = tool.deferLoading === true;
    try {
      total += estimateTokens(JSON.stringify({
        type: tool.type, name: tool.name, description: tool.description,
        ...(!deferred ? { parameters: tool.parameters, strict: tool.strict } : {}),
      }));
    } catch {
      total += 50;
    }
  }
  return total;
}

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
  /** memoryContext only: size of each rendered memory section, keyed by its
   *  heading (never its contents). "(header)" is the preamble before the
   *  first section; "(appended)" is memory text appended after the context. */
  sections?: Record<string, { bytes: number; tokens: number }>;
}

export interface PromptCompositionSummary {
  toolSchemaCosts?: readonly ToolSchemaCost[];
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
  toolSchemaCosts?: readonly ToolSchemaCost[];
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
  /** The per-turn memory primer the host appends as its own input item. */
  memoryPrimer?: string;
  /** Proven-operation guidance the host appends as its own input item. */
  provenOperation?: string;
  /** Retry context the host appends after an interrupted call. */
  retryContext?: string;
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
   *  rather than one string. Wins over estimating the history string. It
   *  excludes every item measured as its own bucket (the current message and
   *  the appended packet, primer, proven operation and retry context). */
  measuredHistoryTokens?: number;
  /** MEASURED tokens for text that rides as its own input item, item framing
   *  included. Wins over estimating the text, which still supplies the
   *  bucket's bytes and digest. */
  measuredItemTokens?: Partial<Record<
    'contextPacket' | 'currentMessage' | 'memoryPrimer' | 'provenOperation' | 'retryContext',
    number
  >>;
}

/** Split a rendered memory context into its sections (heading -> size). */
export function memoryContextSections(
  memoryContext: string,
  appendedMemory = '',
): Record<string, { bytes: number; tokens: number }> {
  const sections: Record<string, { bytes: number; tokens: number }> = {};
  const add = (heading: string, text: string): void => {
    if (!text) return;
    const current = sections[heading] ?? { bytes: 0, tokens: 0 };
    current.bytes += Buffer.byteLength(text, 'utf8');
    current.tokens += estimateTokens(text);
    sections[heading] = current;
  };
  const titles = new Set(MEMORY_CONTEXT_SECTION_TITLES);
  const blocks = memoryContext ? memoryContext.split('\n\n') : [];
  let heading = '(header)';
  let buffer: string[] = [];
  // Each block keeps the separator that follows it, so the sections' bytes
  // add up to the rendered context exactly.
  const flush = (): void => { add(heading, buffer.join('')); buffer = []; };
  blocks.forEach((block, index) => {
    const firstLine = block.split('\n', 1)[0] ?? '';
    const title = firstLine.startsWith('## ') ? firstLine.slice(3) : '';
    if (title && titles.has(title)) {
      flush();
      heading = title;
    }
    buffer.push(index < blocks.length - 1 ? `${block}\n\n` : block);
  });
  flush();
  add('(appended)', memoryContext && appendedMemory ? `\n\n${appendedMemory}` : appendedMemory);
  return sections;
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
  const dynamicInstructions = sentinelAt >= 0
    ? instructionsText.slice(sentinelAt + CACHE_BREAK_SENTINEL.length)
    : '';
  const dynamicLayers = splitCacheDynamicContext(dynamicInstructions);
  const memoryLayers = splitCacheDynamicLayers(dynamicInstructions);
  const measuredTools = Number.isFinite(input.measuredToolSchemaTokens)
    ? Math.max(0, Math.trunc(input.measuredToolSchemaTokens as number))
    : null;
  const measuredHistory = Number.isFinite(input.measuredHistoryTokens)
    ? Math.max(0, Math.trunc(input.measuredHistoryTokens as number))
    : null;
  const deferredIndex = Number.isFinite(input.deferredToolIndexTokens)
    ? Math.max(0, Math.trunc(input.deferredToolIndexTokens as number))
    : 0;
  const itemTokens = (name: keyof NonNullable<PromptCompositionInput['measuredItemTokens']>, text: string): number => {
    const measured = input.measuredItemTokens?.[name];
    return Number.isFinite(measured) ? Math.max(0, Math.trunc(measured as number)) : estimateTokens(text);
  };
  const raw: Array<[string, number, PromptBucketStability, string | null]> = [
    // STABLE: same bytes every turn for a given session, so the provider keeps
    // them warm. Large is FINE here — that is the whole point of the split.
    ['instructions', estimateTokens(staticInstructions), 'stable', staticInstructions],
    ['turnContext', estimateTokens(dynamicLayers.turnContext), 'variable', dynamicLayers.turnContext],
    ['memoryContext', estimateTokens(dynamicLayers.memoryContext), 'variable', dynamicLayers.memoryContext],
    // The measured serialized schemas win; the names x 120 guess is only for
    // callers that never had the real schemas in hand.
    ['toolSchemas', measuredTools ?? toolNames.length * perSchema, 'stable', null],
    ['deferredToolIndex', deferredIndex, 'stable', null],
    // History is a stable PREFIX in principle (it only appends) but any change
    // upstream of it re-pays the lot, so it is scored with the variable side
    // where it will be noticed.
    ['history', measuredHistory ?? estimateTokens(input.history ?? ''), 'variable', measuredHistory !== null ? null : input.history ?? ''],
    ['contextPacket', itemTokens('contextPacket', input.contextPacket ?? ''), 'variable', input.contextPacket ?? ''],
    ['memoryPrimer', itemTokens('memoryPrimer', input.memoryPrimer ?? ''), 'variable', input.memoryPrimer ?? ''],
    ['provenOperation', itemTokens('provenOperation', input.provenOperation ?? ''), 'variable', input.provenOperation ?? ''],
    ['retryContext', itemTokens('retryContext', input.retryContext ?? ''), 'variable', input.retryContext ?? ''],
    ['currentMessage', itemTokens('currentMessage', input.currentMessage ?? ''), 'variable', input.currentMessage ?? ''],
    ['outputSchema', estimateTokens(input.outputSchema ?? ''), 'variable', input.outputSchema ?? ''],
  ];

  const buckets = raw
    .filter(([, tokens]) => tokens > 0)
    .map(([name, tokens, stability, text]) => ({
      name,
      tokens,
      stability,
      ...(text !== null ? digest(text) : {}),
      ...(name === 'memoryContext'
        ? { sections: memoryContextSections(memoryLayers.memoryContext, memoryLayers.appendedMemory) }
        : {}),
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
    ...(input.toolSchemaCosts ? { toolSchemaCosts: input.toolSchemaCosts } : {}),
  };
}

/** The ledger's per-request prompt components, read from the same summary
 *  the composition event records (bucket name -> estimated tokens). */
export function promptComponentsFromComposition(summary: PromptCompositionSummary): Record<string, number> {
  return Object.fromEntries(summary.buckets.map((bucket) => [bucket.name, bucket.tokens]));
}

/** Which model request a reading describes. */
export interface PromptCompositionRequest {
  /** 1-based position of this request within its accepted source; equals the
   *  request's model_request_provenance ordinal where the host records one. */
  requestOrdinal?: number;
  /** The model the request was composed for (the routed id, not proof of
   *  which model served it; the usage ledger holds that). */
  model?: string;
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
  request: PromptCompositionRequest = {},
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
        ...(summary.toolSchemaCosts ? { toolSchemaCosts: summary.toolSchemaCosts } : {}),
        buckets: summary.buckets,
        ...(Number.isSafeInteger(sourceUserSeq) && (sourceUserSeq ?? 0) > 0 ? { sourceUserSeq } : {}),
        ...(Number.isSafeInteger(request.requestOrdinal) && (request.requestOrdinal ?? 0) > 0
          ? { requestOrdinal: request.requestOrdinal }
          : {}),
        ...(request.model ? { model: request.model } : {}),
      },
    });
  } catch { /* telemetry never breaks a turn */ }
}
