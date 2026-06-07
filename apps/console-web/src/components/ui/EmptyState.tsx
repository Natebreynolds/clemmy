import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Friendly empty state: the dog mascot + a plain title + a teaching line
 * + one optional primary action. Used instead of bare blank screens.
 */
export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-16 text-center', className)}>
      <img
        src="/console/icon.png"
        alt=""
        width={56}
        height={56}
        className="mb-4 rounded-md opacity-90"
        style={{ imageRendering: 'pixelated' }}
        aria-hidden
      />
      <h3 className="text-h3 text-fg">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-body text-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
