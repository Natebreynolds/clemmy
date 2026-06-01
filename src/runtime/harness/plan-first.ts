import { Runner } from '@openai/agents';
import { surfacePlan, surfaceAskingPlan } from '../../agents/plan-proposals.js';
import { buildPlannerAgent, PlanSchema, type Plan } from '../../agents/planner.js';
import { captureInteractionSignals } from '../../memory/auto-capture.js';
import { recallHybrid } from '../../memory/recall.js';
import { getRuntimeEnv } from '../../config.js';
import type { AutoApproveScope } from '../../agents/proactivity-policy.js';
import { appendEvent } from './eventlog.js';

export interface PlanFirstInput {
  input: string;
  freshSession: boolean;
  /**
   * Autonomy dial from the proactivity policy. Kept for caller parity;
   * plan-first no longer uses it to route ordinary ambiguity. Clarify /
   * plan / act belongs to the main orchestrator loop.
   */
  autonomy?: AutoApproveScope;
}

export interface PlanFirstRunInput extends PlanFirstInput {
  sessionId: string;
  channel?: string;
  /**
   * Force the planner path even if the normal first-turn heuristic would
   * skip it. Used when resuming a saved asking-plan: the existence of the
   * saved plan is the routing signal, not the wording of the user's short
   * answer.
   */
  force?: boolean;
  /**
   * Answers the user already supplied to a prior plan's open questions.
   * When present (plan-continuity re-entry), the planner is told to fold
   * these in and produce a now-COMPLETE plan with needsUserInput empty,
   * rather than re-asking. Flag-gated upstream (CLEMMY_PLAN_CONTINUITY).
   */
  priorAnswers?: string;
}

export interface PlanFirstResult {
  surfaced: boolean;
  proposalId?: string;
  error?: string;
}

const CONTROL_RE = /^(?:\/)?(?:continue|cancel|new|sessions?|approve|approved|reject|rejected)\b/i;
const EXECUTION_CONTINUATION_RE =
  /\b(?:go ahead|proceed|do it|send those|create those|make those|yes|approved?|continue)\b/i;
const SEQUENCE_RE = /\b(?:then|after that|afterward|for each|each one|before .* then|once .* then|first .* then)\b/i;
const BATCH_RE = /\b(?:\d+|top\s+\d+|several|many|multiple|batch|bulk|list of|all of them)\b/i;
const WRITE_RE =
  /\b(?:create|draft|send|write|update|append|post|publish|host|deploy|file|sheet|email|proposal|report)\b/i;

const DOMAIN_PATTERNS: RegExp[] = [
  /\bsalesforce|sf cli|soql|accounts?|leads?|contacts?|opportunit(?:y|ies)\b/i,
  /\bseo|ranking|rankings|serp|keyword|keywords|backlink|organic traffic|search visibility|dataforseo\b/i,
  /\boutlook|email|emails|drafts?|calendar|meeting invite\b/i,
  /\bgoogle sheets?|googlesheets?|spreadsheet|sheet row|worksheet\b/i,
  /\bwebsite|web page|webpage|scrape|crawl|browser|article|web search|look up online\b/i,
  /\blocal file|markdown|report|proposal|docx?|deck|pdf|workspace\b/i,
  /\bgithub|repo|repository|branch|commit|pull request|pr\b/i,
  /\bnetlify|vercel|railway|deploy|host\b/i,
];

function planFirstDisabled(): boolean {
  const raw = process.env.CLEMMY_PLAN_FIRST;
  return typeof raw === 'string' && /^(0|false|off|no)$/i.test(raw.trim());
}

/**
 * Flag gate for plan-continuity (persist the asking plan + fold in answers
 * on the next message). Default on because it only activates after the
 * planner has already asked a concrete question; set
 * CLEMMY_PLAN_CONTINUITY=off to return to legacy fire-and-forget asks.
 */
function planContinuityEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_PLAN_CONTINUITY', 'on') ?? 'on').toLowerCase() !== 'off';
}

function domainCount(input: string): number {
  return DOMAIN_PATTERNS.reduce((count, pattern) => count + (pattern.test(input) ? 1 : 0), 0);
}

