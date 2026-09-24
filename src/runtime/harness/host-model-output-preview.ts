import { DEFAULT_TOOL_RESULT_MAX_CHARS, explicitLocalReadPreviewBudget, formatRecallableToolText } from './tool-output-format.js';
import { withToolOutputContext } from './tool-output-context.js';

/** Presentation only: the host has already settled the original tool result.
 * Keep raw bytes in the recall store and leave execution evidence untouched. */
export async function hostModelOutputPreview(text: string, input: {
  identity: () => { sessionId: string; sourceUserSeq: number };
  callId: string;
  toolName: string;
  arguments: unknown;
}): Promise<string> {
  const maxChars = explicitLocalReadPreviewBudget(input.toolName, input.arguments)
    ?? DEFAULT_TOOL_RESULT_MAX_CHARS;
  if (text.length <= maxChars) return text;
  const identity = input.identity();
  // Do not borrow an ambient nested call's nonce or identity. This is the
  // outer model projection; its logical receipt is recorded by the host.
  return withToolOutputContext({
    sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq,
    callId: input.callId, toolName: input.toolName,
  }, () => formatRecallableToolText(text, { maxChars }));
}
