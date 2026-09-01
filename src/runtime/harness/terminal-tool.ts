/**
 * DURABLE CONTROL RECEIPTS — tools whose SUCCESS is itself the answer to the
 * request that invoked them, so the foreground turn is finished when they
 * return.
 *
 * This set is the one place both lanes agree on that fact: `orchestrator.ts`
 * (Codex) and `claude-agent-sdk.ts` (Claude) are its only consumers, so a
 * receipt added here settles identically on both. Lane adapters translate
 * transport; they do not each decide what completes a turn.
 *
 * Live incident 2026-08-10 (`session-fixture-terminal-control`, Codex gpt-5.6-sol): the
 * user asked "How's it going?", the status read succeeded, and a good answer
 * was produced — then the harness treated the still-running CHILD task as
 * unfinished FOREGROUND work and kept going: 58 status calls, 40 conversation
 * steps, 95 model calls, 3.36M tokens, no delivered completion. A revision
 * receipt was discarded the same way and retried until generic blocked output
 * appeared.
 *
 * The child's lifecycle is its own. A parent asking after it gets one fresh
 * read and one answer; the child stays running.
 */
const TERMINAL_TOOL_NAMES = new Set([
  'ask_user_question',
  'dispatch_background_task',
  'background_task_status',
  'background_task_revise',
  'background_task_cancel',
]);

export function bareTerminalToolName(rawName: string): string {
  return rawName.split('__').at(-1) ?? rawName;
}

export function isTerminalToolName(rawName: string | null | undefined): boolean {
  return typeof rawName === 'string' && TERMINAL_TOOL_NAMES.has(bareTerminalToolName(rawName));
}

/** Machine-readable contract emitted only when ask_user_question auto-resolves. */
export const ASK_USER_QUESTION_AUTO_RESOLVED_PREFIX = '[clementine:ask-user-question:auto-resolved:yolo]';

export function formatAutoResolvedAskUserQuestionOutput(message: string): string {
  return `${ASK_USER_QUESTION_AUTO_RESOLVED_PREFIX}\n${message}`;
}

/** `ask_user_question` is non-terminal only when YOLO explicitly resolved an
 * approval-shaped ask. The tool result is the shared contract on both SDKs. */
export interface TerminalToolHaltContext {
  /** Durable accepted-task authority says this foreground turn still owes
   * business work. Never derive this bit from prompt prose. */
  actionExpectedWork?: boolean;
}

export function terminalToolShouldHalt(
  rawName: string,
  output: string,
  context: TerminalToolHaltContext = {},
): boolean {
  const bare = bareTerminalToolName(rawName);
  if (bare === 'ask_user_question') {
    return !output.startsWith(`${ASK_USER_QUESTION_AUTO_RESOLVED_PREFIX}\n`);
  }
  // A control receipt settles the request only when the control action actually
  // SUCCEEDED. A refused or failed dispatch/revise/status is an ordinary typed
  // tool failure that belongs back inside the model loop — halting there would
  // strand the user with no answer and nothing running.
  if (BACKGROUND_CONTROL_TOOLS.has(bare)) {
    if (controlReceiptFailed(output)) return false;
    // A status receipt answers a status/review request, but it is only
    // reconciliation evidence inside an accepted action. Halting an act turn
    // here stranded the requested work after a stale background-task match.
    if (bare === 'background_task_status' && context.actionExpectedWork === true) return false;
    return true;
  }
  return true;
}

const BACKGROUND_CONTROL_TOOLS: ReadonlySet<string> = new Set([
  'dispatch_background_task',
  'background_task_status',
  'background_task_revise',
  'background_task_cancel',
]);

/**
 * Did the control action fail? Keyed on the harness's own typed refusal markers
 * and explicit result flags — never on prose about what the tool did.
 */
