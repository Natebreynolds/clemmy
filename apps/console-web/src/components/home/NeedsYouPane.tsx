import { attentionWorkTitle, groupAttentionReports } from '@clem/chat-engine';
import { useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, AlertCircle, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { answerInboxQuestion, dismissInboxItem, listInboxQuestions, presentInboxQuestion, snoozeNeedsYou, type InboxQuestionRow } from '@/lib/inbox';
import { presentAttentionItem } from '@/lib/attention-presentation';
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
import { ProjectLabelTag } from '@/components/projects/ProjectLabelTag';
import { useProjectLabels } from '@/lib/project-labels';

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
export function AnswerRow({
  question,
  busy,
  onAnswer,
  placeholder = 'Answer so she can carry on…',
  value,
  onValueChange,
  autoFocus,
}: {
  question?: InboxQuestionRow;
  busy: boolean;
  onAnswer: (text: string) => void;
  placeholder?: string;
  /** A draft the caller keeps, so it survives the row closing or a refresh. */
  value?: string;
  onValueChange?: (text: string) => void;
  autoFocus?: boolean;
}) {
  const [ownDraft, setOwnDraft] = useState('');
  const draft = value ?? ownDraft;
  const setDraft = onValueChange ?? setOwnDraft;
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
        autoFocus={autoFocus}
        aria-label="Your answer"
        placeholder={placeholder}
        className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-2.5 text-small text-fg outline-none placeholder:text-faint focus:border-border-strong disabled:opacity-50"
      />
      <Button type="submit" size="sm" className="h-8 px-3 text-small" disabled={busy || !draft.trim()}>
        {busy ? 'Sending…' : 'Send'}
      </Button>
    </form>
  );
}


