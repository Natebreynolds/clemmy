/**
 * One droppable column on the Tasks board. Highlights green when a valid
 * drop is hovering (the dragged card allows an action that targets this
 * column) and red when the drop would be rejected.
 */
import { useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { cn } from '@/lib/cn';
import { BoardCard } from './BoardCard';
import { intentForDrop, type BoardButtonIntent, type BoardCard as BoardCardT, type BoardColumnId } from '@/lib/board';

/** A crowded column (a Done pile of 40) reads as clutter, not a queue — show the
 *  newest few and tuck the rest behind an expander. */
const COLUMN_VISIBLE_MAX = 7;

export function BoardColumn({
  id,
  label,
  cards,
  activeCard,
  onOpen,
  onArchive,
  onAction,
}: {
  id: BoardColumnId;
  label: string;
  cards: BoardCardT[];
  activeCard: BoardCardT | null;
  onOpen: (card: BoardCardT) => void;
  onArchive?: (card: BoardCardT) => void;
  onAction?: (card: BoardCardT, intent: BoardButtonIntent) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const [showAll, setShowAll] = useState(false);
  const validHover = activeCard && isOver ? intentForDrop(activeCard, id) !== null : null;
  const showReject = activeCard && isOver && activeCard.column !== id && validHover === null;
  const visible = showAll ? cards : cards.slice(0, COLUMN_VISIBLE_MAX);
  const hidden = cards.length - visible.length;

  return (
    <div className="flex min-w-0 flex-col">
      <div className="mb-2 flex items-center justify-between px-1">
        <h3 className="text-label uppercase tracking-wide text-muted">{label}</h3>
        <span className="rounded-sm bg-subtle px-1.5 py-0.5 text-caption font-semibold text-faint">{cards.length}</span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          'flex min-h-32 flex-1 flex-col gap-2 rounded-lg border border-dashed border-transparent bg-canvas/40 p-2 transition-colors',
          isOver && validHover && 'border-success bg-success-tint/40',
          showReject && 'border-danger bg-danger-tint/30',
        )}
      >
        {cards.length === 0 ? (
          <p className="px-1 py-6 text-center text-caption text-faint">Nothing here</p>
        ) : (
          <>
            {visible.map((card) => (
              <BoardCard key={card.id} card={card} onOpen={onOpen} onArchive={onArchive} onAction={onAction} />
            ))}
            {hidden > 0 && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="rounded-md border border-border/60 bg-surface px-2 py-1.5 text-caption text-muted transition-colors hover:bg-subtle hover:text-fg cursor-pointer"
              >
                Show {hidden} more
              </button>
            )}
            {showAll && cards.length > COLUMN_VISIBLE_MAX && (
              <button
                type="button"
                onClick={() => setShowAll(false)}
                className="rounded-md px-2 py-1 text-caption text-faint transition-colors hover:text-muted cursor-pointer"
              >
                Show fewer
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
