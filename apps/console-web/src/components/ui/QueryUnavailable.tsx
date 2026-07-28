import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from './Button';
import { cn } from '@/lib/cn';

/** A failed critical query is not an empty collection. Keep the distinction
 * explicit and give the user a bounded recovery action. */
export function QueryUnavailable({
  title,
  description,
  onRetry,
  className,
}: {
  title: string;
  description?: string;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn('flex flex-col items-center justify-center rounded-xl border border-warning/40 bg-warning-tint/40 px-6 py-12 text-center', className)}
    >
      <AlertTriangle className="mb-3 h-7 w-7 text-warning" aria-hidden />
      <h3 className="text-h3 text-fg">{title}</h3>
      {description && <p className="mt-1 max-w-md text-body text-muted">{description}</p>}
      <Button variant="secondary" className="mt-4" onClick={onRetry}>
        <RefreshCw className="h-4 w-4" aria-hidden /> Retry
      </Button>
    </div>
  );
}
