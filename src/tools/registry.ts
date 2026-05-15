import { z } from 'zod';
import { tool, type Tool } from '@openai/agents';
import type { RuntimeContextValue } from '../types.js';
import { getComputerTools } from './computer-tools.js';
import { getComposioRuntimeTools, getDynamicComposioRuntimeTools } from './composio-tools.js';
import { getLocalRuntimeTools } from './local-runtime-tools.js';

export function getCoreTools(): Tool<RuntimeContextValue>[] {
  const request_destructive_action = tool({
    name: 'request_destructive_action',
    description: 'Use this when the user explicitly wants a risky external action that should require human approval before execution.',
    parameters: z.object({
      action: z.string().min(1),
      reason: z.string().min(1),
    }),
    needsApproval: true,
    execute: async ({ action, reason }) => {
      return `Approved action placeholder: ${action}. Reason: ${reason}`;
    },
  });

  return [
    request_destructive_action,
    ...getLocalRuntimeTools(),
    ...getComputerTools(),
    ...getComposioRuntimeTools(),
  ];
}

export async function getCoreToolsAsync(options: {
  includeDynamicComposioTools?: boolean;
} = {}): Promise<Tool<RuntimeContextValue>[]> {
  const core = getCoreTools();
  if (!options.includeDynamicComposioTools) return core;

  try {
    const dynamic = await getDynamicComposioRuntimeTools();
    if (dynamic.length === 0) return core;
    // When first-class `cx_<slug>` tools are loaded, drop
    // `composio_execute_tool` from the broker. The model has the real
    // tools with real schemas in its surface — the broker's
    // free-form-string slug invite was the path where it would
    // hallucinate slugs (`GOOGLESHEETS_CREATE_SPREADSHEET` when the
    // real slug is `GOOGLESHEETS_CREATE_GOOGLE_SHEET1`).
    // Keep `composio_status` / `composio_search_tools` /
    // `composio_list_tools` — those are discovery helpers, not
    // execution paths.
    const filteredCore = core.filter(
      (t) => (t as { name?: string }).name !== 'composio_execute_tool',
    );
    return [...filteredCore, ...dynamic];
  } catch {
    // A connected-app catalog failure should not make the whole agent
    // unavailable. The broker tools remain available so the agent can
    // surface the actual connection/tooling issue.
    return core;
  }
}
