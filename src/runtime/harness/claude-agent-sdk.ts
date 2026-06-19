import path from 'node:path';
import { existsSync } from 'node:fs';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool,
  McpServerConfig,
  Options as ClaudeAgentOptions,
  Query,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { BASE_DIR, PKG_DIR } from '../../config.js';
import { mergedSpawnEnv } from '../spawn-env.js';
import { buildClaudeHeadlessEnv, claudeCliModelArg } from './claude-headless-model.js';
import { buildGatedToolPermission } from './claude-agent-approval.js';

type QueryFn = typeof claudeQuery;
let queryImpl: QueryFn = claudeQuery;

export function setClaudeAgentSdkQueryForTest(fn: QueryFn | null): void {
  queryImpl = fn ?? claudeQuery;
}

export const CLAUDE_AGENT_SDK_READ_ONLY_LOCAL_TOOLS = [
  'ping',
  'memory_search',
  'memory_read',
  'memory_recall',
  'memory_list_facts',
  'memory_search_facts',
  'task_list',
  'workspace_roots',
  'workspace_list',
  'workspace_info',
  'list_files',
  'read_file',
  'git_status',
  'mcp_status',
  'composio_status',
  'user_profile_read',
  'session_history',
  'agent_runs_recent',
  'agent_run_get',
  'background_tasks_recent',
  'background_task_status',
  'skill_list',
  'skill_read',
  'tool_choice_recall',
] as const;

export const CLAUDE_AGENT_SDK_LOCAL_AUTHORING_TOOLS = [
  ...CLAUDE_AGENT_SDK_READ_ONLY_LOCAL_TOOLS,
  // Local Clementine memory / planning state. These never touch external
  // systems, but they let Claude act like a real selected brain instead of a
  // read-only analyst.
  'memory_remember',
  'source_map_upsert',
  'working_memory',
  'note_create',
  'note_take',
  'task_add',
  'task_update',
  'goal_create',
  'goal_update',
  'create_plan',
  'update_plan_step',
  // Role routing is local env state and is the chat surface for "use Claude for
  // design" / "make Opus the judge".
  'set_model_role',
  'clear_model_role',
  // Workflow authoring and queueing are local Clementine state. The workflow
  // runner still owns execution-time write/send gates.
  'workflow_list',
  'workflow_get',
  'workflow_create',
  'workflow_from_session',
  'workflow_update',
  'workflow_set_enabled',
  'workflow_run',
  'workflow_run_status',
  'workflow_schedule',
  'workflow_unschedule',
] as const;

export type ClaudeAgentSdkToolProfile = 'read_only' | 'local_authoring';

export function defaultClaudeAgentSdkAllowedLocalTools(profile: ClaudeAgentSdkToolProfile = 'read_only'): string[] {
  const raw = process.env.CLEMMY_CLAUDE_AGENT_SDK_ALLOWED_TOOLS?.trim();
  if (!raw && profile === 'local_authoring') return [...new Set(CLAUDE_AGENT_SDK_LOCAL_AUTHORING_TOOLS)];
  if (!raw) return [...CLAUDE_AGENT_SDK_READ_ONLY_LOCAL_TOOLS];
  return raw
    .split(',')
    .map((toolName) => toolName.trim())
    .filter(Boolean);
}

function localNodeCommand(): string {
  return process.execPath || 'node';
}

export function buildClaudeAgentSdkLocalMcpServers(
  sessionId?: string,
  gatedMutations = false,
): Record<string, McpServerConfig> {
  const distEntry = path.join(PKG_DIR, 'dist', 'tools', 'mcp-server.js');
  const srcEntry = path.join(PKG_DIR, 'src', 'tools', 'mcp-server.ts');
  // gatedMutations=on exposes the mutating tools (shell/composio/write) on the
  // MCP surface, each run through the full harness gate chain (see
  // gated-mutating-tools.ts). Set only for the agentic brain/worker profiles —
  // a read-only run leaves it off so those tools never appear.
  const env = mergedSpawnEnv({
    CLEMENTINE_HOME: BASE_DIR,
    ...(sessionId?.trim() ? { CLEMENTINE_MCP_SESSION_ID: sessionId.trim() } : {}),
    ...(gatedMutations ? { CLEMENTINE_MCP_GATED_MUTATIONS: 'on' } : {}),
  });
  if (existsSync(distEntry)) {
    return {
      'clementine-local': {
        type: 'stdio',
        command: localNodeCommand(),
        args: [distEntry],
        env,
        timeout: 10 * 60 * 1000,
        alwaysLoad: true,
      },
    };
  }
  return {
    'clementine-local': {
      type: 'stdio',
      command: 'npx',
      args: ['tsx', srcEntry],
      env,
      timeout: 10 * 60 * 1000,
      alwaysLoad: true,
    },
  };
}

