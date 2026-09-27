import { createHash } from 'node:crypto';
import { getToolOutputForInvocation, writeToolOutput } from './eventlog.js';
import { retainedResultWayThrough } from './retained-result-routes.js';
import { getToolOutputContext } from './tool-output-context.js';
import { compactStructuredJsonToolOutput, digestToolOutput } from './tool-output-digest.js';
import { actionTopologyRoleForRuntimeCall, unwrapRuntimeEffectiveToolIdentity } from './tool-effect.js';
import { effectiveContextWindow } from './model-window-observations.js';
import { toolReadsRetainedOutput } from '../../tools/tool-registry.js';

// One whole inline result: 20K (~5K tokens) passes typical single-screen
// results whole, so the model does not spend a follow-up read on data it was
// about to need, while genuinely huge outputs still digest and stay
// recoverable. Context pressure is owned by compaction, budgeted from the
// routed model's real window (compactionBudgetForModel).
export const DEFAULT_TOOL_RESULT_MAX_CHARS = 20_000;
/** When the full payload is parked for recall, the prompt keeps a smaller
 *  field/index view plus a source reference instead of re-reading the dump. */
export const PROMPT_INLINE_RECALLABLE_RESULT_CHARS = 4_000;

/** These local readers already validate max_chars and format their preview.
 * The outer bracket must not silently impose its smaller default afterwards.
 * Smaller previews remain the handler's responsibility; unrelated tools do
 * not gain a larger result budget from an arbitrary argument of this name. */
