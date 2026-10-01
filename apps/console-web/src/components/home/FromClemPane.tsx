import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { answerInboxQuestion, decidePlanProposal, markNotificationRead } from '@/lib/inbox';
import { recentPulses, type FromClem, type FromClemRow } from '@/lib/from-clem';
import { cn } from '@/lib/cn';
import { agoLabel } from './home-model';
import { AnswerRow } from './NeedsYouPane';
import { LoadFailedLine, PaneCard, PaneRow, RowSkeleton, SectionHeader } from './HomeSection';

interface RowState {
  busy?: 'answer' | 'yes' | 'no' | 'done';
  notice?: { tone: 'success' | 'error'; text: string };
}

/**
 * From Clem: what Clem's heartbeats brought you, in their own words, in one
 * place. What waits on you comes first and is answered right here — in your
 * words for a proposal, yes or no for a suggestion, Done for a finding. With
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
  const rows = data?.rows ?? [];
  const asks = rows.filter((row) => row.asks).length;
  const pulses = recentPulses(data?.pulses ?? []);

  const act = (row: FromClemRow, busy: NonNullable<RowState['busy']>, run: () => Promise<unknown>, success: string) => {
    setStates((all) => ({ ...all, [row.key]: { busy } }));
    run().then(
      () => {
        setStates((all) => ({ ...all, [row.key]: { notice: { tone: 'success', text: success } } }));
        void qc.invalidateQueries({ queryKey: ['home-from-clem'] });
        void qc.invalidateQueries({ queryKey: ['command-center'] });
      },
      (err: unknown) => setStates((all) => ({
        ...all,
        [row.key]: { notice: { tone: 'error', text: err instanceof Error ? err.message : 'That didn’t reach Clem.' } },
      })),
    );
  };

  const actions = (row: FromClemRow, state: RowState) => {
    if (row.answer?.kind === 'words') {
      const questionId = row.answer.questionId;
      return (
        <AnswerRow
          busy={state.busy === 'answer'}
          onAnswer={(text) => {
            if (text.trim()) act(row, 'answer', () => answerInboxQuestion(questionId, text.trim()), 'Sent — she’ll take it from here.');
          }}
        />
      );
    }
    if (row.answer?.kind === 'yes_no') {
      const id = row.answer.planProposalId;
      return (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" className="h-8 px-3 text-small" disabled={Boolean(state.busy)}
            onClick={() => act(row, 'yes', () => decidePlanProposal(id, 'approve'), 'Yes — she’s on it.')}>
            {state.busy === 'yes' ? 'Sending…' : 'Yes'}
          </Button>
          <Button size="sm" variant="secondary" className="h-8 px-3 text-small" disabled={Boolean(state.busy)}
            onClick={() => act(row, 'no', () => decidePlanProposal(id, 'reject'), 'Noted — she won’t.')}>
            No
          </Button>
        </div>
      );
    }
    if (row.done) {
      const id = row.done.notificationId;
      return (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" className="h-8 px-3 text-small" disabled={Boolean(state.busy)}
            onClick={() => act(row, 'done', () => markNotificationRead(id), 'Marked done.')}>
            {state.busy === 'done' ? 'Saving…' : 'Done'}
          </Button>
        </div>
      );
    }
    return null;
  };

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2.5">
      <SectionHeader
        id={headingId}
        label="From Clem"
        count={asks}
        aside={<Link to="/heartbeats" className="rounded-sm font-semibold text-primary hover:underline">How Clem checks in</Link>}
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
            return (
              <PaneRow key={row.key} className="flex-col items-stretch gap-1.5 py-3.5">
                <div className="flex items-center gap-2 text-caption text-faint">
                  <span className="font-semibold text-muted">{row.heartbeatTitle}</span>
                  <span aria-hidden>·</span>
                  <span>{agoLabel(row.at)}</span>
                  {row.asks && <span className="ml-auto font-semibold text-primary">Waiting on you</span>}
                </div>
                <p className="text-body text-fg">{row.text}</p>
                {row.detail && <p className="line-clamp-3 whitespace-pre-line text-small text-muted">{row.detail}</p>}
                {state.notice ? (
                  <p role="status" className={cn('text-small', state.notice.tone === 'error' ? 'text-warning' : 'text-muted')}>
                    {state.notice.text}
                  </p>
                ) : actions(row, state)}
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
