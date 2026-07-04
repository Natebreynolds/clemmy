/**
 * Pure reducer that folds a workflow run's durable event log (the events.jsonl
 * served by GET /api/console/workflows/:name/runs/:runId/events) into a
 * step-grouped run detail: per-step status, duration, output, error, forEach
 * item counts, retries, per-attempt records, judge/quality advisories, and
 * best-effort tokens/cost — plus the run summary. Mirrors the live poll's raw
 * event stream into the structured, inspectable shape the drawer renders for a
 * FINISHED run (not just a flat milestone list).
 *
 * No React, no I/O — kept pure so it is unit-testable and the component stays a
 * thin renderer (same split as activity-lanes.ts / NowStrip).
 */

export interface WorkflowAttemptRecord {
  attemptIndex: number;
  maxAttempts: number;
  failedProblems: string[];
  changeSummary: string;
  metrics: { durationMs?: number; tokens?: number; toolCalls?: number };
}

export interface WorkflowRunAdvisory {
  reason: string;
  note: string;
}

export type WorkflowStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface WorkflowRunStep {
  stepId: string;
  status: WorkflowStepStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  output: string;
  error: string;
  skippedReason: string;
  retries: number;
  advisories: WorkflowRunAdvisory[];
  attempts: WorkflowAttemptRecord[];
  items: { started: number; completed: number; failed: number };
  /** Best-effort: completion-event tokens, else summed from attempt samples. */
  tokens?: number;
  costUsd?: number;
}

export interface WorkflowRunSummary {
  because: string;
  needsAttention: boolean;
  artifacts: { counts: string[]; files: string[]; urls: string[] };
}

export type WorkflowRunStatus = 'unknown' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface WorkflowRunDetail {
  steps: WorkflowRunStep[];
  summary: WorkflowRunSummary | null;
  runStatus: WorkflowRunStatus;
  runStartedAt?: string;
  runFinishedAt?: string;
  durationMs?: number;
  /** Sum of per-step tokens (undefined when no step carried a token count). */
  tokensTotal?: number;
}

