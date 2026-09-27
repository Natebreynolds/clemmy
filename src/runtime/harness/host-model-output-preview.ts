import { DEFAULT_TOOL_RESULT_MAX_CHARS, formatRecallableToolText, presentationBudgetFor } from './tool-output-format.js';
import { withToolOutputContext } from './tool-output-context.js';

/** Presentation only: the host has already settled the original tool result.
 * Keep raw bytes in the recall store and leave execution evidence untouched. */
export async function hostModelOutputPreview(text: string, input: {
  identity: () => { sessionId: string; sourceUserSeq: number };
  callId: string;
  toolName: string;
  arguments: unknown;
  /** The model this projection is presented to. */
  routedModelId?: string | null;
}): Promise<string> {
  // An outer backstop only: the invocation's own presentation budget (the
  // same resolver) already bounded the result, so this never cuts below it.
  const maxChars = Math.max(DEFAULT_TOOL_RESULT_MAX_CHARS, presentationBudgetFor({
    toolName: input.toolName,
    args: input.arguments,
    routedModelId: input.routedModelId,
  }));
  if (text.length <= maxChars) return text;
  const identity = input.identity();
  // Do not borrow an ambient nested call's nonce or identity. This is the
  // outer model projection; its logical receipt is recorded by the host.
  return withToolOutputContext({
    sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq,
    callId: input.callId, toolName: input.toolName,
  }, () => formatRecallableToolText(text, { maxChars }));
}
