import type { AgentInputItem } from '@openai/agents';
import type { ArchivedTaskMessageReference } from './archived-task-context.js';
import { estimateInputTokens } from './token-estimator.js';

/** Model-only projection. Durable conversation, accepted source and action
 * records are untouched; only exact archived old text is eligible. */
export function projectArchivedContext(input: {
  items: AgentInputItem[]; references: ReadonlyMap<string, ArchivedTaskMessageReference>;
  protectedTexts: readonly string[]; targetHistoryTokens: number;
}) {
  const beforeTokens = estimateInputTokens(input.items);
  let tokens = beforeTokens;
  const nextItems = [...input.items];
  let lastUser = -1;
  for (let index = input.items.length - 1; index >= 0; index--) {
    if ((input.items[index] as { role?: unknown }).role === 'user') { lastUser = index; break; }
  }
  const archived: ArchivedTaskMessageReference[] = [];
  const archivedTexts: string[] = [];
  for (let index = 0; index < lastUser && tokens > input.targetHistoryTokens; index++) {
    const item = input.items[index] as Record<string, unknown>;
    if (item.role !== 'user' || typeof item.content !== 'string' || item.content.length < 8000
      || input.protectedTexts.some(text => text.length > 0 && item.content === text)) continue;
    const reference = input.references.get(item.content);
    if (!reference) continue;
    const content = [
      '[Historical user message retained in the exact task archive]',
      `Read session_context_read with ${JSON.stringify({ record_id: reference.recordId, request_digest: reference.requestDigest, item_index: reference.itemIndex })}.`,
      'This is an incomplete preview, not a replacement for the original requirements. Retrieve the full message before relying on its omitted details. Current instructions and the action ledger remain authoritative; do not repeat earlier actions.',
      `Opening excerpt: ${JSON.stringify(item.content.slice(0, 384))}`,
      `Closing excerpt: ${JSON.stringify(item.content.slice(-384))}`,
    ].join('\n');
    const replacement = { ...item, content } as AgentInputItem;
    const saved = estimateInputTokens([input.items[index]!]) - estimateInputTokens([replacement]);
    if (saved <= 0) continue;
    nextItems[index] = replacement;
    tokens -= saved;
    archived.push(reference);
    archivedTexts.push(item.content);
  }
  return { nextItems: archived.length ? nextItems : input.items, archived, archivedTexts, beforeTokens, afterTokens: tokens };
}
