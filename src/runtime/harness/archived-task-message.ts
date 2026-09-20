import { createHash } from 'node:crypto';

/** Select one historical user message, never policy, memory, tool schemas or
 * tool frames. This projection conveys text evidence, not execution authority. */
export function pageArchivedTaskMessage(input: {
  taskLayer: string; itemIndex: number; offset?: number; maxChars?: number;
}) {
  const task = JSON.parse(input.taskLayer) as { input?: unknown };
  if (!Number.isSafeInteger(input.itemIndex) || input.itemIndex < 0
    || !Array.isArray(task.input)) throw new Error('invalid_message_locator');
  const item = task.input[input.itemIndex] as Record<string, unknown> | undefined;
  if (!item || item.role !== 'user'
    || (item.type !== undefined && item.type !== 'message')) throw new Error('not_user_message');
  // Preserve typed content exactly. The caller receives JSON, including every
  // text/image part, without fetching any referenced resource or reinterpreting it.
  if (typeof item.content !== 'string' && !Array.isArray(item.content)) throw new Error('invalid_message_content');
  const text = JSON.stringify({ role: 'user', content: item.content });
  const offset = input.offset ?? 0;
  const maxChars = input.maxChars ?? 12000;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length
    || !Number.isSafeInteger(maxChars) || maxChars < 2 || maxChars > 16000) throw new Error('invalid_page');
  if (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] ?? '')
    && /[\uD800-\uDBFF]/.test(text[offset - 1] ?? '')) throw new Error('invalid_page_boundary');
  let end = Math.min(text.length, offset + maxChars);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end -= 1;
  return {
    itemIndex: input.itemIndex,
    sha256: createHash('sha256').update(text).digest('hex'),
    totalChars: text.length, offsetChars: offset,
    nextOffsetChars: end < text.length ? end : null,
    contentJsonPage: text.slice(offset, end),
  };
}
