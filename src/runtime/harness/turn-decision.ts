/**
 * Turn-decision classification — extracted verbatim from loop.ts.
 *
 * Everything here answers one question: "what did the model's turn text
 * MEAN?" — a completed answer, an ASK/CONTINUE marker, a zero-work punt,
 * a hallucinated tool transcript, or nothing at all. The conversation
 * loop (loop.ts) imports these primitives and re-exports the public ones,
 * so existing importers (`toOrchestratorDecision` from './loop.js') are
 * unchanged. `classifyTurnText` at the bottom is the forward-looking
 * unified entry point later phases adopt.
 */
import { listEvents, type EventRow } from './eventlog.js';
import { getRuntimeEnv } from '../../config.js';
import { scrubInternalNarration } from './scrub-internal-narration.js';
import { looksLikeToolUnavailableSelfReport } from './tool-unavailable-text.js';
// Type-only import — erased at compile time, so there is no runtime cycle
// with loop.ts (which imports this module's values).
import type { OrchestratorDecisionShape } from './loop.js';

export const MISSING_REPLY_USER_FALLBACK =
  "I didn't produce a visible reply there. Please send that again and I'll retry.";

export const STRUCTURED_OUTPUT_RECOVERY_FALLBACK =
  "Clementine produced a response that couldn't be structured. Please ask again.";

// The draft-present retry directive below EXPLICITLY forbids tool calls and
// demands a user-facing text reply. A turn that receives such a directive and
// answers with substantive zero-tool text has FULFILLED the contract — running
// the zero-tool stall detectors against it makes the harness fight its own
// instruction (observed sess-mrchgvkc 2026-07-08: the model presented the
// requested email draft three times; STALL_ANNOUNCEMENT_PATTERN matched
// "checking"/"I'll" INSIDE the quoted email body and the stall banner ate the
// answer every time). Detection keys on the directive text itself so every
// injection site — and any future one that speaks the same contract — inherits
// the exemption without a parallel flag to keep in sync.
const PLAIN_TEXT_CONTRACT_DIRECTIVE_PATTERN =
  /\bdo not call (?:another|a) tool\b[\s\S]*\breply to the user now\b/i;

export function isPlainTextContractDirective(input: unknown): boolean {
  return typeof input === 'string' && PLAIN_TEXT_CONTRACT_DIRECTIVE_PATTERN.test(input);
}

const VALID_DECISION_ACTIONS: ReadonlySet<string> = new Set([
  'awaiting_user_input',
  'awaiting_approval',
  'awaiting_handoff_result',
  'completed',
  'abandoned',
]);

/** Legacy structured-envelope path: a fully-formed `{summary, done, nextAction, …}`
 *  object (the SDK's outputType result, or a JSON-envelope a model still emits).
 *  Kept so any lane/test still handing back the object shape parses identically. */
function decisionFromObject(value: Record<string, unknown>): OrchestratorDecisionShape | null {
  if (typeof value.summary !== 'string') return null;
  if (typeof value.done !== 'boolean') return null;
  if (typeof value.nextAction !== 'string') return null;
  if (!VALID_DECISION_ACTIONS.has(value.nextAction)) return null;
  const rawReply = typeof value.reply === 'string' && value.reply.trim() ? value.reply : null;
  return {
    summary: value.summary,
    // Strip internal context/memory/focus bookkeeping the model sometimes
    // narrates INTO the user-facing reply (e.g. "I checked the active context…
    // not the stale Revill audit thread"). reply is the answer, not plumbing.
    reply: rawReply ? scrubInternalNarration(rawReply) : null,
    done: value.done,
    nextAction: value.nextAction as OrchestratorDecisionShape['nextAction'],
    reason: typeof value.reason === 'string' ? value.reason : null,
  };
}

// ── Plain-text marker contract (replaces the structured DECISION ENVELOPE) ─────
// The model's turn output is an optional ONE-LINE marker + free-text body, parsed
// by regex and clamped in code — the same doctrine that hardened the judges (one
// marker, nothing to fail on shape). Claude Code never emits "response couldn't be
// structured" because its final output is just text; this is that contract.
//
//   ASK: <question>   → pause for the user (awaiting_user_input); body = question
//   CONTINUE: <why>   → keep looping (not done); body is an internal note
//   (no marker)       → DONE; the ENTIRE text is the user-facing reply
//
// FAIL-OPEN is the whole point: ANY non-empty text without a recognized marker is
// a VALID completed reply, so an unparseable decision is IMPOSSIBLE for non-empty
// output (the 2026-07-08 landing-page D_decision_unparsed failure class). Empty /
// recovery-sentinel output returns null → the existing stall-retry path (unchanged).
const ASK_DECISION_MARKER = /^\s*ASK:\s*([\s\S]+)$/i;
const CONTINUE_DECISION_MARKER = /^\s*CONTINUE:\s*([\s\S]*)$/i;

/** Telemetry-only summary derived IN CODE (first sentence, else first 200 chars) —
 *  never demanded from the model. */
function deriveDecisionSummary(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const firstSentence = collapsed.match(/^.*?[.!?](?=\s|$)/)?.[0]?.trim();
  const base = firstSentence && firstSentence.length >= 12 ? firstSentence : collapsed;
  return base.slice(0, 200);
}

