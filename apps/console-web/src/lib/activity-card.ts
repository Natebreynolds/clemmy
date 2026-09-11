/**
 * The activity card's pure model — the ONE build log that the chat reply, the
 * Space view and the home "Working now" all render. Owner, 2026-09-08: "seeing
 * what Clem is doing while she's doing it is key" — so the card's title, the
 * per-step elapsed, and the finished summary are decided here from the
 * ActivityItem rows the stream already carries, never re-derived per surface.
 */
import type { ActivityItem } from './useChat';

export interface ActivityCardHead {
  /** "Working on it" while live; a results-first summary once settled. */
  title: string;
  /** Rows still running (0 once settled). */
  running: number;
  /** Helpers (spawned agents) in this turn, running or not. */
  helpers: number;
  /** Client-clock anchor of the earliest row — the card's elapsed clock. */
  startedAt?: number;
  /** Elapsed of the whole turn once every row has settled, else undefined. */
  totalMs?: number;
}

/** Results first, then effort — the same order a person would report it. */
export function summarizeActivity(view: readonly ActivityItem[]): string {
  const work = view.filter((row) => row.id.startsWith('work:') || row.id.startsWith('plan:'));
  if (work.length > 0) {
    const done = work.filter((row) => row.tone === 'success').map((row) => row.label);
    const blocked = work.filter((row) => row.tone === 'warning').map((row) => row.label);
    const headline = [...done, ...blocked];
    if (headline.length > 0) return headline.join(' · ');
  }
  const tools = view.filter((item) => item.kind === 'tool').length;
  const helpers = view.filter((item) => item.kind === 'agent').length;
  const batches = view.filter((item) => item.kind === 'batch').length;
  const writes = view.filter((item) => item.kind === 'event' && item.variant === 'write').length;
  const filesSaved = view.find((item) => item.id === 'deliverables')?.count ?? 0;
  const parts: string[] = [];
  if (writes) parts.push(`${writes} ${writes === 1 ? 'thing sent or written' : 'things sent or written'}`);
  if (filesSaved) parts.push(`${filesSaved} file${filesSaved > 1 ? 's' : ''} saved`);
  if (helpers) parts.push(`${helpers} helper${helpers > 1 ? 's' : ''}`);
  if (batches) parts.push(`${batches} batch${batches > 1 ? 'es' : ''}`);
  if (tools) parts.push(`looked at ${tools} thing${tools > 1 ? 's' : ''}`);
  if (parts.length === 0) return 'Nothing to show';
  const [first, ...rest] = parts;
  const sentence = [first, ...rest].join(' · ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export function activityCardHead(view: readonly ActivityItem[], live: boolean, now: number): ActivityCardHead {
  const running = live ? view.filter((row) => row.status === 'running').length : 0;
  const helpers = view.filter((row) => row.kind === 'agent').length;
  const runningHelpers = live ? view.filter((row) => row.kind === 'agent' && row.status === 'running').length : 0;
  const starts = view.map((row) => row.startedAt).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const startedAt = starts.length > 0 ? Math.min(...starts) : undefined;
  const ends = view.map((row) => row.finishedAt).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const settled = !live && startedAt !== undefined && ends.length > 0;
  const totalMs = settled ? Math.max(0, Math.max(...ends) - startedAt) : undefined;
  const current = live
    ? [...view].reverse().find((row) => row.status === 'running')
    : undefined;
  const title = live
    ? (current?.label
      || (runningHelpers > 0
        ? `Working with ${runningHelpers} helper${runningHelpers > 1 ? 's' : ''}`
        : 'Working on it'))
    : summarizeActivity(view);
  void now;
  return { title, running, helpers, startedAt, totalMs };
}

/** "0:42" from a start anchor, or '' with no anchor. Minutes never overflow to hours here — a turn that long is a task. */
export function clockLabel(startedAt: number | undefined, now: number): string {
  if (!startedAt) return '';
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Per-step duration in the mono column: "1.4s" / "12s" / "1m 4s". Live rows tick; settled rows freeze. */
export function stepElapsed(row: Pick<ActivityItem, 'startedAt' | 'finishedAt' | 'status'>, now: number, live: boolean): string {
  if (!row.startedAt) return '';
  const end = row.status === 'running' ? (live ? now : undefined) : row.finishedAt;
  if (end === undefined) return '';
  const ms = Math.max(0, end - row.startedAt);
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Steps a spawned helper reported, keyed by the helper row they belong to.
 *  Rows tagged with `parentId` nest under that helper; everything else is a
 *  top-level step. Order inside each group is arrival order. */
export function groupActivityByParent(view: readonly ActivityItem[]): { top: ActivityItem[]; children: Map<string, ActivityItem[]> } {
  const children = new Map<string, ActivityItem[]>();
  const ids = new Set(view.map((row) => row.id));
  const top: ActivityItem[] = [];
  for (const row of view) {
    if (row.parentId && ids.has(row.parentId)) {
      const list = children.get(row.parentId) ?? [];
      list.push(row);
      children.set(row.parentId, list);
    } else {
      top.push(row);
    }
  }
  return { top, children };
}
