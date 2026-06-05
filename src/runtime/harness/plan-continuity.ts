import { Agent, Runner } from '@openai/agents';
import { z } from 'zod';
import { MODELS } from '../../config.js';
import { listPlanProposals, setWorkflowPendingInputValues, supersedePlanProposal, type PlanProposal } from '../../agents/plan-proposals.js';
import { resumeWorkflowRun } from '../../tools/workflow-run-queue.js';
import type { AutoApproveScope } from '../../agents/proactivity-policy.js';
import type { RuntimeContextValue } from '../../types.js';
import { normalizeZodForCodexStrict } from '../schema-normalizer.js';
import { runPlanFirstPreflight } from './plan-first.js';
import { extractNamedResource } from '../../memory/focus.js';

/**
 * Deterministic self-contained-request guard (code-level, not a prompt rule).
 * The classifier biases toward "answers"; a fresh request that names its OWN
 * concrete resource (a sheet/doc id or URL) absent from the open plan must NOT
 * be swallowed as an answer to that plan, or it would run against the wrong
 * target. High precision: only fires on a concrete resource id that does not
 * appear in the plan's objective/questions — plain answers ("yes, the first
 * list") carry no resource id and stay "answers". Best-effort; never throws.
 */
export function applySelfContainedGuard(
  plan: PlanProposal,
  message: string,
  classification: PlanContinuityClassification,
): PlanContinuityClassification {
  try {
    if (classification.kind !== 'answers') return classification;
    const named = extractNamedResource(message);
    if (!named) return classification;
    const planText = [
      plan.plan?.objective ?? '',
      plan.originatingRequest ?? '',
      ...(plan.plan?.needsUserInput ?? []),
    ].join(' ');
    if (planText.includes(named)) return classification; // plan IS about this resource → genuine answer
    return {
      kind: 'new_topic',
      confidence: Math.max(classification.confidence, 0.6),
      reason: `message names its own resource not in the open plan — treating as a new request, not an answer`,
    };
  } catch {
    return classification;
  }
}

/**
 * Plan continuity (always on — the CLEMMY_PLAN_CONTINUITY rollout flag was
 * removed per feedback_no_rollout_flags; validated behavior is the default).
 *
 * When Clementine drafts a plan that ASKS the user a question, that asking
 * plan is now persisted as a pending PlanProposal (see surfaceAskingPlan).
 * On the user's NEXT message we look up the open question-plan for the
 * channel and classify the message against it: is it answering the
 * questions, pivoting to a new topic, explicitly resuming, or abandoning?
 *
 * The plan — not the session — is the unit of continuity, so this works even
 * after the session compacted or rolled over (the proposal is on disk, keyed
 * by channel).
 */

function proposalNeedsUserInput(proposal: PlanProposal): boolean {
  const plan = proposal.plan;
  return Array.isArray(plan?.needsUserInput) && plan.needsUserInput.some((q) => q.trim().length > 0);
}

/**
 * Find the most-recently-proposed pending plan on this channel that still
 * has open questions. Returns null when there is none.
 */
export function findOpenQuestionPlan(channel: string): PlanProposal | null {
  if (!channel) return null;
  // listPlanProposals already sorts newest-first by proposedAt.
  const pending = listPlanProposals({ status: 'pending', channel });
  for (const proposal of pending) {
    // workflow_pending_inputs records are routed by session (the tool that
    // creates them has no channel) — never let the channel path claim one.
    if (proposal.kind === 'workflow_pending_inputs') continue;
    if (proposalNeedsUserInput(proposal)) return proposal;
  }
  return null;
}

/**
 * Find the most-recent pending workflow_pending_inputs record for this
 * session. These are created inside the workflow_run tool (which only has a
 * sessionId, not a channel), so they are keyed and resumed by session — chat
 * sessions stay stable across turns, so the next reply finds the record.
 */
export function findOpenWorkflowPendingInputs(sessionId: string): PlanProposal | null {
  if (!sessionId) return null;
  const pending = listPlanProposals({ status: 'pending', sessionId });
  for (const proposal of pending) {
    if (proposal.kind === 'workflow_pending_inputs' && proposal.workflowName) return proposal;
  }
  return null;
}

export type PlanContinuityKind = 'answers' | 'new_topic' | 'resume' | 'abandon';

export interface PlanContinuityClassification {
  kind: PlanContinuityKind;
  answers?: string;
  confidence: number;
  reason: string;
}

const ClassificationSchema = z.object({
  kind: z.enum(['answers', 'new_topic', 'resume', 'abandon']).describe(
    'How the new message relates to the open plan that is awaiting answers.',
  ),
  answers: z.string().nullable().describe(
    'When kind is answers (or resume with answers folded in), the extracted answers to the open questions, in the user\'s own terms. Null otherwise.',
  ),
  confidence: z.number().min(0).max(1).describe('0..1 confidence in the kind label.'),
  reason: z.string().describe('One short sentence explaining the classification.'),
});

