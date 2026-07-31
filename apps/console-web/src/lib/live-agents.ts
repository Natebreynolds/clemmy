/**
 * Live-agents panel presentation — the simple "who is working right now"
 * projection of the Tasks board, for the slide-in panel on every screen.
 *
 * Replaces the old Run environment panel (plan/helpers/provenance bookkeeping
 * inline) with the owner's actual mental model: Clem kicks work off, the chat
 * stays free, a side panel shows the live agents, and results come back
 * proactively. Deep inspection stays on the Tasks board; this surface is
 * glanceable rows + a stop button.
 *
 * Everything here is pure so the row projection, badge count, and the
 * auto-pop decision get cheap regression pins (same pattern as
 * chatRailLayout).
 */
import type { BoardCard, BoardSourceKind } from './board';

export interface LiveAgentRow {
  id: string;
  sourceKind: BoardSourceKind;
  title: string;
  /** One glanceable line: the card's live progress hint (may be ''). */
  statusLine: string;
  needsYou: boolean;
  elapsedLabel: string;
  canStop: boolean;
  sessionId: string | null;
  card: BoardCard;
}

export function elapsedLabel(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return '';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

/** Human word for where a row came from — spoken language, never plumbing. */
export function sourceKindLabel(kind: BoardSourceKind): string {
  switch (kind) {
    case 'guest': return 'project run';
    case 'workflow': return 'workflow';
    case 'background': return 'task';
    case 'execution': return 'execution';
    case 'approval': return 'approval';
    case 'schedule': return 'scheduled';
    case 'run': return 'run';
    default: return 'work';
  }
}

/**
 * The panel's rows: everything live (running) or blocked on the user
 * (needs_you), needs-you first so a waiting decision is never below the fold,
 * then newest-first. Queued and done stay off this surface — queued work has
 * not started and finished work reports back into the chat + Delivered.
 */
export function liveAgentRows(cards: BoardCard[]): LiveAgentRow[] {
  return cards
    .filter((card) => (card.column === 'running' || card.column === 'needs_you') && !card.archived)
    .sort((a, b) => {
      if (a.column !== b.column) return a.column === 'needs_you' ? -1 : 1;
      return a.ageMs - b.ageMs;
    })
    .map((card) => ({
      id: `${card.sourceKind}:${card.id}`,
      sourceKind: card.sourceKind,
      title: card.title,
      statusLine: card.progressHint || '',
      needsYou: card.column === 'needs_you',
      elapsedLabel: elapsedLabel(card.ageMs),
      canStop: card.column === 'running' && card.actions.includes('cancel'),
      sessionId: card.sessionId,
      card,
    }));
}

/** Badge on the toggle button: live + waiting-on-you, the two states worth a glance. */
export function liveAgentBadgeCount(cards: BoardCard[]): number {
  return liveAgentRows(cards).length;
}

/**
 * Auto-pop decision: the panel opens itself exactly when a NEW live row
 * appears (Clem just kicked something off, or something started needing the
 * user) — and never re-opens for rows the user already saw and closed the
 * panel on. Pure: the caller persists `seenIds` across polls.
 */
export function liveAgentAutoOpen(
  seenIds: readonly string[],
  cards: BoardCard[],
): { open: boolean; seenIds: string[] } {
  const rows = liveAgentRows(cards);
  const current = rows.map((row) => row.id);
  const seen = new Set(seenIds);
  const open = current.some((id) => !seen.has(id));
  return { open, seenIds: current };
}
