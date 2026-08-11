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
 * Live incident 2026-08-10 (`sess-msmo2312-e8aad2da`, Codex gpt-5.6-sol): the
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
export function terminalToolShouldHalt(rawName: string, output: string): boolean {
  const bare = bareTerminalToolName(rawName);
  if (bare === 'ask_user_question') {
    return !output.startsWith(`${ASK_USER_QUESTION_AUTO_RESOLVED_PREFIX}\n`);
  }
  // A control receipt settles the request only when the control action actually
  // SUCCEEDED. A refused or failed dispatch/revise/status is an ordinary typed
  // tool failure that belongs back inside the model loop — halting there would
  // strand the user with no answer and nothing running.
  if (BACKGROUND_CONTROL_TOOLS.has(bare)) return !controlReceiptFailed(output);
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
