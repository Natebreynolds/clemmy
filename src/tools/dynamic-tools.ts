import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BASE_DIR } from '../config.js';
import { textResult } from './shared.js';

export function registerDynamicTools(server: McpServer): void {
  const toolsDir = path.join(BASE_DIR, 'tools');
  if (!existsSync(toolsDir)) return;

  for (const file of readdirSync(toolsDir).filter((entry) => entry.endsWith('.sh') || entry.endsWith('.py'))) {
    const toolName = file.replace(/\.(sh|py)$/, '').replace(/[^a-z0-9_]/gi, '_');
    const filePath = path.join(toolsDir, file);
    const metaPath = `${filePath}.meta.json`;

    let description = `Custom tool: ${toolName}`;
    let argsDescription = 'Optional argument string';

    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as {
          description?: string;
          args_description?: string;
        };
        description = meta.description || description;
        argsDescription = meta.args_description || argsDescription;
      } catch {
        // Ignore bad metadata and keep defaults.
      }
    }

    server.tool(
      toolName,
      description,
      { args: z.string().optional().describe(argsDescription) },
      async ({ args }) => {
        try {
          const command = file.endsWith('.py') ? 'python3' : filePath;
          const commandArgs = file.endsWith('.py') ? [filePath, ...(args ? [args] : [])] : args ? [args] : [];
          const result = execFileSync(command, commandArgs, {
            cwd: BASE_DIR,
            encoding: 'utf-8',
            timeout: 30_000,
            env: {
              ...process.env,
              CLEMENTINE_HOME: BASE_DIR,
            },
          });
          return textResult(result.trim() || '(no output)');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return textResult(`Tool error: ${message}`);
        }
      },
    );
  }
}
