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

/** A receipt names its state and next destination. Its complete request,
 * activity and reply stay readable without repeating a pending approval. */
export function CardRecord({ record, onDismiss, showTitle = false }: { record: CardReplyRecord; onDismiss?: () => void; showTitle?: boolean }) {
  const outcome = record.outcome;
  const headline = tapOutcomeHeadline(outcome);
  const steps = ('steps' in outcome && outcome.steps ? outcome.steps : []).filter((step) => !isHousekeepingTool(step.tool) && cardStepLabel(step));
  const words = 'text' in outcome ? outcome.text : '';
  const sessionId = 'sessionId' in outcome ? outcome.sessionId : null;
  const working = outcome.state === 'working';
  const action = outcome.state === 'needs_you' && outcome.approvalId
    ? { href: `/inbox?tab=needs&select=${encodeURIComponent(outcome.approvalId)}`, label: 'Review and approve' }
    : sessionId ? {
      href: `/chat/${encodeURIComponent(unifiedChatSessionId(sessionId))}`,
      label: outcome.state === 'needs_you' ? outcome.asks === 'approval' ? 'Review and approve' : 'Answer Clem' : 'Open the conversation',
    } : null;
  const activity = (shown = steps) => <ol className="space-y-1" aria-label={working ? 'What Clem is doing' : 'What Clem did'}>
    {shown.map((step, index) => <li key={`${step.tool}-${index}`} className="flex items-start gap-1.5 text-small text-muted">
      {step.done
        ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
        : <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />}
      <span className="min-w-0 break-words">{cardStepLabel(step)}</span>
    </li>)}
  </ol>;
  return (
    <div className="rounded-lg border border-border bg-subtle px-3 py-2.5" aria-live="polite" data-testid="card-record">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          {showTitle && <p className="line-clamp-1 text-small text-muted">{record.title}</p>}
          <p className={cn('flex items-center gap-1.5 text-small font-semibold', toneClass[headline.tone])}>
            {working && steps.length === 0 && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />}
            {outcome.state === 'not_found' ? 'This turn couldn’t be confirmed' : headline.text}
          </p>
        </div>
        {action && <Link to={action.href} className="inline-flex min-h-9 shrink-0 items-center rounded-sm text-small font-semibold text-primary hover:underline">{action.label}</Link>}
        {onDismiss && !working && <button type="button" onClick={onDismiss} aria-label="Hide this record"
          className="rounded-sm p-1 text-faint hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          <X className="h-4 w-4" aria-hidden />
        </button>}
      </div>
      {working && steps.length > 0 && <div className="mt-2">{activity(steps.slice(-3))}</div>}
      <details className="mt-1 text-small">
        <summary className="min-h-9 cursor-pointer py-2 font-medium text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{working ? 'Read request & full activity' : 'Read request, full reply & activity'}</summary>
        <div className="space-y-3 border-t border-border py-3">
          {showTitle && record.title && <p className="whitespace-pre-wrap text-small text-muted [overflow-wrap:anywhere]">{record.title}</p>}
          <p className="whitespace-pre-wrap text-body text-fg [overflow-wrap:anywhere]"><span className="font-semibold">You: </span>{record.reply}</p>
          {steps.length > 0 && activity()}
          {words && <p className="whitespace-pre-wrap text-body text-fg [overflow-wrap:anywhere]">{words}</p>}
          {outcome.state === 'not_found' && <p className="text-small text-muted">{headline.text}</p>}
        </div>
      </details>
    </div>
  );
}

/** Moving and waiting receipts stay visible. Older settled activity stays
 * fully mounted in one counted disclosure, with the latest receipt above it. */
export function CardRecordList({ records, onDismiss }: { records: readonly CardReplyRecord[]; onDismiss?: (record: CardReplyRecord) => void }) {
  if (records.length === 0) return null;
  const current = records.filter(record => record.outcome.state === 'working' || record.outcome.state === 'needs_you');
  const settled = records.filter(record => record.outcome.state !== 'working' && record.outcome.state !== 'needs_you');
  const renderRecord = (record: CardReplyRecord) => <CardRecord key={record.runId} record={record} showTitle onDismiss={onDismiss ? () => onDismiss(record) : undefined} />;
  return <div className="flex flex-col gap-2">
    {current.map(renderRecord)}
    {settled.slice(0, 1).map(renderRecord)}
    {settled.length > 1 && <details className="text-small text-muted">
      <summary className="min-h-9 cursor-pointer py-2 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">Earlier reply activity · {settled.length - 1}</summary>
      <div className="flex flex-col gap-2 pb-2">{settled.slice(1).map(renderRecord)}</div>
    </details>}
  </div>;
}

/** The same receipts on screens where the originating items are not listed. */
export function RecentCardRecords() {
  const replies = useQuery({
    queryKey: ['from-clem-replies'],
    queryFn: getCardReplies,
    refetchInterval: (query) => (query.state.data?.replies.some(cardReplyInMotion) ? 3_000 : 20_000),
  });
  return <CardRecordList records={replies.data?.replies ?? []} />;
}
