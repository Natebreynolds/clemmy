/**
 * One droppable column on the Tasks board. Highlights green when a valid
 * drop is hovering (the dragged card allows an action that targets this
 * column) and red when the drop would be rejected.
 */
import { useDroppable } from '@dnd-kit/core';
import { cn } from '@/lib/cn';
import { BoardCard } from './BoardCard';
import { intentForDrop, type BoardButtonIntent, type BoardCard as BoardCardT, type BoardColumnId } from '@/lib/board';

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
  const validHover = activeCard && isOver ? intentForDrop(activeCard, id) !== null : null;
  const showReject = activeCard && isOver && activeCard.column !== id && validHover === null;

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
          cards.map((card) => (
            <BoardCard key={card.id} card={card} onOpen={onOpen} onArchive={onArchive} onAction={onAction} />
          ))
        )}
      </div>
    </div>
  );
}
