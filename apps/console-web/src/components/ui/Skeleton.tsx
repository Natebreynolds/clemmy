import { cn } from '@/lib/cn';

/** Loading placeholder that reserves space (no layout shift). */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-md', className)} aria-hidden />;
}
