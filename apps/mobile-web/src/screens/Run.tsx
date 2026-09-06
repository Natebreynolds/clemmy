/**
 * One run, as a thing you can look at.
 *
 * The unit of work in this product is a run, and it used to exist only as a
 * row in a list — a title and a status. Research on agentic products is blunt
 * about the cost of that: sessions with no mid-run visibility were abandoned
 * ~3x as often as sessions with a live progress panel, at identical output
 * quality. Invisible work, not bad work, is what loses people.
 *
 * So this screen answers the three questions a person actually has about work
 * being done on their behalf:
 *   what is happening right now  → the live step, narrated, with elapsed
 *   what did it change out there → receipts for every external write
 *   what did it leave me         → the deliverables it produced
 *
 * The detail is available and scannable, never mandatory: verification has a
 * measured cost, so the default view is decidable in seconds and the full
 * ledger is one tap down.
 */
import { useMemo } from 'preact/hooks';
import {
  foldWriteLedger,
  narrateActivity,
  reduceActivity,
  writeReversibilityLabel,
  writeRowLabel,
  type ActivityItem,
  type HarnessEvent,
} from '@clem/chat-engine';
import { getRun, isActiveRunStatus } from '../lib/api';
import { RunControl } from '../components/RunControl';
import { ScreenNotice } from '../components/ScreenNotice';
import { useScreenData } from '../lib/use-screen-data';

interface Props {
  sessionId: string;
  onBack: () => void;
}

export function Run({ sessionId, onBack }: Props) {
  const { data, loading, error, offline, refresh } = useScreenData(
    () => getRun(sessionId),
    // Live runs are worth polling; a settled one is not.
    { intervalMs: 5_000 },
  );
  const run = data ?? null;
  const live = run ? isActiveRunStatus(run.status) : false;
  /**
   * What changed out there, folded from the events rather than the route's
   * precomputed `receipts`. Two reasons: the events carry `callId`, so a
   * reservation pairs to its own terminal instead of listing the same draft
   * twice; and this is the SAME fold the chat transcript runs, so the run view
   * and the conversation can no longer disagree about what settled.
   */
  const writes = useMemo(
    () => [...foldWriteLedger(run?.events ?? []).values()],
    [run?.events],
  );

  const activity = useMemo(() => {
    if (!run) return [] as ActivityItem[];
    let acc: ActivityItem[] = [];
    for (const event of run.events) {
      acc = reduceActivity(acc, event as HarnessEvent);
    }
    return narrateActivity(acc, { live });
  }, [run, live]);

  const reply = useMemo(() => {
    if (!run) return '';
    for (let i = run.events.length - 1; i >= 0; i -= 1) {
      const event = run.events[i];
      if (event.type === 'conversation_completed') {
        const text = (event.data as { reply?: unknown } | undefined)?.reply;
        if (typeof text === 'string' && text.trim()) return text.trim();
      }
    }
    return '';
  }, [run]);

  return (
    <div class="workflow-detail">
      <div class="chat-header">
        <button class="chat-back" onClick={onBack} aria-label="Back">←</button>
        <div class="chat-title">{run?.title || 'Run'}</div>
      </div>
      <div class="workflow-detail-body">
        {loading && !run ? <div class="skeleton-stack" aria-hidden="true"><i /><i /></div> : null}
        <ScreenNotice error={error} offline={offline} onRetry={() => void refresh()} hasData={Boolean(run)} />

        {run ? (
          <>
            <div class="run-status-row">
              <span class="card-when">
                {/* Status is not a liveness certificate: active reads active,
                    but only the server's liveness may animate a pulse. */}
                {live ? <span class="running-task-state" style={{ background: 'var(--accent)' }} aria-hidden="true" /> : <span class={`status-dot status-${run.status}`} aria-hidden="true" />}
                {run.status.replace(/_/g, ' ')}
                {run.startedAt ? ` · ${elapsed(run.startedAt, run.lastEventAt, live)}` : ''}
              </span>
              {live ? <RunControl target={{ kind: 'run', runId: run.id }} onChanged={() => void refresh()} /> : null}
            </div>

            {/* What it changed in the world. First, because it is the thing a
                person most needs to know and the hardest to take back. */}
            {writes.length > 0 ? (
              <section class="home-section">
                <h2 class="section-head">What changed</h2>
                {writes.map((row) => {
                  const reversibility = writeReversibilityLabel(row);
                  return (
                    <div key={row.callId} class="run-receipt">
                      <div class="run-receipt-what">{writeRowLabel(row)}</div>
                      {reversibility ? <div class="card-when">{reversibility}</div> : null}
                    </div>
                  );
                })}
              </section>
            ) : null}

            {/* What it left behind. */}
            {run.deliverables.length > 0 ? (
              <section class="home-section">
                <h2 class="section-head">What it produced</h2>
                {run.deliverables.map((file, i) => (
                  <div key={i} class="run-receipt">
                    <div class="run-receipt-what">{file.name}</div>
                    {file.dir ? <div class="card-when">in {file.dir}</div> : null}
                    {file.excerpt ? <pre class="run-excerpt">{file.excerpt}</pre> : null}
                  </div>
                ))}
              </section>
            ) : null}

            {reply ? (
              <section class="home-section">
                <h2 class="section-head">What it reported</h2>
                <p class="run-reply">{reply}</p>
              </section>
            ) : null}

            <details class="wf-raw-log" open={live}>
              <summary class="wf-steps-summary">
                {live ? 'Working' : 'How it went'} · {activity.length} {activity.length === 1 ? 'step' : 'steps'}
              </summary>
              <div class="work-detail run-timeline">
                {activity.map((item) => (
                  <div key={item.id} class={`activity-row act-${item.status}`}>
                    {item.status === 'running' ? <span class="act-spinner" aria-label="running" />
                      : item.status === 'failed' ? <span class="act-mark act-fail">✗</span>
                        : item.status === 'interrupted' ? <span class="act-mark act-warn">–</span>
                          : <span class="act-mark act-ok">✓</span>}
                    <span class="act-label">
                      {item.label}
                      {item.repeats && item.repeats > 1 ? <span class="act-repeats">×{item.repeats}</span> : null}
                    </span>
                    {item.detail ? <span class="act-detail">{item.detail}</span> : null}
                  </div>
                ))}
                {activity.length === 0 ? <div class="muted">Nothing recorded yet.</div> : null}
              </div>
            </details>
          </>
        ) : null}
      </div>
    </div>
  );
}


function elapsed(startedAt: number, lastEventAt: number | null, live: boolean): string {
  const end = live ? Date.now() : (lastEventAt ?? Date.now());
  const seconds = Math.max(0, Math.round((end - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
