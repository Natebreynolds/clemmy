import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  ArrowLeft, RefreshCw, Pause, Play, PanelRightOpen, X,
  MessageCircle, RotateCcw, AlertCircle, Database, Zap, History, FileCode2, CheckCircle2, Share2,
  PanelLeftClose,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { StatusPill, type Tone } from '@/components/ui/StatusPill';
import { ChatBubble } from '@/components/chat/ChatBubble';
import { Composer } from '@/components/chat/Composer';
import { RunningTasksDrawer } from '@/components/chat/RunningTasksDrawer';
import { chatApprovalReply, useChat } from '@/lib/useChat';
import { usePoll } from '@/lib/poll';
import {
  isCurrentWorkspaceDiffScope,
  type WorkspaceDiffScope,
} from '@/lib/workspace-history-state';
import {
  getSpace, refreshSpace, patchSpace, rollbackSpace, publishSpace,
  getSpaceDiff, getSpaceHistory, spaceSessionId, openApprovalCount, gapQuestions,
  latestRefreshFailures, buildWorkspaceFixPrompt, type SpaceStatus, type SpaceDiffResponse,
  type SpaceObservationSummary, WorkspaceRefreshError,
} from '@/lib/spaces';
import { BuildStatusBanner } from '@/components/workspaces/BuildStatusBanner';
import { CanonicalEntityCoveragePanel } from '@/components/workspaces/CanonicalEntityCoveragePanel';
import { PurposePanel } from '@/components/workspaces/PurposePanel';
import { WorkspaceFrame } from '@/components/workspaces/WorkspaceFrame';
import { describeSpaceShape, spaceBuildState } from '@/lib/space-build';
import { getWorkflowsHome } from '@/lib/automate';

function statusTone(status: SpaceStatus): Tone {
  if (status === 'active') return 'success';
  if (status === 'paused') return 'warning';
  return 'neutral';
}

type DetailTab = 'health' | 'dataHistory' | 'code' | 'history' | 'audit';
type ScopedHistoryDiff = { scope: WorkspaceDiffScope; value: SpaceDiffResponse };
type ScopedHistoryDiffBusy = { scope: WorkspaceDiffScope; observationId: string };

export function WorkspaceView() {
  const { id = '' } = useParams();
  return <WorkspaceViewForId key={id} id={id} />;
}