/**
 * Build the classifier prompt. Pure + exported so it can be unit-tested
 * without a live model call.
 */
export function buildClassifierPrompt(plan: PlanProposal, message: string): string {
  const objective = plan.plan?.objective ?? plan.originatingRequest;
  const questions = (plan.plan?.needsUserInput ?? [])
    .map((q, i) => `${i + 1}. ${q}`)
    .join('\n');
  return [
    'Clementine previously presented a plan and asked the user some questions before starting. The user just sent a new message. Decide how that message relates to the open plan.',
    '',
    `Open plan objective: ${objective}`,
    '',
    `Open questions the plan is waiting on:\n${questions || '(none recorded)'}`,
    '',
    `The user\'s new message:\n${message}`,
    '',
    'Choose exactly one kind:',
    '- answers: the message supplies answers to the open questions (it need not answer all of them; extract whatever it provides into the answers field, in the user\'s own words).',
    '- resume: the user is explicitly returning to / continuing this plan ("let\'s get back on the deals thing", "continue that"). If they also give answers, include them in answers.',
    '- new_topic: the message is a clearly different request, unrelated to the open questions.',
    '- abandon: the user wants to drop the plan ("never mind", "forget it", "cancel that").',
    '',
    'Bias toward "answers" whenever the message plausibly maps to the open questions. Only choose "new_topic" on a clear pivot to something unrelated.',
  ].join('\n');
}

function buildClassifierAgent(): Agent<RuntimeContextValue, typeof ClassificationSchema> {
  return new Agent<RuntimeContextValue, typeof ClassificationSchema>({
    name: 'PlanContinuityClassifier',
    instructions: [
      'You classify how a user\'s new message relates to a plan that is awaiting their answers.',
      'Return only the structured classification. Do not call tools. Do not execute anything.',
    ].join('\n\n'),
    model: MODELS.fast,
    outputType: normalizeZodForCodexStrict(ClassificationSchema) as typeof ClassificationSchema,
    tools: [],
  });
}

/**
 * Classify a new message against an open question-plan via a small model
 * call. Fails SAFE: any error returns a low-confidence `answers` so a
 * classifier failure never strands the user — the re-draft will still ask
 * if the answer was truly incomplete.
 */
export async function classifyAgainstPlan(
  plan: PlanProposal,
  message: string,
): Promise<PlanContinuityClassification> {
  try {
    const runner = new Runner({ workflowName: 'clementine-plan-continuity' });
    const result = await runner.run(buildClassifierAgent(), buildClassifierPrompt(plan, message), {
      maxTurns: 1,
    });
    const parsed = ClassificationSchema.safeParse(result.finalOutput);
    if (!parsed.success) {
      return applySelfContainedGuard(plan, message, {
        kind: 'answers',
        answers: message,
        confidence: 0.3,
        reason: 'classifier output did not parse — defaulting to treat as answer',
      });
    }
    const data = parsed.data;
    return applySelfContainedGuard(plan, message, {
      kind: data.kind,
      answers: data.answers ?? undefined,
      confidence: data.confidence,
      reason: data.reason,
    });
  } catch {
    return applySelfContainedGuard(plan, message, {
      kind: 'answers',
      answers: message,
      confidence: 0.3,
      reason: 'classifier error — defaulting to treat as answer',
    });
  }
}

// ── workflow-input continuity ────────────────────────────────────────────
// A pending workflow run needs NAMED input values. The classifier returns an
// ARRAY of {name,value} pairs (named properties fill reliably under codex
// strict mode, unlike an open map — the same lesson as the workflow_run bug)
// plus an intent label so a clear pivot or "never mind" doesn't get parsed as
// a value.

const WorkflowInputClassificationSchema = z.object({
  kind: z.enum(['answers', 'new_topic', 'abandon']).describe(
    'How the new message relates to the workflow we are waiting to run: answers=it supplies input value(s); new_topic=a clearly different request; abandon=drop the run.',
  ),
  values: z.array(
    z.object({
      name: z.string().describe('Exactly one of the required input names listed.'),
      value: z.string().describe('The value the user supplied for that input.'),
    }),
  ).describe('Input name/value pairs extracted from the message. Empty array if none.'),
  confidence: z.number().min(0).max(1).describe('0..1 confidence in the kind label.'),
  reason: z.string().describe('One short sentence explaining the classification.'),
});

