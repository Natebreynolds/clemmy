/**
 * Human vocabulary + evidence derivation for work status, shared by the Tasks
 * board and chat. One place turns raw harness states and durable
 * TaskOutcomeSnapshot facts into calm, plain-language UI — so raw strings like
 * `awaiting_capability` and engineering prose never fall through into pills.
 */
import type { TaskOutcomeSnapshot } from './board';

/** Raw harness/board statuses → plain language. Anything unknown is
 *  prettified snake_case (never rendered verbatim with underscores). */
const STATUS_LABELS: Record<string, string> = {
  parked: 'Waiting for your approval',
  awaiting_approval: 'Waiting for your approval',
  waiting_for_approval: 'Waiting for your approval',
  awaiting_input: 'Needs your reply',
  awaiting_user_input: 'Needs your reply',
  awaiting_continue: 'Ready to continue',
  awaiting_capability: 'Waiting for a connection',
  capability_blocked: 'Waiting for a connection',
  needs_attention: 'Needs review',
  interrupted: 'Interrupted — resumable',
  cancelling: 'Stopping…',
  cancelled: 'Stopped',
  blocked: 'Blocked — see what’s needed',
  failed: 'Did not finish',
  error: 'Did not finish',
  running: 'Working',
  active: 'Working',
  queued: 'Queued',
  missed_schedule: 'Missed schedule',
  awaiting_catchup_decision: 'Missed schedule',
  completed: 'Done',
  succeeded: 'Done',
};

export function humanStatusLabel(status: string): string {
  const key = status.trim().toLowerCase();
  if (STATUS_LABELS[key]) return STATUS_LABELS[key];
  if (key.startsWith('step:')) return 'Working';
  // Prettify unknown raw states instead of leaking them verbatim.
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Unknown';
}

export interface EvidenceSummary {
  /** e.g. "119/120 items" — present when the manifest declared countable work. */
  work?: string;
  /** Verified / total saved artifacts. */
  artifactsVerified: number;
  artifactsTotal: number;
  /** Committed external actions (sends, writes) with durable receipts. */
  receipts: number;
  /** True when every declared unit completed and no artifact is unverified. */
  complete: boolean;
}

/** Fold the durable outcome snapshot into chip-ready facts. Returns null when
 *  the task carries no evidence structure (the UI then shows nothing rather
 *  than inventing certainty). */
export function evidenceSummary(snapshot?: TaskOutcomeSnapshot | null): EvidenceSummary | null {
  const evidence = snapshot?.evidence;
  if (!evidence) return null;
  const work = evidence.work ?? [];
  const artifacts = evidence.artifacts ?? [];
  const receipts = evidence.committedExternalActions ?? 0;
  if (work.length === 0 && artifacts.length === 0 && receipts === 0) return null;

  const totals = work.reduce(
    (acc, w) => ({ completed: acc.completed + w.completed, total: acc.total + w.total }),
    { completed: 0, total: 0 },
  );
  const artifactsVerified = artifacts.filter((a) => a.verified).length;
  return {
    work: totals.total > 0 ? `${totals.completed}/${totals.total} items` : undefined,
    artifactsVerified,
    artifactsTotal: artifacts.length,
    receipts,
    complete:
      (totals.total === 0 || totals.completed === totals.total)
      && artifactsVerified === artifacts.length,
  };
}

/** Chip strings for compact rows. Order: work → artifacts → receipts. */
export function evidenceChips(snapshot?: TaskOutcomeSnapshot | null): string[] {
  const summary = evidenceSummary(snapshot);
  if (!summary) return [];
  const chips: string[] = [];
  if (summary.work) chips.push(summary.work);
  if (summary.artifactsTotal > 0) {
    chips.push(
      summary.artifactsVerified === summary.artifactsTotal
        ? `${summary.artifactsTotal} artifact${summary.artifactsTotal === 1 ? '' : 's'} ✓`
        : `${summary.artifactsVerified}/${summary.artifactsTotal} artifacts verified`,
    );
  }
  if (summary.receipts > 0) chips.push(`${summary.receipts} send receipt${summary.receipts === 1 ? '' : 's'}`);
  return chips;
}

export interface BlockerSummary {
  /** Plain-language dependency ("Railway sign-in is required"). */
  blocker: string;
  /** The exact thing the user should do next, if the harness recorded one. */
  nextAction?: string;
  /** Saved work resumes after the dependency clears. */
  resumable: boolean;
}

export function blockerSummary(snapshot?: TaskOutcomeSnapshot | null): BlockerSummary | null {
  if (!snapshot?.blocker) return null;
  return {
    blocker: snapshot.blocker,
    nextAction: snapshot.nextAction || undefined,
    resumable: snapshot.resumable !== false,
  };
}
