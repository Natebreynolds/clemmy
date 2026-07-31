/**
 * Live-agents panel presentation — the glanceable "who is working right now"
 * projection of the Tasks board, for the slide-in panel on every screen.
 *
 * PURE RUNNING WORK ONLY (owner decision, 2026-07-30 declutter): the first
 * live day filled this panel with week-old "waiting on you" rows and it read
 * as nagging backlog, not live work. Waiting items belong to the chat's
 * Needs-you strip, the Inbox, and the Tasks board — this surface answers one
 * question: what is Clem doing right now.
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
 * The panel's rows: genuinely RUNNING work only, newest first. Queued work
 * has not started, finished work reports back into the chat + Delivered, and
 * waiting-on-you items live on the Needs-you strip / Inbox / Tasks — none of
 * them belong here. A `parked` workflow run mis-columns as running upstream
 * (the column derives from inFlightStepId alone) but is actually blocking on
 * the user, so it is excluded too.
 */
export function liveAgentRows(cards: BoardCard[]): LiveAgentRow[] {
  return cards
    .filter((card) => card.column === 'running' && !card.archived && card.status !== 'parked')
    .sort((a, b) => a.ageMs - b.ageMs)
    .map((card) => ({
      id: `${card.sourceKind}:${card.id}`,
      sourceKind: card.sourceKind,
      title: card.title,
      statusLine: card.progressHint || '',
      elapsedLabel: elapsedLabel(card.ageMs),
      canStop: card.actions.includes('cancel'),
      sessionId: card.sessionId,
      card,
    }));
}

/** Badge on the toggle button: how many agents are live right now. */
export function liveAgentBadgeCount(cards: BoardCard[]): number {
  return liveAgentRows(cards).length;
}

/** A row only counts as "just started" for this long — older rows appearing
 *  in the poll are pre-existing work (an app launch, a re-focused tab), not a
 *  live kickoff, and must not pop the panel at the user. */
export const AUTO_OPEN_FRESH_MS = 5 * 60_000;

export interface LiveAgentAutoOpenState {
  seenIds: string[];
  /** False until the first poll has seeded the seen-set. */
  primed: boolean;
}

/**
 * Auto-pop decision: the panel opens itself ONLY when work starts while the
 * user is actually here — a new row that is genuinely fresh, observed on a
 * poll AFTER the first. The first poll seeds the seen-set silently, so an app
 * launch with pre-existing work never pops (the live 2026-07-30 regression:
 * the in-memory seen-set made every launch "new"). Closing the panel is
 * respected until the next live start. Pure: the caller persists the state.
 */
export function liveAgentAutoOpen(
  state: LiveAgentAutoOpenState,
  cards: BoardCard[],
): { open: boolean; state: LiveAgentAutoOpenState } {
  const rows = liveAgentRows(cards);
  const current = rows.map((row) => row.id);
  if (!state.primed) {
    return { open: false, state: { seenIds: current, primed: true } };
  }
  const seen = new Set(state.seenIds);
  const open = rows.some((row) => !seen.has(row.id) && row.card.ageMs < AUTO_OPEN_FRESH_MS);
  return { open, state: { seenIds: current, primed: true } };
}
