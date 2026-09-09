/**
 * Home model — the pure half of the main window.
 *
 * Every helper here is total and I/O-free so the screen renders from data and
 * infers nothing: the "Needs you" list is the command center's, "Running" is
 * the shared Working-Now presenter, "While you were away" is the durable
 * results feed. The screen composes; this file decides copy and targets.
 */
import type { ActivityEntry } from '@/lib/activity';
import type { HomePaneId } from '@/lib/home-prefs';
import type { CommandCenterItem } from '@/lib/types';
import type { SpaceRecord } from '@/lib/spaces';
// Relative for VALUES, `@/` for types. The alias is a bundler/tsconfig path,
// so a type import is erased before Node ever sees it while a value import is
// not — which is why this module had no unit test until now.
import { humanizeCron } from '../../lib/cron';
import { relativeTime } from '../../lib/inbox';
import { unifiedChatSessionId } from '../../lib/last-session';

/** The command-center DTO is deliberately loose; these are the extra,
 *  server-owned fields a home row may carry (all optional). */
export interface HomeFeedItem extends CommandCenterItem {
  createdAt?: string;
  read?: boolean;
  notDelivered?: boolean;
  runId?: string;
  taskId?: string;
  targetRunId?: string;
}

// ─── The shape of the window ───────────────────────────────────────────────

/** A thing the home stacks: one of the user's panes, or the composer. */
export type HomeBlockId = HomePaneId | 'composer';

/**
 * WORK LEADS — and the order is the user's, not this function's.
 *
 * The home used to open with a greeting and a text box: on an operations
 * console the first thing on screen was an invitation to type, and the panes
 * that actually answer "what are my employees doing" started underneath it.
 * The composer is still on the page and its send -> thread handoff is
 * untouched; it is simply no longer the hero.
 *
 * ONE rule: the composer goes last, after every pane the user kept. The
 * composer is the only block the Customize sheet does not list, so it is the
 * only block this function may place.
 *
 * WHAT WAS HERE AND WHY IT IS GONE. This used to also sink `quick_actions`
 * whenever it preceded every work pane, on the theory that the chips are the
 * other half of "talk to Clementine" and belong beside the composer. But that
 * condition cannot tell a shipped default from a deliberate choice — it is
 * exactly the state produced by dragging "Quick actions" to slot 1 in the
 * Customize sheet. So the sheet rendered the chips in position 1, the drag
 * saved, and the home went on rendering them last: a preference the UI offered
 * and silently discarded. Where the chips SIT by default is a question for the
 * default order (DEFAULT_HOME_PANE_ORDER), which is data the user can see and
 * change; it is not a question for the renderer.
 */
export function homeBlocks(visible: readonly HomePaneId[]): HomeBlockId[] {
  return [...visible, 'composer'];
}

/** Needs you and Running share one row when the user keeps them adjacent.
 *  Rows, not a flat list, so the screen never re-derives the pairing. */
export function homeRows(blocks: readonly HomeBlockId[]): HomeBlockId[][] {
  const rows: HomeBlockId[][] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const id = blocks[i];
    const next = blocks[i + 1];
    const paired = (id === 'needs_you' && next === 'running') || (id === 'running' && next === 'needs_you');
    if (paired && next) {
      rows.push([id, next]);
      i += 1;
      continue;
    }
    rows.push([id]);
  }
  return rows;
}

export interface PresenceCounts {
  needsYou: number;
  running: number;
  done: number;
  paused: number;
}

/** "2 need you · 1 running · 2 done and 1 paused while you were away". */
export function presenceLine(counts: PresenceCounts): string {
  const parts: string[] = [];
  if (counts.needsYou > 0) parts.push(`${counts.needsYou} need${counts.needsYou === 1 ? 's' : ''} you`);
  if (counts.running > 0) parts.push(`${counts.running} running`);
  const away: string[] = [];
  if (counts.done > 0) away.push(`${counts.done} done`);
  if (counts.paused > 0) away.push(`${counts.paused} paused`);
  if (away.length > 0) parts.push(`${away.join(' and ')} while you were away`);
  return parts.length > 0 ? parts.join(' · ') : 'Nothing needs you right now.';
}

/** Where a "Needs you" card lands. Every approval-, plan-, question-, and
 *  notification-backed card lives on the Inbox "Needs you" tab; deep-link to
 *  the exact item so the row always opens what it promised. */
