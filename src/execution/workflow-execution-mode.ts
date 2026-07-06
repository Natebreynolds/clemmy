/**
 * Workflow EXECUTION MODE — how much of a workflow runs as code vs an agent.
 *
 * The product thesis this makes first-class: Clem's intelligence is the
 * COMPILER, not the runtime. It reasons once at authoring to emit steps that are
 * as coded as possible — a direct tool `call` or a `deterministic` script — and
 * uses an LLM step only where judgment is genuinely unavoidable. When there are
 * NO llm steps, the workflow runs as a pure DAG pipeline with no model calls at
 * all (executeStep dispatches call/deterministic without the harness): token-
 * free, fast, deterministic. That's the gold standard, and it should be a
 * visible target — for the operator AND for Clem's own authoring.
 *
 *   agentless — 0 llm steps: runs as pure code, no agent, no tokens per run
 *   hybrid    — code + llm: mechanical parts free, LLM only for the judgment
 *   agent     — all llm: reasoning re-paid every run (the thing to improve)
 *
 * Pure + deterministically tested.
 */
import type { WorkflowDefinition, WorkflowStepInput } from '../memory/workflow-store.js';
import { classifyStepSideEffect } from './workflow-enforce.js';
import { isDirectComposioActionSlug } from './workflow-direct-call.js';

export type WorkflowExecutionMode = 'agentless' | 'hybrid' | 'agent' | 'empty';
export type WorkflowStepExecutor = 'call' | 'deterministic' | 'skill' | 'model';

export interface WorkflowCodifyCandidate {
  stepId: string;
  /** Why this LLM step looks mechanical enough to become a coded step. */
  reason: string;
  /** The single tool it appears to need, when we can name it. */
  tool?: string;
}

export interface WorkflowExecutionModeReport {
  mode: WorkflowExecutionMode;
  stepCount: number;
  codeSteps: number;
  llmSteps: number;
  codeStepIds: string[];
  llmStepIds: string[];
  /** Fraction of steps that run as code, 0..1. */
  codeRatio: number;
  /** LLM steps that could plausibly be converted to code (path to agentless). */
  codifyCandidates: WorkflowCodifyCandidate[];
  label: string;
  summary: string;
}

export function stepExecutor(step: WorkflowStepInput): WorkflowStepExecutor {
  if (step.call?.tool) return 'call';
  if (step.deterministic?.runner) return 'deterministic';
  if (step.usesSkill) return 'skill';
  return 'model';
}

const isCode = (e: WorkflowStepExecutor) => e === 'call' || e === 'deterministic';

// A model step that reads as a single mechanical operation — a strong candidate
// to become a `call`/`deterministic` step so the run stops paying for reasoning.
export const MECHANICAL_PROMPT_RE =
  /^\s*(?:call|invoke|run|use|fetch|get|pull|read|query|list|retrieve|download|scrape|search|post|send|create|update|write|save|upload|export)\b/i;

// A step whose work is genuine JUDGMENT — an LLM has to write/decide/assess/
// adapt. These NEVER codify, even behind a mechanical-looking verb ("write the
// summary", "post the BEST 3"): a script can't do them, and codifying breaks
// the workflow. This is the guard the codify-criteria analysis demanded.
// Note: bare "rank" is deliberately excluded — it collides with the metric NOUN
// ("domain rank", "ranked keywords"). Ranking-as-judgment is covered by
// prioriti/select/choose, and the single-concrete-tool gate protects the rest.
export const JUDGMENT_PROMPT_RE =
  /\b(?:write|draft|compose|summari[sz]|assess|evaluate|decide|choose|select|prioriti|personali[sz]|classif|triage|recommend|analy[sz]e|interpret|judge|craft|tailor)\b/i;

// Tools whose result SHAPE drifts (SERP/HTML/scrape/crawl): a coded call breaks
// silently when the page or ranking layout changes, while an LLM step adapts.
// Never codify these — matched against the resolved tool slug.
export const BRITTLE_SLUG_RE = /(?:scrape|serp|firecrawl|brightdata|crawl|lighthouse|instant_pages|content_parsing|apify)/i;

/** A real, verifiable output contract (not a degenerate `non_empty:['']`). */
export function hasOutputContract(step: WorkflowStepInput): boolean {
  const o = step.output as { type?: unknown; required_keys?: unknown; non_empty?: unknown } | undefined;
  if (!o) return false;
  return Boolean(o.type || (Array.isArray(o.required_keys) && o.required_keys.length > 0) || o.non_empty);
}

