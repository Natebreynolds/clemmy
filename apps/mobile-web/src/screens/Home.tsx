/**
 * Home — what Clem wants you to know, the moment you open your phone.
 *
 * The old first screen was an approvals list, which is empty most of the
 * time: opening your assistant to "Nothing pending" says nothing. This screen
 * answers three questions in priority order — what needs me, what is she
 * doing, what did she promise — and puts asking her one tap away at the top,
 * because talking to your assistant is the point of the app.
 */
import { useCallback, useRef, useState } from 'preact/hooks';
import {
  getReminders,
  listApprovals,
  listChatSessions,
  listPlanProposals,
  listRecentRuns,
  listWorkspaceDestinationChoosers,
  type ApprovalRow,
  type ChatSession,
  type PlanProposalRow,
  type ReminderItem,
  type RunSummary,
  type WorkspaceDestinationChooser,
  listWorkingNow,
  type ActivityEntry,
} from '../lib/api';
import { greetingName, timeGreeting } from '../lib/greeting';
import { relativeTime } from '../components/Approvals';
import { PushPrompt } from '../components/PushPrompt';
import { ScreenNotice } from '../components/ScreenNotice';
import { haptic } from '../lib/native-bridge';
import { RunControl } from '../components/RunControl';
import { lifecycleLabel, mobileRunControl } from '../lib/running-tasks';
import { presentWorkingNow, type PresentedWorkingNowEntry } from '@clem/chat-engine';
import { useScreenData } from '../lib/use-screen-data';
import { approvalQuestion } from '../lib/inbox-presentation';
import { homeCanSayAllClear, homeStatusLine } from '../lib/home-presentation';

const POLL_MS = 5000;
interface Props {
  name: string;
  onAsk: (draft: string) => void;
  onOpenChat: (session: ChatSession) => void;
  onOpenInbox: () => void;
  needsYouCount: number;
  needsYouCountKnown: boolean;
}

interface HomeData {
  approvals: ApprovalRow[];
  plans: PlanProposalRow[];
  workspaceChoosers: WorkspaceDestinationChooser[];
  reminders: ReminderItem[];
  runs: RunSummary[];
  sessions: ChatSession[];
  /** The server snapshot WITH its own clock: elapsed is observedAt−startedAt,
   *  never the phone's clock against a server timestamp. */
  working: { observedAt: string; entries: ActivityEntry[] };
  workingKnown: boolean;
}

