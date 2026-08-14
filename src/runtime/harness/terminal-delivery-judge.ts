/**
 * Independent terminal-delivery judge.
 *
 * This module only decides the next verb at a terminal verification gap. It
 * does not commit a terminal, resume a brain, or manufacture fallback prose.
 * Callers retain today's safe behavior whenever the judge is unavailable.
 *
 * The production route is deliberately stricter than the older boundary
 * judges: a different model family is mandatory. The ordered boundary chain
 * may begin with its historical same-family fallback, so this evaluator selects
 * the first model-bearing independent member and never silently self-grades.
 */
import type { Model } from '@openai/agents-core';
import type { AcceptedSourceSettlementAudit } from './accepted-source-settlement-audit.js';
import type { BoundaryJudgeRouting } from './debate-model.js';
import { extractJsonCandidate } from './json-repair.js';

export type TerminalDeliveryJudgeVerb = 'resume' | 'ask' | 'deliver';

export interface TerminalDeliveryRecoveryCapability {
  /** The caller still owns a live continuation edge after this verdict. */
  liveContinuation: boolean;
  /** That continuation can invoke the task's available tools. */
  toolsAvailable: boolean;
  /** It can attempt a read-only inspection of the relevant external state. */
  externalStateInspection: boolean;
}

export interface TerminalDeliveryJudgeInput {
  /** The exact accepted task, composed by the caller. */
  objective: string;
  /** The model-authored terminal account that triggered delivery review. */
  authoredText: string;
  /** The concrete verification/preparation gap observed by the harness. */
  deliveryConcern: {
    reason: string;
    missing?: readonly string[];
  };
  /** Read-only durable settlement truth for the exact accepted source. */
  settlementAudit: AcceptedSourceSettlementAudit;
  /** Consecutive RESUME verdicts already honored for this terminal gap. */
  priorConsecutiveResumes: 0 | 1;
  /** What the caller can actually do if the judge selects RESUME. The judge
   * itself remains tool-less; these facts describe the running agent. */
  recoveryCapability: TerminalDeliveryRecoveryCapability;
}

interface ParsedTerminalDeliveryJudgeBase {
  reason: string;
}

export type ParsedTerminalDeliveryJudgeVerdict =
  | (ParsedTerminalDeliveryJudgeBase & {
    verb: 'resume';
    recoveryInstruction: string;
    askIfRepeated: string;
  })
  | (ParsedTerminalDeliveryJudgeBase & {
    verb: 'ask' | 'deliver';
    publicText: string;
  });

export interface TerminalDeliveryJudgeIdentity {
  modelId: string;
  judgeFamily: BoundaryJudgeRouting['judgeFamily'];
  brainFamily: BoundaryJudgeRouting['brainFamily'];
}

export type TerminalDeliveryJudgeDecision =
  | {
    status: 'decided';
    verb: 'resume';
    reason: string;
    recoveryInstruction: string;
    /** Judge-authored public question to use if the same recovery misses once. */
    askIfRepeated: string;
    consecutiveResumeCount: 1;
    judge: TerminalDeliveryJudgeIdentity;
  }
  | {
    status: 'decided';
    verb: 'ask';
    reason: string;
    publicText: string;
    consecutiveResumeCount: 0;
    escalatedFromResume?: true;
    judge: TerminalDeliveryJudgeIdentity;
  }
  | {
    status: 'decided';
    verb: 'deliver';
    reason: string;
    publicText: string;
    consecutiveResumeCount: 0;
    judge: TerminalDeliveryJudgeIdentity;
  };

export type TerminalDeliveryJudgeUnavailableCause =
  | 'no_route'
  | 'no_model'
  | 'self_judge'
  | 'same_family'
  | 'timeout'
  | 'judge_error'
  | 'invalid_verdict'
  | 'resume_unavailable'
  | 'irreversible_floor_conflict';

/** Intentionally has no public/recovery text. An unavailable judge cannot add
 * new words to the user's terminal; callers keep their existing safe fallback. */
export interface TerminalDeliveryJudgeUnavailable {
  status: 'unavailable';
  cause: TerminalDeliveryJudgeUnavailableCause;
  judge?: TerminalDeliveryJudgeIdentity;
}

export type TerminalDeliveryJudgeResult =
  | TerminalDeliveryJudgeDecision
  | TerminalDeliveryJudgeUnavailable;

export interface TerminalDeliveryJudgeRequest {
  route: BoundaryJudgeRouting;
  instructions: string;
  prompt: string;
  tools: readonly [];
  maxTurns: 1;
}

