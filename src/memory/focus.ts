import { openMemoryDb, type FocusRow, type FocusStatus } from './db.js';
import { actionBus } from '../runtime/action-bus.js';

/**
 * Current Focus — the assistant's working-memory attention pointer.
 *
 * Distinct from:
 *   - GOALS (long-term, vault-backed, weeks/months span)
 *   - FACTS (durable, semantic, no lifecycle)
 *   - SESSIONS (transactional, one conversation thread)
 *
 * Focus = "what the user is actively working on RIGHT NOW." Survives
 * across Discord channels, desktop chat, and session boundaries.
 *
 * Invariants (enforced by DB partial unique index):
 *   - At most ONE row may be status='active' at any time.
 *   - Switching focus parks the current active first.
 *
 * Lifecycle (model-driven via the focus_* tool surface):
 *   - createFocus({...}) — parks any current active, inserts new active
 *   - touchFocus(id) — bump last_touched_at + extend confirm_after
 *   - parkFocus(id, reason?) — flip 'active' to 'paused' for later resume
 *   - activateFocus(id) — flip a 'paused' row back to 'active' (parks
 *     any current active first)
 *   - clearFocus(id) — flip to 'completed' (resolves naturally) or
 *     'abandoned' (user dropped it)
 *
 * Confirm-after: when now > confirm_after, the next getFocusSnapshot
 * call returns needsConfirm=true. The orchestrator prompt instructs
 * the model to ask "still on X?" before doing other work.
 */

const DEFAULT_CONFIRM_AFTER_MS = 4 * 60 * 60 * 1000; // 4 hours

function getConfirmAfterMs(): number {
  const raw = (process.env.CLEMMY_FOCUS_CONFIRM_MS ?? '').trim();
  if (!raw) return DEFAULT_CONFIRM_AFTER_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CONFIRM_AFTER_MS;
  return parsed;
}

function nowIso(): string {
  return new Date().toISOString();
}

function emitChange(reason: 'set' | 'park' | 'activate' | 'clear' | 'touch'): void {
  // Best-effort: subscribers (Discord presence, dashboard live chip)
  // tolerate either presence or absence of the event. Wrap in try so
  // the event-emit can never block a focus mutation.
  try {
    const active = getActiveFocus();
    actionBus.emit({
      kind: 'focus.changed',
      reason,
      activeTitle: active?.title ?? null,
      activeId: active?.id ?? null,
    });
  } catch { /* ignore */ }
}

function confirmAfterFromNow(): string {
  return new Date(Date.now() + getConfirmAfterMs()).toISOString();
}

export interface CreateFocusInput {
  resourceRef: string;
  title: string;
  summary: string;
  resourceKind?: string;
  relatedSessionId?: string;
  relatedGoalId?: string;
  metadata?: Record<string, unknown>;
}

export interface FocusSnapshot {
  active: FocusRow | null;
  parked: FocusRow[];
  needsConfirm: boolean;
}

/**
 * Park whatever is currently active (if anything). Internal helper —
 * createFocus and activateFocus both call this first so the partial
 * unique index never sees two actives.
 */
function parkActiveIfPresent(reason: string): FocusRow | null {
  const db = openMemoryDb();
  const active = db.prepare(
    `SELECT * FROM current_focus WHERE status='active' LIMIT 1`,
  ).get() as FocusRow | undefined;
  if (!active) return null;
  const now = nowIso();
  db.prepare(`
    UPDATE current_focus
    SET status='paused', parked_at=?, parked_reason=?, last_touched_at=?
    WHERE id=?
  `).run(now, reason, now, active.id);
  return active;
}

