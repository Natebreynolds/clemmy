import { useState } from 'preact/hooks';
import {
  getWorkflowRunEvents,
  listWorkflowRuns,
  listWorkflows,
  runWorkflow,
  type MobileWorkflow,
  type WorkflowEventSummary,
  type WorkflowRunSummary,
} from '../lib/api';
import { RunControl } from '../components/RunControl';
import { ScreenNotice } from '../components/ScreenNotice';
import { haptic } from '../lib/native-bridge';
import { useScreenData } from '../lib/use-screen-data';

/** Mirrors src/execution/workflow-run-cancellation.ts — anything else is live. */
const TERMINAL_RUN_STATUSES = new Set([
  'completed', 'completed_with_errors', 'error', 'failed', 'cancelled', 'dry_run', 'creation_test',
]);

export function Workflows() {
  const [selected, setSelected] = useState<MobileWorkflow | null>(null);
  const { data, loading, error, offline, refresh } = useScreenData(
    listWorkflows,
    { intervalMs: 10_000, disabled: selected !== null },
  );
  const workflows = data?.workflows ?? [];

  if (selected) {
    return <WorkflowDetail workflow={selected} onBack={() => { setSelected(null); void refresh(); }} />;
  }

  if (loading && workflows.length === 0) {
    return <div class="skeleton-stack" aria-hidden="true"><i /><i /><i /></div>;
  }
  if ((error || offline) && workflows.length === 0) {
    return <ScreenNotice error={error} offline={offline} onRetry={() => void refresh()} />;
  }
  if (workflows.length === 0) {
    return (
      <div class="empty">
        <img class="empty-mark" src="/m/clemmy.png" alt="" width="72" height="72" />
        <p class="empty-title">No flows yet</p>
        <p class="empty-body">Flows are the routines Clem runs for you. Build one on the desktop and trigger it from here.</p>
      </div>
    );
  }

  return (
    <div>
      <ScreenNotice error={error} offline={offline} onRetry={() => void refresh()} hasData />
      {workflows.map((wf) => (
        <button key={wf.name} class="workflow-row" onClick={() => setSelected(wf)}>
          <div class="workflow-row-head">
            <span class="workflow-row-name">{wf.name}</span>
            <span class={`workflow-row-status status-${(wf.lastRunOutcome ?? wf.lastRunStatus ?? 'unknown').toLowerCase()}`}>
              {wf.enabled ? (wf.lastRunOutcome ?? wf.lastRunStatus ?? 'idle') : 'disabled'}
            </span>
          </div>
          {wf.description ? <div class="workflow-row-desc">{wf.description}</div> : null}
          <div class="workflow-row-meta">
            <span>{wf.stepCount} steps</span>
            {wf.schedule ? <span>cron: {wf.schedule}</span> : null}
            {wf.requiresInput ? <span class="workflow-row-tag">needs input</span> : null}
            {wf.lastRunAt ? <span>last: {relativeTime(wf.lastRunAt)}</span> : null}
          </div>
        </button>
      ))}
    </div>
  );
}

interface WorkflowDetailProps {
  workflow: MobileWorkflow;
  onBack: () => void;
}