function controlReceiptFailed(output: string): boolean {
  const head = output.slice(0, 240);
  if (/^\s*(?:\{\s*")?(?:Tool call refused by harness|\[provider-dispatch:not-started:)/i.test(head)) return true;
  return /"(?:ok|successful)"\s*:\s*false/i.test(head) || /"error"\s*:\s*"/i.test(head);
}

/**
 * One user-facing reply per control receipt, shared by both lanes so a
 * receipt reads identically wherever it settles. `input` may be null on
 * lanes whose tool-result callback carries no input (Codex); every branch
 * degrades to output-derived text.
 */
export function renderTerminalToolReply(rawName: string, input: unknown, output: string): string {
  const bare = bareTerminalToolName(rawName);
  if (bare === 'dispatch_background_task') {
    // Voice-first (owner feedback, 2026-07-24): the model authors its own
    // handoff confirmation in the dispatch call (handoff_note rubric) — the
    // generated line below is only the floor when it omitted one.
    const note = (input as { handoff_note?: unknown } | null | undefined)?.handoff_note;
    if (typeof note === 'string' && note.trim().length >= 12) return note.trim();
    const match = output.match(/Dispatched "([^"]+)" to the background \(task ([^)]+)\)/i);
    const inputObjective = (input as { objective?: unknown } | null | undefined)?.objective;
    // Never fabricate a handoff claim: without a real dispatch receipt in the
    // output, the honest reply is the output itself (a refusal rendered as
    // "Started …" was blocked by the honesty floor — live 2026-08-11).
    if (!match && !(typeof inputObjective === 'string' && inputObjective.trim())) {
      return output.trim() || 'dispatch_background_task completed.';
    }
    const title = match?.[1] || (typeof inputObjective === 'string' && inputObjective.trim() ? inputObjective.trim() : 'the task');
    const taskId = match?.[2];
    return `Started "${title}" in the background${taskId ? ` (${taskId})` : ''} — it reports back here when it finishes or gets stuck.`;
  }
  if (bare === 'ask_user_question') {
    // Surface the QUESTION inline (from the tool input) so the turn ends on a clean
    // clarifying question the user answers in their next message — the conversational
    // beat. Render from the input, not the tool output (which is a check-in receipt),
    // so the question shows even if the check-in record write hiccuped.
    const q = (input as { question?: unknown } | null | undefined)?.question;
    return typeof q === 'string' && q.trim() ? q.trim() : (output.trim() || 'I have a quick question before I proceed.');
  }
  if (bare === 'background_task_revise') {
    // The raw receipt is mechanism-speak ("Updated bg-… to contract v2 …
    // evidence policy: revalidate") and shipped verbatim to a user (live
    // 2026-08-11, first dev-daemon acceptance ask). Plain voice, no ids —
    // the surrounding thread already names the task.
    return 'Got it — I’ve folded that into the running task; it picks up the change at its next step.';
  }
  if (bare === 'background_task_cancel') {
    return output.trim().startsWith('{')
      ? 'Stopped that background task — nothing further will run.'
      : (output.trim() || 'Stopped that background task — nothing further will run.');
  }
  return output.trim() || `${bare} completed.`;
}

/**
 * Machine-readable finalOutput contract for a HALTING control receipt on the
 * loop lane. The single decision parser converts it deterministically into a
 * completed decision — the receipt text must never re-enter prose parsing,
 * where "reports back when it finishes" reads as an announcement stall (live
 * 2026-08-10: 58 status calls / 3.36M tokens answering "How's it going?").
 */
export const CONTROL_RECEIPT_FINAL_OUTPUT_PREFIX = '[clementine:control-receipt:final]';

export function formatControlReceiptFinalOutput(text: string): string {
  return `${CONTROL_RECEIPT_FINAL_OUTPUT_PREFIX}\n${text}`;
}

export function parseControlReceiptFinalOutput(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!value.startsWith(`${CONTROL_RECEIPT_FINAL_OUTPUT_PREFIX}\n`)) return null;
  const text = value.slice(CONTROL_RECEIPT_FINAL_OUTPUT_PREFIX.length + 1).trim();
  return text || null;
}

/**
 * Machine-readable finalOutput contract for a REAL user-input pause on the
 * Codex loop lane. A question is terminal for the current provider activation,
 * but it is deliberately NOT a completed foreground request: the shared
 * conversation reducer must publish needs_input + resumable ownership.
 *
 * Keep this distinct from CONTROL_RECEIPT_FINAL_OUTPUT_PREFIX. Treating an
 * ask_user_question result as a completed control receipt produced the
 * internally impossible sequence `awaiting_user_input` followed by a public
 * done/answer terminal (live 2026-08-29, source 100077).
 */
export const AWAITING_USER_INPUT_FINAL_OUTPUT_PREFIX =
  '[clementine:awaiting-user-input:final]';

export function formatAwaitingUserInputFinalOutput(text: string): string {
  return `${AWAITING_USER_INPUT_FINAL_OUTPUT_PREFIX}\n${text}`;
}

export function parseAwaitingUserInputFinalOutput(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!value.startsWith(`${AWAITING_USER_INPUT_FINAL_OUTPUT_PREFIX}\n`)) return null;
  const text = value.slice(AWAITING_USER_INPUT_FINAL_OUTPUT_PREFIX.length + 1).trim();
  return text || null;
}

