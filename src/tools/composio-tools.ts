import { createHash } from 'node:crypto';
import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import type { RuntimeContextValue } from '../types.js';
import { needsApprovalFromTaxonomy } from '../agents/tool-taxonomy.js';
import {
  executeComposioTool,
  getComposioCredentialStatus,
  listComposioToolkitTools,
  listConnectedToolkits,
} from '../integrations/composio/client.js';

const DYNAMIC_TOOL_PREFIX = 'cx_';
const MAX_TOOL_NAME_LENGTH = 64;
const DEFAULT_DYNAMIC_TOOLKIT_LIMIT = 25;
const DEFAULT_DYNAMIC_TOTAL_LIMIT = 120;
const DEFAULT_SEARCH_TOOLKIT_LIMIT = 80;
const DEFAULT_SEARCH_TOTAL_LIMIT = 20;

// Composio slug → ToolKind classification lives in agents/tool-taxonomy.ts
// (classifyComposioSlug). The previous ad-hoc READ_ONLY_PREFIXES /
// MUTATING_WORDS heuristic was deleted along with composioToolNeedsApproval.

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hashSuffix(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 8);
}

function sanitizeToolName(toolSlug: string): string {
  const cleaned = toolSlug
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_') || 'tool';
  const prefixed = `${DYNAMIC_TOOL_PREFIX}${cleaned}`;
  if (prefixed.length <= MAX_TOOL_NAME_LENGTH) return prefixed;
  const suffix = hashSuffix(toolSlug);
  return `${prefixed.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length - 1)}_${suffix}`;
}

function normalizeJsonSchemaObject(schema: unknown): Record<string, unknown> {
  if (isRecord(schema) && (schema.type === 'object' || isRecord(schema.properties))) {
    return {
      type: 'object',
      ...schema,
      additionalProperties: schema.additionalProperties ?? true,
    };
  }
  return {
    type: 'object',
    description: 'Arguments for the connected app action. Use the exact fields requested by the action.',
    additionalProperties: true,
  };
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) return {};
  return input;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
}

function scoreComposioTool(toolkitSlug: string, toolSlug: string, name: string, description: string | undefined, queryTerms: string[]): number {
  const haystack = `${toolkitSlug} ${toolSlug} ${name} ${description ?? ''}`.toLowerCase();
  let score = 0;
  for (const term of queryTerms) {
    if (toolSlug.toLowerCase().includes(term)) score += 5;
    if (name.toLowerCase().includes(term)) score += 4;
    if (description?.toLowerCase().includes(term)) score += 2;
    if (toolkitSlug.toLowerCase().includes(term)) score += 1;
    if (!haystack.includes(term)) score -= 1;
  }
  return score;
}

function describeDynamicTool(toolkitSlug: string, toolSlug: string, description?: string): string {
  // Lead with Composio's own description if it exists — that's the
  // model's primary signal of "what this does". Our scaffolding goes
  // at the end so it doesn't push the operational text below the
  // model's attention budget. Origin tag `[toolkit]` stays first so
  // the model can disambiguate same-named actions across toolkits.
  const real = description?.trim();
  const tag = `[${toolkitSlug}]`;
  if (real) return `${tag} ${real} (Composio action: ${toolSlug})`;
  return `${tag} Composio action ${toolSlug}. Call this directly when the fields are clear; use composio_list_tools first if you need to inspect the schema.`;
}

