/** A calendar watch read is a saved read declaration, not a chat message or
 * permission to write. The watch reads every connected calendar account, so
 * each read names its own account and the account is not a choice anyone has
 * to make again: routing keeps it on that account the way it keeps a saved
 * Space read on the account the Space declares. The declaration is reopened at
 * every publication boundary; a learned read that moved to another operation
 * invalidates the pending preparation. */
import { randomUUID } from 'node:crypto';
import { appendEvent, getSession, listEvents } from '../runtime/harness/eventlog.js';
import { listLearnedCalendarReads } from './calendar-read-recipe.js';

const EVENT = 'watch_read_preparation_started' as const;
const WATCH = 'calendar';
const SESSION_ID = `watch:${WATCH}`;

export interface CalendarWatchReadPreparationSource {
  sessionId: string;
  sourceUserSeq: number;
  acceptedInput: string;
}

/** The watch still reads this operation for this provider. */
function watchReads(toolkit: string, operationId: string): boolean {
  return listLearnedCalendarReads().some((read) => read.toolkit === toolkit
    && read.recipe.operationId.trim().toUpperCase() === operationId);
}

function textFor(operationId: string, accountId: string): string {
  // Structural fields only: no prose becomes an account nomination.
  return JSON.stringify({ kind: 'watch_read', watch: WATCH, operation: operationId, account: accountId });
}

export function beginCalendarWatchReadPreparation(input: {
  toolkit: string; operationId: string; accountId: string; tickId: string;
}): CalendarWatchReadPreparationSource {
  const toolkit = input.toolkit.trim().toLowerCase();
  const operationId = input.operationId.trim().toUpperCase();
  const accountId = input.accountId.trim();
  if (!accountId || !watchReads(toolkit, operationId)) {
    throw new Error('calendar watch read declaration changed before preparation');
  }
  if (!getSession(SESSION_ID)) throw new Error('calendar watch session is missing');
  const acceptedInput = textFor(operationId, accountId);
  const event = appendEvent({ sessionId: SESSION_ID, turn: 0, role: 'system', type: EVENT, data: {
    version: 1, watch: WATCH, toolkit, operationId, accountId, tickId: input.tickId,
    occurrenceId: randomUUID(), acceptedInput,
  } });
  return { sessionId: SESSION_ID, sourceUserSeq: event.seq, acceptedInput };
}

export function readCalendarWatchReadPreparation(sessionId: string, sourceUserSeq: number) {
  if (sessionId !== SESSION_ID) return null;
  try {
    const event = listEvents(sessionId, { sinceSeq: sourceUserSeq - 1, throughSeq: sourceUserSeq,
      types: [EVENT], limit: 1 })[0];
    const data = event?.data;
    if (!event || event.seq !== sourceUserSeq || event.role !== 'system' || data?.version !== 1
      || data.watch !== WATCH || typeof data.toolkit !== 'string' || typeof data.operationId !== 'string'
      || typeof data.accountId !== 'string' || !data.accountId
      || typeof data.occurrenceId !== 'string' || !data.occurrenceId) return null;
    if (!watchReads(data.toolkit, data.operationId)) return null;
    const acceptedInput = textFor(data.operationId, data.accountId);
    if (data.acceptedInput !== acceptedInput) return null;
    return { sessionId, sourceUserSeq, acceptedInput, operationId: data.operationId,
      accountId: data.accountId, occurrenceId: data.occurrenceId };
  } catch { return null; }
}
