import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  getWorkflowRunEvents,
  listWorkflowRuns,
  listWorkflows,
  runWorkflow,
  type MobileWorkflow,
  type WorkflowEventSummary,
  type WorkflowRunSummary,
} from '../lib/api';

export function Workflows() {
  const [workflows, setWorkflows] = useState<MobileWorkflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MobileWorkflow | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await listWorkflows();
      setWorkflows(result.workflows);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to load workflows');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  if (selected) {
    return <WorkflowDetail workflow={selected} onBack={() => { setSelected(null); refresh(); }} />;
  }

  if (loading && workflows.length === 0) return <div class="inbox-empty">Loading…</div>;
  if (error && workflows.length === 0) return <div class="inbox-empty">{error}</div>;
  if (workflows.length === 0) return <div class="inbox-empty">No workflows installed yet.</div>;

  return (
    <div>
      {workflows.map((wf) => (
        <button key={wf.name} class="workflow-row" onClick={() => setSelected(wf)}>
          <div class="workflow-row-head">
            <span class="workflow-row-name">{wf.name}</span>
            <span class={`workflow-row-status status-${(wf.lastRunStatus ?? 'unknown').toLowerCase()}`}>
              {wf.enabled ? (wf.lastRunStatus ?? 'idle') : 'disabled'}
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
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [selectedRun, setSelectedRun] = useState<WorkflowRunSummary | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await listWorkflowRuns(workflow.name, 20);
      setRuns(result.runs);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to load runs');
    } finally {
      setRunsLoading(false);
    }
  }, [workflow.name]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 8_000);
    return () => clearInterval(id);
  }, [refresh]);

  async function trigger() {
    if (triggering) return;
    setTriggering(true);
    setError(null);
    try {
      await runWorkflow(workflow.name);
      // Refresh to surface the new queued run.
      refresh();
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 409 && e.message?.includes('REQUIRES_INPUT')) {
        setError('This workflow needs input. Run it from the desktop app for now.');
      } else if (e.status === 409 && e.message?.includes('DISABLED')) {
        setError('This workflow is disabled. Enable it from the desktop app first.');
      } else {
        setError(e.message ?? 'Failed to trigger workflow');
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
        onBack={() => { setSelectedRun(null); refresh(); }}
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
        {error ? <div class="global-error">{error}</div> : null}
        <div class="memory-section-head">Recent runs</div>
        {runsLoading && runs.length === 0 ? <div class="inbox-empty">Loading…</div> : null}
        {!runsLoading && runs.length === 0 ? <div class="inbox-empty">No runs yet.</div> : null}
        {runs.map((run) => (
          <button key={run.id} class="run-card" onClick={() => setSelectedRun(run)}>
            <div class="title">{run.id}</div>
            <div class={`status ${run.status}`}>{run.status}</div>
          </button>
        ))}
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
  const [events, setEvents] = useState<WorkflowEventSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const result = await getWorkflowRunEvents(workflowName, run.id, 200);
        if (!cancelled) {
          setEvents(result.events);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message ?? 'Failed to load events');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    refresh();
    const id = setInterval(refresh, 5_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [workflowName, run.id]);

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
        {loading && events.length === 0 ? <div class="inbox-empty">Loading…</div> : null}
        {!loading && events.length === 0 ? <div class="inbox-empty">No events yet.</div> : null}
        {error ? <div class="global-error">{error}</div> : null}
        {events.map((ev, idx) => (
          <div key={idx} class={`workflow-event ${ev.error ? 'event-error' : ''}`}>
            <div class="workflow-event-head">
              <span class="workflow-event-kind">{ev.kind}</span>
              {ev.stepId ? <span class="workflow-event-step">{ev.stepId}</span> : null}
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
