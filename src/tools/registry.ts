import { z } from 'zod';
import { tool, type Tool } from '@openai/agents';
import type { RuntimeContextValue } from '../types.js';
import { getComputerTools } from './computer-tools.js';
import { getComposioRuntimeTools } from './composio-tools.js';
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
