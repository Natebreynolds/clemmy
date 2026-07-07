/**
 * CODIFY-ON-AUTHOR — Clem's compiler pass.
 *
 * Clem's #1 skill is creating workflows that save time and money. The expensive
 * reasoning ("how do I do this?") is paid ONCE, at authoring. This pass then
 * converts a mechanical LLM step — a fixed, single-tool operation whose args are
 * already knowable — into a direct `call` step that runs token-free, fast, and
 * deterministically every run. An LLM step is kept ONLY where judgment or
 * adaptation is genuinely needed.
 *
 * It is:
 *   - AUTOMATIC + INVISIBLE — runs inside commitAuthoredWorkflow; no user surface.
 *   - CONSERVATIVE — a gated rule; any doubt leaves the step a model step.
 *   - REVERSIBLE — stashes `codifiedFrom`, so self-heal can restore the model
 *     step if the coded call trips its output contract or the goal checker.
 *   - FORWARD-ONLY — only ADDS `call` shape to steps that were going to be model
 *     steps; existing workflows and every judgment step are untouched.
 *
 * No LLM and no async inside the pass: args are derived only from the author's
 * DECLARED `inputs` contract (deterministic). If args aren't mechanically
 * derivable, the step is left as a model step.
 */
import type { WorkflowDefinition, WorkflowStepInput } from '../memory/workflow-store.js';
import { codifiableStep } from './workflow-execution-mode.js';

export interface CodifyProposal {
  stepId: string;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}

/**
 * Derive the call's args purely from the step's DECLARED `inputs` contract —
 * the author already stated each arg and its source. Returns null when there is
 * no declared inputs contract (so we cannot know the tool's args deterministically).
 */
function deriveArgsFromDeclaredInputs(step: WorkflowStepInput): Record<string, unknown> | null {
  const inputs = step.inputs as Record<string, { from?: string; default?: unknown }> | undefined;
  if (!inputs || Object.keys(inputs).length === 0) return null;
  const args: Record<string, unknown> = {};
  for (const [name, binding] of Object.entries(inputs)) {
    const from = binding?.from?.trim();
    if (from) {
      args[name] = `{{${from}}}`;                 // input.x / steps.y.output[.path] / item[.path]
    } else if (binding?.default !== undefined) {
      args[name] = binding.default;
    } else {
      args[name] = `{{input.${name}}}`;           // conventional resolution by the input's own name
    }
  }
  return args;
}

/** THE RULE: propose a codified `call` for a step, or return null to keep it a
 *  model step. The mechanical/single-tool/contract/non-send/non-brittle gate is
 *  the shared `codifiableStep` predicate (so the operator's codifyCandidates
 *  display and this converter never disagree); codify adds ONE more gate on top:
 *  the args must be mechanically derivable from the declared `inputs` contract. */
export function proposeCodifiedStep(step: WorkflowStepInput): CodifyProposal | null {
  const gate = codifiableStep(step);
  if (!gate) return null;                                             // shared mechanical/contract gate
  const args = deriveArgsFromDeclaredInputs(step);
  if (!args) return null;                                             // args mechanically derivable from declared inputs
  return { stepId: step.id, tool: gate.tool, args, reason: `mechanical single-tool step with a declared contract — ran as a direct ${gate.tool} call` };
}

/** Non-mutating: every codify proposal for a definition. */
export function proposeCodifiedSteps(def: WorkflowDefinition): CodifyProposal[] {
  return (def.steps ?? []).map(proposeCodifiedStep).filter((p): p is CodifyProposal => p !== null);
}

export interface CodifyResult {
  codified: string[];
  notes: string[];
}

/**
 * In-place codify pass for the create seam (mirrors bindStepsToToolChoices):
 * converts eligible mechanical model steps to `call` steps, preserving the
 * original executor in `codifiedFrom` for reversibility. Returns which steps
 * were codified + operator-facing notes.
 */
export function codifyMechanicalSteps(steps: WorkflowStepInput[]): CodifyResult {
  const codified: string[] = [];
  const notes: string[] = [];
  for (const step of steps) {
    const proposal = proposeCodifiedStep(step);
    if (!proposal) continue;
    step.codifiedFrom = { prompt: step.prompt, ...(step.allowedTools ? { allowedTools: step.allowedTools } : {}) };
    step.call = { tool: proposal.tool, args: proposal.args };
    codified.push(step.id);
    notes.push(`Codified step \`${step.id}\` into a direct ${proposal.tool} call — it now runs as code (no AI, no tokens) every run. If the call ever fails its contract, self-heal restores the AI step.`);
  }
  return { codified, notes };
}
