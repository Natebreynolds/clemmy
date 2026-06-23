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
import { BASE_DIR, PKG_DIR, getRuntimeEnv } from '../../config.js';
import { cliBinaryFromCommand } from '../../memory/authoritative-sources.js';
import { scheduleReflection } from '../../memory/reflection.js';
import { mergedSpawnEnv } from '../spawn-env.js';
import { buildClaudeHeadlessEnv, claudeCliModelArg, resolveClaudeCliPath } from './claude-headless-model.js';
import { buildGatedToolPermission } from './claude-agent-approval.js';
import { renderTranscriptTurns } from './session-transcript.js';

type QueryFn = typeof claudeQuery;
let queryImpl: QueryFn = claudeQuery;

export function setClaudeAgentSdkQueryForTest(fn: QueryFn | null): void {
  queryImpl = fn ?? claudeQuery;
}

// Test seam for the learning-OUT bridge (see runClaudeAgentSdk). Lets a test
// assert which tool returns get reflected without running the real extractor.
type ReflectFn = typeof scheduleReflection;
let reflectImpl: ReflectFn = scheduleReflection;
export function setClaudeAgentSdkReflectionForTest(fn: ReflectFn | null): void {
  reflectImpl = fn ?? scheduleReflection;
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
  'dispatch_background_task',
  'skill_list',
  'skill_read',
  'tool_choice_recall',
  // Recall the verbatim / sliced payload of a clipped tool result (read-only).
  'recall_tool_result',
  'tool_output_query',
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

// Mutating tools exposed through the harness gate chain (gated-mutating-tools.ts)
// + the async approval gate (claude-agent-approval.ts). Shared by the brain
// (full) and worker (scoped) agentic profiles.
const AGENTIC_EXECUTION_TOOLS = [
  'run_shell_command',
  'write_file',
  'composio_search_tools',
  'composio_list_tools',
  'composio_execute_tool',
  'local_cli_list',
  'local_cli_probe',
  // Surface-to-user channel. A workflow "notify"/report step (and agentic
  // workers) need this to actually deliver — it's registered on the MCP server
  // (registerAutonomyActionTools) but was absent from the allowlist, so a Claude
  // notify step blocked with no tool to call.
  'notify_user',
] as const;

/** Full agentic surface for the Claude BRAIN: local-authoring + execution tools
 *  + the gated mutating surface. Execution lanes let the execution-wrap gate be
 *  satisfied and batch fan-out wrap. */
export const CLAUDE_AGENT_SDK_FULL_TOOLS = [
  ...CLAUDE_AGENT_SDK_LOCAL_AUTHORING_TOOLS,
  ...AGENTIC_EXECUTION_TOOLS,
  'execution_create',
  'execution_list',
  'execution_get',
  'execution_update_step',
  'execution_mark_blocked',
  'execution_complete',
] as const;

/** Scoped agentic surface for a Claude WORKER (one parent-planned item). The
 *  PARENT owns the execution lane + batch approval, so a worker gets the gated
 *  mutating tools but NOT execution_create / workflow authoring. The shared
 *  parent session means the parent's execution lane + plan-scope cover the
 *  worker's gated writes. */
export const CLAUDE_AGENT_SDK_WORKER_TOOLS = [
  ...CLAUDE_AGENT_SDK_READ_ONLY_LOCAL_TOOLS,
  ...AGENTIC_EXECUTION_TOOLS,
] as const;

export type ClaudeAgentSdkToolProfile = 'read_only' | 'local_authoring' | 'full' | 'worker';

export function defaultClaudeAgentSdkAllowedLocalTools(profile: ClaudeAgentSdkToolProfile = 'read_only'): string[] {
  const raw = process.env.CLEMMY_CLAUDE_AGENT_SDK_ALLOWED_TOOLS?.trim();
  if (!raw && profile === 'full') return [...new Set(CLAUDE_AGENT_SDK_FULL_TOOLS)];
  if (!raw && profile === 'worker') return [...new Set(CLAUDE_AGENT_SDK_WORKER_TOOLS)];
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
  mcpToolAllowlist?: string[],
): Record<string, McpServerConfig> {
  const distEntry = path.join(PKG_DIR, 'dist', 'tools', 'mcp-server.js');
  const srcEntry = path.join(PKG_DIR, 'src', 'tools', 'mcp-server.ts');
  // gatedMutations=on exposes the mutating tools (shell/composio/write) on the
  // MCP surface, each run through the full harness gate chain (see
  // gated-mutating-tools.ts). Set only for the agentic brain/worker profiles —
  // a read-only run leaves it off so those tools never appear.
  // mcpToolAllowlist (JIT tool-RAG): when non-empty, the server advertises ONLY
  // those tools — fewer schemas sent to the model = fewer input tokens. Absent →
  // every tool registers (byte-identical to before).
  const allowlist = (mcpToolAllowlist ?? []).map((t) => t.trim()).filter(Boolean);
  const env = mergedSpawnEnv({
    CLEMENTINE_HOME: BASE_DIR,
    ...(sessionId?.trim() ? { CLEMENTINE_MCP_SESSION_ID: sessionId.trim() } : {}),
    ...(gatedMutations ? { CLEMENTINE_MCP_GATED_MUTATIONS: 'on' } : {}),
    ...(allowlist.length > 0 ? { CLEMENTINE_MCP_ALLOWED_TOOLS: allowlist.join(',') } : {}),
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
  /**
   * JIT tool-RAG (Claude-brain port). When set, the in-process MCP server is
   * spawned advertising ONLY these tools, so the model receives only their schemas
   * (fewer input tokens). The brain computes it per turn via selectToolsForTurn;
   * absent → the server advertises every tool (byte-identical). Should be a SUPERSET
   * of whatever the model is permitted to call (allowedLocalMcpTools).
   */
  mcpToolAllowlist?: string[];
  /**
   * CHAT-only multi-turn history. When set, the prior user/assistant turns of
   * this session are prepended to the prompt as an authoritative transcript block
   * so the Claude brain has conversation context (the Codex lane gets this from
   * its persisted AgentInputItem snapshot; the SDK lane is stateless —
   * persistSession:false). Worker/workflow callers omit it → byte-identical.
   */
  priorTurns?: Array<{ who: 'user' | 'assistant'; text: string }>;
  /**
   * CHAT-only streaming. When set, assistant text deltas are forwarded as they
   * arrive (this also flips includePartialMessages on). ONLY text_delta is
   * forwarded — thinking/tool-arg deltas are filtered out. Worker/workflow
   * callers omit it → no partial messages, byte-identical result assembly.
   */
  onDelta?: (text: string) => void | Promise<void>;
}

export interface ClaudeAgentSdkRunResult {
  text: string;
  structuredOutput?: unknown;
  sessionId?: string;
  model?: string;
  toolUses: string[];
  usage?: unknown;
  modelUsage?: unknown;
  /** True when the run stopped because it hit the turn budget (error_max_turns)
   *  rather than finishing. The caller surfaces a graceful "say continue" instead
   *  of a hard error — parity with the harness loop's auto-continue-on-limit. */
  limitHit?: boolean;
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

/** Pair tool_use ids → names from an assistant message (the MCP tool name is
 *  namespaced, e.g. `mcp__clementine-local__run_shell_command`). Used to label
 *  the reflection so the source-trust classifier can see the producing tool. */
function extractToolUseIds(message: SDKMessage): Array<{ id: string; name: string; input: unknown }> {
  if (message.type !== 'assistant') return [];
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string; name: string; input: unknown }> = [];
  for (const block of content) {
    const b = block as { type?: unknown; id?: unknown; name?: unknown; input?: unknown };
    if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
      out.push({ id: b.id, name: b.name, input: b.input });
    }
  }
  return out;
}

function bareMcpToolName(rawName: string): string {
  return rawName.split('__').at(-1) ?? rawName;
}

function reflectionToolName(rawName: string | null, input: unknown): string | null {
  if (!rawName) return null;
  const bare = bareMcpToolName(rawName);
  if (bare === 'composio_execute_tool') {
    const slug = (input as { tool_slug?: unknown } | null | undefined)?.tool_slug;
    return typeof slug === 'string' && slug.trim() ? slug.trim() : bare;
  }
  if (bare === 'run_shell_command') {
    const command = (input as { command?: unknown } | null | undefined)?.command;
    return typeof command === 'string' ? (cliBinaryFromCommand(command) ?? bare) : bare;
  }
  return bare;
}

function normalizeToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const cc = c as { type?: unknown; text?: unknown };
        return cc.type === 'text' && typeof cc.text === 'string' ? cc.text : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content == null) return '';
  try { return JSON.stringify(content); } catch { return String(content); }
}