export function createFocus(input: CreateFocusInput): FocusRow {
  const title = input.title.trim();
  const summary = input.summary.trim();
  const resourceRef = input.resourceRef.trim();
  if (!title) throw new Error('createFocus: title required');
  if (!summary) throw new Error('createFocus: summary required');
  if (!resourceRef) throw new Error('createFocus: resourceRef required');

  const db = openMemoryDb();
  parkActiveIfPresent('replaced by new focus');
  const now = nowIso();
  const info = db.prepare(`
    INSERT INTO current_focus
      (resource_ref, title, summary, status, resource_kind,
       related_session_id, related_goal_id, created_at,
       last_touched_at, confirm_after, metadata_json)
    VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    resourceRef,
    title,
    summary,
    input.resourceKind ?? null,
    input.relatedSessionId ?? null,
    input.relatedGoalId ?? null,
    now,
    now,
    confirmAfterFromNow(),
    JSON.stringify(input.metadata ?? {}),
  );
  const row = getFocusById(Number(info.lastInsertRowid))!;
  emitChange('set');
  return row;
}

export function getActiveFocus(): FocusRow | null {
  const db = openMemoryDb();
  const row = db.prepare(
    `SELECT * FROM current_focus WHERE status='active' LIMIT 1`,
  ).get() as FocusRow | undefined;
  return row ?? null;
}

export function getFocusById(id: number): FocusRow | null {
  const db = openMemoryDb();
  const row = db.prepare(`SELECT * FROM current_focus WHERE id=?`).get(id) as FocusRow | undefined;
  return row ?? null;
}

export function listFocuses(options: { includeTerminal?: boolean; limit?: number } = {}): FocusRow[] {
  const db = openMemoryDb();
  const limit = Math.max(1, Math.min(50, options.limit ?? 20));
  const where = options.includeTerminal
    ? `1=1`
    : `status IN ('active','paused')`;
  const rows = db.prepare(`
    SELECT * FROM current_focus
    WHERE ${where}
    ORDER BY
      CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
      last_touched_at DESC
    LIMIT ?
  `).all(limit) as FocusRow[];
  return rows;
}

export function listParkedFocuses(limit = 5): FocusRow[] {
  const db = openMemoryDb();
  return db.prepare(`
    SELECT * FROM current_focus
    WHERE status='paused'
    ORDER BY parked_at DESC, id DESC
    LIMIT ?
  `).all(limit) as FocusRow[];
}

export function touchFocus(id: number): FocusRow | null {
  const db = openMemoryDb();
  const now = nowIso();
  const info = db.prepare(`
    UPDATE current_focus
    SET last_touched_at=?, confirm_after=?
    WHERE id=? AND status='active'
  `).run(now, confirmAfterFromNow(), id);
  if (info.changes > 0) emitChange('touch');
  return getFocusById(id);
}

export function parkFocus(id: number, reason?: string): FocusRow | null {
  const db = openMemoryDb();
  const now = nowIso();
  const info = db.prepare(`
    UPDATE current_focus
    SET status='paused', parked_at=?, parked_reason=?, last_touched_at=?
    WHERE id=? AND status='active'
  `).run(now, (reason ?? '').slice(0, 200), now, id);
  if (info.changes > 0) emitChange('park');
  return getFocusById(id);
}

export function activateFocus(id: number): FocusRow | null {
  const target = getFocusById(id);
  if (!target) return null;
  if (target.status === 'active') return target;
  if (target.status !== 'paused') return null; // refuse to reactivate completed/abandoned
  parkActiveIfPresent('switched to another paused focus');
  const db = openMemoryDb();
  const now = nowIso();
  const info = db.prepare(`
    UPDATE current_focus
    SET status='active', parked_at=NULL, parked_reason=NULL,
        last_touched_at=?, confirm_after=?
    WHERE id=?
  `).run(now, confirmAfterFromNow(), id);
  if (info.changes > 0) emitChange('activate');
  return getFocusById(id);
}

export function clearFocus(id: number, resolution: 'completed' | 'abandoned' = 'completed'): FocusRow | null {
  const db = openMemoryDb();
  const info = db.prepare(`
    UPDATE current_focus
    SET status=?, last_touched_at=?
    WHERE id=? AND status IN ('active','paused')
  `).run(resolution, nowIso(), id);
  if (info.changes > 0) emitChange('clear');
  return getFocusById(id);
}

/**
 * One-shot snapshot for the agent's `focus_get` tool. Returns the
 * active focus + a small stack of parked + whether the active is past
 * its confirm window (so the model knows to ask "still on X?").
 */
export function getFocusSnapshot(parkedLimit = 5): FocusSnapshot {
  const active = getActiveFocus();
  const parked = listParkedFocuses(parkedLimit);
  const needsConfirm = active
    ? Date.parse(active.confirm_after) <= Date.now()
    : false;
  return { active, parked, needsConfirm };
}
