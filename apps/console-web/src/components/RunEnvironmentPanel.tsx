import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity, Bot, Box, Check, ChevronDown, ChevronRight, Circle, ExternalLink,
  FileText, GitBranch, Hammer, Loader2, Monitor, Network, OctagonX,
  RefreshCw, Sparkles, TerminalSquare, X,
  SendToBack,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '@/lib/api';
import type { RunRow } from '@/lib/inbox';
import { usePoll } from '@/lib/poll';
import { cn } from '@/lib/cn';
import { Button } from './ui/Button';
import { StatusPill } from './ui/StatusPill';
import {
  buildRunEnvironmentHelpers,
  buildRunEnvironmentPlan,
  buildRunEnvironmentTools,
  artifactBindingPresentation,
  chooseRunEnvironmentRun,
  collectRunEnvironmentReferences,
  elapsedLabel,
  isRunEnvironmentCancellable,
  isRunEnvironmentBackgroundable,
  isRunLive,
  runEnvironmentMetadata,
  runEnvironmentScopePresentation,
  runEnvironmentTasksHref,
  runEnvironmentTone,
  shouldReconcileRunEnvironmentDetail,
  type RunEnvironmentArtifact,
  type RunEnvironmentDetail,
} from '@/lib/run-environment';

function detailFor(id: string): Promise<{ run: RunEnvironmentDetail }> {
  return apiGet(`/api/runs/${encodeURIComponent(id)}?view=environment`);
}