/** Pull tool_result blocks (callId + flattened text) from a user message — the
 *  Agent SDK feeds MCP tool results back as a user turn carrying
 *  `{ type: 'tool_result', tool_use_id, content }` blocks. */
function extractToolResults(message: SDKMessage): Array<{ callId: string; output: string }> {
  if (message.type !== 'user') return [];
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  const out: Array<{ callId: string; output: string }> = [];
  for (const block of content) {
    const b = block as { type?: unknown; tool_use_id?: unknown; content?: unknown };
    if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      out.push({ callId: b.tool_use_id, output: normalizeToolResultContent(b.content) });
    }
  }
  return out;
}

/** Kill-switch for the Agent SDK learning-OUT bridge (default ON). Off ⇒ Claude
 *  brain/worker turns no longer write facts back (legacy behaviour). The global
 *  reflection disable flag still applies inside scheduleReflection regardless. */
export function claudeSdkReflectionEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_CLAUDE_SDK_REFLECTION', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

/** Flatten an assistant message's text blocks — used to keep the latest partial
 *  answer so a turn-limit stop can surface it gracefully (error results carry no
 *  `result` text). */
function extractAssistantText(message: SDKMessage): string {
  if (message.type !== 'assistant') return '';
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('');
}

/** Pull a streaming TEXT delta from a partial-message stream_event. Filters
 *  STRICTLY to text_delta — thinking_delta (chain-of-thought) and input_json_delta
 *  (raw tool-call args) are skipped so they never stream into the chat bubble. */