/**
 * A bounded async-read refinement can end without satisfying its accepted
 * research requirement. The work_call result is then a host-authored scope
 * gate, not model prose and not verified read evidence. Recognize only the
 * exact local carrier plus the exact protocol/option tuple so an arbitrary
 * provider result cannot stop a turn or manufacture an awaiting-input card.
 */
const ASYNC_READ_REFINEMENT_TERMINAL_PROTOCOL =
  'clementine.async_read_refinement_terminal.v1' as const;

const ASYNC_READ_REFINEMENT_OPTIONS = [
  'Retry a materially different query within the same 30-day window',
  'Change the content brief',
  'Pause this task without creating a Workspace',
] as const;

const ASYNC_READ_REFINEMENT_TERMINAL_KINDS: ReadonlySet<string> = new Set([
  'insufficient_evidence',
  'provider_failed',
  'provider_cancelled',
  'deadline_exhausted',
  'attempts_exhausted',
]);

export interface AsyncReadRefinementAwaitingInputPresentation {
  readonly protocol: typeof ASYNC_READ_REFINEMENT_TERMINAL_PROTOCOL;
  readonly terminalKind: string;
  readonly reason: string;
  readonly question: string;
  readonly options: readonly string[];
}

function exactAsyncReadRefinementGate(value: unknown): {
  terminalKind: string;
  reason: string;
} | null {
  let parsed = value;
  if (typeof parsed === 'string') {
    if (!parsed.trim() || parsed.length > 8_192) return null;
    try { parsed = JSON.parse(parsed) as unknown; } catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (JSON.stringify(keys) !== JSON.stringify([
    'options',
    'protocol',
    'reason',
    'status',
    'terminalKind',
  ])) return null;
  if (
    row.protocol !== ASYNC_READ_REFINEMENT_TERMINAL_PROTOCOL
    || row.status !== 'needs_scope'
    || typeof row.terminalKind !== 'string'
    || !ASYNC_READ_REFINEMENT_TERMINAL_KINDS.has(row.terminalKind)
    || typeof row.reason !== 'string'
    || row.reason !== row.reason.trim()
    || row.reason.length < 12
    || row.reason.length > 300
    || /[\u0000-\u001f\u007f]/u.test(row.reason)
    || !Array.isArray(row.options)
    || row.options.length !== ASYNC_READ_REFINEMENT_OPTIONS.length
    || row.options.some((option, index) => option !== ASYNC_READ_REFINEMENT_OPTIONS[index])
  ) return null;
  return { terminalKind: row.terminalKind, reason: row.reason };
}

/** Structural decoder only. Callers MUST reprove the exact durable async
 * intent/terminal receipt/logical settlement before using this to halt. */
export function parseAsyncReadRefinementTerminalResult(
  rawName: string | null | undefined,
  output: unknown,
): AsyncReadRefinementAwaitingInputPresentation | null {
  if (typeof rawName !== 'string' || bareTerminalToolName(rawName) !== 'work_call') return null;
  const gate = exactAsyncReadRefinementGate(output);
  if (!gate) return null;
  const question = [
    gate.reason,
    '',
    'How would you like me to proceed?',
    '',
    ...ASYNC_READ_REFINEMENT_OPTIONS.map((option, index) => `${index + 1}. ${option}`),
  ].join('\n');
  return {
    protocol: ASYNC_READ_REFINEMENT_TERMINAL_PROTOCOL,
    terminalKind: gate.terminalKind,
    reason: gate.reason,
    question,
    options: ASYNC_READ_REFINEMENT_OPTIONS,
  };
}