/** Split route selection from execution so family independence is checked
 * before any injected or production model call. */
export interface TerminalDeliveryJudgePort {
  resolveRoute(): Promise<BoundaryJudgeRouting | null>;
  run(request: TerminalDeliveryJudgeRequest): Promise<unknown>;
}

const RAW_OUTPUT_MAX_CHARS = 12_000;
const REASON_MAX_CHARS = 600;
const RECOVERY_MAX_CHARS = 1_200;
const PUBLIC_TEXT_MAX_CHARS = 4_000;
const OBJECTIVE_MAX_CHARS = 4_000;
const AUTHORED_TEXT_MAX_CHARS = 6_000;
const CONCERN_MAX_CHARS = 1_200;
const MISSING_ITEM_MAX_CHARS = 300;
const MAX_MISSING_ITEMS = 12;

function boundedText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n/g, '\n').trim();
  return text && text.length <= maxChars ? text : null;
}

function specificRecoveryInstruction(value: unknown): string | null {
  const text = boundedText(value, RECOVERY_MAX_CHARS);
  if (!text || text.split(/\s+/).length < 5) return null;
  return text;
}

function parseObject(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string' || raw.length > RAW_OUTPUT_MAX_CHARS) return null;
  const candidate = extractJsonCandidate(raw);
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** One bounded parse attempt. There is no repair re-prompt or second model
 * call: off-contract output becomes typed unavailability. */
export function parseTerminalDeliveryJudgeVerdict(
  raw: unknown,
): ParsedTerminalDeliveryJudgeVerdict | null {
  const value = parseObject(raw);
  if (!value) return null;
  const verbValue = boundedText(value.verb, 20)?.toLowerCase();
  const reason = boundedText(value.reason, REASON_MAX_CHARS);
  if (!reason || (verbValue !== 'resume' && verbValue !== 'ask' && verbValue !== 'deliver')) {
    return null;
  }
  if (verbValue === 'resume') {
    const recoveryInstruction = specificRecoveryInstruction(value.recoveryInstruction);
    const askIfRepeated = boundedText(value.askIfRepeated, PUBLIC_TEXT_MAX_CHARS);
    if (!recoveryInstruction || !askIfRepeated) return null;
    return { verb: 'resume', reason, recoveryInstruction, askIfRepeated };
  }
  const publicText = boundedText(value.publicText, PUBLIC_TEXT_MAX_CHARS);
  if (!publicText) return null;
  return { verb: verbValue, reason, publicText };
}

function clip(value: string, maxChars: number): string {
  const text = value.replace(/\r\n/g, '\n').trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[bounded for judging]`;
}

function auditFactsForPrompt(audit: AcceptedSourceSettlementAudit): string {
  const facts = audit.facts;
  return JSON.stringify({
    openLogicalCalls: facts.openLogicalCalls,
    conflictingLogicalCalls: facts.conflictingLogicalCalls,
    startedDispatches: facts.startedDispatches,
    businessSettlements: facts.businessSettlements,
    successfulBusinessSettlements: facts.successfulBusinessSettlements,
    successfulSdkBusinessResults: facts.successfulSdkBusinessResults,
    successfulSdkAuthoringResults: facts.successfulSdkAuthoringResults,
    unrecoveredBusinessFailures: facts.unrecoveredBusinessFailures,
    confirmedWrites: facts.confirmedWrites,
    uncertainWrites: facts.uncertainWrites,
    blockingUncertainWrites: facts.blockingUncertainWrites,
  });
}

export const TERMINAL_DELIVERY_JUDGE_SYSTEM_PROMPT = [
  'You are an independent terminal-delivery judge. You have no tools, but the running agent may still have a live tool-capable continuation. Use the RECOVERY CAPABILITY facts below and choose exactly one next verb: RESUME, ASK, or DELIVER.',
  '',
  'RESUME only when one specific gap can be repaired now by the running agent without new user information or authorization. Supply a concrete recoveryInstruction for the agent and a complete, user-facing askIfRepeated that should be shown if this recovery misses once.',
  'ASK when progress cannot safely continue without the user or a human inspection. publicText must directly ask for the exact information, authorization, or inspection needed.',
  'DELIVER when the work is finished enough to show now. publicText must be a truthful stand-alone account of the result and any uncertainty the user should know.',
  '',
  'Never invent work, evidence, links, receipts, or user authority. Preserve concrete useful results from the authored terminal text. Public text must not mention this judge, an internal gate, a parser, or hidden audit mechanics.',
  'If IRREVERSIBLE UNCERTAINTY is marked YES, ASK is the only valid verb: the user or a human must inspect the external state. Never RESUME or DELIVER that ambiguity.',
  'Otherwise, when live continuation, tools, and external-state inspection are all AVAILABLE, never ASK the user to inspect a provider, spreadsheet, mailbox, sent folder, calendar, or other external state that the running agent can inspect itself. Choose RESUME and give one specific read-only recovery instruction that checks the exact target and binds the observed result to this accepted objective.',
  '',
  'Return exactly one JSON object and no other text, using exactly one applicable shape:',
  '{"verb":"resume","reason":"<short diagnosis>","recoveryInstruction":"<specific internal instruction>","askIfRepeated":"<complete user-facing question>"}',
  '{"verb":"ask","reason":"<short diagnosis>","publicText":"<complete user-facing question>"}',
  '{"verb":"deliver","reason":"<short diagnosis>","publicText":"<complete truthful user-facing answer>"}',
].join('\n');

/** Pure, clipped evidence packet. It carries the prior strike for context, but
 * the evaluator—not the model—enforces the two-strike transition. */
export function buildTerminalDeliveryJudgePrompt(input: TerminalDeliveryJudgeInput): string {
  const missing = (input.deliveryConcern.missing ?? [])
    .slice(0, MAX_MISSING_ITEMS)
    .map((item) => `- ${clip(String(item), MISSING_ITEM_MAX_CHARS)}`);
  const irreversibleFloor = input.settlementAudit.status === 'uncertain_write';
  return [
    '=== ACCEPTED OBJECTIVE ===',
    clip(input.objective, OBJECTIVE_MAX_CHARS) || '(empty)',
    '',
    '=== MODEL-AUTHORED TERMINAL ACCOUNT ===',
    clip(input.authoredText, AUTHORED_TEXT_MAX_CHARS) || '(empty)',
    '',
    '=== DELIVERY CONCERN ===',
    clip(input.deliveryConcern.reason, CONCERN_MAX_CHARS) || '(none supplied)',
    ...(missing.length > 0 ? ['Missing evidence:', ...missing] : []),
    '',
    '=== SETTLEMENT AUDIT (durable host evidence) ===',
    `status: ${input.settlementAudit.status}`,
    `reason: ${clip(input.settlementAudit.reason, CONCERN_MAX_CHARS)}`,
    `facts: ${auditFactsForPrompt(input.settlementAudit)}`,
    `IRREVERSIBLE UNCERTAINTY: ${irreversibleFloor ? 'YES — ASK is mandatory' : 'NO'}`,
    '',
    '=== RECOVERY CAPABILITY (running agent, not this judge) ===',
    `Live continuation: ${input.recoveryCapability.liveContinuation ? 'AVAILABLE' : 'UNAVAILABLE'}`,
    `Tools during continuation: ${input.recoveryCapability.toolsAvailable ? 'AVAILABLE' : 'UNAVAILABLE'}`,
    `Read-only external-state inspection: ${input.recoveryCapability.externalStateInspection ? 'AVAILABLE' : 'UNAVAILABLE'}`,
    '',
    `Consecutive RESUME verdicts already honored: ${input.priorConsecutiveResumes}`,
    'Choose the next verb and return the one JSON object.',
  ].join('\n');
}

function judgeIdentity(route: BoundaryJudgeRouting): TerminalDeliveryJudgeIdentity {
  return {
    modelId: route.modelId,
    judgeFamily: route.judgeFamily,
    brainFamily: route.brainFamily,
  };
}

const productionTerminalDeliveryJudgePort: TerminalDeliveryJudgePort = {
  resolveRoute: resolveProductionTerminalDeliveryJudgeRoute,
  async run(request) {
    const { Agent, Runner } = await import('@openai/agents');
    const agent = new Agent({
      name: 'TerminalDeliveryJudge',
      instructions: request.instructions,
      model: request.route.model as Model,
      modelSettings: { reasoning: { effort: 'low' } },
      tools: [],
    });
    const runner = new Runner({ workflowName: 'clementine-terminal-delivery-judge' });
    const result = await runner.run(agent, request.prompt, { maxTurns: request.maxTurns });
    return (result as { finalOutput?: unknown }).finalOutput;
  },
};

/** Narrow production-routing seam: exported so connection topology can be
 * pinned without making a live judge call. */
export async function resolveProductionTerminalDeliveryJudgeRoute(): Promise<BoundaryJudgeRouting | null> {
  try {
    const { resolveBoundaryJudgeChain } = await import('./debate-model.js');
    return selectIndependentTerminalDeliveryJudgeRoute(resolveBoundaryJudgeChain());
  } catch {
    return null;
  }
}

/** Select one model-bearing judge that is genuinely independent of the active
 * brain. Selection never executes or retries a route. */
export function selectIndependentTerminalDeliveryJudgeRoute(
  routes: readonly BoundaryJudgeRouting[],
): BoundaryJudgeRouting | null {
  for (const route of routes) {
    if (route.model && !route.selfJudge && route.judgeFamily !== route.brainFamily) {
      return route;
    }
  }
  return null;
}

export interface EvaluateTerminalDeliveryOptions {
  port?: TerminalDeliveryJudgePort;
  /** Deterministic test override; production uses the shared boundary timeout. */
  timeoutMs?: number;
}

function unavailable(
  cause: TerminalDeliveryJudgeUnavailableCause,
  route?: BoundaryJudgeRouting,
): TerminalDeliveryJudgeUnavailable {
  return {
    status: 'unavailable',
    cause,
    ...(route ? { judge: judgeIdentity(route) } : {}),
  };
}

/** Evaluate exactly one independent judge verdict. No retry, hedge, schema
 * repair call, or same-family fallback is permitted. */
export async function evaluateTerminalDelivery(
  input: TerminalDeliveryJudgeInput,
  options: EvaluateTerminalDeliveryOptions = {},
): Promise<TerminalDeliveryJudgeResult> {
  const port = options.port ?? productionTerminalDeliveryJudgePort;
  let route: BoundaryJudgeRouting | null;
  try {
    route = await port.resolveRoute();
  } catch {
    return unavailable('no_route');
  }
  if (!route) return unavailable('no_route');
  if (!route.model) return unavailable('no_model', route);
  if (route.selfJudge) return unavailable('self_judge', route);
  if (route.judgeFamily === route.brainFamily) return unavailable('same_family', route);

  let timed: { output: unknown } | null;
  try {
    const { withJudgeTimeout } = await import('./judge-family.js');
    timed = await withJudgeTimeout(
      port.run({
        route,
        instructions: TERMINAL_DELIVERY_JUDGE_SYSTEM_PROMPT,
        prompt: buildTerminalDeliveryJudgePrompt(input),
        tools: [],
        maxTurns: 1,
      }).then((output) => ({ output })),
      options.timeoutMs,
    );
  } catch {
    return unavailable('judge_error', route);
  }
  if (!timed) return unavailable('timeout', route);
  const parsed = parseTerminalDeliveryJudgeVerdict(timed.output);
  if (!parsed) return unavailable('invalid_verdict', route);

  // Deterministic safety floor outranks model semantics. A wrong verb is not
  // rewritten into an ask; it is unavailable so the caller keeps today's hold.
  if (input.settlementAudit.status === 'uncertain_write' && parsed.verb !== 'ask') {
    return unavailable('irreversible_floor_conflict', route);
  }

  const judge = judgeIdentity(route);
  if (parsed.verb === 'resume') {
    // The second consecutive RESUME is no longer a control edge: it is the
    // judge-authored two-strike ASK. Convert it before checking continuation
    // capability because this branch does not run another model/tool turn.
    if (input.priorConsecutiveResumes >= 1) {
      return {
        status: 'decided',
        verb: 'ask',
        reason: parsed.reason,
        publicText: parsed.askIfRepeated,
        consecutiveResumeCount: 0,
        escalatedFromResume: true,
        judge,
      };
    }
    // A first RESUME is a real control edge, not advisory prose. Prompt
    // compliance is not authority: refuse it unless the caller still owns a
    // tool-capable, read-only continuation. In particular, a final-step
    // terminal must not `continue` out without committing a public outcome.
    if (
      !input.recoveryCapability.liveContinuation
      || !input.recoveryCapability.toolsAvailable
      || !input.recoveryCapability.externalStateInspection
    ) {
      return unavailable('resume_unavailable', route);
    }
    return {
      status: 'decided',
      verb: 'resume',
      reason: parsed.reason,
      recoveryInstruction: parsed.recoveryInstruction,
      askIfRepeated: parsed.askIfRepeated,
      consecutiveResumeCount: 1,
      judge,
    };
  }
  return {
    status: 'decided',
    verb: parsed.verb,
    reason: parsed.reason,
    publicText: parsed.publicText,
    consecutiveResumeCount: 0,
    judge,
  };
}
