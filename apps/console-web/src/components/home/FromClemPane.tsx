import { useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { attentionReportCount, attentionWorkTitle, groupAttentionReports, oneLine, appPlaceHref, fromClemSourceName, heartbeatLastCheckWords, heartbeatStateWords, currentProactiveReceipt, proactiveReplySettled, type ProactiveReplyReceipt } from '@clem/chat-engine';
import { Button } from '@/components/ui/Button';
import { markNotificationRead, presentInboxQuestion } from '@/lib/inbox';
import { cardReplyInMotion, fromClemDisposition, fromClemReceiptVersion, fromClemRunHref, getCardReplies, recentPulses, replyFromClem, replyOutcomeText, type CardReplyRecord, type FromClem, type FromClemRow } from '@/lib/from-clem';
import { presentAttentionItem } from '@/lib/attention-presentation';
import { cn } from '@/lib/cn';
import { unifiedChatSessionId } from '@/lib/last-session';
import { agoLabel } from './home-model';
import { AnswerRow } from './NeedsYouPane';
import { LoadFailedLine, PaneCard, PaneRow, RowSkeleton, SectionHeader } from './HomeSection';
import { CardRecord } from './CardRecord';

const HIDDEN_RECORDS_KEY = 'clem.home.hiddenCardRecords';

function readHiddenRecords(): ReadonlySet<string> {
  try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_RECORDS_KEY) ?? '[]') as string[]); } catch { return new Set(); }
}

function writeHiddenRecords(runs: ReadonlySet<string>): void {
  try { localStorage.setItem(HIDDEN_RECORDS_KEY, JSON.stringify([...runs].slice(-50))); } catch { /* hiding is a convenience */ }
}

interface RowState {
  voiceDigest: string;
  busy?: 'answer' | 'yes' | 'no' | 'done';
  notice?: ProactiveReplyReceipt;
}

