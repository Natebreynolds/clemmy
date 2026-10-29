import './attention-report-groups.css';
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { attentionReportCount, attentionWorkTitle, groupAttentionReports, oneLine, appPlaceHref, currentProactiveReceipt, fromClemSourceName, proactiveReplySettled, type ProactiveReplyReceipt } from '@clem/chat-engine';
import { markInboxNotificationRead, presentInboxAttention, presentInboxQuestion, replyFromClem, type FromClem as FromClemData, type FromClemReplyOutcome, type FromClemRow } from '../lib/api';
import { restoreSavedAttention, sameAttentionReceipt, type SavedAttentionReceipt } from '../lib/attention-presentation';
import { relativeTime } from './Approvals';
import { haptic } from '../lib/native-bridge';
import { cardRecordInMotion, getCardRecords, type CardRecord as CardRecordData } from '../lib/card-records';
import { CardRecord } from './CardRecord';

type Decision = 'do_it' | 'done' | 'not_now' | 'never';

/** What a reply did, said plainly. Her own reaction comes from her, in her thread. */
function outcomeText(outcome: FromClemReplyOutcome): string {
  switch (outcome.outcome) {
    case 'answered': return 'Sent.';
    case 'started': return outcome.itemSettled === false ? 'Started a conversation.' : 'Clem is on it in her thread.';
    case 'approved': return 'Approved.';
    case 'declined': return 'Declined.';
    case 'cleared': return 'Cleared.';
    case 'later': return 'Back tomorrow morning.';
    case 'rule_added': return 'Saved as a rule.';
    case 'unclear': return 'That didn’t settle it. Say what you want Clem to do.';
    case 'changed': return 'This changed while you were replying. Have another look.';
    default: return 'Already handled.';
  }
}

/**
 * From Clem on the phone: the same three groups as the Mac. What waits on you
 * first, with the answers she offers as buttons and your own words one tap
 * away; then updates, each cleared with Done; then the one part she offers to
 * help set up. A place that lives only on the Mac says so instead of linking.
 */
