import { createHash } from 'node:crypto';
import { getToolOutputForInvocation, writeToolOutput } from './eventlog.js';
import { getToolOutputContext } from './tool-output-context.js';
import { compactStructuredJsonToolOutput, digestToolOutput } from './tool-output-digest.js';

// Raised 4000 → 12000 (2026-05-29): 4000 clipped normal "show me N" results
// (e.g. 10 Salesforce accounts ≈ 5.5KB) into head+tail, which read as
// "aggressive" clipping. Raised 12000 → 20000 (2026-08-05): a 39KB calendar
// day (6 Graph events) digested at 12K, forcing a follow-up tool_output_query
// round-trip for data the model was about to need anyway; 20K (~5K tokens)
// passes typical single-screen results whole while genuinely huge outputs
// (100KB+ Composio dumps) still digest + stay recoverable. Context pressure is
// owned by compaction, which is now budgeted from the routed model's REAL
// window (compactionBudgetForModel) instead of a fixed 200K.
export const DEFAULT_TOOL_RESULT_MAX_CHARS = 20_000;

export interface RecallableToolTextOptions {
  maxChars?: number;
  toolName?: string | null;
  sessionId?: string;
  callId?: string;
  /** Host commentary, separate from the provider payload and its raw receipt. */
  hostAnnotations?: readonly string[];
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
// ─── Scrape-head densifier (live 2026-07-23, 120-account visibility run) ───
// Scraped-page markdown reaches the model as a clipped head — and the head was
// junk-dense: image markdown, data: URI blobs, asset links, and bare-URL nav
// lines burned the budget while the useful content sat below the cut (the
// model went back via recall_tool_result 44× in one run). The STORED payload
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
  const maxChars = options.maxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS;
  const active = getToolOutputContext();
  const sessionId = options.sessionId ?? active?.sessionId;
  const callId = options.callId ?? active?.callId;
  const toolName = options.toolName ?? active?.toolName ?? 'tool';
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
      if (text.length <= maxChars && hostAnnotations.length === 0) return text;
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
  const compactBudget = Math.max(200, maxChars - receiptReserve);
  let compact = annotationText + withIndex(digestToolOutput(densifyMarkdownForModelHead(text), {
    maxChars: compactBudget,
    toolName,
    callId,
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