export function buildWorkflowInputClassifierPrompt(
  workflowName: string,
  missingInputs: string[],
  message: string,
): string {
  return [
    `Clementine tried to run the "${workflowName}" workflow but is waiting on required input value(s) before it can start. The user just sent a new message. Decide how it relates and extract any values.`,
    '',
    `Required input names still needed: ${missingInputs.join(', ')}`,
    '',
    `The user's new message:\n${message}`,
    '',
    'Choose exactly one kind:',
    '- answers: the message supplies value(s) for one or more of the required inputs. Put each into values as {name, value}, using ONLY the names listed above. If a single input is needed and the whole message is plainly that value, return it as that input.',
    '- new_topic: a clearly different request, unrelated to the inputs the workflow needs.',
    '- abandon: the user wants to drop the run ("never mind", "forget it", "cancel that").',
    '',
    'Bias toward "answers" whenever the message plausibly supplies a needed value. Normalize obvious wrappers (e.g. "use https://x.com" → value "https://x.com").',
  ].join('\n');
}

function buildWorkflowInputClassifierAgent(): Agent<RuntimeContextValue, typeof WorkflowInputClassificationSchema> {
  return new Agent<RuntimeContextValue, typeof WorkflowInputClassificationSchema>({
    name: 'WorkflowInputClassifier',
    instructions: [
      'You extract workflow input values from a user message and classify intent.',
      'Return only the structured classification. Do not call tools. Do not execute anything.',
    ].join('\n\n'),
    model: MODELS.fast,
    outputType: normalizeZodForCodexStrict(WorkflowInputClassificationSchema) as typeof WorkflowInputClassificationSchema,
    tools: [],
  });
}

export interface WorkflowInputClassification {
  kind: 'answers' | 'new_topic' | 'abandon';
  values: Record<string, string>;
  confidence: number;
  reason: string;
}

/**
 * Classify a reply against a pending workflow run + extract named input
 * values. Fails SAFE: on any error, if exactly one input is still missing the
 * whole message is taken as that value (the user was just asked for it), so a
 * classifier hiccup never strands the run.
 */
export async function classifyWorkflowInputAnswers(
  workflowName: string,
  missingInputs: string[],
  message: string,
): Promise<WorkflowInputClassification> {
  const singleInputFallback = (): WorkflowInputClassification => ({
    kind: 'answers',
    values: missingInputs.length === 1 ? { [missingInputs[0]]: message.trim() } : {},
    confidence: 0.3,
    reason: 'classifier unavailable — defaulting to treat the reply as the answer',
  });
  try {
    const runner = new Runner({ workflowName: 'clementine-workflow-input-continuity' });
    const result = await runner.run(
      buildWorkflowInputClassifierAgent(),
      buildWorkflowInputClassifierPrompt(workflowName, missingInputs, message),
      { maxTurns: 1 },
    );
    const parsed = WorkflowInputClassificationSchema.safeParse(result.finalOutput);
    if (!parsed.success) return singleInputFallback();
    const allowed = new Set(missingInputs);
    const values: Record<string, string> = {};
    for (const pair of parsed.data.values) {
      if (allowed.has(pair.name) && pair.value.trim().length > 0) values[pair.name] = pair.value.trim();
    }
    // The model said "answers" but didn't map a value, and only one input is
    // outstanding → take the whole message as that value.
    if (parsed.data.kind === 'answers' && Object.keys(values).length === 0 && missingInputs.length === 1) {
      values[missingInputs[0]] = message.trim();
    }
    return { kind: parsed.data.kind, values, confidence: parsed.data.confidence, reason: parsed.data.reason };
  } catch {
    return singleInputFallback();
  }
}

export interface PlanContinuityRouteInput {
  channel: string;
  input: string;
  sessionId: string;
  autonomy?: AutoApproveScope;
  sendNote?: (message: string) => Promise<void> | void;
}

export interface PlanContinuityRouteResult {
  handled: boolean;
  kind?: PlanContinuityKind;
  proposalId?: string;
  reason?: string;
}

/**
 * Route a new user message against the latest open asking-plan for the
 * channel. This is intentionally channel-neutral: Discord, desktop, and any
 * future harness surface should all use the same continuity decision so a
 * user's short answer does not become a fresh unrelated turn.
 */
/**
 * Resume a workflow that stalled on missing inputs: classify the reply, merge
 * any supplied values, and either queue the run, re-ask for what's still
 * missing (once, bounded by the next user reply), or set it aside on a pivot.
 * Never re-enters a model-driven retry — the queue is done in code.
 */
