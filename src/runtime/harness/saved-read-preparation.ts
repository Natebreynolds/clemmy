/** A saved read declaration — a Space's persisted source or a watch's learned
 * read — reopened at a publication boundary. Each names one exact read
 * operation and, when it pins one, its account. Neither is a person's turn or
 * permission to write; the read kernel still owns dispatch. */
import { readSpaceReadPreparation } from '../../spaces/read-preparation-source.js';
import { readCalendarWatchReadPreparation } from '../../agents/calendar-read-declaration.js';

export interface SavedReadPreparation {
  sessionId: string;
  sourceUserSeq: number;
  acceptedInput: string;
  operationId: string;
  accountId: string | null;
  occurrenceId: string;
}

export function readSavedReadPreparation(sessionId: string, sourceUserSeq: number): SavedReadPreparation | null {
  return readSpaceReadPreparation(sessionId, sourceUserSeq)
    ?? readCalendarWatchReadPreparation(sessionId, sourceUserSeq);
}