export function needsYouTarget(item: HomeFeedItem): string {
  if (item.notifId) return `/inbox?tab=needs&select=${encodeURIComponent(item.notifId)}`;
  if (item.approvalId) return `/inbox?tab=needs&select=${encodeURIComponent(item.approvalId)}`;
  if (item.planProposalId) return `/inbox?tab=needs&select=${encodeURIComponent(item.planProposalId)}`;
  if (item.questionId) return `/inbox?tab=needs&select=${encodeURIComponent(item.questionId)}`;
  if (item.kind === 'background') return '/tasks';
  return '/inbox';
}

export type NeedsYouDecision =
  | { kind: 'approval'; id: string; approvalKind?: 'runtime' | 'harness' }
  | { kind: 'plan'; id: string };

/** Inline Approve / Not now exist ONLY where the Inbox already exposes an
 *  approve/reject call for that item kind. Everything else opens. */
export function needsYouDecision(item: HomeFeedItem): NeedsYouDecision | null {
  if (item.approvalId) return { kind: 'approval', id: item.approvalId, approvalKind: item.approvalKind };
  if (item.planProposalId) return { kind: 'plan', id: item.planProposalId };
  return null;
}

/** A stable key for a needs-you row across polls. */
export function needsYouKey(item: HomeFeedItem, index: number): string {
  return item.approvalId
    ?? item.planProposalId
    ?? item.questionId
    ?? item.notifId
    ?? (item.dismissId ? `${item.dismissKind}:${item.dismissId}` : `row:${index}:${item.title ?? ''}`);
}

/** "4m ago" from a server timestamp; '' when the row carries none. */
export function agoLabel(createdAt?: string): string {
  const rel = relativeTime(createdAt);
  if (!rel) return '';
  return rel === 'now' ? 'just now' : `${rel} ago`;
}

export type AwayOutcome = 'success' | 'warning';

/** Check for a settled result; the warning glyph for a report that did not
 *  land (undelivered) — the two outcomes the durable feed distinguishes. */
export function awayOutcome(item: HomeFeedItem): AwayOutcome {
  return item.notDelivered || item.kind === 'exec' ? 'warning' : 'success';
}

export function awayTarget(item: HomeFeedItem): string | null {
  if (item.notifId) return `/inbox?tab=notifications&select=${encodeURIComponent(item.notifId)}`;
  if (item.taskId) return `/tasks?select=${encodeURIComponent(item.taskId)}`;
  if (item.targetRunId) return `/tasks?select=${encodeURIComponent(item.targetRunId)}`;
  if (item.targetSessionId) return `/chat/${encodeURIComponent(unifiedChatSessionId(item.targetSessionId))}`;
  return null;
}

/** Notification-backed rows prefix their meta with "HH:MM · "; the row shows
 *  the time on the right instead, so drop the duplicate. */
export function awayMeta(item: HomeFeedItem): string {
  const meta = (item.meta ?? '').trim();
  if (!item.createdAt) return meta;
  return meta.replace(/^\d{1,2}:\d{2}(?:\s*·\s*|$)/, '').trim();
}

/** "3:42 pm" in the viewer's locale; '' for an unusable timestamp. */
export function clockLabel(iso?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t)
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    .replace(/\s?(AM|PM)$/i, (m) => m.toLowerCase());
}

export function awayCounts(items: readonly HomeFeedItem[]): { done: number; paused: number } {
  let done = 0;
  let paused = 0;
  for (const item of items) {
    if (awayOutcome(item) === 'warning') paused += 1;
    else done += 1;
  }
  return { done, paused };
}

// ─── Running ───────────────────────────────────────────────────────────────

/** Steer means "say something to the running turn". Only a live chat session
 *  has a thread whose composer steers mid-run. */
export function steerTarget(entry: ActivityEntry): string | null {
  if (entry.kind !== 'chat' || !entry.sessionId) return null;
  return `/chat/${encodeURIComponent(unifiedChatSessionId(entry.sessionId))}`;
}

/**
 * Where "Open run" goes.
 *
 * A run with a session now has a real ADDRESS — /chat/:sessionId renders it as
 * a run, and that page can be bookmarked, pinned, renamed, tagged and searched.
 * This used to hand every row to the /tasks drawer, which was right when the
 * drawer was the only run detail there was; sending a row there now would put
 * the owner in front of transient overlay state when a durable page exists.
 *
 * A row with no session is genuinely still board-shaped — a queued task or a
 * run scope that never minted a harness session has nothing to render at a
 * session address — so it keeps the deep link it had, attempt and all.
 */