const DATA_FETCH_VERB_RE = /\b(?:get|pull|list|grab|fetch|compile|put together)\b/i;
const DATA_NOUN_RE =
  /\b(?:deals?|accounts?|leads?|contacts?|opportunit(?:y|ies)|emails?|customers?|prospects?|rows?|records?|report|list|sheet|data)\b/i;
const VAGUE_RECENCY_RE = /\b(?:recent|recently|lately|some|a few|the latest|current)\b/i;
const CONCRETE_SCOPE_RE =
  /(?:\d|\blast\s+\w+\b|\bmy\b|\bour\b|\bowner\b|"[^"]+"|'[^']+'|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\b|\b(?:january|february|march|april|june|july|august|september|october|november|december)\b|\b(?:today|yesterday|week|month|quarter|year)\b)/i;
const DEST_IMPLIED_RE =
  /\b(?:somewhere|put it|place to look|where i can|save|store)\b/i;
const CONCRETE_DEST_RE =
  /\b(?:sheet|spreadsheet|docs?|document|email|file|notion|slack|message)\b/i;
const QUESTION_LEAD_RE = /^(?:what|when|where|who|why|how)\b/i;

/**
 * Conservative ambiguity detector for the conversation side. Returns which
 * required slots (source / scope / destination) a request leaves unfilled.
 * MUST NOT fire on simple clear asks ("what's on my calendar today") or
 * pure questions — those should execute or answer directly.
 */
export function detectAmbiguousAction(
  input: string,
): { ambiguous: boolean; missing: Array<'source' | 'scope' | 'destination'> } {
  const text = (input ?? '').trim();
  const lower = text.toLowerCase();

  // Pure questions never count as ambiguous actions.
  if (QUESTION_LEAD_RE.test(text) && text.endsWith('?')) {
    return { ambiguous: false, missing: [] };
  }

  // Must look like an ACTION on data / a deliverable.
  const isWrite = WRITE_RE.test(text);
  const isDataFetch = DATA_FETCH_VERB_RE.test(text) && DATA_NOUN_RE.test(text);
  if (!isWrite && !isDataFetch) {
    return { ambiguous: false, missing: [] };
  }

  const missing: Array<'source' | 'scope' | 'destination'> = [];

  // source: no system/tool family named yet it's asking for data.
  const asksForData = DATA_NOUN_RE.test(text);
  if (domainCount(lower) === 0 && asksForData) {
    missing.push('source');
  }

  // scope: vague recency/quantity word with no concrete window/filter.
  if (VAGUE_RECENCY_RE.test(text) && !CONCRETE_SCOPE_RE.test(text)) {
    missing.push('scope');
  }

  // destination: implies an output but names no concrete target.
  if (DEST_IMPLIED_RE.test(text) && !CONCRETE_DEST_RE.test(text)) {
    missing.push('destination');
  }

  return { ambiguous: missing.length >= 1, missing };
}

const EXPLICIT_PLAN_FIRST_RE =
  /\b(?:plan\s+first|draft\s+(?:me\s+)?a\s+plan|create\s+(?:me\s+)?a\s+plan|make\s+(?:me\s+)?a\s+plan|show\s+me\s+(?:the\s+)?plan|before\s+you\s+start[, ]+(?:plan|outline)|approve\s+(?:the\s+)?plan)\b/i;
const EXTERNAL_MUTATION_RE =
  /\b(?:send|post|publish|deploy|host|update|append|create|draft|write|delete|remove)\b[\s\S]{0,90}\b(?:outlook|email|emails|salesforce|crm|airtable|google\s+sheets?|googlesheets?|spreadsheet|slack|github|pull\s+request|netlify|vercel|railway)\b|\b(?:outlook|email|emails|salesforce|crm|airtable|google\s+sheets?|googlesheets?|spreadsheet|slack|github|pull\s+request|netlify|vercel|railway)\b[\s\S]{0,90}\b(?:send|post|publish|deploy|host|update|append|create|draft|write|delete|remove)\b/i;

