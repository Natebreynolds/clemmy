import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { StatusPill } from '@/components/ui/StatusPill';
import { cn } from '@/lib/cn';
import { relativeTime } from '@/lib/inbox';
import { detailHeading, type NeedsYouRowView } from '@/lib/needs-you-list';

/** One compact decision: what, for what work, how current. No forms, no
 *  actions; selecting it opens the one detail where it is read and decided. */
export function DecisionRow({ view, selected, checked, disabled, onToggleCheck, onSelect }: {
  view: NeedsYouRowView;
  selected: boolean;
  checked?: boolean;
  disabled?: boolean;
  onToggleCheck?: () => void;
  onSelect: () => void;
}) {
  const meta = (
    <span className="mt-1 flex min-w-0 items-center gap-2 text-caption text-faint">
      <StatusPill tone={view.state.tone}>{view.state.label}</StatusPill>
      {view.context && <span className="truncate">{view.context}</span>}
      {view.at && <span className="shrink-0">{relativeTime(view.at)}</span>}
    </span>
  );
  const body = (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-body font-medium text-fg">{view.title}</span>
      {view.preview && <span className="mt-0.5 block truncate text-small text-muted">{view.preview}</span>}
      {meta}
    </span>
  );
  const rowClass = cn(
    'flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors',
    selected ? 'bg-primary-tint' : 'hover:bg-hover',
  );
  if (view.href) {
    return <Link to={view.href} className={rowClass}>{body}</Link>;
  }
  return (
    <div className={rowClass} aria-current={selected ? 'true' : undefined}>
      {view.checkable && onToggleCheck && (
        <input type="checkbox" aria-label={`Select “${view.title}” for a batch decision`}
          className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-primary"
          disabled={disabled} checked={Boolean(checked)} onChange={onToggleCheck} />
      )}
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 cursor-pointer text-left focus-visible:outline-none" aria-pressed={selected}>
        {body}
      </button>
    </div>
  );
}

/** The one place a selected decision is read and acted on: a short header,
 *  the content needed to decide, and actions in a footer that stays in reach
 *  however long the content is. Rationale and identifiers go in disclosures. */
export function DecisionFrame({ view, title, aside, children, actions, notice, onBack }: {
  view: Pick<NeedsYouRowView, 'state' | 'context' | 'at'>;
  title: string;
  aside?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  notice?: { tone: 'success' | 'error'; text: string } | null;
  onBack?: () => void;
}) {
  const { heading, body } = detailHeading(title);
  return (
    <article aria-labelledby="needs-you-detail-title" className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 pb-3">
        {onBack && (
          <button type="button" onClick={onBack}
            className="mb-3 inline-flex items-center gap-1 rounded-md text-small font-medium text-primary hover:underline">
            <ChevronLeft className="h-4 w-4" aria-hidden /> Needs you
          </button>
        )}
        <div className="mb-1.5 flex flex-wrap items-center gap-2 text-caption text-faint">
          <StatusPill tone={view.state.tone}>{view.state.label}</StatusPill>
          {view.context && <span>{view.context}</span>}
          {view.at && <span>{relativeTime(view.at)}</span>}
        </div>
        <h2 id="needs-you-detail-title" className="text-h3 text-fg [text-wrap:balance]">{heading}</h2>
        {aside && <div className="mt-2">{aside}</div>}
      </header>
      {(children || body) && (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 text-body text-fg">
          {body && <p className="whitespace-pre-wrap">{body}</p>}
          {children}
        </div>
      )}
      {(actions || notice) && (
        // Sticky so the decision stays in reach under a long body on a narrow
        // screen; on a wide one the body scrolls inside the pane instead.
        <footer className="sticky bottom-0 -mx-5 mt-3 shrink-0 border-t border-border bg-raised px-5 pb-1 pt-3">
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
          {notice && (
            <p role={notice.tone === 'error' ? 'alert' : 'status'}
              className={cn('mt-2 text-small', notice.tone === 'error' ? 'text-danger' : 'text-success')}>
              {notice.text}
            </p>
          )}
        </footer>
      )}
    </article>
  );
}

/** Supporting material the decision does not depend on: open on request. */
export function Disclosure({ summary, children, defaultOpen }: { summary: string; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="group rounded-md border border-border px-3 py-2" open={defaultOpen}>
      <summary className="cursor-pointer select-none text-small font-medium text-muted hover:text-fg">{summary}</summary>
      <div className="mt-2 text-small text-fg">{children}</div>
    </details>
  );
}