export function explicitLocalReadPreviewBudget(toolName: string, args: unknown): number | undefined {
  if (!['read_file', 'convert_to_markdown'].includes(toolName)
    || !args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const requested = (args as Record<string, unknown>).max_chars;
  return typeof requested === 'number' && Number.isSafeInteger(requested)
    && requested > DEFAULT_TOOL_RESULT_MAX_CHARS ? requested : undefined;
}

/** Inline characters one result may take per token of the routed model's
 * context window: about a tenth of the window at ~3.5 characters per token.
 * Every window of 57,143 tokens or more keeps the full
 * DEFAULT_TOOL_RESULT_MAX_CHARS; a small window scales down, never below
 * PROMPT_INLINE_RECALLABLE_RESULT_CHARS, and a large window never scales up
 * (per-round prefill is paid in absolute bytes). */
const INLINE_RESULT_CHARS_PER_WINDOW_TOKEN = 0.35;

/** The routed model's context window in tokens, or null when there is no
 * routed model or its window is unknowable. Without a routed model the model
 * registry is not asked to resolve (and warn about) an absent id on every
 * tool result. */
function routedWindowTokens(routedModelId?: string | null): number | null {
  if (!routedModelId?.trim()) return null;
  try {
    const window = effectiveContextWindow(routedModelId);
    return Number.isFinite(window) && window > 0 ? window : null;
  } catch {
    return null;
  }
}

/** The whole-result inline budget for the routed model's window. Without a
 * routed model the tuned default applies. */
export function inlineResultBudgetForModel(routedModelId?: string | null): number {
  const window = routedWindowTokens(routedModelId);
  if (window === null) return DEFAULT_TOOL_RESULT_MAX_CHARS;
  return Math.max(
    PROMPT_INLINE_RECALLABLE_RESULT_CHARS,
    Math.min(DEFAULT_TOOL_RESULT_MAX_CHARS, Math.floor(window * INLINE_RESULT_CHARS_PER_WINDOW_TOKEN)),
  );
}

/** The largest slice a retained-output reader's schema admits (the static
 * recall_tool_result max_chars bound, so the tool contract never churns per
 * model). What a reader actually returns is retainedReaderMaxChars. */
export const RETAINED_OUTPUT_READER_MAX_SLICE_CHARS = 120_000;
/** Room for a reader's header and paging line around its slice. */
const RETAINED_OUTPUT_READER_FRAME_CHARS = 2_000;

/**
 * The most characters one tool reply may carry across the Claude CLI's MCP
 * wire. The CLI measures an MCP tool reply against its own output-token cap
 * (MAX_MCP_OUTPUT_TOKENS, default 25,000 tokens); a reply over the cap is cut
 * to 4 characters per token of that cap (100,000 characters) and marked
 * truncated, so a longer reply loses its tail after the reply's own paging
 * frame already named the next offset. A reply at or under this bound is
 * never cut. Dense text (CJK, base64, id-heavy JSON) can still exceed the
 * token cap at this length, and then the CLI appends its truncation notice
 * to a reply that lost nothing; the reply's own paging line stays accurate.
 */
export const MCP_TRANSPORT_MAX_CHARS = 60_000;

/** Reader characters per token of the routed window: at the 200,000-token
 * baseline every earlier reader bound was tuned against, this is the query
 * page bound; a smaller window shrinks it. */
const RETAINED_READER_CHARS_PER_WINDOW_TOKEN = 0.25;
const BASELINE_WINDOW_TOKENS = 200_000;

/**
 * The most one retained-output reader reply (a recall slice, a query page)
 * holds for the routed window, frame excluded. It never exceeds what the
 * window can take (a quarter character per window token, never below one
 * inline result), the reader schema bound, or what the MCP wire carries whole.
 * recall_tool_result and tool_output_query bound their own replies by this,
 * and presentation budgets every retained-output reader by this plus the
 * frame, so presentation never re-clips those replies. A file_query reply
 * larger than this bound (many passages on a small window) is shown as a
 * recallable view like any other oversized result.
 */
export function retainedReaderMaxChars(routedModelId?: string | null): number {
  const window = routedWindowTokens(routedModelId) ?? BASELINE_WINDOW_TOKENS;
  return Math.min(
    RETAINED_OUTPUT_READER_MAX_SLICE_CHARS,
    MCP_TRANSPORT_MAX_CHARS - RETAINED_OUTPUT_READER_FRAME_CHARS,
    Math.max(inlineResultBudgetForModel(routedModelId), Math.floor(window * RETAINED_READER_CHARS_PER_WINDOW_TOKEN)),
  );
}

export interface PresentationBudgetInput {
  /** The name the model called: a tool, or a carrier naming its inner tool. */
  toolName: string;
  /** The arguments of that call (a carrier's envelope for a carrier). */
  args?: unknown;
  /** The model the result is presented to. */
  routedModelId?: string | null;
}

/**
 * The one inline presentation budget for a tool result.
 *
 * It keys on the EFFECTIVE inner tool, resolved by the canonical carrier
 * unwrapping, never on the carrier the call travelled through. A carrier and
 * the child it dispatches therefore resolve the same number, so the carrier
 * passes the child's presentation through instead of digesting it again, and
 * an inner tool is shown exactly as it would be when called directly.
 *
 * - A local reader's explicit larger preview request is honored.
 * - A retained-output reader (recall_tool_result, tool_output_query,
 *   file_query) bounds its own reply by retainedReaderMaxChars for the routed
 *   window; presentation allows that plus the reader's frame, so it never
 *   clips a reader's reply again. Per-turn reading stays governed by the
 *   RecallBudget.
 * - A registry control read (Clementine's own state and control tools) is
 *   shown whole up to the routed window's inline budget.
 * - Everything else (provider and business results, foreign tools) keeps the
 *   recallable keyhole: a bounded view plus the parked full payload.
 */
export function presentationBudgetFor(input: PresentationBudgetInput): number {
  let effectiveName: string | null = null;
  let effectiveArgs: unknown = input.args;
  let role: 'control' | 'business' = 'business';
  try {
    const effective = unwrapRuntimeEffectiveToolIdentity(input.toolName, input.args);
    effectiveName = effective.toolName;
    effectiveArgs = effective.args;
    role = actionTopologyRoleForRuntimeCall(input.toolName, input.args);
  } catch {
    // An unreadable identity presents like an unknown tool: the keyhole.
  }
  if (effectiveName) {
    const explicitRead = explicitLocalReadPreviewBudget(effectiveName, effectiveArgs);
    if (explicitRead !== undefined) return explicitRead;
  }
  if (role !== 'control') return PROMPT_INLINE_RECALLABLE_RESULT_CHARS;
  if (effectiveName && toolReadsRetainedOutput(effectiveName)) {
    return retainedReaderMaxChars(input.routedModelId) + RETAINED_OUTPUT_READER_FRAME_CHARS;
  }
  return inlineResultBudgetForModel(input.routedModelId);
}

/**
 * The bound a reviewer's view of a settled result uses: the answerer's own
 * presentation budget from the same resolver (tool, arguments, routed window),
 * so a result the window clipped is never shown to a reviewer as whole. A
 * result presented through the recallable keyhole had its exact bytes parked
 * for the answerer's next read, so its reviewer view keeps one whole inline
 * result for the same window rather than the keyhole alone.
 */
export function answererViewBudgetFor(input: PresentationBudgetInput): number {
  return Math.max(presentationBudgetFor(input), inlineResultBudgetForModel(input.routedModelId));
}

/**
 * The bound an outer transport applies to a result its invocation already
 * presented: a carrier's MCP wire, or the host lane's model projection.
 *
 * The invocation's own presentation budget (the same resolver) bounded the
 * result, so a transport is a backstop only. It never cuts below that budget,
 * or it would clip a slice the reader shaped whole and whose paging frame
 * names offsets the model would then silently skip.
 */
export function transportPresentationMaxChars(input: PresentationBudgetInput): number {
  return Math.max(DEFAULT_TOOL_RESULT_MAX_CHARS, presentationBudgetFor(input));
}

/**
 * The same transport bound for a carrier reply that crosses the Claude CLI's
 * MCP wire, never above what that wire carries whole. A reply the invocation
 * presented larger (an explicit local read preview) is cut here, with this
 * formatter's own truthful marker, instead of silently by the CLI.
 */
export function mcpTransportPresentationMaxChars(input: PresentationBudgetInput): number {
  return Math.min(MCP_TRANSPORT_MAX_CHARS, transportPresentationMaxChars(input));
}


// Host commentary explains a provider result; it never displaces it. The
// annotation block receives at most this share of the result budget, each note
// shortened within it, and the provider result keeps the remainder.
const HOST_ANNOTATION_BUDGET_SHARE = 0.25;
const HOST_ANNOTATION_SHORTENED = '…[host annotation shortened]';

export function boundHostAnnotations(notes: readonly string[], maxChars: number): string[] {
  const budget = Math.max(0, Math.floor(maxChars * HOST_ANNOTATION_BUDGET_SHARE));
  const bounded: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const note of notes) {
    const remaining = budget - used;
    if (note.length + 1 <= remaining) {
      bounded.push(note);
      used += note.length + 1;
    } else if (remaining > HOST_ANNOTATION_SHORTENED.length * 3) {
      const shortened = `${note.slice(0, remaining - HOST_ANNOTATION_SHORTENED.length - 1)}${HOST_ANNOTATION_SHORTENED}`;
      bounded.push(shortened);
      used += shortened.length + 1;
    } else {
      omitted += 1;
    }
  }
  if (omitted > 0) bounded.push(`[${omitted} more host annotation${omitted === 1 ? '' : 's'} omitted]`);
  return bounded;
}

