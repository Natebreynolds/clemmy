import { openMemoryDb, type FocusRow, type FocusStatus } from './db.js';
import { actionBus } from '../runtime/action-bus.js';
import { getRuntimeEnv } from '../config.js';

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
  /**
   * Born-stale: set confirm_after to NOW so getFocusSnapshot reports
   * needsConfirm immediately and the focus renders under the "verify before
   * relying" block. Used for auto-pins inferred from prior-session tool calls —
   * a guess the model should confirm, not treat as authoritative.
   */
  staleOnCreate?: boolean;
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
    input.staleOnCreate ? now : confirmAfterFromNow(),
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

/**
 * Move 1 (scoped recall): the objective string used to scope which
 * facts get injected into the prompt this turn. Returns the active
 * focus's title + summary, or undefined when there is no active focus
 * or the CLEMMY_SCOPED_RECALL flag is off. Single source of truth so
 * every fact-injection path scopes identically. Fail-safe: any error
 * returns undefined (→ unchanged global ranking), never throws into
 * prompt assembly.
 */
export function getActiveObjective(): string | undefined {
  const enabled = (getRuntimeEnv('CLEMMY_SCOPED_RECALL', 'on') ?? 'on').toLowerCase() !== 'off';
  if (!enabled) return undefined;
  try {
    const focus = getActiveFocus();
    if (!focus) return undefined;
    return `${focus.title} ${focus.summary}`.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Recall objective for a single turn = the CURRENT MESSAGE blended with the
 * active focus. getActiveObjective() alone scopes recall to the focus, so a
 * one-off chat query ("pull MY priority-account accounts") with no matching
 * focus fell back to global top-N recall and never surfaced the query-
 * relevant fact ("accounts owned by Alexander Chen"). Scoping to the
 * message fixes that. Same CLEMMY_SCOPED_RECALL flag → off = undefined =
 * today's global recall, byte-for-byte.
 */
export function getRecallObjective(message?: string): string | undefined {
  const enabled = (getRuntimeEnv('CLEMMY_SCOPED_RECALL', 'on') ?? 'on').toLowerCase() !== 'off';
  if (!enabled) return undefined;
  const focus = getActiveObjective();
  const parts = [message?.trim(), focus].filter((p): p is string => Boolean(p));
  const joined = parts.join(' ').slice(0, 600).trim();
  return joined || undefined;
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

/**
 * Evolve an existing focus IN PLACE — same id, same active status,
 * but with updated title/summary/resource_kind. Use this when the
 * plan develops within a single focus (e.g. "Q2 sheet · dropdowns"
 * → "Q2 sheet · scoring 10/25 leads via firecrawl"). Distinct from
 * createFocus, which parks the prior and starts a new id.
 *
 * Bumps last_touched_at + confirm_after as a side effect so an
 * evolving focus stays warm.
 */
export interface UpdateFocusInput {
  title?: string;
  summary?: string;
  resourceKind?: string;
  /** Latest chat surface that explicitly continued this focus. */
  relatedSessionId?: string;
}
export function updateFocus(id: number, patch: UpdateFocusInput): FocusRow | null {
  const db = openMemoryDb();
  const existing = getFocusById(id);
  if (!existing) return null;
  if (existing.status !== 'active' && existing.status !== 'paused') return null;
  const now = nowIso();
  const newTitle = (patch.title ?? '').trim() || existing.title;
  const newSummary = (patch.summary ?? '').trim() || existing.summary;
  const newKind = patch.resourceKind === undefined ? existing.resource_kind : (patch.resourceKind || null);
  const newRelatedSessionId = patch.relatedSessionId === undefined
    ? existing.related_session_id
    : patch.relatedSessionId.trim() || existing.related_session_id;
  const info = db.prepare(`
    UPDATE current_focus
    SET title=?, summary=?, resource_kind=?, related_session_id=?,
        last_touched_at=?, confirm_after=?
    WHERE id=?
  `).run(newTitle, newSummary, newKind, newRelatedSessionId, now, confirmAfterFromNow(), id);
  if (info.changes > 0) emitChange('set');
  return getFocusById(id);
}

/**
 * Sparse conversational workstate stored inside current_focus.metadata_json.
 *
 * This is a shared notebook, not a workflow/state-machine contract: the model
 * decides how to reason and when to move. The runtime only persists material
 * decisions so a long conversation, provider switch, or background handoff
 * does not erase what the user already chose.
 */
export type FocusWorkMode = 'explore' | 'decide' | 'execute' | 'monitor';
export type FocusCandidateStatus = 'considering' | 'selected' | 'rejected';
export type FocusActionStatus = 'planned' | 'running' | 'blocked' | 'done';
export type FocusActionKind = 'background' | 'workflow' | 'external' | 'local' | 'other';

export interface FocusWorkstateCandidate {
  id: string;
  label: string;
  status: FocusCandidateStatus;
  note?: string;
  ref?: string;
}

export interface FocusWorkstateAction {
  id: string;
  label: string;
  status: FocusActionStatus;
  kind?: FocusActionKind;
  ref?: string;
  note?: string;
}

export interface FocusWorkstate {
  version: number;
  updatedAt: string;
  mode?: FocusWorkMode;
  objective?: string;
  candidates: FocusWorkstateCandidate[];
  constraints: string[];
  decisions: string[];
  openLoops: string[];
  actions: FocusWorkstateAction[];
}

export interface FocusWorkstatePatch {
  clear?: boolean;
  mode?: FocusWorkMode | null;
  objective?: string | null;
  upsertCandidates?: FocusWorkstateCandidate[];
  removeCandidateIds?: string[];
  addConstraints?: string[];
  removeConstraints?: string[];
  addDecisions?: string[];
  removeDecisions?: string[];
  /** Replacement semantics: pass [] when all open loops are resolved. */
  openLoops?: string[];
  upsertActions?: FocusWorkstateAction[];
  removeActionIds?: string[];
}

export interface PatchFocusWorkstateResult {
  status: 'updated' | 'cleared' | 'conflict' | 'not_found';
  row: FocusRow | null;
  workstate: FocusWorkstate | null;
  actualVersion: number;
}

const WORKSTATE_LIMITS = {
  candidates: 48,
  constraints: 24,
  decisions: 24,
  openLoops: 24,
  actions: 32,
} as const;

function cleanWorkstateText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function parseFocusMetadata(row: Pick<FocusRow, 'metadata_json'> | null | undefined): Record<string, unknown> {
  if (!row?.metadata_json) return {};
  try {
    const parsed = JSON.parse(row.metadata_json) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function cleanStringList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    const item = cleanWorkstateText(raw, 300);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= maxItems) break;
  }
  return out;
}

function cleanCandidate(value: unknown): FocusWorkstateCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Partial<FocusWorkstateCandidate>;
  const id = cleanWorkstateText(raw.id, 80);
  const label = cleanWorkstateText(raw.label, 200);
  if (!id || !label || !['considering', 'selected', 'rejected'].includes(String(raw.status))) return null;
  const note = cleanWorkstateText(raw.note, 300);
  const ref = cleanWorkstateText(raw.ref, 300);
  return {
    id,
    label,
    status: raw.status as FocusCandidateStatus,
    ...(note ? { note } : {}),
    ...(ref ? { ref } : {}),
  };
}

function cleanAction(value: unknown): FocusWorkstateAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Partial<FocusWorkstateAction>;
  const id = cleanWorkstateText(raw.id, 100);
  const label = cleanWorkstateText(raw.label, 200);
  if (!id || !label || !['planned', 'running', 'blocked', 'done'].includes(String(raw.status))) return null;
  const kind = ['background', 'workflow', 'external', 'local', 'other'].includes(String(raw.kind))
    ? raw.kind as FocusActionKind
    : undefined;
  const ref = cleanWorkstateText(raw.ref, 300);
  const note = cleanWorkstateText(raw.note, 300);
  return {
    id,
    label,
    status: raw.status as FocusActionStatus,
    ...(kind ? { kind } : {}),
    ...(ref ? { ref } : {}),
    ...(note ? { note } : {}),
  };
}