/** A bare zero-work stall announcement ("Continuing.", "OK.", or a future-tense
 *  "I'll pull the records now" with nothing done) — NOT a real deliverable. These
 *  defer to the existing toolCalls-aware stall detector (evaluateProgress in the
 *  no-decision branch), which is the desired safety, not a parse failure. Fail-open
 *  applies to SUBSTANTIVE output; a recognized punt is never surfaced as the reply.
 *  Mirrors evaluateProgress's Signal A / A' text checks so there is one vocabulary. */
// The announcement-stall heuristic only applies to SHORT text. A genuine punt
// is 1–3 sentences of future tense ("Executing the Salesforce pull now — I'll
// fetch 15 contacts"). Longer text that happens to contain a future-tense verb
// or gerund is almost always a REAL answer quoting content — an email draft's
// "the piece worth checking", a report's "I'll include the link". Testing the
// pattern against unbounded text contradicted the FAIL-OPEN contract below and
// nulled live answers into the D_decision_unparsed retry thrash (sess-mrcg3mtx
// 2026-07-08: "Here's one example: To: lloyd@…" — the requested draft — was
// nulled twice, burned 5 minutes of re-runs, and ended in the stall banner
// instead of the answer).
const ANNOUNCEMENT_STALL_MAX_CHARS = 300;

function looksLikeZeroWorkStallText(trimmed: string): boolean {
  if (trimmed.length <= 60 && STALL_OUTPUT_PATTERN.test(trimmed)) return true;
  if (
    trimmed.length <= ANNOUNCEMENT_STALL_MAX_CHARS &&
    STALL_ANNOUNCEMENT_PATTERN.test(trimmed) &&
    !STALL_REFLECTION_SUPPRESS_PATTERN.test(trimmed)
  ) return true;
  if (looksLikeToolUnavailableSelfReport(trimmed)) return true;
  // A HALLUCINATED TOOL CALL rendered as text — a tool-shaped heading
  // ("**run_shell_command**" or "**Tool Call: run_shell_command**") near the
  // start, followed shortly by a fenced block. Live 2026-07-08: gpt-5.5 ended
  // the Joshua Tree acceptance run by WRITING the netlify deploy invocation as
  // markdown instead of calling the tool; under fail-open that prose completed
  // the run with the site never deployed. A second live shape (sess-mrcg3mtx)
  // opened with a lead-in sentence ("Let me find the correct file path.")
  // before the fake transcript, so the heading may appear after a short
  // preamble and a status line may sit between heading and fence. Text whose
  // substance is an intended-but-uncalled tool invocation is a punt — route it
  // to the stall nudge ("call the tool for real"), never to the user as an
  // answer. Still narrow: heading within the first 200 chars, fence within 120
  // chars of the heading, short body (a real reply that merely QUOTES a
  // command is longer).
  if (looksLikeHallucinatedToolTranscript(trimmed)) return true;
  return false;
}

