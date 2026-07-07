/**
 * Structured, read-only detail for a workflow run — the step-grouped view the
 * drawer shows for a FINISHED run (or a live one). Folds the raw event log via
 * buildWorkflowRunDetail and renders, per step: status, duration, tokens/cost,
 * retries, forEach item counts, error, expandable output, judge/quality
 * advisories (with the note), and the per-attempt sub-timeline (index/max,
 * change summary, failed problems, duration/tokens/tool-calls). Above the steps
 * sits the run summary (because · artifacts · needs-attention).
 *
 * Presentational only — all folding lives in lib/workflow-run-detail.ts.
 */
import { useMemo } from 'react';
import { CheckCircle2, AlertCircle, AlertTriangle, Radio, Circle, MinusCircle, Package } from 'lucide-react';
import { cn } from '@/lib/cn';
import { StatusPill, type Tone } from '@/components/ui/StatusPill';
import {
  advisoryLabel,
  advisoryTone,
  buildWorkflowRunDetail,
  type WorkflowRunStep,
  type WorkflowStepStatus,
} from '@/lib/workflow-run-detail';

const STEP_TONE: Record<WorkflowStepStatus, Tone> = {
  done: 'success',
  blocked: 'warning',
  failed: 'danger',
  running: 'live',
  skipped: 'neutral',
  pending: 'neutral',
};

const STEP_ICON = {
  done: CheckCircle2,
  blocked: AlertTriangle,
  failed: AlertCircle,
  running: Radio,
  skipped: MinusCircle,
  pending: Circle,
} as const;

function formatDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs < 10 ? secs.toFixed(1) : Math.round(secs)}s`;
  const min = Math.floor(secs / 60);
  return `${min}m ${Math.round(secs - min * 60)}s`;
}

function formatTokens(n?: number): string {
  if (n === undefined || !Number.isFinite(n)) return '';
  if (n < 1000) return `${n} tok`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k tok`;
  return `${(n / 1_000_000).toFixed(1)}M tok`;
}

function firstLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat || '(empty)';
}

export function WorkflowRunDetail({ events }: { events: ReadonlyArray<Record<string, unknown>> }) {
  const detail = useMemo(() => buildWorkflowRunDetail(events), [events]);

  if (detail.steps.length === 0 && !detail.summary) {
    return <p className="text-body text-faint">No step events recorded yet — the trace streams in as the run works.</p>;
  }

  return (
    <div className="space-y-3">
      {detail.summary && (
        <div
          className={cn(
            'rounded-md border-l-2 border border-border px-3 py-2.5',
            detail.summary.needsAttention ? 'border-l-warning' : 'border-l-success',
          )}
        >
          <div className="mb-1 flex items-center gap-2">
            <StatusPill tone={detail.summary.needsAttention ? 'warning' : 'success'}>
              {detail.summary.needsAttention ? 'Needs attention' : 'Completed'}
            </StatusPill>
            {detail.tokensTotal !== undefined && (
              <span className="text-caption tabular-nums text-faint">{formatTokens(detail.tokensTotal)}</span>
            )}
            {detail.durationMs !== undefined && (
              <span className="text-caption tabular-nums text-faint">{formatDuration(detail.durationMs)}</span>
            )}
          </div>
          {detail.summary.because && <div className="text-small text-fg">{detail.summary.because}</div>}
          {(() => {
            const a = detail.summary.artifacts;
            const produced = [...a.counts, ...a.files, ...a.urls];
            return produced.length > 0 ? (
              <div className="mt-1.5 flex items-start gap-1.5 text-caption text-muted">
                <Package className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 break-words">{produced.slice(0, 12).join(' · ')}</span>
              </div>
            ) : null;
          })()}
        </div>
      )}

      <ol className="space-y-2">
        {detail.steps.map((s) => (
          <StepRow key={s.stepId} step={s} />
        ))}
      </ol>
    </div>
  );
}

