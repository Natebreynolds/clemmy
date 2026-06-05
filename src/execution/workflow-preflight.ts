/**
 * Workflow PREFLIGHT — a safe, side-effect-free "would this run?" smoke-test.
 *
 * Backs the dashboard DRY-RUN button (previously dead: the route wrote a
 * `dry_run` record the drain never processed) and the confidence line a
 * freshly-promoted workflow gets. It deliberately does NOT execute steps —
 * no LLM, no tools, no emails/writes — so it's always safe to run on a
 * disabled draft.
 *
 * Strategic (no new validation logic): it COMPOSES the existing canonical
 * checks — checkWorkflowForWrite (structure / dataflow / send-gate / cron /
 * timezone) + missingWorkflowRunInputs (runtime input satisfiability) — and
 * presents them as a single "runnable / not yet" verdict. Structural problems
 * fail the preflight; missing run inputs are reported as a heads-up (the
 * workflow IS runnable once they're supplied), not a failure.
 */
import type { WorkflowDefinition } from '../memory/workflow-store.js';
import { checkWorkflowForWrite } from './workflow-enforce.js';
import {
  missingWorkflowRunInputs,
  normalizeWorkflowRunInputs,
} from './workflow-inputs.js';

export interface PreflightResult {
  /** Structurally runnable (missing run inputs do NOT flip this false). */
  ok: boolean;
  /** Blocking structural problems (a workflow with these can't run). */
  errors: string[];
  /** Non-blocking authoring advisories. */
  warnings: string[];
  /** Inputs the workflow needs at run time that weren't supplied here. */
  missingInputs: string[];
  /** One-line human verdict. */
  summary: string;
}

export function preflightWorkflow(
  def: WorkflowDefinition,
  runInputs: Record<string, string> = {},
): PreflightResult {
  const check = checkWorkflowForWrite(def);
  const inputs = normalizeWorkflowRunInputs({
    ...Object.fromEntries(
      Object.entries(def.inputs ?? {}).map(([k, meta]) => [k, meta.default ?? '']),
    ),
    ...runInputs,
  });
  const missingInputs = missingWorkflowRunInputs(def, inputs);
  const ok = check.ok;
  const stepCount = def.steps?.length ?? 0;
  const summary = ok
    ? `Preflight passed — ${stepCount} step${stepCount === 1 ? '' : 's'} look runnable`
      + (missingInputs.length > 0
        ? `, but you'll need to supply ${missingInputs.map((k) => `"${k}"`).join(', ')} at run time.`
        : '.')
    : `Preflight found ${check.errors.length} blocking issue${check.errors.length === 1 ? '' : 's'} — fix before running.`;
  return { ok, errors: check.errors, warnings: check.warnings, missingInputs, summary };
}

/** Render a preflight result as a legible report body (notification / chat). */
export function renderPreflightReport(workflowName: string, result: PreflightResult): string {
  const lines: string[] = [
    result.ok ? `✅ Dry-run preflight: ${workflowName}` : `⚠️ Dry-run preflight: ${workflowName}`,
    result.summary,
  ];
  if (result.errors.length > 0) {
    lines.push('', 'Blocking issues:', ...result.errors.map((e) => `- ${e}`));
  }
  if (result.missingInputs.length > 0) {
    lines.push('', `Needs at run time: ${result.missingInputs.join(', ')}.`);
  }
  if (result.warnings.length > 0) {
    lines.push('', 'Advisories:', ...result.warnings.slice(0, 5).map((w) => `- ${w}`));
  }
  lines.push('', 'Note: a preflight checks runnability without executing — no tools ran, nothing was sent.');
  return lines.join('\n');
}
