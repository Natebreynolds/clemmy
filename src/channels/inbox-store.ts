import { openMemoryDb } from '../memory/db.js';

/**
 * Channel-message inbox.
 *
 * Solves three reliability gaps on the inbound path:
 *  1. Idempotency. Discord (and dashboard reconnects) can redeliver
 *     the same provider message id; without a dedup key we'd run the
 *     model twice and reply twice.
 *  2. Restart durability. If the daemon dies between "received" and
 *     "replied", the row survives so a future replay can finish the
 *     reply instead of dropping it on the floor.
 *  3. Observability. Every inbound message gets a row with status
 *     transitions and attempt count — useful when chasing "Clemmy went
 *     silent" reports.
 *
 * Zero LLM tokens. Pure local SQLite (better-sqlite3 already in deps,
 * shared memory.db so we don't open a second connection).
 */

export type InboundStatus = 'received' | 'claimed' | 'replied' | 'failed' | 'dropped';

export interface InboundRecord {
  channel: string;
  sourceMessageId: string;
  sessionId?: string;
  userId?: string;
  runId?: string;
  payloadHash?: string;
  sourceUserSeq?: number;
  status: InboundStatus;
  attempts: number;
  error?: string;
  receivedAt: string;
  claimedAt?: string;
  completedAt?: string;
}

interface InboundRow {
  channel: string;
  source_message_id: string;
  session_id: string | null;
  user_id: string | null;
  run_id: string | null;
  payload_hash: string | null;
  source_user_seq: number | null;
  status: InboundStatus;
  attempts: number;
  error: string | null;
  received_at: string;
  claimed_at: string | null;
  completed_at: string | null;
}

function rowToRecord(row: InboundRow): InboundRecord {
  return {
    channel: row.channel,
    sourceMessageId: row.source_message_id,
    sessionId: row.session_id ?? undefined,
    userId: row.user_id ?? undefined,
    runId: row.run_id ?? undefined,
    payloadHash: row.payload_hash ?? undefined,
    sourceUserSeq: row.source_user_seq ?? undefined,
    status: row.status,
    attempts: row.attempts,
    error: row.error ?? undefined,
    receivedAt: row.received_at,
    claimedAt: row.claimed_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
  };
}

export interface ClaimInput {
  channel: string;
  sourceMessageId: string;
  sessionId?: string;
  userId?: string;
  /** Stable provider-derived run identity. Required for every v31+ claim. */
  runId: string;
  /** Canonical hash of the complete authority-bearing provider payload. */
  payloadHash: string;
}

export const LEGACY_INBOUND_QUARANTINE_REASON = 'legacy_inbound_without_durable_identity_v31_quarantine';

export class InboundIdentityConflictError extends Error {
  constructor(message = 'provider message id is already bound to a different inbound request') {
    super(message);
    this.name = 'InboundIdentityConflictError';
  }
}

function assertCompatibleIdentity(
  existing: InboundRow,
  input: Pick<ClaimInput, 'sessionId' | 'userId'> & Partial<Pick<ClaimInput, 'runId' | 'payloadHash'>>,
): void {
  const conflicts = (
    (existing.session_id !== null && input.sessionId !== undefined && existing.session_id !== input.sessionId)
    || (existing.user_id !== null && input.userId !== undefined && existing.user_id !== input.userId)
    || (existing.run_id !== null && input.runId !== undefined && existing.run_id !== input.runId)
    || (existing.payload_hash !== null && input.payloadHash !== undefined && existing.payload_hash !== input.payloadHash)
  );
  if (conflicts) throw new InboundIdentityConflictError();
}

export interface ClaimResult {
  /** True when the row was newly inserted; false when a prior row
   *  already exists for this (channel, sourceMessageId). */
  isNew: boolean;
  /** Whether the caller should proceed to run the model. False when
   *  the message has already been replied or dropped. */
  shouldProcess: boolean;
  record: InboundRecord;
}

/**
 * Attempt to claim an inbound message for processing. Returns whether
 * the caller should proceed.
 *
 * - First sighting → insert row as 'claimed', shouldProcess = true.
 * - Already 'replied' / 'dropped' → shouldProcess = false. Caller
 *   should skip silently (the user already got their answer).
 * - Already freshly 'claimed' → shouldProcess = false. Another local
 *   path is probably processing the same provider message right now.
 * - Already stale 'claimed' or 'failed' → shouldProcess = true,
 *   attempts++. Treated as a retry because a stuck row from a crashed
 *   run is a real recovery path.
 */
