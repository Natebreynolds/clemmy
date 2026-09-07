import type { ReactNode } from 'react';

/**
 * One labeled block of the Customize sheet: the small section label the
 * mockup uses, an optional one-line hint beside it, and a hairline card of
 * 36px rows underneath.
 */
export function CustomizeSection({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <h3 className="text-small font-semibold text-muted">{label}</h3>
        {hint && <span className="text-caption text-faint">{hint}</span>}
      </div>
      <div className="overflow-hidden rounded-md border border-border bg-surface">{children}</div>
    </section>
  );
}
