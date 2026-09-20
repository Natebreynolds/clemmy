import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Check, CheckCircle2, AlertCircle, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { answerInboxQuestion, decideApproval, decidePlanProposal, dismissInboxItem, listInboxQuestions, type InboxQuestionRow } from '@/lib/inbox';
import { usePoll } from '@/lib/poll';
import { cn } from '@/lib/cn';
import {
  agoLabel,
  needsYouDecision,
  needsYouKey,
  needsYouTarget,
  type HomeFeedItem,
} from './home-model';
import { LoadFailedLine, PaneCard, PaneRow, QuietLine, RowSkeleton, SectionHeader } from './HomeSection';
import { plainText } from '@/components/home/home-model';

const MAX_ROWS = 4;

/**
 * The answer box on a parked run.
 *
 * Options come from the question itself, so a run waiting on "Gmail or
 * Outlook?" is one click, not a typing exercise. When the server says the row
 * is not answerable it gives a reason — show that rather than a dead control,
 * and keep the row's link so the owner can still go to where it can be
 * answered.
 */
function AnswerRow({
  question,
  busy,
  onAnswer,
}: {
  question?: InboxQuestionRow;
  busy: boolean;
  onAnswer: (text: string) => void;
}) {
  const [draft, setDraft] = useState('');
  if (question && !question.answerable) {
    return (
      <p className="text-small text-muted">
        {question.unavailableReason?.trim() || 'This one has to be answered where it was asked.'}
      </p>
    );
  }
  const options = question?.options ?? [];
  if (options.length > 0) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {options.slice(0, 4).map((option) => (
          <Button
            key={option}
            size="sm"
            variant="secondary"
            className="h-8 px-3 text-small"
            disabled={busy}
            onClick={() => onAnswer(option)}
          >
            {option}
          </Button>
        ))}
      </div>
    );
  }
  return (
    <form
      className="flex w-full items-center gap-2"
      onSubmit={(event) => { event.preventDefault(); onAnswer(draft); setDraft(''); }}
    >
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        disabled={busy}
        aria-label="Your answer"
        placeholder="Answer so she can carry on…"
        className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-2.5 text-small text-fg outline-none placeholder:text-faint focus:border-border-strong disabled:opacity-50"
      />
      <Button type="submit" size="sm" className="h-8 px-3 text-small" disabled={busy || !draft.trim()}>
        {busy ? 'Sending…' : 'Send'}
      </Button>
    </form>
  );
}


interface RowState {
  busy?: 'approve' | 'reject' | 'dismiss' | 'answer';
  notice?: { tone: 'success' | 'error'; text: string };
}

/**
 * What the run is actually waiting for.
 *
 * A parked run reaches this pane either way, but only approvals could be
 * settled here: `needsYouDecision` returns null for a question, so a run
 * stopped on "which mailbox should I use?" showed up as a row you could read
 * and not answer. The one thing that would let Clementine carry on was the one
 * thing the pane would not take.
 *
 * `POST /api/console/inbox/questions/:id/answer` has always returned
 * `resuming` when the answer releases a run — the word is in its contract. It
 * also says when an answer must go somewhere else (`requires_origin`) and,
 * per row, whether it is `answerable` at all and why not. All of it goes
 * unused until something asks.
 */

/**
 * NEEDS YOU — the command center's list, rendered as decisions. Inline
 * Approve / Not now appear only where the Inbox already exposes that exact
 * approve/reject call; every other card opens where the Inbox would.
 */