function Section({
  title,
  meta,
  children,
  collapsible = false,
  defaultOpen = false,
}: {
  title: string;
  meta?: string;
  children: React.ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const heading = (
    <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
      <h3 className="text-small font-semibold text-fg">{title}</h3>
      {meta && <span className="truncate text-caption text-faint" title={meta}>{meta}</span>}
    </div>
  );
  if (collapsible) {
    return (
      <details className="group border-t border-border py-1 first:border-t-0" open={defaultOpen || undefined}>
        <summary className="flex cursor-pointer list-none items-center gap-2 py-3.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 [&::-webkit-details-marker]:hidden">
          {heading}
          <ChevronDown className="h-4 w-4 shrink-0 text-faint transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <div className="pb-4">{children}</div>
      </details>
    );
  }
  return (
    <section className="border-t border-border py-4 first:border-t-0">
      <div className="mb-2.5">{heading}</div>
      {children}
    </section>
  );
}

function Row({
  icon: Icon,
  label,
  meta,
  state,
  title,
}: {
  icon: typeof Activity;
  label: React.ReactNode;
  meta?: string;
  state?: 'running' | 'done' | 'failed' | 'warning';
  title?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 py-1.5" title={title}>
      <Icon className={cn(
        'h-4 w-4 shrink-0 text-faint',
        state === 'running' && 'text-primary',
        state === 'done' && 'text-success',
        state === 'failed' && 'text-danger',
        state === 'warning' && 'text-warning',
      )} aria-hidden />
      <div className="min-w-0 flex-1 truncate text-small text-fg">{label}</div>
      {meta && <div className="max-w-[42%] shrink-0 truncate text-caption text-faint">{meta}</div>}
    </div>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return <p className="text-small leading-relaxed text-faint">{children}</p>;
}

function safeArtifactUrl(artifact: RunEnvironmentArtifact): string {
  if (!artifact.uri) return '';
  try {
    const url = new URL(artifact.uri);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch { return ''; }
}

function artifactLabel(artifact: RunEnvironmentArtifact): string {
  return artifact.title || artifact.slotKey || artifact.resourceId || artifact.kind || 'Artifact';
}

function sourceLabel(run: RunEnvironmentDetail): string {
  const values = [run.kindLabel || run.source || run.kind || 'Run'];
  if (run.channel && run.channel !== run.source) values.push(run.channel);
  return values.filter(Boolean).join(' · ');
}

export function RunEnvironmentPanel({
  open,
  runs,
  runsLoading,
  runsError,
  onRetryRuns,
  onClose,
}: {
  open: boolean;
  runs: RunRow[];
  runsLoading: boolean;
  runsError: boolean;
  onRetryRuns: () => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const bestCandidate = useMemo(() => chooseRunEnvironmentRun(runs), [runs]);
  const [pinnedRunId, setPinnedRunId] = useState<string | null>(null);
  const selectedRunId = pinnedRunId ?? bestCandidate?.id ?? null;
  const selectedRow = selectedRunId ? runs.find((run) => run.id === selectedRunId) : null;
  const detail = usePoll(
    ['run-environment-detail', selectedRunId ?? 'none'],
    () => detailFor(selectedRunId!),
    selectedRow && isRunLive(selectedRow) ? 3000 : 0,
    { enabled: open && Boolean(selectedRunId) },
  );
  const [stopping, setStopping] = useState(false);
  const [moving, setMoving] = useState(false);
  const [stopError, setStopError] = useState('');
  const [mobileDialog, setMobileDialog] = useState(() => (
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 1279px)').matches : false
  ));
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Select once per drawer opening. Polling can reorder the activity list as
  // other runs start or finish, but the context Nathan is inspecting must not
  // jump out from under him.
  useEffect(() => {
    if (!open) {
      setPinnedRunId(null);
      return;
    }
    if (!pinnedRunId && bestCandidate?.id) setPinnedRunId(bestCandidate.id);
  }, [bestCandidate?.id, open, pinnedRunId]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 1279px)');
    const sync = () => setMobileDialog(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (!open || !mobileDialog) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      const target = returnFocusRef.current;
      if (target?.isConnected) target.focus();
      returnFocusRef.current = null;
    };
  }, [mobileDialog, open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !mobileDialog) return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mobileDialog, onClose, open]);

  useEffect(() => { setStopError(''); setStopping(false); setMoving(false); }, [selectedRunId]);

  const detailedRun = detail.data?.run;
  useEffect(() => {
    if (!open || !shouldReconcileRunEnvironmentDetail(selectedRow, detailedRun)) return;
    void detail.refetch();
  }, [
    detailedRun?.runState,
    detailedRun?.status,
    detailedRun?.updatedAt,
    detail.refetch,
    open,
    selectedRow?.runState,
    selectedRow?.status,
    selectedRow?.updatedAt,
  ]);

  if (!open) return null;

  const run = detailedRun;
  const plan = run ? buildRunEnvironmentPlan(run) : null;
  const helpers = run ? buildRunEnvironmentHelpers(run) : [];
  const tools = run ? buildRunEnvironmentTools(run) : null;
  const scope = run ? runEnvironmentScopePresentation(run) : null;
  const references = run ? collectRunEnvironmentReferences(run) : { urls: [], files: [] };
  const environment = run ? runEnvironmentMetadata(run) : { workspace: null, branch: null, model: null };
  const artifacts = (run?.artifacts ?? []).filter(Boolean);
  const visibleArtifacts = artifacts.slice(-8);
  const returnedArtifactsOmitted = Math.max(0, artifacts.length - visibleArtifacts.length);
  const boundUrls = new Set(artifacts.map(safeArtifactUrl).filter(Boolean));
  const observedUrls = references.urls.filter((url) => !boundUrls.has(url));
  const helpersDone = helpers.filter((helper) => helper.state === 'done').length;
  const helpersFailed = helpers.filter((helper) => helper.state === 'failed').length;
  const visibleToolNames = tools?.names.slice(0, 12) ?? [];
  const toolNamesOmitted = Math.max(0, (tools?.names.length ?? 0) - visibleToolNames.length);

  const stop = async () => {
    if (!run || !isRunEnvironmentCancellable(run)) return;
    setStopping(true);
    setStopError('');
    const endpoint = typeof run.cancelEndpoint === 'string' && run.cancelEndpoint.startsWith('/api/')
      ? run.cancelEndpoint
      : '';
    if (!endpoint) return;
    try {
      await apiPost(endpoint);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['run-environment-runs'] }),
        qc.invalidateQueries({ queryKey: ['run-environment-detail', run.id] }),
        qc.invalidateQueries({ queryKey: ['board'] }),
      ]);
    } catch (error) {
      setStopError(error instanceof Error ? error.message : String(error));
    } finally {
      setStopping(false);
    }
  };

  const moveToBackground = async () => {
    if (!run || !isRunEnvironmentBackgroundable(run)) return;
    const endpoint = run.backgroundEndpoint!;
    setMoving(true);
    setStopError('');
    try {
      await apiPost(endpoint);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['run-environment-runs'] }),
        qc.invalidateQueries({ queryKey: ['run-environment-detail', run.id] }),
        qc.invalidateQueries({ queryKey: ['board'] }),
      ]);
    } catch (error) {
      setStopError(error instanceof Error ? error.message : String(error));
    } finally {
      setMoving(false);
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close run environment"
        onClick={onClose}
        tabIndex={-1}
        className="fixed inset-0 z-40 bg-black/20 xl:hidden"
      />
      <aside
        id="run-environment-panel"
        ref={panelRef}
        tabIndex={-1}
        role={mobileDialog ? 'dialog' : 'complementary'}
        aria-modal={mobileDialog ? true : undefined}
        aria-labelledby="run-environment-title"
        className={cn(
          'fixed inset-x-3 inset-y-3 z-50 flex min-w-0 max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xl',
          'animate-fade-in xl:relative xl:inset-auto xl:z-auto xl:w-[370px] xl:max-w-none xl:shrink-0 xl:rounded-none xl:border-y-0 xl:border-r-0 xl:shadow-none',
        )}
      >
        <div className="app-drag flex min-h-14 min-w-0 shrink-0 items-center gap-3 border-b border-border px-4 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-caption font-semibold uppercase tracking-[0.14em] text-faint">
              {run && isRunLive(run) ? 'Active context' : 'Latest run'}
            </div>
            <h2 id="run-environment-title" className="truncate text-body font-semibold text-fg">Run environment</h2>
          </div>
          {run && (
            <div className="hidden min-[360px]:block">
              <StatusPill tone={runEnvironmentTone(run)}>{run.statusLabel || run.runStateLabel || run.runState || run.status || 'Unknown'}</StatusPill>
            </div>
          )}
          <Button ref={closeButtonRef} variant="ghost" size="icon" onClick={onClose} aria-label="Close run environment" title="Close run environment">
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>

        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pb-5">
          {!selectedRunId && runsLoading && (
            <div className="flex min-h-64 items-center justify-center gap-2 text-small text-muted">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading recent activity…
            </div>
          )}

          {!selectedRunId && !runsLoading && runsError && (
            <div className="flex min-h-64 flex-col items-center justify-center gap-3 px-5 text-center">
              <OctagonX className="h-7 w-7 text-danger" aria-hidden />
              <p className="text-small text-muted">Recent activity is unavailable.</p>
              <Button variant="secondary" size="sm" onClick={onRetryRuns}>
                <RefreshCw className="h-4 w-4" aria-hidden /> Retry
              </Button>
            </div>
          )}

          {!selectedRunId && !runsLoading && !runsError && (
            <div className="flex min-h-64 flex-col items-center justify-center gap-3 px-5 text-center">
              <Circle className="h-8 w-8 text-faint" aria-hidden />
              <div>
                <p className="text-body font-medium text-fg">Nothing has run yet</p>
                <p className="mt-1 text-small text-faint">The latest plan, helpers, tools, and outputs will appear here.</p>
              </div>
            </div>
          )}

          {selectedRunId && detail.isLoading && !run && (
            <div className="flex min-h-64 items-center justify-center gap-2 text-small text-muted">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading run context…
            </div>
          )}

          {selectedRunId && detail.isError && !run && (
            <div className="flex min-h-64 flex-col items-center justify-center gap-3 px-5 text-center">
              <OctagonX className="h-7 w-7 text-danger" aria-hidden />
              <p className="text-small text-muted">Run details are unavailable.</p>
              <Button variant="secondary" size="sm" onClick={() => void detail.refetch()}>
                <RefreshCw className="h-4 w-4" aria-hidden /> Retry
              </Button>
            </div>
          )}

          {run && (
            <>
              <div className="py-4">
                {runs.length > 1 && (
                  <label className="mb-3 block">
                    <span className="mb-1 block text-caption font-medium text-faint">Viewing</span>
                    <select
                      value={selectedRunId ?? ''}
                      onChange={(event) => setPinnedRunId(event.target.value || null)}
                      className="app-no-drag w-full min-w-0 max-w-full rounded-md border border-border bg-canvas px-2.5 py-2 text-small text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                      aria-label="Run shown in the environment rail"
                    >
                      {runs.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {(candidate.statusLabel || candidate.runStateLabel || (isRunLive(candidate) ? 'Working' : ''))
                            ? `${candidate.statusLabel || candidate.runStateLabel || 'Working'} · `
                            : ''}{candidate.title || candidate.id}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="mb-2 flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 min-[360px]:hidden">
                      <StatusPill tone={runEnvironmentTone(run)}>{run.statusLabel || run.runStateLabel || run.runState || run.status || 'Unknown'}</StatusPill>
                    </div>
                    <h3 className="line-clamp-2 text-body font-semibold leading-snug text-fg">{run.title || run.input || 'Untitled run'}</h3>
                    {run.liveLine && isRunLive(run) && <p className="mt-1 line-clamp-2 text-small text-muted">{run.liveLine}</p>}
                  </div>
                </div>
              </div>

              <Section title="Environment" meta={elapsedLabel(run)}>
                <Row icon={Activity} label={sourceLabel(run)} state={isRunLive(run) ? 'running' : undefined} />
                {environment.workspace && <Row icon={Monitor} label={environment.workspace.value} meta={environment.workspace.provenance === 'observed' ? 'observed in run' : 'recorded'} title={environment.workspace.value} />}
                {environment.branch && <Row icon={GitBranch} label={environment.branch.value} meta={environment.branch.provenance === 'observed' ? 'observed in run' : 'branch'} />}
                {environment.model && <Row icon={Sparkles} label={environment.model.value} meta={environment.model.provenance === 'observed' ? 'observed in run' : 'model'} />}
              </Section>

              <Section title="Plan" collapsible meta={plan?.declaredCount ? `${plan.declaredCount} planned` : plan?.steps.length ? `${plan.steps.length} recorded` : 'not recorded'}>
                {!plan?.recorded ? <EmptyLine>No structured plan was recorded for this run.</EmptyLine> : (
                  <>
                    {plan.objective && <p className="mb-2 line-clamp-3 text-small leading-relaxed text-muted">{plan.objective}</p>}
                    {plan.steps.length === 0 ? <EmptyLine>Plan recorded; individual step names were not emitted.</EmptyLine> : plan.steps.slice(-8).map((step) => (
                      <Row
                        key={step.label}
                        icon={step.state === 'done' ? Check : step.state === 'failed' ? OctagonX : ChevronRight}
                        label={step.label}
                        meta={step.state}
                        state={step.state === 'failed' ? 'failed' : step.state === 'done' ? 'done' : 'running'}
                      />
                    ))}
                    {plan.steps.length > 8 && <p className="mt-1 text-caption text-faint">Latest 8 of {plan.steps.length} projected steps shown.</p>}
                  </>
                )}
              </Section>

              <Section title="Helpers" collapsible meta={helpers.length ? `${helpersDone} done${helpersFailed ? ` · ${helpersFailed} failed` : ''}` : 'none'}>
                {helpers.length === 0 ? <EmptyLine>No helpers or handoffs were recorded.</EmptyLine> : helpers.slice(-8).map((helper) => (
                  <Row
                    key={helper.key}
                    icon={Bot}
                    label={helper.label}
                    meta={helper.meta || helper.state}
                    state={helper.state === 'failed' ? 'failed' : helper.state === 'done' ? 'done' : 'running'}
                  />
                ))}
                {helpers.length > 8 && <p className="mt-1 text-caption text-faint">Latest 8 of {helpers.length} projected helpers shown.</p>}
              </Section>

              <Section
                title="Tools & resources"
                collapsible
                defaultOpen={artifacts.length > 0}
                meta={tools?.logicalCount != null
                  ? `${tools.logicalCount} logical call${tools.logicalCount === 1 ? '' : 's'} · ${scope?.label ?? 'run scope'}`
                  : tools?.recordedCalls
                    ? `${tools.recordedCalls} recorded call event${tools.recordedCalls === 1 ? '' : 's'} · ${scope?.label ?? 'run scope'}`
                    : 'no calls recorded'}
              >
                {tools && visibleToolNames.length > 0 ? (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {visibleToolNames.map((name) => (
                      <span key={name} title={name} className="max-w-full truncate rounded-md bg-subtle px-2 py-1 font-mono text-caption text-muted">
                        {name}{(tools.countsByName[name] ?? 1) > 1 ? ` ${tools.countsByName[name]}×` : ''}
                      </span>
                    ))}
                  </div>
                ) : <EmptyLine>No tool use was recorded.</EmptyLine>}
                {toolNamesOmitted > 0 && <p className="mb-2 text-caption text-faint">{toolNamesOmitted} additional tool name{toolNamesOmitted === 1 ? '' : 's'} omitted from this compact view.</p>}
                {tools && tools.mirrorEvents > 0 && (
                  <p className="mb-2 text-caption text-faint">{tools.mirrorEvents} transport mirror event{tools.mirrorEvents === 1 ? '' : 's'} omitted from usage.</p>
                )}
                {artifacts.length > 0 && (
                  <div className="mt-3">
                    <div className="mb-1 text-caption font-semibold uppercase tracking-wide text-faint">Artifact ledger</div>
                    {visibleArtifacts.map((artifact, index) => {
                      const url = safeArtifactUrl(artifact);
                      const label = artifactLabel(artifact);
                      const binding = artifactBindingPresentation(artifact);
                      return (
                        <Row
                          key={artifact.id || `${artifact.slotKey}-${index}`}
                          icon={Box}
                          label={url ? (
                            <a href={url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 truncate text-primary hover:underline">
                              <span className="truncate">{label}</span><ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
                            </a>
                          ) : label}
                          meta={binding.meta}
                          state={binding.state}
                          title={artifact.bindingVerifiedAt
                            ? `Provider read-back verified ${artifact.bindingVerifiedAt}${artifact.resourceId ? ` · ${artifact.resourceId}` : ''}`
                            : (artifact.resourceId || artifact.runScopeId)}
                        />
                      );
                    })}
                  </div>
                )}
                {returnedArtifactsOmitted > 0 && (
                  <p className="mt-2 text-caption text-faint">
                    Latest {visibleArtifacts.length} shown; {returnedArtifactsOmitted} additional returned artifact{returnedArtifactsOmitted === 1 ? '' : 's'} omitted from this compact view.
                  </p>
                )}
                {(observedUrls.length > 0 || references.files.length > 0) && (
                  <div className="mt-3">
                    <div className="mb-1 text-caption font-semibold uppercase tracking-wide text-faint">Observed references</div>
                    {observedUrls.slice(0, 6).map((url) => (
                      <Row
                        key={url}
                        icon={Network}
                        label={<a href={url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 truncate text-primary hover:underline"><span className="truncate">{url}</span><ExternalLink className="h-3 w-3 shrink-0" aria-hidden /></a>}
                        meta="observed"
                        title="Observed in telemetry; not a verified artifact binding"
                      />
                    ))}
                    {references.files.slice(0, 6).map((file) => <Row key={file} icon={FileText} label={file.split('/').filter(Boolean).at(-1) || file} meta="file" title={file} />)}
                    {(observedUrls.length > 6 || references.files.length > 6) && (
                      <p className="mt-1 text-caption text-faint">
                        {Math.max(0, observedUrls.length - 6) + Math.max(0, references.files.length - 6)} additional observed reference{Math.max(0, observedUrls.length - 6) + Math.max(0, references.files.length - 6) === 1 ? '' : 's'} omitted.
                      </p>
                    )}
                  </div>
                )}
              </Section>

              <Section title="Details" collapsible meta={scope?.label}>
                <Row icon={TerminalSquare} label={run.id} meta="run id" title={run.id} />
                {run.runEnvironmentMeta?.runScopeId && (
                  <Row icon={Network} label={run.runEnvironmentMeta.runScopeId} meta="scope id" title={run.runEnvironmentMeta.runScopeId} />
                )}
                {scope?.audit && <p className="mt-2 text-caption text-faint">{scope.audit}.</p>}
                {scope?.projection && <p className="mt-1 text-caption text-faint">Projection: {scope.projection}.</p>}
                {scope?.artifacts && <p className="mt-1 text-caption text-faint">Artifact coverage: {scope.artifacts}.</p>}
              </Section>

            </>
          )}
        </div>

        {run && (
          <div className="min-w-0 shrink-0 border-t border-border bg-surface px-4 py-3 shadow-[0_-8px_18px_-18px_rgba(0,0,0,0.55)]">
            {stopError && <p role="alert" className="mb-2 rounded-md bg-danger-tint px-3 py-2 text-small text-danger">Run control was not confirmed: {stopError}</p>}
            {detail.isError && <p className="mb-2 text-caption text-warning">Live refresh paused. The last loaded context remains visible.</p>}
            <div className="flex min-w-0 flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="min-w-0 flex-1 basis-[9rem]"
                onClick={() => { onClose(); navigate(runEnvironmentTasksHref(run)); }}
              >
                <Hammer className="h-4 w-4" aria-hidden /> Open tasks
              </Button>
              {isRunEnvironmentBackgroundable(run) && (
                <Button className="min-w-0 flex-1 basis-[8rem]" variant="secondary" size="sm" onClick={() => void moveToBackground()} disabled={moving || stopping}>
                  {moving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <SendToBack className="h-4 w-4" aria-hidden />}
                  {moving ? 'Moving…' : 'Background'}
                </Button>
              )}
              {isRunEnvironmentCancellable(run) && (
                <Button className="min-w-0 flex-1 basis-[8rem]" variant="danger" size="sm" onClick={() => void stop()} disabled={stopping || moving}>
                  {stopping ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <OctagonX className="h-4 w-4" aria-hidden />}
                  {stopping ? 'Stopping…' : 'Stop run'}
                </Button>
              )}
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
