import type { JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { appPlaceHref, currentProactiveReceipt, fromClemSourceName, proactiveReplySettled, type ProactiveReplyReceipt } from '@clem/chat-engine';
import { markInboxNotificationRead, replyFromClem, type FromClem as FromClemData, type FromClemReplyOutcome, type FromClemRow } from '../lib/api';
import { relativeTime } from './Approvals';
import { haptic } from '../lib/native-bridge';

type Decision = 'do_it' | 'done' | 'not_now' | 'never';

/** What a reply did, said plainly. Her own reaction comes from her, in her thread. */
function outcomeText(outcome: FromClemReplyOutcome): string {
  switch (outcome.outcome) {
    case 'answered': return 'Sent.';
    case 'started': return 'Clem is on it in her thread.';
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
export function FromClem({ data, onChanged, onOpenThread, mode = 'all' }: {
  data: FromClemData | null;
  /** Home places current decisions in its configurable Needs you pane. */
  mode?: 'all' | 'decisions' | 'updates';
  onChanged: () => void;
  onOpenThread: (sessionId?: string) => void;
}) {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notices, setNotices] = useState<Record<string, ProactiveReplyReceipt>>({});
  const [replying, setReplying] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const rows = (data?.rows ?? []).filter(row => mode === 'all' || (mode === 'decisions' ? row.asks && !row.setup : !row.asks || Boolean(row.setup)));
  const latestRows = useRef(rows);
  latestRows.current = rows;
  const sectionId = `home-from-clem-${mode}`;
  if (rows.length === 0) return null;
  const waiting = rows.filter((row) => row.asks && !row.setup);
  const updates = rows.filter((row) => !row.asks && !row.setup);
  const offers = rows.filter((row) => row.setup);
  const heading = mode === 'decisions' ? 'Waiting on you'
    : mode === 'updates' ? (updates.length > 0 ? 'Updates from Clem' : 'Set up next') : 'From Clem';
  const showGroupHeading = mode === 'all' || [waiting, updates, offers].filter(group => group.length > 0).length > 1;

  const run = async (row: FromClemRow, work: () => Promise<{text: string; settled: boolean}>) => {
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
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };
  const reply = (row: FromClemRow, text: string, decision?: Decision, choiceIndex?: number) =>
    run(row, async () => { const result = await replyFromClem(row.key, text, row.voiceDigest, decision, choiceIndex); return { text: outcomeText(result), settled: proactiveReplySettled(result.outcome) }; });

  const meta = (row: FromClemRow) => (
    <div class="home-row-note">{fromClemSourceName(row)} · {relativeTime(row.at)}</div>
  );
  const notice = (row: FromClemRow) => {
    const said = currentProactiveReceipt(notices[row.key], row.voiceDigest);
    if (!said) return null;
    return said.tone === 'error'
      ? <p class="home-row-error" role="alert">{said.text}</p>
      : <div class={said.tone === 'success' ? 'home-row-receipt' : 'home-row-note'} role="status">{said.text}</div>;
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

  const waitingRow = (row: FromClemRow) => {
    const done = Boolean(currentProactiveReceipt(notices[row.key], row.voiceDigest)?.settled);
    return (
      <div key={row.key} class="home-row home-row-needs" aria-busy={busy === row.key}>
        {meta(row)}
        <div class="home-row-title">{row.say || row.text}</div>
        {notice(row)}
        {!done ? (
          <div class="home-row-actions">
            {(row.choices ?? []).map((choice, index) => (
              <button key={choice} type="button" class={index === 0 ? 'home-btn home-btn-primary' : 'home-btn'} disabled={busy !== null}
                onClick={() => void reply(row, choice, undefined, index)}>{choice}</button>
            ))}
            {!row.choices?.length && (row.answer?.kind === 'yes_no' || row.answer?.kind === 'brain_outage') ? (
              <>
                <button type="button" class="home-btn home-btn-primary" disabled={busy !== null} onClick={() => void reply(row, 'Yes, do it', 'do_it')}>Yes</button>
                <button type="button" class="home-btn" disabled={busy !== null} onClick={() => void reply(row, 'No', 'done')}>No</button>
              </>
            ) : null}
            {openReply(row, row.choices?.length ? 'Reply in your words' : 'Reply')}
          </div>
        ) : null}
        {replyBox(row)}
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
          onClick={() => setReading(open ? null : row.key)}>{open ? 'Show less' : 'Read more'}</button>
        {row.handoff ? <div class="home-row-note">
          <p>{row.handoff.reason || (row.handoff.state === 'dispatched' ? 'The approved task is in its conversation.' : 'This suggestion needs another look before work continues.')}</p>
          <button type="button" class="home-btn" onClick={() => onOpenThread(row.handoff?.sessionId)}>{row.handoff.sessionId ? 'Open conversation' : 'Ask Clem in chat'}</button>
        </div> : null}
        {notice(row)}
        {!row.handoff && !done ? (
          <div class="home-row-actions">
            {notificationId ? (
              <button type="button" class="home-btn" disabled={busy !== null}
                onClick={() => void run(row, async () => { await markInboxNotificationRead(notificationId); return {text: 'Cleared.', settled: true}; })}>Done</button>
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

  const group = (id: string, label: string, list: FromClemRow[], render: (row: FromClemRow) => JSX.Element) => (list.length > 0 ? (
    <div class={`from-clem-group ${id}`}>
      {showGroupHeading ? <h3 id={`${sectionId}-${id}`} class="from-clem-group-head">{label}{list.length > 1 ? ` · ${list.length}` : ''}</h3> : null}
      <div class="home-card" aria-labelledby={showGroupHeading ? `${sectionId}-${id}` : sectionId}>{list.map(render)}</div>
    </div>
  ) : null);

  return (
    <section class="home-section" aria-labelledby={sectionId}>
      <div class="from-clem-head">
        <h2 id={sectionId} class="section-head pane-head">{heading}</h2>
        {mode !== 'decisions' ? <button type="button" class="from-clem-thread" onClick={() => { haptic('light'); onOpenThread(); }}>Her thread</button> : null}
      </div>
      {group('from-clem-waiting', 'Waiting on you', waiting, waitingRow)}
      {group('from-clem-updates', 'Updates', updates, updateRow)}
      {group('from-clem-setup', 'Set up next', offers, offerRow)}
    </section>
  );
}
