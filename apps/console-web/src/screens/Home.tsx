import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { HomeNotice, SectionHeader, type HomeNoticeState } from '@/components/home/HomeSection';
import { awayCounts, homeBlocks, homeRows, presenceLine, type HomeBlockId, type HomeFeedItem } from '@/components/home/home-model';

/** How long the home waits for the daemon's 202 before giving up on opening
 *  the thread. The send itself keeps going server-side either way. */
const OPEN_THREAD_TIMEOUT_MS = 30_000;

/**
 * Home — the main window. One truth per pane: the command center's "Needs
 * you", the shared Working-Now presenter's "Running", the durable results
 * feed's "While you were away", the workspace index's "Projects". The user
 * shapes it (pane order, quick actions) through HomePreferences; the screen
 * only renders what those say.
 *
 * The composer is the real chat composer: a send mints or continues the
 * conversation and the thread route takes over the moment the daemon
 * acknowledges it, so there is never a second chat surface to keep in sync.
 * It sits BELOW the work (see homeBlocks): this is an operations console, so
 * the first thing on it is what the employees are doing, not a text box.
 */
export function Home() {
  const navigate = useNavigate();
  const prefsQuery = useHomePreferences();
  const prefs = prefsQuery.data ?? DEFAULT_HOME_PREFERENCES;

  const cc = usePoll(['command-center'], () => apiGet<CommandCenter>('/api/console/home/command-center'), 6000);
  // Same key + fetcher as the shell badge: one request feeds both.
  const workingNow = usePoll(['working-now-badge'], listWorkingNowSnapshot, 12_000);
  const spaces = usePoll(['spaces'], listSpaces, 60_000);
  // The profile changes rarely; a slow poll keeps the greeting personal.
  const userContext = usePoll(['user-context'], getContext, 300_000);

  const needsYou = (cc.data?.needsYou ?? []) as HomeFeedItem[];
  const recent = (cc.data?.recentCompleted ?? []) as HomeFeedItem[];
  const workingView = presentWorkingNow(workingNow.data?.entries ?? [], workingNow.data?.observedAt ?? '');
  const away = awayCounts(recent);

  // ── Composer → thread handoff ────────────────────────────────────────────
  const chat = useChat({ rememberAsLastSession: true });
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const openTimerRef = useRef<number | null>(null);
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState<HomeNoticeState | null>(null);

  useEffect(() => () => {
    if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current);
  }, []);

  const sendAndOpen = useCallback((input: { text: string; attachmentIds?: string[]; attachmentNames?: string[] }) => {
    if (chat.busy || opening) return;
    setNotice(null);
    setOpening(true);
    // Not awaited: send() resolves only when the whole turn finishes. The
    // session id lands the moment the daemon returns its 202 — that is the
    // handoff point, and the thread route reattaches to the live stream.
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

  // A send the daemon refused never mints a session: surface the reason here
  // instead of leaving a silent composer.
  useEffect(() => {
    if (!opening || chat.busy || chat.sessionId.current) return;
    const failed = [...chat.messages].reverse().find((m) => m.role === 'assistant' && m.status === 'failed');
    if (!failed) return;
    if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current);
    setOpening(false);
    setNotice({ tone: 'error', text: failed.text || 'That didn’t send. Try again.' });
    chat.reset();
  }, [opening, chat]);

  // ── Panes ────────────────────────────────────────────────────────────────
  const ccLoading = cc.isLoading;
  const ccError = cc.isError && !cc.data;
  const retryCommandCenter = () => { void cc.refetch(); };

  const renderPane = (id: HomePaneId): ReactNode => {
    switch (id) {
      case 'quick_actions':
        return (
          <QuickActions
            key={id}
            actions={prefs.quickActions}
            disabled={opening || chat.busy}
            onPrompt={(text) => sendAndOpen({ text })}
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

  // The composer is a peer of the panes, not the page's opening statement.
  const renderBlock = (id: HomeBlockId): ReactNode => {
    if (id !== 'composer') return renderPane(id);
    return (
      <section key={id} aria-labelledby="home-ask" className="flex flex-col gap-2.5">
        <SectionHeader id="home-ask" label="Ask Clementine" />
        <Composer
          inputRef={composerRef}
          busy={chat.busy}
          onSend={sendAndOpen}
          onStop={chat.stop}
        />
        {opening && !notice && (
          <p role="status" className="text-small text-faint">Opening your conversation…</p>
        )}
        {notice && <HomeNotice notice={notice} onDismiss={() => setNotice(null)} />}
      </section>
    );
  };

  const rows = homeRows(homeBlocks(visiblePanes(prefs)));

  const greeting = timeGreeting(new Date().getHours(), greetingName(userContext.data?.profile));
  const presence = ccLoading && workingNow.isLoading
    ? null
    : presenceLine({
        needsYou: needsYou.length,
        running: workingView.running,
        done: away.done,
        paused: away.paused,
      });

  return (
    <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-5 px-5 py-5 animate-fade-in sm:px-10 sm:py-6">
      {/* The greeting stays — it is Clementine's, and losing it would cost the
          screen its warmth — but it is a byline now. The headline is the state
          of the work, which is the sentence the owner actually opens this
          window to read. */}
      <header className="flex flex-col gap-0.5">
        <p className="text-small text-muted">{greeting}</p>
        {presence === null
          ? <Skeleton className="mt-1 h-7 w-72" />
          : <h1 className="text-h1 text-fg" aria-live="polite">{presence}</h1>}
      </header>

      {rows.map((row) => (row.length === 1
        ? <Fragment key={row[0]}>{renderBlock(row[0])}</Fragment>
        : (
          <div key={row.join('+')} className="grid gap-5 lg:grid-cols-2">
            {row.map((id) => renderBlock(id))}
          </div>
        )))}
    </div>
  );
}
