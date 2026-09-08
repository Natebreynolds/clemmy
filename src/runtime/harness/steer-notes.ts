import { isLiveApprovalAcknowledgement } from './accepted-source-kind.js';
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

/** Sessions whose runs a user can steer from a chat surface. Background/cron
 *  agent sessions have no live human typing into them. */
export function sessionSupportsSteering(sessionId: string | undefined): boolean {
  return typeof sessionId === 'string' && /^(?:sess-|space-|discord-)/.test(sessionId);
}

export function appendSteerNote(
  sessionId: string,
  text: string,
  options: { clientRequestId?: string | undefined } = {},
): { seq: number } {
  // Accepted owner instructions are durable input, never a presentation slice.
  const acceptedText = text;
  // A retried delivery of the SAME client request is one instruction, not two.
  // Appending it twice would show the model the same steer again and, now that
  // adopted notes shape the judged objective, count it twice there too.
  const requestId = options.clientRequestId?.trim();
  if (requestId) {
    try {
      const existing = listEvents(sessionId, { types: ['user_steer_note'] })
        .find((row) => (row.data as { clientRequestId?: unknown }).clientRequestId === requestId);
      if (existing) return { seq: existing.seq };
    } catch { /* fall through and append */ }
  }
  const row = appendEvent({
    sessionId,
    turn: 0,
    role: 'user',
    type: 'user_steer_note',
    data: { text: acceptedText, ...(requestId ? { clientRequestId: requestId } : {}) },
  });
  return { seq: row.seq };
}

/**
 * The owner's later instructions that this accepted source has ADOPTED.
 *
 * A note belongs to exactly one source: the one that was accepted before it and
 * is not yet superseded by a newer accepted source. Only DELIVERED notes count —
 * an undelivered note has not reached the model, so it cannot have changed what
 * the run is doing, and judging against it would fail work for ignoring an
 * instruction it never saw.
 */
