import { renderMarkdown } from '../../../../../packages/chat-engine/src/markdown';
import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';
import { checkedPlanArtifactResponse, samePlanRevision, canExecuteReviewedPlan, type PlanRevisionRef, type PlanArtifactResponse } from '@/lib/task-mode';

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
    void apiGet<unknown>(`/api/console/plan-artifacts/${encodeURIComponent(selected.planId)}?${params}`)
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
  return <section aria-label={`Plan revision ${selected.revision}`} className="mt-3 space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
    <div className="flex items-center justify-between gap-2"><strong>Plan <span className="ml-2 text-caption font-normal text-muted">Revision {selected.revision}</span></strong>
      <span className="text-caption text-muted">{!loaded ? (loadError ? 'Plan unavailable' : 'Loading plan…') : view?.execution ? 'Execution requested' : view?.artifact.readiness === 'ready' ? 'Ready to review' : 'Needs information'}</span></div>
    {error && <p role="alert" className="text-small text-danger">{error} <button type="button" className="underline" onClick={() => { setExecutionError(''); setReload(value => value + 1); }}>Reload</button></p>}
    {view && loaded && <>
      <div className="break-words text-body [&_p]:mb-3 [&_h3]:my-3 [&_h3]:font-semibold [&_h4]:my-2 [&_h4]:font-semibold [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-auto [&_pre]:whitespace-pre-wrap [&_a]:text-primary" data-full-plan dangerouslySetInnerHTML={{ __html: renderMarkdown(view.artifact.fullText) }} />
      {view.artifact.missingPrerequisites.length > 0 && <ul className="list-disc pl-5 text-small">{view.artifact.missingPrerequisites.map((item, i) => <li key={i}>{item}</li>)}</ul>}
      {stale && <p className="text-small">A newer revision is available. <button type="button" className="underline" onClick={() => setSelected(view.latest)}>Review revision {view.latest.revision}</button></p>}
      {view.execution && <p className="text-small text-muted">Execution has been requested for this revision. Follow its progress in the conversation.</p>}
      <div className="flex flex-wrap gap-2">
        {onExecute && <button type="button" disabled={!canExecute || busy || acting} onClick={() => void execute()} className="rounded-md bg-primary px-4 py-2 text-small font-semibold text-primary-fg disabled:opacity-50">{acting ? 'Submitting…' : 'Execute plan'}</button>}
        {onRevise && <button type="button" disabled={busy || acting} onClick={onRevise} className="rounded-md border border-border px-3 py-2 text-small disabled:opacity-50">Revise in Plan mode</button>}
      </div>
    </>}
  </section>;
}
