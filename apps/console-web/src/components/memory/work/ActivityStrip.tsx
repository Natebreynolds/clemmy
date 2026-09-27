/**
 * When memory work happened: the last 24 hours as bars (height = model calls,
 * or runs when no model was called), a dot where Clem learned something, the
 * current hour marked; the last 30 days as a quieter strip; and today's
 * totals. A bar says its numbers on hover or keyboard focus. One tab stop per
 * strip; the arrow keys walk the bars.
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import { clsx } from 'clsx';
import type { ActivityBarView, MemoryWorkView } from '@/lib/memory-work';

function BarStrip({ bars, slots, label, summary, heightClass, ticks }: {
  bars: ActivityBarView[];
  /** Slots on the strip; each bar sits in its own (`bar.slot`), and a slot
   *  never measured (before history began) stays blank. */
  slots: number;
  label: string;
  summary: string;
  heightClass: string;
  ticks: 'hours' | 'ends';
}) {
  const [shown, setShown] = useState<number | null>(null);
  const [stop, setStop] = useState<number>(Math.max(0, bars.length - 1));
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabAt = Math.min(stop, Math.max(0, bars.length - 1));
  const go = (i: number) => {
    const next = Math.max(0, Math.min(bars.length - 1, i));
    setStop(next);
    refs.current[next]?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); go(i + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); go(bars.length - 1); }
  };
  const bySlot = new Map(bars.map((bar, i) => [bar.slot, i] as const));
  const slotList = Array.from({ length: slots }, (_, slot) => slot);
  const first = bars[0];
  const last = bars[bars.length - 1];
  return (
    <div className="min-w-0">
      <div role="group" aria-label={label} className={clsx('flex items-end', heightClass)} onMouseLeave={() => setShown(null)}>
        {slotList.map((slot) => {
          const i = bySlot.get(slot);
          const bar = i === undefined ? undefined : bars[i];
          if (i === undefined || !bar) return <span key={`blank-${slot}`} className="h-full flex-1" aria-hidden />;
          return (
            <button
              key={bar.key}
              ref={(el) => { refs.current[i] = el; }}
              type="button"
              tabIndex={i === tabAt ? 0 : -1}
              aria-label={bar.readout}
              onMouseEnter={() => setShown(i)}
              onFocus={() => { setShown(i); setStop(i); }}
              onBlur={() => setShown(null)}
              onKeyDown={(e) => onKey(e, i)}
              className="group relative flex h-full min-w-0 flex-1 cursor-default items-end justify-center rounded-[3px] px-[1.5px]"
            >
              <span
                aria-hidden
                className={clsx(
                  'block w-full max-w-[1.25rem] rounded-t-[3px] transition-colors duration-fast',
                  bar.value === 0 ? 'bg-border' : clsx('memory-bar', (bar.current || shown === i) && 'is-strong'),
                )}
                style={{ height: bar.value > 0 ? `${bar.height}%` : '2px' }}
              />
              {bar.learned > 0 && (
                <span
                  aria-hidden
                  className="absolute left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-primary"
                  style={{ bottom: bar.value > 0 ? `calc(${bar.height}% + 3px)` : '5px' }}
                />
              )}
            </button>
          );
        })}
      </div>
      <div className="relative mt-1 flex h-4 text-caption leading-4 text-faint" aria-hidden>
        {ticks === 'hours'
          ? slotList.map((slot) => {
            const i = bySlot.get(slot);
            const bar = i === undefined ? undefined : bars[i];
            return (
              <span key={`t-${slot}`} className="relative flex-1">
                {bar && (bar.tick || bar.current) && (
                  <span className={clsx('absolute left-1/2 -translate-x-1/2 whitespace-nowrap', bar.current && 'font-semibold text-muted')}>
                    {bar.current ? 'now' : bar.tick}
                  </span>
                )}
              </span>
            );
          })
          : first && last && (
            <>
              {/* One day of history has one label, not the same one twice. */}
              {first !== last && <span style={{ marginLeft: `${(first.slot / slots) * 100}%` }}>{first.label}</span>}
              <span className="ml-auto">{last.label}</span>
            </>
          )}
      </div>
      <p className="mt-1 min-h-[1.25rem] text-caption text-muted" aria-hidden>
        {shown !== null && bars[shown] ? bars[shown].readout : summary}
      </p>
    </div>
  );
}

export function ActivityStrip({ view }: { view: MemoryWorkView }) {
  return (
    <div className="memory-activity">
      <div className="min-w-0 space-y-4">
        <div>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
            <h4 className="text-small font-semibold text-fg">Last 24 hours</h4>
            <span className="inline-flex items-center gap-3 text-caption text-faint">
              <span className="inline-flex items-center gap-1.5"><span className="memory-bar h-2.5 w-1.5 rounded-t-[2px]" aria-hidden />{view.hourlyUnit}</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />learned something</span>
            </span>
          </div>
          {view.hourly.length === 0
            ? <p className="text-small text-muted">— <span className="text-faint">couldn’t be read</span></p>
            : <BarStrip bars={view.hourly} slots={view.hourlySlots} label="Memory work in the last 24 hours, by hour" summary={view.hourlySummary} heightClass="h-16" ticks="hours" />}
        </div>
        {view.daily.length > 0 && (
          <div>
            <h4 className="mb-2 text-small font-semibold text-fg">Last 30 days</h4>
            <BarStrip
              bars={view.daily}
              slots={view.dailySlots}
              label="Memory work in the last 30 days, by day"
              summary={view.dailyMissing > 0 ? `Daily totals start ${view.daily[0]?.label}; there is no record before that.` : `Bars show ${view.dailyUnit} per day.`}
              heightClass="h-9"
              ticks="ends"
            />
          </div>
        )}
      </div>
      <div className="min-w-0">
        <h4 className="mb-2 text-small font-semibold text-fg">Today</h4>
        <dl className="divide-y divide-border rounded-md border border-border bg-surface">
          {view.totals.map((t) => (
            <div key={t.label} className="flex items-baseline justify-between gap-3 px-3 py-1.5">
              <dt className="text-small text-muted">{t.label}</dt>
              <dd className={clsx('font-mono text-small tabular-nums', t.value === '—' ? 'text-faint' : 'text-fg')}>{t.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
