/**
 * No message in a conversation is left unread (owner 2026-10-30: "there
 * should never be a time where Clem doesn't pick up a message in a
 * conversation").
 *
 * A message the owner sends while Clem works is a steer note, and the running
 * work adopts it at its next tool result or at its end. When nothing will —
 * nothing runs in the conversation any more and the note was never delivered —
 * the note becomes the conversation's next turn, in the owner's own words,
 * exactly once. The turn's input is the owner's own words (it joins the
 * conversation's history like any message); the transcript already shows them
 * as the note, so the input draws no second bubble.
 */
import { createHash } from 'node:crypto';
import pino from 'pino';
import { acceptUserInputForRun, appendEvent, claimHarnessChatRequestInTransaction, getLatestEventSeq, getSession,
  listActiveRunAttemptOwnership, listEvents, openEventLog, updateSession, withEventPublicationTransaction } from './eventlog.js';
import { sessionSupportsSteering } from './steer-notes.js';

const logger = pino({ name: 'clementine-next.steer-pickup' });

/** Long enough for a running turn's own end-of-turn handoff to adopt the note. */
const SETTLE_MS = 5_000;
/** Notes older than this are history, not something to act on now. */
const LOOKBACK_MS = 24 * 60 * 60_000;
const SWEEP_MS = 10_000;

export interface SteerPickupRequest {
  sessionId: string;
  channel: string;
  message: string;
  sourceUserSeq: number;
  runId: string;
}
export type SteerPickupRespond = (request: SteerPickupRequest) => Promise<unknown>;

let respondImpl: SteerPickupRespond | null = null;
export function bindSteerPickupRespond(respond: SteerPickupRespond | null): void { respondImpl = respond; }

export interface UnownedSteerNote { seq: number; text: string }

/** The owner's notes in this conversation that no running work will adopt. */
export function unownedSteerNotes(sessionId: string, nowMs = Date.now()): UnownedSteerNote[] {
  if (!sessionSupportsSteering(sessionId)) return [];
  if (listActiveRunAttemptOwnership(sessionId).length > 0) return [];
  const rows = listEvents(sessionId, { types: ['user_steer_note', 'user_steer_note_delivered'] });
  const delivered = new Set<number>();
  for (const row of rows) {
    if (row.type !== 'user_steer_note_delivered') continue;
    const seqs = (row.data as { noteSeqs?: unknown }).noteSeqs;
    if (Array.isArray(seqs)) for (const seq of seqs) if (typeof seq === 'number') delivered.add(seq);
  }
  return rows
    .filter((row) => row.type === 'user_steer_note' && row.role === 'user' && !delivered.has(row.seq))
    .filter((row) => {
      const at = Date.parse(row.createdAt);
      return Number.isFinite(at) && nowMs - at >= SETTLE_MS && nowMs - at <= LOOKBACK_MS;
    })
    .map((row) => ({ seq: row.seq, text: typeof row.data.text === 'string' ? row.data.text.trim() : '' }))
    .filter((note) => note.text.length > 0);
}

/** Start the conversation's next turn with its unowned notes. 'started' when
 * this call owns the turn; a second call for the same notes finds them
 * delivered and does nothing. */
export async function pickUpUnownedSteerNotes(sessionId: string, nowMs = Date.now()): Promise<'started' | 'none'> {
  const respond = respondImpl;
  if (!respond) return 'none';
  const notes = unownedSteerNotes(sessionId, nowMs);
  if (notes.length === 0) return 'none';
  const noteSeqs = notes.map((note) => note.seq);
  const message = notes.map((note) => note.text).join('\n\n');
  const requestId = `steer-pickup:${sessionId}:${noteSeqs[0]}`;
  const runId = requestId;
  const accepted = withEventPublicationTransaction(() => {
    const claimed = claimHarnessChatRequestInTransaction(openEventLog(), { requestId, sessionId, runId,
      inputHash: createHash('sha256').update(JSON.stringify({ noteSeqs, message })).digest('hex'),
      sinceSeq: getLatestEventSeq(sessionId) });
    if (!claimed.inserted) return null;
    appendEvent({ sessionId, turn: 0, role: 'system', type: 'user_steer_note_delivered', data: { noteSeqs, followUp: true } });
    const turn = Number((getSession(sessionId)?.metadata as { __turn?: unknown } | undefined)?.__turn) || 0;
    return acceptUserInputForRun({ sessionId, turn: turn + 1, role: 'user', data: {
      text: message, displayText: message, runId, source: 'steer_follow_up', steerNoteSeqs: noteSeqs,
    } });
  });
  if (!accepted) return 'none';
  updateSession(sessionId, { status: 'active' });
  const channel = getSession(sessionId)?.channel ?? 'desktop';
  logger.info({ sessionId, noteSeqs }, 'An unowned message starts the conversation\'s next turn');
  await respond({ sessionId, channel, message, sourceUserSeq: accepted.seq, runId });
  return 'started';
}

const inFlight = new Set<string>();

/** One sweep: every conversation with a recent note no work will adopt. */
export function sweepUnownedSteerNotes(nowMs = Date.now()): string[] {
  if (!respondImpl) return [];
  let sessions: string[] = [];
  try {
    const since = new Date(nowMs - LOOKBACK_MS).toISOString();
    sessions = (openEventLog().prepare(`SELECT DISTINCT session_id AS id FROM events
      WHERE type = 'user_steer_note' AND created_at >= ?`).all(since) as Array<{ id: string }>).map((row) => row.id);
  } catch { return []; }
  const started: string[] = [];
  for (const sessionId of sessions) {
    if (inFlight.has(sessionId) || unownedSteerNotes(sessionId, nowMs).length === 0) continue;
    inFlight.add(sessionId);
    started.push(sessionId);
    void pickUpUnownedSteerNotes(sessionId, nowMs)
      .catch((error: unknown) => logger.warn({ sessionId, err: error instanceof Error ? error.message : String(error) },
        'An unowned message could not start its turn'))
      .finally(() => inFlight.delete(sessionId));
  }
  return started;
}

let timer: NodeJS.Timeout | null = null;
export function startSteerPickupSweep(): void {
  if (timer) return;
  timer = setInterval(() => { try { sweepUnownedSteerNotes(); } catch { /* the next sweep tries again */ } }, SWEEP_MS);
  timer.unref();
}
