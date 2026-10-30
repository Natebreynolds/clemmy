/**
 * Which conversations lead Clem's screen.
 *
 * One Clem is still working in, or one she answered since you looked, leads.
 * One waiting on your answer leads while the ask is fresh; after a day it is
 * history that still says "Waiting on your answer" in Chats, not the first
 * thing on the screen (live 2026-10-30: chats waiting 3 and 5 days led it).
 */
import type { ChatSession } from './api';

export const FRESH_ASK_MS = 24 * 60 * 60_000;

export function waitingAskIsFresh(session: Pick<ChatSession, 'waitingOnYou' | 'updatedAt'>, nowMs = Date.now()): boolean {
  return Boolean(session.waitingOnYou) && Number.isFinite(session.updatedAt) && nowMs - session.updatedAt < FRESH_ASK_MS;
}

/** Fresh asks first, then the rest in their own order. */
export function orderRecentConversations<T extends Pick<ChatSession, 'waitingOnYou' | 'updatedAt'>>(sessions: readonly T[], nowMs = Date.now()): T[] {
  return [
    ...sessions.filter((session) => waitingAskIsFresh(session, nowMs)),
    ...sessions.filter((session) => !waitingAskIsFresh(session, nowMs)),
  ];
}