function WorkflowDetail({ workflow, onBack }: WorkflowDetailProps) {
  const [triggering, setTriggering] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<WorkflowRunSummary | null>(null);
  const { data, loading: runsLoading, error, offline, refresh } = useScreenData(
    () => listWorkflowRuns(workflow.name, 20),
    { intervalMs: 8_000, disabled: selectedRun !== null },
  );
  const runs = data?.runs ?? [];

  async function trigger() {
    if (triggering) return;
    setTriggering(true);
    haptic('medium');
    setActionError(null);
    try {
      await runWorkflow(workflow.name);
      // Refresh to surface the new queued run.
      void refresh();
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 409 && e.message?.includes('REQUIRES_INPUT')) {
        setActionError('This workflow needs input. Run it from the desktop app for now.');
      } else if (e.status === 409 && e.message?.includes('DISABLED')) {
        setActionError('This workflow is disabled. Enable it from the desktop app first.');
      } else {
        setActionError(e.message ?? 'Failed to trigger workflow');
      }
    } finally {
      setTriggering(false);
    }
  }

  if (selectedRun) {
    return (
      <WorkflowRunEvents
        workflowName={workflow.name}
        run={selectedRun}
        onBack={() => { setSelectedRun(null); void refresh(); }}
      />
    );
  }

  return (
    <div class="workflow-detail">
      <div class="chat-header">
        <button class="chat-back" onClick={onBack} aria-label="Back">←</button>
        <div class="chat-title">{workflow.name}</div>
      </div>
      <div class="workflow-detail-body">
        {workflow.description ? <p class="workflow-desc">{workflow.description}</p> : null}
        <div class="workflow-actions">
          <button
            class="btn"
            disabled={triggering || !workflow.enabled || workflow.requiresInput}
            onClick={trigger}
          >
            {triggering ? 'Queuing…' : workflow.requiresInput ? 'Needs input — use desktop' : !workflow.enabled ? 'Disabled' : 'Run now'}
          </button>
        </div>
        {actionError ? <div class="global-error">{actionError}</div> : null}
        <ScreenNotice error={error} offline={offline} onRetry={() => void refresh()} hasData={runs.length > 0} />
        <div class="memory-section-head">Recent runs</div>
        {runsLoading && runs.length === 0 ? <div class="skeleton-stack" aria-hidden="true"><i /></div> : null}
        {!runsLoading && runs.length === 0 ? <p class="muted">Hasn’t run yet.</p> : null}
        <div class="stack">
          {runs.map((run, i) => {
            const live = !TERMINAL_RUN_STATUSES.has(run.status);
            return (
              <article key={run.id} class={`card rise ${live ? 'card-live' : ''}`} style={{ '--i': i }}>
                {live ? <span class="pulse-dot" aria-hidden="true" /> : null}
                <button class="run-open min-w-0" onClick={() => setSelectedRun(run)}>
                  <div class="card-title-sm truncate">{run.id}</div>
                  <div class="card-when">
                    {live ? null : <span class={`status-dot status-${run.terminalOutcome ?? run.status}`} aria-hidden="true" />}
                    {(run.terminalOutcome ?? run.status).replace(/_/g, ' ')}
                  </div>
                </button>
                {live ? (
                  <RunControl
                    target={{ kind: 'workflow', workflow: workflow.name, runId: run.id }}
                    onChanged={() => void refresh()}
                  />
                ) : null}
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface WorkflowRunEventsProps {
  workflowName: string;
  run: WorkflowRunSummary;
  onBack: () => void;
}

function WorkflowRunEvents({ workflowName, run, onBack }: WorkflowRunEventsProps) {
  const { data, loading, error, offline, refresh } = useScreenData(
    () => getWorkflowRunEvents(workflowName, run.id, 200),
    { intervalMs: 5_000 },
  );
  const events = data?.events ?? [];

  return (
    <div class="workflow-detail">
      <div class="chat-header">
        <button class="chat-back" onClick={onBack} aria-label="Back">←</button>
        <div class="chat-title">{run.id}</div>
      </div>
      <div class="workflow-detail-body">
        <div class="memory-section-head">
          <span>{run.status}</span>
          {run.error ? <span class="memory-section-count" style="color:var(--accent-fail)">error</span> : null}
        </div>
        {loading && events.length === 0 ? <div class="skeleton-stack" aria-hidden="true"><i /></div> : null}
        {!loading && !error && !offline && events.length === 0 ? <p class="muted">No steps recorded yet.</p> : null}
        <ScreenNotice error={error} offline={offline} onRetry={() => void refresh()} hasData={events.length > 0} />
        {events.map((ev, idx) => (
          <div key={idx} class={`workflow-event ${ev.error ? 'event-error' : ''}`}>
            <div class="workflow-event-head">
              <span class="workflow-event-kind">{workflowEventLabel(ev)}</span>
              {workflowEventDetail(ev) ? <span class="workflow-event-step">{workflowEventDetail(ev)}</span> : null}
              <span class="workflow-event-time">{shortTime(ev.t)}</span>
            </div>
            {ev.error ? <div class="workflow-event-error">{ev.error}</div> : null}
            {ev.outputPreview ? <pre class="workflow-event-output">{ev.outputPreview}</pre> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function workflowEventLabel(ev: WorkflowEventSummary): string {
  switch (ev.kind) {
    case 'run_started': return 'Run started';
    case 'run_resumed': return 'Run resumed';
    case 'run_summary': return 'Run summary';
    case 'run_completed': return 'Completed';
    case 'run_failed': return 'Failed';
    case 'step_started': return 'Step started';
    case 'step_completed': return 'Step done';
    case 'step_failed': return 'Step failed';
    case 'step_advisory': return 'Note';
    case 'item_started': return 'Item started';
    case 'item_completed': return 'Item done';
    case 'item_failed': return 'Item failed';
    case 'approval_requested': return 'Needs approval';
    default: return ev.kind.replace(/_/g, ' ');
  }
}

function workflowEventDetail(ev: WorkflowEventSummary): string {
  if (ev.kind === 'run_summary') {
    return [
      typeof ev.meta?.because === 'string' ? ev.meta.because : '',
      workflowArtifactsText(ev.meta?.artifacts),
    ].filter(Boolean).join(' · ');
  }
  if (ev.kind === 'step_advisory') {
    return [ev.stepId, typeof ev.meta?.reason === 'string' ? ev.meta.reason : ''].filter(Boolean).join(' · ');
  }
  if (ev.itemKey) return [ev.stepId, ev.itemKey].filter(Boolean).join(' · ');
  return ev.stepId ?? '';
}

function workflowArtifactsText(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const artifacts = value as { counts?: unknown; files?: unknown; urls?: unknown };
  const parts = [
    ...(Array.isArray(artifacts.counts) ? artifacts.counts.map(String) : []),
    ...(Array.isArray(artifacts.files) ? artifacts.files.map(String) : []),
    ...(Array.isArray(artifacts.urls) ? artifacts.urls.map(String) : []),
  ];
  return parts.slice(0, 3).join(' · ');
}

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const seconds = Math.round((Date.now() - t) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

function shortTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
