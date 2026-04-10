import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { registerMemoryTools } from './memory-tools.js';
import { registerVaultTools } from './vault-tools.js';
import { registerPlanTools } from './plan-tools.js';
import { registerSessionTools } from './session-tools.js';
import { registerDynamicTools } from './dynamic-tools.js';
import { registerGoalTools } from './goal-tools.js';
import { registerAdminTools } from './admin-tools.js';
import { registerTeamTools } from './team-tools.js';
import { registerOrchestrationTools } from './orchestration-tools.js';
import { ensureToolDirectories, textResult } from './shared.js';
import { loadPlugins } from '../plugins/loader.js';
import type { PluginTool } from '../plugins/types.js';

const server = new McpServer({ name: 'clementine-next-tools', version: '0.3.0' });

registerMemoryTools(server);
registerVaultTools(server);
registerPlanTools(server);
registerSessionTools(server);
registerGoalTools(server);
registerAdminTools(server);
registerTeamTools(server);
registerOrchestrationTools(server);
registerDynamicTools(server);

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
      zodType = zodType.optional();
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
