import type { ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * A 36px card row with a grip on the left. The grip is the drag activator
 * (pointer + keyboard: Space/Enter picks up, arrows move, Esc cancels), so
 * the controls beside it — switches, selects, remove buttons — stay plain
 * clicks. Render inside a dnd-kit SortableContext.
 */
export function CustomizeSortableRow({
  id,
  label,
  muted,
  className,
  children,
}: {
  id: string;
  /** Plain name of the row, for the grip's accessible label. */
  label: string;
  muted?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        'relative flex min-h-9 items-center gap-2.5 border-t border-border bg-surface px-3 text-small text-fg',
        muted && 'text-faint',
        isDragging && 'z-10 rounded-sm border-t-0 shadow-md',
        className,
      )}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${label}`}
        className="-ml-1.5 inline-flex h-7 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-border-strong transition-colors duration-fast hover:text-muted active:cursor-grabbing"
      >
        <GripVertical className="h-4 w-4" aria-hidden />
      </button>
      {children}
    </li>
  );
}
