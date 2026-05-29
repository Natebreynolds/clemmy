import { Runner } from '@openai/agents';
import { surfacePlan } from '../../agents/plan-proposals.js';
import { buildPlannerAgent, PlanSchema, type Plan } from '../../agents/planner.js';
import { captureInteractionSignals } from '../../memory/auto-capture.js';
import { appendEvent } from './eventlog.js';

export interface PlanFirstInput {
  input: string;
  freshSession: boolean;
}

export interface PlanFirstRunInput extends PlanFirstInput {
  sessionId: string;
  channel?: string;
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
const READ_RE = /\b(?:find|pull|query|search|scrape|crawl|research|audit|summarize|analyze|gather)\b/i;
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

function domainCount(input: string): number {
  return DOMAIN_PATTERNS.reduce((count, pattern) => count + (pattern.test(input) ? 1 : 0), 0);
}

export function shouldUsePlanFirst(input: PlanFirstInput): boolean {
  if (planFirstDisabled()) return false;

  const text = input.input.trim();
  if (text.length < 80) return false;
  if (CONTROL_RE.test(text)) return false;
  if (EXECUTION_CONTINUATION_RE.test(text) && text.length < 240) return false;

  const domains = domainCount(text);
  const hasRead = READ_RE.test(text);
  const hasWrite = WRITE_RE.test(text);
  const hasBatch = BATCH_RE.test(text);
  const hasSequence = SEQUENCE_RE.test(text);

  if (input.freshSession) {
    if (domains >= 3 && (hasRead || hasWrite)) return true;
    if (domains >= 2 && hasRead && hasWrite) return true;
    if (domains >= 2 && hasBatch && hasSequence) return true;
    if (text.length >= 350 && hasRead && hasWrite && (hasBatch || hasSequence)) return true;
    return false;
  }

  // Existing sessions should not get replanned for ordinary
  // continuations, but a user can pivot into a brand-new complex
  // objective inside the same chat. Catch those pivots so Clem surfaces
  // a quick plan before opening many external tools.
  if (domains >= 3 && hasRead && hasWrite) return true;
  if (domains >= 2 && hasRead && hasWrite && (hasBatch || hasSequence)) return true;
  if (text.length >= 450 && domains >= 1 && hasRead && hasWrite && (hasBatch || hasSequence)) return true;

  return false;
}

function buildPlannerPrompt(input: string): string {
  return [
    'Draft a preflight plan for this fresh Clementine request before any external writes or long-running execution begins.',
    'Do not execute the work. Do not call mutating tools. Produce an inspectable plan the user can approve.',
    'Name the likely tool families or systems in the step text when they are obvious from the request.',
    '',
    `User request:\n${input}`,
  ].join('\n\n');
}

function renderPlanReply(plan: Plan, proposalId: string): string {
  const steps = plan.steps
    .slice(0, 6)
    .map((step) => `${step.n}. ${step.action}`)
    .join('\n');
  const more = plan.steps.length > 6 ? `\n...and ${plan.steps.length - 6} more step${plan.steps.length - 6 === 1 ? '' : 's'}.` : '';
  const questions = plan.needsUserInput.length > 0
    ? `\n\nBefore I start, I need:\n${plan.needsUserInput.map((q) => `- ${q}`).join('\n')}`
    : '';
  return [
    'I drafted the plan before starting the tool work.',
    '',
    `Objective: ${plan.objective}`,
    '',
    `Plan:\n${steps}${more}`,
    questions,
    '',
    `Review and approve plan ${proposalId} when you want me to proceed.`,
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
  if (!shouldUsePlanFirst(input)) return { surfaced: false };

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
    const result = await runner.run(buildPlannerAgent(), buildPlannerPrompt(input.input), {
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
