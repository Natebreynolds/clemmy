import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { addNotification } from '../runtime/notifications.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { appendEvent } from '../runtime/harness/eventlog.js';
import { answerCheckIn, closeCheckIn, createCheckIn, listOpenCheckIns, validateCheckInQuestion } from '../agents/check-ins.js';
import { proposeCheckInTemplate } from '../agents/check-in-proposals.js';
import { surfacePlan } from '../agents/plan-proposals.js';
import { PlanSchema, type Plan } from '../agents/planner.js';
import { textResult } from './shared.js';

/**
 * Autonomy-only action tools. These are the things v1 used to express
 * as JSON action types (`{type: 'notify_user', ...}`) but which v2
 * needs as actual callable tools so the agent can invoke them during
 * its run.
 *
 * Scope is intentionally narrow: tools here are safe to call from
 * any agent, identity-free (no `from_agent` argument needed) and side-
 * effecting only against the local user surface (notification queue).
 *
 * Cross-agent communication (message_agent, complete_delegation,
 * delegate, reply_request) needs context-aware identity propagation —
 * that lands in Phase 3 alongside native handoffs.
 */

function compactLine(value: string, max = 180): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

function renderSharedPlan(plan: Plan, message?: string): string {
  const steps = plan.steps
    .slice(0, 6)
    .map((step) => `${step.n}. ${compactLine(step.action, 220)}`);
  const criteria = plan.successCriteria
    .slice(0, 4)
    .map((item) => `- ${compactLine(item, 180)}`);
  const instructions = (plan.appliedInstructions ?? [])
    .slice(0, 4)
    .map((item) => `- ${compactLine(item, 180)}`);
  const risks = plan.risks
    .slice(0, 3)
    .map((item) => `- ${compactLine(item, 180)}`);

  return [
    message?.trim() || 'Here is the working plan I am using before I start the tool work.',
    '',
    `Goal: ${compactLine(plan.objective, 260)}`,
    '',
    'Plan:',
    ...steps,
    criteria.length ? '' : null,
    criteria.length ? 'Success check:' : null,
    ...criteria,
    instructions.length ? '' : null,
    instructions.length ? "Instructions I'm following:" : null,
    ...instructions,
    risks.length ? '' : null,
    risks.length ? 'Risks / constraints:' : null,
    ...risks,
  ]
    .filter((part): part is string => typeof part === 'string')
    .join('\n');
}

