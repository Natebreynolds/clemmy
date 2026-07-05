/**
 * Provable workflow dry-run — a side-effect-free, end-to-end SIMULATION of a
 * workflow that answers "what will this actually do?" before a single step runs.
 *
 * This is the trace layer above the plan/readiness/contract spine. It executes
 * NOTHING — no LLM, no tools, no sends — but it composes the canonical analyses
 * into one grounded account:
 *   - the ordered execution WAVES (from the plan's dependency levels),
 *   - a per-step TRACE (executor, side-effect class, external surface it
 *     touches, what it reads from upstream, what it emits, whether it's gated),
 *   - and — the headline — an EFFECTS rollup that enumerates every step that
 *     will WRITE or irreversibly SEND to the outside world, so nothing hidden
 *     touches or sends.
 *
 * Every claim is derived from the shared classifier / plan / readiness, not from
 * prose — that's what makes it "provable". The structured result is also the
 * data contract the visual dry-run preview renders from.
 */
import type { WorkflowDefinition, WorkflowStepInput } from '../memory/workflow-store.js';
import { shortStepLabel } from './workflow-describe.js';
import { classifyStepSideEffect, type StepSideEffectClass } from './workflow-enforce.js';
import { preflightWorkflow } from './workflow-preflight.js';
import { checkWorkflowRunReadiness } from './workflow-run-readiness.js';
import type {
  WorkflowExecutionPlan,
  WorkflowExecutionVisualContract,
  WorkflowToolReadinessItem,
} from '../dashboard/workflow-execution-plan.js';

export type WorkflowDryRunVerdict = 'ready' | 'needs_inputs' | 'blocked';
export type WorkflowDryRunExecutor = 'model' | 'skill' | 'deterministic' | 'call';
/** What the step does to the OUTSIDE world when the workflow runs for real. */
export type WorkflowDryRunEffect = 'external_send' | 'external_write' | 'read_only' | 'internal';

export interface WorkflowDryRunStep {
  stepId: string;
  label: string;
  wave: number;
  executor: WorkflowDryRunExecutor;
  sideEffect: StepSideEffectClass;
  effect: WorkflowDryRunEffect;
  touches: { tools: string[]; skills: string[]; scripts: string[]; project: string | null };
  reads: string[];
  emits: string | null;
  gated: boolean;
  fanout: { source: string; newOnly: boolean } | null;
  model: string | null;
}

export interface WorkflowDryRunSimulation {
  workflow: string;
  verdict: WorkflowDryRunVerdict;
  runnable: boolean;
  summary: string;
  waves: Array<{ index: number; stepIds: string[]; parallel: boolean }>;
  criticalPath: string[];
  steps: WorkflowDryRunStep[];
  effects: {
    sends: Array<{ stepId: string; detail: string }>;
    writes: Array<{ stepId: string; detail: string }>;
    readSteps: number;
    toolsTouched: string[];
    approvals: string[];
  };
  readiness: { blockers: WorkflowToolReadinessItem[]; warnings: WorkflowToolReadinessItem[] };
  contract: WorkflowExecutionVisualContract;
  contractAdvisories: string[];
  missingInputs: string[];
  blockingReasons: string[];
  plan: WorkflowExecutionPlan;
}

export interface SimulateWorkflowDryRunOptions {
  workflowSlug?: string;
  inputs?: Record<string, string>;
}

function executorFor(step: WorkflowStepInput): WorkflowDryRunExecutor {
  if (step.call?.tool) return 'call';
  if (step.deterministic?.runner) return 'deterministic';
  if (step.usesSkill) return 'skill';
  return 'model';
}

function effectFor(sideEffect: StepSideEffectClass): WorkflowDryRunEffect {
  if (sideEffect === 'send') return 'external_send';
  if (sideEffect === 'write') return 'external_write';
  if (sideEffect === 'read') return 'read_only';
  return 'internal';
}

function uniqueTrimmed(items: Array<string | undefined | null>): string[] {
  return Array.from(new Set(items.map((i) => i?.trim()).filter((i): i is string => Boolean(i))));
}

function forEachSourceStepId(expr: string | undefined, ids: Set<string>): string | null {
  if (!expr) return null;
  const raw = expr.trim();
  if (!raw || raw.startsWith('input.') || raw === 'items') return null;
  const head = raw.split('.')[0] || null;
  return head && ids.has(head) ? head : null;
}

function stepReads(step: WorkflowStepInput, ids: Set<string>): string[] {
  const deps = Array.isArray(step.dependsOn) ? step.dependsOn.filter((d) => ids.has(d)) : [];
  const forEachSource = forEachSourceStepId(step.forEach, ids);
  return uniqueTrimmed([...deps, forEachSource]);
}