function normalizeStoredWorkstate(value: unknown): FocusWorkstate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Partial<FocusWorkstate>;
  const version = Number.isSafeInteger(raw.version) && Number(raw.version) > 0
    ? Number(raw.version)
    : 1;
  const updatedAt = cleanWorkstateText(raw.updatedAt, 40) || nowIso();
  const mode = ['explore', 'decide', 'execute', 'monitor'].includes(String(raw.mode))
    ? raw.mode as FocusWorkMode
    : undefined;
  const objective = cleanWorkstateText(raw.objective, 500);
  const candidates = Array.isArray(raw.candidates)
    ? raw.candidates.map(cleanCandidate).filter((item): item is FocusWorkstateCandidate => Boolean(item))
      .slice(0, WORKSTATE_LIMITS.candidates)
    : [];
  const actions = Array.isArray(raw.actions)
    ? raw.actions.map(cleanAction).filter((item): item is FocusWorkstateAction => Boolean(item))
      .slice(0, WORKSTATE_LIMITS.actions)
    : [];
  return {
    version,
    updatedAt,
    ...(mode ? { mode } : {}),
    ...(objective ? { objective } : {}),
    candidates,
    constraints: cleanStringList(raw.constraints, WORKSTATE_LIMITS.constraints),
    decisions: cleanStringList(raw.decisions, WORKSTATE_LIMITS.decisions),
    openLoops: cleanStringList(raw.openLoops, WORKSTATE_LIMITS.openLoops),
    actions,
  };
}

