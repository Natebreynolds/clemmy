import { useState } from 'preact/hooks';
import { renderMarkdown } from '@clem/chat-engine';
import {
  getWorkflowDetail,
  getWorkflowRunEventsFull,
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
import { buildWorkflowRunDetail } from '../lib/workflow-run-detail';

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
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const { data, loading: runsLoading, error, offline, refresh } = useScreenData(
    () => listWorkflowRuns(workflow.name, 20),
    { intervalMs: 8_000, disabled: selectedRun !== null },
  );
  const runs = data?.runs ?? [];
  // The FULL workflow — plain-English summary, certified steps, inputs
  // schema. Loaded once (no interval): definitions don't change mid-view and
  // certification is real work on the daemon.
  const { data: info, error: infoError, offline: infoOffline, refresh: reloadInfo } = useScreenData(
    () => getWorkflowDetail(workflow.name),
    { disabled: selectedRun !== null },
  );
  const requiredMissing = (info?.inputs ?? [])
    .filter((input) => input.required && !(inputValues[input.key] ?? '').trim())
    .map((input) => input.key);

  async function trigger() {
    if (triggering) return;
    setTriggering(true);
    haptic('medium');
    setActionError(null);
    try {
      await runWorkflow(workflow.name, inputValues);
      // Refresh to surface the new queued run.
      void refresh();
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 409 && e.message?.includes('REQUIRES_INPUT')) {
        setActionError('This workflow needs input — fill the fields above first.');
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
        <ScreenNotice error={infoError} offline={infoOffline} onRetry={() => void reloadInfo()} hasData={Boolean(info)} />

        {/* The strategic read, before any mechanics: what it touches, whether
            it can be trusted, and what "good" means for it. Deciding to run
            something is answered by these three, never by a step list. */}
        {info ? (
          <section class="wf-strategy">
            <div class="wf-facts">
              <div class="wf-fact">
                <div class="wf-fact-value">{whenLabel(info.schedule)}</div>
                <div class="wf-fact-label">Runs</div>
              </div>
              {info.trackRecord ? (
                <div class="wf-fact">
                  <div class={`wf-fact-value ${info.trackRecord.succeeded === info.trackRecord.of ? 'wf-good' : info.trackRecord.succeeded === 0 ? 'wf-bad' : ''}`}>
                    {info.trackRecord.succeeded}/{info.trackRecord.of}
                  </div>
                  <div class="wf-fact-label">Recent success</div>
                </div>
              ) : null}
              <div class="wf-fact">
                <div class={`wf-fact-value ${(info.effects?.writes ?? 0) + (info.effects?.sends ?? 0) > 0 ? 'wf-warn' : ''}`}>
                  {touchLabel(info.effects)}
                </div>
                <div class="wf-fact-label">Touches</div>
              </div>
            </div>

            {info.effects?.approvals?.length ? (
              <div class="wf-approvals">
                Pauses for your approval on {info.effects.approvals.length} {info.effects.approvals.length === 1 ? 'step' : 'steps'}
              </div>
            ) : null}

            {info.summary ? (
              <div class="bubble-md wf-summary" dangerouslySetInnerHTML={{ __html: renderMarkdown(info.summary) }} />
            ) : null}

            {info.qualityCriteria?.length ? (
              <div class="wf-criteria">
                <div class="memory-section-head">What counts as a good run</div>
                {info.qualityCriteria.slice(0, 5).map((line) => (
                  <div key={line} class="ws-contract-line">{line}</div>
                ))}
              </div>
            ) : null}

            {info.steps.length ? (
              <details class="wf-steps">
                <summary class="wf-steps-summary">
                  {stepSpine(info.steps)} · {info.steps.length} {info.steps.length === 1 ? 'step' : 'steps'}
                </summary>
                <ol class="wf-step-list">
                  {info.steps.map((step) => (
                    <li key={step.stepId} class="wf-step">
                      <span class="wf-step-label">{step.label || step.stepId}</span>
                      <span class="wf-step-chips">
                        {step.executor ? <span class="wf-chip">{step.executor}</span> : null}
                        {step.effect === 'external' ? <span class="wf-chip wf-chip-effect">writes outside</span> : null}
                        {step.gated ? <span class="wf-chip wf-chip-gated">needs approval</span> : null}
                      </span>
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
          </section>
        ) : null}

        {info?.inputs?.length ? (
          <div class="wf-inputs">
            <div class="memory-section-head">Inputs</div>
            {info.inputs.map((input) => (
              <label key={input.key} class="wf-input-row">
                <span class="wf-input-label">
                  {input.key}{input.required ? '' : ' (optional)'}
                  {input.description ? <span class="wf-input-desc"> — {input.description}</span> : null}
                </span>
                <input
                  class="memory-add-input"
                  value={inputValues[input.key] ?? ''}
                  placeholder={input.example ?? ''}
                  onInput={(ev) => {
                    const value = (ev.currentTarget as HTMLInputElement).value;
                    setInputValues((prev) => ({ ...prev, [input.key]: value }));
                  }}
                />
              </label>
            ))}
          </div>
        ) : null}

        <div class="workflow-actions">
          <button
            class="btn"
            disabled={triggering || !workflow.enabled || requiredMissing.length > 0}
            onClick={trigger}
          >
            {triggering ? 'Queuing…'
              : !workflow.enabled ? 'Disabled'
                : requiredMissing.length > 0 ? `Needs: ${requiredMissing.join(', ')}`
                  : 'Run now'}
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
    () => getWorkflowRunEventsFull(workflowName, run.id, 500),
    { intervalMs: 5_000 },
  );
  const events = data?.events ?? [];
  // The same pure reducer the desktop drawer uses — per-step status,
  // duration, output, retries, item counts, tokens/cost, run verdicts.
  const detail = buildWorkflowRunDetail(events as unknown as Parameters<typeof buildWorkflowRunDetail>[0]);

  return (
    <div class="workflow-detail">
      <div class="chat-header">
        <button class="chat-back" onClick={onBack} aria-label="Back">←</button>
        <div class="chat-title">{run.id}</div>
      </div>
      <div class="workflow-detail-body">
        <div class="memory-section-head">
          <span>{data?.status ?? run.status}</span>
          {run.error ? <span class="memory-section-count" style="color:var(--accent-fail)">error</span> : null}
          {typeof detail.tokensTotal === 'number' && detail.tokensTotal > 0
            ? <span class="memory-section-count">{Math.round(detail.tokensTotal / 1000)}k tokens</span>
            : null}
        </div>
        {detail.summary?.because ? <p class="wf-because">{detail.summary.because}</p> : null}

        {loading && events.length === 0 ? <div class="skeleton-stack" aria-hidden="true"><i /></div> : null}
        {!loading && !error && !offline && events.length === 0 ? <p class="muted">No steps recorded yet.</p> : null}
        <ScreenNotice error={error} offline={offline} onRetry={() => void refresh()} hasData={events.length > 0} />

        {detail.steps.map((step) => (
          <details key={step.stepId} class={`wf-run-step wf-run-${step.status}`}>
            <summary class="wf-run-step-head">
              <span class={`wf-run-mark wf-run-mark-${step.status}`} aria-hidden="true" />
              <span class="wf-run-step-id">{step.stepId}</span>
              <span class="wf-run-step-meta">
                {step.status.replace(/_/g, ' ')}
                {typeof step.durationMs === 'number' ? ` · ${formatDuration(step.durationMs)}` : ''}
                {step.items.started > 0 ? ` · ${step.items.completed}/${step.items.started} items${step.items.failed ? ` (${step.items.failed} failed)` : ''}` : ''}
                {step.retries > 0 ? ` · ${step.retries} ${step.retries === 1 ? 'retry' : 'retries'}` : ''}
              </span>
            </summary>
            {step.error ? <div class="workflow-event-error">{step.error}</div> : null}
            {step.skippedReason ? <div class="muted">{step.skippedReason}</div> : null}
            {step.output ? <pre class="workflow-event-output">{step.output.slice(0, 4000)}</pre> : null}
          </details>
        ))}

        {detail.verdicts.length > 0 ? (
          <div class="wf-verdicts">
            {detail.verdicts.map((verdict, i) => (
              <div key={i} class={`wf-verdict ${verdict.pass ? 'wf-verdict-pass' : 'wf-verdict-fail'}`}>
                Verdict · {verdict.door.replace(/_/g, ' ')}: {verdict.pass ? 'passed' : 'not passed'}
                {verdict.reason ? <span class="wf-verdict-reason"> — {verdict.reason}</span> : null}
              </div>
            ))}
          </div>
        ) : null}

        {events.length > 0 ? (
          <details class="wf-raw-log">
            <summary class="memory-section-head">Full log · {events.length} events</summary>
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
          </details>
        ) : null}
      </div>
    </div>
  );
}

/** When it runs, in words. A cron string is not an answer to "when". */
function whenLabel(schedule: string | null): string {
  if (!schedule) return 'When asked';
  const parts = schedule.trim().split(/\s+/);
  if (parts.length < 5) return schedule;
  const [minute, hour, dom, , dow] = parts;
  const at = (): string => {
    const h = Number(hour);
    const m = Number(minute);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return schedule;
    const suffix = h < 12 ? 'am' : 'pm';
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    return m === 0 ? `${hour12}${suffix}` : `${hour12}:${String(m).padStart(2, '0')}${suffix}`;
  };
  if (hour.includes('*')) return 'Hourly';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (dow !== '*' && !dow.includes('*')) {
    const day = days[Number(dow)] ?? dow;
    return `${day} ${at()}`;
  }
  if (dom !== '*' && !dom.includes('*')) return `Monthly ${at()}`;
  return `Daily ${at()}`;
}

/** What it touches, as consequence rather than counts. */
function touchLabel(effects?: { reads: number; writes: number; sends: number }): string {
  if (!effects) return '—';
  const out: string[] = [];
  if (effects.sends > 0) out.push(`${effects.sends} send${effects.sends === 1 ? '' : 's'}`);
  if (effects.writes > 0) out.push(`${effects.writes} write${effects.writes === 1 ? '' : 's'}`);
  if (out.length === 0) return effects.reads > 0 ? 'Reads only' : 'Nothing outside';
  return out.join(' · ');
}

/** The shape of the work in one line: "3 reads → 1 write". */
function stepSpine(steps: Array<{ effect: string | null; gated: boolean }>): string {
  const external = steps.filter((s) => s.effect === 'external').length;
  const internal = steps.length - external;
  const gated = steps.filter((s) => s.gated).length;
  const spine = external > 0
    ? `${internal} internal → ${external} external`
    : `${internal} internal`;
  return gated > 0 ? `${spine} · ${gated} gated` : spine;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
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