interface RowState {
  generation?: string;
  presentationSettled?: boolean;
  busy?: 'snooze' | 'dismiss' | 'answer';
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
 * NEEDS YOU — the command center's list, rendered as decisions. An approval
 * can be approved inline; "Not now" sets it aside (it stays pending in Needs
 * you — it used to decline it for good). Declining and every plan are
 * reviewed where the Inbox shows the draft and the steps.
 */
export function NeedsYouPane({
  items,
  total,
  loading,
  error,
  onRetry,
  headingId,
  layout = 'list',
  maxRows = MAX_ROWS,
  lead,
  leadCount = 0,
}: {
  /** Rows that lead this list on Today (Clem's own asks), counted in its
   *  one number. */
  lead?: ReactNode;
  leadCount?: number;
  items: readonly HomeFeedItem[];
  /** The one needs-you count (the sidebar's number); the list shows the
   *  first few of those items. */
  total?: number;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  headingId: string;
  /** A stacked list (a tile, a rail) or a row of cards you act on in place. */
  layout?: 'list' | 'strip';
  maxRows?: number;
}) {
  const qc = useQueryClient();
  const presentationLocks = useRef(new Set<string>());
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const currentRowState = (key: string, item: HomeFeedItem): RowState => {
    const saved = rows[key];
    const generation = item.questionId ? questionFor(item.questionId)?.lifecycle?.generation : item.lifecycle?.generation;
    return (item.attentionKey || item.questionId && saved?.generation) && saved?.generation !== generation ? {} : saved ?? {};
  };
  // One question open at a time; a typed answer survives closing it.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const settle = () => {
    for (const key of ['command-center', 'needs-you-summary', 'approvals', 'approvals-count', 'plan-proposals', 'notifications', 'inbox-questions', 'inbox-question-presentations', 'inbox-attention-presentations', 'home-from-clem', 'working-now-badge']) {
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

  const snooze = async (key: string, item: HomeFeedItem) => {
    const generation = item.questionId ? questionFor(item.questionId)?.lifecycle?.generation : item.attentionKey ? item.lifecycle?.generation : undefined;
    const lockKey = item.attentionKey ? `${key}:${generation}` : key;
    if ((!item.snoozeKey && !item.questionId && !item.attentionKey) || currentRowState(key, item).busy || presentationLocks.current.has(lockKey)) return;
    if (item.attentionKey && !item.lifecycle?.generation) return;
    presentationLocks.current.add(lockKey);
    setRows((prev) => ({ ...prev, [key]: { busy: 'snooze', generation } }));
    try {
      if (item.questionId) await presentInboxQuestion(item.questionId, 'defer', questionFor(item.questionId)?.lifecycle?.generation);
      else if (item.attentionKey) await presentAttentionItem(item.attentionKey, 'defer', item.lifecycle!.generation);
      else await snoozeNeedsYou(item.snoozeKey!);
      setRows((prev) => generation && prev[key]?.generation !== generation ? prev : ({
        ...prev,
        [key]: item.questionId || item.attentionKey ? { generation, presentationSettled: true }
          : { notice: { tone: 'success', text: 'Set aside. It’s waiting in Inbox when you’re ready.' } },
      }));
    } catch (err) {
      setRows((prev) => generation && prev[key]?.generation !== generation ? prev : ({
        ...prev,
        [key]: {
          generation, notice: {
            tone: 'error',
            text: err instanceof Error && err.message.trim() ? err.message : 'Couldn’t set this aside.',
          },
        },
      }));
    } finally {
      presentationLocks.current.delete(lockKey);
      settle();
    }
  };

  const dismiss = async (key: string, item: HomeFeedItem) => {
    const generation = item.questionId ? questionFor(item.questionId)?.lifecycle?.generation : item.attentionKey ? item.lifecycle?.generation : undefined;
    const lockKey = item.attentionKey ? `${key}:${generation}` : key;
    if ((!item.questionId && !item.attentionKey && (!item.dismissKind || !item.dismissId)) || currentRowState(key, item).busy || presentationLocks.current.has(lockKey)) return;
    if (item.attentionKey && !item.lifecycle?.generation) return;
    presentationLocks.current.add(lockKey);
    setRows((prev) => ({ ...prev, [key]: { busy: 'dismiss', generation } }));
    try {
      if (item.questionId) await presentInboxQuestion(item.questionId, 'dismiss', questionFor(item.questionId)?.lifecycle?.generation);
      else if (item.attentionKey) await presentAttentionItem(item.attentionKey, 'dismiss', item.lifecycle!.generation);
      else await dismissInboxItem(item.dismissKind!, item.dismissId!);
      setRows((prev) => generation && prev[key]?.generation !== generation ? prev : ({ ...prev, [key]: { generation, ...(item.questionId || item.attentionKey ? { presentationSettled: true } : {}) } }));
    } catch (err) {
      setRows((prev) => generation && prev[key]?.generation !== generation ? prev : ({
        ...prev,
        [key]: { generation, notice: { tone: 'error', text: err instanceof Error && err.message.trim() ? err.message : 'Couldn’t dismiss this.' } },
      }));
    } finally {
      presentationLocks.current.delete(lockKey);
      settle();
    }
  };

  const grouped = groupAttentionReports(items, item => ({ id: needsYouKey(item, items.indexOf(item)),
    attentionKey: item.attentionKey, generation: item.lifecycle?.generation, protected: Boolean(item.questionId || needsYouDecision(item)) }));
  const visibleGroups = grouped.slice(0, maxRows);
  const visible = visibleGroups.flatMap(group => group.reports);
  // Which project each row belongs to, by the session that asked.
  const projectOf = useProjectLabels(visible);
  const strip = layout === 'strip' && !loading && !error && visible.length > 0;
  // A function, not a component: the rows keep their state (a typed answer)
  // across re-renders because the element types never change identity.
  const wrap = (children: ReactNode) => strip
    ? <div className="grid items-stretch gap-3 sm:grid-cols-2 xl:grid-cols-3">{children}</div>
    : <PaneCard>{children}</PaneCard>;
  const rowCard = strip ? 'rounded-md border border-border bg-surface first:border-t' : '';
  const ownCount = typeof total === 'number' ? Math.max(0, total) : new Set(grouped.map(group => group.attentionKey ?? group.id)).size;
  const count = ownCount;
  const overflow = ownCount - visibleGroups.length;

  const renderItem = (item: HomeFeedItem, index: number, presentation = true) => {
              const key = needsYouKey(item, index);
              const state = currentRowState(key, item);
              if (state.presentationSettled) return null;
              const decision = needsYouDecision(item);
              const href = needsYouTarget(item);
              const question = questionFor(item.questionId);
              const when = agoLabel(question?.askedAt ?? item.createdAt);
              const lifecycle = item.questionId ? question?.lifecycle : item.attentionKey ? item.lifecycle : undefined;
              const meta = question?.context ?? item.meta;
              const canDismiss = presentation && (item.questionId ? lifecycle?.canDismiss === true : item.attentionKey
                ? Boolean(lifecycle?.canDismiss && lifecycle.generation) : Boolean(item.dismissKind && item.dismissId));
              // A question is answered here once opened, with its options or a
              // reply box; everything else opens the exact item where its full
              // content is shown. Nothing is approved from a two-line preview.
              const answerable = !decision && Boolean(item.questionId);
              const open = answerable && openKey === key;
              const title = <span className="line-clamp-2">{plainText(question?.question ?? item.title) || 'Pending approval'}</span>;
              return (
                <PaneRow key={key} className={cn('flex-col items-stretch gap-1.5', presentation && rowCard)}>
                  <div className="flex items-start gap-2">
                    {answerable ? (
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => setOpenKey(open ? null : key)}
                        className="min-w-0 flex-1 rounded-sm text-left text-body font-semibold text-fg hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      >
                        {title}
                      </button>
                    ) : (
                      <Link to={href} className="min-w-0 flex-1 rounded-sm text-body font-semibold text-fg hover:text-primary">
                        {title}
                      </Link>
                    )}
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
                  {meta && <p className={cn('text-small text-muted', !open && 'line-clamp-2')}>{plainText(meta, open ? 600 : 160)}</p>}
                  <ProjectLabelTag label={projectOf(item)} link className="self-start" />
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
                  ) : open ? (
                    <div className="flex flex-col gap-2">
                      <AnswerRow
                        question={question}
                        busy={state.busy === 'answer'}
                        value={drafts[key] ?? ''}
                        onValueChange={(text) => setDrafts((all) => ({ ...all, [key]: text }))}
                        autoFocus
                        onAnswer={(text) => void answer(key, item.questionId!, text)}
                      />
                      <Link to={href} className="self-start text-small font-semibold text-muted hover:text-fg">Open in Needs you</Link>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-3 text-small">
                      {!answerable && !decision && item.attentionKey && <Link to={href} className="font-semibold text-primary hover:underline">View reports in Inbox</Link>}
                      {answerable ? (
                        <button type="button" onClick={() => setOpenKey(key)} className="font-semibold text-primary hover:underline">
                          {drafts[key]?.trim() ? 'Finish your answer' : 'Answer'}
                        </button>
                      ) : decision ? (
                        <Link to={href} className="font-semibold text-primary hover:underline">
                          {decision.kind === 'plan' ? 'Review plan' : 'Review'}
                        </Link>
                      ) : null}
                      {presentation && (item.questionId ? lifecycle?.canDefer === true : item.attentionKey ? Boolean(lifecycle?.canDefer && lifecycle.generation) : decision && item.snoozeKey) && (
                        <button
                          type="button"
                          disabled={Boolean(state.busy)}
                          onClick={() => void snooze(key, item)}
                          className="font-semibold text-muted hover:text-fg disabled:opacity-50"
                        >
                          {state.busy === 'snooze' ? 'Setting aside…' : item.questionId || item.attentionKey ? 'Tomorrow' : 'Later'}
                        </button>
                      )}
                    </div>
                  )}
                </PaneRow>
              );
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5">
      <SectionHeader
        id={headingId}
        label="Needs you"
        count={count}
        countTone="muted"
        aside={<Link to="/inbox?tab=needs" className="rounded-sm font-semibold text-primary hover:underline">Open Inbox</Link>}
      />
      {lead}
      {!(leadCount > 0 && !loading && !error && items.length === 0 && ownCount === 0) && wrap(<>
        {loading ? (
          <RowSkeleton rows={2} tall />
        ) : error ? (
          <LoadFailedLine what="what needs you" onRetry={onRetry} />
        ) : items.length === 0 && count === 0 ? (
          <QuietLine>Nothing needs you right now.</QuietLine>
        ) : items.length === 0 ? (
          <PaneRow className="justify-center">
            <Link to="/inbox?tab=needs" className="text-small font-semibold text-primary hover:underline">
              {count === 1 ? 'One thing needs you — open Needs you' : `${count} things need you — open Needs you`}
            </Link>
          </PaneRow>
        ) : (
          <>
            {visibleGroups.map(group => {
              if (group.reports.length === 1) return renderItem(group.reports[0], items.indexOf(group.reports[0]));
              const first = group.reports[0];
              const key = needsYouKey(first, items.indexOf(first));
              const state = currentRowState(key, first);
              if (state.presentationSettled) return null;
              return <details key={group.id} data-attention-group={group.attentionKey} className={cn('px-4 py-3', rowCard)}>
                <summary className="min-h-11 cursor-pointer rounded-sm py-1 text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                  <span className="font-semibold text-fg">{attentionWorkTitle(group.attentionKey, first.title)}</span><span className="ml-2 text-small text-muted">{group.reports.length} reports</span>
                  {group.reports.map((item, index) => <span key={needsYouKey(item, index)} className="mt-1 block text-small text-muted">{plainText(item.meta || item.title, 140)}</span>)}
                </summary>
                <div className="flex flex-wrap gap-3 py-2 text-small">
                  <Link to={needsYouTarget(first)} className="mr-auto font-semibold text-primary hover:underline">View reports in Inbox</Link>
                  {first.lifecycle?.canDefer && <Button size="sm" variant="secondary" disabled={Boolean(state.busy)} onClick={() => void snooze(key, first)}>Tomorrow</Button>}
                  {first.lifecycle?.canDismiss && <Button size="sm" variant="ghost" disabled={Boolean(state.busy)} onClick={() => void dismiss(key, first)}>Dismiss</Button>}
                </div>
                {group.reports.map((item, index) => renderItem(item, index, false))}
              </details>;
            })}
            {overflow > 0 && !strip && (
              <PaneRow className="justify-center">
                <Link to="/inbox?tab=needs" className="text-small font-semibold text-primary hover:underline">
                  See all requests in Inbox
                </Link>
              </PaneRow>
            )}
          </>
        )}
      </>)}
    </section>
  );
}
