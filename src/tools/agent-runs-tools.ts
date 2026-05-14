import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  autonomyRunSlug,
  getAutonomyRun,
  listAutonomyRuns,
} from '../agents/run-tracking.js';
import { textResult } from './shared.js';

/**
 * MCP tools for inspecting autonomy cycles.
 *
 * These work even before the autonomy loop adopts run-tracking — they
 * read from the same `runs.json` store the rest of the system already
 * populates. Once the integration point in src/agents/run-tracking.ts is
 * wired into runAgentCycle, every daemon cycle becomes inspectable
 * here without further changes.
 */

export function registerAgentRunsTools(server: McpServer): void {
  server.tool(
    'agent_runs_recent',
    'List recent autonomy cycles (daemon-source runs). Optional slug filter to focus on one agent. Includes status, wake reasons, outcomes preview, and duration.',
    {
      slug: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async ({ slug, limit }) => {
      const runs = listAutonomyRuns({ slug, limit: limit ?? 10 });
      if (runs.length === 0) {
        return textResult(
          slug
            ? `No autonomy runs recorded yet for agent "${slug}".`
            : 'No autonomy runs recorded yet. Wire src/agents/run-tracking.ts into runAgentCycle to enable.',
        );
      }

      const lines = runs.map((run) => {
        const ownerSlug = autonomyRunSlug(run) ?? run.userId ?? 'unknown';
        const duration = run.completedAt
          ? `${new Date(run.completedAt).getTime() - new Date(run.createdAt).getTime()}ms`
          : 'running';
        const outcome = run.outputPreview ? ` | ${run.outputPreview.slice(0, 160)}` : '';
        const errSuffix = run.error ? ` | error: ${run.error.slice(0, 120)}` : '';
        return `- ${run.id} [${run.status}] ${run.createdAt.slice(11, 19)} ${ownerSlug} (${duration})${outcome}${errSuffix}`;
      });

      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'agent_run_get',
    'Fetch the full event timeline of a single autonomy cycle by runId.',
    {
      id: z.string().min(1),
    },
    async ({ id }) => {
      const run = getAutonomyRun(id);
      if (!run) return textResult(`No run found with id ${id}.`);

      const header = [
        `Run ${run.id}`,
        `Agent: ${autonomyRunSlug(run) ?? run.userId ?? 'unknown'}`,
        `Status: ${run.status}`,
        `Title: ${run.title}`,
        `Started: ${run.createdAt}`,
        run.completedAt ? `Completed: ${run.completedAt}` : 'Completed: -',
        run.error ? `Error: ${run.error}` : '',
        run.outputPreview ? `Output preview: ${run.outputPreview}` : '',
      ].filter(Boolean).join('\n');

      const eventLines = run.events.map((event) => {
        const dataStr = event.data ? ` | ${JSON.stringify(event.data).slice(0, 400)}` : '';
        return `  ${event.createdAt.slice(11, 19)} [${event.type}] ${event.message}${dataStr}`;
      });

      return textResult([header, '', 'Events:', ...eventLines].join('\n'));
    },
  );
}
