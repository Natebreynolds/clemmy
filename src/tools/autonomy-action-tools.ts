import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { addNotification } from '../runtime/notifications.js';
import { answerCheckIn, closeCheckIn, createCheckIn, listOpenCheckIns } from '../agents/check-ins.js';
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
	      addNotification({
	        id,
	        kind: notificationKind,
        title,
        body,
        createdAt: new Date().toISOString(),
        read: false,
        metadata: { source: 'notify_user_tool' },
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
}
