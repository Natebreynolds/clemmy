import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { appPlaceHref, fromClemSourceName, heartbeatLastCheckWords, heartbeatStateWords, currentProactiveReceipt, proactiveReplySettled, type ProactiveReplyReceipt } from '@clem/chat-engine';
import { Button } from '@/components/ui/Button';
import { decidePlanProposal, markNotificationRead } from '@/lib/inbox';
import { fromClemRunHref, recentPulses, replyFromClem, replyOutcomeText, type FromClem, type FromClemRow } from '@/lib/from-clem';
import { cn } from '@/lib/cn';
import { unifiedChatSessionId } from '@/lib/last-session';
import { agoLabel } from './home-model';
import { AnswerRow } from './NeedsYouPane';
import { LoadFailedLine, PaneCard, PaneRow, RowSkeleton, SectionHeader } from './HomeSection';
import { TapOutcomes, type RecentTap } from './TapOutcome';

interface RowState {
  voiceDigest: string;
  busy?: 'answer' | 'yes' | 'no' | 'done';
  notice?: ProactiveReplyReceipt;
}

/** How many rows each group shows before "Show more" opens the rest in place. */
const WAITING_SHOWN = 5;
const UPDATES_SHOWN = 3;

function pulseNeedsVisibility(pulse: FromClem['pulses'][number]): boolean {
  const state = pulse.presentation?.state;
  const last = pulse.presentation?.lastCheck.state;
  return pulse.availability === 'unavailable' || state === undefined
    || state === 'checking' || state === 'due' || state === 'failed' || state === 'partial' || state === 'unknown'
    || last === 'failed' || last === 'partial' || last === 'unknown';
}

/**
 * From Clem: what Clem's heartbeats brought you, in her words, in two groups.
 * What waits on you comes first, each with the answers she offers as buttons
 * and your own words one tap away; then updates, each cleared with Done. A
 * group longer than a glance opens the rest in place, never on another page.
 * With nothing to say, the pane still shows when each heartbeat last looked,
 * so a quiet Clem reads as a watching one. How often she looks lives in
 * Heartbeats.
 */
