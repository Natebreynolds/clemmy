/**
 * Home — the command center. Glanceable: what needs you, what's running,
 * what got done. Chat is a separate door. A send from here hands off to the
 * conversation the moment the daemon acknowledges it.
 */
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
import { awayCounts, presenceLine, type HomeFeedItem } from '@/components/home/home-model';

const OPEN_THREAD_TIMEOUT_MS = 30_000;

export function Home() {
  const navigate = useNavigate();
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
  const panes: ReactNode[] = [];
  for (let i = 0; i < order.length; i += 1) {
    const id = order[i];
    const next = order[i + 1];
    const paired = (id === 'needs_you' && next === 'running') || (id === 'running' && next === 'needs_you');
    if (paired && next) {
      panes.push(
        <div key={`${id}+${next}`} className="grid gap-5 lg:grid-cols-2">
          {renderPane(id)}
          {renderPane(next)}
        </div>,
      );
      i += 1;
      continue;
    }
    panes.push(<Fragment key={id}>{renderPane(id)}</Fragment>);
  }

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
      <section className="flex flex-col gap-3.5" aria-label="Ask Clementine">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-h1 text-fg">{greeting}</h1>
          {presence === null
            ? <Skeleton className="h-4 w-64 self-center" />
            : <p className="text-body text-muted" aria-live="polite">{presence}</p>}
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

      {panes}
    </div>
  );
}
