import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BASE_DIR } from '../config.js';
import { findSafeCliCommand } from '../runtime/cli-discovery.js';
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
      // v0.5.22 — .nullable() instead of .optional(); Codex strict mode
      // requires every property in `required` (optional fields must be
      // nullable so the field is present with possibly-null value).
      { args: z.string().nullable().describe(argsDescription) },
      async ({ args }) => {
        try {
          let command = filePath;
          let commandArgs: string[] = args ? [args] : [];
          if (file.endsWith('.py')) {
            // Route python3 through the stub guard. On a fresh Mac with
            // no Xcode/CLT installed, `/usr/bin/python3` is a shim that
            // pops the CLT installer when invoked. The guard returns a
            // clear "install python3 (or Xcode CLT) first" error instead
            // of triggering Apple's system dialog.
            const safe = findSafeCliCommand('python3');
            if (!safe) {
              return textResult('Tool error: python3 is not installed on $PATH. Install Python 3 (e.g. via Homebrew: `brew install python`) then retry.');
            }
            if (safe.skipped) {
              return textResult(`Tool error: ${safe.reason}`);
            }
            command = safe.command;
            commandArgs = [filePath, ...(args ? [args] : [])];
          }
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
