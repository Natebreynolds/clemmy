import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listHarnessCapabilityHealth, readHarnessCapabilityHealth } from '../runtime/harness/capability-health.js';
import { textResult } from './shared.js';

function renderLine(rec: ReturnType<typeof listHarnessCapabilityHealth>[number]): string {
  const reason = rec.reason ? ` — ${rec.reason}` : '';
  return `- ${rec.id}: ${rec.state}${reason} (last ${rec.lastSeenAt}, count ${rec.count})`;
}

export function registerHarnessStatusTools(server: McpServer): void {
  server.tool(
    'harness_status',
    [
      'Inspect Clementine harness-internal capability health: local MCP surface, SDK startup, model/tool routing, and other self-repair signals.',
      'Use this when a previous turn said a tool was unavailable, when the harness switched brains, or before diagnosing why Clementine could not use a capability it should have had.',
      'This is separate from mcp_status: mcp_status covers external MCP servers; harness_status covers Clementine\'s own car/dashboard.',
    ].join(' '),
    {
      capability_id: z.string().optional().describe('Specific harness capability id to inspect, e.g. "claude_sdk_local_mcp_surface". Omit to list recent degraded/unavailable records.'),
      include_healthy: z.boolean().optional().describe('Include healthy records too. Default false.'),
    },
    async ({ capability_id, include_healthy }) => {
      const one = capability_id?.trim();
      if (one) {
        const rec = readHarnessCapabilityHealth(one);
        if (!rec) return textResult(`No harness capability health record for "${one}".`);
        return textResult(`Harness capability ${one}:\n${renderLine(rec)}\n\nRAW:\n${JSON.stringify(rec, null, 2)}`);
      }

      const rows = listHarnessCapabilityHealth({ includeHealthy: include_healthy === true });
      const payload = { count: rows.length, capabilities: rows };
      return textResult([
        `Harness capability health (${rows.length} record${rows.length === 1 ? '' : 's'}):`,
        rows.length ? rows.map(renderLine).join('\n') : 'No degraded or unavailable harness capabilities recorded.',
        '',
        'RAW:',
        JSON.stringify(payload, null, 2),
      ].join('\n'));
    },
  );
}
