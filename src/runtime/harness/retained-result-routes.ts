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
 * Both are individually well-reasoned, and each carries a comment explaining
 * the live incident it was written for. Together they are a closed loop, and a
 * model that obeys either one lands back where it started. Live 2026-09-07
 * source 146537 — the owner's Platform 49 Sheet-cleanup Plan — burned its turn
 * inside that cycle and never published a plan. The same shape had already been
 * fixed once on 2026-09-02 ("19 recalls, zero business calls, a governor stop,
 * and the sheet never touched"); pointing one tool at another simply moved it.
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
import { getToolOutput, listToolOutputCallIds, resolveToolOutputForAuthority } from './eventlog.js';
import { parseStoredToolOutputJson } from './json-repair.js';

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
  let record: { output: string; truncatedAtWrite?: boolean } | null = null;
  try {
    record = getToolOutput(input.sessionId, input.callId);
  } catch {
    record = null;
  }
  // Without the stored bytes there is nothing to route to. Say so; do not
  // invent a reader that will refuse for a different reason.
  if (!record || typeof record.output !== 'string' || record.output.length === 0) return routes;
  // A prefix is not authoritative data, and no reader can make it so.
  if (record.truncatedAtWrite) return routes;

  const structured = (() => {
    try {
      return Boolean(parseStoredToolOutputJson(record.output, {}));
    } catch {
      return false;
    }
  })();

  // Structured rows: the server-side query is the cheap, unclipped read.
  if (structured && !excluded.has('tool_output_query')) {
    routes.push({
      tool: 'tool_output_query',
      call: `tool_output_query {"call_id":"${input.callId}"}`,
      why: 'this output holds structured records, which it can filter, project and page server-side without spending recall budget',
    });
  }

  // Plain text: recall reads it, but only while its per-turn budget allows.
  const recallAvailable = input.recallCallsRemaining === undefined
    || input.recallCallsRemaining > 0;
  if (!structured && recallAvailable && !excluded.has('recall_tool_result')) {
    routes.push({
      tool: 'recall_tool_result',
      call: `recall_tool_result {"call_id":"${input.callId}"}`,
      why: 'this output is text rather than structured records, and recall reads it verbatim',
    });
  }

  // THE ROUTE NEITHER MESSAGE EVER NAMED. file_query reads the same stored
  // text and spends no recall budget, so it serves exactly the case that
  // trapped the Platform 49 plan: plain text with recall already exhausted.
  if (!excluded.has('file_query')) {
    routes.push({
      tool: 'file_query',
      call: `file_query {"call_id":"${input.callId}","query":"<what you need>"}`,
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