export function claimInbound(input: ClaimInput): ClaimResult {
  const db = openMemoryDb();
  const now = new Date().toISOString();
  const runId = input.runId.trim();
  const payloadHash = input.payloadHash.trim();
  if (!runId) throw new Error('runId is required for provider inbox claims');
  if (!payloadHash) throw new Error('payloadHash is required for provider inbox claims');
  const authorityInput: ClaimInput = { ...input, runId, payloadHash };

  const insert = db.prepare(`
    INSERT INTO inbound_messages
      (channel, source_message_id, session_id, user_id, run_id, payload_hash,
       status, attempts, received_at, claimed_at)
    VALUES (?, ?, ?, ?, ?, ?, 'claimed', 1, ?, ?)
    ON CONFLICT(channel, source_message_id) DO NOTHING
  `);
  const result = insert.run(
    authorityInput.channel,
    authorityInput.sourceMessageId,
    authorityInput.sessionId ?? null,
    authorityInput.userId ?? null,
    authorityInput.runId,
    authorityInput.payloadHash,
    now,
    now,
  );

  if (result.changes === 1) {
    const row = db.prepare(
      'SELECT * FROM inbound_messages WHERE channel = ? AND source_message_id = ?',
    ).get(authorityInput.channel, authorityInput.sourceMessageId) as InboundRow;
    return { isNew: true, shouldProcess: true, record: rowToRecord(row) };
  }

  const existing = db.prepare(
    'SELECT * FROM inbound_messages WHERE channel = ? AND source_message_id = ?',
  ).get(authorityInput.channel, authorityInput.sourceMessageId) as InboundRow;

  // Replied/dropped history is already inert. Historical pre-v31 rows have no
  // payload authority, so do not "helpfully" backfill them on redelivery: that
  // would erase the evidence that the old request was unbound. Current rows
  // retain strict payload/run conflict checks.
  if (existing.status === 'replied' || existing.status === 'dropped') {
    if (existing.payload_hash !== null) assertCompatibleIdentity(existing, authorityInput);
    return { isNew: false, shouldProcess: false, record: rowToRecord(existing) };
  }

  // A claimed/failed row without v31's payload hash may have executed an
  // external side effect before the old daemon stopped, but it cannot prove
  // which logical source owned that work. Quarantine it BEFORE filling any
  // null identity fields, making every later retry inert.
  if ((existing.status === 'claimed' || existing.status === 'failed') && existing.payload_hash === null) {
    db.prepare(
      `UPDATE inbound_messages
          SET status = 'dropped',
              error = CASE
                WHEN error IS NULL OR trim(error) = '' THEN ?
                ELSE error || ' | ' || ?
              END,
              completed_at = COALESCE(completed_at, ?)
        WHERE channel = ? AND source_message_id = ?
          AND status IN ('claimed', 'failed') AND payload_hash IS NULL`,
    ).run(
      LEGACY_INBOUND_QUARANTINE_REASON,
      LEGACY_INBOUND_QUARANTINE_REASON,
      now,
      authorityInput.channel,
      authorityInput.sourceMessageId,
    );
    const quarantined = db.prepare(
      'SELECT * FROM inbound_messages WHERE channel = ? AND source_message_id = ?',
    ).get(authorityInput.channel, authorityInput.sourceMessageId) as InboundRow;
    return { isNew: false, shouldProcess: false, record: rowToRecord(quarantined) };
  }

  assertCompatibleIdentity(existing, authorityInput);

  // The first durable claim may know the provider run before a target harness
  // session is selected (for example, an approval id chooses an older paused
  // session). Bind only previously-null fields; an established identity is
  // immutable and was validated above.
  if (
    (existing.session_id === null && authorityInput.sessionId !== undefined)
    || (existing.user_id === null && authorityInput.userId !== undefined)
    || existing.run_id === null
    || existing.payload_hash === null
  ) {
    db.prepare(
      `UPDATE inbound_messages
          SET session_id = COALESCE(session_id, ?),
              user_id = COALESCE(user_id, ?),
              run_id = COALESCE(run_id, ?),
              payload_hash = COALESCE(payload_hash, ?)
        WHERE channel = ? AND source_message_id = ?`,
    ).run(
      authorityInput.sessionId ?? null,
      authorityInput.userId ?? null,
      authorityInput.runId,
      authorityInput.payloadHash,
      authorityInput.channel,
      authorityInput.sourceMessageId,
    );
    const rebound = db.prepare(
      'SELECT * FROM inbound_messages WHERE channel = ? AND source_message_id = ?',
    ).get(authorityInput.channel, authorityInput.sourceMessageId) as InboundRow;
    Object.assign(existing, rebound);
  }

  // Concurrent-second-claim guard: a row that's already 'claimed' AND
  // freshly so (claimed_at within the last few minutes) means another
  // code path inside THIS daemon is currently processing the same
  // message. Refuse the second claim so the gateway-path and the
  // DM-polling path don't both spawn a session for one Discord message.
  // The bug this fixes: handleDiscordHarnessMessage (gateway) and
  // runDiscordHarnessConversation (polling) BOTH fire for DMs in some
  // intents-mix configurations; without this guard the user saw 2-3
  // "Orchestrator working…" messages per ask and the model burned 2-3×
  // the tokens.
  if (existing.status === 'claimed' && existing.claimed_at) {
    const claimedAt = Date.parse(existing.claimed_at);
    const FRESH_CLAIM_WINDOW_MS = 5 * 60_000;
    if (!Number.isNaN(claimedAt) && Date.now() - claimedAt < FRESH_CLAIM_WINDOW_MS) {
      return { isNew: false, shouldProcess: false, record: rowToRecord(existing) };
    }
  }

  // Stale-claim retry path: a 'claimed' row older than the fresh window
  // (or status 'failed') is the signal that a prior run crashed mid-reply.
  // Bump attempts and re-claim so a future restart-replay can finish.
  db.prepare(
    `UPDATE inbound_messages
        SET status = 'claimed', attempts = attempts + 1, claimed_at = ?
      WHERE channel = ? AND source_message_id = ?`,
  ).run(now, authorityInput.channel, authorityInput.sourceMessageId);

  const reclaimed = db.prepare(
    'SELECT * FROM inbound_messages WHERE channel = ? AND source_message_id = ?',
  ).get(authorityInput.channel, authorityInput.sourceMessageId) as InboundRow;
  return { isNew: false, shouldProcess: true, record: rowToRecord(reclaimed) };
}