/** How many rows each group shows before "Show more" opens the rest in place. */
const WAITING_SHOWN = 3;
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
  const [readingKey, setReadingKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // What the owner asked Clem from an item, and what she is doing about it,
  // kept by the daemon: shown on that item while it is listed, and under
  // Just now once it is not. Watched closely only while Clem is working.
  const cardReplies = useQuery({
    queryKey: ['from-clem-replies'],
    queryFn: getCardReplies,
    refetchInterval: (query) => (query.state.data?.replies.some(cardReplyInMotion) ? 3_000 : 20_000),
  });
  const [hiddenRuns, setHiddenRuns] = useState<ReadonlySet<string>>(() => readHiddenRecords());
  const hideRecord = (record: CardReplyRecord) => setHiddenRuns((all) => {
    const next = new Set(all).add(record.runId);
    writeHiddenRecords(next);
    return next;
  });
  const records = (cardReplies.data?.replies ?? []).filter((record) => !hiddenRuns.has(record.runId));
  const recordFor = (row: FromClemRow) => records.find((record) => record.rowKey === row.key);
  const [showAll, setShowAll] = useState<{ waiting: boolean; updates: boolean }>({ waiting: false, updates: false });
  const rows = data?.rows ?? [];
  const latestRows = useRef(rows);
  latestRows.current = rows;
  const waiting = rows.filter((row) => row.asks && !row.setup);
  const updates = rows.filter((row) => !row.asks && !row.setup);
  const offers = rows.filter((row) => row.setup);
  const listedKeys = new Set(rows.map((row) => row.key));
  const justNow = records.filter((record) => !listedKeys.has(record.rowKey));
  const justNowList = justNow.length > 0 && (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-caption font-semibold uppercase tracking-wide text-faint">Just now</h3>
      <div className="flex flex-col gap-2">
        {justNow.map((record) => <CardRecord key={record.runId} record={record} showTitle onDismiss={() => hideRecord(record)} />)}
      </div>
    </div>
  );
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
    const version = fromClemReceiptVersion(row);
    const lockKey = `${row.key}:${version}`;
    if (inFlight.current.has(lockKey)) return;
    inFlight.current.add(lockKey);
    setStates((all) => ({ ...all, [row.key]: { voiceDigest: version, busy } }));
    run().then(
      (result) => {
        const said = typeof success === 'string' ? { text: success } : success(result);
        setStates((all) => all[row.key]?.voiceDigest !== version ? all : ({ ...all, [row.key]: { voiceDigest: version, notice: { tone: said.settled === false ? 'info' : 'success', settled: said.settled !== false, voiceDigest: version, ...said } } }));
        if (said.settled !== false && latestRows.current.some(current => current.key === row.key && fromClemReceiptVersion(current) === version)) setOpenKey((key) => (key === row.key ? null : key));
      },
    ).catch((err: unknown) => setStates((all) => all[row.key]?.voiceDigest !== version ? all : ({
        ...all,
        [row.key]: { voiceDigest: version, notice: { voiceDigest: version, settled: false, tone: 'error', text: err instanceof Error ? err.message : 'That didn’t reach Clem. Your reply is kept; check the item before trying again.' } },
      }))).finally(() => {
        inFlight.current.delete(lockKey);
        for (const key of ['home-from-clem', 'command-center', 'needs-you-summary', 'inbox-questions', 'inbox-question-presentations', 'inbox-attention-presentations', 'notifications', 'working-now-badge']) {
          void qc.invalidateQueries({ queryKey: [key] });
        }
      });
  };

  const setAside = (row: FromClemRow, action: 'dismiss' | 'defer') => {
    const disposition = fromClemDisposition(row, action);
    if (!disposition) return;
    if (disposition.kind === 'question') {
      act(row, 'done', () => presentInboxQuestion(disposition.questionId, disposition.action, row.lifecycle?.generation),
        '');
      return;
    }
    if (disposition.kind === 'attention') {
      act(row, 'done', () => presentAttentionItem(disposition.key, disposition.action, disposition.generation),
        '');
      return;
    }
    reply(row, disposition.text, disposition.decision);
  };

  const reply = (row: FromClemRow, text: string, decision?: 'do_it' | 'done' | 'not_now' | 'never', choiceIndex?: number) => {
    return act(row, 'answer', () => replyFromClem(row.key, text, row.voiceDigest, decision, choiceIndex), (result) => {
      const outcome = result as Awaited<ReturnType<typeof replyFromClem>>;
      if (outcome.outcome === 'started') {
        // The daemon keeps the record; look again now so the item shows it at once.
        void qc.invalidateQueries({ queryKey: ['from-clem-replies'] });
        const settled = proactiveReplySettled(outcome.outcome, outcome.itemSettled);
        return { settled, sessionId: outcome.sessionId,
          text: settled ? 'Clem is on it — see Just now.' : 'Started a conversation — see Just now.' };
      }
      return { settled: proactiveReplySettled(outcome.outcome), text: replyOutcomeText(outcome, fromClemSourceName(row)) };
    });
  };

  /** The answers on the row itself: hers when she offered some, else the
   *  record's own (yes/no for a suggestion). */
  const answers = (row: FromClemRow, state: RowState) => {
    const busy = Boolean(state.busy);
    // Consent belongs beside the full proposed steps, never a clamped preview.
    if (row.answer?.kind === 'yes_no') {
      const id = row.answer.planProposalId;
      return [<Link key="review" to={`/inbox?tab=needs&select=${encodeURIComponent(id)}`}
        className="inline-flex min-h-9 items-center rounded-md bg-primary px-3 text-small font-semibold text-primary-fg hover:bg-primary-hover">Review plan</Link>];
    }
    if (row.blocker) return [<Link key="account" to="/settings?guide=model-accounts#accounts"
      className="inline-flex min-h-9 items-center rounded-md bg-primary px-3 text-small font-semibold text-primary-fg hover:bg-primary-hover">Review model account</Link>];
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
    return [];
  };

  const notice = (state: RowState) => state.notice?.text && (
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
      {(row.relatedNotificationIds?.length ?? 0) > 1 && <span>Reported {row.relatedNotificationIds!.length} times</span>}
      {drafts[row.key]?.trim() && openKey !== row.key && <span className="ml-auto text-muted">Draft saved</span>}
    </span>
  );

  // What the message is about: the record behind it, shown on request.
  const source = (row: FromClemRow) => (row.say ? [row.text, row.detail] : [row.detail]).filter(Boolean).join(' · ');

  const waitingRow = (row: FromClemRow, presentation = true) => {
    const state = currentProactiveReceipt(states[row.key], fromClemReceiptVersion(row)) ?? { voiceDigest: row.voiceDigest };
    const open = openKey === row.key;
    const reading = readingKey === row.key;
    const offered = answers(row, state);
    return (
      <PaneRow key={row.key} className="flex-col items-stretch gap-2 py-3.5">
        {meta(row)}
        <p className={cn('text-body text-fg', !open && !reading && 'line-clamp-3')}>{row.say || row.text}</p>
        {(open || reading) && source(row) && <p className="whitespace-pre-line text-small text-muted">{source(row)}</p>}
        {state.notice && notice(state)}
        {recordFor(row) && <CardRecord record={recordFor(row)!} />}
        {!state.notice?.settled && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {offered}
              <button type="button" aria-expanded={reading} onClick={() => setReadingKey(reading ? null : row.key)}
                className="rounded-sm px-1 text-small font-medium text-muted hover:underline">{reading ? 'Less detail' : 'Details'}</button>
              <button type="button" aria-expanded={open} onClick={() => setOpenKey(open ? null : row.key)}
                className="rounded-sm px-1 text-small font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                {open ? 'Close' : offered.length > 0 ? 'Reply in your words' : 'Reply'}
              </button>
              {presentation && (row.answer?.kind === 'words' ? row.lifecycle?.canDefer : Boolean(fromClemDisposition(row, 'defer'))) && <button type="button" disabled={Boolean(state.busy)} onClick={() => setAside(row, 'defer')}
                className="ml-auto rounded-md px-2 py-1 text-small font-medium text-muted hover:bg-hover hover:text-fg disabled:opacity-50">
                Tomorrow
              </button>}
              {presentation && (row.answer?.kind === 'words' ? row.lifecycle?.canDismiss : Boolean(fromClemDisposition(row, 'dismiss'))) &&
                <button type="button" disabled={Boolean(state.busy)} onClick={() => setAside(row, 'dismiss')}
                  className="rounded-md px-2 py-1 text-small font-medium text-muted hover:bg-hover hover:text-fg disabled:opacity-50">
                  {row.answer?.kind === 'yes_no' ? 'Decline' : 'Dismiss'}
                </button>}
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
    const state = currentProactiveReceipt(states[row.key], fromClemReceiptVersion(row)) ?? { voiceDigest: row.voiceDigest };
    const open = readingKey === row.key;
    const replying = openKey === row.key;
    const done = row.done;
    // A report leads with its title; opened, it reads as she wrote it.
    const report = row.authored === true;
    const runHref = fromClemRunHref(row);
    return (
      <PaneRow key={row.key} className="flex-col items-stretch gap-1.5 px-0 py-4">
        <button type="button" aria-expanded={open} onClick={() => setReadingKey(open ? null : row.key)}
          className="flex flex-col items-stretch gap-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          {meta(row)}
          {report && <span className="text-body font-semibold text-fg">{row.text}</span>}
          <span className={cn('text-body text-fg [overflow-wrap:anywhere]', open ? 'whitespace-pre-line' : 'line-clamp-2')}>{row.say || row.text}</span>
        </button>
        {open && !report && source(row) && <p className="whitespace-pre-line text-body text-muted [overflow-wrap:anywhere]">{source(row)}</p>}
        <button type="button" aria-expanded={open} onClick={() => setReadingKey(open ? null : row.key)}
          className="min-h-11 self-start rounded-sm px-1 text-small font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          {open ? 'Show less' : 'Read more'}
        </button>
        {row.handoff && <div className="space-y-1 text-small text-muted">
          <p>{row.handoff.reason || (row.handoff.state === 'dispatched' ? 'The approved task is in its conversation.' : 'This suggestion needs another look before work continues.')}</p>
          <Link to={row.handoff.sessionId ? `/chat/${encodeURIComponent(unifiedChatSessionId(row.handoff.sessionId))}` : `/chat/${encodeURIComponent(unifiedChatSessionId('clem'))}`} className="font-semibold text-primary hover:underline">{row.handoff.sessionId ? 'Open conversation' : 'Ask Clem in chat'}</Link>
        </div>}
        {state.notice && notice(state)}
        {recordFor(row) && <CardRecord record={recordFor(row)!} />}
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
            {replying && (
              <AnswerRow
                busy={state.busy === 'answer'}
                placeholder="Tell Clem what to do with it…"
                value={drafts[row.key] ?? ''}
                onValueChange={(text) => setDrafts((all) => ({ ...all, [row.key]: text }))}
                onAnswer={(text) => { if (text.trim()) reply(row, text.trim()); }}
              />
            )}
            <button type="button" aria-expanded={replying} onClick={() => setOpenKey(replying ? null : row.key)}
              className="min-h-11 rounded-sm px-1 text-small font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              {replying ? 'Close reply' : 'Reply to Clem'}
            </button>
          </div>
        )}
      </PaneRow>
    );
  };

  // An offer to help set something up: go there, have Clem walk you through
  // it, or move it out of the way.
  const offerRow = (row: FromClemRow) => {
    const state = currentProactiveReceipt(states[row.key], fromClemReceiptVersion(row)) ?? { voiceDigest: row.voiceDigest };
    const href = row.setup ? appPlaceHref(row.setup.place, 'desktop') : null;
    const busy = Boolean(state.busy);
    return (
      <PaneRow key={row.key} className="flex-col items-stretch gap-2 py-3.5">
        <p className="text-body text-fg">{row.say || row.text}</p>
        {!row.say && row.detail && <p className="text-small text-muted">{row.detail}</p>}
        {state.notice && notice(state)}
        {recordFor(row) && <CardRecord record={recordFor(row)!} />}
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

  const group = (label: string, list: FromClemRow[], shown: number, which: 'waiting' | 'updates', render: (row: FromClemRow) => ReactNode) => {
    if (list.length === 0) return null;
    const grouped = groupAttentionReports(list, row => ({ id: row.key, attentionKey: row.attentionKey,
      generation: row.lifecycle?.generation, protected: !row.asks || Boolean(row.answer) || Boolean(row.setup) }));
    const all = showAll[which];
    const visible = all ? grouped : grouped.slice(0, shown);
    const count = new Set(grouped.map(item => item.attentionKey ?? item.id)).size;
    return <div className="flex flex-col gap-1.5">
      {section === 'all' && <h3 className="text-small font-semibold text-muted">{label}{count > 1 ? ` · ${count}` : ''}</h3>}
      <PaneCard className={which === 'updates' ? 'rounded-none border-0 bg-transparent' : undefined}>
        {visible.map(item => {
          if (item.reports.length === 1) return render(item.reports[0]);
          const first = item.reports[0];
          const reportCount = attentionReportCount(item.reports, row => row.relatedNotificationIds ?? [row.done?.notificationId ?? row.key]);
          const busy = item.reports.some(row => Boolean(currentProactiveReceipt(states[row.key], fromClemReceiptVersion(row))?.busy));
          return <details key={item.id} data-attention-group={item.attentionKey} className="px-4 py-3">
            <summary className="min-h-11 cursor-pointer rounded-sm py-1 text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              <span className="font-semibold text-fg">{attentionWorkTitle(item.attentionKey, fromClemSourceName(first))}</span>
              <span className="ml-2 text-small text-muted">{reportCount} reports</span>
              {item.reports.map(row => <span key={row.key} className="mt-1 block text-small font-normal text-muted [overflow-wrap:anywhere]">{oneLine(row.say || row.detail || row.text, 140)}</span>)}
            </summary>
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2 text-small">
              <span className="mr-auto text-muted">Setting this aside leaves every report and the work unchanged.</span>
              {fromClemDisposition(first, 'defer')?.kind === 'attention' && <Button size="sm" variant="secondary" disabled={busy} onClick={() => setAside(first, 'defer')}>Tomorrow</Button>}
              {fromClemDisposition(first, 'dismiss')?.kind === 'attention' && <Button size="sm" variant="secondary" disabled={busy} onClick={() => setAside(first, 'dismiss')}>Dismiss</Button>}
            </div>
            <div className="divide-y divide-border">{item.reports.map(row => waitingRow(row, false))}</div>
          </details>;
        })}
        {grouped.length > shown && <PaneRow className="justify-center text-small"><button type="button" onClick={() => setShowAll(now => ({ ...now, [which]: !all }))}
          className="min-h-11 rounded-sm font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{all ? 'Show fewer' : `Show ${grouped.length - shown} more items`}</button></PaneRow>}
      </PaneCard>
    </div>;
  };

  if (section !== 'all') {
    // Inside a Today list: its rows only, or nothing; the list owns the
    // heading, the loading line and the empty state.
    if (!data) return null;
    return section === 'waiting'
      ? <>
          {justNowList}
          {group('Waiting on you', waiting, WAITING_SHOWN, 'waiting', waitingRow)}
          {offers.length > 0 && <details className="rounded-xl border border-border bg-surface px-4 text-small text-muted">
            <summary className="cursor-pointer py-3 font-medium">Ways Clem can help · {offers.length}</summary>
            <div className="border-t border-border">{offers.map(offerRow)}</div>
          </details>}
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
      {justNowList}
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
