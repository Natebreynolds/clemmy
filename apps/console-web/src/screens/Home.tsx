/**
 * Home — the command center. Glanceable: what needs you, what's running,
 * what got done. Chat is a separate door. A send from here hands off to the
 * conversation the moment the daemon acknowledges it.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Plus, SlidersHorizontal } from 'lucide-react';
import { HomeBuilder } from '@/components/home/HomeBuilder';
import { SpaceTile } from '@/components/home/SpaceTile';
import { openCustomizeHome } from '@/components/home/CustomizePanel';
import { useHomeLayout, type HomeTile } from '@/lib/home-layout';
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
import { RunningPane } from '@/components/home/RunningPane';
import { WhileAwayPane } from '@/components/home/WhileAwayPane';
import { ProjectsPane } from '@/components/home/ProjectsPane';
import { MadePane } from '@/components/home/MadePane';
import { HomeNotice, SectionHeader, type HomeNoticeState } from '@/components/home/HomeSection';
import { awayCounts, presenceLine, silentImmediatePanes, staleSuffix, type HomeFeedItem } from '@/components/home/home-model';

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
  const layout = useHomeLayout();
  const [building, setBuilding] = useState(false);
  const prefsQuery = useHomePreferences();
  const prefs = prefsQuery.data ?? DEFAULT_HOME_PREFERENCES;

  const cc = usePoll(['command-center'], () => apiGet<CommandCenter>('/api/console/home/command-center'), 6000);
  const workingNow = usePoll(['working-now-badge'], listWorkingNowSnapshot, 12_000);
  const spaces = usePoll(['spaces'], listSpaces, 60_000);
  const userContext = usePoll(['user-context'], getContext, 300_000);

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
  // Every immediate pane on this screen is fed by the same daemon. When both
  // shared sources fail at once that is not four broken panes, it is one
  // unreachable Clementine — and desktop stacked up to six "Couldn't load…"
  // rows with six Retry buttons to say it. Mobile has said it in one line for
  // a while (ScreenNotice: "Can't reach your Mac right now.").
  const daemonUnreachable = ccError && workingNow.isError && !workingNow.data;
  const retryCommandCenter = () => { void cc.refetch(); };

  const renderPane = (id: HomePaneId): ReactNode => {
    switch (id) {
      case 'quick_actions':
        return (
          <QuickActions
            key={id}
            actions={prefs.quickActions}
            disabled={opening || chat.busy}
            onPrompt={(text) => sendAndOpen({ text, attachmentIds: [], attachmentNames: [] })}
          />
        );
      case 'needs_you':
        return (
          <NeedsYouPane
            key={id}
            headingId="home-needs-you"
            items={needsYou}
            loading={ccLoading}
            error={ccError}
            onRetry={retryCommandCenter}
          />
        );
      case 'running':
        return (
          <RunningPane
            key={id}
            headingId="home-running"
            view={workingView}
            loading={workingNow.isLoading}
            error={workingNow.isError && !workingNow.data}
            onRetry={() => { void workingNow.refetch(); }}
          />
        );
      case 'while_away':
        return (
          <WhileAwayPane
            key={id}
            headingId="home-while-away"
            items={recent}
            loading={ccLoading}
            error={ccError}
            onRetry={retryCommandCenter}
          />
        );
      case 'made':
        return <MadePane key={id} headingId="home-made" />;
      case 'projects':
        return (
          <ProjectsPane
            key={id}
            headingId="home-projects"
            spaces={spaces.data ?? []}
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

  const order = visiblePanes(prefs);
  const tileWidth = (tile: HomeTile) => tile.width === 'wide'
    ? 'col-span-12' : tile.width === 'small' ? 'col-span-12 md:col-span-6 xl:col-span-4' : 'col-span-12 md:col-span-6';
  // A pane earns its card by having something in it; the presence line above
  // already says the quiet case once. Nothing is hidden until every source has
  // actually answered — see silentImmediatePanes.
  const immediateSettled = !cc.isLoading && !cc.isError
    && !workingNow.isLoading && !(workingNow.isError && !workingNow.data);
  const silent = new Set(silentImmediatePanes({
    needsYou: needsYou.length,
    running: workingView.running,
    updates: away.updates,
    attention: away.attention,
    settled: immediateSettled,
    workRows: workingView.total,
  }));
  const IMMEDIATE: HomePaneId[] = ['needs_you', 'running', 'while_away'];
  const immediatePanes = daemonUnreachable
    ? []
    : order.filter(id => IMMEDIATE.includes(id) && !silent.has(id));
  const tilesIn = (zone: HomeTile['zone']) => layout.data?.tiles.filter(tile => tile.zone === zone) ?? [];
  // Projects deliberately does NOT follow the quiet rule. Its empty state is
  // load-bearing: the "New project" link lives inside the pane and renders
  // whether or not there are projects, so collapsing it on an empty list took
  // away the only door on Home for starting your first one. A pane earns its
  // card by having something in it — unless the empty state IS the something.
  const remainingPanes = order.filter(id => !IMMEDIATE.includes(id));
  const watching = tilesIn('watching');
  // Nothing placed, nothing running, nothing to answer — and we actually KNOW
  // that, rather than having failed to ask. This is the state the approved mock
  // calls the blank canvas; live Home only ever had a dashed CTA tucked inside
  // "Watching", which a new owner met at the bottom of four empty cards.
  // ...and nothing the owner put below either. A Home with pinned quick actions
  // or a kept Projects pane is furnished, however quiet the top of it is —
  // swapping those for the onboarding canvas would take away what they chose.
  const homeIsBare = immediateSettled && !daemonUnreachable && !layout.isLoading
    && immediatePanes.length === 0 && tilesIn('now').length === 0 && watching.length === 0
    && remainingPanes.length === 0;

  const greeting = timeGreeting(new Date().getHours(), greetingName(userContext.data?.profile));
  // The presence line speaks for BOTH sources, so it may only speak once both
  // have answered. It used to skeleton only while `ccLoading && workingNow
  // .isLoading` — so with the command centre loaded and working-now still in
  // flight it printed running=0 as fact, stating "Nothing needs you right now."
  // over a run that was very much in progress. Unknown is not zero.
  // Serving a cached count after a failed refresh is honest only if it says so.
  // `immediateSettled` is false while a poll is erroring, so the skeleton covers
  // the no-data case; this covers the other one — data survived, the read did
  // not, and the numbers are older than they look.
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
        needsYou: needsYou.length,
        running: workingView.running,
        updates: away.updates,
        attention: away.attention,
      }) + staleSuffix({
        updatedAtMs: Number.isFinite(oldestReading) ? oldestReading : 0,
        nowMs: Date.now(),
        live: !servingCached,
      });

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-5 py-5 animate-fade-in sm:px-10 sm:py-6">
      <section className="flex flex-col gap-3.5" aria-label="Ask Clementine">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1"><h1 className="text-h1 text-fg">{greeting}</h1>
          {presence === null
            ? <Skeleton className="h-4 w-64 self-center" />
            : <p className="text-body text-muted" aria-live="polite">{presence}</p>}</div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" disabled={!layout.data} onClick={() => setBuilding(true)}><Plus className="h-4 w-4" /> Build home</Button>
            <Button variant="ghost" size="sm" onClick={openCustomizeHome}><SlidersHorizontal className="h-4 w-4" /> Tune</Button>
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
        {opening && !notice && (
          <p role="status" className="text-small text-faint">Opening your conversation…</p>
        )}
        {notice && <HomeNotice notice={notice} onDismiss={() => setNotice(null)} />}
      </section>

      {daemonUnreachable && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-md border border-warning/30 bg-warning-tint px-4 py-3 text-small text-fg">
          <span className="min-w-0 flex-1">Clementine isn’t responding, so what needs you and what’s running can’t be read right now.</span>
          <Button size="sm" variant="secondary" onClick={() => { retryCommandCenter(); void workingNow.refetch(); }}>Try again</Button>
        </div>
      )}
      {layout.isError && <div role="alert" className="flex items-center gap-3 rounded-md border border-warning/30 p-3 text-small text-muted">
        <span>Couldn’t load your Home layout. {layout.data ? 'Your last saved tiles are shown.' : 'Your saved layout has not been changed.'}</span>
        <Button size="sm" variant="ghost" onClick={() => { void layout.refetch(); }}>Retry</Button>
      </div>}
      {(immediatePanes.length > 0 || tilesIn('now').length > 0) && (
      <section className="flex flex-col gap-3" aria-label="Now">
        <p className="text-caption font-semibold uppercase tracking-widest text-faint">Now</p>
        <div className="grid grid-cols-12 items-start gap-5">
          {immediatePanes.map(id => <div key={id} className="col-span-12 lg:col-span-6 xl:col-span-4">{renderPane(id)}</div>)}
          {layout.data && tilesIn('now').map(tile => <div key={tile.spaceId} className={tileWidth(tile)}><SpaceTile tile={tile} layout={layout.data!} /></div>)}
        </div>
      </section>
      )}
      {homeIsBare ? (
        /* The blank canvas. One invitation, centred, instead of a dashed box at
           the bottom of a stack of empty cards. */
        <section className="flex flex-col items-center gap-4 px-4 py-12 text-center" aria-label="Build your Home">
          <h2 className="text-h2 text-fg">Build your command center</h2>
          <p className="reading max-w-[52ch] text-body text-muted">
            Place what you want to see every time you sit down — your calendar, what needs an answer,
            a report Clem keeps current. Nothing lives here until you put it here.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button onClick={() => setBuilding(true)} disabled={!layout.data}>Build home</Button>
            <Button variant="secondary" onClick={() => composerRef.current?.focus()}>Ask Clem</Button>
          </div>
        </section>
      ) : (
      <section className="flex flex-col gap-3" aria-label="Watching">
        <p className="text-caption font-semibold uppercase tracking-widest text-faint">Watching</p>
        {layout.data && watching.length > 0 ? <div className="grid grid-cols-12 items-start gap-5">
          {watching.map(tile => <div key={tile.spaceId} className={tileWidth(tile)}><SpaceTile tile={tile} layout={layout.data!} /></div>)}
        </div> : layout.isLoading ? <Skeleton className="h-28 w-full" /> : layout.data && <div className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-dashed border-border px-5 py-7">
          <div><h2 className="text-h3">Make this Home yours</h2><p className="mt-1 text-body text-muted">Bring a Space here, or ask Clem to build something you want to keep in view.</p></div>
          <Button variant="secondary" onClick={() => setBuilding(true)}>Build home</Button>
        </div>}
      </section>
      )}
      {/* "Now" and "Watching" are labelled; these were not, so the page ran out
          of structure exactly where it got long. */}
      {!homeIsBare && remainingPanes.length > 0 && (
        <section className="flex flex-col gap-3" aria-label="Also on your Home">
          <p className="text-caption font-semibold uppercase tracking-widest text-faint">Also</p>
          <div className="flex flex-col gap-5">{remainingPanes.map(renderPane)}</div>
        </section>
      )}
      {building && layout.data && <HomeBuilder layout={layout.data} spaces={spaces.data ?? []} spacesUnavailable={spaces.isError && !spaces.data} spacesLoading={spaces.isLoading} onClose={() => setBuilding(false)}
        onBuild={text => sendAndOpen({ text, attachmentIds: [], attachmentNames: [] })} />}
    </div>
  );
}
