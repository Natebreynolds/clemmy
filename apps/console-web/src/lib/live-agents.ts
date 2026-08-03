/**
 * Live-agents panel presentation — the glanceable "what is running away from
 * this foreground conversation" projection of the Tasks board.
 *
 * PURE RUNNING WORK ONLY (owner decision, 2026-07-30 declutter): the first
 * live day filled this panel with week-old "waiting on you" rows and it read
 * as nagging backlog, not live work. Waiting items belong to the chat's
 * Needs-you strip, the Inbox, and the Tasks board — this surface answers one
 * question: what is Clem doing right now.
 *
 * A canonical harness attempt is the foreground chat itself. Its progress is
 * already rendered in ChatBubble, so mirroring it here made every message pop
 * an empty-looking side panel. Detached/background work still belongs here.
 * The top-bar count is intentionally passive: background work never moves the
 * user's layout. The user opens this panel when they want it.
 */
import type { BoardCard, BoardSourceKind } from './board';

export interface LiveAgentRow {
  id: string;
  sourceKind: BoardSourceKind;
  title: string;
  /** One glanceable line: the card's live progress hint (may be ''). */
  statusLine: string;
  /** Age of the latest update, explicitly labeled as recency (not elapsed run
   * time—the board API currently supplies updatedAt-derived ageMs). */
  updatedLabel: string;
  canStop: boolean;
  sessionId: string | null;
  card: BoardCard;
}

/** Canonical harness attempts are the currently visible foreground
 * conversation, not a second agent working in the background. Legacy run
 * records do not carry attemptId and remain eligible for this panel. */
export function isForegroundConversationCard(card: BoardCard): boolean {
  return card.sourceKind === 'run' && Boolean(card.attemptId);
}

export function updatedLabel(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return '';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return 'updated now';
  if (minutes < 60) return `updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `updated ${hours}h ${minutes % 60}m ago`;
  return `updated ${Math.floor(hours / 24)}d ago`;
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
    .filter((card) => (
      card.column === 'running'
      && !card.archived
      && card.status !== 'parked'
      && !isForegroundConversationCard(card)
    ))
    .sort((a, b) => a.ageMs - b.ageMs)
    .map((card) => ({
      id: `${card.sourceKind}:${card.id}`,
      sourceKind: card.sourceKind,
      title: card.title,
      statusLine: card.progressHint || '',
      updatedLabel: updatedLabel(card.ageMs),
      canStop: card.actions.includes('cancel'),
      sessionId: card.sessionId,
      card,
    }));
}

/** Badge on the toggle button: how many agents are live right now. */
export function liveAgentBadgeCount(cards: BoardCard[]): number {
  return liveAgentRows(cards).length;
}

/** Exact Tasks target for a row. Canonical runs carry attempt/scope identity;
 * other sources still land on their best board-card or session selector. */
export function liveAgentTarget(row: LiveAgentRow): string {
  const select = row.sessionId || row.card.id;
  const params = new URLSearchParams({ select });
  if (row.card.attemptId) params.set('attemptId', row.card.attemptId);
  if (row.card.runScopeId) params.set('runScopeId', row.card.runScopeId);
  return `/tasks?${params.toString()}`;
}
