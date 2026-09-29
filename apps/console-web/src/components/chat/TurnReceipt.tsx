/**
 * The last lines under an answer: what she made and changed, whether it was
 * checked, which models did the work and the checking, and what the turn
 * touched.
 *
 * Every fact here is read from the turn's own events. "Checked" appears only
 * when a review passed; a turn whose reviewer never ran says so, because an
 * unchecked answer must not borrow a pass. A card for work outside Clem
 * appears only for writes the provider confirmed.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, Check, CheckCircle2, Copy, FileText, Lock, Mail, PenLine, Repeat, Send, Sparkles, Workflow } from 'lucide-react';
import {
  outsideWorkCards, projectPagePlace, projectPageTitle, turnByline, turnModelOffer, turnReview, workflowCardLevels, workflowCards,
  type ModelRuleOffer, type OutsideWorkCard, type WorkflowCardData,
} from '@clem/chat-engine';
import { cn } from '@/lib/cn';
import { answerModelRuleOffer } from '@/lib/chat';
import type { ActivityItem } from '@/lib/useChat';
import type { TerminalFacts } from '@clem/chat-engine';
import { openFile, resolveDeliverablePath } from '@/lib/files';
import { findSessionPage, isPageName, pageViewerPath, type ProjectPageView } from '@/lib/projects';
import { TurnEvidenceLine } from '@/components/chat/TurnEvidenceLine';

/** A file she saved this turn, as something you can open. The harness names
 *  the latest file by basename; the path is resolved on demand and the button
 *  disappears when no single file matches. */
function DeliverableCard({ row, sessionId }: { row: ActivityItem; sessionId?: string }) {
  const file = row.deliverable;
  const [state, setState] = useState<'idle' | 'working' | 'unavailable'>('idle');
  const [problem, setProblem] = useState('');
  // A page written into a linked local project lies outside Clem's own
  // files, where Open cannot reach. It is looked at in the project's viewer.
  const [page, setPage] = useState<{ projectId: string; page: ProjectPageView } | null>(null);
  const name = file?.name ?? '';
  const folder = file?.dir ?? '';
  useEffect(() => {
    let current = true;
    setPage(null);
    if (!sessionId || !isPageName(name)) return undefined;
    void findSessionPage(sessionId, name, folder).then((found) => { if (current) setPage(found); });
    return () => { current = false; };
  }, [sessionId, name, folder]);
  if (!file) return null;
  const count = row.count ?? 1;
  if (page) {
    const title = projectPageTitle(page.page);
    return (
      <div className="flex min-w-0 items-center gap-3 rounded-md border border-border bg-surface px-3 py-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-success-tint text-success">
          <FileText className="h-[18px] w-[18px]" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-small font-semibold text-fg" title={title}>{title}</span>
          <span className="truncate text-caption text-faint" title={projectPagePlace(page.page)}>{projectPagePlace(page.page)}</span>
        </span>
        <Link
          to={pageViewerPath(page.projectId, page.page.id)}
          aria-label={`View the page ${title}`}
          className="shrink-0 rounded-sm border border-border-strong px-3 py-1 text-caption font-semibold text-fg transition-colors hover:bg-subtle active:scale-press"
        >
          View
        </Link>
      </div>
    );
  }
  const open = () => {
    setState('working');
    setProblem('');
    void resolveDeliverablePath(file.name, file.dir)
      .then(async (resolved) => {
        if (!resolved) { setState('unavailable'); return; }
        const result = await openFile(resolved);
        setState('idle');
        if (!result.ok) setProblem(result.reason);
      })
      .catch(() => setState('unavailable'));
  };
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-md border border-border bg-surface px-3 py-2.5">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-success-tint text-success">
        <FileText className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-small font-semibold text-fg" title={file.name}>{file.name}</span>
        <span className="truncate text-caption text-faint">
          {problem || (count > 1 ? `Latest of ${count} files saved` : 'Saved to your files')}
        </span>
      </span>
      {state !== 'unavailable' && (
        <button
          type="button"
          onClick={open}
          disabled={state === 'working'}
          className="shrink-0 rounded-sm border border-border-strong px-3 py-1 text-caption font-semibold text-fg transition-colors hover:bg-subtle disabled:opacity-60 active:scale-press"
        >
          {state === 'working' ? 'Opening…' : 'Open'}
        </button>
      )}
    </div>
  );
}

/** Something the turn changed in another app, confirmed by that app. Open
 *  goes to the app itself: the provider returns no link to the exact item. */
