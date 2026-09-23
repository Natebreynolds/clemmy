/**
 * Home — the owner's own page. The Spaces they chose are the main content;
 * beside them, what needs an answer and what came back recently. Clem's
 * running work is summarized in one line that leads to the board (/tasks),
 * which owns the detail. A send from here hands off to the conversation the
 * moment the daemon acknowledges it.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Plus, SlidersHorizontal } from 'lucide-react';
import { HomeBuilder } from '@/components/home/HomeBuilder';
import { SpaceTile } from '@/components/home/SpaceTile';
import { openCustomizeHome } from '@/components/home/CustomizePanel';
import { changeHomeLayout, HOME_LAYOUT_KEY, useHomeLayout, type HomeTile } from '@/lib/home-layout';
import { useHomeBuilds } from '@/lib/home-builds';
import { BuildCard } from '@/components/home/BuildCard';
import { useQueryClient } from '@tanstack/react-query';
import { isHomeMockScreen } from '@/components/home/mock/screens';

/** Loaded only when ?mock= or ?screen= asks for it — see app.tsx. */
const HomeMock = lazy(async () => ({ default: (await import('./HomeMock')).HomeMock }));
import { apiGet } from '@/lib/api';
import { usePoll } from '@/lib/poll';
import { getContext } from '@/lib/memory';
import { greetingName, timeGreeting } from '@/lib/greeting';
import { DEFAULT_HOME_PREFERENCES, useHomePreferences, visiblePanes, type HomePaneId } from '@/lib/home-prefs';
import { useChat } from '@/lib/useChat';
import { unifiedChatSessionId } from '@/lib/last-session';
import { listWorkingNowSnapshot } from '@/lib/activity';
import { presentWorkingNow } from '@/lib/activity-presentation';
import { listSpaces } from '@/lib/spaces';
import type { CommandCenter } from '@/lib/types';
import { Composer } from '@/components/chat/Composer';
import { CollaborativeWorkstate } from '@/components/CollaborativeWorkstate';
import { ModelStatusChips } from '@/components/ModelStatusChips';
import { Skeleton } from '@/components/ui/Skeleton';
import { QuickActions } from '@/components/home/QuickActions';
import { NeedsYouPane } from '@/components/home/NeedsYouPane';
import { WhileAwayPane } from '@/components/home/WhileAwayPane';
import { ProjectsPane } from '@/components/home/ProjectsPane';
import { MadePane } from '@/components/home/MadePane';
import { HomeNotice, SectionHeader, type HomeNoticeState } from '@/components/home/HomeSection';
import { awayCounts, presenceLine, silentImmediatePanes, staleSuffix, workLine, type HomeFeedItem } from '@/components/home/home-model';

const OPEN_THREAD_TIMEOUT_MS = 30_000;

export function Home() {
  const [params] = useSearchParams();
  const mockFlag = params.get('mock');
  const mockScreen = params.get('screen');
  if (mockFlag !== null || isHomeMockScreen(mockScreen)) {
    return (
      <Suspense fallback={<div className="p-8"><Skeleton className="h-64 w-full" /></div>}>
        <HomeMock initialScreen={mockFlag || mockScreen || undefined} embedded />
      </Suspense>
    );
  }
  return <LiveHome />;
}

