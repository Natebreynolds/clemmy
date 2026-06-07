import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Standard screen container: generous gutters, capped width, optional header. */
export function Page({
  title,
  subtitle,
  actions,
  children,
  width = 'wide',
  className,
}: {
  title?: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  width?: 'wide' | 'reading';
  className?: string;
}) {
  return (
    <div className={cn('mx-auto w-full px-8 py-8', width === 'reading' ? 'max-w-3xl' : 'max-w-6xl', className)}>
      {(title || actions) && (
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            {title && <h2 className="text-h1 text-fg">{title}</h2>}
            {subtitle && <p className="mt-1 text-body-lg text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}