function stepEmits(step: WorkflowStepInput): string | null {
  const type = (step.output as { type?: unknown } | undefined)?.type;
  return typeof type === 'string' && type.trim() ? type.trim() : null;
}

function effectDetail(step: WorkflowStepInput, touches: WorkflowDryRunStep['touches']): string {
  const surface = [
    ...touches.tools,
    ...(touches.project ? [`project:${touches.project}`] : []),
  ];
  const via = surface.length ? ` via ${surface.slice(0, 4).join(', ')}` : '';
  return `${shortStepLabel(step.prompt || step.id)}${via}`;
}

/**
 * Simulate a full workflow run WITHOUT executing anything. Returns a grounded,
 * per-step trace plus a rollup of every external write/send the real run would
 * perform — the "here is exactly what this will do" preview.
 */
export function simulateWorkflowDryRun(
  def: WorkflowDefinition,
  options: SimulateWorkflowDryRunOptions = {},
): WorkflowDryRunSimulation {
  const steps = def.steps ?? [];
  const ids = new Set(steps.map((s) => s.id));

  // One call gives us the built plan (waves, fanout, gates, tool surface,
  // visual contract) AND the readiness blocker/warning partition.
  const readiness = checkWorkflowRunReadiness(def, options.workflowSlug, {});
  const plan = readiness.plan;
  const preflight = preflightWorkflow(def, options.inputs ?? {});

  const waveByStep = new Map<string, number>();
  for (const level of plan.levels) {
    for (const stepId of level.stepIds) waveByStep.set(stepId, level.index);
  }
  const fanoutByStep = new Map(plan.fanout.map((f) => [f.stepId, f]));

  const traced: WorkflowDryRunStep[] = steps.map((step) => {
    const sideEffect = classifyStepSideEffect(step);
    const touches = {
      tools: uniqueTrimmed([...(step.allowedTools ?? []), step.call?.tool]),
      skills: uniqueTrimmed([step.usesSkill]),
      scripts: uniqueTrimmed([step.deterministic?.runner]),
      project: step.project?.trim() || def.project?.trim() || null,
    };
    const fan = fanoutByStep.get(step.id);
    return {
      stepId: step.id,
      label: shortStepLabel(step.prompt || step.id),
      wave: waveByStep.get(step.id) ?? 0,
      executor: executorFor(step),
      sideEffect,
      effect: effectFor(sideEffect),
      touches,
      reads: stepReads(step, ids),
      emits: stepEmits(step),
      gated: step.requiresApproval === true,
      fanout: fan ? { source: fan.source, newOnly: fan.newOnly } : null,
      model: step.model ?? null,
    };
  });

  const sends = traced
    .filter((s) => s.effect === 'external_send')
    .map((s) => ({ stepId: s.stepId, detail: effectDetail(stepFor(steps, s.stepId), s.touches) }));
  const writes = traced
    .filter((s) => s.effect === 'external_write')
    .map((s) => ({ stepId: s.stepId, detail: effectDetail(stepFor(steps, s.stepId), s.touches) }));
  const toolsTouched = uniqueTrimmed(traced.flatMap((s) => s.touches.tools)).sort();
  const approvals = traced.filter((s) => s.gated).map((s) => s.stepId);

  const contract = plan.visualContract;
  // The dry-run's runnable verdict mirrors exactly what the queue would REFUSE:
  // a structural preflight error, or an authoritatively-missing capability
  // (skill / script / project). The visual contract is richer authoring
  // guidance (model portability, judge gates, plain-tool readiness) and can flag
  // `block` on non-authoritative signal — that INFORMS but must not, on its own,
  // declare a runnable workflow un-runnable. Guardrails inform; they don't
  // override. Contract blocks are surfaced as advisories below.
  const blockingReasons = uniqueTrimmed([
    ...preflight.errors,
    ...readiness.blockers.map((b) => `${b.kind} "${b.name}" is missing — ${b.reason}`),
  ]);
  const contractAdvisories = uniqueTrimmed(
    contract.checks.filter((c) => c.status !== 'pass').map((c) => `${c.label}: ${c.detail}`),
  );

  const verdict: WorkflowDryRunVerdict = blockingReasons.length > 0
    ? 'blocked'
    : preflight.missingInputs.length > 0 ? 'needs_inputs' : 'ready';
  const runnable = verdict !== 'blocked';

  return {
    workflow: def.name,
    verdict,
    runnable,
    summary: renderSummary(def.name, verdict, traced.length, sends.length, writes.length, preflight.missingInputs),
    waves: plan.levels.map((level) => ({ index: level.index, stepIds: level.stepIds, parallel: level.parallel })),
    criticalPath: plan.criticalPath,
    steps: traced,
    effects: { sends, writes, readSteps: traced.filter((s) => s.effect === 'read_only').length, toolsTouched, approvals },
    readiness: { blockers: readiness.blockers, warnings: readiness.warnings },
    contract,
    contractAdvisories,
    missingInputs: preflight.missingInputs,
    blockingReasons,
    plan,
  };
}

