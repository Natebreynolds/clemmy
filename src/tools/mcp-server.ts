import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { registerMemoryTools } from './memory-tools.js';
import { registerFocusTools } from './focus-tools.js';
import { registerVaultTools } from './vault-tools.js';
import { registerPlanTools } from './plan-tools.js';
import { registerSessionTools } from './session-tools.js';
import { registerDynamicTools } from './dynamic-tools.js';
import { registerGoalTools } from './goal-tools.js';
import { registerAdminTools } from './admin-tools.js';
import { registerTeamTools } from './team-tools.js';
import { registerOrchestrationTools } from './orchestration-tools.js';
import { registerAgentRunsTools } from './agent-runs-tools.js';
import { registerAutonomyActionTools } from './autonomy-action-tools.js';
import { registerBackgroundTaskTools } from './background-task-tools.js';
import { registerWorkerTools } from './worker-tools.js';
import { registerExecutionTools } from './execution-tools.js';
import { registerProfileTools } from './profile-tools.js';
import { registerCapabilityTools } from './capability-tools.js';
import { registerCliTools } from './cli-tools.js';
import { registerSkillTools } from './skill-tools.js';
import { registerWorkflowScheduleTools } from './workflow-schedule-tools.js';
import { registerSpaceTools } from './space-tools.js';
import { isSpacesEnabled } from '../spaces/store.js';
import { registerMcpStatusTools } from './mcp-status-tools.js';
import { registerMcpServerTools } from './mcp-server-tools.js';
import { registerToolChoiceTools } from './tool-choice-tools.js';
import { registerModelRoleTools } from './model-role-tools.js';
import { registerRecallTools } from './recall-tools.js';
import { registerGatedMutatingTools } from './gated-mutating-tools.js';
import { codeModeEnabled, codeModeDescription, runCodeModeForSession } from './code-mode-tool.js';
import { ensureToolDirectories, textResult } from './shared.js';
import { loadPlugins } from '../plugins/loader.js';
import type { PluginTool } from '../plugins/types.js';
import { withToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { withHarnessRunContext, ToolCallsCounter } from '../runtime/harness/brackets.js';

const server = new McpServer({ name: 'clementine-next-tools', version: '0.3.0' });

// Counter cap for the ambient harness run context. Most tools wrapped here are
// reads that never touch the counter; the gated mutating tools set their OWN
// inner context (gated-mutating-tools.ts), so this ambient counter only ever
// matters as a benign fallback.
const AMBIENT_COUNTER_LIMIT = 1000;

function installAmbientToolContext(): void {
  const sessionId = process.env.CLEMENTINE_MCP_SESSION_ID?.trim();
  if (!sessionId) return;
  const originalTool = server.tool.bind(server) as (...args: any[]) => unknown;
  (server as unknown as { tool: (...args: any[]) => unknown }).tool = (...args: any[]) => {
    const toolName = typeof args[0] === 'string' ? args[0] : undefined;
    const last = args.length - 1;
    const handler = args[last];
    if (toolName && typeof handler === 'function') {
      args[last] = async (...handlerArgs: any[]) => withToolOutputContext(
        { sessionId, toolName },
        // Also establish the harness run context so tools that read it for the
        // active session (execution_create / execution_* / plan / goal, etc.)
        // resolve CLEMENTINE_MCP_SESSION_ID instead of failing with "requires a
        // harness session context". Without this, the Agent SDK lane deadlocks:
        // the execution-wrap gate demands an execution lane before an outbound
        // send, but execution_create could not see the session to open one.
        // The gated mutating tools nest their own inner context (with the real
        // per-call counter), so this is a safe outer fallback for everything else.
        () => withHarnessRunContext(
          { sessionId, counter: new ToolCallsCounter(AMBIENT_COUNTER_LIMIT) },
          () => handler(...handlerArgs),
        ),
      );
    }
    return originalTool(...args);
  };
}

installAmbientToolContext();

// JIT tool-RAG for the Claude Agent SDK lane (Phase 1, Claude-brain port). When the
// brain decides to JIT-reduce the per-turn tool surface, it spawns THIS server with
// CLEMENTINE_MCP_ALLOWED_TOOLS=<comma-list> so only those tools are ADVERTISED — and
// since the SDK sends the schema of every advertised tool to the model, fewer
// advertised tools = fewer input tokens (allowedTools/canUseTool gate calls but do
// NOT shrink the schema payload — verified against the SDK). Unset (default) → no
// filtering, every tool registers exactly as before (byte-identical). Installed
// AFTER the ambient-context wrap so it's the OUTERMOST check (skips before wrapping).
function installToolAllowlistFilter(): void {
  const raw = process.env.CLEMENTINE_MCP_ALLOWED_TOOLS?.trim();
  if (!raw) return;
  const allowed = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  // Floor: a health tool that must always exist so the surface is never empty.
  const FLOOR = new Set(['ping']);
  const wrapped = server.tool.bind(server) as (...args: any[]) => unknown;
  (server as unknown as { tool: (...args: any[]) => unknown }).tool = (...args: any[]) => {
    const toolName = typeof args[0] === 'string' ? args[0] : undefined;
    if (toolName && !allowed.has(toolName) && !FLOOR.has(toolName)) {
      return undefined; // not in the JIT set → don't advertise it (schema not sent)
    }
    return wrapped(...args);
  };
}

installToolAllowlistFilter();

registerMemoryTools(server);
registerFocusTools(server);
registerVaultTools(server);
registerPlanTools(server);
registerSessionTools(server);
registerGoalTools(server);
registerAdminTools(server);
registerTeamTools(server);
registerOrchestrationTools(server);
registerAgentRunsTools(server);
registerBackgroundTaskTools(server);
registerWorkerTools(server);
registerAutonomyActionTools(server);
registerExecutionTools(server);
registerProfileTools(server);
registerCapabilityTools(server);
registerCliTools(server);
registerSkillTools(server);
registerWorkflowScheduleTools(server);
if (isSpacesEnabled()) registerSpaceTools(server);
registerMcpStatusTools(server);
registerMcpServerTools(server);
registerToolChoiceTools(server);
registerModelRoleTools(server);
// Recall tools (read-only): pull the verbatim/sliced payload of a clipped tool
// result. Needed so the Claude Agent SDK lane can read large outputs (e.g. a
// 25-row `sf data query`) the harness clipped — without them it hits the same
// "tool not found" the @openai/agents lane was fixed for.
registerRecallTools(server);
registerDynamicTools(server);
// Agent SDK lane only (CLEMENTINE_MCP_GATED_MUTATIONS=on): expose the mutating
// tools (shell/composio/write) through the full harness gate chain so the Claude
// Agent SDK can execute them safely. No-op for the Codex/OpenAI MCP wiring.
registerGatedMutatingTools(server);

// Code Mode (Lane C) — expose run_tool_program on the Claude SDK lane too, so
// BOTH brains can run a sandboxed program. Flag-gated (CLEMMY_CODE_MODE); the
// in-program clem calls dispatch through the same gated path under this MCP
// session. No-op when off.
if (codeModeEnabled()) {
  const codeModeSessionId = process.env.CLEMENTINE_MCP_SESSION_ID?.trim() || '';
  server.tool(
    'run_tool_program',
    codeModeDescription(),
    { program: z.string() },
    async (input: { program: string }) => {
      const r = await runCodeModeForSession(input.program, codeModeSessionId);
      return textResult(
        r.ok
          ? `code-mode program returned (${r.rpcCalls} tool call${r.rpcCalls === 1 ? '' : 's'}):\n${JSON.stringify(r.value)}`
          : `code-mode program failed: ${r.error}`,
      );
    },
  );
}

server.tool('ping', 'Basic health-check tool for the local MCP server.', {}, async () => textResult('pong'));

function registerPluginTool(server: McpServer, tool: PluginTool): void {
  // Build a Zod schema from the JSON Schema properties
  const properties = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, schemaDef] of Object.entries(properties)) {
    const def = schemaDef as { type?: string; description?: string; enum?: string[] };
    let zodType: z.ZodTypeAny;
    if (def.enum) {
      zodType = z.enum(def.enum as [string, ...string[]]);
    } else if (def.type === 'number' || def.type === 'integer') {
      zodType = z.number();
    } else if (def.type === 'boolean') {
      zodType = z.boolean();
    } else if (def.type === 'array') {
      zodType = z.array(z.unknown());
    } else {
      zodType = z.string();
    }
    if (!required.has(key)) {
      // v0.5.22 — .nullable() instead of .optional(). Codex strict mode
      // (SDK 0.11.5 default) requires every property in `required`;
      // optional fields must serialize as nullable so the field is
      // present with possibly-null value.
      zodType = zodType.nullable();
    }
    shape[key] = zodType;
  }

  server.tool(tool.name, tool.description, shape, async (input) => {
    return tool.handler(input as Record<string, unknown>);
  });
}

async function main(): Promise<void> {
  ensureToolDirectories();

  // Load and register user plugins
  const plugins = await loadPlugins();
  let pluginToolCount = 0;
  for (const plugin of plugins) {
    for (const tool of plugin.tools ?? []) {
      try {
        registerPluginTool(server, tool);
        pluginToolCount++;
      } catch (err) {
        console.error(`[plugins] Failed to register tool "${tool.name}" from plugin "${plugin.name}":`, err);
      }
    }
  }
  if (plugins.length > 0) {
    console.error(`[plugins] Loaded ${plugins.length} plugin(s) with ${pluginToolCount} tool(s)`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
