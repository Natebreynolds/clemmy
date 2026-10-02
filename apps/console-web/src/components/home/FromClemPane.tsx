import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { decidePlanProposal, markNotificationRead } from '@/lib/inbox';
import { recentPulses, replyFromClem, replyOutcomeText, type FromClem, type FromClemRow } from '@/lib/from-clem';
import { cn } from '@/lib/cn';
import { unifiedChatSessionId } from '@/lib/last-session';
import { agoLabel } from './home-model';
import { AnswerRow } from './NeedsYouPane';
import { LoadFailedLine, PaneCard, PaneRow, RowSkeleton, SectionHeader } from './HomeSection';

interface RowState {
  busy?: 'answer' | 'yes' | 'no' | 'done';
  notice?: { tone: 'success' | 'error'; text: string; sessionId?: string };
}

/**
 * From Clem: what Clem's heartbeats brought you, in their own words, in one
 * place. What waits on you comes first. Each message reads on its own; opening
 * one shows what it is about and answers it right here — in your words for a
 * proposal, yes or no for a suggestion, Done for a finding. With
 * nothing to say, the pane still shows when each heartbeat last looked and
 * what it found, so a quiet Clem reads as a watching one. How often she looks
 * lives one level down, in Heartbeats.
 */
export function FromClemPane({
  headingId,
  data,
  loading,
  error,
  onRetry,
  maxRows = 4,
}: {
  headingId: string;
  data?: FromClem;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  maxRows?: number;
}) {
  const qc = useQueryClient();
  const [states, setStates] = useState<Record<string, RowState>>({});
  // One item open at a time: its source, its reply box and its quick answers.
  // Closed items are a message to read, not a form. Drafts outlive closing.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const rows = data?.rows ?? [];
  const asks = rows.filter((row) => row.asks).length;
  const pulses = recentPulses(data?.pulses ?? []);

  const act = (
    row: FromClemRow,
    busy: NonNullable<RowState['busy']>,
    run: () => Promise<unknown>,
    success: string | ((result: unknown) => { text: string; sessionId?: string }),
  ) => {
    setStates((all) => ({ ...all, [row.key]: { busy } }));
    run().then(
      (result) => {
        const said = typeof success === 'string' ? { text: success } : success(result);
        setStates((all) => ({ ...all, [row.key]: { notice: { tone: 'success', ...said } } }));
        void qc.invalidateQueries({ queryKey: ['home-from-clem'] });
        void qc.invalidateQueries({ queryKey: ['command-center'] });
      },
      (err: unknown) => setStates((all) => ({
        ...all,
        [row.key]: { notice: { tone: 'error', text: err instanceof Error ? err.message : 'That didn’t reach Clem.' } },
      })),
    );
  };

  const reply = (row: FromClemRow, text: string) => act(row, 'answer', () => replyFromClem(row.key, text, row.voiceDigest), (result) => {
    const outcome = result as Awaited<ReturnType<typeof replyFromClem>>;
    return { text: replyOutcomeText(outcome, row.heartbeatTitle), ...(outcome.outcome === 'started' ? { sessionId: outcome.sessionId } : {}) };
  });

  const quick = (row: FromClemRow, state: RowState) => {
    if (row.answer?.kind === 'yes_no') {
      const id = row.answer.planProposalId;
      return (
        <>
          <Button size="sm" className="h-8 px-3 text-small" disabled={Boolean(state.busy)}
            onClick={() => act(row, 'yes', () => decidePlanProposal(id, 'approve'), 'Approved.')}>
            {state.busy === 'yes' ? 'Sending…' : 'Yes'}
          </Button>
          <Button size="sm" variant="secondary" className="h-8 px-3 text-small" disabled={Boolean(state.busy)}
            onClick={() => act(row, 'no', () => decidePlanProposal(id, 'reject'), 'Declined.')}>
            No
          </Button>
        </>
      );
    }
    if (row.done) {
      const id = row.done.notificationId;
      return (
        <Button size="sm" variant="secondary" className="h-8 px-3 text-small" disabled={Boolean(state.busy)}
          onClick={() => act(row, 'done', () => markNotificationRead(id), 'Cleared.')}>
          {state.busy === 'done' ? 'Saving…' : 'Done'}
        </Button>
      );
    }
    return null;
  };

  const actions = (row: FromClemRow, state: RowState) => (
    <div className="flex flex-col gap-2">
      <AnswerRow
        busy={state.busy === 'answer'}
        placeholder="Reply to Clem…"
        value={drafts[row.key] ?? ''}
        onValueChange={(text) => setDrafts((all) => ({ ...all, [row.key]: text }))}
        autoFocus
        onAnswer={(text) => { if (text.trim()) reply(row, text.trim()); }}
      />
      {quick(row, state) && <div className="flex flex-wrap items-center gap-2">{quick(row, state)}</div>}
    </div>
  );

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2.5">
      <SectionHeader
        id={headingId}
        label="From Clem"
        count={asks}
        aside={(
          <>
            <Link to={`/chat/${encodeURIComponent(unifiedChatSessionId('clem'))}`} className="rounded-sm font-semibold text-primary hover:underline">Her thread</Link>
            <span aria-hidden>·</span>
            <Link to="/heartbeats" className="rounded-sm font-semibold text-primary hover:underline">How Clem checks in</Link>
          </>
        )}
      />
      <PaneCard>
        {loading && !data ? (
          <RowSkeleton rows={2} tall />
        ) : error && !data ? (
          <LoadFailedLine what="what Clem noticed" onRetry={onRetry} />
        ) : rows.length === 0 ? (
          <PaneRow className="flex-col items-stretch gap-1.5 py-3.5">
            <p className="text-body text-fg">Nothing from Clem right now.</p>
            {pulses.length > 0 ? (
              <ul className="flex flex-col gap-1 text-small text-muted">
                {pulses.map((pulse) => (
                  <li key={pulse.heartbeat}>
                    <span className="font-semibold">{pulse.title}</span>
                    {' · '}{agoLabel(pulse.lastAt)}{pulse.summary ? ` — ${pulse.summary}` : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-small text-muted">Her heartbeats haven’t looked at anything yet.</p>
            )}
          </PaneRow>
        ) : (
          rows.slice(0, maxRows).map((row) => {
            const state = states[row.key] ?? {};
            const open = openKey === row.key;
            // What the message is about: the record behind it, shown on request.
            const source = (row.say ? [row.text, row.detail] : [row.detail]).filter(Boolean).join(' · ');
            const drafted = Boolean(drafts[row.key]?.trim());
            return (
              <PaneRow key={row.key} className="flex-col items-stretch gap-1.5 py-3.5">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpenKey(open ? null : row.key)}
                  className="flex flex-col items-stretch gap-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <span className="flex items-center gap-2 text-caption text-faint">
                    <span className="font-semibold text-muted">{row.heartbeatTitle}</span>
                    <span aria-hidden>·</span>
                    <span>{agoLabel(row.at)}</span>
                    {row.asks && (
                      <span className="ml-auto inline-flex items-center gap-1.5 text-muted">
                        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary" />
                        {drafted && !open ? 'Draft saved' : 'Waiting on you'}
                      </span>
                    )}
                  </span>
                  <span className={cn('text-body text-fg', !open && 'line-clamp-2')}>{row.say || row.text}</span>
                  {!open && !state.notice && (
                    <span className="text-small font-medium text-primary">{row.asks ? 'Reply' : 'Read more'}</span>
                  )}
                </button>
                {open && source && <p className="whitespace-pre-line text-small text-muted">{source}</p>}
                {state.notice ? (
                  <p role="status" className={cn('text-small', state.notice.tone === 'error' ? 'text-warning' : 'text-muted')}>
                    {state.notice.text}
                    {state.notice.sessionId && (
                      <>{' '}<Link to={`/chat/${encodeURIComponent(unifiedChatSessionId(state.notice.sessionId))}`} className="font-semibold text-primary hover:underline">Open</Link></>
                    )}
                  </p>
                ) : open ? actions(row, state) : null}
              </PaneRow>
            );
          })
        )}
        {rows.length > maxRows && (
          <PaneRow className="justify-center text-small">
            <Link to="/inbox" className="font-semibold text-primary hover:underline">{rows.length - maxRows} more in Needs you</Link>
          </PaneRow>
        )}
      </PaneCard>
      {rows.length > 0 && pulses.length > 0 && (
        <p className="text-caption text-faint">
          Last looked: {pulses.map((pulse) => `${pulse.title} ${agoLabel(pulse.lastAt)}`).join(' · ')}
        </p>
      )}
    </section>
  );
}
