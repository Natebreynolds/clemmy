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
 * - Already 'claimed' or 'failed' → shouldProcess = true, attempts++.
 *   Treated as a retry; the caller decides whether to bail based on
 *   `attempts`. We don't refuse retries outright because a stuck
 *   'claimed' row from a crashed run is a real recovery path.
 */
export function claimInbound(input: ClaimInput): ClaimResult {
  const db = openMemoryDb();
  const now = new Date().toISOString();

  const insert = db.prepare(`
    INSERT INTO inbound_messages
      (channel, source_message_id, session_id, user_id, status, attempts, received_at, claimed_at)
    VALUES (?, ?, ?, ?, 'claimed', 1, ?, ?)
    ON CONFLICT(channel, source_message_id) DO NOTHING
  `);
  const result = insert.run(
    input.channel,
    input.sourceMessageId,
    input.sessionId ?? null,
    input.userId ?? null,
    now,
    now,
  );

  if (result.changes === 1) {
    const row = db.prepare(
      'SELECT * FROM inbound_messages WHERE channel = ? AND source_message_id = ?',
    ).get(input.channel, input.sourceMessageId) as InboundRow;
    return { isNew: true, shouldProcess: true, record: rowToRecord(row) };
  }

  const existing = db.prepare(
    'SELECT * FROM inbound_messages WHERE channel = ? AND source_message_id = ?',
  ).get(input.channel, input.sourceMessageId) as InboundRow;

  if (existing.status === 'replied' || existing.status === 'dropped') {
    return { isNew: false, shouldProcess: false, record: rowToRecord(existing) };
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
  ).run(now, input.channel, input.sourceMessageId);

  const reclaimed = db.prepare(
    'SELECT * FROM inbound_messages WHERE channel = ? AND source_message_id = ?',
  ).get(input.channel, input.sourceMessageId) as InboundRow;
  return { isNew: false, shouldProcess: true, record: rowToRecord(reclaimed) };
}

export interface CompleteInput {
  channel: string;
  sourceMessageId: string;
  runId?: string;
  status: 'replied' | 'failed' | 'dropped';
  error?: string;
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
