/**
 * The turn's progress bar on the phone: the same four phases the desktop
 * draws (thinking → working → writing → checking), from the same engine
 * model. Done is filled, current sweeps or fills to a declared count, pending
 * waits, skipped is a dashed gap. Labels sit under the bar; only the current
 * phase carries its caption, because a phone has no room for four.
 */
import type { TurnProgress } from '@clem/chat-engine';

export function ProgressRail({ progress }: { progress: TurnProgress }) {
  const current = progress.phases.find((phase) => phase.state === 'current');
  return (
    <ol
      class="rail"
      aria-label={current ? `${current.label}${current.caption ? `, ${current.caption}` : ''}` : 'Progress'}
    >
      {progress.phases.map((phase) => {
        const determinate = phase.fraction !== undefined && phase.state === 'current';
        const percent = determinate ? Math.round((phase.fraction ?? 0) * 100) : undefined;
        const showCaption = Boolean(phase.caption) && (phase.state === 'current' || phase.id === 'check');
        return (
          <li
            key={phase.id}
            class={`rail-phase rail-phase-${phase.id} is-${phase.state}`}
            aria-current={phase.state === 'current' ? 'step' : undefined}
          >
            <span
              class={`rail-seg is-${phase.state}${determinate ? ' is-determinate' : ''}`}
              role={determinate ? 'progressbar' : undefined}
              aria-valuenow={percent}
              aria-valuemin={determinate ? 0 : undefined}
              aria-valuemax={determinate ? 100 : undefined}
            >
              <span class="rail-fill" style={determinate ? { width: `${percent}%` } : undefined} />
            </span>
            <span class="rail-label">
              {phase.label}
              {showCaption ? <span class="rail-caption"> · {phase.caption}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