export function shouldUsePlanFirst(input: PlanFirstInput): boolean {
  if (planFirstDisabled()) return false;

  const text = input.input.trim();
  // Control words ("approve", "cancel", "continue") and bare execution
  // continuations never plan-first — these guards run FIRST, ahead of the
  // ambiguity branch and the length floor, so neither path can re-engage on
  // a control reply. (Reordered ahead of the length floor 2026-05-30;
  // result-identical to the legacy order for flag-off — all three are
  // early-return-false guards, so their order doesn't change the outcome.)
  if (CONTROL_RE.test(text)) return false;
  if (EXECUTION_CONTINUATION_RE.test(text) && text.length < 240) return false;

  // The separate preflight planner engages ONLY when the user EXPLICITLY
  // asks for a plan ("plan this first", "draft me a plan"). Everything
  // else — including batch/external/multi-step action requests — stays
  // with the main conversational orchestrator, which reads the
  // conversation + memory + tools, asks as many clarifying questions as
  // it needs (converse until aligned), plans the work itself, and fires
  // execution once the user agrees, gating only irreversible writes.
  //
  // 2026-06-01 (feedback_converse_until_aligned): the prior heuristics
  // (length floor + external-mutation/batch/sequence/domain count)
  // auto-tripped a formal APPROVE/REJECT plan card on ordinary requests
  // ("create 10 Outlook drafts"), short-circuiting the conversation the
  // user wants. The planner-first preflight was restricting the model;
  // it is now opt-in via an explicit request only.
  if (EXPLICIT_PLAN_FIRST_RE.test(text)) return true;

  return false;
}

export function buildPlannerPrompt(input: string, priorAnswers?: string, memoryContext?: string): string {
  const lines = [
    'Draft a preflight plan for this fresh Clementine request before any external writes or long-running execution begins.',
    'Do not execute the work. Do not call mutating tools. Produce an inspectable plan the user can approve.',
    'If required information is missing, put the shortest possible question in needsUserInput. A plan with needsUserInput is NOT approvable yet.',
    "If the 'What Clementine already knows' block answers a detail, treat it as known and put it in the plan — only list a question in needsUserInput when memory and the request genuinely do not provide it.",
    'Name the likely tool families or systems in the step text when they are obvious from the request.',
  ];
  if (priorAnswers && priorAnswers.trim().length > 0) {
    lines.push(
      `The user has answered the open questions: ${priorAnswers.trim()}. Produce a now-COMPLETE plan with needsUserInput EMPTY; apply safe defaults (e.g. create a NEW Google Sheet unless told to update an existing one) rather than re-asking.`,
    );
  }
  lines.push('', `User request:\n${input}`);
  if (memoryContext && memoryContext.trim().length > 0) {
    lines.push('', memoryContext.trim());
  }
  return lines.join('\n\n');
}

const EXTERNAL_WRITE_RE =
  /\b(?:send|sent|post|publish|deploy|host|netlify|vercel|railway|notify(?:\s+externally|\s+prospects?)?|salesforce|crm|airtable|google\s+sheets?|googlesheets?|spreadsheet|outlook|email|emails|draft\s+emails?|create\s+drafts?|slack|github|pull\s+request|commit|delete|remove|mutate\s+external)\b/i;
const LOCAL_ONLY_SAFE_RE =
  /\b(?:local(?:ly)?|markdown|file|report|brief)\b[\s\S]{0,140}\b(?:only|review|reviewable|save|saved|no\s+external|do\s+not\s+send|stop\s+before|without\s+sending)\b/i;
const EXTERNAL_WRITE_NEGATED_RE =
  /\b(?:no\s+external|do\s+not\s+(?:send|post|publish|deploy|host|notify|update|mutate)|stop\s+before\s+(?:any\s+)?external|without\s+(?:sending|posting|publishing|deploying|updating|notifying))\b/i;

function compact(value: string, max = 220): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

function planText(plan: Plan, input: string): string {
  return [
    input,
    plan.objective,
    ...plan.steps.map((step) => step.action),
    ...(plan.successCriteria ?? []),
    ...(plan.risks ?? []),
  ].join('\n');
}

export function planRequiresUserApproval(plan: Plan, input: string): boolean {
  const text = planText(plan, input);
  if (plan.estimatedComplexity === 'significant' || plan.estimatedComplexity === 'large') return true;
  if (plan.recommendsTrackedExecution) return true;
  if (LOCAL_ONLY_SAFE_RE.test(text) && EXTERNAL_WRITE_NEGATED_RE.test(text)) return false;
  if (LOCAL_ONLY_SAFE_RE.test(text) && !EXTERNAL_WRITE_RE.test(text)) return false;
  return EXTERNAL_WRITE_RE.test(text);
}