// Heading must be unmistakably tool-shaped: a **/`-wrapped name, an
// explicit "Tool Call:" prefix, or a bare snake_case name (≥1 underscore).
// A plain word before a fence ("Options:", "bash") never qualifies — real
// replies use those.
const HALLUCINATED_TOOL_TRANSCRIPT_PATTERN =
  /(?:^|\n)\s*(?:(?:\*\*|`)(?:tool call:\s*)?[a-z][a-z0-9_]*(?:\*\*|`)|tool call:\s*[a-z][a-z0-9_]*|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*\n[\s\S]{0,120}?```/i;
const HALLUCINATED_XML_TOOL_CALL_PATTERN =
  /<function_calls>[\s\S]{0,600}?<invoke\s+name=["']([a-z][a-z0-9_]*)["'][\s\S]{0,1400}?<\/function_calls>/i;
const HALLUCINATED_TOOL_LABEL_PATTERN =
  /(?:^|\n)\s*(?:\*\*)?\s*(?:tool|tool call)\s*:\s*([a-z][a-z0-9_-]*)\s*(?:\*\*)?/i;
const HALLUCINATED_BRACKET_TOOL_LABEL_PATTERN =
  /\[(?:tool|tool call)\s*:\s*([a-z][a-z0-9_-]*)\]/i;
const HALLUCINATED_TOOL_NO_PARAMS_PATTERN =
  /\b(?:no\s+`?[a-z][a-z0-9_-]*`?\s+provided|assistant's tool call|harness will supply required params|tool call.+missing required)/i;

function hallucinatedToolTranscriptName(trimmed: string): string | null {
  const xml = HALLUCINATED_XML_TOOL_CALL_PATTERN.exec(trimmed);
  if (xml && xml.index <= 200) return xml[1] ?? null;
  const label = HALLUCINATED_TOOL_LABEL_PATTERN.exec(trimmed);
  if (label && label.index <= 200 && HALLUCINATED_TOOL_NO_PARAMS_PATTERN.test(trimmed)) return label[1] ?? null;
  const bracket = HALLUCINATED_BRACKET_TOOL_LABEL_PATTERN.exec(trimmed);
  if (bracket && bracket.index <= 200 && HALLUCINATED_TOOL_NO_PARAMS_PATTERN.test(trimmed)) return bracket[1] ?? null;
  return null;
}

function looksLikeHallucinatedToolTranscript(trimmed: string): boolean {
  if (trimmed.length >= 2_000) return false;
  const transcript = HALLUCINATED_TOOL_TRANSCRIPT_PATTERN.exec(trimmed);
  return Boolean(transcript && transcript.index <= 200) || Boolean(hallucinatedToolTranscriptName(trimmed));
}

/** Parse the model's plain-text turn output into a decision. Never returns a
 *  "malformed" verdict for substantive non-empty text — see FAIL-OPEN above. */
function parseDecisionText(text: string): OrchestratorDecisionShape | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed === STRUCTURED_OUTPUT_RECOVERY_FALLBACK) return null;

  // Back-compat / graceful transition: a model still emitting the JSON envelope
  // as text parses cleanly rather than being shown to the user as raw JSON.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object') {
        const obj = decisionFromObject(parsed as Record<string, unknown>);
        if (obj) return obj;
      }
    } catch { /* not a decision envelope — fall through to the marker contract */ }
  }

  const ask = trimmed.match(ASK_DECISION_MARKER);
  const cont = trimmed.match(CONTINUE_DECISION_MARKER);
  // A recognized zero-work punt (no explicit marker) defers to the stall path.
  // Explicit ASK:/CONTINUE: markers are intentional and always honored.
  if (!ask && !cont && looksLikeZeroWorkStallText(trimmed)) return null;
  if (ask && ask[1].trim()) {
    const question = ask[1].trim();
    return {
      summary: deriveDecisionSummary(question),
      reply: scrubInternalNarration(question) || question,
      done: false,
      nextAction: 'awaiting_user_input',
      reason: 'ask',
    };
  }

  if (cont) {
    const why = cont[1].trim() || 'Continuing.';
    // done:false + awaiting_handoff_result is the loop's existing "keep looping"
    // shape — it skips the completion + missing-reply paths and recurses.
    return {
      summary: deriveDecisionSummary(why),
      reply: null,
      done: false,
      nextAction: 'awaiting_handoff_result',
      reason: why.slice(0, 400),
    };
  }

  // No marker → the whole body IS the completed, user-facing reply.
  const reply = scrubInternalNarration(trimmed) || trimmed;
  return {
    summary: deriveDecisionSummary(trimmed),
    reply,
    done: true,
    nextAction: 'completed',
    reason: null,
  };
}

export function toOrchestratorDecision(value: unknown): OrchestratorDecisionShape | null {
  if (typeof value === 'string') return parseDecisionText(value);
  if (value && typeof value === 'object') return decisionFromObject(value as Record<string, unknown>);
  return null;
}

/**
 * Detect when a sub-agent received a handoff and then returned without
 * actually doing the work — a "stall". Observed pattern:
 *   - Orchestrator hands off to Executor with a clear directive.
 *   - Executor's turn ends with finalOutput "Continuing." (or "OK.",
 *     "Done.", "Working on it.") and ZERO tool calls.
 *   - The harness sees no_structured_output and renders the generic
 *     acknowledgement as if it were the bot's reply.
 *
 * The user sees "Continuing." and waits for action that never comes.
 * Surface the failure explicitly so they (and the chat UI) can tell
 * the difference between a real answer and a punt.
 *
 * Returns a stall descriptor when the pattern matches, undefined when
 * the output looks like real work. The check is intentionally narrow:
 * we don't want to flag a sub-agent that returned a short BUT real
 * answer ("Done — added 5 rows to the sheet"). Only the
 * acknowledgement-with-no-work pattern qualifies.
 */
export const STALL_OUTPUT_PATTERN = /^(continuing|ok|okay|done|sure|got it|working on it|will do|on it|understood|noted|alright|certainly|yes)\.?$/i;

// Verbose-announcement / false-claim stall. Two shapes the detector
// catches; both end with zero tool calls in the sub-agent turn:
//
// (A) Future-tense announcement — "Executing the Salesforce pull
//     now — I'll fetch 15 contacts..." Original repro 2026-05-19.
//
// (B) Past-tense FALSE CLAIM — "Handed off the exact Outlook action
//     for execution with the required tool slug and arguments." or
//     "Searched Outlook and found nothing." The model lies that
//     work happened. Caught in sess-mper69si-1a163ec1 (2026-05-21)
//     after a retry escaped the original future-tense filter.
//     Strictly WORSE than (A) because the false claim looks like a
//     real reply and the user trusts it.
//
// Boundary anchors (\b) prevent substring matches; the Unicode-
// apostrophe class catches curly quotes models love to emit.
const STALL_ANNOUNCEMENT_PATTERN = /\b(I[\u2018\u2019\u02bc' ]?ll\s|let me\s|executing\s|fetching\s|running\s|calling\s|pulling\s|querying\s|checking\s|retrieving\s|processing\s|attempting\s|trying\s|configuring\s|preparing\s|setting up\s|about to\s|going to\s|on the way|in progress|kicking off|starting now|handed off\s|handing off\s|completed the\s|sent the\s|updated the\s|searched\s|pulled the\s|posted the\s|created the\s|drafted the\s|saved the\s|loaded the\s|fetched\s|queried\s|ran the\s|transferred to\s|transferring to\s|routed to\s|routing to\s|dispatched the\s|dispatching the\s|delegated to\s|delegating to\s|kicked off\s|invoked the\s|invoking the\s|launched the\s|launching the\s|triggered the\s|triggering the\s|forwarded to\s|forwarding to\s)/i;
const STRUCTURED_TOOL_UNAVAILABLE_PATTERN = /\b(tool[- ]?enabled run|tool runtime|tool access|tool surface.{0,80}not available|tools? (?:were|was|are|is) (?:not )?available|no (?:commentary\/)?tool calls? (?:were|was|are|is) available|no executable tool results|no completed tool results|handoff summary|without tool access|resend ["“]?continue["”]?.*tool|please resend.*tool[- ]?enabled|cannot (?:create|read|write|search|execute|run).{0,80}(?:this turn|without tools?))\b/i;
// A zero-tool turn that AGREES with a correction, reflects on future behavior,
// or admits it isn't done is a legitimate CONVERSATIONAL reply — not a false
// "I did the work" claim. Without this guard, a stray "I'll …" in
// "you're right — going forward I'll treat SEO as raw metrics" trips
// STALL_ANNOUNCEMENT_PATTERN and the harness force-injects "prose, not an
// action — call a tool now", punishing exactly the converse-until-aligned
// behavior we want. Suppressing on these markers only ever removes FALSE
// positives: a real fake-completion ("Sent the email.", "Created the records.")
// contains none of them. Tool-agnostic — keys on the model's own wording.
const STALL_REFLECTION_SUPPRESS_PATTERN =
  /(you[‘’ʼ'` ]?re right|you are right|good catch|fair (?:point|enough)|my (?:mistake|bad)|i was wrong|i (?:got|had) (?:that|it) wrong|apolog|i should(?:n[‘’ʼ'`]?t)? have|going forward|for future|next time|in the future|that[‘’ʼ'` ]?s (?:right|fair|a (?:fair|good) point)|not (?:the|what)\b.{0,40}\byou asked\b)/i;
const TOOL_SURFACE_PROBE_TOOLS = new Set([
  'check_capability',
  'list_capabilities',
  'workspace_roots',
  'workspace_info',
  'workspace_list',
  'session_history',
  'memory_recall',
  'memory_search',
  'memory_list_facts',
  'skill_list',
  // Discovery-ritual tools: "which tool/command should I use" lookups — never the
  // deliverable itself. A turn that does ONLY these and then DEFERS (sets
  // nextAction:awaiting_handoff_result) has discovered-then-punted instead of
  // executing inline; the narration-deferral guard in evaluateStructuredDecisionStall
  // force-corrects it. A turn that does discovery AND a real tool call in the same
  // turn is NOT probe-only (it called a non-probe tool), so this never false-fires.
  'tool_choice_recall',
  'composio_search_tools',
  'local_cli_list',
]);

export type StallSignal = 'A_zero_tools' | 'B_repeated_tool' | 'C_handoff_pingpong' | 'D_decision_json';

export interface StallInfo {
  signal: StallSignal;
  rawOutput?: string;
  userVisibleMessage: string;
  /** Structured detail for the stuck_detected event / dashboard panel. */
  detail: Record<string, unknown>;
}

export function evaluateStructuredDecisionStall(opts: {
  decision: OrchestratorDecisionShape;
  toolCalls: number;
  sessionId?: string;
  turn?: number;
}): StallInfo | undefined {
  const { decision, toolCalls } = opts;
  const combined = [decision.reply, decision.summary, decision.reason]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n')
    .trim();
  const onlyProbeTools =
    toolCalls > 0 && opts.sessionId && opts.turn
      ? turnOnlyUsedToolSurfaceProbeTools(opts.sessionId, opts.turn)
      : false;
  const noMeaningfulTools = toolCalls === 0 || onlyProbeTools;
  // SILENT narration-deferral — caught BEFORE the empty-text early return below.
  // A turn with nextAction:awaiting_handoff_result, zero meaningful tools, and
  // reply/summary/reason ALL null-or-whitespace is still a defer to a hand-off
  // that no longer exists — just a wordless one. Without this, the empty-`combined`
  // guard lets it escape into a bland auto-continue (audit 2026-06-16). The
  // non-empty case is handled by the narration-deferral branch further down, which
  // stays AFTER the tool-unavailable branch so an explicit "tools unavailable"
  // claim keeps its own kind.
  if (!combined && noMeaningfulTools && decision.nextAction === 'awaiting_handoff_result') {
    return {
      signal: 'A_zero_tools',
      rawOutput: '',
      userVisibleMessage:
        `_(Clementine produced an empty turn that deferred to a hand-off that no longer ` +
        `exists, with zero tool calls. The harness will retry and force the actual tool action.)_`,
      detail: {
        kind: 'structured_narration_deferral',
        rawOutput: '',
        toolCalls,
        onlyProbeTools,
        nextAction: decision.nextAction,
        done: decision.done,
        summary: decision.summary,
        silent: true,
      },
    };
  }
  if (!combined) return undefined;
  const selfReportedToolUnavailable = looksLikeToolUnavailableSelfReport(combined);
  const toolUnavailableClaim =
    selfReportedToolUnavailable ||
    (
      STRUCTURED_TOOL_UNAVAILABLE_PATTERN.test(combined) &&
      (
        decision.nextAction === 'awaiting_user_input' ||
        decision.nextAction === 'awaiting_handoff_result' ||
        decision.nextAction === 'abandoned'
      )
    );
  if (noMeaningfulTools && decision.nextAction !== 'awaiting_approval' && toolUnavailableClaim) {
    return {
      signal: 'A_zero_tools',
      rawOutput: combined.slice(0, 220),
      userVisibleMessage:
        `_(Clementine claimed tool access was unavailable but made zero tool calls. ` +
        `The harness will retry and force an actual tool action.)_`,
      detail: {
        kind: 'structured_tool_unavailable',
        rawOutput: combined.slice(0, 220),
        toolCalls,
        onlyProbeTools,
        nextAction: decision.nextAction,
        done: decision.done,
        summary: decision.summary,
      },
    };
  }
  // NARRATION-DEFERRAL stall — the Claude-vs-Codex execution gap.
  // `awaiting_handoff_result` is a vestige of the retired Orchestrator→Executor
  // handoff: in today's single-agent model there is NO executor to hand off to.
  // So a turn that sets it while making ZERO meaningful tool calls (none, or only
  // discovery-ritual probes) has PROMISED imminent action ("On it — running the
  // pull now", "I'll pull 25") and deferred it to a phantom next agent. Left
  // alone, the loop REWARDS that by auto-continuing with a bland nudge, inviting
  // another narration turn — turning one CLI call into N slow model round-trips
  // (observed sess-mqhj058j: a 25-account Salesforce pull that is a single
  // `sf data query` burned a narration turn + a discover-then-defer turn before
  // executing). Codex acts inline; Claude reaches for the defer enum. Force the
  // real tool action THIS turn instead — reuses the zero-tool retry machinery.
  if (noMeaningfulTools && decision.nextAction === 'awaiting_handoff_result') {
    return {
      signal: 'A_zero_tools',
      rawOutput: combined.slice(0, 220),
      userVisibleMessage:
        `_(Clementine said it was acting but made zero tool calls and deferred to a ` +
        `hand-off that no longer exists. The harness will retry and force the actual tool action.)_`,
      detail: {
        kind: 'structured_narration_deferral',
        rawOutput: combined.slice(0, 220),
        toolCalls,
        onlyProbeTools,
        nextAction: decision.nextAction,
        done: decision.done,
        summary: decision.summary,
      },
    };
  }
  if (toolCalls !== 0) return undefined;
  if (
    // `abandoned` is included because a bare "Impossible — abandoning" + zero tools
    // otherwise banks as a clean terminal WITHOUT the objective judge (which only
    // runs on nextAction:'completed') or any blocked-text check — strictly worse
    // than a false `completed` claim (audit 2026-06-16). The same prior-work
    // suppression below still protects a genuine "searched, found nothing,
    // abandoning after real work" answer.
    (decision.nextAction === 'completed' || decision.nextAction === 'abandoned') &&
    STALL_ANNOUNCEMENT_PATTERN.test(combined) &&
    !STALL_REFLECTION_SUPPRESS_PATTERN.test(combined) &&
    // Not a false "zero-tool claim" when the model is REPORTING a genuine
    // completion (done:true) whose work was done in PRIOR turns — a
    // "searched, found nothing" answer makes no NEW tool call but isn't a lie.
    // The genuine target (claims done, did NO work this session) has no prior
    // substantive tool call, so it is NOT suppressed and still fires.
    !(decision.done === true && opts.sessionId && opts.turn !== undefined &&
      sessionDidSubstantiveToolWork(opts.sessionId, opts.turn))
  ) {
    return {
      signal: 'A_zero_tools',
      rawOutput: combined.slice(0, 220),
      userVisibleMessage:
        `_(Clementine claimed action was completed but made zero tool calls. ` +
        `The harness will retry and require the actual tools.)_`,
      detail: {
        kind: 'structured_zero_tool_claim',
        rawOutput: combined.slice(0, 220),
        toolCalls,
        nextAction: decision.nextAction,
        done: decision.done,
        summary: decision.summary,
      },
    };
  }

  return undefined;
}

function turnOnlyUsedToolSurfaceProbeTools(sessionId: string, turn: number): boolean {
  try {
    const toolNames = listEvents(sessionId)
      .filter((event) => event.turn === turn && event.type === 'tool_called')
      .map((event) => {
        const tool = event.data.tool;
        return typeof tool === 'string' ? tool : null;
      })
      .filter((tool): tool is string => Boolean(tool));
    if (toolNames.length === 0) return false;
    return toolNames.every((tool) => TOOL_SURFACE_PROBE_TOOLS.has(tool));
  } catch {
    return false;
  }
}

/**
 * True when the SESSION already did substantive (non-probe) tool work in a
 * STRICTLY-PRIOR turn (`event.turn < turn`). Used to suppress the
 * `structured_zero_tool_claim` stall on a genuine completion that reports the
 * result of earlier work (2026-06-15 Brooke email-find: real Outlook searches
 * in prior turns, then a `done:true` "found nothing" turn was falsely flagged a
 * zero-tool prose claim → 2.5-min thrash → false "unable to make progress").
 * Probe tools (memory/workspace/capability lookups) are EXCLUDED, so "only
 * looked at memory then claimed an external action" is not granted suppression.
 * Fail-OPEN to false — a degraded eventlog must never hide a real "claimed done,
 * did no work" lie. Kill-switch: HARNESS_STALL_PRIOR_WORK=off.
 */
function sessionDidSubstantiveToolWork(sessionId: string, turn: number): boolean {
  if ((getRuntimeEnv('HARNESS_STALL_PRIOR_WORK', 'on') ?? 'on').toLowerCase() === 'off') return false;
  try {
    return listEvents(sessionId, { types: ['tool_called'] }).some((event) => {
      if (typeof event.turn !== 'number' || event.turn >= turn) return false;
      const tool = event.data.tool;
      return typeof tool === 'string' && tool.length > 0 && !TOOL_SURFACE_PROBE_TOOLS.has(tool);
    });
  } catch {
    return false;
  }
}

function finalHandoffProgress(
  sessionId: string,
  turn: number | undefined,
): { from: string | null; to: string | null; toolCallsAfterHandoff: number } | undefined {
  if (!turn) return undefined;
  try {
    const turnEvents = listEvents(sessionId)
      .filter((event) => event.turn === turn);
    let lastHandoffIndex = -1;
    for (let index = turnEvents.length - 1; index >= 0; index -= 1) {
      if (turnEvents[index].type === 'handoff') {
        lastHandoffIndex = index;
        break;
      }
    }
    if (lastHandoffIndex < 0) return undefined;

    const handoff = turnEvents[lastHandoffIndex];
    const afterHandoff = turnEvents.slice(lastHandoffIndex + 1);
    return {
      from: typeof handoff.data.from === 'string' ? handoff.data.from : null,
      to: typeof handoff.data.to === 'string' ? handoff.data.to : null,
      toolCallsAfterHandoff: afterHandoff.filter((event) => event.type === 'tool_called').length,
    };
  } catch {
    return undefined;
  }
}

/**
 * T2.2 — Generalized stall detector. Four signals; first match wins.
 * Called from the no-structured-output branch of runConversation when
 * a sub-agent's turn ended without an OrchestratorDecision, but useful
 * for both the "punted on directive" and "stuck-in-loop" patterns.
 *
 *   Signal A — zero tools + short generic reply ("Continuing.", "OK.").
 *              The legacy detector; still the most common stall shape.
 *   Signal B — identical (toolName, hash(args)) ≥3 times in the last
 *              5 tool_called events for this session. The agent is
 *              re-running the same query expecting different results.
 *   Signal C — same from→to→from handoff pair fires ≥2 times within
 *              the last 8 handoff events. Orchestrator + sub-agent
 *              bouncing the directive back and forth.
 *   Signal D — final output is a stringified OrchestratorDecision
 *              JSON instead of a plain reply. Model over-conformed to
 *              the schema and the SDK exposed it raw.
 */
export function evaluateProgress(opts: {
  finalOutput: unknown;
  toolCalls: number;
  sessionId: string;
  turn?: number;
}): StallInfo | undefined {
  const handoffProgress = finalHandoffProgress(opts.sessionId, opts.turn);
  const effectiveToolCalls = handoffProgress?.toolCallsAfterHandoff ?? opts.toolCalls;

  // Signal A — zero tools + short generic reply (current behavior).
  if (effectiveToolCalls === 0 && typeof opts.finalOutput === 'string') {
    const trimmed = opts.finalOutput.trim();
    const fakeToolName = hallucinatedToolTranscriptName(trimmed);
    if (trimmed && looksLikeHallucinatedToolTranscript(trimmed)) {
      return {
        signal: 'A_zero_tools',
        rawOutput: trimmed.slice(0, 220),
        userVisibleMessage:
          `_(The model wrote a fake tool call transcript instead of calling the tool. ` +
          `Output: "${trimmed.slice(0, 160)}…". The harness will retry and require a real tool call.)_`,
        detail: {
          rawOutput: trimmed.slice(0, 220),
          fakeToolTranscript: true,
          toolName: fakeToolName,
          toolCalls: effectiveToolCalls,
          totalToolCalls: opts.toolCalls,
          afterHandoff: handoffProgress ?? null,
        },
      };
    }
    if (trimmed && looksLikeToolUnavailableSelfReport(trimmed)) {
      return {
        signal: 'A_zero_tools',
        rawOutput: trimmed.slice(0, 220),
        userVisibleMessage:
          `_(The model claimed tool access was unavailable but made zero tool calls. ` +
          `The harness will retry and require a real tool call.)_`,
        detail: {
          kind: 'tool_unavailable_self_report',
          rawOutput: trimmed.slice(0, 220),
          toolCalls: effectiveToolCalls,
          totalToolCalls: opts.toolCalls,
          afterHandoff: handoffProgress ?? null,
        },
      };
    }
    if (trimmed && trimmed.length <= 60 && STALL_OUTPUT_PATTERN.test(trimmed)) {
      return {
        signal: 'A_zero_tools',
        rawOutput: trimmed,
        userVisibleMessage:
          `_(The sub-agent ended its turn without taking any action. The model said "${trimmed}" but made zero tool calls. ` +
          `Re-send your request with a more specific directive — e.g. name the toolkit, the field, or the file you want it to touch.)_`,
        detail: {
          rawOutput: trimmed,
          toolCalls: effectiveToolCalls,
          totalToolCalls: opts.toolCalls,
          afterHandoff: handoffProgress ?? null,
        },
      };
    }
    // Signal A' — verbose-announcement stall. The model spent a turn
    // describing what it WOULD do without actually doing it. Caught the
    // 2026-05-19 sf data query session (Executor said "Executing the
    // Salesforce pull now — I'll fetch 15 contacts ..." with 0 tool
    // calls). Any time the output is future-tense and zero tools fired,
    // treat it the same as the bare "Continuing." stall — EXCEPT when the
    // reply is a reflective/alignment turn ("you're right — going forward
    // I'll …"), which legitimately has zero tools. Same suppression the
    // structured-decision path already applies (evaluateStructuredDecisionStall);
    // without it, converse-until-aligned replies false-fire a stall retry.
    // Bounded to SHORT text (ANNOUNCEMENT_STALL_MAX_CHARS) for the same reason
    // as looksLikeZeroWorkStallText: a long reply that contains a future-tense
    // verb is quoting content (a draft, a report), not announcing a punt.
    if (
      trimmed &&
      trimmed.length <= ANNOUNCEMENT_STALL_MAX_CHARS &&
      STALL_ANNOUNCEMENT_PATTERN.test(trimmed) &&
      !STALL_REFLECTION_SUPPRESS_PATTERN.test(trimmed)
    ) {
      return {
        signal: 'A_zero_tools',
        rawOutput: trimmed.slice(0, 220),
        userVisibleMessage:
          `_(The sub-agent announced work it was about to do but didn't actually call the tool. ` +
          `Output: "${trimmed.slice(0, 160)}…". Re-send your request — if it keeps stalling, name the exact tool you want it to use.)_`,
        detail: {
          rawOutput: trimmed.slice(0, 220),
          toolCalls: effectiveToolCalls,
          totalToolCalls: opts.toolCalls,
          afterHandoff: handoffProgress ?? null,
        },
      };
    }
  }

  // Signal D — stringified OrchestratorDecision JSON. Detect a `{...}`
  // shape with the schema's discriminating keys before we look up tool
  // history (cheap structural check first).
  if (typeof opts.finalOutput === 'string') {
    const trimmed = opts.finalOutput.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}') && trimmed.length > 40) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (
          typeof parsed.summary === 'string' &&
          typeof parsed.done === 'boolean' &&
          typeof parsed.nextAction === 'string'
        ) {
          const reply = typeof parsed.reply === 'string' ? parsed.reply : null;
          return {
            signal: 'D_decision_json',
            rawOutput: trimmed.slice(0, 200),
            userVisibleMessage:
              reply && reply.trim()
                ? reply
                : MISSING_REPLY_USER_FALLBACK,
            detail: {
              summary: parsed.summary,
              done: parsed.done,
              nextAction: parsed.nextAction,
              hasReply: !!(reply && reply.trim()),
            },
          };
        }
      } catch {
        /* not JSON-shaped after all — fall through */
      }
    }
  }

  // Signal B — repeated identical tool call. Look at the LAST 5
  // tool_called events for this session; if 3+ share (toolName, args
  // hash), the agent is looping on the same query.
  try {
    const recentToolCalls = listEvents(opts.sessionId, {
      types: ['tool_called'],
    }).slice(-5);
    if (recentToolCalls.length >= 3) {
      const counts = new Map<string, { count: number; toolName: string; argsExcerpt: string }>();
      for (const ev of recentToolCalls as EventRow[]) {
        const data = ev.data as { tool?: unknown; arguments?: unknown };
        const toolName = typeof data.tool === 'string' ? data.tool : 'unknown';
        const args = typeof data.arguments === 'string'
          ? data.arguments
          : data.arguments !== undefined ? JSON.stringify(data.arguments) : '';
        // Tight hash — collapses small whitespace differences but
        // preserves intent. A 60-char fingerprint catches "same query"
        // without false-positives on different keys.
        const key = `${toolName}::${args.slice(0, 200)}`;
        const existing = counts.get(key);
        if (existing) {
          existing.count++;
        } else {
          counts.set(key, { count: 1, toolName, argsExcerpt: args.slice(0, 120) });
        }
      }
      for (const [, info] of counts) {
        if (info.count >= 3) {
          return {
            signal: 'B_repeated_tool',
            userVisibleMessage:
              `_(I'm not making progress — I just re-ran \`${info.toolName}\` with the same arguments ${info.count} times in a row. ` +
              `What did you mean by the request? A different keyword, a specific record id, or a clarification will get past this.)_`,
            detail: {
              toolName: info.toolName,
              argsExcerpt: info.argsExcerpt,
              repeatCount: info.count,
              windowSize: recentToolCalls.length,
            },
          };
        }
      }
    }
  } catch {
    /* event-log query is best-effort */
  }

  // Signal C — handoff ping-pong. Pull the last 8 handoff events and
  // look for `from→to→from` patterns occurring twice or more.
  try {
    const recentHandoffs = listEvents(opts.sessionId, {
      types: ['handoff'],
    }).slice(-8);
    if (recentHandoffs.length >= 4) {
      const pairs = new Map<string, number>();
      // Build sequences of consecutive (from, to) pairs.
      const sequence: string[] = [];
      for (const ev of recentHandoffs as EventRow[]) {
        const d = ev.data as { from?: unknown; to?: unknown };
        const from = typeof d.from === 'string' ? d.from : null;
        const to = typeof d.to === 'string' ? d.to : null;
        if (from && to) sequence.push(`${from}→${to}`);
      }
      // Look for a triple ABA pattern occurring multiple times.
      for (let i = 0; i + 2 < sequence.length; i++) {
        const a = sequence[i];
        const b = sequence[i + 1];
        const c = sequence[i + 2];
        // ABA pattern: from→to→from (a's from === c's to AND a's to === c's from)
        const aFrom = a.split('→')[0]; const aTo = a.split('→')[1];
        const cFrom = c.split('→')[0]; const cTo = c.split('→')[1];
        if (aFrom === cTo && aTo === cFrom) {
          const key = `${aFrom}↔${aTo}`;
          pairs.set(key, (pairs.get(key) ?? 0) + 1);
        }
        // suppress unused warning
        void b;
      }
      for (const [pair, count] of pairs) {
        if (count >= 2) {
          return {
            signal: 'C_handoff_pingpong',
            userVisibleMessage:
              `_(${pair.replace('↔', ' and ')} are handing the work back and forth without making progress. ` +
              `The directive is probably ambiguous — clarify what you want and which agent should own it.)_`,
            detail: {
              agentPair: pair,
              repeatCount: count,
              windowSize: recentHandoffs.length,
            },
          };
        }
      }
    }
  } catch {
    /* best effort */
  }

  return undefined;
}

