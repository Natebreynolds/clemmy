/**
 * ProgressRail — the turn's progress bar.
 *
 * Four segments for the four phases every turn passes through: thinking,
 * working, writing, checking. Done segments are filled, the current one
 * sweeps (or fills to a real fraction when the harness declared a count), the
 * rest wait. A phase the turn skipped is a dashed gap, not a lie of
 * completion. The model that decides all of this lives in the chat engine, so
 * the phone draws the same rail from the same facts.
 */
import { cn } from '@/lib/cn';
import type { TurnProgress } from '@clem/chat-engine';

export function ProgressRail({ progress, className }: { progress: TurnProgress; className?: string }) {
  const current = progress.phases.find((phase) => phase.state === 'current');
  return (
    <ol
      className={cn('flex min-w-0 items-end gap-2', className)}
      aria-label={current ? `${current.label}${current.caption ? `, ${current.caption}` : ''}` : 'Progress'}
    >
      {progress.phases.map((phase) => {
        const determinate = phase.fraction !== undefined && phase.state === 'current';
        const percent = determinate ? Math.round((phase.fraction ?? 0) * 100) : undefined;
        const showCaption = Boolean(phase.caption) && (phase.state === 'current' || phase.id === 'check');
        return (
          <li
            key={phase.id}
            className={cn('flex min-w-0 flex-col gap-1', phase.id === 'work' ? 'flex-[2]' : 'flex-1')}
            aria-current={phase.state === 'current' ? 'step' : undefined}
          >
            <span
              className={cn(
                'truncate text-caption leading-none',
                phase.state === 'current' ? 'font-semibold text-fg' : phase.state === 'done' ? 'text-muted' : 'text-faint',
              )}
            >
              {phase.label}
              {showCaption && <span className="font-normal text-faint"> · {phase.caption}</span>}
            </span>
            <span
              className={cn('rail-seg', `is-${phase.state}`, determinate && 'is-determinate')}
              role={determinate ? 'progressbar' : undefined}
              aria-valuenow={percent}
              aria-valuemin={determinate ? 0 : undefined}
              aria-valuemax={determinate ? 100 : undefined}
            >
              <span className="rail-fill" style={determinate ? { width: `${percent}%` } : undefined} />
            </span>
          </li>
        );
      })}
    </ol>
  );
}
