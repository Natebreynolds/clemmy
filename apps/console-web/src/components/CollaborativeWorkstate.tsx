import {
  CheckCircle2,
  CircleHelp,
  Compass,
  ExternalLink,
  GitBranch,
  ListChecks,
  ShieldCheck,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { StatusPill, type Tone } from './ui/StatusPill';
import { cn } from '@/lib/cn';
import {
  focusActionHref,
  hasWorkstateDetails,
  type FocusActionStatus,
  type FocusCandidateStatus,
  type FocusSnapshot,
  type FocusWorkMode,
} from '@/lib/focus';

const MODE_LABEL: Record<FocusWorkMode, string> = {
  explore: 'Exploring',
  decide: 'Deciding',
  execute: 'Executing',
  monitor: 'Monitoring',
};

const MODE_TONE: Record<FocusWorkMode, Tone> = {
  explore: 'neutral',
  decide: 'info',
  execute: 'live',
  monitor: 'live',
};

const CANDIDATE_LABEL: Record<FocusCandidateStatus, string> = {
  considering: 'Considering',
  selected: 'Selected',
  rejected: 'Passed on',
};

const ACTION_LABEL: Record<FocusActionStatus, string> = {
  planned: 'Planned',
  running: 'Running',
  blocked: 'Blocked',
  done: 'Done',
};

const ACTION_TONE: Record<FocusActionStatus, Tone> = {
  planned: 'neutral',
  running: 'live',
  blocked: 'warning',
  done: 'success',
};

function MoreCount({ count }: { count: number }) {
  if (count <= 0) return null;
  return <li className="text-caption text-faint">+{count} more</li>;
}

export function CollaborativeWorkstate({
  snapshot,
  compact = false,
  className,
}: {
  snapshot: FocusSnapshot | null | undefined;
  compact?: boolean;
  className?: string;
}) {
  const focus = snapshot?.active;
  if (!focus) return null;
  const state = focus.workstate;
  const hasDetails = hasWorkstateDetails(state);
  const itemLimit = compact ? 2 : 8;
  const mode = state?.mode;

  return (
    <section
      aria-label="Working together"
      className={cn(
        'rounded-lg border border-primary/20 bg-primary-tint/30 px-4 py-3',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary-tint text-primary">
          <Compass className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-caption font-semibold uppercase tracking-wide text-muted">Working together</p>
            {mode && <StatusPill tone={MODE_TONE[mode]}>{MODE_LABEL[mode]}</StatusPill>}
            {snapshot?.needsConfirm && <StatusPill tone="warning">Check context</StatusPill>}
          </div>
          <h3 className="mt-0.5 text-body font-semibold text-fg">{focus.title}</h3>
          <p className="mt-0.5 text-small text-muted">
            {state?.objective || focus.summary}
          </p>
        </div>
      </div>

      {hasDetails && state && (
        <div className={cn('mt-3 grid gap-3 border-t border-primary/15 pt-3', compact ? 'sm:grid-cols-2' : 'md:grid-cols-2 xl:grid-cols-4')}>
          {state.candidates.length > 0 && (
            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-caption font-semibold text-muted">
                <GitBranch className="h-3.5 w-3.5" aria-hidden /> Options
              </p>
              <ul className="space-y-1.5">
                {state.candidates.slice(0, itemLimit).map((candidate) => (
                  <li key={candidate.id} className="text-small text-fg">
                    <span className={cn(
                      'mr-1.5 text-caption font-semibold',
                      candidate.status === 'selected' && 'text-success',
                      candidate.status === 'considering' && 'text-info',
                      candidate.status === 'rejected' && 'text-faint',
                    )}>
                      {CANDIDATE_LABEL[candidate.status]}:
                    </span>
                    <span className={cn(candidate.status === 'rejected' && 'text-faint line-through')}>
                      {candidate.label}
                    </span>
                    {candidate.note && <span className="text-muted"> — {candidate.note}</span>}
                  </li>
                ))}
                <MoreCount count={state.candidates.length - itemLimit} />
              </ul>
            </div>
          )}

          {(state.decisions.length > 0 || state.constraints.length > 0) && (
            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-caption font-semibold text-muted">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Decided
              </p>
              <ul className="space-y-1 text-small text-fg">
                {state.decisions.slice(0, itemLimit).map((decision) => <li key={`decision:${decision}`}>• {decision}</li>)}
                {state.constraints.slice(0, Math.max(0, itemLimit - Math.min(itemLimit, state.decisions.length))).map((constraint) => (
                  <li key={`constraint:${constraint}`} className="text-muted">
                    <ShieldCheck className="mr-1 inline h-3.5 w-3.5" aria-hidden />{constraint}
                  </li>
                ))}
                <MoreCount count={state.decisions.length + state.constraints.length - itemLimit} />
              </ul>
            </div>
          )}

          {state.openLoops.length > 0 && (
            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-caption font-semibold text-muted">
                <CircleHelp className="h-3.5 w-3.5" aria-hidden /> Still open
              </p>
              <ul className="space-y-1 text-small text-fg">
                {state.openLoops.slice(0, itemLimit).map((loop) => <li key={`open:${loop}`}>• {loop}</li>)}
                <MoreCount count={state.openLoops.length - itemLimit} />
              </ul>
            </div>
          )}

          {state.actions.length > 0 && (
            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-caption font-semibold text-muted">
                <ListChecks className="h-3.5 w-3.5" aria-hidden /> In motion
              </p>
              <ul className="space-y-1.5">
                {state.actions.slice(0, itemLimit).map((action) => {
                  const href = focusActionHref(action);
                  const content = (
                    <>
                      <StatusPill tone={ACTION_TONE[action.status]} className="mr-1.5">
                        {ACTION_LABEL[action.status]}
                      </StatusPill>
                      <span className="text-small text-fg">{action.label}</span>
                      {href && <ExternalLink className="ml-1 inline h-3 w-3 text-faint" aria-hidden />}
                    </>
                  );
                  return (
                    <li key={action.id}>
                      {href
                        ? <Link to={href} className="inline-flex items-center hover:underline">{content}</Link>
                        : <span className="inline-flex items-center">{content}</span>}
                      {action.note && <p className="mt-0.5 text-caption text-muted">{action.note}</p>}
                    </li>
                  );
                })}
                <MoreCount count={state.actions.length - itemLimit} />
              </ul>
            </div>
          )}
        </div>
      )}

      {!compact && (
        <p className="mt-3 border-t border-primary/15 pt-2 text-caption text-faint">
          Shared context Clementine carries across conversations and connected work.
        </p>
      )}
    </section>
  );
}