type Ev = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function asMeta(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

function outputText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function parseAttempt(v: unknown): WorkflowAttemptRecord | null {
  const a = asMeta(v);
  const attemptIndex = num(a.attemptIndex);
  if (attemptIndex === undefined) return null;
  const metrics = asMeta(a.metrics);
  return {
    attemptIndex,
    maxAttempts: num(a.maxAttempts) ?? 0,
    failedProblems: asStringArray(a.failedProblems),
    changeSummary: str(a.changeSummary),
    metrics: {
      durationMs: num(metrics.durationMs),
      tokens: num(metrics.tokens),
      toolCalls: num(metrics.toolCalls),
    },
  };
}

function emptyStep(stepId: string): WorkflowRunStep {
  return {
    stepId,
    status: 'pending',
    output: '',
    error: '',
    skippedReason: '',
    retries: 0,
    advisories: [],
    attempts: [],
    items: { started: 0, completed: 0, failed: 0 },
  };
}

export function buildWorkflowRunDetail(events: ReadonlyArray<Ev> | undefined): WorkflowRunDetail {
  const order: string[] = [];
  const byStep = new Map<string, WorkflowRunStep>();
  let summary: WorkflowRunSummary | null = null;
  let runStatus: WorkflowRunStatus = 'unknown';
  let runStartedAt: string | undefined;
  let runFinishedAt: string | undefined;

  const ensure = (stepId: string): WorkflowRunStep => {
    let s = byStep.get(stepId);
    if (!s) {
      s = emptyStep(stepId);
      byStep.set(stepId, s);
      order.push(stepId);
    }
    return s;
  };

  for (const ev of events ?? []) {
    const kind = str(ev.kind);
    const t = str(ev.t);
    if (kind === 'run_started') { runStartedAt = t; if (runStatus === 'unknown') runStatus = 'running'; continue; }
    if (kind === 'run_completed') { runFinishedAt = t; runStatus = 'completed'; continue; }
    if (kind === 'run_failed') { runFinishedAt = t; runStatus = 'failed'; continue; }
    if (kind === 'run_cancelled') { runFinishedAt = t; runStatus = 'cancelled'; continue; }
    if (kind === 'run_summary') {
      const meta = asMeta(ev.meta);
      const artifacts = asMeta(meta.artifacts);
      summary = {
        because: str(meta.because),
        needsAttention: meta.needsAttention === true,
        artifacts: {
          counts: asStringArray(artifacts.counts),
          files: asStringArray(artifacts.files),
          urls: asStringArray(artifacts.urls),
        },
      };
      continue;
    }
    const stepId = str(ev.stepId);
    if (!stepId) continue;
    const s = ensure(stepId);
    const meta = asMeta(ev.meta);
    switch (kind) {
      case 'step_started':
        s.status = 'running';
        s.startedAt = t;
        break;
      case 'step_completed':
        s.status = 'done';
        s.finishedAt = t;
        s.output = outputText(ev.output);
        if (num(meta.tokens) !== undefined) s.tokens = num(meta.tokens);
        if (num(meta.costUsd) !== undefined) s.costUsd = num(meta.costUsd);
        break;
      case 'step_failed':
        s.status = 'failed';
        s.finishedAt = t;
        s.error = str(ev.error);
        break;
      case 'step_skipped':
        s.status = 'skipped';
        s.finishedAt = t;
        s.skippedReason = str(meta.reason);
        break;
      case 'step_retry':
      case 'step_loop_retry':
        s.retries += 1;
        break;
      case 'attempt_record': {
        const rec = parseAttempt(ev.attempt);
        if (rec) s.attempts.push(rec);
        break;
      }
      case 'step_advisory':
        s.advisories.push({ reason: str(meta.reason) || 'advisory', note: str(meta.note) });
        break;
      case 'item_started':
        s.items.started += 1;
        break;
      case 'item_completed':
        s.items.completed += 1;
        break;
      case 'item_failed':
        s.items.failed += 1;
        break;
      default:
        break;
    }
  }

  // Finalize: per-step duration + token rollup (completion meta, else attempt
  // samples), then the run-level token total.
  let tokensTotal: number | undefined;
  const steps = order.map((id) => {
    const s = byStep.get(id)!;
    if (s.startedAt && s.finishedAt) {
      const d = Date.parse(s.finishedAt) - Date.parse(s.startedAt);
      if (Number.isFinite(d) && d >= 0) s.durationMs = d;
    }
    if (s.tokens === undefined && s.attempts.length > 0) {
      let sum = 0;
      let seen = false;
      for (const a of s.attempts) {
        if (a.metrics.tokens !== undefined) { sum += a.metrics.tokens; seen = true; }
      }
      if (seen) s.tokens = sum;
    }
    if (s.tokens !== undefined) tokensTotal = (tokensTotal ?? 0) + s.tokens;
    return s;
  });

  const durationMs = runStartedAt && runFinishedAt
    ? (() => {
        const d = Date.parse(runFinishedAt) - Date.parse(runStartedAt);
        return Number.isFinite(d) && d >= 0 ? d : undefined;
      })()
    : undefined;

  return { steps, summary, runStatus, runStartedAt, runFinishedAt, durationMs, tokensTotal };
}

/** Friendly, human labels for the advisory reasons the runner emits (incl. the
 *  newer self-improvement / resilience flags). Unknown reasons fall back to the
 *  raw slug with underscores spaced out. */
const ADVISORY_LABELS: Record<string, string> = {
  brain_fallover: 'Switched brain',
  skill_not_executed: 'Skill deliverable not confirmed',
  ungrounded_output: 'Output not grounded in tool results',
  inferred_output_contract: 'Output contract inferred',
  contract_tightened: 'Success contract tightened',
  self_heal_reverted: 'Auto-heal reverted (regressed)',
  synthesis_degraded: 'Synthesis degraded / fell back',
  batch_sibling_failed_while_parked: 'Sibling batch item failed while parked',
  foreach_batched: 'Multi-item step batched into forEach',
  empty_output: 'Empty output',
  output_contract: 'Output contract not met',
};

export function advisoryLabel(reason: string): string {
  return ADVISORY_LABELS[reason] ?? reason.replace(/_/g, ' ');
}

/** Advisories that are self-improvements / informational rather than problems —
 *  drives tone so a "contract tightened" note doesn't read like a failure. */
const ADVISORY_POSITIVE = new Set(['contract_tightened', 'inferred_output_contract', 'foreach_batched']);

export function advisoryTone(reason: string): 'success' | 'warning' {
  return ADVISORY_POSITIVE.has(reason) ? 'success' : 'warning';
}
