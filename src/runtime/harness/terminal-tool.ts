/** Tools that intentionally hand control back to the user or background runner. */
const TERMINAL_TOOL_NAMES = new Set([
  'ask_user_question',
  'dispatch_background_task',
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
  if (bareTerminalToolName(rawName) !== 'ask_user_question') return true;
  return !output.startsWith(`${ASK_USER_QUESTION_AUTO_RESOLVED_PREFIX}\n`);
}
