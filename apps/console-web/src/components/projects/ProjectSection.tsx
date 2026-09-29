/**
 * One section of a project's page: a heading that says what the section is,
 * an optional count of what is waiting, and an action that belongs to it.
 * Sections stack in order of importance; an empty one is a single quiet line.
 */
import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function ProjectSection({
  title,
  count,
  attention,
  action,
  hint,
  children,
  className,
}: {
  title: string;
  /** How many things the section holds, when that is worth a glance. */
  count?: number;
  /** The count is of things waiting on the owner. */
  attention?: boolean;
  action?: ReactNode;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={cn('flex flex-col gap-3', className)}>
      <div className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1">
        <h3 id={headingId} className="text-h3 text-fg">{title}</h3>
        {typeof count === 'number' && count > 0 && (
          <span
            className={cn(
              'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-caption font-bold tabular-nums',
              attention ? 'bg-primary text-primary-fg' : 'bg-subtle text-muted',
            )}
            aria-label={attention ? `${count} waiting on you` : `${count}`}
          >
            {count}
          </span>
        )}
        {action && <div className="ml-auto flex items-center gap-2">{action}</div>}
      </div>
      {hint && <p className="-mt-2 text-small text-muted">{hint}</p>}
      {children}
    </section>
  );
}

/** The one line an empty section says. */
export function QuietNote({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-dashed border-border px-4 py-3 text-small text-muted">{children}</p>;
}

/** An outcome said in the page, where the owner is already looking. */
export function InlineNotice({ tone, children }: { tone: 'error' | 'success' | 'info'; children: ReactNode }) {
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={`text-small ${tone === 'error' ? 'text-danger' : tone === 'success' ? 'text-success' : 'text-muted'}`}
    >
      {children}
    </p>
  );
}