function planHighlights(plan: Plan): string[] {
  const actions = plan.steps
    .map((step) => compact(step.action, 120))
    .filter(Boolean);
  if (actions.length <= 2) return actions;
  return [
    actions[0],
    actions[actions.length - 1],
  ];
}

export function renderPlanReply(plan: Plan, proposalId: string): string {
  const highlights = planHighlights(plan);
  const highlightBlock = highlights.length > 0
    ? `\n\nWhat I’ll do:\n${highlights.map((item) => `- ${item}`).join('\n')}`
    : '';
  return [
    `I can do that. I’ll ${compact(plan.objective, 180)}`,
    highlightBlock,
    '',
    `Approve this plan when you want me to start. (${proposalId})`,
  ].filter(Boolean).join('\n');
}

export function renderPlanNeedsInputReply(plan: Plan): string {
  const questions = plan.needsUserInput
    .slice(0, 2)
    .map((q) => `- ${compact(q, 180)}`)
    .join('\n');
  const firstAction = plan.steps[0]?.action
    ? compact(plan.steps[0].action, 140).replace(/\.$/, '')
    : '';
  const context = firstAction
    ? `I’ll use ${firstAction.charAt(0).toLowerCase()}${firstAction.slice(1)} once that’s clear.`
    : '';
  return [
    `I can help with that. Before I start, I need one detail:`,
    questions,
    context,
  ].filter(Boolean).join('\n');
}

export function renderPlanFirstFailureReply(): string {
  return [
    'I tried to draft a plan before starting, but the planner did not finish cleanly.',
    '',
    'I did not start the tool work. Reply with one of these:',
    '- `retry plan` to try the planning step again',
    '- `simplify` to ask me for the smallest missing details first',
    '- `proceed` to continue with normal tool execution and the usual approval gates',
  ].join('\n');
}

function surfacePlanFirstFailure(input: PlanFirstRunInput, error: string): PlanFirstResult {
  appendEvent({
    sessionId: input.sessionId,
    turn: 0,
    role: 'Clem',
    type: 'conversation_completed',
    data: {
      reason: 'plan_first_failed',
      summary: 'Planner did not finish; tool work was not started.',
      reply: renderPlanFirstFailureReply(),
      plannerError: error,
    },
  });

  return { surfaced: true, error };
}