export async function getDynamicComposioRuntimeTools(options: {
  perToolkitLimit?: number;
  totalLimit?: number;
} = {}): Promise<Tool<RuntimeContextValue>[]> {
  const credentials = getComposioCredentialStatus();
  if (!credentials.enabled) return [];

  const perToolkitLimit = Math.max(1, Math.min(options.perToolkitLimit ?? DEFAULT_DYNAMIC_TOOLKIT_LIMIT, 100));
  const totalLimit = Math.max(1, Math.min(options.totalLimit ?? DEFAULT_DYNAMIC_TOTAL_LIMIT, 300));
  const connections = (await listConnectedToolkits()).filter((connection) => connection.status === 'ACTIVE');
  if (connections.length === 0) return [];

  const connectionsByToolkit = new Map<string, typeof connections>();
  for (const connection of connections) {
    const current = connectionsByToolkit.get(connection.slug) ?? [];
    current.push(connection);
    connectionsByToolkit.set(connection.slug, current);
  }

  const out: Tool<RuntimeContextValue>[] = [];
  const seenNames = new Set<string>();

  for (const [toolkitSlug, toolkitConnections] of connectionsByToolkit) {
    if (out.length >= totalLimit) break;

    let toolkitTools;
    try {
      toolkitTools = await listComposioToolkitTools(toolkitSlug, perToolkitLimit);
    } catch {
      continue;
    }

    const defaultConnectionId = toolkitConnections.length === 1 ? toolkitConnections[0]?.connectionId : undefined;
    for (const toolkitTool of toolkitTools) {
      if (out.length >= totalLimit) break;
      const name = sanitizeToolName(toolkitTool.slug);
      if (seenNames.has(name)) continue;
      seenNames.add(name);

      const toolSlug = toolkitTool.slug;
      out.push(tool({
        name,
        description: describeDynamicTool(toolkitSlug, toolSlug, toolkitTool.description),
        parameters: normalizeJsonSchemaObject(toolkitTool.inputParameters) as any,
        strict: false,
        // Unified taxonomy: cx_<slug> classifies via the Composio slug
        // (read for GET/LIST/etc., send for everything else), then
        // consults the scope policy (yolo → auto, strict → ask, etc.).
        needsApproval: needsApprovalFromTaxonomy(name),
        execute: async (input) => prettyJson(await executeComposioTool(
          toolSlug,
          normalizeToolInput(input),
          defaultConnectionId,
        )),
      }));
    }
  }

  return out;
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

  const composio_search_tools = tool({
    name: 'composio_search_tools',
    description: 'Search connected Composio toolkit actions on demand without preloading every action into the agent context. Use this when the user asks for an external-app task but the exact toolkit or action slug is unknown.',
    parameters: z.object({
      query: z.string().min(1),
      toolkit_slug: z.string().min(1).nullable(),
      limit: z.number().int().positive().max(50).nullable(),
    }),
    execute: async ({ query, toolkit_slug, limit }) => {
      const credentials = getComposioCredentialStatus();
      if (!credentials.enabled) {
        return prettyJson({
          configured: false,
          message: 'COMPOSIO_API_KEY is not configured. Connect Composio in the dashboard first.',
          matches: [],
        });
      }

      const connected = (await listConnectedToolkits()).filter((connection) => connection.status === 'ACTIVE');
      const targetToolkits = toolkit_slug
        ? [toolkit_slug]
        : [...new Set(connected.map((connection) => connection.slug))];
      const queryTerms = tokenize(query);
      const maxResults = Math.max(1, Math.min(limit ?? DEFAULT_SEARCH_TOTAL_LIMIT, 50));
      const matches: Array<{
        toolkit: string;
        slug: string;
        name: string;
        description?: string;
        score: number;
        inputParameters?: unknown;
      }> = [];

      for (const slug of targetToolkits) {
        let tools;
        try {
          tools = await listComposioToolkitTools(slug, DEFAULT_SEARCH_TOOLKIT_LIMIT);
        } catch (error) {
          matches.push({
            toolkit: slug,
            slug: '__toolkit_error__',
            name: 'Toolkit lookup failed',
            description: error instanceof Error ? error.message : String(error),
            score: -999,
          });
          continue;
        }

        for (const item of tools) {
          const score = scoreComposioTool(slug, item.slug, item.name, item.description, queryTerms);
          if (score <= 0 && queryTerms.length > 0) continue;
          matches.push({
            toolkit: slug,
            slug: item.slug,
            name: item.name,
            description: item.description,
            score,
            inputParameters: item.inputParameters,
          });
        }
      }

      matches.sort((left, right) => right.score - left.score || left.slug.localeCompare(right.slug));
      return prettyJson({
        configured: true,
        connectedToolkits: connected.map((connection) => ({
          toolkit: connection.slug,
          account: connection.accountLabel ?? connection.alias ?? null,
          connectionId: connection.connectionId,
        })),
        searchedToolkits: targetToolkits,
        query,
        count: Math.min(matches.length, maxResults),
        matches: matches.slice(0, maxResults),
        nextStep: 'Call the matching cx_<toolkit>_<action> first-class tool directly. (composio_execute_tool is only registered when first-class tools are unavailable — usually because Composio is not configured.)',
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
    // Taxonomy reads `tool_slug` from args to decide read-vs-send, so
    // GOOGLESHEETS_BATCH_GET autos through while GMAIL_SEND_EMAIL pauses
    // (or autos in YOLO).
    needsApproval: needsApprovalFromTaxonomy('composio_execute_tool'),
    execute: async ({ tool_slug, arguments: args, connected_account_id }) => {
      const result = await executeComposioTool(tool_slug, parseArgumentsJson(args), connected_account_id ?? undefined);
      return prettyJson(result);
    },
  });

  return [composio_status, composio_search_tools, composio_list_tools, composio_execute_tool];
}
