/**
 * One draggable card on the Tasks board. Dragging it requests an action
 * (see lib/board intentForDrop); clicking "View trace" opens the live
 * trace drawer. Source-kind chip + status pill + relative age + a one-line
 * progress hint.
 */
import { useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { Radio, Archive, Check, X, RotateCcw, Play, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/cn';
import { StatusPill } from '@/components/ui/StatusPill';
import { Button } from '@/components/ui/Button';
import { relativeTime } from '@/lib/inbox';
import {
  cardTone,
  isWorkflowCatchupCard,
  pendingActionReviewFacts,
  sourceLabel,
  runQueueRef,
  workflowCatchupReadinessFacts,
  type BoardButtonIntent,
  type BoardCard as BoardCardT,
} from '@/lib/board';
import { evidenceChips, blockerSummary } from '@/lib/work-status';
import { stripInlineMarkdown } from '@/lib/markdown-text';
import { RunQueue } from './RunQueue';

const dragActions = new Set(['cancel', 'resume', 'promote']);

function artifactsLine(card: BoardCardT): string {
  const a = card.artifactSummary;
  if (!a) return '';
  // A raw Salesforce URL is 80+ unbroken chars — show the hostname; the full
  // link lives in the trace drawer. Dedupe: recurring runs repeated the same
  // count three times ("accounts: 15 · accounts: 15 · accounts: 15").
  const urlLabel = (u: string) => {
    try { return new URL(u).hostname.replace(/^www\./, ''); }
    catch { return u.length > 40 ? `${u.slice(0, 39)}…` : u; }
  };
  const parts = [...new Set([
    ...a.counts,
    ...a.files.map((f) => f.split('/').pop() || f),
    ...a.urls.map(urlLabel),
  ])];
  return parts.slice(0, 3).join(' · ');
}

/** The red box adds nothing when its reason just repeats the card's own
 *  progress hint (both are derived from the same output preview). */
function failureReasonIsRedundant(card: BoardCardT): boolean {
  const reason = card.failureSummary?.reason ?? '';
  const hint = card.progressHint ?? '';
  if (!reason || !hint) return false;
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const a = norm(reason);
  const b = norm(hint);
  const probe = Math.min(40, a.length, b.length);
  return probe > 0 && a.slice(0, probe) === b.slice(0, probe);
}

function continueIntent(card: BoardCardT): BoardButtonIntent {
  return card.sourceKind === 'background' || card.sourceKind === 'execution' || card.sourceKind === 'schedule'
    ? 'resume'
    : 'resume_safe';
}

export function BoardCard({
  card,
  onOpen,
  onArchive,
  onAction,
}: {
  card: BoardCardT;
  onOpen: (card: BoardCardT) => void;
  onArchive?: (card: BoardCardT) => void;
  onAction?: (card: BoardCardT, intent: BoardButtonIntent) => void | Promise<void>;
}) {
  const [busyIntent, setBusyIntent] = useState<BoardButtonIntent | null>(null);
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: card.id,
    data: { card },
    disabled: busyIntent !== null,
  });
  const tone = cardTone(card);
  const draggable = busyIntent === null && card.actions.some((a) => dragActions.has(a));
  const artifacts = artifactsLine(card);
  const pendingActionReview = card.pendingAction
    ? pendingActionReviewFacts(card.pendingAction)
    : null;
  const isCatchup = isWorkflowCatchupCard(card);
  const catchupReadiness = workflowCatchupReadinessFacts(card);

  const runAction = async (intent: BoardButtonIntent) => {
    if (!onAction || busyIntent !== null) return;
    setBusyIntent(intent);
    try {
      await onAction(card, intent);
    } finally {
      setBusyIntent(null);
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(
        'group rounded-md border border-border bg-surface p-3 shadow-xs',
        isDragging && 'opacity-50',
        draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
      )}
      {...(draggable ? { ...listeners, ...attributes } : {})}
      // The whole card opens the live trace (the subtitle promises "click a card
      // to watch it live"). Drag is separated by the 6px PointerSensor threshold;
      // inner action buttons stopPropagation so they don't also open the drawer.
      onClick={() => onOpen(card)}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="rounded-sm bg-subtle px-1.5 py-0.5 text-caption font-semibold text-muted">{sourceLabel(card.sourceKind)}</span>
          {card.stale && (
            <span
              className="rounded-sm bg-warning-tint px-1.5 py-0.5 text-caption font-semibold text-warning"
              title={card.staleKind === 'parked' ? 'Waiting on you for over a week' : 'Idle for over a week'}
            >
              Stale
            </span>
          )}
        </div>
        <span className="text-caption text-faint">{relativeTime(card.updatedAt)}</span>
      </div>

      <p className="mt-2 line-clamp-2 text-body font-medium text-fg">{card.title}</p>

      {card.progressHint && (
        <p className="mt-1 line-clamp-2 text-caption text-muted">{stripInlineMarkdown(card.progressHint)}</p>
      )}

      {(() => {
        // The durable blocker beats derived failure prose: it names the exact
        // dependency and the exact user action, and says work is saved.
        const blocked = blockerSummary(card.raw.outcomeSnapshot);
        if (blocked) {
          return (
            <div className="mt-2 space-y-1 rounded-sm bg-warning-tint px-2 py-1.5">
              <p className="line-clamp-2 break-words text-caption font-medium text-warning">{blocked.blocker}</p>
              {blocked.nextAction && (
                <p className="line-clamp-2 break-words text-caption text-fg">{blocked.nextAction}</p>
              )}
              {blocked.resumable && (
                <p className="text-caption text-faint">Completed work is saved — Clementine resumes from here.</p>
              )}
            </div>
          );
        }
        if (!card.failureSummary) return null;
        return (
          // line-clamp keeps a verbose failure reason from turning the card into a
          // wall of red — the FULL text lives one click away in the trace drawer.
          <p className="mt-2 line-clamp-3 break-words rounded-sm bg-danger-tint px-2 py-1 text-caption text-danger">
            {card.failureSummary.failedItems > 0
              ? `${card.failureSummary.failedItems} failed item${card.failureSummary.failedItems === 1 ? '' : 's'}`
              : 'Needs review'}
            {card.failureSummary.reason && !failureReasonIsRedundant(card) ? ` · ${stripInlineMarkdown(card.failureSummary.reason)}` : ''}
          </p>
        );
      })()}

      {(() => {
        // Durable evidence chips — counts, verified artifacts, send receipts —
        // straight from the outcome snapshot the harness proved, so completion
        // never rests on prose alone.
        const chips = evidenceChips(card.raw.outcomeSnapshot);
        if (chips.length === 0) return null;
        return (
          <div className="mt-2 flex flex-wrap gap-1">
            {chips.map((chip) => (
              <span key={chip} className="rounded-sm bg-subtle px-1.5 py-0.5 text-caption font-medium text-fg">
                {chip}
              </span>
            ))}
          </div>
        );
      })()}

      {artifacts && (
        <p className="mt-2 line-clamp-2 break-words rounded-sm bg-success-tint px-2 py-1 text-caption text-success">{artifacts}</p>
      )}

      {card.nextSafeAction && (
        <p className="mt-2 line-clamp-2 text-caption text-faint">{card.nextSafeAction}</p>
      )}

      {isCatchup && catchupReadiness.blocked && (
        <div className="mt-2 rounded-sm bg-warning-tint px-2 py-1.5">
          <p className="text-caption font-semibold text-warning">Needs connection/fix before Resume</p>
          <p className="mt-0.5 line-clamp-2 text-caption text-fg">
            {catchupReadiness.blockerMessages[0]
              ?? `${catchupReadiness.blockerCount || 1} required dependency is not ready.`}
          </p>
        </div>
      )}

      {pendingActionReview && (
        <div className="mt-2 space-y-1 rounded-md border border-warning/30 bg-warning-tint px-2.5 py-2 text-caption">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-warning">Exact queued action</span>
            <span className="font-mono text-faint">{pendingActionReview.toolName}</span>
          </div>
          {pendingActionReview.target && (
            <p className="line-clamp-2 break-words text-fg">
              <span className="font-semibold">Target:</span> {pendingActionReview.target}
            </p>
          )}
          {pendingActionReview.risk && (
            <p className="line-clamp-3 break-words text-warning">
              <span className="font-semibold">Risk:</span> {pendingActionReview.risk}
            </p>
          )}
          {pendingActionReview.preview && (
            <p className="line-clamp-4 whitespace-pre-wrap break-words text-muted">
              <span className="font-semibold text-fg">Preview:</span> {pendingActionReview.preview}
            </p>
          )}
          {pendingActionReview.payloadHash && (
            <p className="break-all font-mono text-faint">hash {pendingActionReview.payloadHash}</p>
          )}
        </div>
      )}

      {card.contentPreview && (card.contentPreview.body || card.contentPreview.imageUrl) && (
        <div className="mt-2 overflow-hidden rounded-md border border-border bg-subtle">
          {card.contentPreview.imageUrl && (
            <img
              src={card.contentPreview.imageUrl}
              alt="Draft post image"
              className="max-h-44 w-full object-cover"
              loading="lazy"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />
          )}
          {card.contentPreview.body && (
            <p className="whitespace-pre-wrap px-2.5 py-2 text-caption text-fg line-clamp-[8]">
              {card.contentPreview.body}
            </p>
          )}
        </div>
      )}

      {(() => {
        const ref = runQueueRef(card);
        return ref ? <RunQueue slug={ref.slug} runId={ref.runId} /> : null;
      })()}

      {/* flex-wrap: Approve + Reject + View trace must never clip off the card edge */}
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
        <StatusPill tone={tone.tone}>
          {card.column === 'running'
            ? <span className="inline-flex items-center gap-1"><Radio className="h-3 w-3 animate-breathe" />{tone.label}</span>
            : tone.label}
        </StatusPill>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          {onAction && isCatchup && (
            <>
              <Button
                size="sm"
                disabled={busyIntent !== null}
                title={catchupReadiness.blocked ? 'Resume rechecks these dependencies now.' : undefined}
                onClick={(e) => { e.stopPropagation(); void runAction('resume'); }}
                onPointerDown={(e) => e.stopPropagation()}
                className="h-7 px-2 text-caption"
              >
                <Play className="h-3.5 w-3.5" aria-hidden />
                {busyIntent === 'resume' ? 'Resuming…' : 'Resume run'}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busyIntent !== null}
                onClick={(e) => { e.stopPropagation(); void runAction('skip'); }}
                onPointerDown={(e) => e.stopPropagation()}
                className="h-7 px-2 text-caption"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
                {busyIntent === 'skip' ? 'Skipping…' : 'Skip run'}
              </Button>
            </>
          )}
          {onAction && !isCatchup && card.primaryAction === 'approve' && (
            <>
              <Button
                size="sm"
                disabled={busyIntent !== null}
                onClick={(e) => { e.stopPropagation(); void runAction('approve'); }}
                onPointerDown={(e) => e.stopPropagation()}
                className="h-7 px-2 text-caption"
              >
                <Check className="h-3.5 w-3.5" aria-hidden />
                {busyIntent === 'approve' ? 'Approving…' : 'Approve'}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busyIntent !== null}
                onClick={(e) => { e.stopPropagation(); void runAction('reject'); }}
                onPointerDown={(e) => e.stopPropagation()}
                className="h-7 px-2 text-caption"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
                {busyIntent === 'reject' ? 'Rejecting…' : 'Reject'}
              </Button>
            </>
          )}
          {onAction && !isCatchup && card.primaryAction === 'retry_failed_items' && (
            <Button
              size="sm"
              disabled={busyIntent !== null}
              onClick={(e) => { e.stopPropagation(); void runAction('retry_failed_items'); }}
              onPointerDown={(e) => e.stopPropagation()}
              className="h-7 px-2 text-caption"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Retry
            </Button>
          )}
          {onAction && !isCatchup && card.primaryAction === 'continue' && (
            <Button
              size="sm"
              disabled={busyIntent !== null}
              onClick={(e) => { e.stopPropagation(); void runAction(continueIntent(card)); }}
              onPointerDown={(e) => e.stopPropagation()}
              className="h-7 px-2 text-caption"
            >
              <Play className="h-3.5 w-3.5" aria-hidden /> Continue
            </Button>
          )}
          {!isCatchup && card.primaryAction === 'open_result' && (
            <Button
              size="sm"
              variant="secondary"
              onClick={(e) => { e.stopPropagation(); onOpen(card); }}
              onPointerDown={(e) => e.stopPropagation()}
              className="h-7 px-2 text-caption"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Result
            </Button>
          )}
          {onArchive && card.actions.includes('archive') && (
            <button
              onClick={(e) => { e.stopPropagation(); onArchive(card); }}
              onPointerDown={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-caption font-semibold text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-fg focus:opacity-100"
              title="Archive (recoverable)"
            >
              <Archive className="h-3.5 w-3.5" aria-hidden /> Archive
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onOpen(card); }}
            onPointerDown={(e) => e.stopPropagation()}
            className="text-caption font-semibold text-faint transition-colors hover:text-primary hover:underline"
          >
            {isCatchup ? 'Review' : 'View trace'}
          </button>
        </div>
      </div>
    </div>
  );
}
