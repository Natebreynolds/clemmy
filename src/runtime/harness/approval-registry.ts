/**
 * Approval registry — the addressable replacement for the implicit
 * "loadInterruptState() exists" check that was the entire approval
 * state machine before this module.
 *
 * Why this exists: the audit on 2026-05-18 found three orphan paused
 * sessions, including the "save Salesforce CLI rule to memory" approval
 * from earlier today. The user's "approve" landed on a different
 * paused session (the memory_search one) because the channel-level
 * routing assumed "the only paused session is the right one." With
 * multiple concurrent approvals — easy to reach in practice — that
 * heuristic loses work. The fix:
 *
 *   - Every `approval_requested` event also registers a row in
 *     `pending_approvals` with a short addressable ID (`apr-xy7q`)
 *     and an explicit `expires_at`.
 *   - The approval prompt shown to the user INCLUDES the ID so they
 *     can resolve a specific one ("approve apr-xy7q") when multiple
 *     are pending.
 *   - A background reaper expires stale rows, never silently leaves
 *     a session paused forever.
 *
 * This module is the data layer; the reaper, the chat-surface routing,
 * and the loop integration live in their own modules (reaper.ts,
 * discord-harness.ts, loop.ts).
 *
 * Gating: flag `HARNESS_APPROVAL_REGISTRY=on` controls whether the
 * channel-routing code consults this registry. The DB writes happen
 * regardless so a flag flip mid-session doesn't lose pending rows.
 */

import { randomBytes } from 'node:crypto';
import { openEventLog } from './eventlog.js';
import { markNotificationsReadByApprovalId } from '../notifications.js';
import { updateToolChoiceOutcomeForIdentifier } from '../../memory/tool-choice-store.js';
import { linkPendingActionApproval, markPendingActionApprovalResolved } from './pending-actions.js';
import { appendAuditRecord } from '../audit-ledger.js';

/**
 * The tool-choice identifier an approval maps to (Thread 2 — outcome loop).
 * For the composio wrapper the proven choice stores the action SLUG (in args),
 * not the wrapper name; an MCP/CLI tool's name IS the stored identifier.
 */
function approvalChoiceIdentifier(tool: string | null, args: Record<string, unknown> | null): string | null {
  if (!tool) return null;
  if (tool === 'composio_execute_tool') {
    return args && typeof args.tool_slug === 'string' && args.tool_slug.trim() ? args.tool_slug.trim() : null;
  }
  return tool;
}

export type PendingApprovalStatus = 'pending' | 'resolved' | 'expired' | 'cancelled';
export type ApprovalResolution = 'approved' | 'rejected' | 'expired' | 'cancelled_by_user';

export interface PendingApprovalRow {
  approvalId: string;
  sessionId: string;
  channel: string | null;
  channelId: string | null;
  requestedAt: string;
  expiresAt: string;
  subject: string;
  tool: string | null;
  args: Record<string, unknown> | null;
  status: PendingApprovalStatus;
  resolution: ApprovalResolution | null;
  resolver: string | null;
  resolvedAt: string | null;
  /** Opaque workflow SDK key for exact-tool park/resume. Never user-authored. */
  resumeKey: string | null;
  /** Set atomically when an approved parked payload is reused. */
  consumedAt: string | null;
}

