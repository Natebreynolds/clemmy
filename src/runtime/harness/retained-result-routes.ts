/**
 * ONE authority on how to reach a retained tool output.
 *
 * THE FAILURE THIS ENDS. Every reader of a parked result used to name its own
 * successor, unconditionally, without knowing what the others could do:
 *
 *   brackets.ts (recall exhausted)
 *     "Do NOT retry recall_tool_result — it will refuse again this turn.
 *      Call tool_output_query instead."
 *   recall-tools.ts (output is plain text)
 *     "It is text, not structured data — use recall_tool_result to read it."
 *
 * Each is individually reasonable. Together they are a closed loop: a model
 * that obeys either one lands back where it started and spends its turn
 * inside that cycle. Pointing one reader at another only moves the loop.
 *
 * The durable form is not a better sentence. It is a single function that
 * answers "what can actually read this output right now?" from the output's
 * real shape and the caller's real budget, excluding whatever just refused.
 * Neither reader may name a successor on its own again, so the loop cannot be
 * reintroduced by adding another reader — a new one registers here once.
 *
 * This mints no authority: every route it names is still subject to the same
 * exact source/account/occurrence checks at its own edge.
 */
import {
  getToolOutput,
  listToolOutputCallIds,
  resolveToolOutputForAuthority,
  resolveToolOutputForQuery,
  toolOutputStoredIdentity,
  unsettledToolOutputQueryRefusal,
  type AuthorityToolOutputResolution,
  type ToolOutputRecord,
  type ToolOutputStoredIdentity,
} from './eventlog.js';
import { parseStoredToolOutputJson } from './json-repair.js';
import { resolveRetainedOutputRead } from './retained-output-read.js';

export interface RetainedResultRoute {
  /** The tool to call. */
  readonly tool: string;
  /** An exact, copyable invocation. */
  readonly call: string;
  /** Why this route can serve THIS output. */
  readonly why: string;
}

export interface RetainedResultRouteInput {
  readonly sessionId: string;
  readonly callId: string;
  /** Readers that just refused, or whose budget is spent. Never suggested. */
  readonly exclude?: readonly string[];
  /** Recall calls still available this turn, when the caller knows. */
  readonly recallCallsRemaining?: number;
}

/** What the readers can do with one retained output, judged from its bytes
 * and from file_query's own query check. */
interface RetainedOutputJudgement {
  readonly readId: string;
  /** Non-empty and complete: something a reader can serve. */
  readonly readable: boolean;
  readonly structured: boolean;
  /** Structured data embedded in prose (a host document with its dataset
   * inside): the query reaches the data, and only recall reaches the prose. */
  readonly proseAroundData: boolean;
  readonly fileQuery: boolean;
}

/** Judgements of unchanged outputs, keyed by the output's metadata identity.
 * A recall pages through the router on every page; the bytes are judged once
 * and the same stored output is routed again without loading them. */
const JUDGEMENT_MEMO_LIMIT = 256;
const judgementMemo = new Map<string, { identity: string; judgement: RetainedOutputJudgement }>();

function rememberJudgement(key: string, identity: string, judgement: RetainedOutputJudgement): void {
  judgementMemo.delete(key);
  judgementMemo.set(key, { identity, judgement });
  while (judgementMemo.size > JUDGEMENT_MEMO_LIMIT) {
    const oldest = judgementMemo.keys().next().value;
    if (oldest === undefined) break;
    judgementMemo.delete(oldest);
  }
}

function judgeBytes(
  record: ToolOutputRecord | null,
  readId: string,
  fileQuery: boolean,
): RetainedOutputJudgement {
  // Without the stored bytes there is nothing to route to, and a prefix is
  // not authoritative data that any reader can make whole.
  if (!record || typeof record.output !== 'string' || record.output.length === 0 || record.truncatedAtWrite) {
    return { readId, readable: false, structured: false, proseAroundData: false, fileQuery: false };
  }
  const recovered = (() => {
    try {
      return parseStoredToolOutputJson(record.output, {});
    } catch {
      return null;
    }
  })();
  return {
    readId,
    readable: true,
    structured: Boolean(recovered),
    proseAroundData: recovered?.via === 'embedded',
    fileQuery,
  };
}

