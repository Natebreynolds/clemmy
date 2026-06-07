/**
 * Unified Conversations API — the desktop console as a single client over
 * the two session engines.
 *
 * There is no data merge: desktop chats live in the SessionStore
 * (sessions.json) and the rest live in the harness eventlog (harness.db).
 * This module merges them ONLY at read time into one normalized list, and
 * dispatches organize edits / history reads to whichever store owns the id.
 *
 * Continuability follows the product decision: chat sessions (desktop +
 * Discord/harness `kind:'chat'`) are continuable; workflow / execution /
 * agent runs are read-only.
 */
import { SessionStore } from '../memory/session-store.js';
import {
  getSession as getHarnessSession,
  listSessions as listHarnessSessions,
  updateSession as updateHarnessSession,
  type SessionRow as HarnessSessionRow,
} from '../runtime/harness/eventlog.js';
import { isUserFacingSession, isInternalSessionId } from '../execution/scope.js';
import { reconstructHarnessTranscript, harnessPreview } from '../runtime/harness/transcript.js';
import { deriveTitle } from '../memory/derive-title.js';
import type {
  SessionRecord,
  SessionOrigin,
  UnifiedSessionSummary,
  UnifiedSessionTurn,
} from '../types.js';

const DESKTOP_PREFIX = 'desktop:';
const HARNESS_PREFIX = 'harness:';

export interface SessionListQuery {
  q?: string;
  tag?: string;
  source?: string;
  includeArchived?: boolean;
  limit?: number;
}

export interface ContinueHint {
  mode: 'desktop' | 'harness';
  endpoint: string;
  streamUrl: string | null;
  protocol: 'ndjson' | 'sse';
}

export interface SessionDetail {
  session: UnifiedSessionSummary;
  turns: UnifiedSessionTurn[];
  continueHint: ContinueHint | null;
}

