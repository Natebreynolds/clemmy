/**
 * WorkLine — how a chat turn shows Clem's work.
 *
 * While she works it is her own sentence about what she is doing (the line
 * she writes before a tool runs, her first words, or the step itself in plain
 * words), one clock, and a card for the step in hand: the app it happens in,
 * what is being done, and the steps behind it on demand. One mark breathes;
 * nothing else moves. When the answer lands it folds to one receipt line
 * ("Worked 18s · read calendar view · created draft") that opens to the same
 * steps. The answer is the page; the work is its footnote.
 *
 * Rows come from the same narration the activity card uses (discovery hidden,
 * repeats folded, attempts merged with outcomes), so the chat and every other
 * surface tell one story. Space builds and background tasks keep the card.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowUpRight, CheckCircle2, ChevronRight, PauseCircle, XCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { ActivityItem } from '@/lib/useChat';
import { MODEL_PHASE_ACTIVITY_ID, friendlyStep, timelineBounds } from '@clem/chat-engine';
import { getComposioToolkits } from '@/lib/connect';
import { BatchRow, useNowTick } from '@/components/chat/ActivityFeed';
import { LiveStepList, StepRow, type StepTimeline } from '@/components/chat/ActivityCard';
import { narrateActivity, settleTerminalActivity, type ActivityTerminalOutcome } from '@/lib/activity-presentation';
import { activityCardHead, clockLabel, groupActivityByParent } from '@/lib/activity-card';

/** "58s" / "1m 12s": how long she worked, in words rather than a stopwatch. */
export function workedFor(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** The folded line's words. The outcome leads when it is not a success, so a
 *  stopped turn never reads like a finished one. */
export function workLineSummary(
  outcome: ActivityTerminalOutcome,
  totalMs: number | undefined,
  steps: number,
  helpers: number,
  /** What was done, in words ("read calendar view"); stands in for the step
   *  count when there are one or two of them. */
  highlights: readonly string[] = [],
): string {
  const worked = workedFor(totalMs);
  const named = highlights.length > 0 && highlights.length <= 2 && highlights.length === steps;
  const parts = [
    outcome === 'failed' ? 'Ran into trouble' : outcome === 'interrupted' ? 'Didn’t finish' : outcome === 'waiting' ? 'Waiting for you' : '',
    worked ? (outcome === 'completed' ? `Worked ${worked}` : `worked ${worked}`) : (outcome === 'completed' ? 'Worked through it' : ''),
    ...(named ? highlights : [steps > 0 ? `${steps} ${steps === 1 ? 'step' : 'steps'}` : '']),
    helpers > 0 ? `${helpers} ${helpers === 1 ? 'helper' : 'helpers'}` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

/** The app a step happens in, by its real logo where the connection catalog
 *  has one, else its initial; a built-in step shows Clem's own mark. */
function AppMark({ app }: { app?: string }) {
  const key = app?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';
  const catalog = useQuery({
    queryKey: ['composio-toolkits'],
    queryFn: getComposioToolkits,
    staleTime: 5 * 60_000,
    enabled: Boolean(key),
  });
  const logo = key
    ? catalog.data?.toolkits?.find((toolkit) => toolkit.slug.toLowerCase().replace(/[^a-z0-9]/g, '') === key)?.logoUrl
    : undefined;
  return (
    <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-[10px] border border-border bg-subtle text-small font-semibold text-muted">
      {logo
        ? <img src={logo} alt="" className="h-5 w-5 object-contain" />
        : key ? app!.charAt(0).toUpperCase() : <span className="h-2 w-2 rounded-full bg-primary" />}
    </span>
  );
}

function OutcomeMark({ outcome }: { outcome: ActivityTerminalOutcome }) {
  if (outcome === 'failed') return <XCircle className="h-4 w-4 shrink-0 text-danger" strokeWidth={2} role="img" aria-label="Failed" />;
  if (outcome === 'interrupted') return <AlertCircle className="h-4 w-4 shrink-0 text-warning" strokeWidth={2} role="img" aria-label="Did not finish" />;
  if (outcome === 'waiting') return <PauseCircle className="h-4 w-4 shrink-0 text-info" strokeWidth={2} role="img" aria-label="Waiting for you" />;
  return <CheckCircle2 className="h-4 w-4 shrink-0 text-success" strokeWidth={2} role="img" aria-label="Completed" />;
}

export function WorkLine({
  items,
  live,
  progress,
  words,
  terminalOutcome,
  traceHref,
  onBackground,
}: {
  items: ActivityItem[];
  live: boolean;
  /** The engine's rolling human line ("Reading your calendar…"). */
  progress?: string;
  /** Clem's own words about what she is doing right now: the sentence she
   *  wrote before a tool ran, or her first words while she works. */
  words?: string;
  terminalOutcome?: ActivityTerminalOutcome;
  traceHref?: string;
  /** Detach the running turn to the background; offered while live. */
  onBackground?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // While live, a turn's tool steps sit under ONE row (owner 09-26: "group a
  // turn's tool steps under one row"); the row opens to the same list, and
  // the choice is remembered so the reader who wants the steps keeps them.
  const [liveOpen, setLiveOpen] = useState<boolean>(() => readLiveStepsOpen());
  const toggleLiveOpen = () => setLiveOpen((value) => { writeLiveStepsOpen(!value); return !value; });
  const now = useNowTick(live);
  const outcome = live ? 'completed' : (terminalOutcome ?? 'interrupted');
  // The model's own phase row ran the whole turn as a second spinner and a
  // second clock; the clock above already says how long she has been at it.
  const work = items.filter((item) => item.id !== MODEL_PHASE_ACTIVITY_ID);
  const view = work.length > 0 ? settleTerminalActivity(narrateActivity(work, { live }), live ? undefined : outcome) : [];
  if (!live && view.length === 0) return null;
  const head = activityCardHead(view, live, now);
  const { top, children } = groupActivityByParent(view);
  const anyRunning = live && view.some((row) => row.status === 'running');
  const current = anyRunning ? head.title : (progress ?? head.title);
  // The timeline window every step bar is drawn against: first start → now
  // while live, → the last settle once done.
  const bounds = timelineBounds(view, live, now);
  const timeline: StepTimeline | undefined = bounds ? { bounds, now, live } : undefined;
  const steps = (
    <LiveStepList live={live}>
      <ol className="ml-[7px] mt-1 list-none border-l border-border py-0.5 pl-4">
        {top.map((a) => (
          a.kind === 'batch'
            ? <BatchRow key={a.id} a={a} now={now} live={live} />
            : (
              <li key={a.id} className="list-none">
                <ol className="list-none p-0"><StepRow a={a} now={now} live={live} timeline={timeline} /></ol>
                {children.get(a.id) && (
                  <ol className="list-none p-0">
                    {children.get(a.id)!.map((c) => <StepRow key={c.id} a={c} now={now} live={live} timeline={timeline} nested />)}
                  </ol>
                )}
              </li>
            )
        ))}
      </ol>
    </LiveStepList>
  );

  if (live) {
    const tools = view.filter((row) => row.kind !== 'check');
    const inHand = [...tools].reverse().find((row) => row.status === 'running') ?? tools[tools.length - 1];
    const step = inHand ? friendlyStep(inHand.label) : null;
    const running = inHand?.status === 'running';
    const said = words?.trim()
      || (inHand && running && step ? step.action : '')
      || (anyRunning ? current : progress)
      || (tools.length > 0 ? 'Working on it' : 'Getting started');
    const clock = head.startedAt !== undefined ? clockLabel(head.startedAt, now) : '';
    const stepCount = top.filter((row) => row.kind !== 'check').length;
    return (
      <section aria-label="What Clem is doing" className="min-w-0">
        <div className="flex items-start gap-3">
          <span className="work-orb mt-[9px] shrink-0" aria-hidden />
          <p role="status" aria-live="polite" className="min-w-0 flex-1 text-body leading-relaxed text-fg">{said}</p>
          {clock && <span className="shrink-0 pt-1 font-mono text-caption tabular-nums text-faint">{clock}</span>}
        </div>
        {inHand && step && (
          <div className="work-reveal ml-5 mt-3 overflow-hidden rounded-[16px] border border-border-raised bg-surface">
            <div className="flex items-center gap-3 px-4 py-3">
              <AppMark app={step.app} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-small font-semibold text-fg">
                  {running ? step.action : step.done}{step.app ? <span className="font-normal text-muted"> · {step.app}</span> : null}
                </div>
                {inHand.detail && <div className="truncate text-caption text-muted">{inHand.detail}</div>}
              </div>
              {running
                ? <span className="shrink-0 text-caption font-medium text-primary">In progress</span>
                : inHand.status === 'failed'
                  ? <XCircle className="h-4 w-4 shrink-0 text-danger" strokeWidth={2} role="img" aria-label="Failed" />
                  : <CheckCircle2 className="h-4 w-4 shrink-0 text-success" strokeWidth={2} role="img" aria-label="Done" />}
            </div>
            {inHand.excerpt && (
              <div className="line-clamp-4 whitespace-pre-wrap border-t border-border bg-subtle px-4 py-2.5 font-mono text-caption leading-relaxed text-muted">{inHand.excerpt}</div>
            )}
            <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-caption text-faint">
              <button
                type="button"
                onClick={toggleLiveOpen}
                aria-expanded={liveOpen}
                className="-ml-1 inline-flex items-center gap-1 rounded-sm px-1 py-0.5 transition-colors duration-fast hover:bg-subtle hover:text-fg"
              >
                <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform duration-base', liveOpen && 'rotate-90')} aria-hidden />
                {stepCount} {stepCount === 1 ? 'step' : 'steps'}
              </button>
              <span className="ml-auto flex items-center gap-3">
                {onBackground && (
                  <button type="button" onClick={onBackground} title="Keeps working, reports back here, and frees the chat" className="transition-colors hover:text-fg">
                    Run in background
                  </button>
                )}
                {traceHref && (
                  <Link to={traceHref} className="inline-flex items-center gap-0.5 transition-colors hover:text-fg">
                    Full trace <ArrowUpRight className="h-3 w-3" aria-hidden />
                  </Link>
                )}
              </span>
            </div>
          </div>
        )}
        {!inHand && onBackground && (
          <div className="ml-5 mt-1.5 text-caption text-faint">
            <button type="button" onClick={onBackground} title="Keeps working, reports back here, and frees the chat" className="transition-colors hover:text-fg">Run in background</button>
          </div>
        )}
        {inHand && liveOpen && <div className="work-reveal ml-5 mt-2">{steps}</div>}
      </section>
    );
  }

  const stepCount = top.filter((row) => row.kind !== 'check').length;
  const highlights = [...new Set(top.filter((row) => row.kind !== 'check')
    .map((row) => friendlyStep(row.label).done)
    .map((done) => done.charAt(0).toLowerCase() + done.slice(1)))];
  return (
    <section aria-label="What Clem did" className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="-ml-1.5 inline-flex max-w-full items-center gap-2 rounded-sm px-1.5 py-1 text-small text-muted transition-colors duration-fast hover:bg-subtle hover:text-fg active:scale-press"
      >
        <OutcomeMark outcome={outcome} />
        <span className="min-w-0 truncate">{workLineSummary(outcome, head.totalMs, stepCount, head.helpers, highlights)}</span>
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-faint transition-transform duration-base', open && 'rotate-90')} aria-hidden />
      </button>
      {open && (
        <div className="work-reveal">
          {steps}
          {traceHref && (
            <Link to={traceHref} className="ml-[23px] mt-1 inline-flex items-center gap-0.5 text-caption text-faint transition-colors hover:text-fg">
              Full trace <ArrowUpRight className="h-3 w-3" aria-hidden />
            </Link>
          )}
        </div>
      )}
    </section>
  );
}

const LIVE_STEPS_OPEN_KEY = 'clem.workline.liveStepsOpen';
/** Open the first time (the steps are the show while a turn runs); after
 *  that, whatever the reader chose. Storage may be unavailable: default open. */
function readLiveStepsOpen(): boolean {
  try {
    const raw = window.localStorage.getItem(LIVE_STEPS_OPEN_KEY);
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
}
function writeLiveStepsOpen(open: boolean): void {
  try { window.localStorage.setItem(LIVE_STEPS_OPEN_KEY, open ? '1' : '0'); } catch { /* per-viewer convenience only */ }
}