/** The resolver's record carries the canonical bytes when it is the canonical
 * row itself or an invocation row with the same digest. */
function resolvedRecordIsCanonical(
  resolution: AuthorityToolOutputResolution,
  identity: ToolOutputStoredIdentity,
): resolution is Extract<AuthorityToolOutputResolution, { status: 'ok' }> {
  if (resolution.status !== 'ok') return false;
  if (resolution.source === 'legacy') return true;
  const nonce = resolution.record.invocationNonce;
  if (!nonce || !identity.canonicalSha256) return false;
  return identity.invocationSha256.get(nonce) === identity.canonicalSha256;
}

function judgeRetainedOutput(input: RetainedResultRouteInput): RetainedOutputJudgement | null {
  // Route to what the readers will actually read: a recall's id resolves to
  // its producer and a receipt to its own redeemed bytes, exactly as each
  // reader resolves it. Naming the producer id means no route reads a copy of
  // a copy.
  let resolved: ReturnType<typeof resolveRetainedOutputRead>;
  try {
    resolved = resolveRetainedOutputRead(input.sessionId, input.callId);
  } catch {
    return null;
  }
  const readId = resolved.callId;
  // A redeemed receipt is read under its own exact identity, as file_query reads it.
  if (resolved.receipt) return judgeBytes(resolved.receipt, readId, true);

  let identity: ToolOutputStoredIdentity | null = null;
  try {
    identity = toolOutputStoredIdentity(input.sessionId, readId);
  } catch {
    identity = null;
  }
  if (!identity) return null;
  // Whether the call is still open is read from the durable lifecycle, never
  // from the caller: a call with no return yet cannot pass the query check,
  // so its output is judged as that check will judge it once the call
  // settles. Once a return exists, the check itself decides. The identity
  // carries the lifecycle, so a remembered judgement never outlives it.
  const inFlight = identity.calledEvents > 0 && identity.returnedEvents === 0;
  const memoKey = `${input.sessionId}\u0000${readId}`;
  const remembered = judgementMemo.get(memoKey);
  if (remembered && remembered.identity === identity.key) {
    rememberJudgement(memoKey, identity.key, remembered.judgement);
    return remembered.judgement;
  }

  let record: ToolOutputRecord | null = null;
  let fileQuery = false;
  try {
    if (inFlight) {
      record = getToolOutput(input.sessionId, readId);
      fileQuery = record !== null && unsettledToolOutputQueryRefusal(record) === null;
    } else {
      // file_query applies this resolver; its verified record doubles as the
      // bytes to judge when it is the canonical row the other readers read.
      const resolution = resolveToolOutputForQuery(input.sessionId, readId);
      fileQuery = resolution.status === 'ok';
      record = resolvedRecordIsCanonical(resolution, identity)
        ? resolution.record
        : getToolOutput(input.sessionId, readId);
    }
  } catch {
    // A failed read leaves whatever was read before it; judged as found.
  }
  const judgement = judgeBytes(record, readId, fileQuery);
  if (identity.canonicalSha256) rememberJudgement(memoKey, identity.key, judgement);
  return judgement;
}

/**
 * The routes that can serve this exact retained output, best first. Empty when
 * nothing can — which is itself the honest answer, and must be reported as
 * such rather than papered over with a guess.
 */
