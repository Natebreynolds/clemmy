import { useContext, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { ShellTitleContext } from '@/lib/shell-title';

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
  // The top bar already names the page; saying it again as a heading is the
  // repeat, so only a title that adds something is shown.
  const shellTitle = useContext(ShellTitleContext);
  const heading = title && title !== shellTitle ? title : undefined;
  return (
    <div className={cn('mx-auto w-full px-4 py-6 sm:px-8 sm:py-8', width === 'reading' ? 'max-w-3xl' : 'max-w-6xl', className)}>
      {(heading || subtitle || actions) && (
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            {heading && <h2 className="text-h1 text-fg">{heading}</h2>}
            {subtitle && <p className={cn('reading text-body-lg text-muted', heading && 'mt-1.5')}>{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2 sm:shrink-0">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}
