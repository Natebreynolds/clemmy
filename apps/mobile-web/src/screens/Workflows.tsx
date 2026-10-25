import { useEffect, useRef, useState } from 'preact/hooks';
import { workflowCaption, workflowConversationSessionId, workflowDisplayName } from '@clem/chat-engine';
import { workflowRowStatus } from '../lib/workflow-status';
import { useBackGesture } from '../lib/back-gesture';
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
import { ChatBackButton } from '../components/ChatBackButton';
import { useMobileDetailHeader } from '../lib/mobile-navigation';
import { RunControl } from '../components/RunControl';
import { ScreenNotice } from '../components/ScreenNotice';
import { haptic } from '../lib/native-bridge';
import { runStateLabel, workflowRunStateLabel } from '../lib/run-rows';
import { useScreenData } from '../lib/use-screen-data';
import { buildWorkflowRunDetail } from '../lib/workflow-run-detail';
import { whenLabel } from '../lib/schedule-label';
import { usePendingCommit } from '../lib/pending-commit';
import { workflowRunFailure, workflowRunNotice } from '../lib/workflow-run-receipt';
import { Chat } from './Chat';
import { EmptyState } from '../components/EmptyState';
import { consumeWidgetWorkflowLaunch, removeWidgetWorkflow, reportWidgetLanding, saveWidgetWorkflow, widgetText, widgetWorkflowAvailable, WIDGET_ROUTE_EVENT } from '../lib/widget-bridge';
import { readWidgetWorkflow, settleWidgetWorkflowClaim, widgetWorkflowCanRun, workflowWidgetTarget, WORKFLOW_WIDGET_SLUG, type WorkflowWidgetTarget } from '../lib/workflow-widget';

/** Mirrors src/execution/workflow-run-cancellation.ts — anything else is live. */
const TERMINAL_RUN_STATUSES = new Set([
  'completed', 'completed_with_errors', 'error', 'failed', 'cancelled', 'dry_run', 'creation_test',
]);

/** A finished run whose goal review found a gap is done work with a note:
 *  its pill says so instead of reading as plain success. */

