import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  checkCapability,
  getCapabilityDescriptor,
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
}
