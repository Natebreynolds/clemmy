import { Agent, Runner } from '@openai/agents';
import { z } from 'zod';
import { MODELS, getRuntimeEnv } from '../../config.js';
import { listPlanProposals, supersedePlanProposal, type PlanProposal } from '../../agents/plan-proposals.js';
import type { AutoApproveScope } from '../../agents/proactivity-policy.js';
import type { RuntimeContextValue } from '../../types.js';
import { normalizeZodForCodexStrict } from '../schema-normalizer.js';
import { runPlanFirstPreflight } from './plan-first.js';

/**
 * Plan continuity (flag `CLEMMY_PLAN_CONTINUITY`, default on).
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

export function planContinuityEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_PLAN_CONTINUITY', 'on') ?? 'on').toLowerCase() !== 'off';
}

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
    if (proposalNeedsUserInput(proposal)) return proposal;
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
      return {
        kind: 'answers',
        answers: message,
        confidence: 0.3,
        reason: 'classifier output did not parse — defaulting to treat as answer',
      };
    }
    const data = parsed.data;
    return {
      kind: data.kind,
      answers: data.answers ?? undefined,
      confidence: data.confidence,
      reason: data.reason,
    };
  } catch {
    return {
      kind: 'answers',
      answers: message,
      confidence: 0.3,
      reason: 'classifier error — defaulting to treat as answer',
    };
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
export async function routeOpenQuestionPlan(
  input: PlanContinuityRouteInput,
): Promise<PlanContinuityRouteResult> {
  if (!planContinuityEnabled()) return { handled: false };

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
      force: true,
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
      force: true,
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