export function Workflows({ onAsk }: { onAsk: (draft: string) => void }) {
  const [selected, setSelected] = useState<MobileWorkflow | null>(null);
  const [widgetTarget, setWidgetTarget] = useState(() => workflowWidgetTarget(window.location.search));
  const abandonSelectedBack = useBackGesture(selected !== null, () => setSelected(null));
  useEffect(() => {
    let active = true;
    const sync = () => {
      if (!active) return;
      const next = workflowWidgetTarget(window.location.search);
      setWidgetTarget(current => current?.slug === next?.slug && current?.navigationId === next?.navigationId ? current : next);
      if (next) setSelected(null);
    };
    // The shell first commits the same-document URL in its own listener.
    const warm = (event: Event) => { queueMicrotask(() => {
      if (!active || !event.defaultPrevented) return;
      abandonSelectedBack();
      sync();
    }); };
    window.addEventListener('popstate', sync); window.addEventListener(WIDGET_ROUTE_EVENT, warm);
    return () => { active = false; window.removeEventListener('popstate', sync); window.removeEventListener(WIDGET_ROUTE_EVENT, warm); };
  }, []);
  const { data, loading, error, offline, stale, refresh } = useScreenData(
    listWorkflows,
    { intervalMs: 10_000, disabled: selected !== null || Boolean(widgetTarget?.slug), resourceKey: widgetTarget?.navigationId ?? 'workflow-list' },
  );
  const workflows = data?.workflows ?? [];
  useEffect(() => {
    if (widgetTarget && !widgetTarget.slug && data && !loading && !stale && !error && !offline) reportWidgetLanding(widgetTarget.navigationId, { tab: 'workflows' });
  }, [widgetTarget, data, loading, stale, error, offline]);
  const closeWidget = () => {
    setWidgetTarget(null);
    window.history.replaceState(window.history.state, '', `${window.location.pathname}?tab=workflows`);
    void refresh();
  };

  if (widgetTarget?.slug) {
    const workflow: MobileWorkflow = { name: widgetTarget.slug, description: '', enabled: false, stepCount: 0, schedule: null,
      requiresInput: false, lastRunId: null, lastRunStatus: null, lastRunOutcome: null, lastRunAt: null };
    return <WorkflowDetail key={`widget:${widgetTarget.slug}:${widgetTarget.navigationId ?? ''}`} workflow={workflow} widgetTarget={widgetTarget} onBack={closeWidget} />;
  }

  if (selected) {
    return <WorkflowDetail key={selected.name} workflow={selected} onBack={() => { setSelected(null); void refresh(); }} />;
  }

  if (loading && workflows.length === 0) {
    return <div class="skeleton-stack" aria-hidden="true"><i /><i /><i /></div>;
  }
  if ((error || offline) && workflows.length === 0) {
    return <ScreenNotice error={error} offline={offline} onRetry={() => void refresh()} />;
  }
  if (workflows.length === 0) {
    return (
      <EmptyState
        title="No automations yet"
        body="An automation is work Clem does for you on a schedule or with one tap."
        action={{ label: 'Ask Clem to set one up', onClick: () => onAsk('Set up an automation that ') }}
      />
    );
  }

  return (
    <div>
      <ScreenNotice error={error} offline={offline} onRetry={() => void refresh()} hasData />
      {workflows.map((wf) => (
        <button key={wf.name} class="workflow-row" onClick={() => setSelected(wf)}>
          <div class="workflow-row-head">
            <span class="workflow-row-name">{workflowDisplayName(wf.name, wf.description)}</span>
            <span class={`workflow-row-status status-${workflowRowStatus(wf).key}`}>
              {workflowRowStatus(wf).label}
            </span>
          </div>
          {/* The list reads as names; the workflow's id stays on its own page. */}
          {wf.description ? <div class="workflow-row-desc">{wf.description}</div> : null}
          <div class="workflow-row-meta">
            {wf.schedule ? <span>{whenLabel(wf.schedule)}</span> : null}
            {wf.requiresInput ? <span class="workflow-row-tag">Needs an answer</span> : null}
            {wf.resourceGaps && wf.resourceGaps.length > 0 ? <span class="workflow-row-tag">Needs a connection</span> : null}
            {wf.lastRunAt ? <span>Last ran {relativeTime(wf.lastRunAt)}</span> : null}
          </div>
        </button>
      ))}
    </div>
  );
}

interface WorkflowDetailProps {
  workflow: MobileWorkflow;
  onBack: () => void;
  widgetTarget?: WorkflowWidgetTarget;
}