export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export function isExpired(row: Pick<PendingApprovalRow, 'expiresAt'>, now: Date = new Date()): boolean {
  const expiresAt = Date.parse(row.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt < now.getTime();
}

export function isActionable(row: PendingApprovalRow, now: Date = new Date()): boolean {
  return row.status === 'pending' && !isExpired(row, now);
}

/**
 * Generic post-resolution hook. A subsystem can react to an approval being
 * resolved WITHOUT this data layer importing it — keeps the registry
 * dependency-free (the comment at the top: "routing lives in their own
 * modules"). Workspaces use this to EXECUTE a gated Space action the moment the
 * user approves it: a button click has no agent turn to resume, so the work
 * must happen on resolve. Fires for every resolution (approved/rejected/
 * expired/cancelled) across every approve path — desktop, mobile, chat-dock —
 * because they all funnel through resolve(). Best-effort: a listener throwing
 * must never break resolution.
 */
export type ApprovalResolvedListener = (row: PendingApprovalRow) => void;
const resolvedListeners: ApprovalResolvedListener[] = [];

export function onApprovalResolved(listener: ApprovalResolvedListener): void {
  if (!resolvedListeners.includes(listener)) resolvedListeners.push(listener);
}

function emitResolved(row: PendingApprovalRow): void {
  for (const fn of resolvedListeners) {
    try { fn(row); } catch { /* a listener must never break resolution */ }
  }
}

export interface RegisterApprovalInput {
  sessionId: string;
  channel?: string | null;
  channelId?: string | null;
  subject: string;
  tool?: string | null;
  args?: Record<string, unknown> | null;
  ttlMs?: number;
  /** Opaque exact-payload key used only by durable workflow SDK parking. */
  resumeKey?: string | null;
}

interface ApprovalSqlRow {
  approval_id: string;
  session_id: string;
  channel: string | null;
  channel_id: string | null;
  requested_at: string;
  expires_at: string;
  subject: string;
  tool: string | null;
  args_json: string | null;
  status: PendingApprovalStatus;
  resolution: ApprovalResolution | null;
  resolver: string | null;
  resolved_at: string | null;
  resume_key: string | null;
  consumed_at: string | null;
}

function rowToPublic(row: ApprovalSqlRow): PendingApprovalRow {
  return {
    approvalId: row.approval_id,
    sessionId: row.session_id,
    channel: row.channel,
    channelId: row.channel_id,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    subject: row.subject,
    tool: row.tool,
    args: row.args_json ? safeParse(row.args_json) : null,
    status: row.status,
    resolution: row.resolution,
    resolver: row.resolver,
    resolvedAt: row.resolved_at,
    resumeKey: row.resume_key,
    consumedAt: row.consumed_at,
  };
}

function safeParse(json: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function pendingActionIdFromArgs(args: Record<string, unknown> | null): string | null {
  const direct = args?.pendingActionId ?? args?.pending_action_id;
  return typeof direct === 'string' && direct.trim() ? direct.trim() : null;
}

/**
 * Generate a short prefixed approval ID. Format: `apr-xy7q` (4 chars
 * base36 hex-ish, distinct enough for the surface display + tight
 * enough for the user to type). Collisions are checked by the PK.
 */
function newApprovalId(): string {
  // 24 bits → ~16M space; we pick 4 base36 chars (~1.6M) which is
  // plenty for concurrent approvals on a single machine.
  const bytes = randomBytes(3);
  let n = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
  const out: string[] = [];
  for (let i = 0; i < 4; i++) {
    out.push((n % 36).toString(36));
    n = Math.floor(n / 36);
  }
  return `apr-${out.join('')}`;
}

/**
 * Register a new pending approval. Returns the row (with the freshly
 * generated approval ID). Called from the harness loop at the same
 * point as `approval_requested` event emission.
 */
export function register(input: RegisterApprovalInput): PendingApprovalRow {
  const db = openEventLog();
  const now = new Date();
  const ttl = input.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttl);

  // Retry on collision (extremely unlikely but the PK enforces it).
  for (let attempt = 0; attempt < 4; attempt++) {
    const approvalId = newApprovalId();
    try {
      db.prepare(`
        INSERT INTO pending_approvals
          (approval_id, session_id, channel, channel_id, requested_at,
           expires_at, subject, tool, args_json, status, resume_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        approvalId,
        input.sessionId,
        input.channel ?? null,
        input.channelId ?? null,
        now.toISOString(),
        expiresAt.toISOString(),
        input.subject,
        input.tool ?? null,
        input.args ? JSON.stringify(input.args) : null,
        input.resumeKey ?? null,
      );
      const row = db.prepare('SELECT * FROM pending_approvals WHERE approval_id = ?').get(approvalId) as ApprovalSqlRow;
      const publicRow = rowToPublic(row);
      try {
        const pendingActionId = pendingActionIdFromArgs(publicRow.args);
        if (pendingActionId) linkPendingActionApproval(pendingActionId, publicRow.approvalId);
      } catch {
        // Approval registration is the source of truth; pending-action linkage is best-effort.
      }
      return publicRow;
    } catch (err) {
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') continue;
      throw err;
    }
  }
  throw new Error('approval-registry: failed to generate a unique approval ID after 4 attempts');
}

/**
 * Register one durable workflow approval for an exact payload. The partial
 * unique index makes this idempotent under process/thread races: a second
 * caller receives the already-pending row and must not surface another card.
 */
export function registerResumable(
  input: RegisterApprovalInput & { resumeKey: string },
): { row: PendingApprovalRow; created: boolean } {
  const db = openEventLog();
  const existing = db.prepare(`
    SELECT * FROM pending_approvals
     WHERE resume_key = ? AND status = 'pending'
     ORDER BY requested_at DESC, rowid DESC
     LIMIT 1
  `).get(input.resumeKey) as ApprovalSqlRow | undefined;
  if (existing) return { row: rowToPublic(existing), created: false };

  try {
    return { row: register(input), created: true };
  } catch (err) {
    // Another process may have inserted the same pending resume key between
    // the lookup and INSERT. Return that row; any other failure remains loud.
    const code = (err as { code?: string }).code ?? '';
    if (!code.startsWith('SQLITE_CONSTRAINT')) throw err;
    const raced = db.prepare(`
      SELECT * FROM pending_approvals
       WHERE resume_key = ? AND status = 'pending'
       ORDER BY requested_at DESC, rowid DESC
       LIMIT 1
    `).get(input.resumeKey) as ApprovalSqlRow | undefined;
    if (!raced) throw err;
    return { row: rowToPublic(raced), created: false };
  }
}

export type ResumableApprovalClaim =
  | { state: 'none' }
  | { state: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'consumed'; row: PendingApprovalRow };

/**
 * Inspect and, for an approved row, atomically consume the exact-payload grant.
 * Only the first caller receives `approved`; every later caller sees `consumed`.
 * Rejected/expired/cancelled decisions remain terminal for this parked step and
 * can never be replaced by a silently minted approval.
 */
export function claimResumableApproval(resumeKey: string): ResumableApprovalClaim {
  const db = openEventLog();
  const claim = db.transaction((): ResumableApprovalClaim => {
    const row = db.prepare(`
      SELECT * FROM pending_approvals
       WHERE resume_key = ?
       ORDER BY requested_at DESC, rowid DESC
       LIMIT 1
    `).get(resumeKey) as ApprovalSqlRow | undefined;
    if (!row) return { state: 'none' };

    const current = rowToPublic(row);
    if (current.status === 'pending' && isExpired(current)) {
      const expired = resolve(current.approvalId, 'expired', 'approval-resume');
      return { state: 'expired', row: expired.row ?? current };
    }
    if (current.status === 'pending') return { state: 'pending', row: current };
    if (current.resolution === 'rejected') return { state: 'rejected', row: current };
    if (current.resolution === 'expired' || current.status === 'expired') return { state: 'expired', row: current };
    if (current.resolution === 'cancelled_by_user' || current.status === 'cancelled') {
      return { state: 'cancelled', row: current };
    }
    if (current.resolution !== 'approved') return { state: 'expired', row: current };
    if (current.consumedAt) return { state: 'consumed', row: current };

    const consumedAt = new Date().toISOString();
    const changes = db.prepare(`
      UPDATE pending_approvals
         SET consumed_at = ?
       WHERE approval_id = ?
         AND status = 'resolved'
         AND resolution = 'approved'
         AND consumed_at IS NULL
    `).run(consumedAt, current.approvalId).changes;
    const claimed = db.prepare('SELECT * FROM pending_approvals WHERE approval_id = ?')
      .get(current.approvalId) as ApprovalSqlRow;
    return {
      state: changes === 1 ? 'approved' : 'consumed',
      row: rowToPublic(claimed),
    };
  });
  return claim();
}

/**
 * Claim the newest resolved-approved, unconsumed approval for a SESSION,
 * restricted to replay-supported tools. This is the re-admission twin of
 * `claimResumableApproval`: that one matches by exact-payload hash, which a
 * re-run model that re-composes its payload can never reproduce (the 2026-07-21
 * approve→re-ask treadmill: 3 approvals granted, 0 consumed, nothing sent).
 * On re-admission the runner claims the APPROVED payload itself and replays it
 * verbatim — same atomic one-shot consume, so a racing duplicate re-admission
 * can never double-execute, and rejected/expired rows are never touched.
 */
export function claimApprovedUnconsumedForSession(
  sessionId: string,
  opts: { tools: string[] },
): PendingApprovalRow | null {
  if (opts.tools.length === 0) return null;
  const db = openEventLog();
  const placeholders = opts.tools.map(() => '?').join(',');
  const claim = db.transaction((): PendingApprovalRow | null => {
    const row = db.prepare(`
      SELECT * FROM pending_approvals
       WHERE session_id = ?
         AND status = 'resolved'
         AND resolution = 'approved'
         AND consumed_at IS NULL
         AND tool IN (${placeholders})
       ORDER BY resolved_at DESC, rowid DESC
       LIMIT 1
    `).get(sessionId, ...opts.tools) as ApprovalSqlRow | undefined;
    if (!row) return null;
    const current = rowToPublic(row);
    const changes = db.prepare(`
      UPDATE pending_approvals
         SET consumed_at = ?
       WHERE approval_id = ?
         AND status = 'resolved'
         AND resolution = 'approved'
         AND consumed_at IS NULL
    `).run(new Date().toISOString(), current.approvalId).changes;
    if (changes !== 1) return null;
    const claimed = db.prepare('SELECT * FROM pending_approvals WHERE approval_id = ?')
      .get(current.approvalId) as ApprovalSqlRow;
    return rowToPublic(claimed);
  });
  return claim();
}

/**
 * Look up an approval by ID. Returns undefined when not found.
 */
export function get(approvalId: string): PendingApprovalRow | undefined {
  const db = openEventLog();
  const row = db.prepare('SELECT * FROM pending_approvals WHERE approval_id = ?')
    .get(approvalId) as ApprovalSqlRow | undefined;
  return row ? rowToPublic(row) : undefined;
}

/**
 * List approvals that match the filter. Used by the chat-surface
 * routing to figure out whether a bare "approve" should resolve THIS
 * channel's one-and-only pending, OR demand an explicit `apr-xxx`
 * code because there are several.
 *
 * Default filter: `status='pending'`. Pass `status: 'any'` to include
 * resolved/expired rows (the dashboard panel uses this for history).
 */
export interface ListFilter {
  status?: PendingApprovalStatus | 'any';
  sessionId?: string;
  channelId?: string;
  channel?: string;
}

export function listPending(filter: ListFilter = {}): PendingApprovalRow[] {
  const db = openEventLog();
  const conditions: string[] = [];
  const params: unknown[] = [];
  const status = filter.status ?? 'pending';
  if (status !== 'any') {
    conditions.push('status = ?');
    params.push(status);
  }
  if (filter.sessionId) {
    conditions.push('session_id = ?');
    params.push(filter.sessionId);
  }
  if (filter.channelId) {
    conditions.push('channel_id = ?');
    params.push(filter.channelId);
  }
  if (filter.channel) {
    conditions.push('channel = ?');
    params.push(filter.channel);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM pending_approvals ${where} ORDER BY requested_at DESC`)
    .all(...params) as ApprovalSqlRow[];
  return rows.map(rowToPublic);
}

/**
 * Convenience predicate. Used by every "is this session paused?"
 * call-site so the answer is single-sourced — no more three
 * disagreeing definitions of "paused".
 */
export function hasPending(sessionId: string): boolean {
  const db = openEventLog();
  const row = db
    .prepare("SELECT 1 AS hit FROM pending_approvals WHERE session_id = ? AND status = 'pending' LIMIT 1")
    .get(sessionId) as { hit: number } | undefined;
  return !!row;
}

/**
 * Resolve a pending approval. Atomic — if another caller resolved it
 * first, the second caller's `resolve` returns `{ ok: false, reason }`
 * so they can surface "already resolved by <resolver>" instead of
 * silently overwriting.
 */
export interface ResolveResult {
  ok: boolean;
  reason?: 'already_resolved' | 'not_found' | 'expired';
  row?: PendingApprovalRow;
}

export function resolve(
  approvalId: string,
  resolution: ApprovalResolution,
  resolver: string,
): ResolveResult {
  const db = openEventLog();
  const existing = db
    .prepare('SELECT * FROM pending_approvals WHERE approval_id = ?')
    .get(approvalId) as ApprovalSqlRow | undefined;
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.status !== 'pending') return { ok: false, reason: 'already_resolved', row: rowToPublic(existing) };

  // Atomic conditional update — only succeeds if status is still
  // 'pending'. Two racers can't both win.
  const nextStatus: PendingApprovalStatus = resolution === 'expired' ? 'expired' : 'resolved';
  const now = new Date().toISOString();
  const changes = db
    .prepare(`
      UPDATE pending_approvals
         SET status      = ?,
             resolution  = ?,
             resolver    = ?,
             resolved_at = ?
       WHERE approval_id = ?
         AND status      = 'pending'
    `)
    .run(nextStatus, resolution, resolver, now, approvalId).changes;
  if (changes === 0) {
    const reread = db
      .prepare('SELECT * FROM pending_approvals WHERE approval_id = ?')
      .get(approvalId) as ApprovalSqlRow;
    return { ok: false, reason: 'already_resolved', row: rowToPublic(reread) };
  }
  const row = db
    .prepare('SELECT * FROM pending_approvals WHERE approval_id = ?')
    .get(approvalId) as ApprovalSqlRow;
  try {
    markNotificationsReadByApprovalId(approvalId, {
      approvalStatus: nextStatus,
      approvalResolution: resolution,
      approvalResolver: resolver,
    });
  } catch {
    // Notification cleanup is best-effort; approval resolution is the
    // source of truth and must not fail because the dashboard queue is
    // temporarily unavailable.
  }
  // Thread 2 — feed the human's approve/reject back to procedural memory. A
  // REJECTION is the strongest distinct signal (the tool never runs, so the
  // execute-outcome loop never sees it); an approval is a soft positive
  // (usually followed by an execute success that also credits it). Flag-gated
  // no-op when off; never let it break resolution.
  if (resolution === 'approved' || resolution === 'rejected') {
    try {
      const pub = rowToPublic(row);
      const id = approvalChoiceIdentifier(pub.tool, pub.args);
      if (id) updateToolChoiceOutcomeForIdentifier(id, resolution);
    } catch {
      /* best-effort */
    }
  }
  const publicRow = rowToPublic(row);
  try {
    const pendingActionId = pendingActionIdFromArgs(publicRow.args);
    if (pendingActionId) markPendingActionApprovalResolved(pendingActionId, resolution, publicRow.approvalId);
  } catch {
    // Pending-action status is auxiliary; never break approval resolution.
  }
  // Durable audit mirror (2026-07-20 attorney-bar B3): resolutions are
  // ledgered from THIS canonical seam (not the eventlog mirror) so every
  // surface's resolve — desktop, Discord, reaper — is captured exactly once.
  try {
    appendAuditRecord({
      at: publicRow.resolvedAt ?? new Date().toISOString(),
      kind: 'approval_resolved',
      sessionId: publicRow.sessionId,
      approvalId: publicRow.approvalId,
      subject: publicRow.subject,
      tool: publicRow.tool,
      resolution: publicRow.resolution,
      resolvedBy: publicRow.resolver ?? null,
    });
  } catch { /* the ledger never blocks resolution */ }
  emitResolved(publicRow);
  return { ok: true, row: publicRow };
}

/**
 * Reaper helper. Finds pending rows past their expiry and marks them
 * expired. Returns the rows that were just expired so the caller can
 * emit user-facing notifications + clear interrupt state on each one.
 *
 * Idempotent: calling this twice for the same row is a no-op the
 * second time (the conditional UPDATE only fires when status='pending').
 */
export function expireStaleApprovals(now: Date = new Date()): PendingApprovalRow[] {
  const db = openEventLog();
  const candidates = db
    .prepare("SELECT * FROM pending_approvals WHERE status = 'pending' AND expires_at < ?")
    .all(now.toISOString()) as ApprovalSqlRow[];

  const expired: PendingApprovalRow[] = [];
  for (const row of candidates) {
    const result = resolve(row.approval_id, 'expired', 'reaper');
    if (result.ok && result.row) expired.push(result.row);
  }
  return expired;
}
