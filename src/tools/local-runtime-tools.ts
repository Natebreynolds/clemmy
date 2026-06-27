import { tool, type Tool } from '@openai/agents';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { RuntimeContextValue } from '../types.js';
import { needsApprovalFromTaxonomy } from '../agents/tool-taxonomy.js';
import { registerAdminTools } from './admin-tools.js';
import { registerAgentRunsTools } from './agent-runs-tools.js';
import { registerAutonomyActionTools } from './autonomy-action-tools.js';
import { registerBackgroundTaskTools } from './background-task-tools.js';
import { registerBrowserHarnessTools } from './browser-harness-tools.js';
import { registerCapabilityTools } from './capability-tools.js';
import { registerCliTools } from './cli-tools.js';
import { registerSkillTools } from './skill-tools.js';
import { registerToolChoiceTools } from './tool-choice-tools.js';
import { registerModelRoleTools } from './model-role-tools.js';
import { registerWorkflowScheduleTools } from './workflow-schedule-tools.js';
import { registerSpaceTools } from './space-tools.js';
import { isSpacesEnabled } from '../spaces/store.js';
import { registerDynamicTools } from './dynamic-tools.js';
import { registerExecutionTools } from './execution-tools.js';
import { registerGoalTools } from './goal-tools.js';
import { registerMemoryTools } from './memory-tools.js';
import { registerFocusTools } from './focus-tools.js';
import { registerMcpStatusTools } from './mcp-status-tools.js';
import { registerMcpServerTools } from './mcp-server-tools.js';
import { registerOrchestrationTools } from './orchestration-tools.js';
import { registerStepResultTool } from './step-result-tool.js';
import { registerPlanTools } from './plan-tools.js';
import { registerProfileTools } from './profile-tools.js';
import { registerRecallTools } from './recall-tools.js';
import { registerSessionTools } from './session-tools.js';
import { registerTeamTools } from './team-tools.js';
import { registerVaultTools } from './vault-tools.js';
import { ensureToolDirectories, textResult } from './shared.js';
import { formatRecallableToolText } from '../runtime/harness/tool-output-format.js';
import { toolOutputContextFromSdk, withToolOutputContext } from '../runtime/harness/tool-output-context.js';

type LocalToolHandler = (input: Record<string, unknown>) => Promise<unknown> | unknown;

interface CapturedLocalTool {
  name: string;
  description: string;
  parameters: z.ZodRawShape;
  handler: LocalToolHandler;
  approvalRequired?: boolean;
}

// `create_tool` and `delete_agent` are admin tools in
// agents/tool-taxonomy.ts. `workspace_config` is mixed-mode there:
// list is read-only, add/remove are admin.

function resultToText(result: unknown): string {
  if (typeof result === 'string') return formatRecallableToolText(result);
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
      if (text) return formatRecallableToolText(text);
    }
  }

  try {
    return formatRecallableToolText(JSON.stringify(result, null, 2));
  } catch {
    return formatRecallableToolText(String(result));
  }
}

// v0.5.22 — moved the body of this normalizer to
// `src/runtime/schema-normalizer.ts` so agent outputType schemas can
// share the same transformation. The helpers below are thin re-exports
// to keep the existing call sites in this file compiling unchanged.
import {
  normalizeZodForCodexStrict as normalizeZodForResponses,
  normalizeShapeForCodexStrict as normalizeShapeForResponses,
} from '../runtime/schema-normalizer.js';
export { normalizeZodForResponses, normalizeShapeForResponses };

/**
 * Per-call destructive-hint override for the handful of local tools
 * where the kind depends on the args (e.g. `workspace_config` is admin
 * only on `add` / `remove`, but `list` is a plain read).
 */
function localDestructiveHint(toolName: string, input: unknown): boolean {
  if (toolName === 'workspace_config') {
    const action = (input && typeof input === 'object' ? (input as Record<string, unknown>).action : undefined);
    return action === 'add' || action === 'remove';
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
  registerFocusTools(server);
  registerVaultTools(server);
  registerPlanTools(server);
  registerSessionTools(server);
  registerGoalTools(server);
  registerAdminTools(server);
  registerTeamTools(server);
  registerOrchestrationTools(server);
  registerStepResultTool(server);

  // NOTE (2026-06-11 audit): the former `pause_for_user_approval` tool was
  // DELETED here. It was a broken duplicate of the real HITL path — it created
  // an in-memory gate with no response route, no UI, no durability, and told
  // the model "awaiting approval" while nothing ever waited. Mid-workflow
  // human sign-off is the declarative gate: split the step and put
  // `requiresApproval: true` (+ `approvalPreview`) on the gated step — the
  // runner registers a durable approval (console + Discord + notifications),
  // parks the run, and resumes on the user's decision.

  registerAgentRunsTools(server);
  registerBackgroundTaskTools(server);
  registerAutonomyActionTools(server);
  registerExecutionTools(server);
  registerProfileTools(server);
  registerRecallTools(server);
  registerCapabilityTools(server);
  registerCliTools(server);
  registerSkillTools(server);
  registerToolChoiceTools(server);
  registerModelRoleTools(server);
  registerWorkflowScheduleTools(server);
  if (isSpacesEnabled()) registerSpaceTools(server);
  registerBrowserHarnessTools(server);
  registerMcpStatusTools(server);
  registerMcpServerTools(server);
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
    // Unified taxonomy. The captured tool's `approvalRequired` flag is
    // honored via a destructive-hint so dynamic tools that the runtime
    // marks as "always ask" still pause regardless of policy scope.
    needsApproval: needsApprovalFromTaxonomy(localTool.name, {
      isDestructive: (input) =>
        Boolean(localTool.approvalRequired) || localDestructiveHint(localTool.name, input),
    }),
    execute: async (input, runContext, details) => withToolOutputContext(
      toolOutputContextFromSdk(localTool.name, runContext, details),
      async () => resultToText(await localTool.handler(input as Record<string, unknown>)),
    ),
  }));
}
