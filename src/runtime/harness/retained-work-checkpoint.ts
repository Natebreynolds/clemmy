/**
 * The host's retained-work checkpoint, as text. It rides at the end of an
 * incomplete terminal so a later turn can reuse the exact results it names
 * (recall_tool_result redeems the rh_ handles) instead of fetching them again.
 * Leaf module: the public projection reads it without the evidence store.
 */
export const RETAINED_WORK_TERMINAL_HEADER = 'Retained work (durable checkpoint):';

/**
 * The part of a terminal a person reads while Clem waits on them: the words
 * before the retained-work checkpoint. Someone answering a question or an
 * approval has no use for record counts and handle ids; the durable terminal
 * keeps them for the model.
 */
export function withoutRetainedWorkCheckpoint(text: string): string {
  const index = text.indexOf(RETAINED_WORK_TERMINAL_HEADER);
  if (index < 0) return text;
  const kept = text.slice(0, index).trimEnd();
  return kept || text;
}