export function retainedResultRoutes(
  input: RetainedResultRouteInput,
): RetainedResultRoute[] {
  const excluded = new Set((input.exclude ?? []).map((name) => name.trim()));
  const routes: RetainedResultRoute[] = [];
  const judged = judgeRetainedOutput(input);
  // Say so when nothing can read it; do not invent a reader that will refuse
  // for a different reason.
  if (!judged || !judged.readable) return routes;
  const { readId, structured, proseAroundData } = judged;

  // Structured rows: the server-side query is the cheap, unclipped read.
  if (structured && !excluded.has('tool_output_query')) {
    routes.push({
      tool: 'tool_output_query',
      call: `tool_output_query {"call_id":"${readId}"}`,
      why: 'this output holds structured records, which it can filter, project and page server-side without spending recall budget',
    });
  }

  // Text: recall reads it, but only while its per-turn budget allows.
  const recallAvailable = input.recallCallsRemaining === undefined
    || input.recallCallsRemaining > 0;
  if ((!structured || proseAroundData) && recallAvailable && !excluded.has('recall_tool_result')) {
    routes.push({
      tool: 'recall_tool_result',
      call: `recall_tool_result {"call_id":"${readId}"}`,
      why: structured
        ? 'the text around that data is prose, and recall reads it verbatim'
        : 'this output is text rather than structured records, and recall reads it verbatim',
    });
  }

  // file_query reads the same stored text and spends no recall budget, so it
  // serves plain text with recall already exhausted. It is offered only when
  // its own query check accepts this id; advertising a reader that will
  // refuse is a dead end.
  if (!excluded.has('file_query') && judged.fileQuery) {
    routes.push({
      tool: 'file_query',
      call: `file_query {"call_id":"${readId}","query":"<what you need>"}`,
      why: 'it searches the same stored output as text and spends no recall budget',
    });
  }

  return routes;
}

/**
 * Retained outputs of THIS session that can still serve as authority, other
 * than the one that just failed.
 *
 * When a reader refuses a call id — derived/presentation-only, unverifiable
 * bytes, a legacy row — the model was told to "re-run the source read". That
 * discards work the host is still holding and, for a derived reader, asks for
 * something the model cannot produce. The host knows exactly which outputs it
 * retained; naming them is the link back to authentic evidence.
 *
 * Authority is unchanged: every id offered here is one `resolveToolOutputForAuthority`
 * accepts right now, and the reader still applies its own source/account checks.
 */
export function authenticRetainedAlternatives(input: {
  sessionId: string;
  excludeCallId?: string;
  limit?: number;
}): Array<{ callId: string; bytes: number }> {
  const out: Array<{ callId: string; bytes: number }> = [];
  try {
    for (const callId of listToolOutputCallIds(input.sessionId, 40)) {
      if (callId === input.excludeCallId) continue;
      let usable = false;
      try { usable = resolveToolOutputForAuthority(input.sessionId, callId).status === 'ok'; } catch { usable = false; }
      if (!usable) continue;
      const record = getToolOutput(input.sessionId, callId);
      if (!record || typeof record.output !== 'string' || record.output.length === 0) continue;
      out.push({ callId, bytes: record.output.length });
      if (out.length >= (input.limit ?? 3)) break;
    }
  } catch { /* advice is best-effort; never fail a read for it */ }
  return out;
}

/**
 * One sentence naming the actually-available next read, or an honest statement
 * that none remains. Callers append this instead of composing their own advice.
 */
export function retainedResultWayThrough(input: RetainedResultRouteInput): string {
  const routes = retainedResultRoutes(input);
  if (routes.length === 0) {
    // Before sending anyone back to the provider, offer what the host still
    // holds. Re-reading a source we already have retained is waste, and for a
    // derived reader it is not even actionable.
    const alternatives = authenticRetainedAlternatives({
      sessionId: input.sessionId,
      excludeCallId: input.callId,
    });
    if (alternatives.length > 0) {
      const named = alternatives
        .map((entry) => `{"call_id":"${entry.callId}"} (${entry.bytes.toLocaleString()} chars)`)
        .join(' or ');
      return 'That stored output cannot serve as authority. These retained results still can: '
        + `${named}. Query one of those instead of re-reading the source.`;
    }
    return 'No retained reader can serve this output as authoritative data — '
      + 're-read the source, or continue with what you already have and say what is missing.';
  }
  const first = routes[0]!;
  const alternative = routes[1];
  return `Call ${first.call} — ${first.why}.`
    + (alternative ? ` If that cannot answer it, ${alternative.call} ${alternative.why}.` : '');
}
