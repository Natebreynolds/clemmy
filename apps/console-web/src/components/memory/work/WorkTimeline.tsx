/**
 * "What Clem did": the newest memory work, grouped by day. Each row says the
 * run in one plain sentence with the model that answered, the tokens it took
 * and how long; it opens to the memories it touched, as they read now. A run
 * that added memories can forget them, a tidy that let some fade can bring
 * them back — one click, no confirm, like every other undo on this screen.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, RotateCcw, Undo2 } from 'lucide-react';
import { clsx } from 'clsx';
import {
  MEMORY_WORK_QUERY_KEY, memoryUndoResultText, undoMemoryWork,
  type TimelineDayView, type TimelineRowView,
} from '@/lib/memory-work';
import { JOB_ICON } from './job-icon';

const FIRST_ROWS = 6;

const CHANGE_TONE: Record<TimelineRowView['facts'][number]['change'], string> = {
  learned: 'bg-success-tint text-success',
  updated: 'bg-info-tint text-info',
  reinforced: 'bg-subtle text-muted',
  faded: 'bg-subtle text-faint',
  restored: 'bg-info-tint text-info',
};

function Row({ row }: { row: TimelineRowView }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const Icon = JOB_ICON[row.job];
  const detailsId = `memory-work-${row.id}`;
  const meta = [
    row.failed ? 'Didn’t finish' : null,
    row.modelName ? `${row.modelName}${row.standIn ? ' (standing in)' : ''}` : null,
    row.tokens,
    row.duration,
  ].filter(Boolean).join(' · ');
  const undo = async () => {
    if (!row.undo) return;
    setBusy(true);
    try {
      const r = await undoMemoryWork(row.id);
      setResult({ ok: r.ok && r.changed > 0, text: memoryUndoResultText(r, row.undo.kind) });
    } catch {
      setResult({ ok: false, text: 'Couldn’t undo just now. Nothing was changed.' });
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: MEMORY_WORK_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ['facts'] });
      void qc.invalidateQueries({ queryKey: ['mem-health'] });
    }
  };
  const UndoIcon = row.undo?.kind === 'restore' ? RotateCcw : Undo2;
  return (
    <li className="py-2.5">
      <div className="grid grid-cols-[4.25rem_1.5rem_minmax(0,1fr)] items-start gap-x-2.5">
        <span className="pt-px font-mono text-caption tabular-nums text-faint">{row.time}</span>
        <span className={clsx('mt-px flex h-6 w-6 items-center justify-center rounded-md', row.failed ? 'bg-warning-tint text-warning' : 'bg-subtle text-muted')}>
          <Icon className="h-3.5 w-3.5" aria-hidden />
        </span>
        <div className="min-w-0">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen((v) => !v)}
            className="group flex w-full min-w-0 items-start gap-2 rounded-sm text-left"
          >
            <span className="min-w-0 flex-1 text-small leading-snug text-fg group-hover:text-primary">{row.sentence}</span>
            <ChevronDown className={clsx('mt-0.5 h-4 w-4 shrink-0 text-faint transition-transform duration-base', open && 'rotate-180')} aria-hidden />
          </button>
          {(meta || row.undo || result) && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption">
              {meta && <span className={row.failed ? 'text-warning' : 'text-faint'}>{meta}</span>}
              {row.undo && !result && (
                <button
                  type="button"
                  onClick={() => void undo()}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded-sm font-semibold text-primary transition-colors duration-fast hover:text-primary-hover hover:underline disabled:opacity-50"
                >
                  <UndoIcon className="h-3.5 w-3.5" aria-hidden />
                  {busy ? 'Undoing…' : row.undo.label}
                </button>
              )}
              {result && (
                <span role="status" className={clsx('inline-flex items-center gap-1', result.ok ? 'text-success' : 'text-muted')}>
                  {result.ok && <Check className="h-3.5 w-3.5" aria-hidden />}
                  {result.text}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      {open && (
        <div id={detailsId} className="mt-2 space-y-2 rounded-md bg-subtle px-3 py-2.5 sm:ml-[7rem]">
          {row.facts.length > 0 && (
            <ul className="space-y-1.5">
              {row.facts.map((f) => (
                <li key={f.id} className="grid grid-cols-[5.25rem_minmax(0,1fr)] items-start gap-x-2 text-small">
                  <span className={clsx('mt-px justify-self-start rounded-sm px-1.5 py-px text-caption font-semibold', CHANGE_TONE[f.change])}>{f.changeLabel}</span>
                  <span className="min-w-0 leading-snug">
                    <span className={f.active ? 'text-fg' : 'text-muted line-through decoration-faint'}>{f.text}</span>
                    {!f.active && <span className="ml-2 whitespace-nowrap text-caption text-faint">off now</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {row.factsMore > 0 && (
            <p className="text-caption text-muted">
              {row.facts.length > 0 ? `And ${row.factsMore} more ${row.factsMore === 1 ? 'change' : 'changes'} not listed here.` : `${row.factsMore} ${row.factsMore === 1 ? 'change' : 'changes'}; the memories aren’t listed for this run.`}
            </p>
          )}
          <p className="text-caption text-muted">
            {[row.source, row.usage, row.expires].filter(Boolean).join(' · ') || 'No other detail was recorded for this run.'}
          </p>
        </div>
      )}
    </li>
  );
}

export function WorkTimeline({ days, count, unknown }: { days: TimelineDayView[]; count: number; unknown: boolean }) {
  const [all, setAll] = useState(false);
  if (count === 0) {
    return unknown
      ? <p className="text-small text-muted">— <span className="text-faint">couldn’t be read</span></p>
      : <p className="text-small text-muted">Nothing in the last few days yet. When Clem reads a finished conversation, what she kept shows up here.</p>;
  }
  let budget = all ? Number.POSITIVE_INFINITY : FIRST_ROWS;
  const shown = days
    .map((day) => {
      const rows = day.rows.slice(0, Math.max(0, budget));
      budget -= rows.length;
      return { ...day, rows };
    })
    .filter((day) => day.rows.length > 0);
  return (
    <div>
      {shown.map((day) => (
        <section key={day.key} aria-label={day.label} className="mt-3 first:mt-0">
          <h5 className="border-b border-border pb-1.5 text-caption font-semibold text-muted">{day.label}</h5>
          <ul className="divide-y divide-border">
            {day.rows.map((row) => <Row key={row.id} row={row} />)}
          </ul>
        </section>
      ))}
      {count > FIRST_ROWS && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          aria-expanded={all}
          className="mt-2 text-small font-semibold text-primary hover:underline"
        >
          {all ? 'Show fewer' : `Show all ${count}`}
        </button>
      )}
    </div>
  );
}