export async function runPlanFirstPreflight(input: PlanFirstRunInput): Promise<PlanFirstResult> {
  if (!input.force && !shouldUsePlanFirst(input)) return { surfaced: false };

  appendEvent({
    sessionId: input.sessionId,
    turn: 0,
    role: 'system',
    type: 'turn_started',
    data: { input: input.input.slice(0, 200), mode: 'plan_first' },
  });
  appendEvent({
    sessionId: input.sessionId,
    turn: 0,
    role: 'user',
    type: 'user_input_received',
    data: { text: input.input },
  });

  try {
    const captured = captureInteractionSignals({
      message: input.input,
      sessionId: input.sessionId,
    });
    if (captured.candidates.length > 0 || captured.profilePatch) {
      appendEvent({
        sessionId: input.sessionId,
        turn: 0,
        role: 'system',
        type: 'memory_signals_captured',
        data: {
          factCount: captured.candidates.length,
          profilePatch: captured.profilePatch ?? null,
          reasons: captured.candidates.map((c) => c.reason),
        },
      });
    }
  } catch {
    // Planning must never fail because opportunistic memory capture failed.
  }

  // Memory-IN: prime the planner with what Clementine already knows BEFORE
  // it drafts the plan, so it FILLS slots from memory instead of re-asking
  // the user details memory already holds. Mirrors the main loop's
  // buildTurnMemoryPrimer; recall must NEVER block planning.
  let memoryContext = '';
  let memoryHitCount = 0;
  try {
    const hits = await recallHybrid(input.input, { limit: 6 });
    memoryHitCount = hits.length;
    const lines = hits
      .filter((h) => (h.score ?? 0) > 0)
      .map((h) => `- ${h.title ?? 'note'}: ${h.snippet}`.slice(0, 300));
    if (lines.length) {
      memoryContext = `What Clementine already knows (from memory — use this to FILL slots; do NOT ask the user for anything answered here):\n${lines.join('\n')}`;
    }
  } catch {
    // Recall must never block planning — fall through to no memoryContext.
  }
  try {
    appendEvent({
      sessionId: input.sessionId,
      turn: 0,
      role: 'system',
      type: 'turn_memory_primer',
      data: {
        enabled: true,
        queryPreview: input.input.slice(0, 160),
        hitCount: memoryHitCount,
        injected: Boolean(memoryContext),
        source: 'plan_first',
      },
    });
  } catch {
    // Event emission must never block planning.
  }

  try {
    appendEvent({
      sessionId: input.sessionId,
      turn: 0,
      role: 'system',
      type: 'plan_first_started',
      data: { reason: 'fresh_complex_request' },
    });
    const runner = new Runner({
      workflowName: 'clementine-plan-first',
      groupId: input.sessionId,
    });
    const result = await runner.run(buildPlannerAgent(), buildPlannerPrompt(input.input, input.priorAnswers, memoryContext), {
      context: { sessionId: input.sessionId, turn: 0 },
      maxTurns: 8,
      toolExecution: { maxFunctionToolConcurrency: 4 },
    });
    const parsed = PlanSchema.safeParse(result.finalOutput);
    if (!parsed.success) {
      const message = parsed.error.message;
      appendEvent({
        sessionId: input.sessionId,
        turn: 0,
        role: 'system',
        type: 'plan_first_failed',
        data: { error: message, stage: 'schema_parse' },
      });
      return surfacePlanFirstFailure(input, message);
    }

    const plan = parsed.data;
    appendEvent({
      sessionId: input.sessionId,
      turn: 0,
      role: 'system',
      type: 'plan_drafted',
      data: {
        objective: plan.objective,
        estimatedComplexity: plan.estimatedComplexity,
        stepCount: plan.steps.length,
        needsUserInput: plan.needsUserInput,
      },
    });

    if (plan.needsUserInput.length > 0) {
      // Plan-continuity (flag-gated): persist the ASKING plan so the user's
      // next message can be classified against it and folded back in, even
      // across session rollover. Flag off → no proposal persisted (legacy).
      let askingProposalId: string | undefined;
      if (planContinuityEnabled()) {
        try {
          const askingProposal = surfaceAskingPlan({
            plan,
            originatingRequest: input.input,
            sessionId: input.sessionId,
            channel: input.channel,
            context: 'Plan awaiting your answers before execution.',
          });
          askingProposalId = askingProposal?.id;
        } catch {
          // Persisting the asking plan must never break the ask itself.
        }
      }
      appendEvent({
        sessionId: input.sessionId,
        turn: 0,
        role: 'Clem',
        type: 'awaiting_user_input',
        data: {
          reason: 'plan_first_needs_input',
          question: renderPlanNeedsInputReply(plan),
          needsUserInput: plan.needsUserInput,
          ...(askingProposalId ? { planProposalId: askingProposalId } : {}),
        },
      });
      return { surfaced: true, ...(askingProposalId ? { proposalId: askingProposalId } : {}) };
    }

    if (!planRequiresUserApproval(parsed.data, input.input)) {
      appendEvent({
        sessionId: input.sessionId,
        turn: 0,
        role: 'system',
        type: 'conversation_step',
        data: {
          decision: {
            summary: `Prepared a safe local plan and continued without an approval gate: ${parsed.data.objective}`,
            reply: null,
            done: false,
            nextAction: 'continue_to_execution',
            reason: 'plan_first_safe_local',
          },
        },
      });
      return { surfaced: false };
    }

    const proposal = surfacePlan({
      plan: parsed.data,
      originatingRequest: input.input,
      sessionId: input.sessionId,
      channel: input.channel,
      context: 'Planner-first preflight: review the intended workflow before Clementine opens the full tool surface.',
    });

    appendEvent({
      sessionId: input.sessionId,
      turn: 0,
      role: 'Clem',
      type: 'conversation_completed',
      data: {
        reason: 'plan_first',
        summary: `Plan ready for approval: ${parsed.data.objective}`,
        reply: renderPlanReply(parsed.data, proposal.id),
        planProposalId: proposal.id,
      },
    });
    return { surfaced: true, proposalId: proposal.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendEvent({
      sessionId: input.sessionId,
      turn: 0,
      role: 'system',
      type: 'plan_first_failed',
      data: { error: message },
    });
    return surfacePlanFirstFailure(input, message);
  }
}