export interface RecallableToolTextOptions {
  maxChars?: number;
  toolName?: string | null;
  sessionId?: string;
  callId?: string;
  /** Host commentary, separate from the provider payload and its raw receipt. */
  hostAnnotations?: readonly string[];
  /** A projection the handler itself already formatted from this invocation's
   * exact bytes is kept whole up to this many characters, and re-rendered from
   * those bytes at this budget above it, even when `maxChars` is smaller. Only
   * a direct call's bracket passes it: a nested or batch child keeps the view
   * its carrier or runner presents. */
  verifiedProjectionMaxChars?: number;
}

const EXACT_OUTPUT_RECEIPT_RE = /\[exact-output-receipt:v1 nonce=([0-9a-f-]{36}) sha256=([0-9a-f]{64})\]/ig;

function exactOutputSha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Host-authored typed result for an invocation whose exact output could not
 * be persisted losslessly. This is an execution outcome, not provider prose:
 * callers may narrow/page and retry, but no consumer may treat the stored
 * prefix as business evidence. */
export class TruncatedToolOutputResult {
  readonly ok = false as const;
  readonly error_kind = 'truncated_tool_output' as const;
  readonly truncated_at_write = true as const;
  readonly error: string;

  constructor(
    readonly result_handle: string,
    readonly content_bytes: number,
  ) {
    this.error = `Tool result "${this.result_handle}" is incomplete (${this.content_bytes} original bytes; legacy truncation or missing/corrupt durable chunks), so the stored prefix cannot be used as evidence. Re-read/page the source with a narrower scope, or stage the full result as a file and read that artifact.`;
  }
}