function WorkflowDetail({ workflow, onBack, widgetTarget }: WorkflowDetailProps) {
  const [triggering, setTriggering] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const commit = usePendingCommit(workflow.name);
  const [selectedRun, setSelectedRun] = useState<WorkflowRunSummary | null>(null);
  const [conversation, setConversation] = useState<{ sessionId: string; draft?: string } | null>(null);
  const [definitionRead, setDefinitionRead] = useState(0);
  const [widgetNote, setWidgetNote] = useState('');
  const [widgetSaving, setWidgetSaving] = useState(false);
  const widgetSaveLock = useRef(false);
  const [widgetClaiming, setWidgetClaiming] = useState(Boolean(widgetTarget?.navigationId));
  const launchChecked = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  useMobileDetailHeader(selectedRun === null && conversation === null);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const { data, loading: runsLoading, error, offline, refresh } = useScreenData(
    () => listWorkflowRuns(workflow.name, 20),
    { intervalMs: 8_000, disabled: selectedRun !== null || conversation !== null },
  );
  const runs = data?.runs ?? [];
  // The FULL workflow — plain-English summary, certified steps, inputs
  // schema. Read on entry and after the conversation closes so a saved edit
  // is reflected by the daemon, rather than inferred from a chat reply.
  const { data: definition, refreshing: infoRefreshing, stale: infoStale, error: infoError, offline: infoOffline, updatedAt: infoReadAt, refresh: reloadInfo } = useScreenData(
    async () => {
      const read = widgetTarget?.slug ? await readWidgetWorkflow(widgetTarget.slug, getWorkflowDetail)
        : { kind: 'ready' as const, info: await getWorkflowDetail(workflow.name) };
      if (read.kind === 'not_found') return read;
      let widgetRow: MobileWorkflow | null = null;
      if (widgetTarget) {
        try {
          const matches = (await listWorkflows()).workflows.filter(row => row.name === read.info.name);
          if (matches.length === 1) widgetRow = matches[0];
        } catch { /* The definition can still be read; an unknown binding state cannot auto-run. */ }
      }
      return { ...read, widgetRow };
    },
    { disabled: conversation !== null, resourceKey: `workflow:${workflow.name}:${widgetTarget?.navigationId ?? ''}:${definitionRead}` },
  );
  const info = definition?.kind === 'ready' ? definition.info : null;
  const widgetRow = definition?.kind === 'ready' ? definition.widgetRow : null;
  const conversationSessionId = info?.slug && !infoStale ? workflowConversationSessionId(info.slug) : null;
  const description = info?.description ?? workflow.description;
  const enabled = info?.enabled ?? workflow.enabled;
  function closeConversation() {
    setConversation(null);
    // A pre-chat in-flight read must not satisfy the post-edit refresh.
    setDefinitionRead(read => read + 1);
  }
  useBackGesture(conversation !== null, closeConversation);
  function askClem(draft?: string) {
    if (conversationSessionId) setConversation({ sessionId: conversationSessionId, ...(draft ? { draft } : {}) });
  }
  const requiredMissing = (info?.inputs ?? [])
    .filter((input) => input.required && !(inputValues[input.key] ?? '').trim())
    .map((input) => input.key);
  const bindingGaps = widgetRow?.resourceGaps ?? workflow.resourceGaps ?? [];
  const latest = useRef({ definition, fresh: false, visible: true });
  latest.current = { definition, fresh: !infoStale && !infoRefreshing && !infoError && !infoOffline, visible: !conversation && !selectedRun };

  async function updateWidget(remove = false) {
    if (!info?.slug || !WORKFLOW_WIDGET_SLUG.test(info.slug) || infoStale || infoRefreshing || widgetSaveLock.current || !infoReadAt) return;
    widgetSaveLock.current = true; setWidgetSaving(true); setWidgetNote('');
    try {
      if (remove) await removeWidgetWorkflow(info.slug);
      else await saveWidgetWorkflow({ slug: info.slug, name: widgetText(workflowDisplayName(info.name, info.description), 160),
        summary: widgetText(info.description || 'Open this automation in Clem.', 600), updatedAt: new Date(infoReadAt).toISOString() });
      if (mounted.current) setWidgetNote(remove ? 'Workflow shortcut removed from this iPhone.' : 'Workflow shortcut saved on this iPhone. Add the Clem widget to your Home Screen to see it.');
    } catch (error) { if (mounted.current) setWidgetNote(error instanceof Error ? error.message : 'The widget update was not confirmed.'); }
    finally { widgetSaveLock.current = false; if (mounted.current) setWidgetSaving(false); }
  }

  async function trigger() {
    const token = commit.begin();
    if (!token) return;
    setTriggering(true);
    haptic('medium');
    setActionError(null);
    setRunNotice(null);
    try {
      const receipt = await runWorkflow(workflow.name, inputValues);
      if (!commit.owns(token)) return;
      setRunNotice(workflowRunNotice(receipt));
      // Refresh to surface the new queued run.
      void refresh();
    } catch (err) {
      if (!commit.owns(token)) return;
      const e = err as { status?: number; message?: string };
      if (e.status === 409 && e.message?.includes('REQUIRES_INPUT')) {
        setActionError('This workflow needs input — fill the fields above first.');
      } else if (e.status === 409 && e.message?.includes('DISABLED')) {
        setActionError('This workflow is disabled. Enable it from the desktop app first.');
      } else {
        setActionError(workflowRunFailure(err));
      }
    } finally {
      if (commit.finish(token)) setTriggering(false);
    }
  }

  useEffect(() => {
    const navigationId = widgetTarget?.navigationId;
    const slug = widgetTarget?.slug;
    if (!navigationId || !slug || !definition || infoStale || infoRefreshing || infoError || infoOffline || conversation || selectedRun) return;
    if (launchChecked.current === navigationId) {
      // A refresh can invalidate a successful claim. Present fresh evidence,
      // but never consume or execute the already-attempted action again.
      if (!widgetClaiming) reportWidgetLanding(navigationId, { tab: 'workflows', workflow: slug }, definition.kind === 'not_found' ? 'unavailable' : 'presented');
      return;
    }
    launchChecked.current = navigationId;
    const current = () => {
      const route = workflowWidgetTarget(window.location.search);
      return mounted.current && latest.current.visible && latest.current.fresh && latest.current.definition === definition
        && route?.navigationId === navigationId && route.slug === slug;
    };
    void settleWidgetWorkflowClaim(() => consumeWidgetWorkflowLaunch(navigationId, slug),
      () => { if (mounted.current) setWidgetClaiming(false); }, current, launch => {
      // A separately persisted native one-shot action, never the URL, permits this tap.
      if (definition.kind === 'not_found') {
        reportWidgetLanding(navigationId, { tab: 'workflows', workflow: slug }, 'unavailable');
        return;
      }
      if (launch && widgetWorkflowCanRun(definition.info, definition.widgetRow)) {
        setWidgetNote('Starting the workflow you tapped. Its usual checks and approvals still apply.');
        void trigger();
      } else if (launch) setWidgetNote('This workflow needs a look before it can run. Review its inputs, status and connections, then use Run now.');
      else setWidgetNote('No automatic run was confirmed. Review this workflow before using Run now.');
      reportWidgetLanding(navigationId, { tab: 'workflows', workflow: slug });
    });
  }, [widgetTarget, definition, infoStale, infoRefreshing, infoError, infoOffline, widgetClaiming, conversation, selectedRun]);

  if (conversation) {
    return <Chat
      key={conversation.sessionId}
      sessionId={conversation.sessionId}
      initialTitle={workflowDisplayName(workflow.name, description)}
      initialDraft={conversation.draft}
      onBack={closeConversation}
    />;
  }

  if (selectedRun) {
    return (
      <WorkflowRunEvents
        workflowName={workflow.name}
        run={selectedRun}
        onAsk={conversationSessionId ? () => askClem(`What happened in run ${selectedRun.id} of this workflow?`) : undefined}
        onBack={() => { setSelectedRun(null); void refresh(); }}
      />
    );
  }

  if (definition?.kind === 'not_found') return <div class="workflow-detail">
    <div class="chat-header"><ChatBackButton onClick={onBack} /><h2 class="chat-title">Workflow unavailable</h2></div>
    <p class="muted">This saved workflow is no longer available. Choose another automation from the list.</p>
  </div>;

  return (
    <div class="workflow-detail">
      <div class="chat-header">
        <ChatBackButton onClick={onBack} />
        <h2 class="chat-title">{workflowDisplayName(workflow.name, description)}</h2>
      </div>
      <div class="workflow-detail-body">
        {workflowCaption(workflow.name, description) ? <div class="workflow-row-slug">{workflow.name}</div> : null}
        {description ? <p class="workflow-desc">{description}</p> : null}
        <ScreenNotice error={infoError} offline={infoOffline} onRetry={() => void reloadInfo()} hasData={Boolean(info)} />
        {infoRefreshing ? <p class="muted" role="status">Loading the latest saved workflow…</p> : null}

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
                      <button type="button" class="btn-quiet" disabled={!conversationSessionId}
                        onClick={() => askClem(`Help me understand or change step ${step.stepId} (${step.label || step.stepId}) in this workflow.`)}>Ask Clem</button>
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

        {bindingGaps.length > 0 ? (
          <div class="global-error" role="status">
            Won't run until you bind: {bindingGaps[0]}{bindingGaps.length > 1 ? ` (+${bindingGaps.length - 1} more)` : ''}
          </div>
        ) : null}
        <div class="workflow-actions">
          <button
            class="btn"
            disabled={triggering || widgetClaiming || !info || infoStale || infoRefreshing || !enabled || requiredMissing.length > 0 || bindingGaps.length > 0}
            onClick={trigger}
          >
            {triggering ? 'Queuing…'
              : infoError || infoOffline ? 'Workflow unavailable'
              : !info || infoRefreshing ? 'Loading workflow…'
              : infoStale ? 'Workflow unavailable'
              : !enabled ? 'Disabled'
                : bindingGaps.length > 0 ? 'Needs a binding (set it on your computer)'
                : requiredMissing.length > 0 ? `Needs: ${requiredMissing.join(', ')}`
                  : 'Run now'}
          </button>
          <button type="button" class="btn-quiet" disabled={!conversationSessionId} onClick={() => askClem()}>Ask Clem</button>
        </div>
        {widgetWorkflowAvailable() ? <div class="workflow-actions">
          <button type="button" class="btn-quiet" disabled={widgetSaving || !info?.slug || infoStale || infoRefreshing} onClick={() => void updateWidget()}>Pin to widget</button>
          <button type="button" class="btn-quiet" disabled={widgetSaving || !info?.slug || infoStale || infoRefreshing} onClick={() => void updateWidget(true)}>Remove from widget</button>
        </div> : null}
        {widgetNote ? <p class="muted" role="status">{widgetNote}</p> : null}
        <p class="muted">Ask about this workflow or describe a change to its saved steps. Runs already in progress keep their own controls.</p>
        {actionError ? <div class="global-error">{actionError}</div> : null}
        {runNotice ? <p class="muted" role="status">{runNotice}</p> : null}
        <ScreenNotice error={error} offline={offline} onRetry={() => void refresh()} hasData={runs.length > 0} />
        <div class="memory-section-head">Recent runs</div>
        {runsLoading && runs.length === 0 ? <div class="skeleton-stack" aria-hidden="true"><i /></div> : null}
        {!runsLoading && runs.length === 0 ? <p class="muted">Hasn’t run yet.</p> : null}
        <div class="stack">
          {runs.map((run, i) => {
            const live = !TERMINAL_RUN_STATUSES.has(run.status);
            return (
              <article key={run.id} class={`card rise ${live ? 'card-live' : ''}`} style={{ '--i': i }}>
                {/* No liveness certificate on run summaries: an active run
                    reads active, but nothing breathes without the server's
                    liveness — a stalled run must not look alive. */}
                {live ? <span class="running-task-state" style={{ background: 'var(--accent)' }} aria-hidden="true" /> : null}
                <button class="run-open min-w-0" onClick={() => setSelectedRun(run)}>
                  <div class="card-title-sm truncate">{run.id}</div>
                  <div class="card-when">
                    {live ? null : <span class={`status-dot status-${run.terminalOutcome ?? run.status}`} aria-hidden="true" />}
                    {workflowRunStateLabel(run)}
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
  onAsk?: () => void;
}

function WorkflowRunEvents({ workflowName, run, onBack, onAsk }: WorkflowRunEventsProps) {
  useMobileDetailHeader();
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
        <ChatBackButton onClick={onBack} />
        {/* A run is named by when it ran, never by its id. */}
        <h2 class="chat-title">{runTitle(run)}</h2>
      </div>
      <div class="workflow-detail-body">
        <div class="memory-section-head">
          <span>{runStateLabel({ status: data?.status ?? run.status })}</span>
          {run.error ? <span class="memory-section-count" style="color:var(--accent-fail)">error</span> : null}
          {typeof detail.tokensTotal === 'number' && detail.tokensTotal > 0
            ? <span class="memory-section-count">{Math.round(detail.tokensTotal / 1000)}k tokens</span>
            : null}
        </div>
        {detail.summary?.because ? <p class="wf-because">{detail.summary.because}</p> : null}
        {onAsk ? <button type="button" class="btn-quiet" onClick={onAsk}>Ask Clem about this run</button> : null}

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
                {typeof verdict.durationMs === 'number' ? ` · ${Math.max(1, Math.round(verdict.durationMs / 1000))} s` : null}
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

function runTitle(run: WorkflowRunSummary): string {
  const at = run.startedAt ?? run.createdAt;
  const when = at ? new Date(at) : null;
  if (!when || Number.isNaN(when.getTime())) return 'Run';
  return `Run · ${when.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
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