export interface SessionPatchInput {
  title?: string;
  pinned?: boolean;
  tags?: string[];
  archived?: boolean;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function parseId(id: string): { store: 'desktop' | 'harness'; rawId: string } | null {
  if (id.startsWith(DESKTOP_PREFIX)) return { store: 'desktop', rawId: id.slice(DESKTOP_PREFIX.length) };
  if (id.startsWith(HARNESS_PREFIX)) return { store: 'harness', rawId: id.slice(HARNESS_PREFIX.length) };
  return null;
}

// ─── Harness classification (kept local so this module stays decoupled) ──

function harnessOrigin(row: HarnessSessionRow): SessionOrigin {
  if (row.channel === 'discord' || row.channel === 'discord-dm' || row.metadata?.source === 'discord') {
    return 'discord';
  }
  if (row.kind === 'workflow' || row.channel === 'workflow' || row.metadata?.source === 'workflow') {
    return 'workflow';
  }
  if (row.kind === 'agent') return 'agent';
  if (row.kind === 'execution') return 'workflow';
  return 'desktop';
}

function harnessLabel(row: HarnessSessionRow): string {
  const origin = harnessOrigin(row);
  if (origin === 'discord') return 'Discord conversation';
  if (origin === 'workflow') return 'Workflow run';
  if (origin === 'agent') return 'Agent run';
  return row.channel || row.kind;
}

function metaBool(row: HarnessSessionRow, key: string): boolean {
  return row.metadata?.[key] === true;
}

function metaTags(meta: Record<string, unknown> | undefined): string[] {
  const raw = meta?.tags;
  return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string') : [];
}

// ─── Summaries (preview filled in lazily for the final page) ─────────────

function summarizeDesktop(record: SessionRecord): UnifiedSessionSummary {
  const firstUser = record.turns.find((t) => t.role === 'user');
  const title = record.title
    || (firstUser ? deriveTitle(firstUser.text, 'New chat') : 'New chat');
  return {
    id: `${DESKTOP_PREFIX}${record.id}`,
    origin: record.channel === 'cli' ? 'cli' : 'desktop',
    store: 'desktop',
    kind: 'chat',
    title,
    preview: '',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    status: 'active',
    pinned: Boolean(record.pinned),
    tags: Array.isArray(record.tags) ? record.tags : [],
    archived: Boolean(record.archived),
    continuable: true,
    turnCount: record.turns.length,
  };
}

function summarizeHarness(row: HarnessSessionRow, titleOverride?: string): UnifiedSessionSummary {
  return {
    id: `${HARNESS_PREFIX}${row.id}`,
    origin: harnessOrigin(row),
    store: 'harness',
    kind: row.kind,
    title: titleOverride || row.title || row.objective || harnessLabel(row),
    preview: '',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: row.status,
    pinned: metaBool(row, 'pinned'),
    tags: metaTags(row.metadata),
    archived: metaBool(row, 'archived'),
    // Only chat sessions are continuable from the desktop. Workflow /
    // execution / agent runs are read-only (sending a turn into them is
    // unguarded and can re-fire tools — see plan).
    continuable: row.kind === 'chat',
    turnCount: 0,
  };
}

/**
 * Collect candidate harness summaries, collapsing per-step workflow
 * sessions (one session per step, titled `name::stepId`) into a single
 * row per workflow run so a multi-step workflow doesn't flood the list.
 */
function collectHarnessSummaries(): UnifiedSessionSummary[] {
  const rows = listHarnessSessions({ limit: 300, status: 'any' })
    .filter((row) => isUserFacingSession(row.id, row.channel ?? undefined));
  const out: UnifiedSessionSummary[] = [];
  const seenWorkflowRuns = new Set<string>();
  for (const row of rows) {
    const runId = typeof row.metadata?.workflowRunId === 'string' ? row.metadata.workflowRunId : '';
    if (runId) {
      // rows are updated_at DESC, so the first one we see per run is the
      // most recent step — keep it as the run's representative row.
      if (seenWorkflowRuns.has(runId)) continue;
      seenWorkflowRuns.add(runId);
      const workflowName = typeof row.metadata?.workflowName === 'string' ? row.metadata.workflowName : '';
      out.push(summarizeHarness(row, workflowName || undefined));
      continue;
    }
    out.push(summarizeHarness(row));
  }
  return out;
}

function desktopSearchText(record: SessionRecord): string {
  const tail = record.turns.slice(-20).map((t) => t.text).join(' ');
  return `${record.title ?? ''} ${tail}`.toLowerCase();
}

// ─── Public API ──────────────────────────────────────────────────────────

export function buildUnifiedSessionList(query: SessionListQuery = {}): UnifiedSessionSummary[] {
  const store = new SessionStore();
  const q = query.q?.trim().toLowerCase() ?? '';
  const tag = query.tag?.trim() ?? '';
  const source = query.source?.trim() ?? '';
  const includeArchived = Boolean(query.includeArchived);
  const limit = Math.max(1, Math.min(500, Math.trunc(query.limit ?? 100)));

  // Desktop side — also keep the matching records for cheap search/preview.
  const desktopRecords = new Map<string, SessionRecord>();
  const desktop: UnifiedSessionSummary[] = [];
  for (const record of store.listAll()) {
    if (isInternalSessionId(record.id)) continue;
    desktopRecords.set(record.id, record);
    desktop.push(summarizeDesktop(record));
  }

  let all = [...desktop, ...collectHarnessSummaries()];

  if (!includeArchived) all = all.filter((s) => !s.archived);
  if (source) all = all.filter((s) => s.origin === source);
  if (tag) all = all.filter((s) => s.tags.includes(tag));
  if (q) {
    all = all.filter((s) => {
      if (s.title.toLowerCase().includes(q)) return true;
      if (s.store === 'desktop') {
        const rec = desktopRecords.get(s.id.slice(DESKTOP_PREFIX.length));
        if (rec && desktopSearchText(rec).includes(q)) return true;
      }
      return false;
    });
  }

  // Pinned first, then most-recently-updated.
  all.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  const page = all.slice(0, limit);

  // Fill previews/turnCounts only for the returned page (bounds query cost).
  for (const summary of page) {
    if (summary.store === 'desktop') {
      const rec = desktopRecords.get(summary.id.slice(DESKTOP_PREFIX.length));
      const last = rec?.turns[rec.turns.length - 1];
      summary.preview = last ? clip(last.text, 140) : '';
    } else {
      summary.preview = clip(harnessPreview(summary.id.slice(HARNESS_PREFIX.length)), 140);
    }
  }
  return page;
}

function continueHintFor(summary: UnifiedSessionSummary, rawId: string): ContinueHint | null {
  if (!summary.continuable) return null;
  if (summary.store === 'desktop') {
    return {
      mode: 'desktop',
      endpoint: '/api/console/home/chat/stream',
      streamUrl: null,
      protocol: 'ndjson',
    };
  }
  return {
    mode: 'harness',
    endpoint: '/api/harness/chat',
    streamUrl: `/api/sessions/${rawId}/events`,
    protocol: 'sse',
  };
}

export function getUnifiedSessionDetail(id: string): SessionDetail | null {
  const parsed = parseId(id);
  if (!parsed) return null;

  if (parsed.store === 'desktop') {
    const store = new SessionStore();
    if (!store.exists(parsed.rawId)) return null;
    const record = store.get(parsed.rawId);
    const summary = summarizeDesktop(record);
    const last = record.turns[record.turns.length - 1];
    summary.preview = last ? clip(last.text, 140) : '';
    const turns: UnifiedSessionTurn[] = record.turns.map((t) => ({
      role: t.role,
      text: t.text,
      createdAt: t.createdAt,
    }));
    return { session: summary, turns, continueHint: continueHintFor(summary, parsed.rawId) };
  }

  const row = getHarnessSession(parsed.rawId);
  if (!row) return null;
  const runId = typeof row.metadata?.workflowRunId === 'string' ? row.metadata.workflowRunId : '';
  const workflowName = typeof row.metadata?.workflowName === 'string' ? row.metadata.workflowName : '';
  const summary = summarizeHarness(row, runId && workflowName ? workflowName : undefined);
  const turns = reconstructHarnessTranscript(parsed.rawId);
  summary.turnCount = turns.length;
  summary.preview = clip(turns[turns.length - 1]?.text ?? '', 140);
  return { session: summary, turns, continueHint: continueHintFor(summary, parsed.rawId) };
}

export function patchUnifiedSession(id: string, patch: SessionPatchInput): UnifiedSessionSummary | null {
  const parsed = parseId(id);
  if (!parsed) return null;

  if (parsed.store === 'desktop') {
    const store = new SessionStore();
    const updated = store.setMeta(parsed.rawId, patch);
    if (!updated) return null;
    const summary = summarizeDesktop(updated);
    const last = updated.turns[updated.turns.length - 1];
    summary.preview = last ? clip(last.text, 140) : '';
    return summary;
  }

  const row = getHarnessSession(parsed.rawId);
  if (!row) return null;
  const meta = { ...row.metadata };
  if (patch.pinned !== undefined) meta.pinned = patch.pinned;
  if (patch.archived !== undefined) meta.archived = patch.archived;
  if (patch.tags !== undefined) {
    meta.tags = patch.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim().slice(0, 40)).filter(Boolean).slice(0, 20);
  }
  const next = updateHarnessSession(parsed.rawId, {
    metadata: meta,
    ...(patch.title !== undefined ? { title: patch.title.trim().slice(0, 120) } : {}),
  });
  const summary = summarizeHarness(next);
  summary.preview = clip(harnessPreview(parsed.rawId), 140);
  return summary;
}

export function deleteUnifiedSession(
  id: string,
  hard = false,
): { ok: boolean; mode: 'deleted' | 'archived' } | null {
  const parsed = parseId(id);
  if (!parsed) return null;

  if (parsed.store === 'desktop') {
    const store = new SessionStore();
    return { ok: store.delete(parsed.rawId), mode: 'deleted' };
  }

  // Harness: hard-delete would cascade and destroy audited events — archive instead.
  const row = getHarnessSession(parsed.rawId);
  if (!row) return null;
  if (hard) {
    // Not supported for harness sessions (would lose audit history).
    return { ok: false, mode: 'archived' };
  }
  updateHarnessSession(parsed.rawId, { metadata: { ...row.metadata, archived: true } });
  return { ok: true, mode: 'archived' };
}
