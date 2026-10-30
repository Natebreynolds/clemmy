import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

/** A refresh failure keeps the work visible and offers one clear recovery. */
export function AutomationRefreshNotice({ title, description, onRetry, className }: {
  title: string; description: string; onRetry: () => void; className?: string;
}) {
  return <div role="alert" className={cn('flex flex-wrap items-center gap-3 rounded-md border border-warning/40 px-3 py-2 text-small', className)}>
    <div className="min-w-0 flex-1"><p className="font-medium text-fg">{title}</p><p className="text-muted">{description}</p></div>
    <Button variant="secondary" size="sm" onClick={onRetry}>Retry</Button>
  </div>;
}
