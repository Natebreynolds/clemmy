import type { HTMLAttributes, ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';

/** The section label — "Needs you", "Running" — with an optional count and a
 *  right-aligned aside. Sentence case: an uppercase tracked-out micro-label is
 *  harder to read at exactly the size where legibility is already thinnest. */
export function SectionHeader({
  label,
  count,
  countTone = 'primary',
  aside,
  id,
}: {
  label: string;
  count?: number;
  countTone?: 'primary' | 'muted';
  aside?: ReactNode;
  id?: string;
}) {
  return (
    <div className="flex min-h-5 items-center gap-2">
      <h2 id={id} className="text-small font-semibold text-muted">{label}</h2>
      {typeof count === 'number' && count > 0 && (
        <span
          className={cn(
            'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-caption font-bold tabular-nums',
            countTone === 'primary' ? 'bg-primary text-primary-fg' : 'bg-subtle text-muted',
          )}
        >
          {count}
        </span>
      )}
      {aside && <div className="ml-auto flex items-center gap-2 text-caption text-faint">{aside}</div>}
    </div>
  );
}

export function PaneCard({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      // Elevation = a hairline plus a lighter surface than the canvas.
      className={cn('flex flex-col overflow-hidden rounded-md border border-border bg-surface', className)}
      {...props}
    />
  );
}

/** One row inside a pane card: hairline above every row but the first. */
export function PaneRow({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex items-center gap-3 border-t border-border px-4 py-3 first:border-t-0', className)}
      {...props}
    />
  );
}

/** A quiet one-line state — the empty pane, never a wall of "nothing here". */
export function QuietLine({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <PaneRow className={cn('justify-center text-small text-faint', className)}>
      {children}
    </PaneRow>
  );
}

/** Loading rows that reserve the pane's height so nothing jumps. */
export function RowSkeleton({ rows = 2, tall = false }: { rows?: number; tall?: boolean }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <PaneRow key={i} className={cn('flex-col items-stretch gap-2', tall ? 'py-3.5' : 'py-3')} aria-hidden>
          <div className="flex items-center gap-3">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="ml-auto h-3 w-12" />
          </div>
          <Skeleton className="h-3 w-3/4" />
          {tall && <Skeleton className="h-8 w-40" />}
        </PaneRow>
      ))}
    </>
  );
}

/** A pane that could not load is not an empty pane. One line + a retry. */
export function LoadFailedLine({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <PaneRow role="alert" className="justify-center gap-2 text-small text-muted">
      <AlertCircle className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
      <span>Couldn’t load {what}.</span>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-sm px-1 font-semibold text-primary transition-colors hover:underline cursor-pointer"
      >
        Retry
      </button>
    </PaneRow>
  );
}

export interface HomeNoticeState {
  tone: 'info' | 'success' | 'error';
  text: string;
  /** Optional trailing action (a Link or button). */
  action?: ReactNode;
}

const NOTICE_ICON = { info: Info, success: CheckCircle2, error: AlertCircle } as const;
const NOTICE_CLASS = {
  info: 'border-info/30 bg-info-tint text-fg',
  success: 'border-success/30 bg-success-tint text-fg',
  error: 'border-danger/30 bg-danger-tint text-fg',
} as const;
const NOTICE_ICON_CLASS = { info: 'text-info', success: 'text-success', error: 'text-danger' } as const;

/** Inline, dismissible outcome line (a workflow started, a decision landed,
 *  a send failed). Lives in the page flow — no floating toast to chase. */
export function HomeNotice({ notice, onDismiss, className }: { notice: HomeNoticeState; onDismiss: () => void; className?: string }) {
  const Icon = NOTICE_ICON[notice.tone];
  return (
    <div
      role="status"
      className={cn('flex items-center gap-2 rounded-sm border px-3 py-2 text-small', NOTICE_CLASS[notice.tone], className)}
    >
      <Icon className={cn('h-4 w-4 shrink-0', NOTICE_ICON_CLASS[notice.tone])} aria-hidden />
      <span className="min-w-0 flex-1">{notice.text}</span>
      {notice.action}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="rounded-sm p-1 text-muted transition-colors hover:bg-hover hover:text-fg cursor-pointer"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
