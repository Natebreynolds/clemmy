/**
 * Today's learning as the path a memory takes: conversations read → things
 * noticed → kept or updated → faded, with "left out" branching off what was
 * noticed. The stage whose job is running right now glows and the link into
 * it carries a slow light; with nothing running, the diagram is still.
 */
import { clsx } from 'clsx';
import type { PipelineFlows, PipelineStageView } from '@/lib/memory-work';

function Stage({ stage }: { stage: PipelineStageView }) {
  return (
    <div
      role="listitem"
      style={{ gridArea: stage.id }}
      className={clsx(
        'relative flex min-w-0 flex-col justify-center gap-0.5 rounded-md border px-3 py-2.5 transition-[background-color,border-color,box-shadow] duration-slow',
        stage.active ? 'memory-stage-active shadow-warm-halo' : 'border-border bg-surface',
      )}
    >
      <span className={clsx('text-h2 tabular-nums leading-none', stage.value === null ? 'text-faint' : stage.active ? 'text-primary' : 'text-fg')}>
        {stage.text}
      </span>
      <span className="text-caption leading-snug text-muted">
        {stage.label}
        {stage.value === null && <span className="sr-only"> (couldn’t be read)</span>}
        {stage.active && <span className="sr-only"> (working on this now)</span>}
      </span>
      {stage.active && <span className="memory-pulse absolute right-2.5 top-2.5 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />}
    </div>
  );
}

function StageLink({ area, axis, flowing }: { area: string; axis: 'main' | 'branch'; flowing: boolean }) {
  return (
    <span aria-hidden data-axis={axis} style={{ gridArea: area }} className={clsx('memory-link', flowing && 'is-flowing')}>
      <span className="memory-line" />
    </span>
  );
}

export function LearningPipeline({ stages, flows }: { stages: PipelineStageView[]; flows: PipelineFlows }) {
  const by = (id: PipelineStageView['id']) => stages.find((s) => s.id === id);
  const read = by('read'); const found = by('found'); const kept = by('kept'); const aside = by('aside'); const faded = by('faded');
  if (!read || !found || !kept || !aside || !faded) return null;
  return (
    <div role="list" aria-label="Today’s learning, stage by stage" className="memory-pipeline">
      <Stage stage={read} />
      <StageLink area="l1" axis="main" flowing={flows.readToFound} />
      <Stage stage={found} />
      <StageLink area="l4" axis="branch" flowing={flows.foundToAside} />
      <Stage stage={aside} />
      <StageLink area="l2" axis="main" flowing={flows.foundToKept} />
      <Stage stage={kept} />
      <StageLink area="l3" axis="main" flowing={flows.keptToFaded} />
      <Stage stage={faded} />
      <p style={{ gridArea: 'note' }} className="mt-3 self-start text-caption leading-snug text-faint">
        Left out is what a conversation didn’t back up, plus what overlaps a memory Clem already has and waits for a second look.
      </p>
    </div>
  );
}