function OutsideWorkCardView({ card }: { card: OutsideWorkCard }) {
  const Icon = card.kind.startsWith('draft') ? PenLine : card.kind === 'message_sent' ? Mail : Send;
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-md border border-border bg-surface px-3 py-2.5">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-info-tint text-info">
        <Icon className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-small font-semibold text-fg" title={card.title}>{card.title}</span>
        <span className="truncate text-caption text-faint" title={card.subtitle}>{card.subtitle}</span>
      </span>
      {card.appUrl && (
        <a
          href={card.appUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${card.app ?? 'the app'}`}
          className="shrink-0 rounded-sm border border-border-strong px-3 py-1 text-caption font-semibold text-fg transition-colors hover:bg-subtle active:scale-press"
        >
          Open
        </a>
      )}
    </div>
  );
}

/** A workflow she created or changed this turn, drawn from the saved
 *  definition: the step chain by dependency level, with the steps that
 *  changed marked, and Open to the workflow's own page. */
function WorkflowCardView({ card }: { card: WorkflowCardData }) {
  const levels = workflowCardLevels(card);
  const changed = new Set(card.changedStepIds);
  const added = new Set(card.addedStepIds);
  const changedCount = card.changedStepIds.length;
  const subtitle = card.op === 'created'
    ? `${card.steps.length} step${card.steps.length === 1 ? '' : 's'} · ${card.enabled ? 'on' : 'off until you turn it on'}`
    : changedCount === 0
      ? (card.removedStepIds.length > 0 ? `${card.removedStepIds.length} step${card.removedStepIds.length === 1 ? '' : 's'} removed` : 'Settings changed · steps as before')
      : `${changedCount} step${changedCount === 1 ? '' : 's'} changed${card.removedStepIds.length > 0 ? `, ${card.removedStepIds.length} removed` : ''}${card.enabled ? '' : ' · off until its test passes'}`;
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md border border-border bg-surface px-3 py-2.5 sm:col-span-2">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-primary-tint text-primary">
          <Workflow className="h-[18px] w-[18px]" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-small font-semibold text-fg" title={card.name}>{card.name}</span>
          <span className="truncate text-caption text-faint">{subtitle}</span>
        </span>
        <Link
          to={`/automate/${encodeURIComponent(card.name)}`}
          className="shrink-0 rounded-sm border border-border-strong px-3 py-1 text-caption font-semibold text-fg transition-colors hover:bg-subtle active:scale-press"
        >
          Open to edit
        </Link>
      </div>
      {card.steps.length > 0 ? (
        <div className="flex items-center gap-1 overflow-x-auto pb-0.5" aria-label="Steps">
          {levels.map((level, i) => (
            <div key={i} className="flex items-center gap-1">
              {i > 0 ? <span className="text-faint" aria-hidden>→</span> : null}
              <div className="flex flex-col gap-1">
                {level.map((step) => (
                  <span
                    key={step.id}
                    title={`${step.id}: ${step.label}`}
                    className={cn(
                      'inline-flex max-w-[160px] items-center gap-1 whitespace-nowrap rounded-sm border px-2 py-0.5 text-caption font-medium',
                      changed.has(step.id) ? 'border-primary bg-primary-tint text-primary' : 'border-border bg-canvas text-fg',
                    )}
                  >
                    <span className="truncate">{step.label}</span>
                    {step.approval ? <Lock className="h-3 w-3 shrink-0" aria-hidden /> : null}
                    {step.forEach ? <Repeat className="h-3 w-3 shrink-0" aria-hidden /> : null}
                    {step.effect === 'send' ? <Send className="h-3 w-3 shrink-0" aria-hidden /> : null}
                    {added.has(step.id) ? <span className="text-[10px] uppercase">new</span> : null}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** "Use <model> for <kind of work> from now on?" — asked once, after a turn
 *  where the owner named a model for one part of the work. Save writes the
 *  same rule Settings → Models shows; nothing changes until the owner taps. */
function ModelRuleOfferCard({ offer, sessionId }: { offer: ModelRuleOffer; sessionId: string }) {
  const [answer, setAnswer] = useState<'save' | 'dismiss' | undefined>(offer.resolved);
  const [state, setState] = useState<'idle' | 'working'>('idle');
  const [problem, setProblem] = useState('');
  if (answer === 'dismiss') return null;
  const respond = (action: 'save' | 'dismiss') => {
    setState('working');
    setProblem('');
    void answerModelRuleOffer(sessionId, offer.offerId, action)
      .then((result) => { setAnswer(result.action); setState('idle'); })
      .catch((err: unknown) => {
        setState('idle');
        setProblem(err instanceof Error && err.message ? err.message : 'That did not save. Try again, or set it in Settings → Models.');
      });
  };
  if (answer === 'save') {
    return (
      <div className="flex min-w-0 items-center gap-2 text-caption text-muted" role="status">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
        <span className="truncate">{offer.modelName} will do {offer.intent} from now on. Change it in Settings → Models.</span>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3 rounded-md border border-border bg-surface px-3 py-2.5">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-primary-tint text-primary">
        <Sparkles className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="text-small font-semibold text-fg">Use {offer.modelName} for {offer.intent} from now on?</span>
        <span className="text-caption text-faint">{problem || 'It will show in Settings → Models, where you can change it.'}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => respond('dismiss')}
          disabled={state === 'working'}
          className="rounded-sm border border-border-strong px-3 py-1 text-caption font-semibold text-fg transition-colors hover:bg-subtle disabled:opacity-60 active:scale-press"
        >
          Just this once
        </button>
        <button
          type="button"
          onClick={() => respond('save')}
          disabled={state === 'working'}
          className="rounded-sm bg-primary px-3 py-1 text-caption font-semibold text-primary-fg transition-colors hover:bg-primary-hover disabled:opacity-60 active:scale-press"
        >
          {state === 'working' ? 'Saving…' : 'Save for next time'}
        </button>
      </span>
    </div>
  );
}

function CopyAnswer({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  if (!text.trim()) return null;
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }).catch(() => { /* the answer stays selectable on the page */ });
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'Copied' : 'Copy answer'}
      title={copied ? 'Copied' : 'Copy answer'}
      className="grid h-7 w-7 place-items-center rounded-sm text-faint transition-colors hover:bg-subtle hover:text-fg"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-success" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
    </button>
  );
}

/** Changes the provider confirmed in other apps, one card per app and kind.
 *  They show the moment a write is confirmed, while the answer is still being
 *  written and checked: once something has gone out, the owner sees it right
 *  away. The finished receipt keeps them in the same place. */
export function OutsideWorkCards({ activity, children }: { activity?: ActivityItem[]; children?: ReactNode }) {
  const outside = outsideWorkCards(activity);
  const workflows = workflowCards(activity);
  if (outside.length === 0 && workflows.length === 0 && !children) return null;
  return (
    <div className="grid gap-2.5 sm:grid-cols-2">
      {workflows.map((card) => <WorkflowCardView key={card.slug} card={card} />)}
      {outside.map((card) => <OutsideWorkCardView key={card.key} card={card} />)}
      {children}
    </div>
  );
}

export function TurnReceipt({
  activity,
  terminal,
  text,
  sessionId,
}: {
  activity?: ActivityItem[];
  terminal?: TerminalFacts;
  text: string;
  sessionId?: string;
}) {
  const review = turnReview(activity);
  const byline = turnByline(activity);
  const saved = activity?.find((row) => row.id === 'deliverables' && row.deliverable);
  const offer = turnModelOffer(activity);
  return (
    <>
      <OutsideWorkCards activity={activity}>{saved ? <DeliverableCard row={saved} sessionId={sessionId} /> : null}</OutsideWorkCards>
      {offer && sessionId && <ModelRuleOfferCard key={offer.offerId} offer={offer} sessionId={sessionId} />}
      <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 text-caption text-faint">
        {review === 'checked' && (
          <span className="inline-flex items-center gap-1 font-semibold text-success">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Checked
          </span>
        )}
        {review === 'unchecked' && (
          <span className="inline-flex items-center gap-1 font-medium text-warning" title="The reviewer was unavailable, so this answer was not checked.">
            <AlertCircle className="h-3.5 w-3.5" aria-hidden /> Not checked
          </span>
        )}
        {review === 'rejected' && (
          <span className="inline-flex items-center gap-1 font-medium text-warning" title="The last review did not accept this answer.">
            <AlertCircle className="h-3.5 w-3.5" aria-hidden /> Didn’t pass review
          </span>
        )}
        {byline && <span className="text-muted">{byline}</span>}
        <TurnEvidenceLine terminal={terminal} activity={activity} inline />
        <span className="ml-auto flex items-center gap-2 opacity-0 transition-opacity duration-base group-hover/turn:opacity-100 group-focus-within/turn:opacity-100">
          <CopyAnswer text={text} />
        </span>
      </div>
    </>
  );
}
