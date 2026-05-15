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
    // Keep `composio_status` / `composio_search_tools` /
    // `composio_list_tools` / `composio_execute_tool` ALL in the surface
    // alongside the first-class `cx_<toolkit>_<action>` tools.
    //
    // The first-class set is curated (~25 actions per toolkit) and won't
    // cover every Composio action — Outlook alone has hundreds. When the
    // model needs an action it doesn't see directly (list/read/search/
    // query), the discovery → execution flow is:
    //   composio_search_tools(query)  →  returns real slugs
    //   composio_execute_tool(tool_slug, arguments)  →  runs the action
    //
    // We DON'T strip `composio_execute_tool` anymore. The previous
    // hallucination concern (model inventing slugs like
    // GOOGLESHEETS_CREATE_SPREADSHEET) is mitigated by routing through
    // `composio_search_tools` first — the slugs that come back are real,
    // and the executor returns a clear error for unknown slugs anyway.
    return [...core, ...dynamic];
  } catch {
    // A connected-app catalog failure should not make the whole agent
    // unavailable. The broker tools remain available so the agent can
    // surface the actual connection/tooling issue.
    return core;
  }
}