export function Home({ name, onAsk, onOpenChat, onOpenInbox, needsYouCount, needsYouCountKnown }: Props) {
  const [draft, setDraft] = useState('');
  // Every section degrades on its own: one failing endpoint must not blank
  // the whole home screen, and a section that failed THIS round keeps its
  // last good rows. Only when everything fails does the screen say so.
  const lastGood = useRef<HomeData>({ approvals: [], plans: [], workspaceChoosers: [], reminders: [], runs: [], sessions: [], working: { observedAt: '', entries: [] }, workingKnown: false });
  const loadHome = useCallback(async (): Promise<HomeData> => {
    const [a, p, w, r, runsResult, chats, workingNow] = await Promise.all([
      listApprovals().then((v) => ({ v }), (e) => ({ e })),
      listPlanProposals().then((v) => ({ v }), (e) => ({ e })),
      listWorkspaceDestinationChoosers().then((v) => ({ v }), (e) => ({ e })),
      getReminders().then((v) => ({ v }), (e) => ({ e })),
      listRecentRuns(8).then((v) => ({ v }), (e) => ({ e })),
      listChatSessions().then((v) => ({ v }), (e) => ({ e })),
      listWorkingNow().then((v) => ({ v }), (e) => ({ e })),
    ]);
    const allFailed = [a, p, w, r, runsResult, chats, workingNow].every((res) => 'e' in res);
    if (allFailed) throw (a as { e: unknown }).e;
    const merged: HomeData = {
      approvals: 'v' in a ? a.v.approvals.filter((row) => row.status === 'pending') : lastGood.current.approvals,
      plans: 'v' in p ? p.v.proposals.filter((row) => row.status === 'pending') : lastGood.current.plans,
      workspaceChoosers: 'v' in w ? w.v.choosers : lastGood.current.workspaceChoosers,
      reminders: 'v' in r ? r.v.items : lastGood.current.reminders,
      runs: 'v' in runsResult ? runsResult.v.runs : lastGood.current.runs,
      sessions: 'v' in chats ? chats.v.sessions : lastGood.current.sessions,
      working: 'v' in workingNow ? workingNow.v : lastGood.current.working,
      workingKnown: 'v' in workingNow ? true : lastGood.current.workingKnown,
    };
    lastGood.current = merged;
    return merged;
  }, []);
  const { data, loading, error, offline, refresh } = useScreenData(loadHome, { intervalMs: POLL_MS });
  const { approvals, plans, workspaceChoosers, reminders, sessions, working, workingKnown } = data ?? lastGood.current;

  // The canonical server-owned working-now projection, rendered through the
  // ONE shared presenter the sheet and the desktop also use. The pulse is a
  // certificate: it animates only for entries the server certified
  // liveness === 'live', and elapsed is server-clock, so this section can
  // never show a dead task as alive or a stale age as fresh.
  const workingView = presentWorkingNow(working.entries, working.observedAt);
  // Do not hide current work merely because it needs the user. Some blocked,
  // stale, awaiting, and paused rows have no separate Inbox card yet. Split
  // them visibly here so a zero summary can never manufacture “All clear.”
  const attentionEntries = workingView.entries.filter((row) => row.presentation === 'needs_you');
  const workingEntries = workingView.entries.filter((row) => row.presentation !== 'needs_you');
  const recentChats = sessions.slice(0, 3);
  const greeting = timeGreeting(new Date().getHours(), greetingName(name));

  function submitAsk(event: Event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    haptic('medium');
    setDraft('');
    onAsk(text);
  }

  return (
    <div class="home">
      <header class="home-greet rise" style={{ '--i': 0 }}>
        <h2>{greeting}</h2>
        <p class="home-status">{homeStatusLine({
          decisionCount: needsYouCount,
          decisionCountKnown: needsYouCountKnown,
          currentTaskCountKnown: workingKnown,
          running: workingView.running,
          currentNeedsAttention: workingView.needsYou,
          loading,
        })}</p>
      </header>

      <form class="ask rise" style={{ '--i': 1 }} onSubmit={submitAsk}>
        <input
          class="ask-input"
          value={draft}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          placeholder="Ask Clem anything…"
          aria-label="Ask Clem"
          enterkeyhint="send"
        />
        <button class="ask-send" type="submit" disabled={!draft.trim()} aria-label="Send">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5 12h13" /><path d="m12 5 7 7-7 7" />
          </svg>
        </button>
      </form>

      <PushPrompt />

      <ScreenNotice
        error={error}
        offline={offline}
        onRetry={() => void refresh()}
        hasData={needsYouCount + workingView.total + reminders.length + recentChats.length > 0}
      />

      {needsYouCount > 0 ? (
        <section class="home-section">
          <h2 class="section-head">
            Needs you
            <span class="section-count">{needsYouCount}</span>
          </h2>
          <button class="home-needs-preview" type="button" onClick={onOpenInbox}>
            <img src="/m/clemmy.png" width="36" height="36" alt="" />
            <span class="home-needs-copy">
              <strong>{homeNeedsQuestion({ approvals, plans, workspaceChoosers })}</strong>
              <span>{needsYouCount === 1 ? 'Open it to respond.' : `${needsYouCount} things are waiting for your response.`}</span>
            </span>
            <span class="home-needs-action">Review</span>
          </button>
        </section>
      ) : null}

      {attentionEntries.length > 0 ? (
        <section class="home-section">
          <h2 class="section-head">
            Current work needs attention
            <span class="section-count">{attentionEntries.length}</span>
          </h2>
          <div class="stack">
            {attentionEntries.map((p, i) => (
              <WorkingCard key={p.entry.runKey} presented={p} index={i} onChanged={refresh} />
            ))}
          </div>
        </section>
      ) : null}

      {workingEntries.length > 0 ? (
        <section class="home-section">
          <h2 class="section-head">Working on it</h2>
          <div class="stack">
            {workingEntries.map((p, i) => (
              <WorkingCard key={p.entry.runKey} presented={p} index={i} onChanged={refresh} />
            ))}
          </div>
        </section>
      ) : null}

      {reminders.length > 0 ? (
        <section class="home-section">
          <h2 class="section-head">Coming up</h2>
          <div class="card upcoming-card">
            {reminders.slice(0, 5).map((item) => (
              <div key={item.id} class="upcoming-row">
                <span class={`upcoming-dot ${item.kind}`} aria-hidden="true" />
                <div class="min-w-0">
                  <div class="upcoming-text">{item.text}</div>
                  <div class="card-when">
                    {item.at ? formatUpcoming(item.at) : 'when the moment comes'}
                    {item.recurring ? ' · repeats' : ''}
                    {item.status === 'blocked' ? ' · waiting on something' : ''}
                  </div>
                </div>
              </div>
            ))}
            {reminders.length > 5 ? <div class="upcoming-more">+{reminders.length - 5} more scheduled</div> : null}
          </div>
        </section>
      ) : null}

      {recentChats.length > 0 ? (
        <section class="home-section">
          <h2 class="section-head">Pick up where you left off</h2>
          <div class="stack">
            {recentChats.map((session, i) => (
              <button key={session.id} class="card card-tap rise" style={{ '--i': i }} onClick={() => onOpenChat(session)}>
                <div class="min-w-0">
                  <div class="card-title-sm truncate">{session.title || 'Untitled'}</div>
                  <div class="card-when">{relativeTime(session.updatedAt)}</div>
                </div>
                <svg class="card-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {loading ? <div class="skeleton-stack" aria-hidden="true"><i /><i /><i /></div> : null}

      {homeCanSayAllClear({
        loading,
        needsYouCount,
        needsYouCountKnown,
        currentTaskCount: workingView.total,
        currentTaskCountKnown: workingKnown,
        reminderCount: reminders.length,
        recentChatCount: recentChats.length,
      }) ? (
        <div class="empty">
          <img class="empty-mark" src="/m/clemmy.png" alt="" width="72" height="72" />
          <p class="empty-title">All clear</p>
          <p class="empty-body">Nothing needs you and nothing's running. Ask her something above.</p>
        </div>
      ) : null}
    </div>
  );
}

function homeNeedsQuestion(data: Pick<HomeData, 'approvals' | 'plans' | 'workspaceChoosers'>): string {
  if (data.workspaceChoosers[0]) return 'I need your help choosing where some records should live.';
  if (data.plans[0]) return `I made a plan for “${data.plans[0].objective}.”`;
  if (data.approvals[0]) return approvalQuestion(data.approvals[0].subject);
  return 'I have a question for you.';
}

function WorkingCard({ presented, index, onChanged }: {
  presented: PresentedWorkingNowEntry<ActivityEntry>;
  index: number;
  onChanged: () => void | Promise<void>;
}) {
  const entry = presented.entry;
  const control = mobileRunControl(entry);
  return (
    <article class="card card-live rise" style={{ '--i': index }}>
      {/* The pulse is a certificate: it animates only when the server said
          liveness === 'live'. Anything else gets a quiet dot. */}
      {presented.pulse
        ? <span class="pulse-dot" aria-hidden="true" />
        : <span class="running-task-state" style={{ background: 'var(--line-strong)' }} aria-hidden="true" />}
      <div class="min-w-0">
        <div class="card-title-sm">{entry.headline || 'Current task'}</div>
        <div class="card-when">
          {entry.activity?.text || lifecycleLabel(entry.lifecycle)}
          {presented.elapsed ? ` · ${presented.elapsed}` : ''}
        </div>
      </div>
      {control ? (
        <RunControl target={control.target} resumable={control.resumable} onChanged={onChanged} />
      ) : null}
    </article>
  );
}

function formatUpcoming(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const delta = then - Date.now();
  if (delta <= 0) return 'due now';
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const date = new Date(then);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = Math.floor((then - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  return `${date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}
