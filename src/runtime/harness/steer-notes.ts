/**
 * Mid-run steering (2026-08-07) — user messages reach a RUNNING turn without
 * stopping it.
 *
 * Before this lane existed, a chat message sent while a session had an active
 * attempt SUPERSEDED that attempt (claimRunAttemptLease retires the prior
 * row), so the only mid-run controls were "wait" or "kill". Users steering a
 * long run — adding context, correcting course — destroyed the very work they
 * were steering (the owner's ask, live 2026-08-07: "steer Clem or add context
 * while Clem is working without stopping the run").
 *
 * Mechanism: the chat route appends a durable `user_steer_note` event instead
 * of claiming a competing attempt; the shared tool-result boundary (brackets —
 * every wrapped tool on every lane) delivers undelivered notes verbatim to the
 * model alongside the next tool result, then marks them delivered with a
 * durable `user_steer_note_delivered` marker so a note is injected exactly
 * once. Steering is CONTEXT, not authority: the injected block says so, and
 * every effect gate (approvals, send lock, destructive gate) is untouched —
 * a note that asks for a new external effect meets the same gates the
 * original objective did.
 */
import { appendEvent, listEvents } from './eventlog.js';

export interface SteerNote {
  seq: number;
  text: string;
  createdAt?: string;
}

const MAX_NOTES_PER_DELIVERY = 5;
const MAX_NOTE_CHARS = 2_000;

/** Sessions whose runs a user can steer from a chat surface. Background/cron
 *  agent sessions have no live human typing into them. */
export function sessionSupportsSteering(sessionId: string | undefined): boolean {
  return typeof sessionId === 'string' && /^(?:sess-|space-|discord-)/.test(sessionId);
}

export function appendSteerNote(sessionId: string, text: string): { seq: number } {
  const trimmed = text.trim().slice(0, MAX_NOTE_CHARS);
  const row = appendEvent({
    sessionId,
    turn: 0,
    role: 'user',
    type: 'user_steer_note',
    data: { text: trimmed },
  });
  return { seq: row.seq };
}

/**
 * Read the notes not yet delivered to the model and durably mark them
 * delivered. The marker is written BEFORE the caller injects the text: if the
 * process dies between marker and injection the note is lost from the model's
 * view but still visible in the transcript — the safe failure direction
 * (duplicated steering instructions caused double-application in testing).
 */
export function takeUndeliveredSteerNotes(sessionId: string | undefined): SteerNote[] {
  if (!sessionSupportsSteering(sessionId)) return [];
  try {
    const rows = listEvents(sessionId as string, {
      types: ['user_steer_note', 'user_steer_note_delivered'],
    });
    const delivered = new Set<number>();
    for (const row of rows) {
      if (row.type !== 'user_steer_note_delivered') continue;
      const seqs = (row.data as { noteSeqs?: unknown }).noteSeqs;
      if (Array.isArray(seqs)) for (const seq of seqs) if (typeof seq === 'number') delivered.add(seq);
    }
    const pending = rows
      .filter((row) => row.type === 'user_steer_note' && !delivered.has(row.seq))
      .map((row) => ({
        seq: row.seq,
        text: String((row.data as { text?: unknown }).text ?? '').trim(),
        createdAt: row.createdAt,
      }))
      .filter((note) => note.text.length > 0)
      .slice(-MAX_NOTES_PER_DELIVERY);
    if (pending.length === 0) return [];
    appendEvent({
      sessionId: sessionId as string,
      turn: 0,
      role: 'system',
      type: 'user_steer_note_delivered',
      data: { noteSeqs: pending.map((note) => note.seq) },
    });
    return pending;
  } catch {
    return []; // steering must never break a tool result
  }
}

/** The model-facing block appended to the next tool result. Verbatim user
 *  words first; the frame is a DIRECTIVE (allowed), not voice-cosplay. */
export function formatSteerBlock(notes: SteerNote[]): string {
  if (notes.length === 0) return '';
  const quoted = notes
    .map((note) => `- "${note.text}"`)
    .join('\n');
  return [
    '',
    '',
    '[MID-RUN MESSAGE FROM THE USER — arrived while you were working]',
    quoted,
    'Incorporate this NOW: adjust course and use the added context for the rest of the run, and briefly acknowledge it in your next visible update. It refines the current objective — it does not replace it unless it clearly says so. If it asks to stop, stop cleanly and report state. Any NEW external effect it introduces still takes the normal approval path.',
  ].join('\n');
}

/** One-call composition for the tool-result boundary. Returns '' when there is
 *  nothing to deliver (the overwhelmingly common case — one indexed read). */
export function steerBlockForToolBoundary(sessionId: string | undefined): string {
  return formatSteerBlock(takeUndeliveredSteerNotes(sessionId));
}
