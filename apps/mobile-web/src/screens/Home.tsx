/**
 * Home — what Clem wants you to know, the moment you open your phone.
 *
 * It opens with an ANSWER, not with a stack of lists at one visual weight.
 * The greeting is an eyebrow; the largest type on the screen is the single
 * most important state, and every word of it comes from home-presentation.ts,
 * where the rules are pure and tested against the owner's own measured
 * numbers. Two of those rules bind this file:
 *
 *  - A count on this screen is the number of rows this screen renders. The
 *    shell's total is only ever named against the screen that can show it.
 *  - "Running" means the server certified the work LIVE. Everything else that
 *    has not ended is unfinished, and is said in the past tense.
 *
 * One home per truth: the Needs-you count is the shell's (ONE source, the
 * inbox summary); running work is the ONE working-now snapshot the shell
 * polls; "While you were away" comes from durable notifications, never
 * inferred from chat prose. The user shapes the window: which panes show
 * and in what order come from HomePreferences, saved on the daemon.
 */
import type { JSX } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  answerInboxQuestion,
  approveApproval,
  approvePlanProposal,
  getReminders,
  listApprovals,
  listInboxNotifications,
  listInboxQuestions,
  listPlanProposals,
  listWorkspaceDestinationChoosers,
  listWorkspaces,
  rejectApproval,
  rejectPlanProposal,
  resolveWorkspaceDestinationChooser,
  runWorkflow,
  type ActivityEntry,
  type ApprovalRow,
  type InboxNotification,
  type InboxQuestion,
  type PlanProposalRow,
  type ReminderItem,
  type WorkspaceDestinationChooser,
  type WorkspaceSummary,
} from '../lib/api';
import { greetingName, timeGreeting } from '../lib/greeting';
import { relativeTime } from '../components/Approvals';
import { PushPrompt } from '../components/PushPrompt';
import { ScreenNotice } from '../components/ScreenNotice';
import { RunControl } from '../components/RunControl';
import { haptic } from '../lib/native-bridge';
import { mobileRunControl, runStatusLabel } from '../lib/running-tasks';
import { presentWorkingNow, type PresentedWorkingNowEntry } from '@clem/chat-engine';
import { useScreenData } from '../lib/use-screen-data';
import { approvalKindLabel, approvalQuestion } from '../lib/inbox-presentation';
import { homeLead, homeNeedsYouPane, homeWorkPane, type NeedsYouPane } from '../lib/home-presentation';
import { phoneVisiblePanes, useHomePreferences, type HomePaneId, type QuickAction } from '../lib/home-prefs';
import { useWorkingNow } from '../lib/working-now';

const POLL_MS = 6_000;
const MAX_NEEDS_ROWS = 3;
const MAX_AWAY_ROWS = 4;
// Every other pane on this screen is capped. This one was not, which is why
// the owner's twenty-one stalled runs were the tallest thing on his phone.
const MAX_WORK_ROWS = 4;
const MAX_QUICK_CHIPS = 3;

interface Props {
  name: string;
  onAsk: (draft: string) => void;
  onOpenInbox: () => void;
  onOpenWorkspace: (id: string) => void;
  /** Open a run's own screen. Every surface that shows running work must be
   *  able to reach it — a row with a pulse and a progress bar that cannot be
   *  opened is a typing indicator, not a work item. */
  onOpenRun: (sessionId: string) => void;
  /** Activity lists the WHOLE working-now projection, so it is the screen a
   *  capped work pane is allowed to name its remainder against. */
  onOpenActivity: () => void;
  onCustomize: () => void;
  needsYouCount: number;
  needsYouCountKnown: boolean;
  /** Whether that count came from a read that actually reached the Mac, and
   *  how old it is if not. The header pill used to be the only thing on the
   *  phone that disclosed this; on Home the pill is suppressed (Home says the
   *  number itself), so the disclosure travels with the number instead. */
  needsYouCountLive: boolean;
  needsYouCountAge: string | null;
}

interface HomeData {
  approvals: ApprovalRow[];
  plans: PlanProposalRow[];
  workspaceChoosers: WorkspaceDestinationChooser[];
  questions: InboxQuestion[];
  notifications: InboxNotification[];
  reminders: ReminderItem[];
  workspaces: WorkspaceSummary[];
}

type Part<T> = { v: T } | { e: unknown } | { skip: true };

