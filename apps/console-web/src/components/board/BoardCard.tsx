/**
 * One draggable card on the Tasks board. Dragging it requests an action
 * (see lib/board intentForDrop); clicking "View trace" opens the live
 * trace drawer. Source-kind chip + status pill + relative age + a one-line
 * progress hint.
 */
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { Radio } from 'lucide-react';
import { cn } from '@/lib/cn';
import { StatusPill } from '@/components/ui/StatusPill';
import { relativeTime } from '@/lib/inbox';
import { cardTone, sourceLabel, type BoardCard as BoardCardT } from '@/lib/board';

export function BoardCard({ card, onOpen }: { card: BoardCardT; onOpen: (card: BoardCardT) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: card.id, data: { card } });
  const tone = cardTone(card);
  const draggable = card.actions.length > 0;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(
        'group rounded-md border border-border bg-surface p-3 shadow-xs',
        isDragging && 'opacity-50',
        draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
      )}
      {...(draggable ? { ...listeners, ...attributes } : {})}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="rounded-sm bg-subtle px-1.5 py-0.5 text-caption font-semibold text-muted">{sourceLabel(card.sourceKind)}</span>
        <span className="text-caption text-faint">{relativeTime(card.updatedAt)}</span>
      </div>

      <p className="mt-2 line-clamp-2 text-body font-medium text-fg">{card.title}</p>

      {card.progressHint && (
        <p className="mt-1 line-clamp-2 text-caption text-muted">{card.progressHint}</p>
      )}

      <div className="mt-2.5 flex items-center justify-between gap-2">
        <StatusPill tone={tone.tone}>
          {card.column === 'running'
            ? <span className="inline-flex items-center gap-1"><Radio className="h-3 w-3 animate-breathe" />{tone.label}</span>
            : tone.label}
        </StatusPill>
        <button
          onClick={() => onOpen(card)}
          onPointerDown={(e) => e.stopPropagation()}
          className="text-caption font-semibold text-primary opacity-0 transition-opacity group-hover:opacity-100 hover:underline focus:opacity-100"
        >
          View trace
        </button>
      </div>
    </div>
  );
}