export function truncatedToolOutputResult(
  callId: string,
  contentBytes: number,
): TruncatedToolOutputResult {
  return new TruncatedToolOutputResult(callId, contentBytes);
}

/** Verify that the compact result returned by THIS invocation names the exact
 * bytes in the lossless store. The nonce is minted outside provider code and
 * inherited through nested tool-output contexts; call ids alone are reusable. */
export function compactResultProvesExactToolOutput(
  compactResult: unknown,
  exactOutput: string,
  expectedNonce: string | undefined,
): boolean {
  if (!expectedNonce || typeof compactResult !== 'string') return false;
  const expectedHash = exactOutputSha256(exactOutput);
  return [...compactResult.matchAll(EXACT_OUTPUT_RECEIPT_RE)].some((match) =>
    match[1] === expectedNonce && match[2]?.toLowerCase() === expectedHash);
}

/** Resolve model-facing compact output back to the exact bytes parked by this
 * SAME invocation. Tool + nonce + hash must all agree; otherwise the compact
 * value is returned unchanged and downstream evidence stays conservative. */
export function exactToolOutputForInvocation(input: {
  sessionId: string | undefined;
  callId: string | undefined;
  toolName: string;
  compactResult: unknown;
  settlementNonce: string | undefined;
}): unknown {
  if (!input.sessionId || !input.callId || !input.settlementNonce) return input.compactResult;
  try {
    const stored = getToolOutputForInvocation(
      input.sessionId,
      input.callId,
      input.settlementNonce,
    );
    if (
      stored
      && stored.tool === input.toolName
      && stored.truncatedAtWrite
    ) {
      return truncatedToolOutputResult(input.callId, stored.contentBytes);
    }
    if (
      stored
      && stored.tool === input.toolName
      && !stored.truncatedAtWrite
      && stored.output.trim()
      && compactResultProvesExactToolOutput(
        input.compactResult,
        stored.output,
        input.settlementNonce,
      )
    ) return stored.output;
  } catch { /* compact result remains the fail-closed fallback */ }
  return input.compactResult;
}

const NARROWER_SCOPE_HINT = 're-call with a narrower scope (offset/limit, filter, specific query) if you need the rest';

function omittedMarker(omitted: number, total: number): string {
  return `…[truncated — ${omitted.toLocaleString()} of ${total.toLocaleString()} chars omitted; ${NARROWER_SCOPE_HINT}]`;
}

/**
 * HEAD-budget clip: `maxChars` is the budget for the CONTENT head, and the
 * truncation marker is appended beyond it. Callers that hand the model a
 * plain (non-recallable) result rely on the first `maxChars` characters being
 * the untouched head of the text (src/tools/shared.test.ts pins this), so the
 * marker never eats into the content budget here. When the whole visible
 * result must stay within a hard cap, use `truncateToolTextWithin`.
 */
export function truncateToolText(text: string, maxChars: number = DEFAULT_TOOL_RESULT_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  return `${head}\n\n${omittedMarker(text.length - maxChars, text.length)}`;
}

/**
 * TOTAL-bounded clip: the returned string (head + marker) never exceeds
 * `maxChars`. formatRecallableToolText composes several pieces (id index,
 * digest body, recovery line, exact-output receipt) inside ONE visible budget,
 * so each piece has to be bounded as a whole or the sum escapes the cap. The
 * marker stays truthful about how many characters were dropped; when even the
 * full marker cannot fit, a shorter total-only marker is used, and when not
 * even that fits the marker itself is cut.
 */
function truncateToolTextWithin(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  // Size the marker with the largest possible omitted count (the full length)
  // so the digits of the real count can never push the result past the cap.
  const widestMarker = omittedMarker(text.length, text.length);
  if (widestMarker.length + 2 < maxChars) {
    const headLength = maxChars - widestMarker.length - 2;
    return `${text.slice(0, headLength)}\n\n${omittedMarker(text.length - headLength, text.length)}`;
  }
  const shortMarker = `…[truncated — ${text.length.toLocaleString()} total chars]`;
  if (shortMarker.length >= maxChars) return shortMarker.slice(0, Math.max(0, maxChars));
  const headLength = Math.max(0, maxChars - shortMarker.length - 2);
  return `${text.slice(0, headLength)}\n\n${shortMarker}`;
}