export function registerAutonomyActionTools(server: McpServer): void {
  server.tool(
    'notify_user',
    'Send a notification to the user via the notification queue. Use for meaningful status updates, blockers, or anything the user genuinely wants surfaced. Avoid spamming — one notification per real signal.',
    {
      title: z.string().min(1).max(140),
      body: z.string().min(1).max(2000),
      kind: z.enum(['system', 'approval', 'execution', 'workflow', 'cron']).optional(),
	    },
	    async ({ title, body, kind }) => {
	      const id = `${Date.now()}-tool-notify`;
	      const notificationKind = kind === 'approval' || kind === 'execution' || kind === 'workflow' || kind === 'cron'
	        ? kind
	        : 'system';
	      const ctx = getToolOutputContext();
	      const workflowRunId =
	        ctx?.sessionId && ctx.sessionId.startsWith('workflow:')
	          ? ctx.sessionId.split(':')[1]
	          : undefined;
	      addNotification({
	        id,
	        kind: notificationKind,
        title,
        body,
        createdAt: new Date().toISOString(),
        read: false,
        metadata: workflowRunId
          ? { source: 'notify_user_tool', workflowRunId }
          : { source: 'notify_user_tool' },
      });
      return textResult(`Notification queued: ${id}`);
    },
  );

  server.tool(
    'ask_user_question',
    'Pause and ask the user a clarifying question. Use ONLY when you genuinely cannot proceed without an answer — not for things you can decide yourself. The user is notified; your next cycle wakes up with their answer in the inbox. Optional contextExecutionId links the question to a tracked execution so you can resume that work the moment the answer arrives.',
    {
      agentSlug: z.string().min(1).describe('Your own slug (e.g. "clementine"). Identifies whose inbox the answer routes back to.'),
      question: z.string().min(8).max(1200),
      urgency: z.enum(['low', 'normal', 'high']).optional(),
      contextExecutionId: z.string().optional(),
      contextSummary: z.string().max(600).optional().describe('One-sentence reminder of what you were working on so the user has context when they answer.'),
    },
    async ({ agentSlug, question, urgency, contextExecutionId, contextSummary }) => {
      const quality = validateCheckInQuestion(question, contextSummary);
      if (!quality.ok) {
        return textResult(`Question rejected: ${quality.reason}`);
      }
      try {
        const record = createCheckIn({ agentSlug, question, urgency, contextExecutionId, contextSummary });
        return textResult(`Check-in created: ${record.id}. The user has been notified; you'll see their answer in your next cycle's inbox.`);
      } catch (err) {
        return textResult(`ask_user_question failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'list_pending_check_ins',
    'List open check-ins waiting for a user answer. Optionally filter to a specific agent. Useful for the user to see "what is the agent waiting on me for?"',
    {
      agentSlug: z.string().optional(),
    },
    async ({ agentSlug }) => {
      const open = listOpenCheckIns(agentSlug);
      if (open.length === 0) return textResult('No open check-ins.');
      const lines = open.map((c) => {
        const urgency = c.urgency !== 'normal' ? ` [${c.urgency}]` : '';
        const ctx = c.contextExecutionId ? ` exec=${c.contextExecutionId}` : '';
        return `- ${c.id}${urgency} (${c.agentSlug}, asked ${c.askedAt.slice(0, 19)})${ctx}: ${c.question}`;
      });
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'answer_check_in',
    'Resolve an open check-in with an answer. The agent that asked the question gets the answer in its next autonomy inbox cycle and resumes work. Pass close=true with a reason to dismiss without answering.',
    {
      id: z.string().min(1),
      answer: z.string().min(1).max(4000).optional(),
      close: z.boolean().optional(),
      closeReason: z.string().max(600).optional(),
    },
    async ({ id, answer, close, closeReason }) => {
      if (close) {
        const closed = closeCheckIn(id, closeReason ?? 'Dismissed by user.');
        if (!closed) return textResult(`No check-in found with id ${id}.`);
        return textResult(`Check-in ${id} closed without answer.`);
      }
      if (!answer) return textResult('Either provide `answer` to resolve, or pass `close: true` to dismiss.');
      const resolved = answerCheckIn(id, answer);
      if (!resolved) return textResult(`No check-in found with id ${id}.`);
      if (resolved.status !== 'answered') return textResult(`Check-in ${id} was already in status ${resolved.status} — no change.`);
      return textResult(`Check-in ${id} answered. The agent (${resolved.agentSlug}) will pick this up on its next cycle.`);
    },
  );

  server.tool(
    'share_plan',
    [
      'Share a non-blocking working plan in the current chat before continuing.',
      'Use after `draft_plan` for complex but safe local/read-only work where the user should see how you will proceed, but no approval is required.',
      'Do NOT use when needsUserInput is non-empty — ask the missing question instead.',
      'Do NOT use for significant/large/tracked/external-write plans that require review; use `surface_plan` for those.',
      'This does not persist a PlanProposal, does not notify Discord separately, and does not create approval buttons. It only makes your plan visible in the live chat/event trace.',
      'Pass the EXACT plan JSON you received from draft_plan in the `planJson` argument.',
    ].join(' '),
    {
      planJson: z.string().min(20).describe('The JSON plan exactly as draft_plan returned it. Will be parsed and validated against PlanSchema.'),
      originatingRequest: z.string().min(4).max(2000).describe('The user request that triggered the plan. Used only as trace context.'),
      sessionId: z.string().optional().describe('The chat/session to render the plan into. Defaults to the current tool-output context session.'),
      message: z.string().min(8).max(500).optional().describe('Optional concise preface, e.g. "I found enough context to proceed; here is the working plan."'),
    },
    async ({ planJson, originatingRequest, sessionId, message }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(planJson);
      } catch (err) {
        return textResult(`share_plan failed: planJson is not valid JSON (${err instanceof Error ? err.message : String(err)}).`);
      }
      const planResult = PlanSchema.safeParse(parsed);
      if (!planResult.success) {
        return textResult(`share_plan failed: planJson did not match PlanSchema. ${planResult.error.message}`);
      }
      if (planResult.data.needsUserInput.length > 0) {
        return textResult([
          'share_plan refused: the plan still needs user input.',
          'Ask the user this clarification instead:',
          ...planResult.data.needsUserInput.map((q) => `- ${q}`),
        ].join('\n'));
      }

      const ctx = getToolOutputContext();
      const targetSessionId = sessionId?.trim() || ctx?.sessionId;
      const preview = renderSharedPlan(planResult.data, message);
      if (!targetSessionId) {
        return textResult([
          'Working plan ready, but no sessionId was available to render it into chat.',
          preview,
        ].join('\n\n'));
      }

      try {
        appendEvent({
          sessionId: targetSessionId,
          turn: 0,
          role: 'Clem',
          type: 'conversation_step',
          data: {
            kind: 'plan_preview',
            originatingRequest,
            decision: {
              summary: `Shared working plan: ${planResult.data.objective}`,
              reply: preview,
              done: false,
              nextAction: 'completed',
            },
            plan: {
              objective: planResult.data.objective,
              estimatedComplexity: planResult.data.estimatedComplexity,
              recommendsTrackedExecution: planResult.data.recommendsTrackedExecution,
              steps: planResult.data.steps.map((step) => ({
                n: step.n,
                action: step.action,
              })),
            },
          },
        });
      } catch (err) {
        return textResult(`share_plan failed to render in chat: ${err instanceof Error ? err.message : String(err)}`);
      }

      return textResult([
        'Working plan shared in the current chat.',
        `Objective: ${planResult.data.objective}`,
        `Complexity: ${planResult.data.estimatedComplexity}; ${planResult.data.steps.length} step(s).`,
        'Continue executing the plan now unless a later tool boundary asks for approval.',
      ].join('\n'));
    },
  );

  server.tool(
    'surface_plan',
    [
      'Surface a Plan you just received from `draft_plan` to the user for review.',
      'Use when the plan is significant or large enough that the user should see it before any mutation happens — typically when estimatedComplexity is "significant" or "large", or when recommendsTrackedExecution is true.',
      'Do NOT use this when needsUserInput is non-empty. Ask the user the missing question first; an unanswered clarification is not approvable.',
      'The plan is persisted as a PlanProposal and the user is notified via Discord + dashboard. Your reply to the user should say "I drafted a plan for X — review and approve when ready."',
      'Pass the EXACT plan JSON you received from draft_plan in the `planJson` argument. Do not paraphrase or summarize — preserve the structured fields.',
      'For trivial / moderate work, do NOT surface — execute against the plan directly.',
    ].join(' '),
    {
      planJson: z.string().min(20).describe('The JSON plan exactly as draft_plan returned it. Will be parsed and validated against PlanSchema.'),
      originatingRequest: z.string().min(4).max(2000).describe('The user request that triggered the plan, so the user has context on what the plan is for.'),
      sessionId: z.string().optional().describe('The session this plan belongs to, so the agent can resume execution in the same session after approval.'),
      channel: z.string().optional().describe('The channel the originating request came from (e.g. "discord:USER_ID", "cli", "webhook").'),
      context: z.string().max(800).optional().describe('Optional one-sentence preface telling the user what they\'re looking at (e.g. "I noticed three risks before I start — please review").'),
    },
    async ({ planJson, originatingRequest, sessionId, channel, context }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(planJson);
      } catch (err) {
        return textResult(`surface_plan failed: planJson is not valid JSON (${err instanceof Error ? err.message : String(err)}).`);
      }
      const planResult = PlanSchema.safeParse(parsed);
      if (!planResult.success) {
        return textResult(`surface_plan failed: planJson did not match PlanSchema. ${planResult.error.message}`);
      }
      if (planResult.data.needsUserInput.length > 0) {
        return textResult([
          'surface_plan refused: the plan still needs user input, so it cannot be approved yet.',
          'Ask the user this clarification first:',
          ...planResult.data.needsUserInput.map((q) => `- ${q}`),
          'After the user answers, draft or revise the plan and only surface it if it is executable.',
        ].join('\n'));
      }
      try {
        const proposal = surfacePlan({
          plan: planResult.data,
          originatingRequest,
          sessionId,
          channel,
          context,
        });
        // Enumerated irreversible sends — the user MUST see these before approving,
        // because approving this plan auto-blesses exactly these send shapes (they
        // then run hands-off within the goal scope; off-shape sends still pause).
        const sends = Array.isArray(proposal.plan.externalSends) ? proposal.plan.externalSends : [];
        const sendsLine = sends.length > 0
          ? `Irreversible sends the user is blessing by approving: ${sends.map((s) => `${s.count ? `${s.count}× ` : ''}${s.summary} [${s.slug}]`).join('; ')}.`
          : 'No irreversible external sends in this plan.';
        return textResult([
          `Plan surfaced: ${proposal.id}.`,
          `Objective: ${proposal.plan.objective}`,
          `Complexity: ${proposal.plan.estimatedComplexity}; ${proposal.plan.steps.length} step(s); recommends tracked execution: ${proposal.plan.recommendsTrackedExecution}.`,
          sendsLine,
          `The user has been notified — they can review and approve in the dashboard or by replying.`,
          sends.length > 0
            ? `Tell the user, in plain language: what you'll do, and EXACTLY what will be sent (${sends.map((s) => `${s.count ? `${s.count} ` : ''}${s.summary}`).join('; ')}) — then ask them to approve. On approval those sends run without further prompts; anything else still pauses.`
            : `Tell the user: "I drafted a plan — review it when you have a moment, and reply to approve when you're ready."`,
        ].join('\n'));
      } catch (err) {
        return textResult(`surface_plan failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'propose_check_in_template',
    [
      'Propose a NEW autonomous check-in template the user can approve.',
      'Use when you notice a recurring rhythm in the user\'s work — weekly deploys,',
      'daily standups, monthly reviews, or a condition that should trigger a nudge.',
      'You DO NOT auto-install the template — the user reviews and approves from',
      'Settings → Proactive Check-Ins. Frame the rationale clearly: what pattern',
      'you noticed, why this template would help, when it would fire.',
      '',
      'Trigger kinds:',
      '  - schedule          → fires on a 5-field cron expression (e.g. "0 9 * * 1" = Mon 9am)',
      '  - execution_blocked → fires when a tracked execution has been blocked > blockedHours',
      '  - goal_stale        → fires when a goal has not been updated in > staleDays',
      '  - inbox_backed_up   → fires when open check-ins count >= inboxThreshold',
    ].join(' '),
    {
      name: z.string().min(3).max(80),
      description: z.string().max(400).optional(),
      trigger: z.enum(['schedule', 'execution_blocked', 'goal_stale', 'inbox_backed_up']),
      schedule: z.string().optional(),
      blockedHours: z.number().int().min(1).max(720).optional(),
      staleDays: z.number().int().min(1).max(365).optional(),
      inboxThreshold: z.number().int().min(1).max(100).optional(),
      questionTemplate: z.string().min(8).max(800).describe(
        'The question shown to the user. Supports {{summary}}, {{date}}, {{time}}, {{executionTitle}}, {{blocker}}, {{goalTitle}}, {{count}} placeholders.',
      ),
      urgency: z.enum(['low', 'normal', 'high']).optional(),
      cooldownHours: z.number().int().min(0).max(720).optional(),
      rationale: z.string().min(8).max(800).describe('Explain WHY you think this template would help. Reference the specific pattern you saw.'),
    },
    async (input) => {
      try {
        const proposal = proposeCheckInTemplate(input);
        return textResult([
          `Proposal queued: ${proposal.id}.`,
          `Name: ${proposal.name}`,
          `Trigger: ${proposal.trigger}${proposal.schedule ? ` (cron: ${proposal.schedule})` : ''}`,
          'The user has been notified and can approve from Settings → Proactive Check-Ins.',
        ].join('\n'));
      } catch (err) {
        return textResult(`Propose failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