function WorkspaceViewForId({ id }: { id: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const detail = usePoll(['space', id], () => getSpace(id), 5000, { enabled: !!id });
  const chat = useChat({ initialSessionId: spaceSessionId(id) });

  const [iframeKey, setIframeKey] = useState(0);
  const lastMtimeRef = useRef<number | null>(null);
  const seededRef = useRef(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // Auto-reload the view when its file changes — keyed on the view's mtime so it
  // catches ANY edit (Clem's space_edit_view, a write_file rewrite, a rollback).
  // Polled via `detail` (5s), so an in-chat edit shows without hitting Refresh.
  const viewMtime = detail.data?.viewMtimeMs ?? null;
  useEffect(() => {
    if (viewMtime == null) return;
    if (lastMtimeRef.current != null && viewMtime !== lastMtimeRef.current) {
      setIframeKey((k) => k + 1);
    }
    lastMtimeRef.current = viewMtime;
  }, [viewMtime]);
  const [busy, setBusy] = useState(false);
  // The conversation is a COLUMN beside the canvas, open by default — the
  // build is watched from it (owner-approved Spaces mockup, 2026-09-08).
  const [dockOpen, setDockOpen] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [tab, setTab] = useState<DetailTab>('health');
  const [error, setError] = useState<string | null>(null);
  const history = usePoll(
    ['space-history', id],
    () => getSpaceHistory(id, { limit: 60 }),
    0,
    { enabled: !!id && detailsOpen && tab === 'dataHistory' },
  );
  const [historyItems, setHistoryItems] = useState<SpaceObservationSummary[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | undefined>();
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyPageBusy, setHistoryPageBusy] = useState(false);
  const [historyPageError, setHistoryPageError] = useState<string | null>(null);
  const [historyDiffState, setHistoryDiffState] = useState<ScopedHistoryDiff | null>(null);
  const [diffBusyState, setDiffBusyState] = useState<ScopedHistoryDiffBusy | null>(null);
  const workspaceIdRef = useRef(id);
  const historyPageRef = useRef(history.data);
  const diffRequestIdRef = useRef(0);
  workspaceIdRef.current = id;
  historyPageRef.current = history.data;
  const currentDiffScope: WorkspaceDiffScope = {
    workspaceId: id,
    pageToken: history.data,
    requestId: diffRequestIdRef.current,
  };
  const historyDiff = historyDiffState
    && isCurrentWorkspaceDiffScope(historyDiffState.scope, currentDiffScope)
    ? historyDiffState.value
    : null;
  const diffBusyId = diffBusyState
    && isCurrentWorkspaceDiffScope(diffBusyState.scope, currentDiffScope)
    ? diffBusyState.observationId
    : null;

  useEffect(() => {
    diffRequestIdRef.current += 1;
    setHistoryItems([]);
    setHistoryCursor(undefined);
    setHistoryHasMore(false);
    setHistoryPageBusy(false);
    setHistoryPageError(null);
    setHistoryDiffState(null);
    setDiffBusyState(null);
  }, [id]);

  useEffect(() => {
    if (!history.data) return;
    diffRequestIdRef.current += 1;
    setHistoryItems(history.data.observations);
    setHistoryCursor(history.data.nextCursor);
    setHistoryHasMore(history.data.hasMore);
    setHistoryPageError(null);
    setHistoryDiffState(null);
    setDiffBusyState(null);
  }, [history.data]);

  // Seed the dock with the build request passed from the creation modal, so a
  // brand-new workspace starts building immediately (no cold context-switch).
  useEffect(() => {
    const build = (location.state as { build?: string } | null)?.build;
    if (!build || seededRef.current) return;
    seededRef.current = true;
    setDockOpen(true);
    void chat.send({ text: build });
    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const space = detail.data?.space;
  // WATCH HER BUILD: the Space's own chat stream is the build feed. Steps and
  // state are pure derivations over it (lib/space-build); the preview below
  // re-renders as revisions land (viewMtimeMs poll + the live action stream).
  const buildState = spaceBuildState(chat.messages);
  // A linked workflow that is running right now says so on its chip — the
  // Space is where its output lands, so its progress belongs here too.
  const workflowsHome = usePoll(['workflows-home'], getWorkflowsHome, 6000, { enabled: (detail.data?.linkedWorkflows ?? []).length > 0 });
  const runningWorkflows = new Map((workflowsHome.data?.activeRuns ?? []).map((run) => [run.workflowName, run]));
  const threadEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => { threadEndRef.current?.scrollIntoView({ block: 'end' }); }, [chat.messages]);
  // A placeholder Space whose build never started (the page was reloaded before
  // the dock sent it): the durable objective is the build request — offer to start.
  const routeBuild = (location.state as { build?: string } | null)?.build;
  const pendingObjective = !routeBuild && chat.messages.length === 0 && space && (space.revisions?.length ?? 0) === 0
    ? (space.contract?.objective ?? undefined)
    : undefined;

  const loadMoreHistory = async () => {
    if (!historyCursor || historyPageBusy) return;
    const requestedWorkspaceId = id;
    const requestedPage = history.data;
    const isCurrent = () => workspaceIdRef.current === requestedWorkspaceId
      && historyPageRef.current === requestedPage;
    setHistoryPageBusy(true);
    setHistoryPageError(null);
    try {
      const page = await getSpaceHistory(id, { limit: 60, cursor: historyCursor });
      if (!isCurrent()) return;
      setHistoryItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...page.observations.filter((item) => !seen.has(item.id))];
      });
      setHistoryCursor(page.nextCursor);
      setHistoryHasMore(page.hasMore);
    } catch (err) {
      if (isCurrent()) {
        setHistoryPageError(err instanceof Error ? err.message : 'Could not load more history.');
      }
    } finally {
      if (isCurrent()) setHistoryPageBusy(false);
    }
  };

  const act = async (fn: () => Promise<unknown>, reloadView = false) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (reloadView) setIframeKey((k) => k + 1);
      await detail.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  };

  if (detail.isLoading) {
    return <div className="flex h-full items-center justify-center text-muted">Loading workspace…</div>;
  }
  if (detail.isError || !space) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted">
        <p>Couldn’t open this workspace.</p>
        <Button variant="secondary" onClick={() => navigate('/workspaces')}>
          <ArrowLeft className="h-4 w-4" aria-hidden /> Back to Workspaces
        </Button>
      </div>
    );
  }

  const notes = detail.data?.notes ?? [];
  const health = detail.data?.health ?? space.health;
  const openApprovals = openApprovalCount(notes);
  const gaps = gapQuestions(notes);
  const refreshFailures = latestRefreshFailures(detail.data?.audit ?? []);

  // "Ask Clem to fix" hands Clem the actual failure, not an empty composer —
  // the user shouldn't have to re-type an error the banner is already showing.
  const askClemToFix = () => {
    setDockOpen(true);
    void chat.send({
      text: buildWorkspaceFixPrompt({
        paused: space.status === 'paused',
        failures: refreshFailures,
        gaps,
        openApprovals,
      }),
    });
  };

  const compareWithPrevious = async (observation: SpaceObservationSummary) => {
    if (!observation.previousObservationId) return;
    const requestScope: WorkspaceDiffScope = {
      workspaceId: id,
      pageToken: history.data,
      requestId: diffRequestIdRef.current + 1,
    };
    diffRequestIdRef.current = requestScope.requestId;
    const isCurrent = () => isCurrentWorkspaceDiffScope(requestScope, {
      workspaceId: workspaceIdRef.current,
      pageToken: historyPageRef.current,
      requestId: diffRequestIdRef.current,
    });
    setDiffBusyState({ scope: requestScope, observationId: observation.id });
    setHistoryDiffState(null);
    setError(null);
    try {
      const result = await getSpaceDiff(id, {
        sourceKey: observation.sourceKey,
        from: observation.previousObservationId,
        to: observation.id,
      });
      if (isCurrent()) setHistoryDiffState({ scope: requestScope, value: result });
    } catch (err) {
      if (isCurrent()) {
        setError(err instanceof Error ? err.message : 'Couldn’t compare these observations.');
      }
    } finally {
      if (isCurrent()) setDiffBusyState(null);
    }
  };

  const building = buildState === 'building';
  const firstVersionPending = building && (space.revisions?.length ?? 0) === 0;
  return (
    <div className="flex h-full">
      {dockOpen && (
        <aside className="flex w-[400px] shrink-0 flex-col border-r border-border bg-subtle" aria-label="Conversation with Clementine">
          <div className="flex items-center gap-2 px-3 pb-2 pt-3">
            <Button variant="ghost" size="sm" onClick={() => navigate('/workspaces')} aria-label="Back to Spaces">
              <ArrowLeft className="h-4 w-4" aria-hidden />
            </Button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-body font-semibold text-fg">{space.title}</p>
              <p className="truncate text-caption text-faint">with Clementine · {describeSpaceShape(space)}</p>
            </div>
            <Button variant="ghost" size="icon" aria-label="Hide the conversation" onClick={() => setDockOpen(false)}>
              <PanelLeftClose className="h-4 w-4" aria-hidden />
            </Button>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-3">
            {chat.messages.length === 0 ? (
              pendingObjective ? (
                <div className="rounded-lg border border-border bg-surface p-4 shadow-xs">
                  <p className="text-small font-semibold text-fg">Ready to build</p>
                  <p className="mt-1 text-small text-muted">{pendingObjective}</p>
                  <Button className="mt-3" size="sm" onClick={() => { void chat.send({ text: pendingObjective }); }}>Start building</Button>
                </div>
              ) : (
                <p className="px-1 pt-6 text-center text-small text-muted">
                  Ask for a change — “add a bar per rep”, “hide closed-lost” — or “what changed since the last refresh?”
                </p>
              )
            ) : (
              chat.messages.map((m) => (
                <ChatBubble
                  key={m.id}
                  message={m}
                  sessionId={chat.sessionId.current ?? undefined}
                  executionBusy={chat.busy}
                  onExecutePlan={chat.executePlan}
                  onRevisePlan={() => { chat.setComposerMode('plan'); composerRef.current?.focus(); }}
                  onApprove={() => chat.send({ text: chatApprovalReply('approve', m.approval?.approvalId) })}
                  onReject={() => chat.send({ text: chatApprovalReply('reject', m.approval?.approvalId) })}
                />
              ))
            )}
            <div ref={threadEndRef} />
          </div>
          <div className="border-t border-border p-2.5">
            <RunningTasksDrawer className="mb-1" composerRef={composerRef} />
            <Composer inputRef={composerRef} sessionId={chat.sessionId.current ?? undefined} busy={chat.busy} mode={chat.composerMode} onModeChange={chat.setComposerMode} activeTaskMode={chat.activeTaskMode} pendingPost={chat.pendingPost} onRetryPending={chat.retryPending} onCancelPending={chat.cancelPending} onSend={chat.send} onStop={chat.stop} placeholder="Ask for a change — “add a bar per rep”, “hide closed-lost”" />
          </div>
        </aside>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="relative flex items-center gap-2 border-b border-border bg-surface px-4 py-2.5">
        {!dockOpen && (
          <>
            <Button variant="ghost" size="sm" onClick={() => navigate('/workspaces')} aria-label="Back to Spaces">
              <ArrowLeft className="h-4 w-4" aria-hidden />
            </Button>
            <Button variant="secondary" size="sm" onClick={() => { setDockOpen(true); composerRef.current?.focus(); }}>
              <MessageCircle className="h-4 w-4" aria-hidden /> Ask Clem
            </Button>
          </>
        )}
        <h2 className="truncate text-h3 text-fg">{space.title}</h2>
        {building
          ? <StatusPill tone="live">building</StatusPill>
          : <StatusPill tone={statusTone(space.status)}>{space.status}</StatusPill>}
        {building && <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-primary/70" />}
        {openApprovals > 0 && <StatusPill tone="warning">{openApprovals} waiting</StatusPill>}
        {space.lastRefreshedAt && (
          <span className="hidden text-caption text-faint sm:inline">
            refreshed {new Date(space.lastRefreshedAt).toLocaleTimeString()}
          </span>
        )}
        {/* The automation feeding this workspace — one click to its workflow. */}
        {(detail.data?.linkedWorkflows ?? []).map((wf) => (
          <button
            key={wf.name}
            type="button"
            title={`${wf.description || wf.name}${wf.enabled ? '' : ' (disabled)'} — open in Automate`}
            onClick={() => navigate(`/automate?workflow=${encodeURIComponent(wf.name)}`)}
            className={`hidden items-center gap-1 rounded-full border border-border px-2 py-0.5 text-caption md:inline-flex ${wf.enabled ? 'text-muted hover:text-primary hover:border-primary/40' : 'text-faint line-through'}`}
          >
            {runningWorkflows.has(wf.name)
              ? <span className="h-2 w-2 animate-pulse rounded-full bg-primary" aria-hidden />
              : <Zap className="h-3 w-3" aria-hidden />}
            <span className="max-w-[160px] truncate">{wf.name}</span>
            {runningWorkflows.get(wf.name)?.inFlightStepId && <span className="text-primary">· {runningWorkflows.get(wf.name)?.inFlightStepId}</span>}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1.5">
          {space.dataSources.length > 0 && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => act(async () => {
                try {
                  await refreshSpace(id);
                } catch (err) {
                  if (err instanceof WorkspaceRefreshError && err.pendingApprovalIds.length > 0) {
                    setDockOpen(true);
                  }
                  throw err;
                }
                await history.refetch();
              }, true)}
            >
              <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} aria-hidden /> Refresh
            </Button>
          )}
          <Button
            variant="secondary" size="sm" disabled={busy}
            onClick={() => act(() => patchSpace(id, { status: space.status === 'paused' ? 'active' : 'paused' }))}
          >
            {space.status === 'paused' ? <><Play className="h-4 w-4" aria-hidden /> Resume</> : <><Pause className="h-4 w-4" aria-hidden /> Pause</>}
          </Button>
          <Button
            variant="secondary" size="sm" disabled={busy}
            title="Export a static, credential-free snapshot and have Clem deploy it for a shareable link (the data in it becomes visible to anyone with the link)."
            onClick={() => act(async () => {
              const snap = await publishSpace(id);
              setDockOpen(true);
              void chat.send({
                text: `I exported a static share snapshot of this workspace (${snap.files.length} files at ${snap.dir}). `
                  + 'Deploy it with the usual flow and give me the shareable link. '
                  + 'Before deploying, sanity-check the inlined data — it will be visible to anyone with the link.',
              });
            })}
          >
            <Share2 className="h-4 w-4" aria-hidden /> Share
          </Button>
          <Button variant="ghost" size="icon" aria-label="Details" onClick={() => setDetailsOpen((v) => !v)}>
            <PanelRightOpen className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>

      {error && (
        <p className="flex items-center gap-2 border-b border-danger/30 bg-danger/5 px-4 py-2 text-small text-danger">
          <AlertCircle className="h-4 w-4" aria-hidden /> {error}
        </p>
      )}

      <BuildStatusBanner
        paused={space.status === 'paused'}
        gaps={gaps}
        openApprovals={openApprovals}
        failures={refreshFailures}
        busy={busy}
        onResume={() => act(() => patchSpace(id, { status: 'active' }))}
        onAskClem={askClemToFix}
      />

      {/* Body: the agent-authored view + overlays */}
      <div className="relative min-h-0 flex-1 bg-canvas">
        <WorkspaceFrame
          key={iframeKey}
          id={id}
          title={space.title}
          className="absolute inset-0 h-full w-full border-0"
          onMutation={() => { void detail.refetch(); }}
          onError={(message) => {
            setError(message);
            if (/approval needed/i.test(message)) setDockOpen(true);
          }}
        />

        {firstVersionPending && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-center" aria-live="polite">
            <div>
              <p className="text-h3 text-muted">Nothing here yet</p>
              <p className="mt-1 text-body text-faint">Clementine is reading your data. The first version lands in a moment.</p>
            </div>
          </div>
        )}

        {/* Details drawer */}
        {detailsOpen && (
          <aside className="absolute right-0 top-0 flex h-full w-full max-w-[440px] flex-col border-l border-border bg-surface shadow-lg">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              {(['health', 'dataHistory', 'code', 'history', 'audit'] as DetailTab[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={`rounded-md px-2.5 py-1 text-small capitalize transition-colors cursor-pointer ${tab === t ? 'bg-primary-tint text-fg' : 'text-muted hover:text-fg'}`}
                >
                  {t === 'dataHistory' ? 'data history' : t === 'history' ? 'view versions' : t}
                </button>
              ))}
              <button type="button" className="ml-auto text-muted hover:text-fg cursor-pointer" onClick={() => setDetailsOpen(false)} aria-label="Close details">
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3">
              {tab === 'health' && (
                <div className="space-y-3">
                  <PurposePanel space={space} onSaved={() => { void detail.refetch(); }} />
                  <CanonicalEntityCoveragePanel workspaceId={id} />
                  {health ? (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="rounded-md border border-border bg-subtle px-3 py-2">
                          <p className="flex items-center gap-1.5 text-caption text-faint"><Database className="h-3.5 w-3.5" aria-hidden /> Sources</p>
                          <p className="text-h3 text-fg">{health.counts.dataSources}</p>
                        </div>
                        <div className="rounded-md border border-border bg-subtle px-3 py-2">
                          <p className="flex items-center gap-1.5 text-caption text-faint"><Zap className="h-3.5 w-3.5" aria-hidden /> Actions</p>
                          <p className="text-h3 text-fg">{health.counts.actions}</p>
                        </div>
                        <div className="rounded-md border border-border bg-subtle px-3 py-2">
                          <p className="flex items-center gap-1.5 text-caption text-faint"><History className="h-3.5 w-3.5" aria-hidden /> Version</p>
                          <p className="text-h3 text-fg">v{health.version}</p>
                        </div>
                        <div className="rounded-md border border-border bg-subtle px-3 py-2">
                          <p className="flex items-center gap-1.5 text-caption text-faint"><FileCode2 className="h-3.5 w-3.5" aria-hidden /> View</p>
                          <p className="truncate text-small text-fg">{health.view.exists ? `${Math.round(health.view.bytes / 1024)} KB` : 'missing'}</p>
                        </div>
                      </div>
                      <div className="rounded-md border border-border bg-surface p-3">
                        <p className="mb-2 text-small font-semibold text-fg">Freshness</p>
                        <p className="text-small text-muted">
                          {health.freshness.state.replace('_', ' ')}
                          {health.freshness.lastRefreshedAt ? ` · ${new Date(health.freshness.lastRefreshedAt).toLocaleString()}` : ''}
                        </p>
                      </div>
                      <div className="rounded-md border border-border bg-surface p-3">
                        <p className="mb-2 text-small font-semibold text-fg">Runners</p>
                        {health.runners.length === 0 ? (
                          <p className="text-small text-muted">No runner files declared.</p>
                        ) : (
                          <ul className="flex flex-col gap-1.5">
                            {health.runners.map((r) => (
                              <li key={`${r.kind}-${r.id}-${r.runner}`} className="flex items-center gap-2 text-caption text-muted">
                                {r.present ? <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden /> : <AlertCircle className="h-3.5 w-3.5 text-warning" aria-hidden />}
                                <span className="font-mono text-fg">{r.runner}</span>
                                <span className="truncate">{r.id}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <div className="rounded-md border border-border bg-surface p-3">
                        <p className="mb-2 text-small font-semibold text-fg">Issues</p>
                        {health.issues.length === 0 ? (
                          <p className="text-small text-muted">No issues reported.</p>
                        ) : (
                          <ul className="flex flex-col gap-1.5">
                            {health.issues.map((issue, i) => (
                              <li key={i} className="flex items-start gap-2 text-small text-warning">
                                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> <span>{issue}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </>
                  ) : (
                    <p className="text-small text-muted">Health snapshot unavailable.</p>
                  )}
                </div>
              )}
              {tab === 'code' && (
                <pre className="whitespace-pre-wrap break-words rounded-md bg-subtle p-3 font-mono text-caption text-fg">
                  {detail.data?.viewSource || '(no view yet)'}
                </pre>
              )}
              {tab === 'dataHistory' && (
                <DataHistoryPanel
                  observations={historyItems}
                  hasMore={historyHasMore}
                  loading={history.isLoading}
                  failed={history.isError}
                  pageBusy={historyPageBusy}
                  pageError={historyPageError}
                  diff={historyDiff}
                  diffBusyId={diffBusyId}
                  onCompare={compareWithPrevious}
                  onRetry={() => { void history.refetch(); }}
                  onLoadMore={() => { void loadMoreHistory(); }}
                />
              )}
              {tab === 'history' && (
                space.revisions.length === 0
                  ? <p className="text-small text-muted">No prior versions yet.</p>
                  : (
                    <ul className="flex flex-col gap-2">
                      {[...space.revisions].reverse().map((r) => (
                        <li key={r.version} className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2">
                          <span className="text-small text-fg">v{r.version} · {new Date(r.ts).toLocaleString()}</span>
                          <Button variant="ghost" size="sm" disabled={busy} onClick={() => act(() => rollbackSpace(id, r.version), true)}>
                            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Revert
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )
              )}
              {tab === 'audit' && (
                (detail.data?.audit ?? []).length === 0
                  ? <p className="text-small text-muted">No activity recorded yet.</p>
                  : (
                    <ul className="flex flex-col gap-1.5">
                      {(detail.data?.audit ?? []).slice().reverse().map((a, i) => (
                        <li key={i} className="flex items-center gap-2 text-caption text-muted">
                          <span className="font-mono text-fg">{a.method}</span>
                          <span className="truncate">{a.path}</span>
                          <span className="ml-auto">{a.outcome}</span>
                        </li>
                      ))}
                    </ul>
                  )
              )}
            </div>
          </aside>
        )}

      </div>
      </div>
    </div>
  );
}

function observationState(observation: SpaceObservationSummary): {
  label: string;
  className: string;
} {
  if (observation.status === 'error') {
    return { label: 'failed', className: 'bg-danger/10 text-danger' };
  }
  if (observation.status === 'awaiting_approval') {
    return { label: 'awaiting approval', className: 'bg-warning/10 text-warning' };
  }
  if (!observation.previousObservationId) {
    return { label: 'baseline', className: 'bg-subtle text-muted' };
  }
  if (observation.changed === true) {
    return { label: 'changed', className: 'bg-primary-tint text-primary' };
  }
  return { label: 'unchanged', className: 'bg-subtle text-muted' };
}

function DataHistoryPanel({
  observations,
  hasMore,
  loading,
  failed,
  pageBusy,
  pageError,
  diff,
  diffBusyId,
  onCompare,
  onRetry,
  onLoadMore,
}: {
  observations: SpaceObservationSummary[];
  hasMore: boolean;
  loading: boolean;
  failed: boolean;
  pageBusy: boolean;
  pageError: string | null;
  diff: SpaceDiffResponse | null;
  diffBusyId: string | null;
  onCompare: (observation: SpaceObservationSummary) => void;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  if (loading) return <p className="text-small text-muted">Loading data history…</p>;
  if (failed) {
    return (
      <div className="rounded-md border border-danger/30 bg-danger/5 p-3">
        <p className="text-small text-danger">Data history is temporarily unavailable.</p>
        <Button variant="ghost" size="sm" className="mt-2" onClick={onRetry}>Try again</Button>
      </div>
    );
  }
  if (observations.length === 0) {
    return (
      <div className="rounded-md border border-border bg-subtle p-3">
        <p className="text-small font-medium text-fg">No observations yet</p>
        <p className="mt-1 text-caption text-muted">
          Refresh a data source to establish its baseline. A second observation makes “what changed?” available.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="text-small font-semibold text-fg">Data history</p>
        <p className="mt-0.5 text-caption text-muted">
          Exact refresh observations, separate from authored view versions.
        </p>
      </div>

      {diff && (
        <div className="rounded-md border border-primary/30 bg-primary-tint p-3">
          {diff.status === 'insufficient_history' ? (
            <>
              <p className="text-small font-semibold text-fg">One more observation needed</p>
              <p className="mt-1 text-caption text-muted">
                {diff.sourceKey ? `“${diff.sourceKey}”` : 'This source'} has {diff.observations} comparable observation{diff.observations === 1 ? '' : 's'}.
              </p>
            </>
          ) : (
            <>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-small font-semibold text-fg">Changes in {diff.sourceKey}</p>
                  <p className="mt-0.5 text-caption text-muted">{diff.diff.summary}</p>
                </div>
                <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-caption text-muted">
                  {diff.diff.changed ? 'changed' : 'same'}
                </span>
              </div>
              {diff.diff.changes.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1.5">
                  {diff.diff.changes.map((change, index) => (
                    <li key={`${change.op}-${change.path}-${index}`} className="rounded border border-border bg-surface px-2 py-1.5">
                      <div className="flex items-center gap-2 text-caption">
                        <span className="font-semibold uppercase text-primary">{change.op}</span>
                        <code className="min-w-0 break-all text-fg">{change.path || '/'}</code>
                      </div>
                      {(change.before !== undefined || change.after !== undefined) && (
                        <div className="mt-1 grid grid-cols-2 gap-1 font-mono text-[11px] text-muted">
                          <span className="break-all rounded bg-subtle px-1.5 py-1">{change.before ?? '—'}</span>
                          <span className="break-all rounded bg-subtle px-1.5 py-1">{change.after ?? '—'}</span>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      <ul className="flex flex-col gap-2">
        {observations.map((observation) => {
          const state = observationState(observation);
          const comparable = observation.status === 'ok' && Boolean(observation.previousObservationId);
          return (
            <li key={observation.id} className="rounded-md border border-border bg-surface px-3 py-2.5">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate font-mono text-small text-fg">{observation.sourceKey}</span>
                    {observation.isCurrent && (
                      <span className="rounded-full bg-success/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-success">current</span>
                    )}
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase ${state.className}`}>
                      {state.label}
                    </span>
                  </div>
                  <p className="mt-1 text-caption text-muted">
                    {observation.cause.replaceAll('_', ' ')} · {new Date(observation.observedAt).toLocaleString()}
                  </p>
                </div>
                {comparable && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={diffBusyId !== null}
                    onClick={() => onCompare(observation)}
                  >
                    {diffBusyId === observation.id
                      ? <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden />
                      : <History className="h-3.5 w-3.5" aria-hidden />}
                    Compare
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {hasMore && (
        <div className="flex flex-col items-center gap-1.5">
          <Button variant="ghost" size="sm" disabled={pageBusy} onClick={onLoadMore}>
            {pageBusy && <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden />}
            Load more
          </Button>
          {pageError && <p className="text-caption text-danger">{pageError}</p>}
        </div>
      )}
    </div>
  );
}
