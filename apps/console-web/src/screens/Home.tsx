/**
 * Home — the owner's own page, in the style they chose (the Tune panel):
 * Briefing (decisions first, each Space a wide row) or Dashboard (Today,
 * Needs you and what came back side by side, Spaces in a grid). Each Space
 * shows as its summary or its full page, per Space. The shared header owns
 * live work; Home brings retained watch reports and From Clem into view.
 * A send from here hands off to the conversation the moment the
 * daemon acknowledges it.
 */
import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { DogMark } from '@/components/DogMark';
import { Plus, SlidersHorizontal } from 'lucide-react';
import { HomeBuilder } from '@/components/home/HomeBuilder';
import { SpaceTile } from '@/components/home/SpaceTile';
import { openCustomizeHome } from '@/lib/customize-home';
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
import { moveComposerDraft, newComposerDraftKey } from '@/lib/composer-drafts';
import { useConversationSendScope } from '@/lib/use-conversation-send-scope';
import { unifiedChatSessionId } from '@/lib/last-session';
import { listWorkingNowSnapshot } from '@/lib/activity';
import { presentWorkingNow } from '@/lib/activity-presentation';
import { listSpaces } from '@/lib/spaces';
import type { CommandCenter } from '@/lib/types';
import { Composer, type ComposerSendInput } from '@/components/chat/Composer';
import { useStuck } from '@/lib/use-stuck';
import { cn } from '@/lib/cn';
import { AgentPicker } from '@/components/chat/AgentPicker';
import { useConversationAgent } from '@/lib/conversation-agent';
import { ProjectPicker } from '@/components/chat/ProjectPicker';
import { useConversationProject } from '@/lib/conversation-project';
import { CollaborativeWorkstate } from '@/components/CollaborativeWorkstate';
import { ModelStatusChips } from '@/components/ModelStatusChips';
import { Skeleton } from '@/components/ui/Skeleton';
import { QuickActions } from '@/components/home/QuickActions';
import { NeedsYouPane } from '@/components/home/NeedsYouPane';
import { MissedRunsCard } from '@/components/home/MissedRunsCard';
import { WhileAwayPane } from '@/components/home/WhileAwayPane';
import { ProjectsPane } from '@/components/home/ProjectsPane';
import { MadePane } from '@/components/home/MadePane';
import { TodayPane } from '@/components/home/TodayPane';
import { FromClemPane } from '@/components/home/FromClemPane';
import { HomeWatchLine } from '@/components/home/HomeWatchOverview';
import { buildWatchOverview } from '@/components/home/watch-overview-model';
import { buildHomeContentLayout } from '@/components/home/home-content-layout';
import { isDefaultExploration, quietExplorationIntroductions } from '@/components/home/exploration-home';
import { listWatches } from '@/lib/watches';
import { useFromClem, withoutFromClem } from '@/lib/from-clem';
import { HomeNotice, SectionHeader, type HomeNoticeState } from '@/components/home/HomeSection';
import { DelegatedTaskCard } from '@/components/projects/DelegatedTaskCard';
import { ExplorationNotice } from '@/components/onboarding/ExplorationNotice';
import { explorationDraftStamp } from '@/lib/onboarding-entry';
import { listOpenTasks } from '@/lib/projects';
import { listDelivered } from '@/lib/delivered';
import { getNeedsYouSummary } from '@/lib/inbox';
import { awayCounts, presenceLine, silentImmediatePanes, staleSuffix, type HomeFeedItem } from '@/components/home/home-model';
import '@/components/home/home-presence.css';

export function Home() {
  const [params] = useSearchParams();
  const mockFlag = params.get('mock');
  const mockScreen = params.get('screen');
  const mock = mockFlag !== null || isHomeMockScreen(mockScreen);
  // Today lives inside the fixed-height chat shell. Own its page scroll here;
  // conversation routes keep their independent transcript/composer layout.
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" role="region" aria-label="Today overview" tabIndex={0}>
      {mock ? (
        <Suspense fallback={<div className="p-8"><Skeleton className="h-64 w-full" /></div>}>
          <HomeMock initialScreen={mockFlag || mockScreen || undefined} embedded />
        </Suspense>
      ) : <LiveHome />}
    </div>
  );
}

