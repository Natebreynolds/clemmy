import {
  workingNowLifecycleLabel,
  workingNowStatusLabel,
  type PresentedWorkingNowEntry,
} from '@clem/chat-engine';
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

/** Human vocabulary for a server-owned lifecycle — the SHARED one, so the phone
 * cannot word a lifecycle differently from the pill above it or the desktop
 * beside it. Unknown values fail closed instead of turning an internal spelling
 * into user-facing state. */
export const lifecycleLabel = workingNowLifecycleLabel;

/**
 * The one line under a run row's title — and the place the phone stops
 * rendering a past fact as a present one. The words come from the shared
 * presenter (workingNowStatusLabel), so the row and the chip above it cannot
 * disagree; this is only the phone's adapter from its DTO to that call.
 */
export function runStatusLabel(presented: PresentedWorkingNowEntry<ActivityEntry>): string {
  return workingNowStatusLabel({
    membership: presented.membership,
    silence: presented.silence,
    quiet: presented.quiet,
    lifecycle: presented.entry.lifecycle,
    ...(presented.entry.activity?.text ? { phase: presented.entry.activity.text } : {}),
  });
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

/**
 * The workflow run ids this phone can actually END right now.
 *
 * A CONTROL MAY NOT BE OFFERED FOR SOMETHING IT CANNOT DO. An Inbox
 * notification carries the runId it was written about and nothing else — no
 * status crosses the mobile boundary — so a button gated on "this row names a
 * run" is really gated on a fact stamped days ago. Measured on the owner's
 * store 2026-09-06: 54 unread notifications carry a runId, and the
 * cancellation authority's own TERMINAL_STATUSES
 * (src/execution/workflow-run-cancellation.ts:61 — completed, blocked, error,
 * failed, cancelled, dry_run, creation_test) already covers 48 of them. Those
 * 48 taps could only ever return 409 ALREADY_FINISHED.
 *
 * So liveness is read from the one place that owns it: the server's Working
 * Now projection, which drops every terminal run before the phone sees it
 * (shouldSurfaceInWorkingNow), narrowed by the SAME mobileRunControl decision
 * the running-tasks sheet and Activity already use — no second opinion about
 * what is stoppable. On that same store this set is exactly the 6 runs the
 * cancel route accepts: 0 false offers, 0 real ones lost.
 */
export function stoppableWorkflowRunIds(entries: readonly ActivityEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    const control = mobileRunControl(entry);
    if (control?.target.kind === 'workflow') ids.add(control.target.runId);
  }
  return ids;
}
