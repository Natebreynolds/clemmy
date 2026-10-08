import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { appPlaceHref } from '@clem/chat-engine';
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
export function FromClem({ data, onChanged, onOpenThread }: {
  data: FromClemData | null;
  onChanged: () => void;
  onOpenThread: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notices, setNotices] = useState<Record<string, { text: string; error?: boolean }>>({});
  const [replying, setReplying] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const rows = data?.rows ?? [];
  if (rows.length === 0) return null;
  const waiting = rows.filter((row) => row.asks && !row.setup);
  const updates = rows.filter((row) => !row.asks && !row.setup);
  const offers = rows.filter((row) => row.setup);

  const run = async (row: FromClemRow, work: () => Promise<string>) => {
    haptic('light');
    setBusy(row.key);
    try {
      const text = await work();
      setNotices((all) => ({ ...all, [row.key]: { text } }));
      setReplying((key) => (key === row.key ? null : key));
      setDraft('');
      onChanged();
    } catch (error) {
      setNotices((all) => ({ ...all, [row.key]: { text: error instanceof Error ? error.message : 'That didn’t reach Clem.', error: true } }));
    } finally {
      setBusy(null);
    }
  };
  const reply = (row: FromClemRow, text: string, decision?: Decision) =>
    run(row, async () => outcomeText(await replyFromClem(row.key, text, row.voiceDigest, decision)));

  const meta = (row: FromClemRow) => (
    <div class="home-row-note">{row.heartbeatTitle} · {relativeTime(row.at)}</div>
  );
  const notice = (row: FromClemRow) => {
    const said = notices[row.key];
    if (!said) return null;
    return said.error
      ? <p class="home-row-error" role="alert">{said.text}</p>
      : <div class="home-row-receipt" role="status">{said.text}</div>;
  };
  const replyBox = (row: FromClemRow) => (replying === row.key ? (
    <form class="from-clem-reply" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) void reply(row, draft.trim()); }}>
      <input class="cz-input" value={draft} placeholder="Reply to Clem…" aria-label="Reply to Clem"
        onInput={(event) => setDraft((event.target as HTMLInputElement).value)} autoFocus />
      <button type="submit" class="home-btn home-btn-primary" disabled={busy !== null || !draft.trim()}>Send</button>
    </form>
  ) : null);
  const openReply = (row: FromClemRow, label: string) => (
    <button type="button" class="home-btn" disabled={busy !== null}
      onClick={() => { setReplying(replying === row.key ? null : row.key); setDraft(''); }}>
      {replying === row.key ? 'Close' : label}
    </button>
  );

  const waitingRow = (row: FromClemRow) => {
    const done = Boolean(notices[row.key] && !notices[row.key]!.error);
    return (
      <div key={row.key} class="home-row home-row-needs" aria-busy={busy === row.key}>
        {meta(row)}
        <div class="home-row-title">{row.say || row.text}</div>
        {notice(row)}
        {!done ? (
          <div class="home-row-actions">
            {(row.choices ?? []).map((choice, index) => (
              <button key={choice} type="button" class={index === 0 ? 'home-btn home-btn-primary' : 'home-btn'} disabled={busy !== null}
                onClick={() => void reply(row, choice)}>{choice}</button>
            ))}
            {!row.choices?.length && row.answer?.kind === 'yes_no' ? (
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
    const done = Boolean(notices[row.key] && !notices[row.key]!.error);
    const notificationId = row.done?.notificationId;
    return (
      <div key={row.key} class="home-row home-row-needs" aria-busy={busy === row.key}>
        {meta(row)}
        <div class="home-row-title">{row.say || row.text}</div>
        {notice(row)}
        {!done ? (
          <div class="home-row-actions">
            {notificationId ? (
              <button type="button" class="home-btn" disabled={busy !== null}
                onClick={() => void run(row, async () => { await markInboxNotificationRead(notificationId); return 'Cleared.'; })}>Done</button>
            ) : null}
            {openReply(row, 'Tell Clem')}
          </div>
        ) : null}
        {replyBox(row)}
      </div>
    );
  };

  const offerRow = (row: FromClemRow) => {
    const done = Boolean(notices[row.key] && !notices[row.key]!.error);
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
    <div class="from-clem-group">
      <h3 id={id} class="from-clem-group-head">{label}{list.length > 1 ? ` · ${list.length}` : ''}</h3>
      <div class="home-card" aria-labelledby={id}>{list.map(render)}</div>
    </div>
  ) : null);

  return (
    <section class="home-section" aria-labelledby="home-from-clem">
      <div class="from-clem-head">
        <h2 id="home-from-clem" class="section-head pane-head">From Clem</h2>
        <button type="button" class="from-clem-thread" onClick={() => { haptic('light'); onOpenThread(); }}>Her thread</button>
      </div>
      {group('from-clem-waiting', 'Waiting on you', waiting, waitingRow)}
      {group('from-clem-updates', 'Updates', updates, updateRow)}
      {group('from-clem-setup', 'Set up next', offers, offerRow)}
    </section>
  );
}
