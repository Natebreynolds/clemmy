/**
 * Watch Clementine build a Space.
 *
 * Renders the Space's own chat stream as a build timeline over the preview:
 * every tool call she makes while building (reading a source, writing the
 * view, refreshing data) appears as a step the moment it starts, the preview
 * re-renders as revisions land, and the stage settles into a one-line summary
 * when the build is done. Nothing here is a reducer of its own — the steps and
 * the state come from `lib/space-build` over the live `useChat` messages.
 */
import { Check, Loader2, X, Sparkles, MessageSquare, Play } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { DogMark } from '@/components/DogMark';
import type { SpaceBuildState, SpaceBuildStep } from '@/lib/space-build';

function StepIcon({ status }: { status: SpaceBuildStep['status'] }) {
  if (status === 'running') return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />;
  if (status === 'failed') return <X className="h-3.5 w-3.5 text-danger" aria-hidden />;
  if (status === 'interrupted') return <X className="h-3.5 w-3.5 text-muted" aria-hidden />;
  return <Check className="h-3.5 w-3.5 text-success" aria-hidden />;
}

export interface BuildStageProps {
  state: SpaceBuildState;
  steps: readonly SpaceBuildStep[];
  /** Clem's latest progress line while building. */
  progress?: string;
  /** Clem's latest reply text (the question when state is needs_input, the wrap-up when built). */
  reply?: string;
  /** One line describing what the Space is made of once built. */
  shape?: string;
  /** Current view revision, for the "View updated" pulse. */
  version?: number;
  /** A placeholder Space whose build never started (page reloaded before the dock sent it). */
  pendingObjective?: string;
  onStartBuild?: () => void;
  onOpenChat?: () => void;
  onDismiss?: () => void;
}

export function BuildStage(props: BuildStageProps) {
  const { state, steps, progress, reply, shape, version, pendingObjective } = props;
  if (state === 'idle' && !pendingObjective) return null;
  const building = state === 'building';
  const title = state === 'building'
    ? 'Clementine is building this Space'
    : state === 'needs_input'
      ? 'Clementine needs one thing from you'
      : state === 'failed'
        ? 'The build stopped'
        : state === 'built'
          ? 'Built'
          : 'Ready to build';
  return (
    <section
      aria-live="polite"
      aria-label={title}
      className={`pointer-events-auto absolute left-4 top-4 z-10 w-[min(420px,calc(100%-2rem))] overflow-hidden rounded-2xl border border-border bg-surface/95 shadow-lg backdrop-blur ${building ? 'ring-1 ring-primary/30' : ''}`}
    >
      <header className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <span className="relative inline-flex h-7 w-7 items-center justify-center rounded-full bg-subtle">
          <DogMark className="h-4 w-4" />
          {building && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-primary animate-pulse" aria-hidden />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-small font-medium text-fg">{title}</p>
          {typeof version === 'number' && state !== 'idle' && (
            <p className="truncate text-caption text-faint">view v{version}{building ? ' · updating as she goes' : ''}</p>
          )}
        </div>
        {props.onDismiss && state !== 'building' && (
          <button type="button" onClick={props.onDismiss} className="cursor-pointer text-muted hover:text-fg" aria-label="Hide build summary">
            <X className="h-4 w-4" aria-hidden />
          </button>
        )}
      </header>

      {state === 'idle' && pendingObjective && (
        <div className="space-y-3 px-4 py-3">
          <p className="text-small text-fg">{pendingObjective}</p>
          <p className="text-caption text-muted">This Space was created but the build never started. Start it and watch it come together here.</p>
          <Button size="sm" onClick={props.onStartBuild}><Play className="h-4 w-4" aria-hidden /> Start building</Button>
        </div>
      )}

      {state !== 'idle' && (
        <ol className="max-h-64 space-y-1.5 overflow-y-auto px-4 py-3">
          {steps.length === 0 && building && (
            <li className="flex items-center gap-2 text-small text-muted"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Thinking about what to build…</li>
          )}
          {steps.map((step) => (
            <li key={step.id} className="flex items-start gap-2 text-small">
              <span className="mt-0.5 shrink-0"><StepIcon status={step.status} /></span>
              <span className="min-w-0">
                <span className={step.status === 'running' ? 'text-fg' : 'text-muted'}>{step.label}</span>
                {step.detail && <span className="block truncate text-caption text-faint">{step.detail}</span>}
              </span>
            </li>
          ))}
          {building && progress && (
            <li className="flex items-start gap-2 text-small text-fg"><Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden /><span>{progress}</span></li>
          )}
        </ol>
      )}

      {(state === 'built' || state === 'needs_input' || state === 'failed') && (
        <footer className="space-y-2 border-t border-border px-4 py-3">
          {state === 'built' && shape && <p className="text-caption text-muted">{shape}</p>}
          {reply && state !== 'built' && <p className="line-clamp-4 text-small text-fg">{reply}</p>}
          <div className="flex items-center gap-2">
            <Button size="sm" variant={state === 'needs_input' ? 'primary' : 'secondary'} onClick={props.onOpenChat}>
              <MessageSquare className="h-4 w-4" aria-hidden /> {state === 'needs_input' ? 'Answer her' : state === 'failed' ? 'Ask her to continue' : 'Ask for a change'}
            </Button>
          </div>
        </footer>
      )}
    </section>
  );
}