export interface CompleteInput {
  channel: string;
  sourceMessageId: string;
  runId?: string;
  status: 'replied' | 'failed' | 'dropped';
  error?: string;
}

export function bindInboundSource(input: {
  channel: string;
  sourceMessageId: string;
  sessionId: string;
  runId: string;
  sourceUserSeq: number;
}): InboundRecord {
  if (!Number.isSafeInteger(input.sourceUserSeq) || input.sourceUserSeq <= 0) {
    throw new Error('sourceUserSeq must be a positive integer');
  }
  const db = openMemoryDb();
  const tx = db.transaction(() => {
    const existing = db.prepare(
      'SELECT * FROM inbound_messages WHERE channel = ? AND source_message_id = ?',
    ).get(input.channel, input.sourceMessageId) as InboundRow | undefined;
    if (!existing) throw new Error('inbound message claim not found');
    assertCompatibleIdentity(existing, input);
    if (existing.source_user_seq !== null && existing.source_user_seq !== input.sourceUserSeq) {
      throw new InboundIdentityConflictError('provider message id is already bound to a different source user event');
    }
    db.prepare(
      `UPDATE inbound_messages
          SET session_id = COALESCE(session_id, ?),
              run_id = COALESCE(run_id, ?),
              source_user_seq = COALESCE(source_user_seq, ?)
        WHERE channel = ? AND source_message_id = ?`,
    ).run(input.sessionId, input.runId, input.sourceUserSeq, input.channel, input.sourceMessageId);
    return db.prepare(
      'SELECT * FROM inbound_messages WHERE channel = ? AND source_message_id = ?',
    ).get(input.channel, input.sourceMessageId) as InboundRow;
  });
  return rowToRecord(tx.immediate());
}

export function completeInbound(input: CompleteInput): void {
  const db = openMemoryDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE inbound_messages
        SET status = ?, run_id = COALESCE(?, run_id), error = ?, completed_at = ?
      WHERE channel = ? AND source_message_id = ?`,
  ).run(
    input.status,
    input.runId ?? null,
    input.error ?? null,
    now,
    input.channel,
    input.sourceMessageId,
  );
}

export function getInbound(channel: string, sourceMessageId: string): InboundRecord | undefined {
  const db = openMemoryDb();
  const row = db.prepare(
    'SELECT * FROM inbound_messages WHERE channel = ? AND source_message_id = ?',
  ).get(channel, sourceMessageId) as InboundRow | undefined;
  return row ? rowToRecord(row) : undefined;
}

export function listInbound(opts: { status?: InboundStatus; limit?: number } = {}): InboundRecord[] {
  const db = openMemoryDb();
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const rows = opts.status
    ? db.prepare(
        'SELECT * FROM inbound_messages WHERE status = ? ORDER BY received_at DESC LIMIT ?',
      ).all(opts.status, limit) as InboundRow[]
    : db.prepare(
        'SELECT * FROM inbound_messages ORDER BY received_at DESC LIMIT ?',
      ).all(limit) as InboundRow[];
  return rows.map(rowToRecord);
}
