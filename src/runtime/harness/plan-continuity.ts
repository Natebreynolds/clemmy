import { Agent, Runner } from '@openai/agents';
import { MODELS } from '../../config.js';
import { listPlanProposals, setWorkflowPendingInputValues, supersedePlanProposal, type PlanProposal } from '../../agents/plan-proposals.js';
import { resumeWorkflowRun } from '../../tools/workflow-run-queue.js';
import type { AutoApproveScope } from '../../agents/proactivity-policy.js';
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

/**
 * Parse the classifier's PLAIN-TEXT verdict. The marker keyword carries the
 * `kind`; the tail carries the extracted answers (for ANSWERS/RESUME) or a
 * short reason (for NEW_TOPIC/ABANDON). Deterministic, no schema to reject a
 * cosmetically-off-but-valid verdict — the same treatment the boundary judges
 * got (2e10714e/2538d916). Returns null when no marker is present, so the
 * caller applies its existing fail-SAFE "treat as answer" default. Pure +
 * exported for unit tests.
 */
export function parsePlanContinuityVerdict(
  raw: string,
): { kind: PlanContinuityKind; answers?: string; reason: string } | null {
  const match = /^\s*(ANSWERS|RESUME|NEW[\s_-]?TOPIC|ABANDON)\s*:?\s*(.*)$/im.exec(raw);
  if (!match) return null;
  const token = match[1].toUpperCase().replace(/[\s-]/g, '_');
  const tail = (match[2] || '').trim().slice(0, 600);
  if (token === 'ANSWERS') return { kind: 'answers', answers: tail || undefined, reason: tail || 'answers' };
  if (token === 'RESUME') return { kind: 'resume', answers: tail || undefined, reason: tail || 'resume' };
  if (token === 'NEW_TOPIC') return { kind: 'new_topic', reason: tail || 'new topic' };
  return { kind: 'abandon', reason: tail || 'abandon' };
}

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

function buildClassifierAgent(): Agent {
  return new Agent({
    name: 'PlanContinuityClassifier',
    instructions: [
      'You classify how a user\'s new message relates to a plan that is awaiting their answers.',
      'Reply with EXACTLY ONE LINE and nothing else, one of:',
      '"ANSWERS: <the answers the message supplies to the open questions, in the user\'s own words>" — use whenever the message plausibly maps to the open questions (bias toward this);',
      '"RESUME: <any answers folded in, else leave blank>" — the user is explicitly returning to / continuing this plan ("let\'s get back on that", "continue that");',
      '"NEW_TOPIC: <one short reason>" — a clearly different request, unrelated to the open questions;',
      '"ABANDON: <one short reason>" — the user wants to drop the plan ("never mind", "forget it", "cancel that").',
      'Do not call tools. Do not execute anything.',
    ].join('\n'),
    model: MODELS.fast,
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
    const raw = String((result as { finalOutput?: unknown }).finalOutput ?? '').trim();
    const parsed = parsePlanContinuityVerdict(raw);
    if (!parsed) {
      return applySelfContainedGuard(plan, message, {
        kind: 'answers',
        answers: message,
        confidence: 0.3,
        reason: 'classifier output had no marker — defaulting to treat as answer',
      });
    }
    // Confidence is set in code (a parsed marker is a confident label); it is
    // informational here — no consumer branches on it, and the self-contained
    // guard only clamps it upward when it downgrades answers→new_topic.
    return applySelfContainedGuard(plan, message, {
      kind: parsed.kind,
      answers: parsed.answers,
      confidence: 0.8,
      reason: parsed.reason,
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
// A pending workflow run needs NAMED input values. The classifier answers in
// PLAIN TEXT — a `kind` marker on the first line, then one `name: value` line
// per supplied input using ONLY the known required names. This removed the last
// structured output from this hot-path file: an ARRAY-of-{name,value} schema
// (already a workaround for codex-strict open-map failures) could still reject
// a valid extraction on provider-shape validation and strand a waiting run.
// Because the required names are KNOWN, we parse each by scanning for its line
// prefix — robust even when a value contains ':' or '=' (e.g. a URL).

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Parse the workflow-input verdict. First recognized marker sets the kind; for
 * ANSWERS, each required name is pulled from its own `name: value` line. Returns
 * null when no marker is present (caller applies its single-input fail-SAFE
 * default). Pure + exported for unit tests.
 */
export function parseWorkflowInputVerdict(
  raw: string,
  allowedNames: string[],
): { kind: 'answers' | 'new_topic' | 'abandon'; values: Record<string, string> } | null {
  const marker = /^\s*(ANSWERS|NEW[\s_-]?TOPIC|ABANDON)\b/im.exec(raw);
  if (!marker) return null;
  const token = marker[1].toUpperCase().replace(/[\s-]/g, '_');
  const kind = token === 'ANSWERS' ? 'answers' : token === 'ABANDON' ? 'abandon' : 'new_topic';
  const values: Record<string, string> = {};
  if (kind === 'answers') {
    for (const name of allowedNames) {
      const line = new RegExp(`^\\s*${escapeRegExp(name)}\\s*[:=]\\s*(.+)$`, 'im').exec(raw);
      const value = line?.[1]?.trim();
      if (value) values[name] = value.slice(0, 2000);
    }
  }
  return { kind, values };
}

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
    'Reply in PLAIN TEXT. Put a marker on the FIRST line — one of ANSWERS, NEW_TOPIC, or ABANDON:',
    '- ANSWERS: the message supplies value(s) for one or more of the required inputs. After the marker line, add ONE line per supplied value in the form "name: value", using ONLY the input names listed above. If a single input is needed and the whole message is plainly that value, return it on its line.',
    '- NEW_TOPIC: a clearly different request, unrelated to the inputs the workflow needs.',
    '- ABANDON: the user wants to drop the run ("never mind", "forget it", "cancel that").',
    '',
    'Bias toward ANSWERS whenever the message plausibly supplies a needed value. Normalize obvious wrappers (e.g. "use https://x.com" → value "https://x.com"). Output nothing but the marker line and any value lines.',
  ].join('\n');
}

function buildWorkflowInputClassifierAgent(): Agent {
  return new Agent({
    name: 'WorkflowInputClassifier',
    instructions: [
      'You extract workflow input values from a user message and classify intent.',
      'Reply in plain text: a kind marker (ANSWERS / NEW_TOPIC / ABANDON) on the first line, then one "name: value" line per supplied input. Do not call tools. Do not execute anything.',
    ].join('\n\n'),
    model: MODELS.fast,
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
    const raw = String((result as { finalOutput?: unknown }).finalOutput ?? '').trim();
    const parsed = parseWorkflowInputVerdict(raw, missingInputs);
    if (!parsed) return singleInputFallback();
    const values = parsed.values;
    // The model said "answers" but didn't map a value, and only one input is
    // outstanding → take the whole message as that value.
    if (parsed.kind === 'answers' && Object.keys(values).length === 0 && missingInputs.length === 1) {
      values[missingInputs[0]] = message.trim();
    }
    // Confidence is informational (no consumer branches on it); a parsed marker
    // is a confident label.
    return { kind: parsed.kind, values, confidence: 0.8, reason: `classified as ${parsed.kind}` };
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