export function runningOpenTarget(entry: ActivityEntry): string {
  if (entry.sessionId) return `/chat/${encodeURIComponent(unifiedChatSessionId(entry.sessionId))}`;
  const select = entry.taskId ?? entry.runId ?? entry.runKey;
  const params = new URLSearchParams({ select });
  return `/tasks?${params.toString()}`;
}

export function runningKindLabel(kind: ActivityEntry['kind']): string {
  if (kind === 'background') return 'Task';
  if (kind === 'workflow') return 'Workflow';
  if (kind === 'fanout') return 'Plan';
  return 'Chat';
}

const LIFECYCLE_LABELS: Record<string, string> = {
  accepted: 'Starting', queued: 'Queued', reasoning: 'Thinking', retrieving: 'Reading',
  using_tool: 'Working', fanout: 'Working', reducing: 'Combining', verifying: 'Verifying',
  retrying: 'Retrying', completing: 'Finishing',
};

/** One line under a running row: phase, progress, and what comes next — the
 *  server's words, never a guess. */
export function runningMeta(entry: ActivityEntry): string {
  const progress = entry.progress && entry.progress.total > 0
    ? `${entry.progress.completed} of ${entry.progress.total}`
    : entry.children && entry.children.total > 0
      ? `${entry.children.completed} of ${entry.children.total} done`
      : '';
  // A run that has sat in 'accepted'/'queued' for a long time is not lying —
  // the server still owns its state — but 'Starting' alone hides the age. Say
  // when it started; the age is durable data, not an inference.
  const startedMs = entry.startedAt ? Date.parse(entry.startedAt) : NaN;
  const longWait = (entry.lifecycle === 'accepted' || entry.lifecycle === 'queued')
    && Number.isFinite(startedMs) && Date.now() - startedMs > 15 * 60_000;
  const parts = [
    entry.activity?.text?.trim() || LIFECYCLE_LABELS[entry.lifecycle] || '',
    longWait ? `started ${agoLabel(entry.startedAt)}` : '',
    progress,
    entry.nextAction ? `next: ${entry.nextAction}` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

/** 0–100 when the server owns a real denominator; null otherwise. */
export function runningPercent(entry: ActivityEntry): number | null {
  const source = entry.progress && entry.progress.total > 0
    ? entry.progress
    : entry.children && entry.children.total > 0
      ? entry.children
      : null;
  if (!source) return null;
  return Math.max(0, Math.min(100, Math.round((source.completed / source.total) * 100)));
}

// ─── Projects ──────────────────────────────────────────────────────────────

const STATUS_RANK: Record<SpaceRecord['status'], number> = { active: 0, paused: 1, archived: 2 };

function recency(space: SpaceRecord): number {
  const t = Date.parse(space.lastOpenedAt ?? '') || Date.parse(space.updatedAt ?? '') || 0;
  return Number.isFinite(t) ? t : 0;
}

/** Active first, most recently opened first; archived never shows on Home. */
export function homeProjects(spaces: readonly SpaceRecord[], cap = 3): SpaceRecord[] {
  return [...spaces]
    .filter((space) => space.status !== 'archived')
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || recency(b) - recency(a))
    .slice(0, cap);
}

/** The project the user is in the middle of: the most recently opened active
 *  space. Shared by the Projects pane and the "current project" landing. */
export function currentProject(spaces: readonly SpaceRecord[]): SpaceRecord | null {
  const active = spaces.filter((space) => space.status === 'active').sort((a, b) => recency(b) - recency(a));
  return active[0] ?? null;
}

export function projectSubtitle(space: SpaceRecord): string {
  const objective = space.contract?.objective?.trim();
  if (objective) return objective.length > 72 ? `${objective.slice(0, 71).trimEnd()}…` : objective;
  const scheduled = space.dataSources.find((source) => source.schedule);
  if (scheduled?.schedule) {
    try { return humanizeCron(scheduled.schedule, scheduled.timezone); } catch { return scheduled.schedule; }
  }
  const sources = space.dataSources.length;
  if (sources > 0) return `${sources} data source${sources === 1 ? '' : 's'}`;
  return space.status === 'paused' ? 'Paused' : 'Static view';
}


/** Strip markdown so previews read as prose: **bold**, *em*, `code`, headings, links. */
export function plainText(input?: string | null, max = 400): string {
  if (!input) return '';
  return input
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
