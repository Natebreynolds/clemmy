/**
 * Home — what Clem wants you to know, the moment you open your phone.
 *
 * The old first screen was an approvals list, which is empty most of the
 * time: opening your assistant to "Nothing pending" says nothing. This screen
 * answers three questions in priority order — what needs me, what is she
 * doing, what did she promise — and puts asking her one tap away at the top,
 * because talking to your assistant is the point of the app.
 */
import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  getReminders,
  listApprovals,
  listChatSessions,
  listPlanProposals,
  listRecentRuns,
  type ApprovalRow,
  type ChatSession,
  type PlanProposalRow,
  type ReminderItem,
  type RunSummary,
} from '../lib/api';
import { greetingName, timeGreeting } from '../lib/greeting';
import { Decisions, relativeTime } from '../components/Approvals';
import { PushPrompt } from '../components/PushPrompt';
import { REFRESH_EVENT, haptic } from '../lib/native-bridge';
import { RunControl } from '../components/RunControl';

const POLL_MS = 5000;
/** Runs in these states are live work, not history. */
const ACTIVE = new Set(['running', 'queued', 'received', 'awaiting_approval']);

interface Props {
  name: string;
  onAsk: (draft: string) => void;
  onOpenChat: (session: ChatSession) => void;
  onDecisionCount: (n: number) => void;
}

export function Home({ name, onAsk, onOpenChat, onDecisionCount }: Props) {
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [plans, setPlans] = useState<PlanProposalRow[]>([]);
  const [reminders, setReminders] = useState<ReminderItem[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');

  const refresh = useCallback(async () => {
    // Every section degrades on its own: one failing endpoint must not blank
    // the whole home screen.
    const [a, p, r, runsResult, chats] = await Promise.all([
      listApprovals().catch(() => null),
      listPlanProposals().catch(() => null),
      getReminders().catch(() => null),
      listRecentRuns(8).catch(() => null),
      listChatSessions().catch(() => null),
    ]);
    if (a) setApprovals(a.approvals.filter((row) => row.status === 'pending'));
    if (p) setPlans(p.proposals.filter((row) => row.status === 'pending'));
    if (r) setReminders(r.items);
    if (runsResult) setRuns(runsResult.runs);
    if (chats) setSessions(chats.sessions);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    // The shell's pull-to-refresh pulls THIS data, not the page — a reload
    // would throw away scroll position and re-run the whole bootstrap.
    const onPull = () => { void refresh(); };
    window.addEventListener(REFRESH_EVENT, onPull);
    return () => {
      clearInterval(id);
      window.removeEventListener(REFRESH_EVENT, onPull);
    };
  }, [refresh]);

  const decisionCount = approvals.length + plans.length;
  useEffect(() => { onDecisionCount(decisionCount); }, [decisionCount, onDecisionCount]);

  const working = runs.filter((run) => ACTIVE.has(run.status));
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
        <h1>{greeting}</h1>
        <p class="home-status">{statusLine({ decisionCount, working: working.length, loading })}</p>
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

      {decisionCount > 0 ? (
        <section class="home-section">
          <h2 class="section-head">
            Needs you
            <span class="section-count">{decisionCount}</span>
          </h2>
          <Decisions approvals={approvals} plans={plans} onResolved={refresh} />
        </section>
      ) : null}

      {working.length > 0 ? (
        <section class="home-section">
          <h2 class="section-head">Working on it</h2>
          <div class="stack">
            {working.map((run, i) => (
              <article key={run.id} class="card card-live rise" style={{ '--i': i }}>
                <span class="pulse-dot" aria-hidden="true" />
                <div class="min-w-0">
                  <div class="card-title-sm">{run.title || 'Working…'}</div>
                  <div class="card-when">{run.status.replace(/_/g, ' ')} · {relativeTime(run.updatedAt)}</div>
                </div>
                <RunControl target={{ kind: 'run', runId: run.id }} onChanged={refresh} />
              </article>
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

      {!loading && decisionCount === 0 && working.length === 0 && reminders.length === 0 && recentChats.length === 0 ? (
        <div class="empty">
          <img class="empty-mark" src="/m/clemmy.png" alt="" width="72" height="72" />
          <p class="empty-title">All clear</p>
          <p class="empty-body">Nothing needs you and nothing's running. Ask her something above.</p>
        </div>
      ) : null}
    </div>
  );
}

function statusLine({ decisionCount, working, loading }: { decisionCount: number; working: number; loading: boolean }): string {
  if (loading) return 'Catching up…';
  if (decisionCount > 0) {
    const noun = decisionCount === 1 ? 'decision' : 'decisions';
    return working > 0
      ? `${decisionCount} ${noun} for you · ${working} running`
      : `${decisionCount} ${noun} waiting on you`;
  }
  if (working > 0) return working === 1 ? 'Clem is working on something' : `Clem is running ${working} things`;
  return 'Everything is quiet';
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