export function NeedsYouPane({
  items,
  loading,
  error,
  onRetry,
  headingId,
}: {
  items: readonly HomeFeedItem[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  headingId: string;
}) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<Record<string, RowState>>({});

  const settle = () => {
    for (const key of ['command-center', 'approvals', 'approvals-count', 'plan-proposals', 'notifications', 'inbox-questions', 'working-now-badge']) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  };

  // Only fetched when a row actually needs it, so a Home with no open
  // questions pays nothing for this.
  const questionIds = items.filter((item) => item.questionId).map((item) => item.questionId!);
  const questions = usePoll(['inbox-questions'], listInboxQuestions, 30_000, { enabled: questionIds.length > 0 });
  const questionFor = (id?: string) => (id ? questions.data?.questions.find((q) => q.id === id) : undefined);

  const answer = async (key: string, questionId: string, text: string) => {
    const body = text.trim();
    if (!body || rows[key]?.busy) return;
    setRows((prev) => ({ ...prev, [key]: { busy: 'answer' } }));
    try {
      const result = await answerInboxQuestion(questionId, body);
      setRows((prev) => ({
        ...prev,
        [key]: {
          notice: {
            tone: 'success',
            // `resuming` is the server saying the answer released a parked run.
            // Say that, rather than a generic acknowledgement.
            text: result.status === 'resuming'
              ? 'Answered — Clementine is picking the run back up.'
              : 'Answered.',
          },
        },
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRows((prev) => ({
        ...prev,
        [key]: {
          notice: {
            tone: 'error',
            text: /authorized origin|requires_origin/i.test(message)
              ? 'This one has to be answered in the conversation that asked it.'
              : /already answered|superseded/i.test(message)
                ? 'Already answered — Clementine has moved on.'
                : message.trim() || 'Couldn’t send that answer.',
          },
        },
      }));
    } finally {
      settle();
    }
  };

  const decide = async (key: string, item: HomeFeedItem, decision: 'approve' | 'reject') => {
    const target = needsYouDecision(item);
    if (!target || rows[key]?.busy) return;
    setRows((prev) => ({ ...prev, [key]: { busy: decision } }));
    try {
      if (target.kind === 'approval') await decideApproval(target.id, decision, { kind: target.approvalKind });
      else await decidePlanProposal(target.id, decision);
      setRows((prev) => ({
        ...prev,
        [key]: {
          notice: {
            tone: 'success',
            text: decision === 'approve' ? 'Approved — Clementine is carrying on.' : 'Declined — this won’t run.',
          },
        },
      }));
    } catch (err) {
      setRows((prev) => ({
        ...prev,
        [key]: {
          notice: {
            tone: 'error',
            text: err instanceof Error && err.message.trim() ? err.message : `Couldn’t ${decision} this.`,
          },
        },
      }));
    } finally {
      settle();
    }
  };

  const dismiss = async (key: string, item: HomeFeedItem) => {
    if (!item.dismissKind || !item.dismissId || rows[key]?.busy) return;
    setRows((prev) => ({ ...prev, [key]: { busy: 'dismiss' } }));
    try {
      await dismissInboxItem(item.dismissKind, item.dismissId);
      setRows((prev) => ({ ...prev, [key]: {} }));
    } catch (err) {
      setRows((prev) => ({
        ...prev,
        [key]: { notice: { tone: 'error', text: err instanceof Error && err.message.trim() ? err.message : 'Couldn’t dismiss this.' } },
      }));
    } finally {
      settle();
    }
  };

  const visible = items.slice(0, MAX_ROWS);
  const overflow = items.length - visible.length;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5">
      <SectionHeader id={headingId} label="Needs you" count={items.length} />
      <PaneCard>
        {loading ? (
          <RowSkeleton rows={2} tall />
        ) : error ? (
          <LoadFailedLine what="what needs you" onRetry={onRetry} />
        ) : items.length === 0 ? (
          <QuietLine>Nothing needs you right now.</QuietLine>
        ) : (
          <>
            {visible.map((item, index) => {
              const key = needsYouKey(item, index);
              const state = rows[key] ?? {};
              const decision = needsYouDecision(item);
              const href = needsYouTarget(item);
              const when = agoLabel(item.createdAt);
              const canDismiss = Boolean(item.dismissKind && item.dismissId);
              return (
                <PaneRow key={key} className="flex-col items-stretch gap-2">
                  <div className="flex items-start gap-2">
                    <Link
                      to={href}
                      className="min-w-0 flex-1 rounded-sm text-body font-semibold text-fg hover:text-primary"
                    >
                      <span className="line-clamp-2">{plainText(item.title) || 'Pending approval'}</span>
                    </Link>
                    {when && <span className="shrink-0 pt-0.5 text-caption text-faint">{when}</span>}
                    {canDismiss && (
                      <button
                        type="button"
                        aria-label="Dismiss — I don’t need this"
                        title="Dismiss — I don’t need this"
                        disabled={Boolean(state.busy)}
                        onClick={() => void dismiss(key, item)}
                        className="-mr-1 -mt-0.5 shrink-0 rounded-sm p-1 text-faint transition-colors hover:bg-hover hover:text-fg disabled:opacity-50 cursor-pointer"
                      >
                        <X className="h-4 w-4" aria-hidden />
                      </button>
                    )}
                  </div>
                  {item.meta && <p className="text-small text-muted">{plainText(item.meta, 160)}</p>}
                  {state.notice ? (
                    <p
                      role="status"
                      className={cn(
                        'inline-flex items-center gap-1.5 text-small',
                        state.notice.tone === 'success' ? 'text-success' : 'text-danger',
                      )}
                    >
                      {state.notice.tone === 'success'
                        ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                        : <AlertCircle className="h-3.5 w-3.5" aria-hidden />}
                      {state.notice.text}
                    </p>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      {!decision && item.questionId && (
                        <AnswerRow
                          question={questionFor(item.questionId)}
                          busy={state.busy === 'answer'}
                          onAnswer={(text) => void answer(key, item.questionId!, text)}
                        />
                      )}
                      {decision && (
                        <>
                          <Button
                            size="sm"
                            className="h-8 px-3 text-small"
                            disabled={Boolean(state.busy)}
                            onClick={() => void decide(key, item, 'approve')}
                          >
                            <Check className="h-3.5 w-3.5" aria-hidden />
                            {state.busy === 'approve' ? 'Approving…' : 'Approve'}
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            className="h-8 px-3 text-small"
                            disabled={Boolean(state.busy)}
                            onClick={() => void decide(key, item, 'reject')}
                          >
                            {state.busy === 'reject' ? 'Declining…' : 'Not now'}
                          </Button>
                        </>
                      )}
                      <Link
                        to={href}
                        className="inline-flex h-8 items-center rounded-md px-3 text-small font-semibold text-muted transition-colors hover:bg-hover hover:text-fg"
                      >
                        {decision ? 'Preview' : 'Open'}
                      </Link>
                    </div>
                  )}
                </PaneRow>
              );
            })}
            {overflow > 0 && (
              <PaneRow className="justify-center">
                <Link to="/inbox?tab=needs" className="text-small font-semibold text-primary hover:underline">
                  See all {items.length} in Inbox
                </Link>
              </PaneRow>
            )}
          </>
        )}
      </PaneCard>
    </section>
  );
}