/**
 * THE codify gate — the single predicate for "is this model step a mechanical
 * single-tool op that could run as a direct call?" Both this module (to surface
 * `codifyCandidates`) and workflow-codify (which adds arg-derivation to actually
 * convert) consume it, so the candidate list ALWAYS matches what codify will do.
 * It lives here, the lower module, to avoid a codify↔execution-mode cycle.
 * Requires: model executor, exactly one concrete direct-Composio tool, a
 * mechanical (non-judgment) prompt, a real output contract, not a send, not
 * human-gated, and not a shape-drifting brittle tool.
 */
export function codifiableStep(step: WorkflowStepInput): { tool: string; reason: string } | null {
  if (stepExecutor(step) !== 'model') return null;              // already coded/skill
  const tools = (step.allowedTools ?? []).filter((t) => t && t !== '*');
  if (tools.length !== 1) return null;                          // exactly one concrete tool
  const tool = tools[0];
  const prompt = (step.prompt ?? '').trim();
  if (!MECHANICAL_PROMPT_RE.test(prompt)) return null;          // clearly mechanical verb
  if (JUDGMENT_PROMPT_RE.test(prompt)) return null;             // …and NOT judgment → keep
  if (classifyStepSideEffect(step) === 'send') return null;     // irreversible send → keep
  if (step.requiresApproval) return null;                       // human-gated → keep
  if (!hasOutputContract(step)) return null;                    // no contract → can't verify → keep
  if (!isDirectComposioActionSlug(tool)) return null;           // direct-call runner handles Composio slugs
  if (BRITTLE_SLUG_RE.test(tool)) return null;                  // shape-drifting tool → keep adaptive LLM
  return { tool, reason: `mechanical step over one tool (${tool}) with an output contract — likely a direct call` };
}

export function classifyWorkflowExecutionMode(def: WorkflowDefinition): WorkflowExecutionModeReport {
  const steps = def.steps ?? [];
  const codeStepIds: string[] = [];
  const llmStepIds: string[] = [];
  const codifyCandidates: WorkflowCodifyCandidate[] = [];
  for (const step of steps) {
    const executor = stepExecutor(step);
    if (isCode(executor)) {
      codeStepIds.push(step.id);
    } else {
      llmStepIds.push(step.id);
      if (executor === 'model') {
        const c = codifiableStep(step);
        if (c) codifyCandidates.push({ stepId: step.id, reason: c.reason, tool: c.tool });
      }
    }
  }
  const stepCount = steps.length;
  const codeSteps = codeStepIds.length;
  const llmSteps = llmStepIds.length;
  const mode: WorkflowExecutionMode =
    stepCount === 0 ? 'empty'
    : llmSteps === 0 ? 'agentless'
    : codeSteps === 0 ? 'agent'
    : 'hybrid';
  return {
    mode,
    stepCount,
    codeSteps,
    llmSteps,
    codeStepIds,
    llmStepIds,
    codeRatio: stepCount > 0 ? codeSteps / stepCount : 0,
    codifyCandidates,
    label: executionModeLabel(mode),
    summary: executionModeSummary(mode, codeSteps, llmSteps, codifyCandidates.length),
  };
}

export function executionModeLabel(mode: WorkflowExecutionMode): string {
  switch (mode) {
    case 'agentless': return 'AGENTLESS';
    case 'hybrid': return 'HYBRID';
    case 'agent': return 'AGENT';
    case 'empty': return 'EMPTY';
  }
}

function executionModeSummary(mode: WorkflowExecutionMode, code: number, llm: number, candidates: number): string {
  switch (mode) {
    case 'agentless':
      return `Runs as pure code — ${code} step${code === 1 ? '' : 's'}, no agent, no tokens per run. Reasoning was paid once at authoring.`;
    case 'hybrid': {
      const path = candidates > 0 ? ` ${candidates} of the LLM step${candidates === 1 ? '' : 's'} could be codified toward agentless.` : '';
      return `${code} step${code === 1 ? '' : 's'} run as code (free); ${llm} use an LLM for judgment.${path}`;
    }
    case 'agent': {
      const path = candidates > 0 ? ` ${candidates} step${candidates === 1 ? '' : 's'} look mechanical and could become code.` : '';
      return `${llm} LLM step${llm === 1 ? '' : 's'} — reasoning is re-paid every run.${path}`;
    }
    case 'empty':
      return 'No steps yet.';
  }
}