// Keys whose array value is a list of ADDRESSABLE resources the model targets
// by id in a follow-up call (tables, sheets, databases, objects, …). Used to
// preserve ids through digest/clip. `records`/`rows`/`value` are excluded —
// those are bulk DATA rows, not addressable schema, and would add noise.
const RESOURCE_LIST_KEYS = new Set([
  'tables', 'items', 'results', 'views', 'bases', 'databases', 'sheets',
  'objects', 'files', 'list', 'entries', 'channels', 'repositories', 'projects', 'boards',
]);
const MAX_INDEX_PAIRS = 40;
const MAX_ITEMS_SCANNED = 600;

/**
 * GLOBAL root-cause fix: a large tool result that LISTS addressable resources
 * (a base's tables, a workspace's sheets/objects/files, …) gets digested/clipped
 * for the context window — and the digest summarizes the list to `array(N)`,
 * DROPPING the very ids the model needs to make the next call. The model then
 * can't target the resource, guesses an id/name, gets NOT_FOUND, re-discovers,
 * and loops into the tool-call guardrail. This affects EVERY tool that returns
 * id-keyed lists (Composio, native MCP, local), because they all format through
 * here. So: extract a compact `id = name` index and surface it ABOVE the
 * clipped body, uncllipped, so discovery always yields usable ids.
 */
export function extractResourceIdIndex(text: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return ''; }
  const arrays: Record<string, unknown>[] = [];
  let scanned = 0;
  const visit = (node: unknown, depth: number): void => {
    if (depth > 4 || !node || typeof node !== 'object' || arrays.length > MAX_ITEMS_SCANNED) return;
    if (Array.isArray(node)) return; // arrays are only harvested via a resource-list key
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (Array.isArray(v) && RESOURCE_LIST_KEYS.has(k.toLowerCase())) {
        for (const it of v) {
          if (++scanned > MAX_ITEMS_SCANNED) break;
          if (it && typeof it === 'object' && !Array.isArray(it)) arrays.push(it as Record<string, unknown>);
        }
      } else if (v && typeof v === 'object') {
        visit(v, depth + 1);
      }
    }
  };
  visit(parsed, 0);
  const pairs: string[] = [];
  const seen = new Set<string>();
  for (const o of arrays) {
    const id = typeof o.id === 'string' ? o.id
      : typeof o.key === 'string' ? o.key
      : typeof o.gid === 'string' ? o.gid
      : typeof o.slug === 'string' ? o.slug : '';
    const name = typeof o.name === 'string' ? o.name
      : typeof o.title === 'string' ? o.title
      : typeof o.displayName === 'string' ? o.displayName : '';
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    pairs.push(`${id} = ${name}`);
    if (pairs.length >= MAX_INDEX_PAIRS) break;
  }
  if (pairs.length === 0) return '';
  return `📋 IDs available in this result (use these EXACT ids in follow-up calls — do NOT guess names):\n  ${pairs.join('\n  ')}`;
}

/**
 * Canonical model-facing tool-output formatter.
 *
 * If a harness session + call id is available, this stores the full
 * output in `tool_outputs` before returning a small prompt-safe stub
 * that tells the model exactly how to recover the original with
 * `recall_tool_result`. Without call context it falls back to a plain
 * truncation marker, which is the best a detached MCP/dev path can do.
 */
// ─── Scrape-head densifier ───
// Scraped-page markdown reaches the model as a clipped head, and that head is
// junk-dense: image markdown, data: URI blobs, asset links, and bare-URL nav
// lines burn the budget while the useful content sits below the cut, sending
// the model back to recall_tool_result again and again. The STORED payload
// stays raw (recall fidelity); only the model-visible head is computed from a
// densified view, and only when the text is provably scrape-shaped.
const MD_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
const DATA_URI_RE = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{64,}/g;
const BARE_URL_LINE_RE = /^\s*\[?https?:\/\/\S+\]?\s*$/;