/**
 * Legacy alias — kept so existing call sites + tests don't break while
 * we migrate to evaluateProgress's discriminated signal output.
 */
export function detectSubAgentStall(finalOutput: unknown, toolCalls: number, sessionId?: string): StallInfo | undefined {
  return evaluateProgress({
    finalOutput,
    toolCalls,
    sessionId: sessionId ?? '',
  });
}

// ── Unified turn-text classifier (forward-looking API) ─────────────────────────

export type TurnTextKind = 'answer' | 'ask' | 'continue' | 'punt' | 'fake_tool_transcript' | 'empty';

/**
 * Classify a model turn's raw text into ONE decision vocabulary. Additive
 * entry point implemented in terms of the primitives above — loop.ts still
 * calls those primitives directly; later phases adopt this instead.
 *
 * `evidence` carries what the caller already knows about the turn, instead of
 * this function re-reading session events:
 *   - toolCalls: meaningful tool calls made THIS turn.
 *   - priorSubstantiveWork: the session did real (non-probe) tool work in a
 *     strictly-prior turn — the sessionDidSubstantiveToolWork verdict. Gates
 *     the zero-tool false-claim check exactly as the structured stall does
 *     (2026-06-15 Brooke email-find: a genuine "searched, found nothing"
 *     completion reports prior work and is NOT a lie).
 *   - contractTurn: this turn answered a plain-text-contract directive
 *     (isPlainTextContractDirective) — zero-tool substantive text is
 *     FULFILLMENT, never a stall (sess-mrchgvkc).
 *
 * Kinds:
 *   answer               → deliver decision.reply to the user (completed/abandoned)
 *   ask                  → pause for the user (ASK: marker / awaiting_* envelope)
 *   continue             → keep looping (CONTINUE: marker / awaiting_handoff_result)
 *   punt                 → zero-work stall text; route to the stall-retry machinery
 *   fake_tool_transcript → a hallucinated tool call rendered as markdown; NEVER
 *                          deliverable (Joshua Tree deploy, 2026-07-08)
 *   empty                → nothing usable (empty / recovery sentinel)
 */