function StepRow({ step }: { step: WorkflowRunStep }) {
  const Icon = STEP_ICON[step.status];
  const tokens = formatTokens(step.tokens);
  const cost = step.costUsd !== undefined ? `$${step.costUsd.toFixed(step.costUsd < 1 ? 3 : 2)}` : '';
  const costBits = [tokens, cost].filter(Boolean).join(' · ');
  const dur = formatDuration(step.durationMs);

  return (
    <li
      className={cn(
        'rounded-md border border-border border-l-2 px-3 py-2',
        step.status === 'done' && 'border-l-success',
        step.status === 'blocked' && 'border-l-warning',
        step.status === 'failed' && 'border-l-danger',
        step.status === 'running' && 'border-l-primary',
        (step.status === 'skipped' || step.status === 'pending') && 'border-l-border',
      )}
    >
      <div className="flex items-center gap-2">
        <Icon
          className={cn(
            'h-4 w-4 shrink-0',
            STEP_TONE[step.status] === 'success' && 'text-success',
            STEP_TONE[step.status] === 'warning' && 'text-warning',
            STEP_TONE[step.status] === 'danger' && 'text-danger',
            STEP_TONE[step.status] === 'live' && 'text-primary',
            STEP_TONE[step.status] === 'neutral' && 'text-faint',
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-small font-semibold text-fg">{step.stepId}</span>
        <span className="text-caption uppercase tracking-wide text-faint">{step.status}</span>
        {dur && <span className="text-caption tabular-nums text-faint">{dur}</span>}
        {costBits && <span className="text-caption tabular-nums text-primary">{costBits}</span>}
        {step.retries > 0 && (
          <span className="text-caption tabular-nums text-warning">
            {step.retries} {step.retries === 1 ? 'retry' : 'retries'}
          </span>
        )}
      </div>

      {(step.items.started > 0 || step.items.failed > 0) && (
        <div className="mt-1.5 text-caption tabular-nums text-muted">
          items: {step.items.completed}/{step.items.started} done
          {step.items.failed > 0 && <span className="text-danger"> · {step.items.failed} failed</span>}
        </div>
      )}

      {step.status === 'skipped' && step.skippedReason && (
        <div className="mt-1.5 text-caption text-faint">skipped: {step.skippedReason}</div>
      )}

      {step.error && (
        <div
          className={cn(
            'mt-1.5 whitespace-pre-wrap break-words rounded-sm border px-2 py-1.5 text-caption',
            step.status === 'blocked'
              ? 'border-warning/40 bg-warning-tint text-warning'
              : 'border-danger/40 bg-danger-tint text-danger',
          )}
        >
          {step.status === 'blocked' ? `Blocked: ${step.error}` : step.error}
        </div>
      )}

      {step.output && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-caption text-muted hover:text-fg">{firstLine(step.output)}</summary>
          <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-canvas p-2 text-caption text-muted">
            {step.output}
          </pre>
        </details>
      )}

      {step.advisories.length > 0 && (
        <div className="mt-2 border-t border-border pt-2">
          <div className="mb-1 text-caption font-semibold uppercase tracking-wide text-faint">Judge / quality verdicts</div>
          <ul className="space-y-1.5">
            {step.advisories.map((a, i) => (
              <li
                key={`${a.reason}-${i}`}
                className={cn(
                  'border-l-2 pl-2',
                  advisoryTone(a.reason) === 'success' ? 'border-l-success' : 'border-l-warning',
                )}
              >
                <div
                  className={cn(
                    'text-caption font-semibold',
                    advisoryTone(a.reason) === 'success' ? 'text-success' : 'text-warning',
                  )}
                >
                  {advisoryLabel(a.reason)}
                </div>
                {a.note && <div className="text-caption text-muted">{a.note}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {step.attempts.length > 0 && (
        <div className="mt-2 border-t border-border pt-2">
          <div className="mb-1 text-caption font-semibold uppercase tracking-wide text-faint">Attempts</div>
          <ul className="space-y-1.5">
            {step.attempts.map((a, i) => {
              const bits = [
                formatDuration(a.metrics.durationMs),
                a.metrics.tokens !== undefined ? formatTokens(a.metrics.tokens) : '',
                a.metrics.toolCalls !== undefined ? `${a.metrics.toolCalls} tools` : '',
              ].filter(Boolean).join(' · ');
              return (
                <li key={`attempt-${a.attemptIndex}-${i}`} className="border-l-2 border-l-border pl-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-caption font-semibold tabular-nums text-warning">
                      #{a.attemptIndex}
                      {a.maxAttempts ? ` / ${a.maxAttempts}` : ''}
                    </span>
                    {bits && <span className="text-caption tabular-nums text-faint">{bits}</span>}
                  </div>
                  {a.changeSummary && <div className="mt-0.5 text-caption text-muted">{a.changeSummary}</div>}
                  {a.failedProblems.length > 0 && (
                    <ul className="mt-0.5 list-disc pl-4">
                      {a.failedProblems.slice(0, 6).map((p, j) => (
                        <li key={j} className="text-caption text-faint">{p}</li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </li>
  );
}
