import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BASE_DIR } from '../config.js';
import { ExternalWritePreDispatchResult } from '../runtime/harness/external-write-admission.js';

export const DYNAMIC_SCRIPT_EXECUTION_UNAVAILABLE =
  'dynamic_script_execution_authority_unrepresented' as const;

const DYNAMIC_SCRIPT_EXECUTION_REASON =
  'Installed custom script execution is unavailable until its local process and every downstream effect are represented by Clementine\'s shared exact logical/physical authority kernel.';

interface DynamicScriptExecutionUnavailablePayload {
  ok: false;
  status: 'unavailable';
  code: typeof DYNAMIC_SCRIPT_EXECUTION_UNAVAILABLE;
  dispatch_state: 'not_started';
  processStarted: false;
  tool: string;
  script: string;
  reason: string;
}

/**
 * Nominal zero-body result shared by the OpenAI/local and MCP adapters.
 *
 * `content` + `isError` retain the normal MCP wire shape. Extending the existing
 * pre-dispatch carrier keeps the in-process harness from laundering this into a
 * successful local execution merely because the corrective returned normally.
 */
export class DynamicScriptExecutionUnavailableResult extends ExternalWritePreDispatchResult {
  [key: string]: unknown;
  readonly executionKind = 'refused_pre_dispatch' as const;
  readonly outcomeKind = 'policy_denial' as const;
  readonly policyRefused = true;
  readonly ok = false;
  readonly status = 'unavailable' as const;
  readonly code = DYNAMIC_SCRIPT_EXECUTION_UNAVAILABLE;
  readonly dispatch_state = 'not_started' as const;
  readonly processStarted = false;
  readonly tool: string;
  readonly script: string;
  readonly content: Array<{ type: 'text'; text: string }>;
  readonly isError = true;

  constructor(toolName: string, script: string) {
    const payload: DynamicScriptExecutionUnavailablePayload = {
      ok: false,
      status: 'unavailable',
      code: DYNAMIC_SCRIPT_EXECUTION_UNAVAILABLE,
      dispatch_state: 'not_started',
      processStarted: false,
      tool: toolName,
      script,
      reason: DYNAMIC_SCRIPT_EXECUTION_REASON,
    };
    const output = JSON.stringify(payload);
    super(output, DYNAMIC_SCRIPT_EXECUTION_UNAVAILABLE);
    this.tool = toolName;
    this.script = script;
    this.content = [{ type: 'text', text: output }];
  }
}

function dynamicToolName(file: string): string {
  return file.replace(/\.(sh|py)$/, '').replace(/[^a-z0-9_]/gi, '_');
}

/** Fresh synchronous inventory so approval routing never mistakes a manually
 * installed custom tool for a provider action merely because its name is
 * SCREAMING_SNAKE. */
export function listDynamicToolNames(): string[] {
  const toolsDir = path.join(BASE_DIR, 'tools');
  if (!existsSync(toolsDir)) return [];
  try {
    return readdirSync(toolsDir)
      .filter((entry) => entry.endsWith('.sh') || entry.endsWith('.py'))
      .map(dynamicToolName);
  } catch {
    return [];
  }
}

export function registerDynamicTools(server: McpServer): void {
  const toolsDir = path.join(BASE_DIR, 'tools');
  if (!existsSync(toolsDir)) return;

  for (const file of readdirSync(toolsDir).filter((entry) => entry.endsWith('.sh') || entry.endsWith('.py'))) {
    const toolName = dynamicToolName(file);
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
      `${description}\nExecution unavailable: this installed script is inventory-only until it is compiled into Clementine's shared exact authority kernel.`,
      // v0.5.22 — .nullable() instead of .optional(); Codex strict mode
      // requires every property in `required` (optional fields must be
      // nullable so the field is present with possibly-null value).
      { args: z.string().nullable().describe(argsDescription) },
      async () => new DynamicScriptExecutionUnavailableResult(toolName, file),
    );
  }
}