export function FromClemPane({
  headingId,
  data,
  loading,
  error,
  onRetry,
  section = 'all',
}: {
  headingId: string;
  data?: FromClem;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  /** Today folds Clem's rows into its own lists (owner 2026-10-18: one
   *  Needs you, one While you were away): `waiting` draws what waits on the
   *  owner (and her offers), `updates` what she brought back, each without a
   *  heading of its own. `all` is the standalone pane. */
  section?: 'all' | 'waiting' | 'updates';
}) {
  const qc = useQueryClient();
  const inFlight = useRef(new Set<string>());
  const [states, setStates] = useState<Record<string, RowState>>({});
  // One reply box open at a time. Drafts outlive closing.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Taps that started work: what came of each shows here, where the owner
  // tapped, instead of only "Started a conversation."
  const [taps, setTaps] = useState<RecentTap[]>([]);
  const dismissTap = (tap: RecentTap) => setTaps((all) => all.filter((each) => each !== tap));
  const [showAll, setShowAll] = useState<{ waiting: boolean; updates: boolean }>({ waiting: false, updates: false });
  const rows = data?.rows ?? [];
  const latestRows = useRef(rows);
  latestRows.current = rows;
  const waiting = rows.filter((row) => row.asks && !row.setup);
  const updates = rows.filter((row) => !row.asks && !row.setup);
  const offers = rows.filter((row) => row.setup);
  const pulses = recentPulses(data?.pulses ?? []);
  const visiblePulses = pulses.filter(pulseNeedsVisibility);
  const quietPulses = pulses.filter(pulse => !pulseNeedsVisibility(pulse));
  const pulseRow = (pulse: FromClem['pulses'][number]) => <li key={pulse.heartbeat}>
    <span className="font-semibold">{pulse.title}</span>
    {' · '}{pulse.availability === 'unavailable' ? 'Status unavailable' : heartbeatStateWords(pulse.presentation)}
    {pulse.presentation?.lastCheck.at ? ` · ${heartbeatLastCheckWords(pulse.presentation)} ${agoLabel(pulse.presentation.lastCheck.at)}` : ''}
    {pulse.summary ? ` — ${pulse.summary}` : ''}
  </li>;
  const pulseHistory = <>
    {visiblePulses.length > 0 && <ul className="flex flex-col gap-1 text-small text-muted">{visiblePulses.map(pulseRow)}</ul>}
    {quietPulses.length > 0 && <details className="text-small text-muted">
      <summary className="min-h-11 cursor-pointer py-2.5 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        Background check history · {quietPulses.length}
      </summary>
      <ul className="flex flex-col gap-1 pb-2">{quietPulses.map(pulseRow)}</ul>
    </details>}
  </>;

  const act = (
    row: FromClemRow,
    busy: NonNullable<RowState['busy']>,
    run: () => Promise<unknown>,
    success: string | ((result: unknown) => { text: string; sessionId?: string; settled?: boolean }),
  ) => {
    if (inFlight.current.has(row.key)) return;
    inFlight.current.add(row.key);
    setStates((all) => ({ ...all, [row.key]: { voiceDigest: row.voiceDigest, busy } }));
    run().then(
      (result) => {
        const said = typeof success === 'string' ? { text: success } : success(result);
        setStates((all) => ({ ...all, [row.key]: { voiceDigest: row.voiceDigest, notice: { tone: said.settled === false ? 'info' : 'success', settled: said.settled !== false, voiceDigest: row.voiceDigest, ...said } } }));
        if (said.settled !== false && latestRows.current.some(current => current.key === row.key && current.voiceDigest === row.voiceDigest)) setOpenKey((key) => (key === row.key ? null : key));
        void qc.invalidateQueries({ queryKey: ['home-from-clem'] });
        void qc.invalidateQueries({ queryKey: ['command-center'] });
      },
    ).catch((err: unknown) => setStates((all) => ({
        ...all,
        [row.key]: { voiceDigest: row.voiceDigest, notice: { voiceDigest: row.voiceDigest, settled: false, tone: 'error', text: err instanceof Error ? err.message : 'That didn’t reach Clem. Your reply is kept; check the item before trying again.' } },
      }))).finally(() => { inFlight.current.delete(row.key); });
  };

  const reply = (row: FromClemRow, text: string, decision?: 'do_it' | 'done' | 'not_now' | 'never', choiceIndex?: number) => {
    const since = new Date().toISOString();
    return act(row, 'answer', () => replyFromClem(row.key, text, row.voiceDigest, decision, choiceIndex), (result) => {
      const outcome = result as Awaited<ReturnType<typeof replyFromClem>>;
      if (outcome.outcome === 'started') {
        setTaps((all) => [{ key: row.key, title: row.say ?? row.text, reply: text, since }, ...all.filter((tap) => tap.key !== row.key)].slice(0, 5));
        return { settled: true, text: 'Clem is on it — see Just now.' };
      }
      return { settled: proactiveReplySettled(outcome.outcome), text: replyOutcomeText(outcome, fromClemSourceName(row)) };
    });
  };

  /** The answers on the row itself: hers when she offered some, else the
   *  record's own (yes/no for a suggestion). */
  const answers = (row: FromClemRow, state: RowState) => {
    const busy = Boolean(state.busy);
    if (row.choices?.length) {
      return row.choices.map((choice, index) => (
        <Button key={choice} size="sm" variant={index === 0 ? 'primary' : 'secondary'} className="h-8 px-3 text-small"
          disabled={busy} onClick={() => reply(row, choice, undefined, index)}>
          {choice}
        </Button>
      ));
    }
    if (row.answer?.kind === 'brain_outage') {
      return [
        <Button key="yes" size="sm" className="h-8 px-3 text-small" disabled={busy} onClick={() => reply(row, 'Yes, switch back', 'do_it')}>
          {state.busy === 'answer' ? 'Sending…' : 'Yes'}
        </Button>,
        <Button key="no" size="sm" variant="secondary" className="h-8 px-3 text-small" disabled={busy} onClick={() => reply(row, 'No, keep the backup', 'done')}>
          No
        </Button>,
      ];
    }
    if (row.answer?.kind === 'yes_no') {
      const id = row.answer.planProposalId;
      return [
        <Button key="yes" size="sm" className="h-8 px-3 text-small" disabled={busy}
          onClick={() => act(row, 'yes', () => decidePlanProposal(id, 'approve'), 'Approved.')}>
          {state.busy === 'yes' ? 'Sending…' : 'Yes'}
        </Button>,
        <Button key="no" size="sm" variant="secondary" className="h-8 px-3 text-small" disabled={busy}
          onClick={() => act(row, 'no', () => decidePlanProposal(id, 'reject'), 'Declined.')}>
          No
        </Button>,
      ];
    }
    return [];
  };

  const notice = (state: RowState) => state.notice && (
    <p role="status" className={cn('text-small', state.notice.tone === 'error' ? 'text-warning' : 'text-muted')}>
      {state.notice.text}
      {state.notice.sessionId && (
        <>{' '}<Link to={`/chat/${encodeURIComponent(unifiedChatSessionId(state.notice.sessionId))}`} className="font-semibold text-primary hover:underline">Open</Link></>
      )}
    </p>
  );

  const meta = (row: FromClemRow) => (
    <span className="flex items-center gap-2 text-caption text-faint">
      <span className="font-semibold text-muted">{fromClemSourceName(row)}</span>
      <span aria-hidden>·</span>
      <span>{agoLabel(row.at)}</span>
      {drafts[row.key]?.trim() && openKey !== row.key && <span className="ml-auto text-muted">Draft saved</span>}
    </span>
  );

  // What the message is about: the record behind it, shown on request.
  const source = (row: FromClemRow) => (row.say ? [row.text, row.detail] : [row.detail]).filter(Boolean).join(' · ');

  const waitingRow = (row: FromClemRow) => {
    const state = currentProactiveReceipt(states[row.key], row.voiceDigest) ?? { voiceDigest: row.voiceDigest };
    const open = openKey === row.key;
    const offered = answers(row, state);
    return (
      <PaneRow key={row.key} className="flex-col items-stretch gap-2 py-3.5">
        {meta(row)}
        <p className="text-body text-fg">{row.say || row.text}</p>
        {open && source(row) && <p className="whitespace-pre-line text-small text-muted">{source(row)}</p>}
        {state.notice && notice(state)}
        {!state.notice?.settled && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {offered}
              <button type="button" aria-expanded={open} onClick={() => setOpenKey(open ? null : row.key)}
                className="rounded-sm px-1 text-small font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                {open ? 'Close' : offered.length > 0 ? 'Reply in your words' : 'Reply'}
              </button>
            </div>
            {open && (
              <AnswerRow
                busy={state.busy === 'answer'}
                placeholder="Reply to Clem…"
                value={drafts[row.key] ?? ''}
                onValueChange={(text) => setDrafts((all) => ({ ...all, [row.key]: text }))}
                autoFocus
                onAnswer={(text) => { if (text.trim()) reply(row, text.trim()); }}
              />
            )}
          </>
        )}
      </PaneRow>
    );
  };

  const updateRow = (row: FromClemRow) => {
    const state = currentProactiveReceipt(states[row.key], row.voiceDigest) ?? { voiceDigest: row.voiceDigest };
    const open = openKey === row.key;
    const done = row.done;
    // A report leads with its title; opened, it reads as she wrote it.
    const report = row.authored === true;
    const runHref = fromClemRunHref(row);
    return (
      <PaneRow key={row.key} className="flex-col items-stretch gap-1.5 py-3.5">
        <button type="button" aria-expanded={open} onClick={() => setOpenKey(open ? null : row.key)}
          className="flex flex-col items-stretch gap-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          {meta(row)}
          {report && <span className="text-body font-semibold text-fg">{row.text}</span>}
          <span className={cn('text-body text-fg', open ? report && 'whitespace-pre-line [overflow-wrap:anywhere]' : 'line-clamp-2')}>{row.say || row.text}</span>
        </button>
        {open && !report && source(row) && <p className="whitespace-pre-line text-small text-muted">{source(row)}</p>}
        {row.handoff && <div className="space-y-1 text-small text-muted">
          <p>{row.handoff.reason || (row.handoff.state === 'dispatched' ? 'The approved task is in its conversation.' : 'This suggestion needs another look before work continues.')}</p>
          <Link to={row.handoff.sessionId ? `/chat/${encodeURIComponent(unifiedChatSessionId(row.handoff.sessionId))}` : `/chat/${encodeURIComponent(unifiedChatSessionId('clem'))}`} className="font-semibold text-primary hover:underline">{row.handoff.sessionId ? 'Open conversation' : 'Ask Clem in chat'}</Link>
        </div>}
        {state.notice && notice(state)}
        {!row.handoff && !state.notice?.settled && (
          <div className="flex flex-wrap items-center gap-2">
            {runHref && (
              <Link to={runHref} className="inline-flex h-8 items-center rounded-md px-1 text-small font-medium text-primary hover:underline">
                Open run
              </Link>
            )}
            {done && (
              <Button size="sm" variant="secondary" className="h-8 px-3 text-small" disabled={Boolean(state.busy)}
                onClick={() => act(row, 'done', () => markNotificationRead(done.notificationId), 'Cleared.')}>
                {state.busy === 'done' ? 'Saving…' : 'Done'}
              </Button>
            )}
            {open ? (
              <AnswerRow
                busy={state.busy === 'answer'}
                placeholder="Tell Clem what to do with it…"
                value={drafts[row.key] ?? ''}
                onValueChange={(text) => setDrafts((all) => ({ ...all, [row.key]: text }))}
                onAnswer={(text) => { if (text.trim()) reply(row, text.trim()); }}
              />
            ) : (
              <button type="button" onClick={() => setOpenKey(row.key)}
                className="rounded-sm px-1 text-small font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                Read more
              </button>
            )}
          </div>
        )}
      </PaneRow>
    );
  };

  // An offer to help set something up: go there, have Clem walk you through
  // it, or move it out of the way.
  const offerRow = (row: FromClemRow) => {
    const state = currentProactiveReceipt(states[row.key], row.voiceDigest) ?? { voiceDigest: row.voiceDigest };
    const href = row.setup ? appPlaceHref(row.setup.place, 'desktop') : null;
    const busy = Boolean(state.busy);
    return (
      <PaneRow key={row.key} className="flex-col items-stretch gap-2 py-3.5">
        <p className="text-body text-fg">{row.say || row.text}</p>
        {!row.say && row.detail && <p className="text-small text-muted">{row.detail}</p>}
        {state.notice && notice(state)}
        {!state.notice?.settled && (
          <div className="flex flex-wrap items-center gap-2">
            {href && row.setup && (
              <Link to={href} className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-small font-semibold text-primary-fg hover:bg-primary-hover active:bg-primary-press">
                Open {row.setup.placeName}
              </Link>
            )}
            <Button size="sm" variant="secondary" className="h-8 px-3 text-small" disabled={busy}
              onClick={() => reply(row, 'Help me set it up', 'do_it')}>
              Help me set it up
            </Button>
            <button type="button" disabled={busy} onClick={() => reply(row, 'Not now', 'not_now')}
              className="rounded-sm px-1 text-small font-medium text-muted hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              Not now
            </button>
            <button type="button" disabled={busy} onClick={() => reply(row, "Don't suggest this", 'never')}
              className="rounded-sm px-1 text-small font-medium text-muted hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              Don’t suggest this
            </button>
          </div>
        )}
      </PaneRow>
    );
  };

  const group = (label: string, list: FromClemRow[], shown: number, which: 'waiting' | 'updates', render: (row: FromClemRow) => React.ReactElement) => {
    if (list.length === 0) return null;
    const all = showAll[which];
    const visible = all ? list : list.slice(0, shown);
    return (
      <div className="flex flex-col gap-1.5">
        {section === 'all' && <h3 className="text-caption font-semibold uppercase tracking-wide text-faint">
          {label}{list.length > 1 ? ` · ${list.length}` : ''}
        </h3>}
        <PaneCard>
          {visible.map(render)}
          {list.length > shown && (
            <PaneRow className="justify-center text-small">
              <button type="button" onClick={() => setShowAll((now) => ({ ...now, [which]: !all }))}
                className="rounded-sm font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                {all ? 'Show fewer' : `Show ${list.length - shown} more`}
              </button>
            </PaneRow>
          )}
        </PaneCard>
      </div>
    );
  };

  if (section !== 'all') {
    // Inside a Today list: its rows only, or nothing; the list owns the
    // heading, the loading line and the empty state.
    if (!data) return null;
    return section === 'waiting'
      ? <>
          <TapOutcomes taps={taps} onDismiss={dismissTap} />
          {group('Waiting on you', waiting, WAITING_SHOWN, 'waiting', waitingRow)}
          {offers.length > 0 && <PaneCard>{offers.map(offerRow)}</PaneCard>}
        </>
      : group('Updates', updates, UPDATES_SHOWN, 'updates', updateRow);
  }

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2.5">
      <SectionHeader
        id={headingId}
        label="From Clem"
        count={waiting.length}
        aside={(
          <>
            <Link to={`/chat/${encodeURIComponent(unifiedChatSessionId('clem'))}`} className="rounded-sm font-semibold text-primary hover:underline">Her thread</Link>
            <span aria-hidden>·</span>
            <Link to="/heartbeats" className="rounded-sm font-semibold text-primary hover:underline">How Clem checks in</Link>
          </>
        )}
      />
      {error && data && <p role="status" className="text-small text-warning">
        Couldn’t refresh what Clem noticed. Showing the last saved reading.{' '}
        <button type="button" onClick={onRetry} className="rounded-sm font-semibold underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">Try again</button>
      </p>}
      <TapOutcomes taps={taps} onDismiss={dismissTap} />
      {error && !data ? (
        <PaneCard><LoadFailedLine what="what Clem noticed" onRetry={onRetry} /></PaneCard>
      ) : loading && !data ? (
        <PaneCard><RowSkeleton rows={2} tall /></PaneCard>
      ) : rows.length === 0 ? (
        <PaneCard>
          <PaneRow className="flex-col items-stretch gap-1.5 py-3.5">
            <p className="text-body text-fg">{error ? 'No updates in the last saved reading.' : 'Nothing new from Clem.'}</p>
            {pulses.length > 0 ? (
              pulseHistory
            ) : (
              <p className="text-small text-muted">{error ? 'Background check history could not be refreshed.' : 'Background check history will appear here.'}</p>
            )}
          </PaneRow>
        </PaneCard>
      ) : (
        <>
          {group('Waiting on you', waiting, WAITING_SHOWN, 'waiting', waitingRow)}
          {group('Updates', updates, UPDATES_SHOWN, 'updates', updateRow)}
          {offers.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <h3 className="text-caption font-semibold uppercase tracking-wide text-faint">Set up next</h3>
              <PaneCard>{offers.map(offerRow)}</PaneCard>
            </div>
          )}
        </>
      )}
      {rows.length > 0 && pulses.length > 0 && pulseHistory}
    </section>
  );
}
