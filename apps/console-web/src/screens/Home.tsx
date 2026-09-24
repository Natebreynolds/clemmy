/**
 * Home — the owner's own page, in the style they chose (the Tune panel):
 * Briefing (decisions first, each Space a wide row) or Dashboard (Today,
 * Needs you and what came back side by side, Spaces in a grid). Each Space
 * shows as its summary or its full page, per Space. Clem's running work is one
 * live band under the greeting that leads to the board (/tasks), which owns
 * the detail. A send from here hands off to the conversation the moment the
 * daemon acknowledges it.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import {
  DEFAULT_HOME_PREFERENCES, useHomePreferences, useSaveHomePreferences, visiblePanes,
  type HomePaneId, type HomeSpaceView,
} from '@/lib/home-prefs';
import { effectiveSpaceView, useHomeToday, useSpaceSummaries } from '@/lib/home-data';
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
import { TodayPane } from '@/components/home/TodayPane';
import { LiveStatus } from '@/components/home/LiveStatus';
import { HomeNotice, SectionHeader, type HomeNoticeState } from '@/components/home/HomeSection';
import { awayCounts, presenceLine, silentImmediatePanes, staleSuffix, type HomeFeedItem } from '@/components/home/home-model';
import { cn } from '@/lib/cn';

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
  const savePrefs = useSaveHomePreferences();

  const cc = usePoll(['command-center'], () => apiGet<CommandCenter>('/api/console/home/command-center'), 6000);
  // Shared with the shell's badge; Home reads it for the live band only (the
  // board owns the detail).
  const workingNow = usePoll(['working-now-badge'], listWorkingNowSnapshot, 12_000);
  const spaces = usePoll(['spaces'], listSpaces, 60_000);
  const userContext = usePoll(['user-context'], getContext, 300_000);
  const builds = useHomeBuilds({
    spaces: spaces.data,
    spacesUpdatedAt: spaces.dataUpdatedAt,
    refetchSpaces: () => { void spaces.refetch(); },
    layout: layout.data,
  });

  const panes = visiblePanes(prefs);
  const shown = (id: HomePaneId) => panes.includes(id);
  const today = useHomeToday(shown('today') || prefs.liveStatus !== 'off');

  const needsYou = (cc.data?.needsYou ?? []) as HomeFeedItem[];
  const recent = (cc.data?.recentCompleted ?? []) as HomeFeedItem[];
  const workingView = presentWorkingNow(workingNow.data?.entries ?? [], workingNow.data?.observedAt ?? '');
  const away = awayCounts(recent);

  // Tiles in the owner's order; how each shows is the owner's choice per Space.
  const tiles = useMemo(() => (layout.data
    ? [...layout.data.tiles.filter((t) => t.zone === 'now'), ...layout.data.tiles.filter((t) => t.zone !== 'now')]
    : []), [layout.data]);
  // The owner's choice per Space, else its summary — or its page when it has
  // no summary to give (lib/home-data.ts effectiveSpaceView, shared with Tune).
  const chosenView = (spaceId: string): HomeSpaceView | undefined => prefs.spaceViews?.[spaceId];
  const summaryIds = tiles.filter((t) => chosenView(t.spaceId) !== 'full').map((t) => t.spaceId);
  const summaries = useSpaceSummaries(summaryIds);
  const viewOf = (spaceId: string): HomeSpaceView =>
    effectiveSpaceView(chosenView(spaceId), summaries.data?.find((s) => s.id === spaceId));
  const setView = (spaceId: string, view: HomeSpaceView) => {
    savePrefs.mutate({ spaceViews: { ...(prefs.spaceViews ?? {}), [spaceId]: view } });
  };

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
  // Every section is fed by the same daemon. When both shared sources fail at
  // once that is one unreachable Clementine, said once.
  const daemonUnreachable = ccError && workingNow.isError && !workingNow.data;
  const retryCommandCenter = () => { void cc.refetch(); };

  const immediateSettled = !cc.isLoading && !cc.isError
    && !workingNow.isLoading && !(workingNow.isError && !workingNow.data);
  // The one needs-you number (the sidebar's, the phone's); a list may show
  // fewer rows than it counts, never a different number.
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
  const showNeeds = !daemonUnreachable && shown('needs_you') && !silent.has('needs_you');
  const showRecent = !daemonUnreachable && shown('while_away') && !silent.has('while_away');
  // Today appears once a calendar is connected (or while its read is loading);
  // Tune lists it either way.
  const showToday = !daemonUnreachable && shown('today') && (today.isLoading || today.isError || Boolean(today.data?.connected));
  const lowerPanes = panes.filter((id) => id === 'made' || id === 'projects' || id === 'workstate');
  const liveBuilds = builds.builds;
  const onHome = (spaceId: string) => Boolean(layout.data?.tiles.some((t) => t.spaceId === spaceId));
  const addToHome = (spaceId: string) => {
    if (!layout.data) return;
    void changeHomeLayout({ operation: 'pin', space_id: spaceId, expected_revision: layout.data.revision })
      .then((next) => qc.setQueryData(HOME_LAYOUT_KEY, next))
      .catch((err: unknown) => setNotice({ tone: 'error', text: err instanceof Error ? err.message : 'Couldn’t add it to your Home.' }));
  };

  // Nothing placed, building, waiting or chosen — and we actually KNOW that.
  const homeIsBare = immediateSettled && !daemonUnreachable && !layout.isLoading && Boolean(layout.data)
    && tiles.length === 0 && liveBuilds.length === 0 && !showNeeds && !showRecent && !showToday && lowerPanes.length === 0;

  const greeting = timeGreeting(new Date().getHours(), greetingName(userContext.data?.profile));
  const servingCached = (cc.isError && Boolean(cc.data)) || (workingNow.isError && Boolean(workingNow.data));
  const oldestReading = Math.min(cc.dataUpdatedAt || Number.POSITIVE_INFINITY, workingNow.dataUpdatedAt || Number.POSITIVE_INFINITY);
  const presence = ccError || (workingNow.isError && !workingNow.data)
    ? 'Live work status is unavailable.'
    : !immediateSettled && !servingCached
    ? null
    : presenceLine({ needsYou: needsYouTotal, running: 0, updates: away.updates, attention: away.attention })
      + staleSuffix({ updatedAtMs: Number.isFinite(oldestReading) ? oldestReading : 0, nowMs: Date.now(), live: !servingCached });

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

  const needsPane = (layoutKind: 'list' | 'strip', maxRows: number) => (
    <NeedsYouPane
      headingId="home-needs-you"
      items={needsYou}
      total={cc.data?.counts?.waiting}
      loading={ccLoading}
      error={ccError}
      onRetry={retryCommandCenter}
      layout={layoutKind}
      maxRows={maxRows}
    />
  );
  const todayPane = (
    <TodayPane headingId="home-today" today={today.data} loading={today.isLoading} error={today.isError && !today.data} onRetry={() => { void today.refetch(); }} maxRows={prefs.style === 'briefing' ? 6 : 5} />
  );
  const recentPane = (variant: 'list' | 'timeline') => (
    <WhileAwayPane headingId="home-while-away" items={recent} loading={ccLoading} error={ccError} onRetry={retryCommandCenter} variant={variant} />
  );

  const buildCards = liveBuilds.map(({ build, state }) => (
    <BuildCard
      key={build.id}
      build={build}
      state={state}
      onHome={state.kind === 'ready' ? onHome(state.space.id) : false}
      onRetry={() => { void builds.retry(build.id).catch((err: unknown) => setNotice({ tone: 'error', text: err instanceof Error ? err.message : 'That didn’t reach Clem.' })); }}
      onDismiss={() => builds.dismiss(build.id)}
      onAddToHome={addToHome}
    />
  ));
  const summaryOf = (spaceId: string) => summaries.data?.find((s) => s.id === spaceId);
  const tile = (t: HomeTile, variant: 'tile' | 'row') => (
    <SpaceTile
      tile={t}
      layout={layout.data!}
      view={viewOf(t.spaceId)}
      summary={summaryOf(t.spaceId)}
      summaryLoading={summaries.isLoading}
      onView={(view) => setView(t.spaceId, view)}
      variant={variant}
    />
  );
  const spacesEmpty = layout.data && tiles.length === 0 && liveBuilds.length === 0 ? (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-border bg-surface px-4 py-3.5">
      <p className="min-w-0 flex-1 text-body text-muted">Bring a Space here, or tell Clem what you’d like to keep in view.</p>
      <Button size="sm" variant="secondary" onClick={() => setBuilding(true)}><Plus className="h-4 w-4" aria-hidden /> Build home</Button>
    </div>
  ) : null;
  const spacesHeader = (
    <div className="flex min-h-5 items-center gap-3">
      <h2 id="home-spaces" className="text-small font-semibold text-muted">Your Spaces</h2>
      <Link to="/workspaces" className="ml-auto rounded-sm text-caption font-semibold text-primary hover:underline">All Spaces</Link>
    </div>
  );
  const tileWidth = (t: HomeTile) => t.width === 'wide'
    ? 'col-span-12'
    : t.width === 'small' ? 'col-span-12 md:col-span-6 xl:col-span-4' : 'col-span-12 md:col-span-6';

  const briefing = (
    <>
      {showNeeds && needsPane('strip', 3)}
      <section aria-labelledby="home-spaces" className="flex min-w-0 flex-col gap-3">
        {spacesHeader}
        {buildCards}
        {layout.isLoading ? <Skeleton className="h-40 w-full" />
          : tiles.length > 0 && layout.data ? <div className="flex flex-col gap-4">{tiles.map((t) => <div key={t.spaceId}>{tile(t, 'row')}</div>)}</div>
          : spacesEmpty}
      </section>
      {(showToday || showRecent) && (
        <div className={cn('grid items-start gap-6', showToday && showRecent && 'lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]')}>
          {showToday && todayPane}
          {showRecent && recentPane('timeline')}
        </div>
      )}
    </>
  );

  const top = [showToday && todayPane, showNeeds && needsPane('list', 2), showRecent && recentPane('list')].filter(Boolean) as ReactNode[];
  const dashboard = (
    <>
      {top.length > 0 && (
        <div className={cn('grid items-start gap-5', top.length === 2 && 'lg:grid-cols-2', top.length >= 3 && 'lg:grid-cols-2 xl:grid-cols-3')}>
          {top.map((pane, i) => <div key={i} className="min-w-0">{pane}</div>)}
        </div>
      )}
      <section aria-labelledby="home-spaces" className="flex min-w-0 flex-col gap-3">
        {spacesHeader}
        {buildCards}
        {layout.isLoading ? <Skeleton className="h-40 w-full" />
          : tiles.length > 0 && layout.data ? (
            <div className="grid grid-cols-12 items-start gap-5">
              {tiles.map((t) => <div key={t.spaceId} className={tileWidth(t)}>{tile(t, 'tile')}</div>)}
            </div>
          ) : spacesEmpty}
      </section>
    </>
  );

  return (
    <div className="mx-auto flex w-full max-w-[1240px] flex-col gap-6 px-5 py-6 animate-fade-in sm:px-10 sm:py-8">
      <section className="flex flex-col gap-4" aria-label="Ask Clementine">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-h1 text-fg text-balance">{greeting}</h1>
            {presence === null
              ? <Skeleton className="h-4 w-64" />
              : <p className="text-body text-muted" aria-live="polite">{presence}</p>}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" disabled={!layout.data} onClick={() => setBuilding(true)}><Plus className="h-4 w-4" aria-hidden /> Build home</Button>
            <Button variant="ghost" size="sm" onClick={openCustomizeHome}><SlidersHorizontal className="h-4 w-4" aria-hidden /> Tune</Button>
          </div>
        </div>
        <LiveStatus
          entries={workingView.entries}
          mode={prefs.liveStatus ?? 'animated'}
          nextCheckAt={today.data?.nextCheckAt ?? null}
          unavailable={!immediateSettled && !servingCached}
        />
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
        {opening && !notice && <p role="status" className="text-small text-faint">Opening your conversation…</p>}
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
      {savePrefs.isError && (
        <HomeNotice notice={{ tone: 'error', text: 'That change to your Home didn’t save. Try it again.' }} onDismiss={() => savePrefs.reset()} />
      )}

      {homeIsBare ? (
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
      ) : prefs.style === 'briefing' ? briefing : dashboard}

      {!homeIsBare && lowerPanes.length > 0 && (
        <div className="flex flex-col gap-6">{lowerPanes.map(renderLower)}</div>
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
