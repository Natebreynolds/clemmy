import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUp, Ellipsis, Minus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { PaneCard, PaneRow, SectionHeader } from '../HomeSection';
import {
  AGENDA,
  CAPTURE,
  MAIL,
  NEEDS_YOU,
  TRENDS,
  WATCH,
} from './data';

export interface TileMenuHandlers {
  onTune?: () => void;
  onReplace?: () => void;
  onRemove?: () => void;
  onOpenSpace?: () => void;
}

function TileMenu({ handlers }: { handlers: TileMenuHandlers }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const labelId = useId();
  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const items = [
    handlers.onTune && { label: 'Tune', run: handlers.onTune },
    handlers.onReplace && { label: 'Replace', run: handlers.onReplace },
    handlers.onOpenSpace && { label: 'Open as a Space', run: handlers.onOpenSpace },
    handlers.onRemove && { label: 'Remove from home', run: handlers.onRemove },
  ].filter((item): item is { label: string; run: () => void } => Boolean(item));
  if (items.length === 0) return null;
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-labelledby={labelId}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-sm text-faint transition-colors hover:bg-hover hover:text-fg"
      >
        <span id={labelId} className="sr-only">Widget menu</span>
        <Ellipsis className="h-4 w-4" aria-hidden />
      </button>
      {open && (
        <ul role="menu" className="absolute right-0 z-50 mt-1 min-w-[12.5rem] rounded-md border border-border bg-surface py-1 shadow-popover">
          {items.map((item) => {
            const danger = item.label.startsWith('Remove');
            return (
              <li key={item.label} role="none" className={danger ? 'mt-1 border-t border-border pt-1' : undefined}>
                <button
                  type="button"
                  role="menuitem"
                  className={cn(
                    'flex w-full cursor-pointer px-3 py-2 text-left text-small hover:bg-hover',
                    danger ? 'text-muted hover:text-danger' : 'text-fg',
                  )}
                  onClick={() => { setOpen(false); item.run(); }}
                >
                  {item.label}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function TileHead({
  id,
  label,
  aside,
  count,
  menu,
}: {
  id: string;
  label: string;
  aside?: string;
  count?: number;
  menu?: TileMenuHandlers;
}) {
  return (
    <SectionHeader
      id={id}
      label={label}
      count={count}
      aside={
        <span className="flex items-center gap-2">
          {aside ? <span>{aside}</span> : null}
          {menu ? <TileMenu handlers={menu} /> : null}
        </span>
      }
    />
  );
}

export function AgendaTile({ compact = false, menu, onPrep }: { compact?: boolean; menu?: TileMenuHandlers; onPrep?: () => void }) {
  const rows = compact
    ? [...AGENDA.filter((event) => event.when === 'next'), ...AGENDA.filter((event) => event.when === 'past').slice(0, 2)]
    : AGENDA;
  return (
    <section aria-labelledby="mock-agenda" className="flex h-full min-h-0 flex-col gap-2.5">
      <TileHead id="mock-agenda" label="Today" menu={menu} />
      <div className="flex flex-1 flex-col overflow-hidden rounded-md border border-border bg-surface">
        {rows.map((event) => {
          const next = event.when === 'next';
          return (
            <div
              key={event.time}
              className={cn(
                'grid grid-cols-[4.5rem_1fr] items-baseline gap-3 border-t border-border px-4 py-3 first:border-t-0',
                next && 'bg-primary-tint/40',
              )}
            >
              <span className={cn('text-small tabular-nums', next ? 'font-semibold text-primary' : 'text-faint')}>
                {event.time}
              </span>
              <div className="min-w-0">
                <p className={cn('truncate text-body', next ? 'font-semibold text-fg' : 'text-muted')}>{event.title}</p>
                {next && event.note && <p className="text-caption text-primary">{event.note}</p>}
                {next && onPrep && (
                  <Button size="sm" variant="secondary" className="mt-2" onClick={onPrep}>Prep me</Button>
                )}
              </div>
            </div>
          );
        })}
        <p className="mt-auto border-t border-border px-4 py-3 text-caption text-faint">After 3:30 the afternoon is open.</p>
      </div>
    </section>
  );
}

export function NeedsYouTile({
  onApprove,
  menu,
}: {
  onApprove?: (title: string) => void;
  menu?: TileMenuHandlers;
}) {
  return (
    <section aria-labelledby="mock-needs" className="flex h-full min-h-0 flex-col gap-2.5">
      <TileHead id="mock-needs" label="Needs you" count={NEEDS_YOU.length} menu={menu} />
      <PaneCard>
        {NEEDS_YOU.map((item) => (
          <PaneRow key={item.title} className="flex-col items-stretch gap-2">
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 text-body font-semibold text-fg">{item.title}</p>
              <span className="shrink-0 pt-0.5 text-caption text-faint">{item.when}</span>
            </div>
            <p className="text-small text-muted">{item.meta}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => onApprove?.(item.title)}>Approve</Button>
              <Button size="sm" variant="secondary">Not now</Button>
            </div>
          </PaneRow>
        ))}
      </PaneCard>
    </section>
  );
}

export function MailTile({
  menu,
  onDraft,
}: {
  menu?: TileMenuHandlers;
  onDraft?: (title: string) => void;
}) {
  return (
    <section aria-labelledby="mock-mail" className="flex h-full min-h-0 flex-col gap-2.5">
      <TileHead id="mock-mail" label="Mail" count={MAIL.length} menu={menu} />
      <PaneCard>
        {MAIL.map((item) => (
          <PaneRow key={item.title} className="flex-col items-stretch gap-1">
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 text-body font-semibold text-fg">{item.title}</p>
              <span className="shrink-0 pt-0.5 text-caption text-faint">{item.when}</span>
            </div>
            <p className="text-small text-muted">{item.from}</p>
            <p className="line-clamp-1 text-small text-faint">{item.preview}</p>
            {item.needsReply && (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className="w-fit rounded-sm bg-primary-tint px-1.5 py-0.5 text-caption font-semibold text-primary">
                  Needs a reply
                </span>
                {onDraft && (
                  <Button size="sm" variant="secondary" onClick={() => onDraft(item.title)}>Draft reply</Button>
                )}
              </div>
            )}
          </PaneRow>
        ))}
      </PaneCard>
    </section>
  );
}

function Spark({ series, className }: { series: readonly number[]; className?: string }) {
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = Math.max(1, max - min);
  const w = 240;
  const h = 40;
  const pts = series.map((value, i) => {
    const x = (i / (series.length - 1)) * w;
    const y = h - ((value - min) / span) * (h - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={cn('w-full', className)} role="img" aria-label="Organic sessions over the last seven days">
      <polyline fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" points={pts.join(' ')} />
    </svg>
  );
}

export function ReportTile({
  baseline = false,
  highlighted = false,
  stacked = false,
  preview = false,
  menu,
  onLookInto,
}: {
  baseline?: boolean;
  highlighted?: boolean;
  stacked?: boolean;
  preview?: boolean;
  menu?: TileMenuHandlers;
  onLookInto?: (title: string) => void;
}) {
  return (
    <section
      aria-labelledby="mock-trends"
      className={cn(
        'flex min-h-0 flex-col gap-2.5',
        highlighted && 'ring-2 ring-primary ring-offset-2 ring-offset-canvas rounded-md',
      )}
    >
      <TileHead
        id="mock-trends"
        label="Content trends"
        aside={baseline ? 'Baseline set' : `Refreshed ${TRENDS.refreshed}`}
        menu={preview ? undefined : menu}
      />
      <div className="flex flex-1 flex-col gap-4 overflow-hidden rounded-md border border-border bg-surface px-5 py-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-small text-muted">{TRENDS.headline.label}</p>
            <p className="font-sans text-display text-fg tabular-nums">{TRENDS.headline.value}</p>
          </div>
          {baseline ? (
            <p className="max-w-sm text-small text-muted">Baseline set — movement starts next refresh.</p>
          ) : (
            <p className="rounded-sm bg-success-tint px-2 py-1 text-small font-semibold text-success">{TRENDS.delta}</p>
          )}
        </div>

        {!baseline && (
          <p className="reading text-body text-fg">{TRENDS.brief}</p>
        )}

        {!preview && (
          <div className="text-primary">
            <Spark series={TRENDS.series} />
            <p className="mt-1 text-caption text-faint">Seven days of organic sessions, from the last successful snapshot.</p>
          </div>
        )}

        <ul className={cn('grid gap-2', stacked ? 'grid-cols-1' : 'grid-cols-3')}>
          {TRENDS.sources.map((source) => (
            <li key={source.label} className="rounded-sm border border-border bg-subtle px-3 py-2">
              <p className="text-caption text-muted">{source.label}</p>
              <p className="text-body font-semibold text-fg">
                {source.delta ?? <span className="inline-flex items-center gap-1 text-muted"><Minus className="h-3.5 w-3.5" aria-hidden /> Flat</span>}
              </p>
            </li>
          ))}
        </ul>

        {!baseline && !preview && (
          <div>
            <p className="mb-2 text-small font-semibold text-muted">Movers</p>
            <ul className="divide-y divide-border border-t border-border">
              {TRENDS.movers.map((mover) => (
                <li key={mover.title} className="flex items-baseline justify-between gap-3 py-2">
                  <span className="min-w-0 truncate text-small text-fg">{mover.title}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-small tabular-nums text-muted">
                      {mover.before} → {mover.after}
                    </span>
                    {onLookInto && (
                      <button
                        type="button"
                        className="cursor-pointer text-caption font-semibold text-primary hover:underline"
                        onClick={() => onLookInto(mover.title)}
                      >
                        Look into
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="text-caption text-faint">Search · Analytics · Social</p>
      </div>
    </section>
  );
}

export function CaptureTile({ stacked = false, menu }: { stacked?: boolean; menu?: TileMenuHandlers }) {
  const items = stacked ? CAPTURE.items : CAPTURE.items;
  return (
    <section aria-labelledby="mock-capture" className="flex min-h-0 flex-col gap-2.5">
      <TileHead
        id="mock-capture"
        label="Social capture"
        count={CAPTURE.newCount}
        aside={`${CAPTURE.newCount} new since ${CAPTURE.since}`}
        menu={menu}
      />
      <div className="flex flex-1 flex-col overflow-hidden rounded-md border border-border bg-surface">
        <div className={cn('grid gap-0', stacked ? 'grid-cols-2' : 'grid-cols-4')}>
          {items.map((item) => (
            <article key={item.title} className="relative border-r border-border last:border-r-0">
              <div className="relative aspect-[5/4] overflow-hidden bg-subtle">
                <img src={item.thumb} alt="" className="h-full w-full object-cover" />
                {item.isNew && (
                  <span className="absolute left-2 top-2 rounded-sm bg-primary px-1.5 py-0.5 text-caption font-semibold text-primary-fg">
                    New
                  </span>
                )}
              </div>
              <div className="px-3 py-2.5">
                <p className="line-clamp-2 text-small font-semibold text-fg">{item.title}</p>
                <p className="mt-1 text-caption text-faint">{item.source} · {item.at}</p>
              </div>
            </article>
          ))}
        </div>
        <p className="border-t border-border px-4 py-2.5 text-caption text-faint">
          {CAPTURE.sources.join(' · ')} · next refresh {CAPTURE.nextRefresh}
        </p>
      </div>
    </section>
  );
}

export function WatchTile({ menu }: { menu?: TileMenuHandlers }) {
  return (
    <section aria-labelledby="mock-watch" className="flex min-h-0 flex-col gap-2.5">
      <TileHead id="mock-watch" label="Rank watch" menu={menu} />
      <div className="flex flex-1 flex-col justify-center gap-2 rounded-md border border-border bg-surface px-4 py-5">
        <p className="text-body font-semibold text-fg">{WATCH.label}</p>
        <p className="text-small text-muted">{WATCH.detail}</p>
      </div>
    </section>
  );
}

export function MiniAsk({
  compact = false,
  placeholder = 'Ask Clementine…',
  onSend,
}: {
  compact?: boolean;
  placeholder?: string;
  onSend?: (text: string) => void;
}) {
  return (
    <form
      className={cn(
        'flex items-end gap-2 rounded-md border border-border bg-surface px-3',
        compact ? 'py-2' : 'py-3',
      )}
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const input = form.elements.namedItem('ask') as HTMLInputElement;
        const text = input.value.trim();
        if (text) onSend?.(text);
        else onSend?.('');
      }}
    >
      <label className="sr-only" htmlFor="mock-ask">Ask Clementine</label>
      <input
        id="mock-ask"
        name="ask"
        placeholder={placeholder}
        className="min-h-10 min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-faint"
      />
      <button
        type="submit"
        aria-label="Send"
        className="mb-0.5 inline-flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-fg transition-colors hover:bg-primary-hover cursor-pointer"
      >
        <ArrowUp className="h-4 w-4" aria-hidden />
      </button>
    </form>
  );
}
