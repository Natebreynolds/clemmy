import { normalizeApprovalResultUpdatedEvent, type ApprovalResultUpdatedEvent } from '@clem/chat-engine';

const listeners = new Set<(event: ApprovalResultUpdatedEvent) => void>();
/** Carried by the existing authenticated chat SSE. No extra socket, replay,
 * history fetch or model work is created by subscribing a visible card. */
export function publishApprovalResultUpdate(value: unknown): void {
  const event = normalizeApprovalResultUpdatedEvent(value);
  if (!event) return;
  for (const listener of listeners) { try { listener(event); } catch { /* another card remains independent */ } }
}
export function subscribeApprovalResultUpdates(listener: (event: ApprovalResultUpdatedEvent) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
