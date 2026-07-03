import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  ArrowLeft, RefreshCw, Pause, Play, ExternalLink, PanelRightOpen, X,
  MessageCircle, RotateCcw, AlertCircle, Database, Zap, History, FileCode2, CheckCircle2, Share2,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { StatusPill, type Tone } from '@/components/ui/StatusPill';
import { DogMark } from '@/components/DogMark';
import { ChatBubble } from '@/components/chat/ChatBubble';
import { Composer } from '@/components/chat/Composer';
import { useChat } from '@/lib/useChat';
import { usePoll } from '@/lib/poll';
import {
  getSpace, refreshSpace, patchSpace, rollbackSpace, publishSpace,
  spaceViewUrl, spaceSessionId, openApprovalCount, gapQuestions, type SpaceStatus,
} from '@/lib/spaces';
import { BuildStatusBanner } from '@/components/workspaces/BuildStatusBanner';

function statusTone(status: SpaceStatus): Tone {
  if (status === 'active') return 'success';
  if (status === 'paused') return 'warning';
  return 'neutral';
}

type DetailTab = 'health' | 'code' | 'history' | 'audit';

export function WorkspaceView() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const detail = usePoll(['space', id], () => getSpace(id), 5000, { enabled: !!id });
  const chat = useChat({ initialSessionId: spaceSessionId(id) });

  const [iframeKey, setIframeKey] = useState(0);
  const lastMtimeRef = useRef<number | null>(null);
  const seededRef = useRef(false);

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
  const [dockOpen, setDockOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [tab, setTab] = useState<DetailTab>('health');
  const [error, setError] = useState<string | null>(null);

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
  const refreshFailures = (detail.data?.audit ?? [])
    .filter((a) => a.method === 'REFRESH' && a.outcome === 'error').slice(-3).reverse();

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2.5">
        <Button variant="ghost" size="sm" onClick={() => navigate('/workspaces')} aria-label="Back to Workspaces">
          <ArrowLeft className="h-4 w-4" aria-hidden />
        </Button>
        <h2 className="truncate text-h3 text-fg">{space.title}</h2>
        <StatusPill tone={statusTone(space.status)}>{space.status}</StatusPill>
        {openApprovals > 0 && <StatusPill tone="warning">{openApprovals} waiting</StatusPill>}
        {space.lastRefreshedAt && (
          <span className="hidden text-caption text-faint sm:inline">
            refreshed {new Date(space.lastRefreshedAt).toLocaleTimeString()}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {space.dataSources.length > 0 && (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => act(() => refreshSpace(id), true)}>
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
          <Button variant="ghost" size="icon" aria-label="Open in new tab" onClick={() => window.open(spaceViewUrl(id), '_blank')}>
            <ExternalLink className="h-4 w-4" aria-hidden />
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
        onAskClem={() => setDockOpen(true)}
      />

      {/* Body: the agent-authored view + overlays */}
      <div className="relative min-h-0 flex-1 bg-canvas">
        <iframe
          key={iframeKey}
          title={space.title}
          src={spaceViewUrl(id)}
          className="absolute inset-0 h-full w-full border-0"
        />

        {/* Details drawer */}
        {detailsOpen && (
          <aside className="absolute right-0 top-0 flex h-full w-full max-w-[440px] flex-col border-l border-border bg-surface shadow-lg">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              {(['health', 'code', 'history', 'audit'] as DetailTab[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={`rounded-md px-2.5 py-1 text-small capitalize transition-colors cursor-pointer ${tab === t ? 'bg-primary-tint text-fg' : 'text-muted hover:text-fg'}`}
                >
                  {t}
                </button>
              ))}
              <button type="button" className="ml-auto text-muted hover:text-fg cursor-pointer" onClick={() => setDetailsOpen(false)} aria-label="Close details">
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3">
              {tab === 'health' && (
                <div className="space-y-3">
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

        {/* Floating "Ask Clem" dock */}
        {dockOpen ? (
          <div className="absolute bottom-4 right-4 flex h-[480px] w-[360px] max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-lg">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <DogMark className="h-6 w-6" />
              <div className="min-w-0 flex-1">
                <p className="text-small font-semibold text-fg">Ask Clem</p>
                <p className="truncate text-caption text-faint">about “{space.title}”</p>
              </div>
              <button type="button" className="text-muted hover:text-fg cursor-pointer" onClick={() => setDockOpen(false)} aria-label="Close chat">
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
              {chat.messages.length === 0 ? (
                <p className="px-1 pt-6 text-center text-small text-muted">
                  Ask about anything in this workspace — “what changed today?”, “draft a follow-up for the stalled deals”.
                </p>
              ) : (
                chat.messages.map((m) => (
                  <ChatBubble
                    key={m.id}
                    message={m}
                    onApprove={() => chat.send({ text: 'approve' })}
                    onReject={() => chat.send({ text: 'not now' })}
                  />
                ))
              )}
            </div>
            <div className="border-t border-border p-2">
              <Composer busy={chat.busy} onSend={chat.send} onStop={chat.stop} placeholder="Ask about this workspace…" />
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setDockOpen(true)}
            className="absolute bottom-4 right-4 inline-flex items-center gap-2 rounded-full bg-primary px-4 py-3 text-primary-fg shadow-lg transition-transform hover:scale-105 cursor-pointer"
          >
            <MessageCircle className="h-5 w-5" aria-hidden /> Ask Clem
          </button>
        )}
      </div>
    </div>
  );
}