function normalizeToolName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function buildAllowOnlyToolsPermission(allowedTools: string[]): CanUseTool {
  const allowed = new Set(allowedTools.map(normalizeToolName).filter(Boolean));
  return async (toolName) => {
    const normalized = normalizeToolName(toolName);
    const tail = toolName.split('__').at(-1) ?? toolName;
    if (allowed.has(normalized) || allowed.has(normalizeToolName(tail))) {
      return { behavior: 'allow' };
    }
    return {
      behavior: 'deny',
      message: `Clementine did not allow Claude Agent SDK tool ${toolName} in this run.`,
      interrupt: false,
    };
  };
}

function sdkToolNamesForLocalMcp(tools: string[]): string[] {
  const out = new Set<string>();
  for (const tool of tools) {
    const t = tool.trim();
    if (!t) continue;
    out.add(t);
    out.add(`mcp__clementine-local__${t}`);
    out.add(`mcp__clementine_local__${t}`);
  }
  return [...out];
}

export interface ClaudeAgentSdkRunOptions {
  prompt: string;
  sessionId?: string;
  modelId?: string;
  systemAppend?: string;
  allowedLocalMcpTools?: string[];
  maxTurns?: number;
  outputSchema?: Record<string, unknown>;
  /**
   * Agentic lane: expose the gated mutating tools on MCP, run the async
   * approval gate (buildGatedToolPermission) instead of deny-only allowlisting,
   * and use permissionMode 'default' so non-allowlisted tools reach our gate.
   * Requires a sessionId (the gates + approval read/write the session's event
   * log); silently falls back to the read-only allowlist without one.
   */
  agentic?: boolean;
}

export interface ClaudeAgentSdkRunResult {
  text: string;
  structuredOutput?: unknown;
  sessionId?: string;
  model?: string;
  toolUses: string[];
  usage?: unknown;
  modelUsage?: unknown;
}

function extractAssistantToolUses(message: SDKMessage): string[] {
  if (message.type !== 'assistant') return [];
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    const b = block as { type?: unknown; name?: unknown };
    if (b.type === 'tool_use' && typeof b.name === 'string') out.push(b.name);
  }
  return out;
}

function extractResult(message: SDKMessage): SDKResultMessage | null {
  return message.type === 'result' ? (message as SDKResultMessage) : null;
}

function extractInit(message: SDKMessage): SDKSystemMessage | null {
  return message.type === 'system' && (message as { subtype?: unknown }).subtype === 'init'
    ? (message as SDKSystemMessage)
    : null;
}

export async function runClaudeAgentSdk(options: ClaudeAgentSdkRunOptions): Promise<ClaudeAgentSdkRunResult> {
  const env = await buildClaudeHeadlessEnv();
  const allowed = options.allowedLocalMcpTools ?? defaultClaudeAgentSdkAllowedLocalTools();
  // Agentic lane requires a session id (the gate chain + approval read/write the
  // session's event log). Without one, fall back to the read-only allowlist.
  const agentic = Boolean(options.agentic && options.sessionId?.trim());
  const sdkOptions: ClaudeAgentOptions = {
    env,
    model: options.modelId ? claudeCliModelArg(options.modelId) : undefined,
    cwd: PKG_DIR,
    persistSession: false,
    settingSources: [],
    skills: [],
    tools: [],
    mcpServers: buildClaudeAgentSdkLocalMcpServers(options.sessionId, agentic),
    allowedTools: sdkToolNamesForLocalMcp(allowed),
    // Agentic: the async approval gate (read/local fast-allow, everything else
    // → decideToolApproval → register/surface/await). permissionMode 'default'
    // so non-allowlisted tools reach canUseTool. Non-agentic: deny-only allowlist.
    canUseTool: agentic
      ? buildGatedToolPermission(options.sessionId as string, allowed)
      : buildAllowOnlyToolsPermission(allowed),
    permissionMode: agentic ? 'default' : 'dontAsk',
    maxTurns: options.maxTurns ?? 3,
    includePartialMessages: false,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: options.systemAppend,
      excludeDynamicSections: true,
    },
    ...(options.outputSchema ? { outputFormat: { type: 'json_schema', schema: options.outputSchema } } : {}),
  };

  const stream = queryImpl({ prompt: options.prompt, options: sdkOptions }) as Query;
  let result: SDKResultMessage | null = null;
  let init: SDKSystemMessage | null = null;
  const toolUses: string[] = [];
  try {
    for await (const message of stream) {
      init = init ?? extractInit(message);
      toolUses.push(...extractAssistantToolUses(message));
      result = extractResult(message) ?? result;
    }
  } finally {
    try { stream.close?.(); } catch { /* ignore */ }
  }

  if (!result) throw new Error('Claude Agent SDK finished without a result message.');
  if (result.subtype !== 'success') {
    throw new Error(`Claude Agent SDK failed: ${JSON.stringify(result).slice(0, 800)}`);
  }
  return {
    text: result.result,
    structuredOutput: result.structured_output,
    sessionId: result.session_id,
    model: init?.model,
    toolUses,
    usage: result.usage,
    modelUsage: result.modelUsage,
  };
}
