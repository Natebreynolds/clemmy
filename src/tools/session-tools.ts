import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sessions, textResult } from './shared.js';

export function registerSessionTools(server: McpServer): void {
  server.tool(
    'session_history',
    'Read recent conversation history for a session.',
    {
      session_id: z.string().min(1),
      max_turns: z.number().int().min(1).max(40).optional(),
    },
    async ({ session_id, max_turns }) => {
      const transcript = sessions.recentTranscript(session_id, max_turns ?? 12);
      return textResult(transcript || 'No history yet for that session.');
    },
  );

  server.tool(
    'session_resume',
    'Summarize a session so work can resume cleanly after context drift or a restart.',
    {
      session_id: z.string().min(1),
    },
    async ({ session_id }) => {
      const session = sessions.get(session_id);
      if (session.turns.length === 0) {
        return textResult('No prior activity for that session.');
      }

      const recentTurns = session.turns.slice(-16).map((turn) => {
        const speaker = turn.role === 'user' ? 'User' : 'Assistant';
        return `- ${speaker}: ${turn.text}`;
      });

      return textResult(
        [
          `Session: ${session.id}`,
          `Updated: ${session.updatedAt}`,
          '',
          'Recent turns:',
          ...recentTurns,
        ].join('\n'),
      );
    },
  );
}