function LiveHome() {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const layout = useHomeLayout();
  const [building, setBuilding] = useState(false);
  const prefsQuery = useHomePreferences();
  const prefs = prefsQuery.data ?? DEFAULT_HOME_PREFERENCES;
  const savePrefs = useSaveHomePreferences();

  const cc = usePoll(['command-center'], () => apiGet<CommandCenter>('/api/console/home/command-center'), 6000);
  const attention = usePoll(['needs-you-summary'], getNeedsYouSummary, 8_000);
  // Shared with the shell's badge; Home reads it for the live band only (the
  // board owns the detail).
  const workingNow = usePoll(['working-now-badge'], listWorkingNowSnapshot, 12_000);
  // The jobs still moving, as task records: Home draws the same card for each
  // that the chat draws, so an agent at work is a card here and not only a
  // line in the header.
  const openTasks = usePoll(['delegated-tasks', 'open'], () => listOpenTasks(), 12_000);
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
  const defaultExploration = isDefaultExploration(location.pathname, location.state, prefsQuery.data,
    !prefsQuery.isLoading && !prefsQuery.isError && !prefsQuery.isPlaceholderData && !savePrefs.isPending);
  // Share Made's query so verified empty first-use content can yield without
  // adding a second endpoint or fetching it for a returning hidden pane.
  const explorationResults = usePoll(['delivered'], () => listDelivered(24), 30_000,
    { enabled: defaultExploration && shown('made') });
  const today = useHomeToday(shown('today'));
  // What the heartbeats brought the owner leads Home, once; the other lists
  // leave those items out so nothing shows twice.
  const fromClem = useFromClem();
  const watches = usePoll(['watches'], listWatches, 30_000);
  const watchOverview = buildWatchOverview({ watches: watches.data?.watches ?? [],
    state: watches.isError ? 'error' : watches.isLoading ? 'loading' : 'loaded',
    dataUpdatedAt: watches.dataUpdatedAt, nowMs: Date.now() });

  const needsYou = withoutFromClem((cc.data?.needsYou ?? []) as HomeFeedItem[], fromClem.data?.covers);
  const recent = withoutFromClem((cc.data?.recentCompleted ?? []) as HomeFeedItem[], fromClem.data?.covers);
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
  const routeDraftKey = newComposerDraftKey(location.pathname, location.key, explorationDraftStamp(location.pathname, location.state)
    ?? (location.state as { newChat?: number } | null)?.newChat);
  const captureSendScope = useConversationSendScope(routeDraftKey, chat.sessionId);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // The composer stays in reach while the owner scrolls Today (owner
  // 2026-10-18: "the chat bar should stay as the user scrolls").
  const composerSentinel = useRef<HTMLDivElement>(null);
  const composerStuck = useStuck(composerSentinel);
  const openingRef = useRef(false);
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState<HomeNoticeState | null>(null);
  useEffect(() => {
    openingRef.current = false;
    setOpening(false);
  }, [routeDraftKey]);

  // Who answers the first message: Clem, or one of the owner's agents. The
  // same chip the thread composer has (owner 09-26: "I don't have the agent
  // picker on the home page"); a brand-new conversation opens inside the pick.
  const agentChoice = useConversationAgent(null);
  // Which project it opens in, chosen the same way.
  const projectChoice = useConversationProject(null);
  const openAcceptedConversation = useCallback((isCurrentRoute: () => boolean, onAccepted?: () => void) => {
    const id = chat.sessionId.current;
    // Move before clearing the accepted snapshot or navigating. New typing,
    // late uploads and a different selected file follow their actual session.
    if (id) moveComposerDraft(routeDraftKey, `session:${id}`);
    onAccepted?.();
    if (id && isCurrentRoute()) navigate(`/chat/${encodeURIComponent(unifiedChatSessionId(id))}`);
  }, [chat.sessionId, navigate, routeDraftKey]);
  const sendAndOpen = useCallback(async (input: ComposerSendInput) => {
    if (chat.busy || openingRef.current) throw new Error('The previous message is still opening. Your draft is here.');
    const scope = captureSendScope();
    setNotice(null);
    openingRef.current = true;
    setOpening(true);
    try {
      const [addressed, placed] = await Promise.all([
        agentChoice.prepare(chat.sessionId.current, chat.busy),
        projectChoice.prepare(chat.sessionId.current, chat.busy),
      ]);
      scope.assertCurrent();
      await chat.send({ ...input, ...addressed, ...placed,
        onAccepted: () => openAcceptedConversation(scope.isCurrentRoute, input.onAccepted),
      });
    } finally {
      if (scope.isCurrentRoute()) { openingRef.current = false; setOpening(false); }
    }
  }, [agentChoice, projectChoice, chat, captureSendScope, openAcceptedConversation]);
  const retryAndOpen = async (onAccepted?: () => void) => {
    if (chat.busy || openingRef.current) throw new Error('The previous message is still opening. Your draft is here.');
    const scope = captureSendScope();
    openingRef.current = true;
    setOpening(true);
    try {
      await chat.retryPending(() => openAcceptedConversation(scope.isCurrentRoute, onAccepted));
    } finally {
      if (scope.isCurrentRoute()) { openingRef.current = false; setOpening(false); }
    }
  };

  const ccLoading = cc.isLoading;
  const ccError = cc.isError && !cc.data;
  // Every section is fed by the same daemon. When both shared sources fail at
  // once that is one unreachable Clementine, said once.
  const daemonUnreachable = ccError && workingNow.isError && !workingNow.data;
  const retryCommandCenter = () => { void cc.refetch(); };

  const immediateSettled = !cc.isLoading && !cc.isError && Boolean(attention.data)
    && !workingNow.isLoading && !(workingNow.isError && !workingNow.data);
  // The one needs-you number (the sidebar's, the phone's); a list may show
  // fewer rows than it counts, never a different number.
  const needsYouTotal = attention.data?.total ?? 0;
  // Today's lists lead with what Clem brought (owner 2026-10-18: one Needs
  // you, one While you were away). Their numbers: the inbox's, less what
  // Clem's rows already stand for, plus her own.
  const clemRows = fromClem.data?.rows ?? [];
  const clemWaiting = clemRows.filter((row) => row.asks && !row.setup).length;
  const clemUpdates = clemRows.filter((row) => !row.asks && !row.setup).length;
  const todayNeedsTotal = needsYouTotal;
  const silent = new Set(silentImmediatePanes({
    needsYou: needsYouTotal,
    running: workingView.running,
    updates: away.updates,
    attention: away.attention,
    settled: immediateSettled,
    workRows: Math.max(workingView.total, openTasks.data?.length ?? 0),
  }));
  const showNeeds = !daemonUnreachable && shown('needs_you') && (!silent.has('needs_you') || clemWaiting > 0);
  const showRecent = !daemonUnreachable && shown('while_away') && (!silent.has('while_away') || clemUpdates > 0);
  const allOpenTaskRows = openTasks.data ?? [];
  const openTaskRows = allOpenTaskRows.filter(task => task.phase === 'working');
  const showRunning = !daemonUnreachable && shown('running') && openTaskRows.length > 0;
  // The header pill lands on the cards it summarises.
  const focusRunning = new URLSearchParams(location.search).get('focus') === 'running';
  useEffect(() => {
    if (!focusRunning || !showRunning) return;
    document.getElementById('home-running')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focusRunning, showRunning]);
  // Today appears once a calendar is connected (or while its read is loading);
  // Tune lists it either way.
  const showToday = !daemonUnreachable && shown('today') && (today.isLoading || today.isError || Boolean(today.data?.connected));
  const liveBuilds = builds.builds;
  const onHome = (spaceId: string) => Boolean(layout.data?.tiles.some((t) => t.spaceId === spaceId));
  const freshLayout = !layout.isLoading && !layout.isError && Boolean(layout.data);
  const untouchedLayout = freshLayout && layout.data?.revision === 0 && layout.data?.updatedAt === null;
  const quietIntroductions = quietExplorationIntroductions({
    eligible: defaultExploration, nowMs: Date.now(),
    made: { state: explorationResults.isError ? 'error' : explorationResults.isLoading ? 'loading' : 'loaded',
      count: explorationResults.data?.length, updatedAt: explorationResults.dataUpdatedAt },
    projects: { state: spaces.isError ? 'error' : spaces.isLoading ? 'loading' : untouchedLayout ? 'loaded' : 'unconfirmed',
      count: spaces.data?.filter(s => !onHome(s.id)).length, updatedAt: Math.min(spaces.dataUpdatedAt, layout.dataUpdatedAt) },
    spaces: { state: untouchedLayout ? 'loaded' : 'unconfirmed', count: tiles.length + liveBuilds.length, updatedAt: layout.dataUpdatedAt },
    watching: { state: watchOverview.status === 'loaded' ? 'loaded' : 'unconfirmed',
      count: watchOverview.currentCounts?.total, updatedAt: watches.dataUpdatedAt },
  });
  const lowerPanes = panes.filter((id) => id === 'made' && !quietIntroductions.made
    || id === 'projects' && !quietIntroductions.projects || id === 'workstate');
  const addToHome = (spaceId: string) => {
    if (!layout.data) return;
    void changeHomeLayout({ operation: 'pin', space_id: spaceId, expected_revision: layout.data.revision })
      .then((next) => qc.setQueryData(HOME_LAYOUT_KEY, next))
      .catch((err: unknown) => setNotice({ tone: 'error', text: err instanceof Error ? err.message : 'Couldn’t add it to your Home.' }));
  };

  // Nothing placed, building, waiting or chosen — and we actually KNOW that.
  const homeIsBare = !quietIntroductions.spaces && immediateSettled && !daemonUnreachable && !layout.isLoading && Boolean(layout.data)
    && tiles.length === 0 && liveBuilds.length === 0 && !showNeeds && !showRecent && !showToday && !showRunning && lowerPanes.length === 0
    && !(shown('quick_actions') && prefs.quickActions.length > 0);

  const greeting = timeGreeting(new Date().getHours(), greetingName(userContext.data?.profile));
  const servingCached = (cc.isError && Boolean(cc.data)) || (workingNow.isError && Boolean(workingNow.data));
  const oldestReading = Math.min(cc.dataUpdatedAt || Number.POSITIVE_INFINITY, workingNow.dataUpdatedAt || Number.POSITIVE_INFINITY);
  const presence = ccError || (workingNow.isError && !workingNow.data) || attention.isError && !attention.data
    ? 'Live work status is unavailable.'
    : !immediateSettled && !servingCached
    ? null
    : presenceLine({ needsYou: todayNeedsTotal, running: 0, updates: away.updates + clemUpdates, attention: away.attention })
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
      total={needsYouTotal}
      loading={ccLoading}
      error={ccError}
      onRetry={retryCommandCenter}
      layout={layoutKind}
      maxRows={maxRows}
      lead={<>
        <MissedRunsCard />
        <FromClemPane section="waiting" headingId="home-from-clem-waiting" data={fromClem.data} loading={fromClem.isLoading}
          error={fromClem.isError} onRetry={() => { void fromClem.refetch(); }} />
      </>}
      leadCount={clemWaiting > 0 ? 1 : 0}
    />
  );
  const todayPane = (
    <TodayPane headingId="home-today" today={today.data} loading={today.isLoading} error={today.isError && !today.data} onRetry={() => { void today.refetch(); }} maxRows={prefs.style === 'briefing' ? 6 : 5} />
  );
  const runningPane = (
    <section aria-labelledby="home-running" className="flex min-w-0 flex-col gap-2.5">
      <SectionHeader id="home-running" label="Working now" count={openTaskRows.length} countTone="muted"
        aside={<Link to="/tasks" className="font-semibold text-primary hover:underline">All work</Link>} />
      <div className="flex flex-col gap-2">
        {openTaskRows.slice(0, 3).map((task) => (
          <DelegatedTaskCard key={task.taskId} task={task} beside={openTaskRows} compact
            onChanged={() => { void openTasks.refetch(); }} />
        ))}
      </div>
      {openTaskRows.length > 3 && <Link to="/tasks" className="self-start text-small font-semibold text-primary hover:underline">See {openTaskRows.length - 3} more active jobs</Link>}
    </section>
  );
  const recentPane = (variant: 'list' | 'timeline') => (
    <WhileAwayPane headingId="home-while-away" items={recent} loading={ccLoading} error={ccError} onRetry={retryCommandCenter} variant={variant}
      lead={<FromClemPane section="updates" headingId="home-from-clem-updates" data={fromClem.data} loading={fromClem.isLoading}
        error={fromClem.isError} onRetry={() => { void fromClem.refetch(); }} />}
      leadCount={clemUpdates} />
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
      <button type="button" className="ml-auto rounded-sm text-caption font-semibold text-primary hover:underline disabled:opacity-50 cursor-pointer" disabled={!layout.data} onClick={() => setBuilding(true)}>Build</button>
      <Link to="/workspaces" className="rounded-sm text-caption font-semibold text-primary hover:underline">All Spaces</Link>
    </div>
  );
  const tileWidth = (t: HomeTile) => t.width === 'wide'
    ? 'col-span-12'
    : t.width === 'small' ? 'col-span-12 md:col-span-6 xl:col-span-4' : 'col-span-12 md:col-span-6';

  const spacesPane = quietIntroductions.spaces ? null : <section aria-labelledby="home-spaces" className="flex min-w-0 flex-col gap-3">
    {spacesHeader}
    {buildCards}
    {layout.isLoading ? <Skeleton className="h-40 w-full" />
      : tiles.length > 0 && layout.data ? prefs.style === 'briefing'
        ? <div className="flex flex-col gap-4">{tiles.map(t => <div key={t.spaceId}>{tile(t, 'row')}</div>)}</div>
        : <div className="grid grid-cols-12 items-start gap-5">{tiles.map(t => <div key={t.spaceId} className={tileWidth(t)}>{tile(t, 'tile')}</div>)}</div>
        : spacesEmpty}
  </section>;
  const quickActions = shown('quick_actions') && prefs.quickActions.length > 0 ? <QuickActions
    actions={prefs.quickActions} disabled={opening || chat.busy}
    onPrompt={text => { void sendAndOpen({ text, attachmentIds: [], attachmentNames: [] }).catch(error => setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'That didn’t send. Try again.' })); }}
  /> : null;
  const paneContent = new Map<HomePaneId, ReactNode>([
    ['needs_you', showNeeds ? needsPane(prefs.style === 'briefing' ? 'strip' : 'list', prefs.style === 'briefing' ? 3 : 2) : null],
    ['today', showToday ? todayPane : null],
    ['running', showRunning ? runningPane : null],
    ['while_away', showRecent ? recentPane(prefs.style === 'briefing' ? 'timeline' : 'list') : null],
    ['quick_actions', quickActions],
    ...lowerPanes.map(id => [id, renderLower(id)] as [HomePaneId, ReactNode]),
  ]);
  const contentLayout = buildHomeContentLayout(panes.filter(id => Boolean(paneContent.get(id))), prefs.style);

  return (
    // A reading width: Clem's sentences ran 150 characters a line at 1240px.
    <div className="clem-home mx-auto flex w-full max-w-[960px] flex-col gap-7 px-5 py-6 sm:px-9 sm:py-8">
      <ExplorationNotice />
      <section aria-label="Today" className="flex flex-col">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="clem-home-greeting">
            <span aria-hidden><DogMark size={56} /></span>
            <div className="clem-home-greeting-copy"><h1 className="text-h1 text-fg text-balance">{greeting}</h1>
            {presence === null
              ? <Skeleton className="h-4 w-64" />
              : <p className="text-body text-muted" aria-live="polite">{presence}</p>}</div>
          </div>
          <Button variant="ghost" size="sm" onClick={openCustomizeHome} title="Choose what Today shows, and in what order"><SlidersHorizontal className="h-4 w-4" aria-hidden /> Arrange</Button>
        </div>
        {/* When this passes out of view the composer below has pinned. */}
        <div ref={composerSentinel} aria-hidden className="h-0" />
      </section>
      {allOpenTaskRows.length > openTaskRows.length && <Link to="/tasks" className="home-work-resume flex items-center justify-between gap-3 rounded-xl border border-border px-4 py-3 text-small text-muted transition-colors hover:bg-hover hover:text-fg">
        <span>{allOpenTaskRows.length - openTaskRows.length} paused or waiting {allOpenTaskRows.length - openTaskRows.length === 1 ? 'job' : 'jobs'} saved in Work</span>
        <span className="shrink-0 font-semibold text-primary">Review work</span>
      </Link>}
      {/* A direct child of the page column: a sticky element pins only within
          its parent, and this one stays in reach the whole way down. */}
      <section aria-label="Ask Clementine" className={cn('sticky top-0 z-20 -mx-5 -mt-4 bg-canvas px-5 pb-3 pt-3 transition-shadow sm:-mx-10 sm:px-10',
          composerStuck && 'shadow-[0_10px_18px_-14px_rgba(31,27,22,0.35)]')}>
        <Composer
          inputRef={composerRef}
          sessionId={chat.sessionId.current ?? undefined} draftSessionId={chat.conversationSessionId.current}
          busy={chat.busy || opening}
          mode={chat.composerMode}
          onModeChange={chat.setComposerMode}
          onSend={sendAndOpen}
          pendingPost={chat.pendingPost}
          onRetryPending={retryAndOpen}
          onCancelPending={chat.cancelPending}
          onStop={chat.stop}
          voiceMessages={chat.messages}
          agentSlot={<><ProjectPicker value={projectChoice.chosen} onChange={projectChoice.choose} /><AgentPicker value={agentChoice.chosen} onChange={agentChoice.choose} /></>}
          placeholder={agentChoice.chosen ? `Message ${agentChoice.chosen.name}…` : 'What can I help with?'}
          agentId={agentChoice.chosen?.id ?? null}
        />
        {opening && !notice && <p role="status" className="mt-2 text-small text-faint">Opening your conversation…</p>}
        {notice && <div className="mt-2"><HomeNotice notice={notice} onDismiss={() => setNotice(null)} /></div>}
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
      ) : contentLayout.map((block, index) => block.kind === 'spaces'
        ? <Fragment key="spaces">{spacesPane}</Fragment>
        // One reading column (owner 2026-10-18): Needs you and While you were
        // away now carry Clem's own cards, which side by side were cramped.
        : <div key={block.panes.join(':') + index} className="flex min-w-0 flex-col gap-7">{block.panes.map(id => <Fragment key={id}>{paneContent.get(id)}</Fragment>)}</div>)}
      {!daemonUnreachable && !quietIntroductions.watching && <HomeWatchLine overview={watchOverview} refreshing={watches.isFetching} onRetry={() => { void watches.refetch(); }} />}
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
