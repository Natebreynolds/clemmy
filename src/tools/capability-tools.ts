import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  checkCapability,
  checkAllCapabilities,
  getCapabilityDescriptor,
  listKnownCapabilities,
  renderCapabilityResult,
} from '../agents/capabilities.js';
import { textResult } from './shared.js';

/**
 * Capability tools — read-only pre-flight checks so the agent can
 * verify a CLI is available BEFORE drafting a plan that depends on
 * it. No approval needed; these only spawn short version probes.
 */

export function registerCapabilityTools(server: McpServer): void {
  server.tool(
    'check_capability',
    [
      'Check whether a CLI / binary is available on this machine.',
      'Call this BEFORE drafting plan steps that depend on an external CLI (sf, gh, gcloud, aws, kubectl, stripe, vercel, fly, etc.).',
      'Returns availability, version, install path, and an install hint if missing.',
      'If the capability is missing, your draft_plan should either:',
      '  (a) include a `needsUserInput` question asking how to proceed (install? use a different approach? non-standard path?), OR',
      '  (b) add a setup step that runs the install command if low-friction (e.g. brew install).',
      'Results are cached for 5 minutes so repeated calls are cheap.',
    ].join(' '),
    {
      name: z.string().min(1).max(80).describe('The CLI / command name to check (e.g. "sf", "gh", "gcloud").'),
    },
    async ({ name }) => {
      const result = await checkCapability(name);
      const descriptor = getCapabilityDescriptor(name);
      const rendered = renderCapabilityResult(result, descriptor);
      const json = JSON.stringify({ ...result, descriptor }, null, 2);
      return textResult(`${rendered}\n\nRAW:\n${json}`);
    },
  );

  server.tool(
    'list_capabilities',
    [
      'List all known capabilities (the CLIs the agent knows how to detect).',
      'Useful for introspection: "what integrations does the user potentially have?"',
      'Pass `probe: true` to actually run the version probes for each (slower but tells you what is installed RIGHT NOW).',
      'Probe results are cached for 5 minutes.',
    ].join(' '),
    {
      probe: z.boolean().optional().describe('If true, probe each capability to determine real availability. Default false (just returns the registry).'),
      category: z.enum(['crm', 'cloud', 'vcs', 'messaging', 'payments', 'devtools', 'other']).optional(),
    },
    async ({ probe, category }) => {
      const registry = listKnownCapabilities().filter((c) => !category || c.category === category);
      if (!probe) {
        const lines = registry.map((c) => `${c.name}\t${c.friendlyName}\t[${c.category}]`);
        return textResult(`Known capabilities (${registry.length}):\n${lines.join('\n')}\n\nPass probe=true to check availability.`);
      }
      const results = await checkAllCapabilities();
      const filtered = results.filter((r) => registry.some((c) => c.name === r.name));
      const available = filtered.filter((r) => r.available);
      const missing = filtered.filter((r) => !r.available);
      const availLines = available.map((r) => `✓ ${r.name}${r.version ? ` (${r.version.slice(0, 60)})` : ''}`);
      const missLines = missing.map((r) => `✗ ${r.name}`);
      const out = [
        `Available (${available.length}):`,
        ...availLines,
        '',
        `Missing (${missing.length}):`,
        ...missLines,
      ].join('\n');
      return textResult(out);
    },
  );
}
