import { tool, type Tool } from '@openai/agents';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { RuntimeContextValue } from '../types.js';
import { registerAdminTools } from './admin-tools.js';
import { registerAgentRunsTools } from './agent-runs-tools.js';
import { registerAutonomyActionTools } from './autonomy-action-tools.js';
import { registerDynamicTools } from './dynamic-tools.js';
import { registerExecutionTools } from './execution-tools.js';
import { registerGoalTools } from './goal-tools.js';
import { registerMemoryTools } from './memory-tools.js';
import { registerOrchestrationTools } from './orchestration-tools.js';
import { registerPlanTools } from './plan-tools.js';
import { registerProfileTools } from './profile-tools.js';
import { registerSessionTools } from './session-tools.js';
import { registerTeamTools } from './team-tools.js';
import { registerVaultTools } from './vault-tools.js';
import { ensureToolDirectories, textResult } from './shared.js';

type LocalToolHandler = (input: Record<string, unknown>) => Promise<unknown> | unknown;

interface CapturedLocalTool {
  name: string;
  description: string;
  parameters: z.ZodRawShape;
  handler: LocalToolHandler;
  approvalRequired?: boolean;
}

const APPROVAL_REQUIRED_TOOLS = new Set([
  'create_tool',
  'delete_agent',
  'workspace_config',
]);

function resultToText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .map((item) => {
          if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
            return (item as { text: string }).text;
          }
          return JSON.stringify(item);
        })
        .filter(Boolean)
        .join('\n');
      if (text) return text;
    }
  }

  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function withDescription(source: z.ZodTypeAny, target: z.ZodTypeAny): z.ZodTypeAny {
  return source.description ? target.describe(source.description) : target;
}

function normalizeZodForResponses(schema: z.ZodTypeAny): z.ZodTypeAny {
  const def = (schema as any)._def as { typeName?: string; [key: string]: unknown };

  switch (def.typeName) {
    case 'ZodOptional':
      return withDescription(schema, normalizeZodForResponses(def.innerType as z.ZodTypeAny).nullable());
    case 'ZodNullable':
      return withDescription(schema, normalizeZodForResponses(def.innerType as z.ZodTypeAny).nullable());
    case 'ZodObject': {
      const shape = typeof (schema as any).shape === 'function' ? (schema as any).shape() : (schema as any).shape;
      const normalizedShape = Object.fromEntries(
        Object.entries(shape as z.ZodRawShape).map(([key, value]) => [key, normalizeZodForResponses(value)]),
      );
      return withDescription(schema, z.object(normalizedShape));
    }
    case 'ZodArray':
      return withDescription(schema, z.array(normalizeZodForResponses(def.type as z.ZodTypeAny)));
    case 'ZodRecord': {
      const valueType = def.valueType ? normalizeZodForResponses(def.valueType as z.ZodTypeAny) : z.string();
      return withDescription(schema, z.record(z.string(), valueType));
    }
    case 'ZodAny':
    case 'ZodUnknown':
      return withDescription(schema, z.string());
    case 'ZodUnion': {
      const options = Array.isArray(def.options) ? def.options.map((item) => normalizeZodForResponses(item as z.ZodTypeAny)) : [];
      if (options.length === 0) return withDescription(schema, z.string());
      if (options.length === 1) return withDescription(schema, options[0]);
      return withDescription(schema, z.union(options as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]));
    }
    default:
      return schema;
  }
}

function normalizeShapeForResponses(shape: z.ZodRawShape): z.ZodRawShape {
  return Object.fromEntries(
    Object.entries(shape).map(([key, value]) => [key, normalizeZodForResponses(value)]),
  );
}

function needsRuntimeApproval(localTool: CapturedLocalTool, input: Record<string, unknown>): boolean {
  if (localTool.approvalRequired) return true;
  const { name } = localTool;
  if (APPROVAL_REQUIRED_TOOLS.has(name)) {
    if (name === 'workspace_config') {
      return input.action === 'add' || input.action === 'remove';
    }
    return true;
  }
  return false;
}

function captureLocalTools(): CapturedLocalTool[] {
  ensureToolDirectories();
  const captured: CapturedLocalTool[] = [];
  const fakeServer = {
    tool(
      name: string,
      description: string,
      parameters: z.ZodRawShape,
      handler: LocalToolHandler,
    ): void {
      captured.push({ name, description, parameters, handler });
    },
  };
  const server = fakeServer as unknown as McpServer;

  registerMemoryTools(server);
  registerVaultTools(server);
  registerPlanTools(server);
  registerSessionTools(server);
  registerGoalTools(server);
  registerAdminTools(server);
  registerTeamTools(server);
  registerOrchestrationTools(server);
  registerAgentRunsTools(server);
  registerAutonomyActionTools(server);
  registerExecutionTools(server);
  registerProfileTools(server);
  const dynamicToolStart = captured.length;
  registerDynamicTools(server);
  for (const dynamicTool of captured.slice(dynamicToolStart)) {
    dynamicTool.approvalRequired = true;
  }

  captured.push({
    name: 'ping',
    description: 'Basic health-check tool for the local Clementine tool runtime.',
    parameters: {},
    handler: async () => textResult('pong'),
  });

  return captured;
}

export function getLocalRuntimeTools(): Tool<RuntimeContextValue>[] {
  return captureLocalTools().map((localTool) => tool({
    name: localTool.name,
    description: localTool.description,
    parameters: z.object(normalizeShapeForResponses(localTool.parameters)),
    needsApproval: async (_context, input) => needsRuntimeApproval(localTool, input as Record<string, unknown>),
    execute: async (input) => resultToText(await localTool.handler(input as Record<string, unknown>)),
  }));
}
