/**
 * The host's own receipt line at the head of a memory_remember result: what
 * the tool did (remembered, superseded an older fact, reinforced one, or
 * changed nothing) and the fact it left active. The host reads this, never
 * the prose after it, when it asks whether a request's memory work landed.
 * Same shape as the local write commit receipt.
 */
export const MEMORY_REMEMBER_RECEIPT_PREFIX = '[clementine:memory-remember:v1]' as const;

export type MemoryRememberAction = 'add' | 'supersede' | 'reinforce' | 'ignore';

export interface MemoryRememberReceipt {
  action: MemoryRememberAction;
  /** The fact now active for this content; absent when nothing was stored. */
  factId?: number;
}

const ACTIONS: ReadonlySet<string> = new Set(['add', 'supersede', 'reinforce', 'ignore']);

export function formatMemoryRememberReceipt(receipt: MemoryRememberReceipt): string {
  return `${MEMORY_REMEMBER_RECEIPT_PREFIX} ${JSON.stringify({ action: receipt.action,
    ...(typeof receipt.factId === 'number' && receipt.factId > 0 ? { factId: receipt.factId } : {}) })}`;
}

/** The receipt at the head of a memory_remember result, or null. */
export function parseMemoryRememberReceipt(result: unknown): MemoryRememberReceipt | null {
  const text = typeof result === 'string' ? result : textOf(result);
  if (!text) return null;
  const line = text.split('\n', 1)[0] ?? '';
  if (!line.startsWith(`${MEMORY_REMEMBER_RECEIPT_PREFIX} `) || line.length > 500) return null;
  try {
    const parsed = JSON.parse(line.slice(MEMORY_REMEMBER_RECEIPT_PREFIX.length + 1)) as Record<string, unknown>;
    if (typeof parsed.action !== 'string' || !ACTIONS.has(parsed.action)) return null;
    const factId = typeof parsed.factId === 'number' && Number.isSafeInteger(parsed.factId) && parsed.factId > 0 ? parsed.factId : undefined;
    return { action: parsed.action as MemoryRememberAction, ...(factId ? { factId } : {}) };
  } catch {
    return null;
  }
}

/** The text of a tool result as the host stored it: a string, or the text
 *  parts of an MCP content array. */
function textOf(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
      ? (part as { text: string }).text : '')).join('\n');
  }
  const text = (result as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
}
