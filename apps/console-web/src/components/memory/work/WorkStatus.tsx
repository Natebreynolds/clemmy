/**
 * The top of "Memory at work": which model keeps the owner's memory, and one
 * line that says what memory work is doing right now. The dot pulses only
 * while the daemon reports a job running in this process AND this read is
 * fresh; waiting, resting, off and unknown are said in words and hold still.
 */
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import { MEMORY_ROLE_WORDS } from '@clem/chat-engine';
import { clsx } from 'clsx';
import { usePoll } from '@/lib/poll';
import { getSettings } from '@/lib/settings';
import { elapsedClock, type MemoryModelChipView, type MemoryWorkView } from '@/lib/memory-work';
import { PROVIDER_DOT } from '@/components/chat/ActivityFeed';

/** Who keeps the memory: the model the next memory job asks for, whether the
 *  owner chose it, and the door to change it (Settings is the one owner). */
export function MemoryModelChip({ model }: { model: MemoryModelChipView }) {
  // The provider colour comes from the settings read the header chip already
  // shares; it is shown only when that read names the same model.
  const settings = usePoll(['settings'], getSettings, 0);
  const role = settings.data?.modelRoles?.roles.memory;
  const provider = role && model.modelId && role.modelId === model.modelId ? role.provider : 'unknown';
  const dot = (PROVIDER_DOT as Record<string, string>)[provider] ?? PROVIDER_DOT.unknown;
  return (
    <div className="memory-head-chip flex min-w-0 max-w-[24rem] flex-col gap-1">
      <span className="text-caption text-muted">
        {MEMORY_ROLE_WORDS.title}
        {!model.unknown && <> · <span className="font-semibold text-fg">{model.sourceLabel}</span></>}
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dot }} aria-hidden />
        <span className={clsx('truncate text-body font-semibold', model.name ? 'text-fg' : 'text-muted')}>
          {model.name ?? (model.unknown ? '—' : 'No model available')}
        </span>
        {model.unknown && <span className="text-caption text-faint">couldn’t be read</span>}
        {model.problem && (
          <span className="inline-flex shrink-0" title={`${model.name ?? 'The memory model'} ${model.problem}`}>
            <AlertTriangle className="h-3.5 w-3.5 text-warning" aria-hidden />
            <span className="sr-only">{model.problem}</span>
          </span>
        )}
      </span>
      {model.served && (
        <span className={clsx('text-caption', model.served.standIn ? 'text-warning' : 'text-muted')}>
          {model.served.standIn
            ? <>Last answered by {model.served.name}, standing in{model.served.age ? ` · ${model.served.age}` : ''}</>
            : <>Last answered by {model.served.name}{model.served.age ? ` · ${model.served.age}` : ''}</>}
        </span>
      )}
      <span className="text-caption text-muted">
        {model.automaticText && !model.unknown && <>{model.automaticText} </>}
        <Link to="/settings#memory-model" className="inline-flex items-center gap-0.5 font-semibold text-primary hover:underline">
          Change <ArrowRight className="h-3 w-3" aria-hidden />
        </Link>
      </span>
    </div>
  );
}

const BAND: Record<MemoryWorkView['state'], string> = {
  working: 'memory-band-working',
  waiting: 'memory-band-waiting',
  resting: 'border-border bg-surface',
  off: 'border-border bg-subtle',
  unknown: 'border-border bg-subtle',
};

function StateDot({ view }: { view: MemoryWorkView }) {
  if (view.live) return <span className="memory-pulse relative h-2.5 w-2.5 shrink-0 rounded-full bg-primary" aria-hidden />;
  if (view.band === 'waiting') return <span className="h-2.5 w-2.5 shrink-0 rounded-full border-2 border-warning" aria-hidden />;
  // Up to date is a quiet green; a queue still to read is a neutral dot.
  if (view.band === 'resting') return <span className={clsx('h-2.5 w-2.5 shrink-0 rounded-full', view.upToDate ? 'bg-success' : 'bg-faint')} aria-hidden />;
  if (view.band === 'unknown') return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />;
  return <span className="h-2.5 w-2.5 shrink-0 rounded-full border-2 border-dashed border-border-strong" aria-hidden />;
}

/** The one sentence about now. `aria-live` is polite and lives here only. */
export function WorkStatusBand({ view, now }: { view: MemoryWorkView; now: number }) {
  return (
    <div className={clsx('flex items-start gap-3 rounded-md border px-4 py-3 transition-colors duration-slow', BAND[view.band])}>
      <span className="mt-[0.45rem] flex h-3.5 w-3.5 shrink-0 items-center justify-center"><StateDot view={view} /></span>
      <div className="min-w-0 flex-1">
        <p role="status" aria-live="polite" className="text-body-lg font-semibold leading-snug text-fg">
          {view.headline}
        </p>
        {view.detail && <p className="mt-0.5 text-small text-muted">{view.detail}</p>}
      </div>
      {view.runningSince !== null && (
        <span className="mt-1 shrink-0 font-mono text-small tabular-nums text-muted" title="How long this job has been running">
          {elapsedClock(view.runningSince, now)}
        </span>
      )}
    </div>
  );
}
