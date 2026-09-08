import type { ReactNode } from 'react';

/**
 * One band of the run page. Elevation is a hairline and a lighter surface, not
 * a shadow stack, so three stacked sections still read as one document.
 */
export function RunSection({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-md border border-border bg-surface">
      <div className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-2.5">
        <h3 className="text-body font-semibold text-fg">{title}</h3>
        {meta ? <span className="shrink-0 text-caption text-muted">{meta}</span> : null}
      </div>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}