async function part<T>(wanted: boolean, work: () => Promise<T>): Promise<Part<T>> {
  if (!wanted) return { skip: true };
  try {
    return { v: await work() };
  } catch (e) {
    return { e };
  }
}

const EMPTY: HomeData = {
  approvals: [], plans: [], workspaceChoosers: [], questions: [], notifications: [], reminders: [], workspaces: [],
};

/** Sort key for the work pane's cap: a person blocking outranks live work,
 *  which outranks a run that has been silent for days. Membership is the
 *  shared presenter's, so this orders rows without re-deciding what they are. */
function workRank(presented: PresentedWorkingNowEntry<ActivityEntry>): number {
  if (presented.membership === 'needs_you') return 0;
  if (presented.membership === 'stalled') return 2;
  return 1;
}

export function Home({
  name, onAsk, onOpenInbox, onOpenWorkspace, onOpenRun, onOpenActivity, onCustomize,
  needsYouCount, needsYouCountKnown, needsYouCountLive, needsYouCountAge,
}: Props) {
  const { prefs } = useHomePreferences();
  const panes = phoneVisiblePanes(prefs);
  const paneSet = new Set<HomePaneId>(panes);
  const wantRef = useRef(paneSet);
  wantRef.current = paneSet;

  // Every section degrades on its own: one failing endpoint must not blank
  // the whole home screen, and a section that failed THIS round keeps its
  // last good rows. Only when everything fails does the screen say so.
  // Hidden panes do not fetch: the user's choice also saves the radio.
  const lastGood = useRef<HomeData>(EMPTY);
  const loadHome = useCallback(async (): Promise<HomeData> => {
    const want = wantRef.current;
    const needs = want.has('needs_you');
    const [a, p, w, q, n, r, s] = await Promise.all([
      part(needs, listApprovals),
      part(needs, listPlanProposals),
      part(needs, listWorkspaceDestinationChoosers),
      part(needs, listInboxQuestions),
      part(want.has('while_away'), () => listInboxNotifications(30)),
      part(want.has('projects'), getReminders),
      part(want.has('projects'), listWorkspaces),
    ]);
    const attempted = [a, p, w, q, n, r, s].filter((res) => !('skip' in res));
    if (attempted.length > 0 && attempted.every((res) => 'e' in res)) throw (attempted[0] as { e: unknown }).e;
    const prev = lastGood.current;
    const merged: HomeData = {
      approvals: 'v' in a ? a.v.approvals.filter((row) => row.status === 'pending') : prev.approvals,
      plans: 'v' in p ? p.v.proposals.filter((row) => row.status === 'pending') : prev.plans,
      workspaceChoosers: 'v' in w ? w.v.choosers : prev.workspaceChoosers,
      questions: 'v' in q ? q.v.questions : prev.questions,
      notifications: 'v' in n ? n.v.notifications : prev.notifications,
      reminders: 'v' in r ? r.v.items : prev.reminders,
      workspaces: 'v' in s ? s.v.workspaces : prev.workspaces,
    };
    lastGood.current = merged;
    return merged;
  }, []);
  const { data, loading, error, offline, refresh } = useScreenData(loadHome, { intervalMs: POLL_MS });
  const { approvals, plans, workspaceChoosers, questions, notifications, reminders, workspaces } = data ?? lastGood.current;

  // The canonical server-owned working-now projection, from the ONE store
  // the shell polls, rendered through the ONE shared presenter the sheet
  // and the desktop also use. The pulse is a certificate: it animates only
  // for entries the server certified live, and elapsed is server-clock.
  const workingNow = useWorkingNow();
  const working = workingNow.data ?? { observedAt: '', entries: [] };
  const workingView = presentWorkingNow(working.entries, working.observedAt);
  // ONE definition of "running" in the app, and it is the shared presenter's
  // three-way membership. Home used to count `p.pulse` — which is
  // `liveness === 'live'` — so a run that started forty seconds ago with no
  // declared lease horizon (liveness 'unknown', membership 'running') landed
  // under a heading reading "Still open" while the Chats chip, reading the
  // same snapshot through `view.running`, said "1 running". Membership is what
  // stops six two-day-old blocked test runs filling a section headed
  // "Running", and re-deriving it here is what made the two disagree.
  const liveNow = workingView.running;
  // Rows a person is BLOCKING. This is a demand and it is the one the shell's
  // Inbox count cannot see: a workflow parked at awaiting_approval never
  // produces an Inbox card, so this must reach the lead on its own.
  const workNeedsYou = workingView.needsYou;
  // Quiet past the stall threshold: started, never ended, nobody waiting.
  const unfinished = workingView.stalled;
  const workPane = homeWorkPane({
    running: liveNow, needsYou: workNeedsYou, unfinished, max: MAX_WORK_ROWS,
  });
  // The cap decides what does NOT get shown, so the order decides what
  // survives it: a row a person is blocking outranks live work, which outranks
  // a run that has been silent for days. Within a group the server's order
  // stands (Array#sort is stable).
  const workRows = workingView.entries.slice()
    .sort((a, b) => workRank(a) - workRank(b))
    .slice(0, workPane.shown);

  // Durable results only. Open decisions live in Needs you; everything that
  // is finished, or was read, is what happened while you were away.
  const awayRows = paneSet.has('while_away')
    ? notifications.filter((row) => row.read || !row.needsAttention).slice(0, MAX_AWAY_ROWS)
    : [];
  const projects = paneSet.has('projects')
    ? workspaces
      .filter((space) => space.onPhone ?? (space.rows ?? 0) > 0)
      .sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt))
      .slice(0, 3)
    : [];
  const upcoming = paneSet.has('projects') ? reminders.slice(0, 3) : [];

  // The decision rows this screen can actually put on the glass. The shell's
  // count is a different number and is never printed as if it were this one.
  const needsItems: NeedsItem[] = paneSet.has('needs_you') ? [
    ...questions.map((row): NeedsItem => ({ key: `question:${row.id}`, kind: 'question', row })),
    ...workspaceChoosers.map((row): NeedsItem => ({ key: `chooser:${row.chooserId}`, kind: 'chooser', row })),
    ...plans.map((row): NeedsItem => ({ key: `plan:${row.id}`, kind: 'plan', row })),
    ...approvals.map((row): NeedsItem => ({ key: `approval:${row.approvalId}`, kind: 'approval', row })),
  ] : [];
  const needsShown = needsItems.slice(0, MAX_NEEDS_ROWS);
  const needsPane = homeNeedsYouPane({
    rendered: needsShown.length,
    counted: needsYouCount,
    countedKnown: needsYouCountKnown,
  });

  const greeting = timeGreeting(new Date().getHours(), greetingName(name));
  const lead = homeLead({
    loading,
    answerableShown: needsShown.length,
    needsYouCount,
    needsYouCountKnown,
    countLive: needsYouCountLive,
    countAge: needsYouCountAge,
    running: liveNow,
    workNeedsYou,
    unfinished,
    workKnown: workingNow.known,
    workPaneShown: paneSet.has('running') && workPane.show,
    awayCount: awayRows.length,
    otherRows: upcoming.length + projects.length,
  });
  // Narrowed here, not in the callback: TypeScript drops a property narrowing
  // the moment it crosses into a closure.
  const leadAction = lead.action;

  const sections: Record<HomePaneId, () => JSX.Element | null> = {
    // No actions saved means no row: the door to adding one is the Customize
    // button at the foot of the screen, which is already there.
    quick_actions: () => (prefs.quickActions.length > 0 ? (
      <QuickActions actions={prefs.quickActions} onAsk={onAsk} />
    ) : null),
    needs_you: () => (needsPane.show ? (
      <NeedsYou
        pane={needsPane}
        items={needsShown}
        onOpenInbox={onOpenInbox}
        onChanged={refresh}
      />
    ) : null),
    running: () => (workPane.show ? (
      <section class="home-section" aria-labelledby="home-running">
        <h2 id="home-running" class="section-head pane-head">{workPane.title}</h2>
        <div class="home-card">
          {workRows.map((p, i) => (
            <RunningRow key={p.entry.runKey} presented={p} index={i} onChanged={workingNow.refresh} onOpenRun={onOpenRun} />
          ))}
          {/* The remainder, named against Activity — the one screen that maps
              the whole projection. Same rule the Needs-you pane obeys. */}
          {workPane.moreLabel ? (
            <button type="button" class="home-row home-row-tap home-row-link" onClick={() => { haptic('light'); onOpenActivity(); }}>
              <span>{workPane.moreLabel}</span>
              <svg class="card-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          ) : null}
        </div>
      </section>
    ) : null),
    while_away: () => (awayRows.length > 0 ? (
      <section class="home-section" aria-labelledby="home-away">
        <h2 id="home-away" class="section-head pane-head">While you were away</h2>
        <div class="home-card">
          {awayRows.map((row) => <AwayRow key={row.id} row={row} />)}
        </div>
      </section>
    ) : null),
    projects: () => (upcoming.length > 0 || projects.length > 0 ? (
      <>
        {upcoming.length > 0 ? (
          <section class="home-section" aria-labelledby="home-upcoming">
            <h2 id="home-upcoming" class="section-head pane-head">Coming up</h2>
            <div class="home-card">
              {upcoming.map((item) => (
                <div key={item.id} class="home-row home-row-static">
                  <span class={`upcoming-dot ${item.kind}`} aria-hidden="true" />
                  <div class="min-w-0">
                    <div class="home-row-title">{item.text}</div>
                    <div class="home-row-note">
                      {item.at ? formatUpcoming(item.at) : 'when the moment comes'}
                      {item.recurring ? ' · repeats' : ''}
                      {item.status === 'blocked' ? ' · waiting on something' : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        {projects.length > 0 ? (
          <section class="home-section" aria-labelledby="home-projects">
            <h2 id="home-projects" class="section-head pane-head">Spaces</h2>
            <div class="home-card">
              {projects.map((space) => (
                <button key={space.id} type="button" class="home-row home-row-tap" onClick={() => { haptic('light'); onOpenWorkspace(space.id); }}>
                  <div class="min-w-0">
                    <div class="home-row-title truncate">{space.title}</div>
                    <div class="home-row-note truncate">
                      {space.objective || (space.rows ? `${space.rows} ${space.rows === 1 ? 'row' : 'rows'}` : `Updated ${relativeTime(space.updatedAt)}`)}
                    </div>
                  </div>
                  <svg class="card-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </>
    ) : null),
    workstate: () => null,
  };

  return (
    <div class="home">
      {/* THE LEAD. The greeting is an eyebrow — it was the largest type on the
          screen and it never told anyone anything. What the phone says first
          is now the answer, and it is the only thing at this weight. */}
      <header class={`home-lead home-lead-${lead.tone} rise`} style={{ '--i': 0 }}>
        {lead.tone === 'clear' ? (
          <img class="home-lead-mark" src="/m/clemmy.png" alt="" width="52" height="52" />
        ) : null}
        <p class="home-lead-eyebrow">{greeting}</p>
        {/* The answer rewrites itself as polls land — from "Catching up…" to
            whatever is true — so it is announced. One live region for the
            whole sentence, its qualifier and its provenance, or a screen
            reader hears the count change and never hears how old it is. */}
        <div class="home-lead-say" aria-live="polite">
          <h2 class="home-lead-head">{lead.headline}</h2>
          {lead.detail ? <p class="home-lead-detail">{lead.detail}</p> : null}
          {/* Never render the confident version of an unknown: when the shell's
              count came off the service-worker shelf, the number is still
              given — with how old it is. */}
          {lead.asOf ? <p class="home-lead-asof">{lead.asOf}</p> : null}
        </div>
        {leadAction ? (
          <button
            type="button"
            class="home-lead-action"
            onClick={() => {
              haptic('light');
              if (leadAction.target === 'activity') onOpenActivity();
              else onOpenInbox();
            }}
          >
            <span>{leadAction.label}</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        ) : null}
      </header>

      <ScreenNotice
        error={error ?? workingNow.error}
        offline={offline || workingNow.offline}
        onRetry={() => { void refresh(); void workingNow.refresh(); }}
        hasData={needsYouCount + workingView.total + awayRows.length + projects.length > 0}
      />

      {panes.map((id) => {
        const rendered = sections[id]();
        return rendered ? <div key={id} class="home-pane rise" style={{ '--i': 1 }}>{rendered}</div> : null;
      })}

      {loading ? <div class="skeleton-stack" aria-hidden="true"><i /><i /><i /></div> : null}

      {/* Housekeeping, not work. It used to sit directly under the greeting as
          the loudest element on the screen — a gradient card above every real
          thing Clem was doing. Enabling push matters, but never more than the
          decision waiting on you. */}
      <PushPrompt />

      <button type="button" class="home-customize" onClick={() => { haptic('light'); onCustomize(); }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" /><path d="M1 14h6M9 8h6M17 16h6" />
        </svg>
        <span>Customize your home</span>
        <svg class="card-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </button>
    </div>
  );
}

// ─── quick actions ──────────────────────────────────────────────────────────

type RunState = 'busy' | 'queued' | 'error';

function QuickActions({ actions, onAsk }: {
  /** Never empty: Home does not mount this pane without saved actions, so the
   *  screen no longer opens with a row whose only content is an invitation. */
  actions: QuickAction[];
  onAsk: (draft: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const timers = useRef<number[]>([]);
  useEffect(() => () => { timers.current.forEach((t) => window.clearTimeout(t)); }, []);

  const trigger = async (action: QuickAction) => {
    if (action.kind === 'prompt') {
      haptic('medium');
      onAsk(action.value);
      return;
    }
    if (runs[action.id] === 'busy') return;
    haptic('medium');
    setRuns((r) => ({ ...r, [action.id]: 'busy' }));
    setNote(null);
    try {
      await runWorkflow(action.value);
      haptic('success');
      setRuns((r) => ({ ...r, [action.id]: 'queued' }));
      setNote({ tone: 'ok', text: `${action.label} is queued. It shows under Running as soon as it starts.` });
      timers.current.push(window.setTimeout(() => {
        setRuns((r) => { const next = { ...r }; delete next[action.id]; return next; });
        setNote((current) => (current?.tone === 'ok' ? null : current));
      }, 4_000));
    } catch (err) {
      haptic('error');
      const e = err as { status?: number; message?: string };
      setRuns((r) => ({ ...r, [action.id]: 'error' }));
      setNote({
        tone: 'error',
        text: e.status === 409 && e.message?.includes('REQUIRES_INPUT')
          ? `${action.label} needs input first — run it from Flows.`
          : e.status === 409 && e.message?.includes('DISABLED')
            ? `${action.label} is disabled. Enable it on your Mac first.`
            : e.message || `Could not start ${action.label}.`,
      });
    }
  };

  const shown = expanded ? actions : actions.slice(0, MAX_QUICK_CHIPS);
  const overflow = actions.length - shown.length;

  return (
    <div class="qa">
      <div class={`qa-row${expanded ? ' expanded' : ''}`} role="group" aria-label="Quick actions">
        {shown.map((action) => {
          const state = runs[action.id];
          return (
            <button
              key={action.id}
              type="button"
              class={`qa-chip${state ? ` qa-${state}` : ''}`}
              disabled={state === 'busy'}
              aria-busy={state === 'busy'}
              onClick={() => void trigger(action)}
            >
              {action.kind === 'workflow' ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z" />
                </svg>
              )}
              <span class="truncate">{state === 'busy' ? 'Starting…' : state === 'queued' ? 'Queued' : action.label}</span>
            </button>
          );
        })}
        {overflow > 0 ? (
          <button type="button" class="qa-chip qa-chip-more" aria-expanded={false} onClick={() => { haptic('light'); setExpanded(true); }}>
            +{overflow}
          </button>
        ) : null}
        {expanded && actions.length > MAX_QUICK_CHIPS ? (
          <button type="button" class="qa-chip qa-chip-more" aria-expanded onClick={() => setExpanded(false)}>Less</button>
        ) : null}
      </div>
      {note ? <p class={`qa-note${note.tone === 'error' ? ' qa-note-error' : ''}`} role="status">{note.text}</p> : null}
    </div>
  );
}

// ─── needs you ──────────────────────────────────────────────────────────────

type NeedsItem =
  | { key: string; kind: 'question'; row: InboxQuestion }
  | { key: string; kind: 'chooser'; row: WorkspaceDestinationChooser }
  | { key: string; kind: 'plan'; row: PlanProposalRow }
  | { key: string; kind: 'approval'; row: ApprovalRow };

function NeedsYou({ pane, items, onOpenInbox, onChanged }: {
  /** Presenter output: the count this pane is allowed to print, and how the
   *  remainder is named. The pane is only mounted when it has rows. */
  pane: NeedsYouPane;
  items: NeedsItem[];
  onOpenInbox: () => void;
  onChanged: () => void | Promise<void>;
}) {
  return (
    <section class="home-section" aria-labelledby="home-needs">
      <h2 id="home-needs" class="section-head pane-head">
        Needs you
        {/* The rows on this card, not the shell's total. A header that claimed
            86 over an empty card is what this whole wave is about. */}
        <span class="section-count">{pane.count}</span>
      </h2>
      <div class="home-card">
        {items.map((item) => <NeedsRow key={item.key} item={item} onOpenInbox={onOpenInbox} onChanged={onChanged} />)}
        <button type="button" class="home-row home-row-tap home-row-link" onClick={() => { haptic('light'); onOpenInbox(); }}>
          <span>{pane.moreLabel}</span>
          <svg class="card-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      </div>
    </section>
  );
}

function NeedsRow({ item, onOpenInbox, onChanged }: {
  item: NeedsItem;
  onOpenInbox: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);

  const act = async (id: string, work: () => Promise<unknown>, done: string) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(id);
    setError(null);
    haptic('medium');
    try {
      await work();
      haptic('success');
      setReceipt(done);
      void onChanged();
    } catch (err) {
      if ((err as { status?: number }).status === 409) {
        haptic('light');
        setReceipt('Already handled');
        void onChanged();
      } else {
        haptic('error');
        setError(err instanceof Error ? err.message : 'That did not go through');
      }
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };

  const openInInbox = (
    <button type="button" class="home-btn" onClick={() => { haptic('light'); onOpenInbox(); }}>Answer in Needs you</button>
  );

  let title = '';
  let note = '';
  let actions: JSX.Element | null = null;

  if (item.kind === 'approval') {
    const row = item.row;
    title = approvalQuestion(row.subject);
    note = `${approvalKindLabel(row.tool)} · ${relativeTime(row.requestedAt)}${row.resourceFingerprint?.warning ? ` · ${row.resourceFingerprint.warning}` : ''}`;
    actions = (
      <>
        <button type="button" class="home-btn home-btn-primary" disabled={busy !== null} onClick={() => void act('approve', () => approveApproval(row.approvalId), 'Approved')}>
          {busy === 'approve' ? 'Approving…' : 'Approve'}
        </button>
        <button type="button" class="home-btn" disabled={busy !== null} onClick={() => void act('reject', () => rejectApproval(row.approvalId), 'Declined')}>
          {busy === 'reject' ? 'Saving…' : 'Decline'}
        </button>
      </>
    );
  } else if (item.kind === 'question') {
    const row = item.row;
    title = row.question;
    note = row.workflowName ?? (row.agentLabel && row.agentLabel !== 'Clem' ? row.agentLabel : row.source === 'workflow' ? 'Workflow' : row.source === 'background_task' ? 'Task' : 'Check-in');
    actions = row.answerable && row.options.length > 0 && row.options.length <= 3 ? (
      <>
        {row.options.map((option) => (
          <button
            key={option}
            type="button"
            class="home-btn"
            disabled={busy !== null}
            onClick={() => void act(option, () => answerInboxQuestion(row.id, option.slice(0, 4_000)), `Answered: ${option}`)}
          >
            {busy === option ? 'Sending…' : option}
          </button>
        ))}
      </>
    ) : openInInbox;
  } else if (item.kind === 'plan') {
    const row = item.row;
    title = `I made a plan for “${row.objective}.”`;
    note = `${row.steps.length} ${row.steps.length === 1 ? 'step' : 'steps'} · ${relativeTime(row.proposedAt)}`;
    actions = row.needsUserInput.length > 0 ? openInInbox : (
      <>
        <button type="button" class="home-btn home-btn-primary" disabled={busy !== null} onClick={() => void act('approve', () => approvePlanProposal(row.id), 'Plan started')}>
          {busy === 'approve' ? 'Starting…' : 'Start this plan'}
        </button>
        <button type="button" class="home-btn" disabled={busy !== null} onClick={() => void act('reject', () => rejectPlanProposal(row.id), 'Plan rejected')}>
          {busy === 'reject' ? 'Saving…' : 'Reject'}
        </button>
      </>
    );
  } else {
    const row = item.row;
    title = 'Where should these records live?';
    note = `Workspace · ${relativeTime(row.createdAt)}`;
    actions = row.choices.length <= 3 ? (
      <>
        {row.choices.map((choice) => (
          <button
            key={choice.choiceId}
            type="button"
            class={`home-btn${choice.kind === 'existing' ? ' home-btn-primary' : ''}`}
            disabled={busy !== null}
            onClick={() => void act(choice.choiceId, () => resolveWorkspaceDestinationChooser(row, choice.choiceId), `Chose ${choice.label}`)}
          >
            {busy === choice.choiceId ? 'Working…' : choice.label}
          </button>
        ))}
      </>
    ) : openInInbox;
  }

  return (
    <div class="home-row home-row-needs" aria-busy={busy !== null}>
      <div class="home-row-title">{title}</div>
      {note ? <div class="home-row-note">{note}</div> : null}
      {receipt ? (
        <div class="home-row-receipt" role="status">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" />
          </svg>
          {receipt}
        </div>
      ) : (
        <div class="home-row-actions">{actions}</div>
      )}
      {error ? <p class="home-row-error" role="alert">{error}</p> : null}
    </div>
  );
}

// ─── running ────────────────────────────────────────────────────────────────

function RunningRow({ presented, index, onChanged, onOpenRun }: {
  presented: PresentedWorkingNowEntry<ActivityEntry>;
  index: number;
  onChanged: () => void | Promise<void>;
  onOpenRun: (sessionId: string) => void;
}) {
  const entry = presented.entry;
  const control = mobileRunControl(entry);
  // Only a harness session has a run screen; a row without one stays static
  // rather than offering a tap that goes nowhere.
  const sessionId = entry.sessionId;
  const progress = entry.progress && entry.progress.total > 0
    ? entry.progress
    : entry.activity && typeof entry.activity.total === 'number' && entry.activity.total > 0
      ? { completed: entry.activity.completed ?? 0, total: entry.activity.total }
      : null;
  const pct = progress ? Math.max(0, Math.min(100, Math.round((progress.completed / progress.total) * 100))) : null;
  // The warn accent means A PERSON IS THE BLOCKER, which is `membership`, not
  // `presentation`: the presenter collapses stalled rows into the same quiet
  // `needs_you` presentation, so reading it here painted a run that has been
  // silent for two days as a question waiting on the owner.
  const waiting = presented.membership === 'needs_you';
  const head = (
    <>
      <div class="home-run-head">
        {/* The pulse is a certificate: it animates only when the server said
            liveness === 'live'. Anything else gets a quiet dot. */}
        {presented.pulse
          ? <span class="pulse-dot" aria-hidden="true" />
          : <span class="running-task-state" style={{ background: waiting ? 'var(--accent-warn)' : 'var(--line-strong)' }} aria-hidden="true" />}
        <span class="home-row-title truncate">{entry.headline || 'Current task'}</span>
        {presented.elapsed ? <span class="home-run-elapsed">{presented.elapsed}</span> : null}
      </div>
      {/* The heading is derived, but the ROW used to speak present tense under
          it: a stalled `reasoning` run printed "Running" and a stalled
          `blocked` run printed "Needs review" under a heading that correctly
          said "Still open". runStatusLabel is the one place that decides, from
          the presenter's own stall verdict and server-derived silence. */}
      <div class="home-row-note">
        {runStatusLabel(presented)}
        {progress ? ` · ${progress.completed} of ${progress.total}` : ''}
      </div>
      {pct !== null ? (
        <div class="home-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <div class="home-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </>
  );
  return (
    <article class={`home-row home-row-static home-run${waiting ? ' home-run-waiting' : ''}`} style={{ '--i': index }}>
      {sessionId ? (
        <button
          type="button"
          class="home-run-open"
          aria-label={`Open ${entry.headline || 'this run'}`}
          onClick={() => onOpenRun(sessionId)}
        >
          {head}
        </button>
      ) : head}
      {control ? (
        <div class="home-run-control">
          <RunControl target={control.target} resumable={control.resumable} onChanged={() => void onChanged()} />
        </div>
      ) : null}
    </article>
  );
}

// ─── while you were away ────────────────────────────────────────────────────

function AwayRow({ row }: { row: InboxNotification }) {
  // Typed fields only: a warning is a notification that needed attention or
  // failed to deliver; never a guess from the prose.
  const warn = row.needsAttention || Boolean(row.deliveryError);
  return (
    <div class="home-row home-row-static home-away">
      {warn ? (
        <svg class="home-away-glyph warn" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" />
        </svg>
      ) : (
        <svg class="home-away-glyph ok" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )}
      <span class="sr-only">{warn ? 'Needs a look. ' : 'Done. '}</span>
      <span class="home-away-text truncate">{row.title || 'Update from Clem'}</span>
      <time class="home-away-time" dateTime={row.createdAt}>{clockOrDay(row.createdAt)}</time>
    </div>
  );
}

function clockOrDay(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const date = new Date(t);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { weekday: 'short' });
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
