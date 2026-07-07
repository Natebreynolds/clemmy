/**
 * One draggable card on the Tasks board. Dragging it requests an action
 * (see lib/board intentForDrop); clicking "View trace" opens the live
 * trace drawer. Source-kind chip + status pill + relative age + a one-line
 * progress hint.
 */
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { Radio, Archive, Check, X, RotateCcw, Play, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/cn';
import { StatusPill } from '@/components/ui/StatusPill';
import { Button } from '@/components/ui/Button';
import { relativeTime } from '@/lib/inbox';
import { cardTone, sourceLabel, runQueueRef, type BoardButtonIntent, type BoardCard as BoardCardT } from '@/lib/board';
import { RunQueue } from './RunQueue';

const dragActions = new Set(['cancel', 'resume', 'promote']);

function artifactsLine(card: BoardCardT): string {
  const a = card.artifactSummary;
  if (!a) return '';
  return [...a.counts, ...a.files, ...a.urls].slice(0, 3).join(' · ');
}

function continueIntent(card: BoardCardT): BoardButtonIntent {
  return card.sourceKind === 'background' || card.sourceKind === 'execution' ? 'resume' : 'resume_safe';
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
  onAction?: (card: BoardCardT, intent: BoardButtonIntent) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: card.id, data: { card } });
  const tone = cardTone(card);
  const draggable = card.actions.some((a) => dragActions.has(a));
  const artifacts = artifactsLine(card);

  const runAction = (intent: BoardButtonIntent) => {
    if (onAction) onAction(card, intent);
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
        <p className="mt-1 line-clamp-2 text-caption text-muted">{card.progressHint}</p>
      )}

      {card.failureSummary && (
        <p className="mt-2 rounded-sm bg-danger-tint px-2 py-1 text-caption text-danger">
          {card.failureSummary.failedItems > 0
            ? `${card.failureSummary.failedItems} failed item${card.failureSummary.failedItems === 1 ? '' : 's'}`
            : 'Needs review'}
          {card.failureSummary.reason ? ` · ${card.failureSummary.reason}` : ''}
        </p>
      )}

      {artifacts && (
        <p className="mt-2 rounded-sm bg-success-tint px-2 py-1 text-caption text-success">{artifacts}</p>
      )}

      {card.nextSafeAction && (
        <p className="mt-2 line-clamp-2 text-caption text-faint">{card.nextSafeAction}</p>
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

      <div className="mt-2.5 flex items-center justify-between gap-2">
        <StatusPill tone={tone.tone}>
          {card.column === 'running'
            ? <span className="inline-flex items-center gap-1"><Radio className="h-3 w-3 animate-breathe" />{tone.label}</span>
            : tone.label}
        </StatusPill>
        <div className="flex items-center gap-2">
          {onAction && card.primaryAction === 'approve' && (
            <>
              <Button
                size="sm"
                onClick={(e) => { e.stopPropagation(); runAction('approve'); }}
                onPointerDown={(e) => e.stopPropagation()}
                className="h-7 px-2 text-caption"
              >
                <Check className="h-3.5 w-3.5" aria-hidden /> Approve
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={(e) => { e.stopPropagation(); runAction('reject'); }}
                onPointerDown={(e) => e.stopPropagation()}
                className="h-7 px-2 text-caption"
              >
                <X className="h-3.5 w-3.5" aria-hidden /> Reject
              </Button>
            </>
          )}
          {onAction && card.primaryAction === 'retry_failed_items' && (
            <Button
              size="sm"
              onClick={(e) => { e.stopPropagation(); runAction('retry_failed_items'); }}
              onPointerDown={(e) => e.stopPropagation()}
              className="h-7 px-2 text-caption"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Retry
            </Button>
          )}
          {onAction && card.primaryAction === 'continue' && (
            <Button
              size="sm"
              onClick={(e) => { e.stopPropagation(); runAction(continueIntent(card)); }}
              onPointerDown={(e) => e.stopPropagation()}
              className="h-7 px-2 text-caption"
            >
              <Play className="h-3.5 w-3.5" aria-hidden /> Continue
            </Button>
          )}
          {card.primaryAction === 'open_result' && (
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
            View trace
          </button>
        </div>
      </div>
    </div>
  );
}