function LiveHome() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const layout = useHomeLayout();
  const [building, setBuilding] = useState(false);
  const prefsQuery = useHomePreferences();
  const prefs = prefsQuery.data ?? DEFAULT_HOME_PREFERENCES;

  const cc = usePoll(['command-center'], () => apiGet<CommandCenter>('/api/console/home/command-center'), 6000);
  // Shared with the shell's badge; Home reads it only for the one-line summary
  // of Clem's work (the board owns the detail).
  const workingNow = usePoll(['working-now-badge'], listWorkingNowSnapshot, 12_000);
  const spaces = usePoll(['spaces'], listSpaces, 60_000);
  const userContext = usePoll(['user-context'], getContext, 300_000);
  const builds = useHomeBuilds({
    spaces: spaces.data,
    spacesUpdatedAt: spaces.dataUpdatedAt,
    refetchSpaces: () => { void spaces.refetch(); },
    layout: layout.data,
  });

  const needsYou = (cc.data?.needsYou ?? []) as HomeFeedItem[];
  const recent = (cc.data?.recentCompleted ?? []) as HomeFeedItem[];
  const workingView = presentWorkingNow(workingNow.data?.entries ?? [], workingNow.data?.observedAt ?? '');
  const away = awayCounts(recent);

  const chat = useChat({ rememberAsLastSession: true });
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const openTimerRef = useRef<number | null>(null);
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState<HomeNoticeState | null>(null);

  useEffect(() => () => {
    if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current);
  }, []);

  const sendAndOpen = useCallback((input: { text: string; attachmentIds: string[]; attachmentNames: string[] }) => {
    if (chat.busy || opening) return;
    setNotice(null);
    setOpening(true);
    void chat.send(input);
    const started = Date.now();
    const tick = () => {
      const id = chat.sessionId.current;
      if (id) {
        navigate(`/chat/${encodeURIComponent(unifiedChatSessionId(id))}`);
        return;
      }
      if (Date.now() - started > OPEN_THREAD_TIMEOUT_MS) {
        setOpening(false);
        return;
      }
      openTimerRef.current = window.setTimeout(tick, 100);
    };
    tick();
  }, [chat, navigate, opening]);

  useEffect(() => {
    if (!opening || chat.busy || chat.sessionId.current) return;
    const failed = [...chat.messages].reverse().find((m) => m.role === 'assistant' && m.status === 'failed');
    if (!failed) return;
    if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current);
    setOpening(false);
    setNotice({ tone: 'error', text: failed.text || 'That didn’t send. Try again.' });
    chat.reset();
  }, [opening, chat]);

  const ccLoading = cc.isLoading;
  const ccError = cc.isError && !cc.data;
  // Every section on this screen is fed by the same daemon. When both shared
  // sources fail at once that is one unreachable Clementine, said once.
  const daemonUnreachable = ccError && workingNow.isError && !workingNow.data;
  const retryCommandCenter = () => { void cc.refetch(); };

  const panes = visiblePanes(prefs);
  const shown = (id: HomePaneId) => panes.includes(id);
  const immediateSettled = !cc.isLoading && !cc.isError
    && !workingNow.isLoading && !(workingNow.isError && !workingNow.data);
  // The one needs-you number (the sidebar's, the phone's); the list below it
  // may show fewer rows than it counts, never a different number.
  const needsYouTotal = typeof cc.data?.counts?.waiting === 'number'
    ? Math.max(cc.data.counts.waiting, needsYou.length)
    : needsYou.length;
  const silent = new Set(silentImmediatePanes({
    needsYou: needsYouTotal,
    running: workingView.running,
    updates: away.updates,
    attention: away.attention,
    settled: immediateSettled,
    workRows: workingView.total,
  }));
  const railNeeds = !daemonUnreachable && shown('needs_you') && !silent.has('needs_you');
  const railRecent = !daemonUnreachable && shown('while_away') && !silent.has('while_away');
  const hasRail = railNeeds || railRecent;
  // What sits below the main grid, in the owner's order. Quick actions live
  // under the composer; the board owns running work.
  const lowerPanes = panes.filter((id) => id === 'made' || id === 'projects' || id === 'workstate');

  const tiles = layout.data
    ? [...layout.data.tiles.filter((t) => t.zone === 'now'), ...layout.data.tiles.filter((t) => t.zone !== 'now')]
    : [];
  const liveBuilds = builds.builds;
  const onHome = (spaceId: string) => Boolean(layout.data?.tiles.some((t) => t.spaceId === spaceId));
  const addToHome = (spaceId: string) => {
    if (!layout.data) return;
    void changeHomeLayout({ operation: 'pin', space_id: spaceId, expected_revision: layout.data.revision })
      .then((next) => qc.setQueryData(HOME_LAYOUT_KEY, next))
      .catch((err: unknown) => setNotice({ tone: 'error', text: err instanceof Error ? err.message : 'Couldn’t add it to your Home.' }));
  };

  // Nothing placed, nothing building, nothing to answer, nothing chosen below
  // — and we actually KNOW that, rather than having failed to ask.
  const homeIsBare = immediateSettled && !daemonUnreachable && !layout.isLoading && Boolean(layout.data)
    && tiles.length === 0 && liveBuilds.length === 0 && !hasRail && lowerPanes.length === 0;

  const greeting = timeGreeting(new Date().getHours(), greetingName(userContext.data?.profile));
  // The presence line speaks for BOTH sources, so it may only speak once both
  // have answered — unknown is not zero — and a cached reading says its age.
  const servingCached = (cc.isError && Boolean(cc.data)) || (workingNow.isError && Boolean(workingNow.data));
  const oldestReading = Math.min(
    cc.dataUpdatedAt || Number.POSITIVE_INFINITY,
    workingNow.dataUpdatedAt || Number.POSITIVE_INFINITY,
  );
  const presence = ccError || (workingNow.isError && !workingNow.data)
    ? 'Live work status is unavailable.'
    : !immediateSettled && !servingCached
    ? null
    : presenceLine({
        needsYou: needsYouTotal,
        running: 0,
        updates: away.updates,
        attention: away.attention,
      }) + staleSuffix({
        updatedAtMs: Number.isFinite(oldestReading) ? oldestReading : 0,
        nowMs: Date.now(),
        live: !servingCached,
      });
  const work = immediateSettled || servingCached ? workLine(workingView) : null;

  const tileWidth = (tile: HomeTile) => tile.width === 'wide'
    ? 'col-span-12'
    : tile.width === 'small' ? 'col-span-12 sm:col-span-6 2xl:col-span-4' : 'col-span-12 2xl:col-span-6';

  const renderLower = (id: HomePaneId): ReactNode => {
    switch (id) {
      case 'made':
        return <MadePane key={id} headingId="home-made" />;
      case 'projects':
        return (
          <ProjectsPane
            key={id}
            headingId="home-projects"
            spaces={(spaces.data ?? []).filter((s) => !onHome(s.id))}
            loading={spaces.isLoading}
            error={spaces.isError && !spaces.data}
            onRetry={() => { void spaces.refetch(); }}
          />
        );
      case 'workstate':
        return (
          <section key={id} aria-labelledby="home-workstate" className="flex flex-col gap-2.5">
            <SectionHeader id="home-workstate" label="Working together" />
            <CollaborativeWorkstate snapshot={cc.data?.focus} compact />
            <ModelStatusChips />
          </section>
        );
      default:
        return null;
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[1240px] flex-col gap-7 px-5 py-6 animate-fade-in sm:px-10 sm:py-8">
      <section className="flex flex-col gap-4" aria-label="Ask Clementine">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-h1 text-fg text-balance">{greeting}</h1>
            {presence === null
              ? <Skeleton className="h-4 w-64" />
              : (
                <p className="text-body text-muted" aria-live="polite">
                  {presence}
                  {work && (
                    <>
                      {' · '}
                      <Link to="/tasks" className="font-medium text-fg underline decoration-border-strong underline-offset-4 hover:decoration-primary">{work}</Link>
                    </>
                  )}
                </p>
              )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" disabled={!layout.data} onClick={() => setBuilding(true)}><Plus className="h-4 w-4" aria-hidden /> Build home</Button>
            <Button variant="ghost" size="sm" onClick={openCustomizeHome}><SlidersHorizontal className="h-4 w-4" aria-hidden /> Tune</Button>
          </div>
        </div>
        <Composer
          inputRef={composerRef}
          busy={chat.busy || opening}
          mode={chat.composerMode}
          onModeChange={chat.setComposerMode}
          onSend={sendAndOpen}
          onStop={chat.stop}
        />
        {shown('quick_actions') && (
          <QuickActions
            actions={prefs.quickActions}
            disabled={opening || chat.busy}
            onPrompt={(text) => sendAndOpen({ text, attachmentIds: [], attachmentNames: [] })}
          />
        )}
        {opening && !notice && (
          <p role="status" className="text-small text-faint">Opening your conversation…</p>
        )}
        {notice && <HomeNotice notice={notice} onDismiss={() => setNotice(null)} />}
      </section>

      {daemonUnreachable && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-md border border-warning/30 bg-warning-tint px-4 py-3 text-small text-fg">
          <span className="min-w-0 flex-1">Clementine isn’t responding, so what needs you and Clem’s work can’t be read right now.</span>
          <Button size="sm" variant="secondary" onClick={() => { retryCommandCenter(); void workingNow.refetch(); }}>Try again</Button>
        </div>
      )}
      {layout.isError && <div role="alert" className="flex items-center gap-3 rounded-md border border-warning/30 p-3 text-small text-muted">
        <span>Couldn’t load your Home layout. {layout.data ? 'Your last saved tiles are shown.' : 'Your saved layout has not been changed.'}</span>
        <Button size="sm" variant="ghost" onClick={() => { void layout.refetch(); }}>Retry</Button>
      </div>}

      {homeIsBare ? (
        /* The blank canvas. One invitation, centred. */
        <section className="flex flex-col items-center gap-4 px-4 py-12 text-center" aria-label="Build your Home">
          <h2 className="text-h2 text-fg text-balance">Make this Home yours</h2>
          <p className="reading max-w-[52ch] text-body text-muted">
            Place what you want to see every time you sit down — your calendar, the accounts you follow,
            a report Clem keeps current. Nothing lives here until you put it here.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button onClick={() => setBuilding(true)} disabled={!layout.data}>Build home</Button>
            <Button variant="secondary" onClick={() => composerRef.current?.focus()}>Ask Clem</Button>
          </div>
        </section>
      ) : (
        <div className={hasRail
          ? 'grid grid-cols-1 items-start gap-7 xl:grid-cols-[minmax(0,1fr)_minmax(320px,380px)] xl:grid-rows-[auto_1fr] xl:gap-x-8'
          : 'grid grid-cols-1 gap-7'}
        >
          {railNeeds && (
            <div className="xl:col-start-2 xl:row-start-1">
              <NeedsYouPane
                headingId="home-needs-you"
                items={needsYou}
                total={cc.data?.counts?.waiting}
                loading={ccLoading}
                error={ccError}
                onRetry={retryCommandCenter}
              />
            </div>
          )}
          <section aria-labelledby="home-spaces" className="flex min-w-0 flex-col gap-3 xl:col-start-1 xl:row-span-2 xl:row-start-1">
            <div className="flex min-h-5 items-center gap-3">
              <h2 id="home-spaces" className="text-small font-semibold text-muted">Your Spaces</h2>
              <Link to="/workspaces" className="ml-auto rounded-sm text-caption font-semibold text-primary hover:underline">All Spaces</Link>
            </div>
            {liveBuilds.map(({ build, state }) => (
              <BuildCard
                key={build.id}
                build={build}
                state={state}
                onHome={state.kind === 'ready' ? onHome(state.space.id) : false}
                onRetry={() => { void builds.retry(build.id).catch((err: unknown) => setNotice({ tone: 'error', text: err instanceof Error ? err.message : 'That didn’t reach Clem.' })); }}
                onDismiss={() => builds.dismiss(build.id)}
                onAddToHome={addToHome}
              />
            ))}
            {layout.isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : tiles.length > 0 && layout.data ? (
              <div className="grid grid-cols-12 items-start gap-5">
                {tiles.map((tile) => <div key={tile.spaceId} className={tileWidth(tile)}><SpaceTile tile={tile} layout={layout.data!} /></div>)}
              </div>
            ) : layout.data && liveBuilds.length === 0 ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-border bg-surface px-4 py-3.5">
                <p className="min-w-0 flex-1 text-body text-muted">Bring a Space here, or tell Clem what you’d like to keep in view.</p>
                <Button size="sm" variant="secondary" onClick={() => setBuilding(true)}><Plus className="h-4 w-4" aria-hidden /> Build home</Button>
              </div>
            ) : null}
          </section>
          {railRecent && (
            <div className="xl:col-start-2 xl:row-start-2">
              <WhileAwayPane
                headingId="home-while-away"
                items={recent}
                loading={ccLoading}
                error={ccError}
                onRetry={retryCommandCenter}
              />
            </div>
          )}
        </div>
      )}

      {!homeIsBare && lowerPanes.length > 0 && (
        <div className="flex flex-col gap-7">{lowerPanes.map(renderLower)}</div>
      )}
      {building && layout.data && (
        <HomeBuilder
          layout={layout.data}
          spaces={spaces.data ?? []}
          spacesUnavailable={spaces.isError && !spaces.data}
          spacesLoading={spaces.isLoading}
          onClose={() => setBuilding(false)}
          startBuild={builds.start}
          submitting={builds.submitting}
        />
      )}
    </div>
  );
}