export function getFocusWorkstate(row: Pick<FocusRow, 'metadata_json'> | null | undefined): FocusWorkstate | null {
  return normalizeStoredWorkstate(parseFocusMetadata(row).workstate);
}

function mergeStringList(
  current: string[],
  additions: unknown,
  removals: unknown,
  maxItems: number,
): string[] {
  const removed = new Set(cleanStringList(removals, maxItems));
  return cleanStringList(
    [...current.filter((item) => !removed.has(item)), ...cleanStringList(additions, maxItems)],
    maxItems,
  );
}

function upsertById<T extends { id: string }>(current: T[], incoming: T[], maxItems: number): T[] {
  const next = [...current];
  for (const item of incoming) {
    const at = next.findIndex((existing) => existing.id === item.id);
    if (at >= 0) next[at] = item;
    else next.push(item);
  }
  return next.slice(0, maxItems);
}

/**
 * Atomically patch one focus's shared notebook. expectedVersion is optional for
 * ordinary single-writer chat turns; background/runtime writers should pass it
 * when they need optimistic concurrency.
 */
export function patchFocusWorkstate(
  id: number,
  patch: FocusWorkstatePatch,
  expectedVersion?: number,
): PatchFocusWorkstateResult {
  const db = openMemoryDb();
  const apply = db.transaction((): PatchFocusWorkstateResult => {
    const row = db.prepare(`SELECT * FROM current_focus WHERE id=?`).get(id) as FocusRow | undefined;
    if (!row || (row.status !== 'active' && row.status !== 'paused')) {
      return { status: 'not_found', row: row ?? null, workstate: null, actualVersion: 0 };
    }
    const metadata = parseFocusMetadata(row);
    const current = normalizeStoredWorkstate(metadata.workstate);
    const actualVersion = current?.version ?? 0;
    if (expectedVersion !== undefined && expectedVersion !== actualVersion) {
      return { status: 'conflict', row, workstate: current, actualVersion };
    }

    const now = nowIso();
    if (patch.clear) {
      delete metadata.workstate;
      db.prepare(`
        UPDATE current_focus
        SET metadata_json=?, last_touched_at=?, confirm_after=?
        WHERE id=?
      `).run(JSON.stringify(metadata), now, confirmAfterFromNow(), id);
      return {
        status: 'cleared',
        row: db.prepare(`SELECT * FROM current_focus WHERE id=?`).get(id) as FocusRow,
        workstate: null,
        actualVersion: 0,
      };
    }

    const base: FocusWorkstate = current ?? {
      version: 0,
      updatedAt: now,
      candidates: [],
      constraints: [],
      decisions: [],
      openLoops: [],
      actions: [],
    };
    const removedCandidateIds = new Set(
      cleanStringList(patch.removeCandidateIds, WORKSTATE_LIMITS.candidates),
    );
    const incomingCandidates = Array.isArray(patch.upsertCandidates)
      ? patch.upsertCandidates.map(cleanCandidate)
        .filter((item): item is FocusWorkstateCandidate => Boolean(item))
      : [];
    const removedActionIds = new Set(
      cleanStringList(patch.removeActionIds, WORKSTATE_LIMITS.actions),
    );
    const incomingActions = Array.isArray(patch.upsertActions)
      ? patch.upsertActions.map(cleanAction)
        .filter((item): item is FocusWorkstateAction => Boolean(item))
      : [];
    const mode = patch.mode === null
      ? undefined
      : patch.mode ?? base.mode;
    const objective = patch.objective === null
      ? undefined
      : cleanWorkstateText(patch.objective, 500) || base.objective;
    const next: FocusWorkstate = {
      version: actualVersion + 1,
      updatedAt: now,
      ...(mode ? { mode } : {}),
      ...(objective ? { objective } : {}),
      candidates: upsertById(
        base.candidates.filter((item) => !removedCandidateIds.has(item.id)),
        incomingCandidates,
        WORKSTATE_LIMITS.candidates,
      ),
      constraints: mergeStringList(
        base.constraints,
        patch.addConstraints,
        patch.removeConstraints,
        WORKSTATE_LIMITS.constraints,
      ),
      decisions: mergeStringList(
        base.decisions,
        patch.addDecisions,
        patch.removeDecisions,
        WORKSTATE_LIMITS.decisions,
      ),
      openLoops: patch.openLoops === undefined
        ? base.openLoops
        : cleanStringList(patch.openLoops, WORKSTATE_LIMITS.openLoops),
      actions: upsertById(
        base.actions.filter((item) => !removedActionIds.has(item.id)),
        incomingActions,
        WORKSTATE_LIMITS.actions,
      ),
    };
    metadata.workstate = next;
    db.prepare(`
      UPDATE current_focus
      SET metadata_json=?, last_touched_at=?, confirm_after=?
      WHERE id=?
    `).run(JSON.stringify(metadata), now, confirmAfterFromNow(), id);
    return {
      status: 'updated',
      row: db.prepare(`SELECT * FROM current_focus WHERE id=?`).get(id) as FocusRow,
      workstate: next,
      actualVersion: next.version,
    };
  });
  const result = apply();
  if (result.status === 'updated' || result.status === 'cleared') emitChange('set');
  return result;
}

