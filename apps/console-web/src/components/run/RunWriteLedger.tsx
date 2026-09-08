import { CheckCircle2, AlertCircle, AlertTriangle, Circle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { RunSection } from './RunSection';
import type { RunWriteRow } from '@/lib/run-presentation';

/**
 * What the run changed outside this machine — the run page's first section,
 * because it is the fact a person most needs and the hardest to take back.
 *
 * The glyph is load-bearing. A reservation gets a hollow ring and the ledger's
 * present tense; only a confirmed terminal gets a tick. Nothing here may say
 * "can't be undone" unless the ledger carried that flag, so the phrase is
 * rendered from `reversibility` and never composed locally.
 */
const stateGlyph = {
  running: Circle,
  done: CheckCircle2,
  failed: AlertCircle,
  interrupted: AlertTriangle,
} as const;

const stateInk: Record<RunWriteRow['state'], string> = {
  running: 'text-primary',
  done: 'text-success',
  failed: 'text-danger',
  interrupted: 'text-warning',
};

/**
 * `settled` is the run having reached a terminal. It is the only condition
 * under which an empty ledger may be read as "it changed nothing out there" —
 * on a run still in progress, or one whose history could not be fully read,
 * an empty section would be indistinguishable from a section that simply did
 * not render, and silence there is the most dangerous reading of all.
 */
export function RunWriteLedger({ rows, summary, settled }: {
  rows: RunWriteRow[];
  summary: string;
  settled: boolean;
}) {
  if (rows.length === 0) {
    if (!settled) return null;
    return (
      <RunSection title="What changed" meta="no recorded receipts">
        <p className="text-body text-muted">No external write receipts were recorded in the available history.</p>
      </RunSection>
    );
  }
  return (
    <RunSection title="What changed" meta={summary}>
      <ul className="space-y-2.5">
        {rows.map((row) => {
          const Glyph = stateGlyph[row.state];
          return (
            <li key={row.key} className="flex items-start gap-2.5">
              <Glyph className={cn('mt-0.5 h-4 w-4 shrink-0', stateInk[row.state])} aria-hidden />
              <div className="min-w-0">
                <p className={cn('text-body text-fg', !row.settled && 'italic')}>{row.what}</p>
                {(row.note || row.reversibility) && (
                  <p className="mt-0.5 text-caption text-muted">
                    {[row.note, row.reversibility].filter(Boolean).join(' · ')}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </RunSection>
  );
}
