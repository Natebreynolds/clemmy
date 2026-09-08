import { useEffect, useState } from 'preact/hooks';
import { api } from '../lib/api';
import { checkedPlanArtifactResponse, samePlanRevision, canExecuteReviewedPlan, renderMarkdown, type PlanRevisionRef, type PlanArtifactResponse } from '@clem/chat-engine';

export function PlanReview({ planRef, sessionId, busy, onExecute, onRevise }: {
  planRef: PlanRevisionRef; sessionId?: string; busy?: boolean;
  onExecute?: (ref: PlanRevisionRef) => Promise<void> | void;
  onRevise?: () => void;
}) {
  const [selected, setSelected] = useState(planRef);
  const [view, setView] = useState<PlanArtifactResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [executionError, setExecutionError] = useState('');
  const error = executionError || loadError;
  const [acting, setActing] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => { setSelected(planRef); }, [planRef.planId, planRef.revision, planRef.digest]);
  useEffect(() => { setExecutionError(''); }, [selected.planId, selected.revision, selected.digest]);
  useEffect(() => {
    let current = true;
    setView(null); setLoadError('');
    if (!sessionId) { setLoadError('Reopen this conversation to load the complete plan.'); return; }
    const params = new URLSearchParams({ sessionId, revision: String(selected.revision), digest: selected.digest });
    void api<unknown>(`/m/api/plan-artifacts/${encodeURIComponent(selected.planId)}?${params}`)
      .then(value => { if (current) setView(checkedPlanArtifactResponse(value, selected)); })
      .catch(error => { if (current) setLoadError(error instanceof Error ? error.message : 'Could not load the complete plan.'); });
    return () => { current = false; };
  }, [sessionId, selected.planId, selected.revision, selected.digest, reload]);
  const stale = Boolean(view && !samePlanRevision(view.latest, selected));
  const loaded = Boolean(view && samePlanRevision(view.artifact, selected));
  const canExecute = Boolean(canExecuteReviewedPlan(view, selected) && onExecute);
  const execute = async () => {
    if (!canExecute || busy || acting) return;
    setActing(true); setExecutionError('');
    try { await onExecute?.({ ...selected }); }
    catch (error) { setExecutionError(error instanceof Error ? error.message : 'Execution was not accepted.'); }
    finally { setActing(false); setReload(value => value + 1); }
  };
  return <section aria-label={`Plan revision ${selected.revision}`} class="plan-review">
    <div class="flex items-center justify-between gap-2"><strong>Plan <span class="plan-revision">Revision {selected.revision}</span></strong>
      <span class="text-caption text-muted">{!loaded ? (loadError ? 'Plan unavailable' : 'Loading plan…') : view?.execution ? 'Execution requested' : view?.artifact.readiness === 'ready' ? 'Ready to review' : 'Needs information'}</span></div>
    {error && <p role="alert" class="text-small text-danger">{error} <button type="button" class="underline" onClick={() => { setExecutionError(''); setReload(value => value + 1); }}>Reload</button></p>}
    {view && loaded && <>
      <div class="plan-full-text bubble-md" data-full-plan dangerouslySetInnerHTML={{ __html: renderMarkdown(view.artifact.fullText) }} />
      {view.artifact.missingPrerequisites.length > 0 && <ul class="list-disc pl-5 text-small">{view.artifact.missingPrerequisites.map((item, i) => <li key={i}>{item}</li>)}</ul>}
      {stale && <p class="text-small">A newer revision is available. <button type="button" class="underline" onClick={() => setSelected(view.latest)}>Review revision {view.latest.revision}</button></p>}
      {view.execution && <p class="text-small text-muted">Execution has been requested for this revision. Follow its progress in the conversation.</p>}
      <div class="flex flex-wrap gap-2">
        {onExecute && <button type="button" disabled={!canExecute || busy || acting} onClick={() => void execute()} class="rounded-md bg-primary px-4 py-2 text-small font-semibold text-white disabled:opacity-50">{acting ? 'Submitting…' : 'Execute plan'}</button>}
        {onRevise && <button type="button" disabled={busy || acting} onClick={onRevise} class="rounded-md border border-border px-3 py-2 text-small disabled:opacity-50">Revise in Plan mode</button>}
      </div>
    </>}
  </section>;
}