export function densifyMarkdownForModelHead(text: string): string {
  const imageCount = (text.match(MD_IMAGE_RE) ?? []).length;
  const hasDataUri = DATA_URI_RE.test(text);
  if (imageCount < 3 && !hasDataUri) return text; // not scrape-shaped — untouched
  const stripped = text
    .replace(MD_IMAGE_RE, '')
    .replace(DATA_URI_RE, '[data-uri removed]');
  const lines = stripped.split('\n').filter((line) => !BARE_URL_LINE_RE.test(line));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function formatRecallableToolText(
  text: string,
  options: RecallableToolTextOptions = {},
): string {
  const active = getToolOutputContext();
  const sessionId = options.sessionId ?? active?.sessionId;
  const callId = options.callId ?? active?.callId;
  const toolName = options.toolName ?? active?.toolName ?? 'tool';
  // A formatter inside a harness invocation defaults to the budget that
  // invocation resolved once (presentationBudgetFor). Without one, the same
  // resolver answers from the tool name alone.
  const activeInvocationBudget = active?.presentationBudget !== undefined
    && (options.sessionId === undefined || options.sessionId === active.sessionId)
    && (options.callId === undefined || options.callId === active.callId)
    && (options.toolName == null || options.toolName === active.toolName)
    ? active.presentationBudget
    : undefined;
  let maxChars = options.maxChars
    ?? (sessionId && callId
      ? activeInvocationBudget ?? presentationBudgetFor({ toolName })
      : DEFAULT_TOOL_RESULT_MAX_CHARS);
  let persistenceFailed = false;
  let hostAnnotations = [...(options.hostAnnotations ?? [])].filter((note) => note.length > 0);

  // Local handlers, adapters and outer brackets can all format one result.
  // An authenticated projection is already backed by this invocation's raw
  // bytes; persisting the projection again would overwrite that evidence.
  // Reuse the existing exact receipt verifier, never infer clipping from prose.
  if (sessionId && callId && active?.settlementNonce) {
    const exact = exactToolOutputForInvocation({ sessionId, callId, toolName,
      compactResult: text, settlementNonce: active.settlementNonce });
    if (exact instanceof TruncatedToolOutputResult) return JSON.stringify(exact);
    if (typeof exact === 'string' && exact !== text) {
      if (options.verifiedProjectionMaxChars !== undefined) {
        maxChars = Math.max(maxChars, options.verifiedProjectionMaxChars);
      }
      if ((options.maxChars === undefined || text.length <= maxChars) && hostAnnotations.length === 0) return text;
      // Only an explicit smaller display request should re-render a verified
      // projection; a second formatter's default must not reinterpret it.
      // Only after exact same-invocation redemption may a smaller rendering
      // inherit the previous host annotation envelope. Provider JSON alone
      // cannot authenticate its metadata or lend another call this receipt.
      try {
        const prior = JSON.parse(text).__clementine?.hostAnnotations;
        if (Array.isArray(prior) && prior.every((note: unknown) => typeof note === 'string')) {
          hostAnnotations = [...new Set([...prior, ...hostAnnotations])];
        }
      } catch { /* non-JSON presentation has no structured host annotations */ }
      // A caller requested a smaller display. Derive it from the same original
      // bytes so its receipt still authenticates the complete retained result.
      text = exact;
    }
  }

  // Persist even a small result when an exact harness invocation exists.
  // Reconciliation must never fall back to the call-id/longest-wins recall row
  // merely because the model-facing value did not need clipping.
  if (sessionId && callId) {
    try {
      writeToolOutput({
        sessionId,
        callId,
        tool: toolName,
        output: text,
        invocationNonce: active?.settlementNonce,
      });
    } catch { persistenceFailed = true; }
  }
  if (text.length <= maxChars && hostAnnotations.length === 0) return text;
  hostAnnotations = boundHostAnnotations(hostAnnotations, maxChars);

  const annotationText = hostAnnotations.length > 0
    ? `[Host annotations — separate from provider result]\n${hostAnnotations.join("\n")}\n\n` : "";

  // The result is about to be clipped/digested. If it lists addressable
  // resources, surface their ids ABOVE the body so they survive (the root-cause
  // fix — see extractResourceIdIndex). Global: every tool formats through here.
  const idIndex = extractResourceIdIndex(text);
  const withIndex = (body: string): string => (idIndex ? `${idIndex}\n\n${body}` : body);

  if (!sessionId || !callId || persistenceFailed) {
    const dense = `${annotationText}${densifyMarkdownForModelHead(text)}`;
    if (!idIndex) return truncateToolTextWithin(dense, maxChars);
    const boundedIndex = truncateToolTextWithin(idIndex, Math.max(1, Math.floor(maxChars * 0.5)));
    const bodyBudget = Math.max(1, maxChars - boundedIndex.length - 2);
    return `${boundedIndex}\n\n${truncateToolTextWithin(dense, bodyBudget)}`;
  }

  const settlementNonce = active?.settlementNonce;
  const exactReceipt = settlementNonce
    ? `[exact-output-receipt:v1 nonce=${settlementNonce} sha256=${exactOutputSha256(text)}]`
    : null;

  // Keep oversized structured results as structured data. The old digest was
  // intentionally human-readable prose, but that made downstream typed source
  // proof impossible: JSON.parse could not recover `/news` after a huge sibling
  // `web[0].markdown`, and appending the exact-output receipt made it invalid
  // JSON even when the visible rows survived. Embed the host receipt inside a
  // reserved JSON property and budget siblings fairly; exact raw bytes remain
  // losslessly parked above and are still redeemed by nonce + digest.
  if (exactReceipt) {
    const structured = compactStructuredJsonToolOutput(text, {
      maxChars,
      toolName,
      callId,
      exactOutputReceipt: exactReceipt,
      resourceIndex: idIndex || undefined,
      hostAnnotations,
    });
    if (structured) return structured;
  }

  // Full payload is now parked in tool_outputs (above). Replace the raw
  // mid-content cut with a structure-aware digest so the model never sees
  // a JSON array severed mid-record — it gets complete records + the true
  // total + how to pull any slice (tool_output_query / recall_tool_result).
  // The head is computed from the DENSIFIED view for scrape-shaped payloads
  // (raw storage above is untouched) so the clipped budget carries content,
  // not image links and nav junk.
  if (exactReceipt && exactReceipt.length > maxChars) {
    // A caller-selected budget smaller than the non-forgeable receipt cannot
    // carry both truth and content. Stay bounded and fail closed: without the
    // complete receipt, exactToolOutputForInvocation will not redeem raw bytes.
    return '…[truncated_tool_output: exact receipt exceeds configured budget]'
      .slice(0, Math.max(0, maxChars));
  }
  const receiptReserve = exactReceipt ? exactReceipt.length + 1 : 0;
  // The digest fits its head, tail and footer inside what the host
  // annotations and the id index leave, so the frame around it never pushes
  // the footer (the exact reader call) past the cap below.
  const frameReserve = annotationText.length + (idIndex ? idIndex.length + 2 : 0);
  const compactBudget = Math.max(200, maxChars - receiptReserve - frameReserve);
  let compact = annotationText + withIndex(digestToolOutput(densifyMarkdownForModelHead(text), {
    maxChars: compactBudget,
    toolName,
    callId,
    // The stored row exists (written above), so the one reader router can
    // name the reader that serves this output's actual shape. The router reads
    // from the durable lifecycle whether this call has returned yet.
    readerAdvice: () => retainedResultWayThrough({ sessionId, callId }),
  }));
  if (exactReceipt && compact.length > maxChars - receiptReserve) {
    // Defensive absolute cap for non-JSON and root-array fallbacks. Preserve
    // the exact receipt and a bounded raw-recovery instruction; never slice the
    // receipt itself. Structure-aware object output takes the JSON path above.
    const bodyLimit = Math.max(0, maxChars - receiptReserve);
    const recovery = `Full output: recall_tool_result ${JSON.stringify({ call_id: callId })}`;
    if (bodyLimit === 0) compact = '';
    else if (recovery.length <= bodyLimit) {
      const available = Math.max(0, bodyLimit - recovery.length - 1);
      compact = available > 0 ? `${compact.slice(0, available)}\n${recovery}` : recovery;
    } else {
      compact = truncateToolTextWithin(recovery, bodyLimit);
    }
  }
  return exactReceipt ? (compact ? `${compact}\n${exactReceipt}` : exactReceipt) : compact;
}