/**
 * Best-effort runtime link from a chat-dispatched action into the active
 * conversational notebook. Automatic graph edges require an exact owning
 * session. A user can continue the same focus on another surface by explicitly
 * touching/evolving/activating it there, which rebinds that continuity identity.
 */
export function linkFocusActionForSession(
  sessionId: string | undefined,
  action: FocusWorkstateAction,
): PatchFocusWorkstateResult | null {
  if (!sessionId) return null;
  try {
    const snap = getFocusSnapshot();
    if (!snap.active || snap.needsConfirm) return null;
    const active = snap.active;
    const resourceSessionId = active.resource_ref.startsWith('session:')
      ? active.resource_ref.slice('session:'.length)
      : undefined;
    const ownerSessionIds = new Set(
      [active.related_session_id, resourceSessionId].filter((value): value is string => Boolean(value)),
    );
    if (ownerSessionIds.size !== 1 || !ownerSessionIds.has(sessionId)) return null;
    return patchFocusWorkstate(active.id, { upsertActions: [action] });
  } catch {
    return null;
  }
}

/** Reconcile a terminal/blocked runtime outcome into any non-terminal focus
 * that already links the exact task/run ref. No model bookkeeping required. */
export function updateLinkedFocusAction(
  ref: string,
  patch: Pick<FocusWorkstateAction, 'status'> & { note?: string },
): number {
  const normalizedRef = cleanWorkstateText(ref, 300);
  if (!normalizedRef) return 0;
  let updated = 0;
  try {
    for (const row of listFocuses({ includeTerminal: false, limit: 50 })) {
      const workstate = getFocusWorkstate(row);
      const existing = workstate?.actions.find((action) =>
        action.ref === normalizedRef || action.id === normalizedRef,
      );
      if (!existing) continue;
      const result = patchFocusWorkstate(row.id, {
        upsertActions: [{
          ...existing,
          status: patch.status,
          ...(patch.note ? { note: cleanWorkstateText(patch.note, 300) } : {}),
        }],
      });
      if (result.status === 'updated') updated += 1;
    }
  } catch {
    return updated;
  }
  return updated;
}

