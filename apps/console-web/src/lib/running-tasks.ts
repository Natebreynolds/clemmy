import type { ActivityEntry } from './activity';
import type { BoardButtonIntent, BoardCard } from './board';

/** Match a shared activity row to the exact canonical Tasks card. Identity
 * outranks title/session convenience so a reusable chat session can never make
 * a stale drawer control a newer attempt. */
export function boardCardForActivity(entry: ActivityEntry, cards: BoardCard[]): BoardCard | undefined {
  // A fan-out plan is a parent aggregate, not the chat/run card that happened
  // to launch it. Shared session or attempt identity cannot grant the parent
  // controls for one of its origin/child runs.
  if (entry.kind === 'fanout') return undefined;
  if (entry.taskId) {
    const exactTask = cards.find((card) => card.sourceKind === 'background' && card.id === entry.taskId);
    if (exactTask) return exactTask;
  }
  if (entry.sessionId) {
    const sessionCards = cards.filter((card) => card.sessionId === entry.sessionId);
    const exactAttempt = sessionCards.find((card) => card.attemptId === entry.attemptId);
    if (exactAttempt) return exactAttempt;
    // A reusable chat session with no exact attempt match fails closed here —
    // even if an older card happens to share another run-shaped identifier.
    if (entry.kind === 'chat') return undefined;
    // A card without canonical attempt identity may still represent a durable
    // background task/workflow. A run card may not fall back by session.
    const durable = sessionCards.find((card) => card.sourceKind !== 'run' && !card.attemptId);
    if (durable) return durable;
  }
  if (entry.runId) {
    return cards.find((card) => card.raw.runId === entry.runId
      && (!card.attemptId || card.attemptId === entry.attemptId));
  }
  return undefined;
}

export interface RunningTaskActions {
  openHref?: string;
  openLabel: 'Open' | 'Review';
  stop?: BoardButtonIntent;
  resume?: BoardButtonIntent;
}

export function runningTaskActions(entry: ActivityEntry, card?: BoardCard): RunningTaskActions {
  if (!card) return { openLabel: entry.needsAttention ? 'Review' : 'Open' };
  const select = card.sessionId || card.raw.runId || card.id;
  const params = new URLSearchParams({ select });
  if (card.attemptId) params.set('attemptId', card.attemptId);
  if (card.runScopeId) params.set('runScopeId', card.runScopeId);
  return {
    openHref: `/tasks?${params.toString()}`,
    openLabel: entry.needsAttention || card.column === 'needs_you' ? 'Review' : 'Open',
    ...(card.actions.includes('cancel') ? { stop: 'cancel' as const } : {}),
    ...(card.actions.includes('resume_safe')
      ? { resume: 'resume_safe' as const }
      : card.actions.includes('resume')
        ? { resume: 'resume' as const }
        : {}),
  };
}

export function serverElapsedLabel(startedAt: string, observedAt: string): string {
  const started = Date.parse(startedAt);
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(started) || !Number.isFinite(observed) || observed < started) return '';
  const seconds = Math.floor((observed - started) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}
