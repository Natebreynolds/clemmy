/**
 * A conversation whose last word is Clem's question is waiting on the owner.
 * The engine records every ask as `awaiting_user_input`; the newer of that and
 * the owner's last message decides. Lists carry it so the owner can find the
 * question without opening every conversation (live 2026-10-30: a first-time
 * owner asked for an automation, stepped back to Clem's screen, and nothing
 * said she was waiting on an answer).
 */
import { listEvents } from '../runtime/harness/eventlog.js';

export interface OwnerAsk {
  /** Clem's own question, as she asked it. */
  question: string;
}

export function ownerAskWaiting(sessionId: string): OwnerAsk | null {
  const [last] = listEvents(sessionId, { types: ['user_input_received', 'awaiting_user_input'], desc: true, limit: 1 });
  if (!last || last.type !== 'awaiting_user_input') return null;
  const question = typeof last.data.question === 'string' ? last.data.question.trim() : '';
  return { question: question.slice(0, 280) };
}
