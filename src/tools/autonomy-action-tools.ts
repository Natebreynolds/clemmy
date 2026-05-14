import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { addNotification } from '../runtime/notifications.js';
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
}