export function FromClem({ data, onChanged, onOpenThread, mode = 'all', maxRows, onOpenInbox }: {
  data: FromClemData | null;
  maxRows?: number;
  onOpenInbox?: (decisionKey?: string) => void;
  /** Home places current decisions in its configurable Needs you pane. */
  mode?: 'all' | 'decisions' | 'updates';
  onChanged: () => void;
  onOpenThread: (sessionId?: string) => void;
}) {
  const inFlight = useRef(false);
  const undoElement = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notices, setNotices] = useState<Record<string, ProactiveReplyReceipt>>({});
  const [replying, setReplying] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ rowKey: string; receipt: SavedAttentionReceipt } | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // What the owner asked Clem from an item, and what she is doing about it,
  // kept by the daemon: on the item while it is listed, under Just now after.
  const [records, setRecords] = useState<CardRecordData[]>([]);
  const [recordsTick, setRecordsTick] = useState(0);
  const recordsMoving = records.some(cardRecordInMotion);
  useEffect(() => {
    let live = true;
    const read = () => { getCardRecords().then((result) => { if (live) setRecords(result.replies); }).catch(() => { /* the last reading stands */ }); };
    read();
    const timer = window.setInterval(read, recordsMoving ? 3_000 : 20_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [recordsMoving, recordsTick]);
  const allRows = (data?.rows ?? []).filter(row => mode === 'all' || (mode === 'decisions' ? row.asks && !row.setup : !row.asks || Boolean(row.setup)));
  const allGroups = groupAttentionReports(allRows, row => ({ id: row.key, attentionKey: row.attentionKey,
    generation: row.lifecycle?.generation, protected: !row.asks || Boolean(row.answer) || Boolean(row.setup) }));
  const visibleGroups = maxRows === undefined ? allGroups : allGroups.slice(0, maxRows);
  const rows = visibleGroups.flatMap(group => group.reports);
  const latestRows = useRef(rows);
  latestRows.current = rows;
  const sectionId = `home-from-clem-${mode}`;
  const recordFor = (row: FromClemRow) => records.find((record) => record.rowKey === row.key);
  const listedKeys = new Set((data?.rows ?? []).map((row) => row.key));
  const justNow = mode === 'updates' ? [] : records.filter((record) => !listedKeys.has(record.rowKey)).slice(0, 3);

  if (rows.length === 0 && !undo && justNow.length === 0) return null;
  const waiting = rows.filter((row) => row.asks && !row.setup);
  const updates = rows.filter((row) => !row.asks && !row.setup);
  const offers = rows.filter((row) => row.setup);
  const heading = mode === 'decisions' ? 'Waiting on you'
    : mode === 'updates' ? (updates.length > 0 ? 'Updates from Clem' : 'Set up next') : 'From Clem';
  const showGroupHeading = mode === 'all' || [waiting, updates, offers].filter(group => group.length > 0).length > 1;

  const run = async (row: FromClemRow, work: () => Promise<{text: string; settled: boolean; sessionId?: string}>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    haptic('light');
    setBusy(row.key);
    try {
      const result = await work();
      setNotices((all) => ({ ...all, [row.key]: { ...result, voiceDigest: row.voiceDigest, tone: result.settled ? 'success' : 'info' } }));
      if (result.settled && latestRows.current.some(current => current.key === row.key && current.voiceDigest === row.voiceDigest)) setReplying((key) => (key === row.key ? null : key));
      onChanged();
    } catch (error) {
      setNotices((all) => ({ ...all, [row.key]: { voiceDigest: row.voiceDigest, settled: false, tone: 'error', text: error instanceof Error ? error.message : 'That didn’t reach Clem. Your reply is kept; check the item before trying again.' } }));
      if ((error as { status?: number }).status === 409) onChanged();
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };
  const reply = (row: FromClemRow, text: string, decision?: Decision, choiceIndex?: number) =>
    run(row, async () => {
      const result = await replyFromClem(row.key, text, row.voiceDigest, decision, choiceIndex);
      if (result.outcome === 'started') setRecordsTick((tick) => tick + 1);
      return { text: outcomeText(result),
        settled: proactiveReplySettled(result.outcome, result.outcome === 'started' ? result.itemSettled : undefined),
        ...(result.outcome === 'started' ? { sessionId: result.sessionId } : {}),
      };
    });

  const hideQuestion = (row: FromClemRow, action: 'dismiss' | 'defer') => run(row, async () => {
    if (row.lifecycle?.effect !== 'hide_only' || !row.lifecycle.generation) throw new Error('Refresh this item before setting it aside.');
    const question = row.answer?.kind === 'words' ? row.answer.questionId : null;
    if (!question && (!row.attentionKey || row.answer?.kind === 'yes_no')) throw new Error('This decision must be reviewed in Inbox.');
    const result = question ? await presentInboxQuestion(question, action, row.lifecycle.generation)
      : await presentInboxAttention(row.attentionKey!, action, row.lifecycle.generation);
    setUndo(result.generation && result.mutationToken ? { rowKey: row.key, receipt: { source: question ? 'question' : 'attention',
      id: question ?? row.attentionKey!, generation: result.generation, mutationToken: result.mutationToken } } : null);
    setUndoError(null);
    // Only an explicit presentation action moves focus. Polls never do. Wait
    // for the receipt and the collapsing report list to reach the DOM first.
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      undoElement.current?.scrollIntoView({ block: 'center', behavior: 'auto' });
      undoElement.current?.focus({ preventScroll: true });
    }));
    return { text: action === 'defer' ? 'Set aside until tomorrow. The work is unchanged.' : 'Set aside. The work is unchanged.', settled: true };
  });
  const restoreQuestion = async () => {
    if (!undo || inFlight.current) return;
    const held = undo;
    inFlight.current = true; setBusy(held.rowKey); setUndoError(null);
    try {
      await restoreSavedAttention(held.receipt);
      setNotices(all => { const next = { ...all }; delete next[held.rowKey]; return next; });
      setUndo(current => current && sameAttentionReceipt(current.receipt, held.receipt) ? null : current); onChanged();
    } catch (err) { setUndoError(err instanceof Error ? err.message : 'Could not restore this item. Refresh to check its status.'); }
    finally { inFlight.current = false; setBusy(null); }
  };

  const meta = (row: FromClemRow) => (
    <div class="home-row-note">{fromClemSourceName(row)} · {relativeTime(row.at)}{(row.relatedNotificationIds?.length ?? 0) > 1 ? ` · Reported ${row.relatedNotificationIds!.length} times` : ''}</div>
  );
  const notice = (row: FromClemRow) => {
    const said = currentProactiveReceipt(notices[row.key], row.voiceDigest);
    if (!said) return null;
    return said.tone === 'error'
      ? <p class="home-row-error" role="alert">{said.text}</p>
      : <div class={said.tone === 'success' ? 'home-row-receipt' : 'home-row-note'} role="status">
        {said.text}
        {said.sessionId ? <>{' '}<button type="button" class="home-link-btn" onClick={() => onOpenThread(said.sessionId)}>Open conversation</button></> : null}
      </div>;
  };
  const replyBox = (row: FromClemRow) => (replying === row.key ? (
    <form class="from-clem-reply" onSubmit={(event) => { event.preventDefault(); if (drafts[row.key]?.trim()) void reply(row, drafts[row.key]!.trim()); }}>
      <input class="cz-input" value={drafts[row.key] ?? ''} placeholder="Reply to Clem…" aria-label="Reply to Clem"
        onInput={(event) => setDrafts(all => ({ ...all, [row.key]: (event.target as HTMLInputElement).value }))} autoFocus />
      <button type="submit" class="home-btn home-btn-primary" disabled={busy !== null || !drafts[row.key]?.trim()}>Send</button>
    </form>
  ) : null);
  const openReply = (row: FromClemRow, label: string) => (
    // A quiet text link, as on the desktop: the tap answers are the choices;
    // typing is the fallback (2026-10-18: three stacked pills per card).
    <button type="button" class="home-link-btn" disabled={busy !== null}
      onClick={() => { setReplying(replying === row.key ? null : row.key); }}>
      {replying === row.key ? 'Close' : label}
    </button>
  );

  const waitingRow = (row: FromClemRow, presentation = true) => {
    const done = Boolean(currentProactiveReceipt(notices[row.key], row.voiceDigest)?.settled);
    return (
      <div key={row.key} class="home-row home-row-needs" aria-busy={busy === row.key}>
        {meta(row)}
        <div class="home-row-title">{row.say || row.text}</div>
        {!presentation && row.detail ? <p class="from-clem-report">{row.detail}</p> : null}
        {notice(row)}
        {recordFor(row) ? <CardRecord record={recordFor(row)!} onOpenThread={onOpenThread} onOpenInbox={onOpenInbox} /> : null}
        {!done ? (
          <div class="home-row-actions">
            {(row.answer?.kind === 'yes_no' ? [] : row.choices ?? []).map((choice, index) => (
              <button key={choice} type="button" class={index === 0 ? 'home-btn home-btn-primary' : 'home-btn'} disabled={busy !== null}
                onClick={() => void reply(row, choice, undefined, index)}>{choice}</button>
            ))}
            {row.answer?.kind === 'yes_no' && onOpenInbox ? <button type="button" class="home-btn home-btn-primary" onClick={() => { if (row.answer?.kind === 'yes_no') onOpenInbox(`plan:${row.answer.planProposalId}`); }}>Review plan</button> : null}
            {!row.choices?.length && row.answer?.kind === 'brain_outage' ? (
              <>
                <button type="button" class="home-btn home-btn-primary" disabled={busy !== null} onClick={() => void reply(row, 'Yes, do it', 'do_it')}>Yes</button>
                <button type="button" class="home-btn" disabled={busy !== null} onClick={() => void reply(row, 'No', 'done')}>No</button>
              </>
            ) : null}
            {row.answer?.kind !== 'yes_no' ? openReply(row, row.choices?.length ? 'Reply in your words' : 'Reply') : null}
            {presentation && (row.answer?.kind === 'words' || row.attentionKey && row.answer?.kind !== 'yes_no') && row.lifecycle?.effect === 'hide_only' && row.lifecycle.generation ? <>
              {row.lifecycle.canDefer ? <button type="button" class="home-btn" disabled={busy !== null} onClick={() => void hideQuestion(row, 'defer')}>Later</button> : null}
              {row.lifecycle.canDismiss ? <button type="button" class="home-btn" disabled={busy !== null} onClick={() => void hideQuestion(row, 'dismiss')}>Dismiss</button> : null}
            </> : null}
          </div>
        ) : null}
        {row.answer?.kind !== 'yes_no' ? replyBox(row) : null}
      </div>
    );
  };

  const updateRow = (row: FromClemRow) => {
    const done = Boolean(currentProactiveReceipt(notices[row.key], row.voiceDigest)?.settled);
    const notificationId = row.done?.notificationId;
    // A report leads with its title; its text opens in place, as she wrote it.
    const report = row.authored === true && Boolean(row.say);
    const open = reading === row.key;
    const detail = !report
      ? (row.say ? [row.text, row.detail] : [row.detail]).filter(Boolean).join('\n\n')
      : '';
    return (
      <div key={row.key} class="home-row home-row-needs from-clem-update" aria-busy={busy === row.key}>
        {meta(row)}
        <div class={open ? 'from-clem-summary' : 'from-clem-summary from-clem-summary-clamped'}>{report ? row.text : row.say || row.text}</div>
        {report ? <div class={open ? 'from-clem-report' : 'from-clem-report from-clem-report-clamped'}>{row.say}</div> : null}
        {open && detail ? <div class="from-clem-report">{detail}</div> : null}
        <button type="button" class="home-link-btn from-clem-read" aria-expanded={open}
          onClick={() => setReading(open ? null : row.key)}>{open ? 'Show less' : 'Read update'}</button>
        {row.handoff ? <div class="home-row-note">
          <p>{row.handoff.reason || (row.handoff.state === 'dispatched' ? 'The approved task is in its conversation.' : 'This suggestion needs another look before work continues.')}</p>
          <button type="button" class="home-btn" onClick={() => onOpenThread(row.handoff?.sessionId)}>{row.handoff.sessionId ? 'Open conversation' : 'Ask Clem in chat'}</button>
        </div> : null}
        {notice(row)}
        {recordFor(row) ? <CardRecord record={recordFor(row)!} onOpenThread={onOpenThread} onOpenInbox={onOpenInbox} /> : null}
        {!row.handoff && !done ? (
          <div class="home-row-actions">
            {notificationId ? (
              <button type="button" class="home-btn" disabled={busy !== null}
                onClick={() => void run(row, async () => { await markInboxNotificationRead(notificationId); return {text: 'Cleared.', settled: true}; })}>Dismiss update</button>
            ) : null}
            {openReply(row, 'Tell Clem')}
          </div>
        ) : null}
        {replyBox(row)}
      </div>
    );
  };

  const offerRow = (row: FromClemRow) => {
    const done = Boolean(currentProactiveReceipt(notices[row.key], row.voiceDigest)?.settled);
    const setup = row.setup!;
    const href = appPlaceHref(setup.place, 'phone');
    return (
      <div key={row.key} class="home-row home-row-needs" aria-busy={busy === row.key}>
        <div class="home-row-title">{row.say || row.text}</div>
        {!row.say && row.detail ? <div class="home-row-note">{row.detail}</div> : null}
        {!href ? <div class="home-row-note">{setup.placeName} is on your computer.</div> : null}
        {notice(row)}
        {recordFor(row) ? <CardRecord record={recordFor(row)!} onOpenThread={onOpenThread} onOpenInbox={onOpenInbox} /> : null}
        {!done ? (
          <div class="home-row-actions">
            {href ? <a class="home-btn home-btn-primary" href={href} data-app-place={setup.place}>Open {setup.placeName}</a> : null}
            <button type="button" class={href ? 'home-btn' : 'home-btn home-btn-primary'} disabled={busy !== null}
              onClick={() => void reply(row, 'Help me set it up', 'do_it')}>Help me set it up</button>
            <button type="button" class="home-btn" disabled={busy !== null}
              onClick={() => void reply(row, 'Not now', 'not_now')}>Not now</button>
            <button type="button" class="home-btn" disabled={busy !== null}
              onClick={() => void reply(row, "Don't suggest this", 'never')}>Don’t suggest this</button>
          </div>
        ) : null}
      </div>
    );
  };

  const group = (id: string, label: string, list: FromClemRow[], render: (row: FromClemRow) => JSX.Element) => {
    if (list.length === 0) return null;
    const grouped = groupAttentionReports(list, row => ({ id: row.key, attentionKey: row.attentionKey,
      generation: row.lifecycle?.generation, protected: !row.asks || Boolean(row.answer) || Boolean(row.setup) }));
    return <div class={`from-clem-group ${id}`}>
      {showGroupHeading ? <h3 id={`${sectionId}-${id}`} class="from-clem-group-head">{label}</h3> : null}
      <div class="home-card" aria-labelledby={showGroupHeading ? `${sectionId}-${id}` : sectionId}>
        {grouped.map(item => {
          if (item.reports.length === 1) return render(item.reports[0]);
          const first = item.reports[0];
          const count = attentionReportCount(item.reports, row => row.relatedNotificationIds ?? [row.done?.notificationId ?? row.key]);
          return <details key={item.id} data-attention-group={item.attentionKey} class="attention-work-group">
            <summary><strong>{attentionWorkTitle(item.attentionKey, fromClemSourceName(first))}</strong><span class="attention-report-count">{count} reports</span>
              {item.reports.map(row => <span key={row.key} class="attention-report-cause">{oneLine(row.say || row.detail || row.text, 140)}</span>)}
            </summary>
            <div class="attention-work-actions"><span>Setting this aside leaves every report and the work unchanged.</span>
              {first.lifecycle?.canDefer ? <button type="button" class="home-btn" disabled={busy !== null} onClick={() => void hideQuestion(first, 'defer')}>Later</button> : null}
              {first.lifecycle?.canDismiss ? <button type="button" class="home-btn" disabled={busy !== null} onClick={() => void hideQuestion(first, 'dismiss')}>Dismiss</button> : null}
            </div>
            <div class="attention-work-reports">{item.reports.map(row => waitingRow(row, false))}</div>
          </details>;
        })}
      </div>
    </div>;
  };

  return (
    <section class="home-section" aria-labelledby={sectionId}>
      {undo ? <div ref={undoElement} class="presentation-undo" role="status" tabIndex={-1}><span>Set aside. The work is unchanged.</span><button type="button" disabled={busy !== null} onClick={() => void restoreQuestion()}>Undo</button></div> : null}
      {undoError ? <p class="home-row-error" role="alert">{undoError}</p> : null}
      <div class="from-clem-head">
        <h2 id={sectionId} class="section-head pane-head">{heading}</h2>
        {mode !== 'decisions' ? <button type="button" class="from-clem-thread" onClick={() => { haptic('light'); onOpenThread(); }}>Chat with Clem</button> : null}
      </div>
      {justNow.length > 0 ? <div class="card-record-just-now">
        <h3 class="section-head">Just now</h3>
        {justNow.map((record) => <CardRecord key={record.runId} record={record} showTitle onOpenThread={onOpenThread} onOpenInbox={onOpenInbox} />)}
      </div> : null}
      {group('from-clem-waiting', 'Waiting on you', waiting, waitingRow)}
      {group('from-clem-updates', 'Updates', updates, updateRow)}
      {group('from-clem-setup', 'Set up next', offers, offerRow)}
      {allGroups.length > visibleGroups.length ? <button type="button" class="home-pinned-more" onClick={() => onOpenInbox ? onOpenInbox() : onOpenThread()}>View all {new Set(allGroups.map(group => group.attentionKey ?? group.id)).size} {mode === 'decisions' ? 'requests' : 'updates'}</button> : null}
    </section>
  );
}