function stepFor(steps: WorkflowStepInput[], stepId: string): WorkflowStepInput {
  return steps.find((s) => s.id === stepId) ?? { id: stepId, prompt: '' };
}

function renderSummary(
  name: string,
  verdict: WorkflowDryRunVerdict,
  stepCount: number,
  sendCount: number,
  writeCount: number,
  missingInputs: string[],
): string {
  const effectPhrase = sendCount === 0 && writeCount === 0
    ? 'no external writes or sends'
    : [
        writeCount > 0 ? `${writeCount} external write${writeCount === 1 ? '' : 's'}` : '',
        sendCount > 0 ? `${sendCount} irreversible send${sendCount === 1 ? '' : 's'}` : '',
      ].filter(Boolean).join(' and ');
  if (verdict === 'blocked') {
    return `Dry-run of "${name}" is BLOCKED — it would attempt ${effectPhrase} across ${stepCount} step${stepCount === 1 ? '' : 's'}, but a required capability or structural check fails first.`;
  }
  if (verdict === 'needs_inputs') {
    return `Dry-run of "${name}" is runnable once you supply ${missingInputs.map((k) => `"${k}"`).join(', ')} — it would perform ${effectPhrase} across ${stepCount} step${stepCount === 1 ? '' : 's'}.`;
  }
  return `Dry-run of "${name}" is READY — ${stepCount} step${stepCount === 1 ? '' : 's'}, ${effectPhrase}.`;
}

const EFFECT_ICON: Record<WorkflowDryRunEffect, string> = {
  external_send: '📤',
  external_write: '✏️',
  read_only: '👁️',
  internal: '•',
};

/** Render the simulation as a legible report for chat / the authoring agent.
 *  Leads with the effects rollup — the "what will it touch/send" preview. */
export function renderWorkflowDryRunSimulation(sim: WorkflowDryRunSimulation): string {
  const verdictLabel = sim.verdict === 'ready' ? '✅ READY' : sim.verdict === 'needs_inputs' ? '⌗ NEEDS INPUTS' : '⛔ BLOCKED';
  const lines: string[] = [`${verdictLabel} · Dry-run simulation: ${sim.workflow}`, sim.summary, ''];

  if (sim.effects.sends.length > 0) {
    lines.push('Will SEND (irreversible):', ...sim.effects.sends.map((e) => `  📤 ${e.stepId} — ${e.detail}`), '');
  }
  if (sim.effects.writes.length > 0) {
    lines.push('Will WRITE (external state):', ...sim.effects.writes.map((e) => `  ✏️ ${e.stepId} — ${e.detail}`), '');
  }
  if (sim.effects.sends.length === 0 && sim.effects.writes.length === 0) {
    lines.push('No external writes or sends — this run only reads and reasons.', '');
  }
  if (sim.effects.approvals.length > 0) {
    lines.push(`Gated on approval: ${sim.effects.approvals.join(', ')}.`, '');
  }

  lines.push('Execution waves:');
  for (const wave of sim.waves) {
    const stepTraces = wave.stepIds.map((id) => {
      const s = sim.steps.find((t) => t.stepId === id);
      return s ? `${EFFECT_ICON[s.effect]} ${s.stepId}` : id;
    });
    lines.push(`  ${wave.index + 1}. ${wave.parallel ? '(parallel) ' : ''}${stepTraces.join('  ')}`);
  }

  if (sim.blockingReasons.length > 0) {
    lines.push('', 'Blocking before it can run:', ...sim.blockingReasons.slice(0, 8).map((r) => `  - ${r}`));
  }
  if (sim.contractAdvisories.length > 0) {
    lines.push('', 'Contract advisories (worth fixing, not blocking):', ...sim.contractAdvisories.slice(0, 6).map((a) => `  - ${a}`));
  }
  if (sim.readiness.warnings.length > 0) {
    lines.push('', `Unconfirmed (not blocking): ${sim.readiness.warnings.slice(0, 5).map((w) => `${w.kind}:${w.name}`).join(', ')}.`);
  }
  lines.push('', 'Note: a dry-run simulates without executing — no tools ran, nothing was sent.');
  return lines.join('\n');
}