export function touchFocus(id: number, relatedSessionId?: string): FocusRow | null {
  const db = openMemoryDb();
  const now = nowIso();
  const info = db.prepare(`
    UPDATE current_focus
    SET related_session_id=COALESCE(?, related_session_id),
        last_touched_at=?, confirm_after=?
    WHERE id=? AND status='active'
  `).run(relatedSessionId?.trim() || null, now, confirmAfterFromNow(), id);
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

export function activateFocus(id: number, relatedSessionId?: string): FocusRow | null {
  const target = getFocusById(id);
  if (!target) return null;
  if (target.status === 'active') {
    return relatedSessionId?.trim()
      ? updateFocus(id, { relatedSessionId })
      : target;
  }
  if (target.status !== 'paused') return null; // refuse to reactivate completed/abandoned
  parkActiveIfPresent('switched to another paused focus');
  const db = openMemoryDb();
  const now = nowIso();
  const info = db.prepare(`
    UPDATE current_focus
    SET status='active', parked_at=NULL, parked_reason=NULL,
        related_session_id=COALESCE(?, related_session_id),
        last_touched_at=?, confirm_after=?
    WHERE id=?
  `).run(relatedSessionId?.trim() || null, now, confirmAfterFromNow(), id);
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
 * Compare a candidate resource id (extracted from a tool call's args
 * — spreadsheet_id, document_id, etc.) against the active focus's
 * resource_ref. Used by the approval surfaces (Discord card,
 * dashboard panel) to flag when an agent is about to mutate a
 * DIFFERENT resource than the one the user has been working on.
 *
 * Returns:
 *   - 'match'    — candidate matches the active focus's resource
 *   - 'mismatch' — both exist and don't match (the warning case)
 *   - 'unknown'  — either no candidate or no active focus
 */
export type ResourceMatchResult = 'match' | 'mismatch' | 'unknown';
export function checkResourceMatchesFocus(candidateId: string | null | undefined): {
  result: ResourceMatchResult;
  focusRef?: string;
  focusTitle?: string;
} {
  if (!candidateId) return { result: 'unknown' };
  const snap = getFocusSnapshot();
  const active = snap.needsConfirm ? null : snap.active;
  if (!active) return { result: 'unknown' };
  // Substring match: a focus stored as a URL (https://docs.google.com/.../<id>)
  // legitimately matches an extracted bare id when that id appears in
  // the URL. Tighten only if we see false matches in practice.
  const candidateLower = candidateId.toLowerCase();
  const refLower = active.resource_ref.toLowerCase();
  const matched = candidateLower === refLower
    || refLower.includes(candidateLower)
    || candidateLower.includes(refLower);
  return {
    result: matched ? 'match' : 'mismatch',
    focusRef: active.resource_ref,
    focusTitle: active.title,
  };
}

/**
 * Best-effort extraction of a resource id (spreadsheet, document,
 * etc.) from an approval's args payload. Args may be a string (JSON)
 * or an object. Returns the first id found, or null.
 */
/**
 * Best-effort extraction of a concrete resource id from FREE-TEXT (a user
 * message or a focus resource_ref), as opposed to JSON approval args. Handles a
 * Google Sheets/Docs/Drive URL and a bare Google-style id pasted inline.
 * Returns the bare id (URL ids normalized) or null. Shared by the cross-session
 * auto-pin guard and the plan-continuity self-contained-request guard so both
 * detect "the user named their own resource" with the same rule.
 */
export function extractNamedResource(text?: string | null): string | null {
  if (!text) return null;
  const url = text.match(
    /(?:docs|drive)\.google\.com\/(?:spreadsheets|document|file|presentation)\/d\/([A-Za-z0-9_-]{20,})/,
  );
  if (url?.[1]) return url[1];
  // A bare Google-style resource id pasted inline (typically ~44 chars). Tight
  // length bound so ordinary words/slugs don't read as a resource id.
  const bare = text.match(/\b([A-Za-z0-9_-]{30,})\b/);
  if (bare?.[1]) return bare[1];
  return null;
}

export function extractResourceIdFromApprovalArgs(args: unknown): string | null {
  if (!args) return null;
  let text: string;
  if (typeof args === 'string') {
    text = args;
  } else {
    try { text = JSON.stringify(args); } catch { return null; }
  }
  // Inner Composio args often nest as { tool_slug, arguments: "..." }
  // where arguments is itself JSON. Match on either layer.
  const patterns = [
    /"spreadsheet_id"\s*:\s*"([A-Za-z0-9_-]{20,})"/,
    /"document_id"\s*:\s*"([A-Za-z0-9_-]{20,})"/,
    /"file_id"\s*:\s*"([A-Za-z0-9_-]{20,})"/,
    /"repo"\s*:\s*"([A-Za-z0-9_./-]+)"/,
    /"thread_id"\s*:\s*"([A-Za-z0-9_-]+)"/,
  ];
  for (const re of patterns) {
    const match = text.match(re);
    if (match && match[1]) return match[1];
  }
  return null;
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