export function adoptedSteerNotesForSource(input: {
  sessionId: string;
  sourceUserSeq: number;
}): SteerNote[] {
  try {
    const rows = listEvents(input.sessionId, {
      types: ['user_steer_note', 'user_steer_note_delivered', 'user_input_received'],
    });
    const nextSource = rows.find(
      (row) => row.type === 'user_input_received' && !isLiveApprovalAcknowledgement(row) && row.seq > input.sourceUserSeq,
    )?.seq ?? Number.MAX_SAFE_INTEGER;
    const delivered = new Set<number>();
    for (const row of rows) {
      if (row.type !== 'user_steer_note_delivered') continue;
      const seqs = (row.data as { noteSeqs?: unknown }).noteSeqs;
      if (Array.isArray(seqs)) for (const seq of seqs) if (typeof seq === 'number') delivered.add(seq);
    }
    return rows
      .filter((row) => (
        row.type === 'user_steer_note'
        && row.seq > input.sourceUserSeq
        && row.seq < nextSource
        && delivered.has(row.seq)
      ))
      .map((row) => ({
        seq: row.seq,
        text: String((row.data as { text?: unknown }).text ?? ''),
        createdAt: row.createdAt,
      }))
      .filter((note) => note.text.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * Fold adopted steering into the objective a judge evaluates.
 *
 * THE DECISIVE C31 DEFECT: the owner said "Never mind that. In one short
 * sentence: what is 9 plus 4?", Clem understood it and answered correctly — and
 * the completion judge, which only ever saw the ORIGINAL request text, ruled her
 * incomplete and pushed her back into creating the abandoned workflow.
 *
 * The original is preserved verbatim, because the historical objective and its
 * prior terminals stay immutable. What changes is that the judge is told the
 * rest of the job: the owner's later words, in the owner's own language, marked
 * as governing where they conflict. No keyword grammar decides whether a note
 * amends or replaces — the judge reads both and interprets, exactly as the
 * model does at the tool boundary.
 */
export function objectiveWithAdoptedSteering(
  originalObjective: string,
  notes: readonly SteerNote[],
): string {
  if (notes.length === 0) return originalObjective;
  return [
    originalObjective,
    '',
    'While this work was running the owner sent further instructions. They are '
      + 'part of the same job and GOVERN WHERE THEY CONFLICT with the request '
      + 'above — including telling this work to stop or change direction. Judge '
      + 'the result against what the owner now wants, not only the original '
      + 'wording:',
    ...notes.map((note) => `- "${note.text}"`),
  ].join('\n');
}

/**
 * Read the notes not yet delivered to the model and durably mark them
 * delivered. Host turns project the complete adopted same-source notes after
 * result budgeting on every model request, including reopen. Consequently a
 * crash after this marker cannot permanently hide an accepted instruction.
 * Legacy tool boundaries retain their existing delivery marker contract.
 */
export function takeUndeliveredSteerNotes(sessionId: string | undefined, sourceUserSeq?: number): SteerNote[] {
  if (!sessionSupportsSteering(sessionId)) return [];
  if (sourceUserSeq !== undefined && (!Number.isSafeInteger(sourceUserSeq) || sourceUserSeq <= 0)) return [];
  try {
    const rows = listEvents(sessionId as string, {
      types: ['user_steer_note', 'user_steer_note_delivered', 'user_input_received'],
    });
    const nextSourceSeq = sourceUserSeq === undefined ? Number.MAX_SAFE_INTEGER
      : rows.find((row) => row.type === 'user_input_received' && !isLiveApprovalAcknowledgement(row)
        && row.seq > sourceUserSeq)?.seq ?? Number.MAX_SAFE_INTEGER;
    const delivered = new Set<number>();
    for (const row of rows) {
      if (row.type !== 'user_steer_note_delivered') continue;
      const seqs = (row.data as { noteSeqs?: unknown }).noteSeqs;
      if (Array.isArray(seqs)) for (const seq of seqs) if (typeof seq === 'number') delivered.add(seq);
    }
    const pending = rows
      .filter((row) => row.type === 'user_steer_note' && !delivered.has(row.seq)
        && (sourceUserSeq === undefined || (row.seq > sourceUserSeq && row.seq < nextSourceSeq)))
      .map((row) => ({
        seq: row.seq,
        text: String((row.data as { text?: unknown }).text ?? ''),
        createdAt: row.createdAt,
      }))
      .filter((note) => note.text.trim().length > 0);
    if (pending.length === 0) return [];
    appendEvent({
      sessionId: sessionId as string,
      turn: 0,
      role: 'system',
      type: 'user_steer_note_delivered',
      data: { noteSeqs: pending.map((note) => note.seq), ...(sourceUserSeq === undefined ? {} : { sourceUserSeq }) },
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

/**
 * How long a run-in-flight marker still counts as live work for the steering
 * decision. Boot recovery routinely resumes minutes-old interrupted turns (a
 * live decision recorded ageMs 165145 and resumed successfully), so the window
 * must comfortably cover a restart; past it an orphaned marker must not keep
 * swallowing messages into notes nobody will read.
 */
export const RECOVERING_STEER_WINDOW_MS = 10 * 60 * 1000;

export type SteerReason = 'lease_live' | 'recovering_in_flight';

/**
 * Does this message reach work that is still running, or start its own turn?
 *
 * RECOVERING WORK IS STILL RUNNING WORK. A lease belongs to the process that
 * took it, so after a crash the interrupted attempt keeps an expired lease
 * while boot recovery resumes the very same work. Judging on the lease alone
 * called that turn dead: the follow-up fell through to ordinary acceptance,
 * the unsettled head made the session non-reusable, and it branched into a NEW
 * conversation while the original task went on to write.
 *
 * Live 2026-09-07: "Never mind that. In one short sentence: what is 9 plus 4?"
 * was accepted at 00:30:17 into sess-branch-0b3390df…; source 139708 issued its
 * workflow_create at 00:30:33. The steering never reached the work it was
 * aimed at.
 *
 * The run-in-flight marker is the daemon's own claim that this session has live
 * work, and it survives the crash the lease does not.
 */
export function steerReasonForRunningWork(input: {
  runInFlightSince: string | null;
  leaseExpiresAt: string | null;
  attemptFinishedAt: string | null;
  /** An attempt exists for this session and has NOT finished. */
  hasUnfinishedAttempt: boolean;
  nowMs: number;
}): SteerReason | null {
  if (
    !input.attemptFinishedAt
    && input.leaseExpiresAt
    && Date.parse(input.leaseExpiresAt) > input.nowMs
  ) return 'lease_live';

  // The marker alone is NOT enough. Measured 2026-09-07 01:21: a resume
  // attempt finished at 01:21:09 while the run-in-flight marker was still
  // armed; a follow-up sent in that gap steered into a note no running turn
  // would ever read, and the user got no answer at all. An unfinished attempt
  // is the positive evidence that something is actually there to receive it.
  if (!input.hasUnfinishedAttempt) return null;
  if (!input.runInFlightSince) return null;
  const age = input.nowMs - Date.parse(input.runInFlightSince);
  return Number.isFinite(age) && age >= 0 && age < RECOVERING_STEER_WINDOW_MS
    ? 'recovering_in_flight'
    : null;
}