async function routeWorkflowPendingInputs(
  openWf: PlanProposal,
  input: PlanContinuityRouteInput,
): Promise<PlanContinuityRouteResult> {
  const workflowName = openWf.workflowName as string;
  const have = openWf.pendingInputValues ?? {};
  const required = openWf.requiredInputs ?? [];
  const missingBefore = required.filter((k) => !have[k] || have[k].trim().length === 0);
  const cls = await classifyWorkflowInputAnswers(
    workflowName,
    missingBefore.length > 0 ? missingBefore : required,
    input.input,
  );

  if (cls.kind === 'abandon' || cls.kind === 'new_topic') {
    supersedePlanProposal(openWf.id);
    if (input.sendNote) {
      await input.sendNote(
        cls.kind === 'abandon'
          ? `🍊 Okay, I've dropped the "${workflowName}" run.`
          : `🍊 I've set the "${workflowName}" run aside. On your new request:`,
      );
    }
    return { handled: false, kind: cls.kind, proposalId: openWf.id, reason: cls.reason };
  }

  const merged = { ...have, ...cls.values };
  // Gap E: re-enter THIS chat session on the resumed run's outcome — it's the
  // session that asked for the missing inputs and is waiting for the result.
  const result = resumeWorkflowRun(workflowName, merged, { originSessionId: input.sessionId });

  if (result.status === 'queued' || result.status === 'duplicate') {
    supersedePlanProposal(openWf.id);
    if (input.sendNote) await input.sendNote(`🍊 Got it — ${result.message}`);
    return { handled: true, kind: 'answers', proposalId: openWf.id, reason: cls.reason };
  }

  if (result.status === 'missing_inputs') {
    setWorkflowPendingInputValues(openWf.id, cls.values);
    const stillNeed = result.missing ?? [];
    if (input.sendNote) {
      await input.sendNote(
        `🍊 Thanks. I still need ${stillNeed.join(', ')} to run "${workflowName}". Reply with ${stillNeed.length === 1 ? 'it' : 'them'}.`,
      );
    }
    return { handled: true, kind: 'answers', proposalId: openWf.id, reason: cls.reason };
  }

  // not_found / disabled — the workflow changed out from under the ask.
  supersedePlanProposal(openWf.id);
  if (input.sendNote) await input.sendNote(`🍊 ${result.message}`);
  return { handled: true, kind: 'answers', proposalId: openWf.id, reason: result.message };
}

export async function routeOpenQuestionPlan(
  input: PlanContinuityRouteInput,
): Promise<PlanContinuityRouteResult> {
  // Session-keyed workflow ask-then-resume takes priority over the channel
  // path (the workflow_run tool that creates these has only a sessionId).
  const openWf = findOpenWorkflowPendingInputs(input.sessionId);
  if (openWf) return routeWorkflowPendingInputs(openWf, input);

  const openPlan = findOpenQuestionPlan(input.channel);
  if (!openPlan) return { handled: false };

  const classification = await classifyAgainstPlan(openPlan, input.input);
  const answers = classification.answers?.trim() || undefined;

  if (classification.kind === 'answers' || (classification.kind === 'resume' && answers)) {
    supersedePlanProposal(openPlan.id);
    const continued = await runPlanFirstPreflight({
      input: openPlan.originatingRequest,
      sessionId: input.sessionId,
      channel: input.channel,
      freshSession: false,
      autonomy: input.autonomy,
      priorAnswers: answers ?? input.input,
      // No `force`: plan-first is now opt-in (commit 396ba57). Let
      // shouldUsePlanFirst gate this re-entry like everywhere else — an
      // explicit-plan originating request ("draft me a plan…") still
      // re-engages the planner; an ordinary request returns
      // {surfaced:false} and the caller falls through to the normal
      // conversational orchestrator turn with the user's message.
    });
    return {
      handled: continued.surfaced,
      kind: classification.kind,
      proposalId: continued.proposalId,
      reason: classification.reason,
    };
  }

  if (classification.kind === 'resume') {
    const reasked = await runPlanFirstPreflight({
      input: openPlan.originatingRequest,
      sessionId: input.sessionId,
      channel: input.channel,
      freshSession: false,
      autonomy: input.autonomy,
      // No `force`: see the answers branch above. An explicit "resume"
      // of an explicit-plan request still re-surfaces the plan; an
      // ordinary resumed request returns {surfaced:false} → handled:false
      // → caller runs the normal conversational turn.
    });
    return {
      handled: reasked.surfaced,
      kind: classification.kind,
      proposalId: reasked.proposalId,
      reason: classification.reason,
    };
  }

  if (classification.kind === 'abandon') {
    supersedePlanProposal(openPlan.id);
    if (input.sendNote) {
      await input.sendNote("🍊 Okay, I've set that plan aside. Handling your message now.");
    }
    return { handled: false, kind: classification.kind, reason: classification.reason };
  }

  if (input.sendNote) {
    await input.sendNote(
      `🍊 Those don't look like answers to the saved plan ("${openPlan.plan.objective}"). I've kept it on hold — reply "resume" anytime to pick it back up. Meanwhile, on your new request:`,
    );
  }
  return { handled: false, kind: classification.kind, reason: classification.reason };
}