function extractTextDelta(message: SDKMessage): string {
  const m = message as { type?: unknown; event?: { type?: unknown; delta?: { type?: unknown; text?: unknown } } };
  if (m.type !== 'stream_event') return '';
  const ev = m.event;
  if (!ev || ev.type !== 'content_block_delta') return '';
  const delta = ev.delta;
  if (!delta || delta.type !== 'text_delta' || typeof delta.text !== 'string') return '';
  return delta.text;
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
  // Point the SDK at the user's installed `claude` CLI. The npm package ships the
  // native CLI as an OPTIONAL per-arch dep (@anthropic-ai/claude-agent-sdk-<plat>);
  // when packaged with --omit=optional (and/or when the daemon's arch differs from
  // the only bundled arch) the SDK's auto-resolve throws "Native CLI binary for
  // <plat>-<arch> not found". Resolving the user's own subscription-authed,
  // auto-updating `claude` here removes that dependency entirely (and the SDK
  // spawns it the same way it would the bundled native binary).
  const pathToClaudeCodeExecutable = resolveClaudeCliPath() ?? undefined;
  const sdkOptions: ClaudeAgentOptions = {
    env,
    ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
    model: options.modelId ? claudeCliModelArg(options.modelId) : undefined,
    cwd: PKG_DIR,
    persistSession: false,
    settingSources: [],
    skills: [],
    tools: [],
    mcpServers: buildClaudeAgentSdkLocalMcpServers(options.sessionId, agentic, options.mcpToolAllowlist),
    allowedTools: sdkToolNamesForLocalMcp(allowed),
    // Agentic: the async approval gate (read/local fast-allow, everything else
    // → decideToolApproval → register/surface/await). permissionMode 'default'
    // so non-allowlisted tools reach canUseTool. Non-agentic: deny-only allowlist.
    canUseTool: agentic
      ? buildGatedToolPermission(options.sessionId as string, allowed)
      : buildAllowOnlyToolsPermission(allowed),
    permissionMode: agentic ? 'default' : 'dontAsk',
    maxTurns: options.maxTurns ?? 3,
    // Flip ON only when a delta sink is provided (chat surfaces). Worker/workflow
    // callers omit onDelta → no partial-message traffic → result assembly +
    // error_max_turns handling stay byte-identical.
    includePartialMessages: Boolean(options.onDelta),
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: options.systemAppend,
      excludeDynamicSections: true,
    },
    ...(options.outputSchema ? { outputFormat: { type: 'json_schema', schema: options.outputSchema } } : {}),
  };

  // CHAT multi-turn history: prepend the prior session turns as an authoritative
  // transcript so the stateless SDK lane (persistSession:false) has context. Empty
  // / absent priorTurns → byte-identical bare prompt (worker/workflow path).
  const effectivePrompt = (options.priorTurns && options.priorTurns.length > 0)
    ? `[CONVERSATION SO FAR — prior turns in THIS session; treat as authoritative, do NOT re-ask decisions already made]\n${renderTranscriptTurns(options.priorTurns)}\n\n[Latest message]\n${options.prompt}`
    : options.prompt;

  const stream = queryImpl({ prompt: effectivePrompt, options: sdkOptions }) as Query;
  let result: SDKResultMessage | null = null;
  let init: SDKSystemMessage | null = null;
  const toolUses: string[] = [];
  // Learning OUT (brain continuity). The Agent SDK runs its tool loop OUTSIDE
  // the @openai/agents RunHooks, so the onToolEnd → scheduleReflection path the
  // Codex loop uses (hooks.ts) never fires here. Without this, a Claude
  // brain/worker turn READS memory but never writes facts back — Clementine
  // would stop learning from Claude turns. Re-source the same per-tool-return
  // reflection from the SDK message stream, in-process (where the extractor +
  // memory store live). scheduleReflection dedupes on sessionId::callId and
  // applies the same importance / self-tool / length gates, so this is parity
  // with Codex, not a second pipeline.
  const reflectSessionId = options.sessionId?.trim();
  const reflectLearning = Boolean(reflectSessionId) && claudeSdkReflectionEnabled();
  const toolById = new Map<string, { name: string; input: unknown }>();
  // Keep the latest assistant text so a turn-budget stop can surface the partial
  // answer (error results carry no `result` field).
  let lastAssistantText = '';
  // Some Claude Code SDK versions surface a turn-budget stop NOT as a clean
  // `result` message (subtype error_max_turns) but as a THROWN stream error
  // ("Claude Code returned an error result: Reached maximum number of turns (N)").
  // That bypasses the clean-result grace below, so a workflow step hard-failed.
  // Catch it here and fall through to the same limitHit handling.
  let threwTurnLimit = false;
  try {
    for await (const message of stream) {
      init = init ?? extractInit(message);
      if (options.onDelta) {
        const delta = extractTextDelta(message);
        if (delta) { try { await options.onDelta(delta); } catch { /* a delta-sink error must never break the run */ } }
      }
      const atext = extractAssistantText(message);
      if (atext) lastAssistantText = atext;
      if (reflectLearning) for (const use of extractToolUseIds(message)) toolById.set(use.id, { name: use.name, input: use.input });
      toolUses.push(...extractAssistantToolUses(message));
      if (reflectLearning) {
        for (const tr of extractToolResults(message)) {
          if (!tr.output) continue;
          const source = toolById.get(tr.callId);
          const tool = source ? reflectionToolName(source.name, source.input) : null;
          reflectImpl({ sessionId: reflectSessionId as string, callId: tr.callId, tool, output: tr.output });
        }
      }
      result = extractResult(message) ?? result;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/maximum number of turns|error_max_turns|max[_ ]turns/i.test(msg) && (result?.subtype ?? 'success') !== 'success') {
      threwTurnLimit = true;
    } else {
      throw err;
    }
  } finally {
    try { stream.close?.(); } catch { /* ignore */ }
  }

  if (threwTurnLimit) {
    return {
      text: (lastAssistantText.trim() || 'I reached the turn budget before finishing. Say "continue" and I\'ll pick up where I left off.'),
      sessionId: result?.session_id ?? init?.session_id,
      model: init?.model,
      toolUses,
      usage: result?.usage,
      modelUsage: result?.modelUsage,
      limitHit: true,
    };
  }

  if (!result) throw new Error('Claude Agent SDK finished without a result message.');
  if (result.subtype !== 'success') {
    // Long-running parity: a turn-budget stop is NOT a failure. Surface the
    // partial answer + a limitHit flag so the brain can offer "say continue"
    // (mirrors the harness loop's max-turns-with-grace) instead of throwing a
    // raw "Claude Agent SDK failed" error that the caller reports as run_failed.
    if (result.subtype === 'error_max_turns') {
      return {
        text: (lastAssistantText.trim() || 'I reached the turn budget before finishing. Say "continue" and I\'ll pick up where I left off.'),
        sessionId: result.session_id,
        model: init?.model,
        toolUses,
        usage: result.usage,
        modelUsage: result.modelUsage,
        limitHit: true,
      };
    }
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
