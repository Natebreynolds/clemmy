import type { ActivityEntry } from './api';

export type MobileRunControlTarget =
  | { kind: 'run'; runId: string }
  | { kind: 'chat'; sessionId: string; attemptId: string }
  | { kind: 'workflow'; workflow: string; runId: string }
  | { kind: 'task'; taskId: string };

const STOPPABLE_LIFECYCLES = new Set([
  'accepted',
  'queued',
  'reasoning',
  'retrieving',
  'using_tool',
  'fanout',
  'reducing',
  'verifying',
  'awaiting_input',
  'awaiting_approval',
  'retrying',
  'completing',
]);

/** Human vocabulary for a server-owned lifecycle. Unknown values fail closed
 * instead of turning an internal spelling into user-facing state. */
export function lifecycleLabel(lifecycle: string): string {
  const labels: Record<string, string> = {
    accepted: 'Accepted',
    queued: 'Queued',
    reasoning: 'Running',
    retrieving: 'Reading',
    using_tool: 'Running',
    fanout: 'Running',
    reducing: 'Combining',
    verifying: 'Verifying',
    awaiting_input: 'Waiting for input',
    awaiting_approval: 'Waiting for approval',
    paused_budget: 'Stopped',
    retrying: 'Retrying',
    completing: 'Finishing',
    blocked: 'Needs review',
    completed: 'Done',
    failed: 'Failed',
    cancelled: 'Stopped',
  };
  return labels[lifecycle] ?? 'Status unavailable';
}

export function kindLabel(kind: ActivityEntry['kind']): string {
  if (kind === 'background') return 'Task';
  if (kind === 'fanout') return 'Plan';
  if (kind === 'workflow') return 'Workflow';
  return 'Chat';
}

/** Elapsed is measured between TWO server timestamps. It advances only when a
 * fresh snapshot arrives; it never turns client wall time into liveness. */
export function elapsedLabel(startedAt: string, observedAt: string): string {
  const start = Date.parse(startedAt);
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(start) || !Number.isFinite(observed) || observed < start) return '';
  const seconds = Math.floor((observed - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function workerCountLabel(entry: ActivityEntry): string {
  const children = entry.children;
  if (!children || children.total <= 0) return '';
  const parts = [`${children.running} running`, `${children.completed}/${children.total} done`];
  if (children.failed > 0) parts.push(`${children.failed} failed`);
  return parts.join(' · ');
}

/** Expansion is useful only when the foreground-safe DTO contains a fact the
 * sheet can actually reveal. Identity and Needs-review state alone must not
 * manufacture a no-op Open/Review control. */
export function hasExpandableTaskFacts(entry: ActivityEntry): boolean {
  return Boolean(entry.activity?.text.trim())
    || Boolean(entry.progress && entry.progress.total > 0)
    || Boolean(entry.children && entry.children.total > 0);
}

/** Reuse the phone's existing confirmed run controls only where the shared
 * projection supplies the exact identity and an explicitly supported active
 * lifecycle. Unknown/stale/terminal shapes fail closed to no mutation action. */
export function mobileRunControl(entry: ActivityEntry): {
  target: MobileRunControlTarget;
  resumable: boolean;
} | null {
  // The foreground DTO has no terminal field. Still fail closed if a stale or
  // malformed server ever sends one across the structural JSON boundary.
  if ((entry as unknown as { terminal?: unknown }).terminal) return null;
  // A live chat turn is stoppable from the phone via the same exact-attempt
  // primitive the desktop uses. Requires BOTH identities: the kill latch names
  // the attempt, and the route stale-checks it, so this can never widen a
  // stale row into a session-wide kill. Before this mapping the phone had no
  // way to stop a turn at all — engine stop() only detached the stream.
  if (entry.kind === 'chat' && entry.sessionId && entry.attemptId && STOPPABLE_LIFECYCLES.has(entry.lifecycle)) {
    return {
      target: { kind: 'chat', sessionId: entry.sessionId, attemptId: entry.attemptId },
      resumable: false,
    };
  }
  if (entry.kind === 'background' && entry.taskId) {
    if (entry.lifecycle === 'paused_budget') {
      return { target: { kind: 'task', taskId: entry.taskId }, resumable: true };
    }
    if (STOPPABLE_LIFECYCLES.has(entry.lifecycle)) {
      return { target: { kind: 'task', taskId: entry.taskId }, resumable: false };
    }
  }
  if (entry.kind === 'workflow' && entry.runId && entry.headline && STOPPABLE_LIFECYCLES.has(entry.lifecycle)) {
    return {
      target: { kind: 'workflow', workflow: entry.headline, runId: entry.runId },
      resumable: false,
    };
  }
  return null;
}
