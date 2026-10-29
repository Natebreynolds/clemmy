import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, Loader2, X } from 'lucide-react';
import { cardReplyInMotion, getCardReplies, tapOutcomeHeadline, type CardReplyRecord, type FromClemTurnStep } from '@/lib/from-clem';
import { humanToolLabel, isHousekeepingTool } from '@/lib/toolLabels';
import { unifiedChatSessionId } from '@/lib/last-session';
import { cn } from '@/lib/cn';

const toneClass = {
  info: 'text-muted',
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-danger',
} as const;

/** A step as the owner reads it: the operation in plain words. */
export function cardStepLabel(step: Pick<FromClemTurnStep, 'tool'>): string {
  const words = humanToolLabel('work_call', undefined, undefined, step.tool);
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

/** What Clem is doing about what the owner asked on this item: their words,
 *  her steps as they happen, then her answer, or what she still needs. Shown
 *  on the item itself, so a reply never disappears into a thread. */
export function CardRecord({ record, onDismiss, showTitle = false }: { record: CardReplyRecord; onDismiss?: () => void; showTitle?: boolean }) {
  const outcome = record.outcome;
  const headline = tapOutcomeHeadline(outcome);
  const steps = ('steps' in outcome && outcome.steps ? outcome.steps : []).filter((step) => !isHousekeepingTool(step.tool) && cardStepLabel(step));
  const words = 'text' in outcome ? outcome.text : '';
  const sessionId = 'sessionId' in outcome ? outcome.sessionId : null;
  const working = outcome.state === 'working';
  return (
    <div className="rounded-lg border border-border bg-subtle px-3 py-2.5" aria-live="polite" data-testid="card-record">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {showTitle && <p className="mb-1 line-clamp-1 text-small text-muted">{record.title}</p>}
          <p className="text-small text-fg [overflow-wrap:anywhere]"><span className="font-semibold">You: </span>{record.reply}</p>
        </div>
        {onDismiss && !working && (
          <button type="button" onClick={onDismiss} aria-label="Hide this record"
            className="rounded-sm p-1 text-faint hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            <X className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>
      {steps.length > 0 && (
        <ol className="mt-1.5 space-y-0.5" aria-label="What Clem did">
          {steps.map((step, index) => (
            <li key={`${step.tool}-${index}`} className="flex items-center gap-1.5 text-small text-muted">
              {step.done
                ? <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
                : <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />}
              <span className="min-w-0 truncate">{cardStepLabel(step)}</span>
            </li>
          ))}
        </ol>
      )}
      <p className={cn('mt-1.5 flex items-center gap-1.5 text-small font-semibold', toneClass[headline.tone])}>
        {working && steps.length === 0 && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />}
        {headline.text}
      </p>
      {words && <p className="mt-0.5 line-clamp-6 whitespace-pre-wrap text-body text-fg [overflow-wrap:anywhere]">{words}</p>}
      {outcome.state === 'needs_you' && outcome.approvalId ? (
        // The approval card shows exactly what Clem will change; it is where the tap is the approval.
        <Link to={`/inbox?tab=needs&select=${encodeURIComponent(outcome.approvalId)}`}
          className="mt-1 inline-block text-small font-semibold text-primary hover:underline">
          Review and approve
        </Link>
      ) : sessionId && outcome.state !== 'done' && (
        <Link to={`/chat/${encodeURIComponent(unifiedChatSessionId(sessionId))}`}
          className="mt-1 inline-block text-small font-semibold text-primary hover:underline">
          {outcome.state === 'needs_you' ? (outcome.asks === 'approval' ? 'Review and approve' : 'Answer Clem') : 'Open the conversation'}
        </Link>
      )}
    </div>
  );
}

/** The recent records on their own, for a screen that lists items without
 *  carrying each record inside them (Inbox). */
export function RecentCardRecords() {
  const replies = useQuery({
    queryKey: ['from-clem-replies'],
    queryFn: getCardReplies,
    refetchInterval: (query) => (query.state.data?.replies.some(cardReplyInMotion) ? 3_000 : 20_000),
  });
  const records = (replies.data?.replies ?? []).slice(0, 3);
  if (records.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-caption font-semibold uppercase tracking-wide text-faint">Just now</h3>
      {records.map((record) => <CardRecord key={record.runId} record={record} showTitle />)}
    </div>
  );
}