export function classifyTurnText(
  text: string,
  evidence: { toolCalls: number; priorSubstantiveWork?: boolean; contractTurn?: boolean },
): { kind: TurnTextKind; decision: OrchestratorDecisionShape | null } {
  const trimmed = text.trim();
  if (!trimmed || trimmed === STRUCTURED_OUTPUT_RECOVERY_FALLBACK) {
    return { kind: 'empty', decision: null };
  }

  const decision = parseDecisionText(text);
  if (!decision) {
    // parseDecisionText nulls exactly the looksLikeZeroWorkStallText shapes
    // (the empty/sentinel case returned above). A contract turn is exempt for
    // substantive text — mirrors the loop's plain-text-contract fulfillment
    // branch (zero tools + text longer than a bare ack = compliance).
    if (
      evidence.contractTurn &&
      evidence.toolCalls === 0 &&
      (trimmed.length > 60 || !STALL_OUTPUT_PATTERN.test(trimmed))
    ) {
      return {
        kind: 'answer',
        decision: {
          summary: deriveDecisionSummary(trimmed),
          reply: trimmed,
          done: true,
          nextAction: 'completed',
          reason: 'plain_text_contract_fulfilled',
        },
      };
    }
    // Name WHICH punt shape. The hallucinated-transcript shape wins even when
    // a short lead-in ("Let me find the correct file path.") ALSO matches the
    // announcement heuristic — the transcript is the substance of the text and
    // the shape that must never reach the user as an answer; everything else
    // is the classic zero-work announcement/ack.
    if (looksLikeHallucinatedToolTranscript(trimmed)) {
      return { kind: 'fake_tool_transcript', decision: null };
    }
    return { kind: 'punt', decision: null };
  }

  if (decision.nextAction === 'awaiting_user_input' || decision.nextAction === 'awaiting_approval') {
    return { kind: 'ask', decision };
  }
  if (decision.nextAction === 'awaiting_handoff_result') {
    return { kind: 'continue', decision };
  }

  // completed / abandoned. A zero-tool announcement-shaped claim without prior
  // substantive work is still a punt — the structured_zero_tool_claim branch of
  // evaluateStructuredDecisionStall, with the eventlog reads replaced by the
  // caller-supplied evidence. Contract turns are exempt: the directive itself
  // forbade tool calls. Bounded to SHORT text (ANNOUNCEMENT_STALL_MAX_CHARS)
  // per the sess-mrcg3mtx lesson — a LONG reply containing a future-tense verb
  // is quoting content, not announcing a punt; the unbounded structured check
  // keeps its own event-based prior-work suppression in
  // evaluateStructuredDecisionStall.
  if (evidence.toolCalls === 0 && !evidence.contractTurn) {
    const combined = [decision.reply, decision.summary, decision.reason]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .join('\n')
      .trim();
    if (
      combined &&
      combined.length <= ANNOUNCEMENT_STALL_MAX_CHARS &&
      STALL_ANNOUNCEMENT_PATTERN.test(combined) &&
      !STALL_REFLECTION_SUPPRESS_PATTERN.test(combined) &&
      !(decision.done === true && evidence.priorSubstantiveWork)
    ) {
      return { kind: 'punt', decision };
    }
  }

  return { kind: 'answer', decision };
}
