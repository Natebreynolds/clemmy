import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import type { RuntimeContextValue } from '../types.js';
import {
  executeComposioTool,
  getComposioCredentialStatus,
  listComposioToolkitTools,
  listConnectedToolkits,
} from '../integrations/composio/client.js';

const READ_ONLY_PREFIXES = [
  'GET',
  'LIST',
  'SEARCH',
  'FIND',
  'FETCH',
  'READ',
  'QUERY',
  'LOOKUP',
  'RETRIEVE',
];

const MUTATING_WORDS = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'REMOVE',
  'SEND',
  'POST',
  'PUT',
  'PATCH',
  'ADD',
  'INVITE',
  'UPLOAD',
  'ARCHIVE',
  'MOVE',
  'SUBMIT',
  'REPLY',
  'FORWARD',
  'STAR',
  'UNSTAR',
];

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function parseArgumentsJson(value: string | null | undefined): Record<string, unknown> {
  if (!value?.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Composio tool arguments must be a JSON object.');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid Composio arguments JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function composioToolNeedsApproval(toolSlug: string): boolean {
  const upper = toolSlug.toUpperCase();
  if (MUTATING_WORDS.some((word) => upper.includes(`_${word}_`) || upper.endsWith(`_${word}`) || upper.startsWith(`${word}_`))) {
    return true;
  }
  return !READ_ONLY_PREFIXES.some((prefix) => upper.startsWith(`${prefix}_`) || upper.includes(`_${prefix}_`));
}

export function getComposioRuntimeTools(): Tool<RuntimeContextValue>[] {
  const composio_status = tool({
    name: 'composio_status',
    description: 'Inspect whether Composio is configured and list active third-party app connections available to Clementine.',
    parameters: z.object({}),
    execute: async () => {
      const credentials = getComposioCredentialStatus();
      const connections = credentials.enabled ? await listConnectedToolkits() : [];
      return prettyJson({
        ...credentials,
        connections: connections.map((connection) => ({
          toolkit: connection.slug,
          connectionId: connection.connectionId,
          status: connection.status,
          account: connection.accountLabel ?? connection.alias ?? null,
        })),
      });
    },
  });

  const composio_list_tools = tool({
    name: 'composio_list_tools',
    description: 'List available Composio tools for one connected toolkit slug, such as gmail, slack, notion, github, or googlecalendar.',
    parameters: z.object({
      toolkit_slug: z.string().min(1),
      limit: z.number().int().positive().max(200).nullable(),
    }),
    execute: async ({ toolkit_slug, limit }) => {
      const tools = await listComposioToolkitTools(toolkit_slug, limit ?? 80);
      return prettyJson({
        toolkit: toolkit_slug,
        count: tools.length,
        tools: tools.map((item) => ({
          slug: item.slug,
          name: item.name,
          description: item.description,
          inputParameters: item.inputParameters,
        })),
      });
    },
  });

  const composio_execute_tool = tool({
    name: 'composio_execute_tool',
    description: 'Execute a specific Composio tool by slug using the user OAuth connection managed by Composio. Use composio_list_tools first if the exact tool slug or arguments are unknown. Pass arguments as a JSON object string.',
    parameters: z.object({
      tool_slug: z.string().min(1),
      arguments: z.string().nullable(),
      connected_account_id: z.string().nullable(),
    }),
    needsApproval: async (_context, input) => composioToolNeedsApproval(input.tool_slug),
    execute: async ({ tool_slug, arguments: args, connected_account_id }) => {
      const result = await executeComposioTool(tool_slug, parseArgumentsJson(args), connected_account_id ?? undefined);
      return prettyJson(result);
    },
  });

  return [composio_status, composio_list_tools, composio_execute_tool];
}
