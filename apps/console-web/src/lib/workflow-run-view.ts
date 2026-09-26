/**
 * The Last run tab, the pure half: which run to show, what each step's status
 * is called, and how it is coloured. Every fact comes from the daemon's run
 * overlay; nothing here re-derives a state from prose.
 */
import type { WorkflowRunOverlay, WorkflowRunOverlayStep, WorkflowRunRecord, WorkflowRunStepStatus } from './automate';
import { RUN_STILL_GOING } from './workflow-step-view';

export type RunStepTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral' | 'live';

/** The words on the step, for a wait a wait. */
export function runStepLabel(status: WorkflowRunStepStatus): string {
  switch (status) {
    case 'pending': return 'Not started';
    case 'running': return 'Working';
    case 'done': return 'Done';
    case 'failed': return 'Failed';
    case 'skipped': return 'Skipped';
    case 'blocked': return 'Blocked';
    case 'awaiting_approval': return 'Waiting on you';
    case 'awaiting_input': return 'Waiting for your answer';
    case 'awaiting_capability': return 'Waiting for a connection';
    case 'redoing': return 'Redoing';
  }
}

export function runStepTone(status: WorkflowRunStepStatus): RunStepTone {
  switch (status) {
    case 'done': return 'success';
    case 'failed': return 'danger';
    case 'running': case 'redoing': return 'live';
    case 'blocked': case 'awaiting_approval': case 'awaiting_input': case 'awaiting_capability': return 'warning';
    case 'skipped': case 'pending': return 'neutral';
  }
}

/** True while the run may still change, so the overlay keeps refreshing. */
export function runStillGoing(run: Pick<WorkflowRunRecord, 'status'> | null | undefined): boolean {
  return !!run && RUN_STILL_GOING.has(String(run.status ?? 'queued'));
}

/** The run the tab opens on: the newest one. */
export function latestRun(runs: readonly WorkflowRunRecord[] | undefined): WorkflowRunRecord | null {
  if (!runs?.length) return null;
  return [...runs].sort((a, b) => String(b.createdAt ?? b.startedAt ?? '').localeCompare(String(a.createdAt ?? a.startedAt ?? '')))[0] ?? null;
}

/** "Today 07:00 · scheduled" for a run row: when it ran and who started it, never the id. */
export function runWhen(run: Pick<WorkflowRunRecord, 'startedAt' | 'createdAt' | 'source'>, now: Date = new Date()): string {
  const iso = run.startedAt ?? run.createdAt;
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(t)) return 'a run';
  const d = new Date(t);
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const day = sameDay ? 'Today' : d.toDateString() === yesterday.toDateString() ? 'Yesterday' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const who = run.source === 'console' || run.source === 'dashboard' ? 'you' : run.source === 'scheduler' || run.source === 'cron' ? 'scheduled' : run.source ?? '';
  return `${day} ${time}${who ? ` · ${who}` : ''}`;
}

export function overlayByStep(overlay: WorkflowRunOverlay | null | undefined): Map<string, WorkflowRunOverlayStep> {
  return new Map((overlay?.steps ?? []).map((step) => [step.stepId, step]));
}

/** One line for the run itself: what state it is in and where it stands. */
export function runHeadline(overlay: WorkflowRunOverlay | null | undefined, run: Pick<WorkflowRunRecord, 'status'> | null | undefined): string {
  if (!overlay) return run ? runStepLabel(run.status === 'completed' ? 'done' : run.status === 'failed' ? 'failed' : 'running') : '';
  const s = overlay.summary;
  const parts: string[] = [];
  if (s.doneSteps) parts.push(`${s.doneSteps} done`);
  if (s.runningSteps) parts.push(`${s.runningSteps} working`);
  if (s.waitingSteps) parts.push(`${s.waitingSteps} waiting on you`);
  if (s.blockedSteps) parts.push(`${s.blockedSteps} blocked`);
  if (s.failedSteps) parts.push(`${s.failedSteps} failed`);
  if (s.skippedSteps) parts.push(`${s.skippedSteps} skipped`);
  if (s.pendingSteps) parts.push(`${s.pendingSteps} not started`);
  const state = overlay.runStatus === 'completed' ? 'Finished'
    : overlay.runStatus === 'failed' ? 'Failed'
      : overlay.runStatus === 'cancelled' ? 'Cancelled'
        : overlay.runStatus === 'paused' ? 'Paused'
          : overlay.runStatus === 'running' ? 'Running' : 'Run';
  return parts.length ? `${state} · ${parts.join(' · ')}` : state;
}

export function formatDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${ms} ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs < 10 ? secs.toFixed(1) : Math.round(secs)} s`;
  const min = Math.floor(secs / 60);
  return `${min} min ${Math.round(secs - min * 60)} s`;
}
