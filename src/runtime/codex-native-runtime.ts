import { randomUUID } from 'node:crypto';
import pino from 'pino';
import type { ApprovalResolutionResult, PendingApproval, RunRequest, RunResult } from '../types.js';
import { AgentRuntimeCancelledError, ASSISTANT_PAUSED_PLACEHOLDER, type AgentRuntime, type AgentRuntimeCallbacks } from './provider.js';
import { ApprovalStore } from './approval-store.js';
import { addNotification, getNotification } from './notifications.js';
import { ASSISTANT_NAME } from '../config.js';
import { getStoredCodexOAuthTokens, refreshStoredNativeOAuth } from './auth-store.js';
import { getCoreToolsAsync } from '../tools/registry.js';
import { getOrCreateConfiguredMcpServers } from './mcp-servers.js';
import { classifyTool, decideToolApproval } from '../agents/tool-taxonomy.js';
import { beginToolEvent, recordPendingApproval, recordToolEvent } from '../agents/tool-observability.js';
import { truncateToolText } from '../tools/shared.js';
import type { RuntimeContextValue, ToolActivity } from '../types.js';

const logger = pino({ name: 'clementine-next.codex-native-runtime' });

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CODEX_USER_AGENT = 'Codex/0.118.0';
const DEFAULT_CODEX_MODEL = 'gpt-5.4';

interface CodexSseEvent {
  event?: string;
  data?: string;
}

export interface CodexFunctionCall {
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface StoredCodexApprovalState {
  request: RunRequest;
  toolCall?: CodexFunctionCall;
  inputHistory?: CodexInputMessage[];
}

interface CodexResponseResult {
  text: string;
  toolCalls: CodexFunctionCall[];
  responseId?: string;
}

interface CodexInputMessage {
  [key: string]: unknown;
}

class CodexRuntimeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'CodexRuntimeError';
  }
}

// One actionable user-facing notification per calendar day when the
// Codex OAuth token has expired AND the auto-refresh attempt failed.
// Without this, the 401 throws unwind to a logger.error stack trace
// in the caller (cron, autonomy, controller) and the user never sees
// the "re-authenticate" prompt — observed 35 silent 401s in a row in
// production logs. Bucket id by date so we never spam.
function notifyCodexAuthExpired(refreshError?: string): void {
  const id = `system-codex-auth-expired-${new Date().toISOString().slice(0, 10)}`;
  if (getNotification(id)) return;
  const detail = refreshError ? `Refresh attempt failed: ${refreshError}\n\n` : '';
  addNotification({
    id,
    kind: 'system',
    title: 'Codex authentication expired — re-authenticate to resume agent work',
    body: `${detail}Clementine's model backend rejected the stored OAuth token and the auto-refresh attempt failed. Open the Clementine desktop app and click "Re-authenticate Codex" in Settings, or run \`clementine auth login\` in a terminal. Background jobs, cron triggers, and chat will keep failing until this is resolved.`,
    createdAt: new Date().toISOString(),
    read: false,
    metadata: { errorCategory: 'auth_expired', provider: 'codex' },
  });
}

async function throwIfCancelled(callbacks?: AgentRuntimeCallbacks): Promise<void> {
  if (await callbacks?.shouldCancel?.()) {
    throw new AgentRuntimeCancelledError();
  }
}

/**
 * Tool surface presented to the Codex Responses API.
 *
 * Three sources, merged in a single flat list:
 *   1. Local SDK tools (`getCoreTools`) — request_destructive_action,
 *      computer-use, local runtime tools, Composio broker + cx_*.
 *   2. MCP tools via the namespace shim — `<server>__<tool>` names.
 *   3. (future) computer-use primitives via SDK `computerTool`.
 *
 * The OpenAI Agents SDK does NOT mediate Codex requests (Codex talks
 * to `chatgpt.com/backend-api/codex/responses` directly), so this
 * runtime is responsible for the same fan-in the SDK Runner does
 * elsewhere: list the MCP shim's tools, present them to the model,
 * route incoming function-calls back to the shim's `callTool`.
 */
async function createCodexToolDefinitions() {
  // 1. Local tools (Composio + computer + local runtime + planner shims).
  const local = await getCoreToolsAsync({ includeDynamicComposioTools: true });

  // 2. MCP tools through the namespace shim. We tolerate the shim
  //    being slow / partially broken — listTools() inside the shim
  //    already swallows per-server failures, so a single dead MCP
  //    server doesn't take the whole tool surface down.
  let mcpDefs: Array<{ type: string; name: string; description?: string; parameters: unknown; strict?: boolean }> = [];
  try {
    const shim = getOrCreateConfiguredMcpServers();
    if (typeof shim.connect === 'function') {
      await shim.connect();
    }
    const mcpTools = await shim.listTools();
    mcpDefs = mcpTools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description ?? `MCP tool ${t.name}`,
      // The MCP SDK gives us a JSON Schema in `inputSchema`. Codex
      // accepts JSON Schema directly in the `parameters` field, same
      // as OpenAI function-calling.
      parameters: (t as { inputSchema?: unknown }).inputSchema ?? { type: 'object', additionalProperties: true },
    }));
  } catch (err) {
    logger.warn({ err }, 'failed to enumerate MCP tools for Codex runtime; continuing without MCP');
  }

  const localDefs = local
    .filter((tool) => tool.type === 'function')
    .map((tool) => ({
      type: 'function' as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: tool.strict,
    }));

  return [...localDefs, ...mcpDefs];
}

async function createToolMap() {
  const tools = await getCoreToolsAsync({ includeDynamicComposioTools: true });
  return new Map(tools
    .filter((tool) => tool.type === 'function')
    .map((tool) => [tool.name, tool]));
}

/**
 * True if `name` is a namespace-shimmed MCP tool: `<server>__<tool>`.
 * The Codex executeToolCall path routes these to the shim instead of
 * looking them up in the local tool map (where they don't exist).
 */
function isMcpToolName(name: string): boolean {
  return name.includes('__');
}

/**
 * MCP `callTool` returns a CallToolResult — an array of content
 * objects (text / image / resource). Collapse to a single string so
 * Codex can feed it back into the next turn the same shape it does
 * for SDK function-tool outputs.
 */
function stringifyMcpResult(result: unknown): string {
  if (typeof result === 'string') return truncateToolText(result);
  if (Array.isArray(result)) {
    return truncateToolText(result.map(stringifyMcpResult).join('\n'));
  }
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.content)) {
      const parts: string[] = [];
      for (const item of r.content) {
        if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
          parts.push((item as { text: string }).text);
        } else if (item && typeof item === 'object') {
          parts.push(JSON.stringify(item));
        }
      }
      if (parts.length) return truncateToolText(parts.join('\n'));
    }
    try {
      return truncateToolText(JSON.stringify(result, null, 2));
    } catch {
      return String(result);
    }
  }
  return String(result);
}

function parseSseChunk(buffer: string): { events: CodexSseEvent[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const events: CodexSseEvent[] = [];

  for (const rawPart of parts) {
    const lines = rawPart.split('\n');
    let eventName = '';
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (eventName || dataLines.length > 0) {
      events.push({
        event: eventName || undefined,
        data: dataLines.join('\n'),
      });
    }
  }

  return { events, rest };
}

function safeJsonParse(value?: string): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildInput(prompt: string): CodexInputMessage[] {
  return [
    {
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: prompt,
        },
      ],
    },
  ];
}

function functionCallOutput(callId: string, output: string): CodexInputMessage[] {
  return [
    {
      type: 'function_call_output',
      call_id: callId,
      output,
    },
  ];
}

/**
 * The Codex API enforces tool names match `^[a-zA-Z0-9_-]+$`. Models
 * occasionally hallucinate names with dots, colons, slashes, or
 * spaces — and the API rejects the *next* request (status 400) that
 * echoes the bad name back as part of conversation history. Slugify
 * any non-allowed characters to `_` and collapse runs of `_`. This is
 * the LAST-RESORT belt; the primary fix for the most common
 * hallucination (`multi_tool_use.parallel`) is the expander below.
 */
function sanitizeToolName(rawName: string): string {
  const safe = rawName.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (safe && safe !== rawName) {
    logger.warn({ rawName, safe }, 'sanitized hallucinated tool name for Codex API regex');
  }
  return safe || 'unknown_tool';
}

/**
 * GPT models periodically emit a SYNTHETIC tool call named
 * `multi_tool_use.parallel` (or just `parallel`) when they want to run
 * multiple tools in one turn. This isn't a real tool — it's the
 * model's internal representation leaking through. The arguments
 * object has the shape:
 *
 *   { "tool_uses": [
 *       { "recipient_name": "functions.<real_tool>", "parameters": {...} },
 *       { "recipient_name": "functions.<real_tool_2>", "parameters": {...} }
 *     ] }
 *
 * The canonical fix (per the OpenAI community + the
 * openai_multi_tool_use_parallel_patch reference impl) is to detect
 * the synthetic call and expand it into N real tool calls before any
 * dispatch happens. This preserves the model's *intent* (parallel
 * execution of real tools) without losing a round trip to the
 * "unknown tool" error path, and keeps the system prompt unchanged.
 *
 * Falls through to the sanitizer + normal failure path if the
 * arguments don't decode cleanly — we never want this expander to
 * THROW and kill the whole turn.
 */
export function expandParallelHallucination(toolCalls: CodexFunctionCall[]): CodexFunctionCall[] {
  const expanded: CodexFunctionCall[] = [];
  let synthetic = 0;
  for (const call of toolCalls) {
    const name = call.name;
    const isParallel = name === 'multi_tool_use.parallel' || name === 'parallel';
    if (!isParallel) {
      expanded.push(call);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.arguments ?? '{}');
    } catch {
      // Couldn't decode — fall back to sanitizer-only behavior (push
      // through; the next-turn 400 protection still catches it).
      expanded.push(call);
      continue;
    }
    const toolUses = (parsed as { tool_uses?: unknown }).tool_uses;
    if (!Array.isArray(toolUses) || toolUses.length === 0) {
      expanded.push(call);
      continue;
    }
    const baseId = call.id ?? call.call_id ?? randomUUID();
    let kept = 0;
    for (let i = 0; i < toolUses.length; i++) {
      const entry = toolUses[i];
      if (!entry || typeof entry !== 'object') continue;
      const recipient = (entry as { recipient_name?: unknown }).recipient_name;
      const parameters = (entry as { parameters?: unknown }).parameters;
      if (typeof recipient !== 'string' || !recipient) continue;
      // Models prefix the real tool name with `functions.` in the
      // synthetic envelope — strip it so the dispatcher sees the
      // actual registered tool name.
      const realName = recipient.replace(/^functions\./, '');
      expanded.push({
        id: `${baseId}_p${i}`,
        call_id: `${baseId}_p${i}`,
        name: realName,
        arguments: typeof parameters === 'string'
          ? parameters
          : JSON.stringify(parameters ?? {}),
      });
      kept += 1;
    }
    if (kept > 0) {
      synthetic += 1;
    } else {
      // Decoded but the structure didn't yield any real calls; let
      // the next-turn path handle it.
      expanded.push(call);
    }
  }
  if (synthetic > 0) {
    logger.info(
      { synthetic, expandedTo: expanded.length, originalCount: toolCalls.length },
      'expanded multi_tool_use.parallel hallucination into real tool calls',
    );
  }
  return expanded;
}

function functionCallInput(toolCall: CodexFunctionCall): CodexInputMessage {
  const callId = toolCall.call_id ?? toolCall.id ?? randomUUID();
  const item: CodexInputMessage = {
    type: 'function_call',
    call_id: callId,
    name: sanitizeToolName(toolCall.name ?? 'unknown_tool'),
    arguments: toolCall.arguments ?? '{}',
    status: 'completed',
  };
  if (toolCall.id) {
    item.id = toolCall.id;
  }
  return item;
}

function resolveCodexModel(model?: string): string {
  if (!model) return DEFAULT_CODEX_MODEL;
  if (model.startsWith('gpt-5')) return model;
  return DEFAULT_CODEX_MODEL;
}

function formatCodexApiError(status: number, bodyText: string): string {
  const parsed = safeJsonParse(bodyText);
  const errorObject = parsed?.error;
  if (errorObject && typeof errorObject === 'object') {
    const message = (errorObject as Record<string, unknown>).message;
    const resetsAt = (errorObject as Record<string, unknown>).resets_at;
    if (typeof message === 'string' && message) {
      if (typeof resetsAt === 'number') {
        return `${message}. Reset at ${new Date(resetsAt * 1000).toISOString()}.`;
      }
      return message;
    }
  }

  const detail = parsed?.detail;
  if (typeof detail === 'string' && detail) {
    return detail;
  }

  return `Clementine's model backend request failed (HTTP ${status}).`;
}

async function performCodexRequest(
  request: RunRequest,
  input: CodexInputMessage[],
  callbacks?: AgentRuntimeCallbacks,
): Promise<CodexResponseResult> {
  await throwIfCancelled(callbacks);
  const tokens = getStoredCodexOAuthTokens();
  if (!tokens?.accessToken) {
    throw new CodexRuntimeError('No native Codex OAuth access token is available.');
  }

  // `prompt_cache_key` lets Codex re-use a cached prefix across calls
  // in the same session. The Codex backend ignores `previous_response_id`
  // (it enforces `store: false`), so this is the only token-cost lever
  // we have for multi-turn chains. Hermes does the same thing.
  const body: Record<string, unknown> = {
    model: resolveCodexModel(request.model),
    instructions: request.instructions || 'You are Clementine, a persistent executive assistant. Be concise, accurate, and action-oriented.',
    store: false,
    stream: true,
    input,
    tools: await createCodexToolDefinitions(),
  };
  if (request.sessionId) {
    body.prompt_cache_key = request.sessionId;
  }

  // Two reasons to want an abort handle:
  //   1) caller-driven cancellation via shouldCancel polling
  //   2) wall-clock budget exceeded
  // If either applies we wire the AbortController. wallClockTimer is
  // separate from cancelPoll so each cleans up independently in the
  // finally block.
  const wantsAbort = Boolean(callbacks?.shouldCancel) || typeof request.maxWallClockMs === 'number';
  const abortController = wantsAbort ? new AbortController() : undefined;
  let cancelPoll: ReturnType<typeof setInterval> | undefined;
  let wallClockTimer: ReturnType<typeof setTimeout> | undefined;
  let wallClockTimedOut = false;
	  if (abortController && callbacks?.shouldCancel) {
	    cancelPoll = setInterval(() => {
	      void Promise.resolve(callbacks.shouldCancel?.())
	        .then((cancelled) => {
	          if (cancelled) abortController.abort();
	        })
        .catch(() => undefined);
    }, 2000);
  }
  if (abortController && typeof request.maxWallClockMs === 'number' && request.maxWallClockMs > 0) {
    wallClockTimer = setTimeout(() => {
      wallClockTimedOut = true;
      abortController.abort();
    }, request.maxWallClockMs);
    // unref so a stray timer doesn't keep Node alive past shutdown.
    wallClockTimer.unref?.();
  }

  let response: Response;
  try {
    response = await fetch(CODEX_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': CODEX_USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: abortController?.signal,
      // Opt out of undici's keep-alive pool. After hours of daemon
      // uptime the pool fills with stale Cloudflare-edge IPs and
      // every reused connection times out at 10s. Fresh DNS + TCP
      // connect per call costs a few ms; the alternative is a
      // multi-hour outage of every chat run. Same fix as embeddings.
      keepalive: false,
    });
	  } catch (error) {
	    if (abortController?.signal.aborted) {
	      if (wallClockTimedOut) {
	        throw new CodexRuntimeError(
	          `Clementine's model backend exceeded the wall-clock budget of ${request.maxWallClockMs}ms and was aborted.`,
	        );
	      }
	      throw new AgentRuntimeCancelledError();
	    }
	    throw error;
	  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new CodexRuntimeError(formatCodexApiError(response.status, errorText), response.status);
  }

  if (!response.body) {
    throw new CodexRuntimeError('Clementine\'s model backend returned an empty response.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalText = '';
  let responseId: string | undefined;
  const toolCalls: CodexFunctionCall[] = [];

	  try {
	    while (true) {
	      await throwIfCancelled(callbacks);
	      let done: boolean;
	      let value: Uint8Array | undefined;
	      try {
	        const read = await reader.read();
	        done = read.done;
	        value = read.value;
	      } catch (error) {
	        if (abortController?.signal.aborted) {
	          if (wallClockTimedOut) {
	            throw new CodexRuntimeError(
	              `Clementine's model backend exceeded the wall-clock budget of ${request.maxWallClockMs}ms and was aborted mid-stream.`,
	            );
	          }
	          throw new AgentRuntimeCancelledError();
	        }
	        throw error;
	      }
	      if (done) break;
	      buffer += decoder.decode(value, { stream: true });
	      const parsed = parseSseChunk(buffer);
	      buffer = parsed.rest;

	      for (const event of parsed.events) {
	        const payload = safeJsonParse(event.data);
	        if (!payload) continue;
	        const type = payload.type;
	        responseId = extractResponseId(payload) ?? responseId;

	        if (type === 'response.output_text.delta') {
	          const delta = payload.delta;
	          if (typeof delta === 'string' && delta) {
	            finalText += delta;
	            if (callbacks?.onChunk) {
	              await callbacks.onChunk(delta);
	            }
	          }
	          continue;
	        }

	        if (type === 'response.output_item.done') {
	          const item = payload.item;
	          if (item && typeof item === 'object') {
	            const typedItem = item as Record<string, unknown>;
	            if (typedItem.type === 'function_call') {
	              toolCalls.push({
	                id: typeof typedItem.id === 'string' ? typedItem.id : undefined,
	                call_id: typeof typedItem.call_id === 'string' ? typedItem.call_id : undefined,
	                name: typeof typedItem.name === 'string' ? typedItem.name : undefined,
	                arguments: typeof typedItem.arguments === 'string'
	                  ? typedItem.arguments
	                  : typedItem.arguments !== undefined
	                    ? JSON.stringify(typedItem.arguments)
	                    : undefined,
	              });
	            }
	          }
	          continue;
	        }

	        if (type === 'response.completed') {
	          if (callbacks?.onText && finalText.trim()) {
	            await callbacks.onText(finalText.trim());
	          }
	        }
	      }
	    }
	  } finally {
	    if (cancelPoll) clearInterval(cancelPoll);
	    if (wallClockTimer) clearTimeout(wallClockTimer);
	  }

  return {
    text: finalText.trim(),
    toolCalls: expandParallelHallucination(toolCalls),
    responseId,
  };
}

function extractResponseId(payload: Record<string, unknown>): string | undefined {
  const response = payload.response;
  if (response && typeof response === 'object') {
    const id = (response as Record<string, unknown>).id;
    if (typeof id === 'string') return id;
  }
  const responseId = payload.response_id;
  if (typeof responseId === 'string') return responseId;
  return undefined;
}

function truncateToolOutput(value: string, maxChars = 18_000): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === 'string') return truncateToolOutput(value);
  try {
    return truncateToolOutput(JSON.stringify(value, null, 2));
  } catch {
    return truncateToolOutput(String(value));
  }
}

function parseToolArguments(toolCall: CodexFunctionCall): Record<string, unknown> {
  const parsed = safeJsonParse(toolCall.arguments);
  return parsed ?? {};
}

function toolActivityFor(toolCall: CodexFunctionCall): ToolActivity {
  return {
    toolName: toolCall.name ?? 'unknown_tool',
    input: parseToolArguments(toolCall),
  };
}

function describeToolCall(toolCall?: CodexFunctionCall): string {
  if (!toolCall?.arguments) return 'Approval required before I continue.';
  const parsed = safeJsonParse(toolCall.arguments);
  const action = typeof parsed?.action === 'string' ? parsed.action : 'Unknown action';
  const reason = typeof parsed?.reason === 'string' ? parsed.reason : 'No reason provided';
  if (toolCall.name === 'request_destructive_action') {
    return `Approval required: ${action}. Reason: ${reason}`;
  }
  return `Approval required before running ${toolCall.name ?? 'tool'} with input: ${JSON.stringify(parsed ?? {}, null, 2)}`;
}

function isTransientCodexStatus(status?: number): boolean {
  return status === 408 || status === 409 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CodexNativeRuntime implements AgentRuntime {
  private readonly approvals = new ApprovalStore();

  listPendingApprovals(): PendingApproval[] {
    return this.approvals.listPending();
  }

  private notifyApprovalPending(approval: PendingApproval, toolCall?: CodexFunctionCall): void {
    addNotification({
      id: `${Date.now()}-approval-${approval.id}`,
      kind: 'approval',
      title: `Approval required: ${approval.toolName}`,
      body: describeToolCall(toolCall),
      createdAt: new Date().toISOString(),
      read: false,
      metadata: {
        approvalId: approval.id,
        sessionId: approval.sessionId,
        toolName: approval.toolName,
        userId: approval.userId,
        channel: approval.channel,
        discordUserId: approval.channel?.startsWith('discord:') ? approval.userId : undefined,
      },
    });
  }

  private async performWithRefresh(
    request: RunRequest,
    input: CodexInputMessage[],
    callbacks?: AgentRuntimeCallbacks,
  ): Promise<CodexResponseResult> {
    let refreshed = false;
    let transientAttempts = 0;

    while (true) {
      try {
        return await performCodexRequest(request, input, callbacks);
      } catch (error) {
        if (!refreshed && error instanceof CodexRuntimeError && error.status === 401) {
          const refreshResult = await refreshStoredNativeOAuth();
          if (refreshResult.ok) {
            refreshed = true;
            continue;
          }
          // Refresh failed. The previous behavior was to throw and let
          // the caller swallow the stack trace into a log line —
          // 35-in-a-row 401s went by without a user-visible signal.
          // Emit one daily-bucketed notification so the user has a
          // clear "re-authenticate" pointer the first time they
          // open the dashboard / check Discord.
          notifyCodexAuthExpired(refreshResult.message);
        }
        if (
          error instanceof CodexRuntimeError &&
          isTransientCodexStatus(error.status) &&
          transientAttempts < 3
        ) {
          const delayMs = 750 * 2 ** transientAttempts;
          transientAttempts += 1;
          logger.warn({ status: error.status, attempt: transientAttempts, delayMs }, 'Retrying transient native Codex request failure');
          await sleep(delayMs);
          continue;
        }
        throw error;
      }
    }
  }

  private async executeToolCall(
    request: RunRequest,
    sessionId: string,
    toolCall: CodexFunctionCall,
    callbacks?: AgentRuntimeCallbacks,
	  ): Promise<{ output?: string; pendingApprovalId?: string }> {
	    await throwIfCancelled(callbacks);
	    const name = toolCall.name;
    if (!name) return { output: 'Tool call is missing a name.' };

    // MCP tools live behind the namespace shim, not in the SDK tool
    // map. Route them through the shim, apply the unified approval
    // taxonomy ourselves (the shim doesn't expose a per-call
    // needsApproval hook), and stream the result back into the Codex
    // turn the same way SDK tools flow.
    if (isMcpToolName(name)) {
      return this.executeMcpToolCall(request, sessionId, toolCall, callbacks);
    }

    const tool = (await createToolMap()).get(name);
    if (!tool) return { output: `Tool "${name}" is not available in this Clementine runtime.` };

    const args = parseToolArguments(toolCall);
    const runContext = {
      context: {
        sessionId,
        userId: request.userId,
        channel: request.channel,
      } satisfies RuntimeContextValue,
    } as any;

    if (callbacks?.onToolActivity) {
      await callbacks.onToolActivity(toolActivityFor(toolCall));
    }

    // Capture the taxonomy classification + the reason the SDK tool
    // is asking for approval so we have a single observable shape for
    // every call (local SDK tools + MCP), regardless of which approval
    // function they wired in.
    const kind = classifyTool(name, { args });
    const needsApproval = await tool.needsApproval(runContext, args, toolCall.call_id ?? toolCall.id);
    if (needsApproval) {
      const approvalId = randomUUID();
      const pendingApproval: PendingApproval = {
        id: approvalId,
        sessionId,
        agentName: ASSISTANT_NAME,
        toolName: name,
        userId: request.userId,
        channel: request.channel,
        createdAt: new Date().toISOString(),
        status: 'pending',
        state: JSON.stringify({
          request,
          toolCall,
        } satisfies StoredCodexApprovalState),
      };
      this.approvals.add(pendingApproval);
      this.notifyApprovalPending(pendingApproval, toolCall);
      recordPendingApproval({ sessionId, toolName: name, kind, args, approvalId, mcp: false });
      return { pendingApprovalId: approvalId };
    }

    const finishEvent = beginToolEvent({
      sessionId,
      toolName: name,
      kind,
      approvalReason: 'auto',
      args,
      mcp: false,
    });
	    try {
	      await throwIfCancelled(callbacks);
	      const callId = toolCall.call_id ?? toolCall.id ?? randomUUID();
	      const output = await tool.invoke(runContext, toolCall.arguments ?? '{}', {
        toolCall: {
          id: toolCall.id ?? callId,
          call_id: callId,
          type: 'function_call',
          name,
          arguments: toolCall.arguments ?? '{}',
        } as any,
	      });
	      await throwIfCancelled(callbacks);
	      finishEvent('success');
	      return { output: stringifyToolOutput(output) };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn({ err: error, tool: name }, 'Native Codex tool execution failed');
      finishEvent('error', msg);
      return { output: `Tool "${name}" failed: ${msg}` };
    }
  }

  /**
   * Dispatch a `<server>__<tool>` MCP function-call. The local tool
   * map doesn't have it; the namespace shim does. Approval is gated
   * by the unified taxonomy (same `decideToolApproval` as everything
   * else), so YOLO mode auto-runs a DataForSEO query, strict pauses
   * a Hostinger create_domain, etc.
   */
  private async executeMcpToolCall(
    request: RunRequest,
    sessionId: string,
    toolCall: CodexFunctionCall,
    callbacks?: AgentRuntimeCallbacks,
  ): Promise<{ output?: string; pendingApprovalId?: string }> {
    const name = toolCall.name!;
    const args = parseToolArguments(toolCall);

    if (callbacks?.onToolActivity) {
      await callbacks.onToolActivity(toolActivityFor(toolCall));
    }

    const decision = decideToolApproval({
      sessionId,
      toolName: name,
      args,
    });
    if (decision.needsApproval) {
      const approvalId = randomUUID();
      const pendingApproval: PendingApproval = {
        id: approvalId,
        sessionId,
        agentName: ASSISTANT_NAME,
        toolName: name,
        userId: request.userId,
        channel: request.channel,
        createdAt: new Date().toISOString(),
        status: 'pending',
        state: JSON.stringify({
          request,
          toolCall,
        } satisfies StoredCodexApprovalState),
      };
      this.approvals.add(pendingApproval);
      this.notifyApprovalPending(pendingApproval, toolCall);
      recordPendingApproval({
        sessionId,
        toolName: name,
        kind: decision.kind,
        args,
        approvalId,
        mcp: true,
      });
      return { pendingApprovalId: approvalId };
    }

    const finishEvent = beginToolEvent({
      sessionId,
      toolName: name,
      kind: decision.kind,
      approvalReason: decision.reason,
      args,
      mcp: true,
    });
    try {
      await throwIfCancelled(callbacks);
      const output = await this.invokeMcpToolByName(name, args);
      await throwIfCancelled(callbacks);
      finishEvent('success');
      return { output };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn({ err: error, tool: name }, 'MCP tool execution failed (Codex runtime)');
      finishEvent('error', msg);
      return { output: `MCP tool "${name}" failed: ${msg}` };
    }
  }

  private async invokeMcpToolByName(name: string, args: Record<string, unknown>): Promise<string> {
    const shim = getOrCreateConfiguredMcpServers();
    // The shim itself routes by namespaced name; we don't unparse the
    // `<server>__<tool>` prefix here.
    const result = await shim.callTool(name, args ?? null);
    return stringifyMcpResult(result);
  }

  private async executeApprovedToolCall(
    request: RunRequest,
    sessionId: string,
    toolCall: CodexFunctionCall,
  ): Promise<string> {
    const name = toolCall.name;
    if (!name) return 'Tool call is missing a name.';

    const args = parseToolArguments(toolCall);
    const kind = classifyTool(name, { args });

    // Approved MCP call — same dispatch path as the live executor.
    if (isMcpToolName(name)) {
      const finish = beginToolEvent({
        sessionId,
        toolName: name,
        kind,
        approvalReason: 'approved-after-prompt',
        args,
        mcp: true,
      });
      try {
        const out = await this.invokeMcpToolByName(name, args);
        finish('success');
        return out;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        finish('error', msg);
        throw error;
      }
    }

    const tool = (await createToolMap()).get(name);
    if (!tool) return `Tool "${name}" is not available in this Clementine runtime.`;

    const runContext = {
      context: {
        sessionId,
        userId: request.userId,
        channel: request.channel,
      } satisfies RuntimeContextValue,
    } as any;

    const finish = beginToolEvent({
      sessionId,
      toolName: name,
      kind,
      approvalReason: 'approved-after-prompt',
      args,
      mcp: false,
    });
    try {
      const callId = toolCall.call_id ?? toolCall.id ?? randomUUID();
      const output = await tool.invoke(runContext, toolCall.arguments ?? '{}', {
        toolCall: {
          id: toolCall.id ?? callId,
          call_id: callId,
          type: 'function_call',
          name,
          arguments: toolCall.arguments ?? '{}',
        } as any,
      });
      finish('success');
      return stringifyToolOutput(output);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn({ err: error, tool: name }, 'Approved native Codex tool execution failed');
      finish('error', msg);
      return `Tool "${name}" failed after approval: ${msg}`;
    }
  }

  private async runToolLoop(
    request: RunRequest,
    sessionId: string,
    input: CodexInputMessage[],
    callbacks?: AgentRuntimeCallbacks,
	  ): Promise<RunResult> {
	    let currentInput = [...input];
	    let latestResult: CodexResponseResult | null = null;
	    let toolCallsTotal = 0;

	    // Maximum back-and-forth turns of (model → tool calls → tool outputs
	    // → model). One turn = one model completion + the tool dispatches
	    // it asks for. Default 75 — matches Hermes' "assistant doing real
	    // work" tier (their default is 90; we trim slightly because our
	    // orchestrator has sub-agent handoffs that each get their own
	    // budget). The OpenAI Agents SDK default of 10 is unusably tight
	    // for any multi-tool task.
	    //
	    // Override via env: `CLEMENTINE_MAX_TOOL_TURNS=120 npm run daemon`.
	    const maxTurns = Math.max(
	      1,
	      parseInt(process.env.CLEMENTINE_MAX_TOOL_TURNS || '', 10) || 75,
	    );
	    for (let turn = 0; turn < maxTurns; turn++) {
	      await throwIfCancelled(callbacks);
	      latestResult = await this.performWithRefresh(
        { ...request, sessionId },
        currentInput,
        callbacks,
      );

      if (latestResult.toolCalls.length === 0) {
        const finalText = latestResult.text || ASSISTANT_PAUSED_PLACEHOLDER;
        if (callbacks?.onText) {
          await callbacks.onText(finalText);
        }
        return {
          text: finalText,
          sessionId,
          stoppedReason: latestResult.text ? 'success' : 'error',
          turnsUsed: turn + 1,
          raw: latestResult,
        };
      }

	      const nextInput: CodexInputMessage[] = [...currentInput];
	      for (const toolCall of latestResult.toolCalls) {
	        await throwIfCancelled(callbacks);
	        toolCallsTotal++;
	        const callId = toolCall.call_id ?? toolCall.id;
        if (!callId) {
          const fallbackCallId = randomUUID();
          nextInput.push(functionCallInput({ ...toolCall, call_id: fallbackCallId }));
          nextInput.push(...functionCallOutput(fallbackCallId, 'Tool call is missing a call_id.'));
          continue;
        }

        nextInput.push(functionCallInput(toolCall));
        const execution = await this.executeToolCall(request, sessionId, toolCall, callbacks);
        if (execution.pendingApprovalId) {
          const approval = this.approvals.get(execution.pendingApprovalId);
          if (approval) {
            const state = safeJsonParse(approval.state) as StoredCodexApprovalState | null;
            if (state) {
              state.inputHistory = nextInput;
              this.approvals.updateStatus(approval.id, 'pending', JSON.stringify(state));
            }
          }
          return {
            text: `Approval required before I continue. Pending approval ID: ${execution.pendingApprovalId}`,
            sessionId,
            pendingApprovalId: execution.pendingApprovalId,
            stoppedReason: 'pending-approval',
            turnsUsed: turn + 1,
            raw: latestResult,
          };
        }

        nextInput.push(...functionCallOutput(callId, execution.output ?? 'Tool completed with no output.'));
      }

      currentInput = nextInput;
    }

    // Hit the tool-turn cap. Instead of returning a static "ran out of
    // cycles" string, do what Hermes does: run ONE grace turn with an
    // injected budget-exhausted notice that asks the model to summarize
    // what it accomplished and what's pending. The model produces a real
    // recap + an explicit "continue?" prompt instead of a dead-end error.
    //
    // The grace turn is forbidden from calling tools — we override the
    // tools list to empty so the model can only respond with text. This
    // is the Hermes `_budget_grace_call` pattern, simplified.
    recordToolEvent({
      at: new Date().toISOString(),
      sessionId,
      toolName: '__runtime__',
      kind: 'execute',
      phase: 'error',
      outcome: 'error',
      errorMessage: `stopped at max tool-call turns (${maxTurns}) — running grace turn`,
    });

    const graceText = await this.runGraceTurn(request, sessionId, currentInput, maxTurns, toolCallsTotal, callbacks)
      .catch((err) => {
        logger.warn({ err }, 'grace turn failed; falling back to static message');
        return null;
      });

    const finalText = graceText
      || `Clementine reached her tool-call budget (${maxTurns} turns, ${toolCallsTotal} tools fired) before finishing. The work so far is in your vault. Reply "continue" to pick up where she left off.`;

    if (callbacks?.onText) {
      await callbacks.onText(finalText);
    }

    return {
      text: finalText,
      sessionId,
      stoppedReason: 'max-turns-with-grace',
      turnsUsed: maxTurns,
      raw: latestResult,
    };
  }

  /**
   * Run ONE final model call after the tool-turn cap has been hit.
   * No tools available — the model can only produce text. Inject a
   * notice telling it the budget is exhausted and ask it to:
   *
   *   1. Summarize what it accomplished
   *   2. Name what's still pending
   *   3. End with an explicit "continue?" prompt
   *
   * Streams chunks to the caller via `onChunk` exactly like a normal
   * turn so the user sees the summary appear in real time instead of
   * waiting for the whole grace turn.
   */
  private async runGraceTurn(
    request: RunRequest,
    sessionId: string,
    input: CodexInputMessage[],
    maxTurns: number,
    toolCallsFired: number,
    callbacks?: AgentRuntimeCallbacks,
  ): Promise<string | null> {
    const graceNotice: CodexInputMessage = {
      type: 'message',
      role: 'developer',
      content: [
        {
          type: 'input_text',
          text: [
            `You have reached your tool-call budget for this turn (${maxTurns} model→tool cycles, ${toolCallsFired} total tools fired).`,
            `STOP calling tools. Do NOT request more tools.`,
            `Write a short response that:`,
            `  1. Summarizes what you accomplished in this run (be specific — name the tools/files/queries that succeeded).`,
            `  2. Lists what's still pending or unfinished.`,
            `  3. Ends with: "Want me to continue?" so the user has a clear path to resume.`,
            `If you produced any artifacts (files, notes, plans, drafts), reference them by path/title so the user can find them.`,
          ].join('\n'),
        },
      ],
    } as unknown as CodexInputMessage;

    // The grace turn replaces the tool surface with an empty list so
    // the model has no choice but to write text. We construct the
    // body manually instead of calling performCodexRequest so we can
    // override `tools` cleanly.
    const tokens = getStoredCodexOAuthTokens();
    if (!tokens?.accessToken) return null;

    const graceInput = [...input, graceNotice];
    const body: Record<string, unknown> = {
      model: resolveCodexModel(request.model),
      instructions: request.instructions
        || 'You are Clementine, a persistent executive assistant. Be concise, accurate, and action-oriented.',
      store: false,
      stream: true,
      input: graceInput,
      tools: [], // critical — no tools available on the grace turn
    };
    if (sessionId) body.prompt_cache_key = sessionId;

    let response: Response;
    try {
      response = await fetch(CODEX_RESPONSES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': CODEX_USER_AGENT,
        },
        body: JSON.stringify(body),
        // See note above on the main fetch site — avoid the long-
        // uptime keep-alive pool poisoning that breaks chat.
        keepalive: false,
      });
    } catch (err) {
      logger.warn({ err }, 'grace turn fetch failed');
      return null;
    }

    if (!response.ok || !response.body) {
      logger.warn({ status: response.status }, 'grace turn returned non-OK');
      return null;
    }

    // Reuse the same SSE parser the main loop uses. We don't need to
    // track tool calls (the model has none); we just collect text.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulated = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseChunk(buffer);
      buffer = rest;
      for (const evt of events) {
        if (!evt.data) continue;
        const payload = safeJsonParse(evt.data) as
          | { type?: string; delta?: string; response?: { output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> } }
          | null;
        if (!payload) continue;
        if (payload.type === 'response.output_text.delta' && typeof payload.delta === 'string') {
          accumulated += payload.delta;
          if (callbacks?.onChunk) {
            await callbacks.onChunk(payload.delta);
          }
        } else if (payload.type === 'response.completed' && payload.response?.output) {
          // Defensive: if streaming deltas were missed for any reason,
          // reconstruct the final text from the completed output.
          if (!accumulated) {
            for (const item of payload.response.output) {
              if (item.type === 'message' && Array.isArray(item.content)) {
                for (const part of item.content) {
                  if (part.type === 'output_text' && typeof part.text === 'string') {
                    accumulated += part.text;
                  }
                }
              }
            }
          }
        }
      }
    }

    return accumulated.trim() || null;
  }

  async resolveApproval(approvalId: string, approved: boolean): Promise<ApprovalResolutionResult> {
    const approval = this.approvals.get(approvalId);
    if (!approval) {
      throw new Error(`Approval ${approvalId} not found.`);
    }

    let outcome: ApprovalResolutionResult;
    if (!approved) {
      this.approvals.updateStatus(approvalId, 'rejected', approval.state);
      outcome = {
        approvalId,
        status: 'rejected',
        sessionId: approval.sessionId,
        text: `Approval ${approvalId} rejected.`,
      };
    } else {
      const state = safeJsonParse(approval.state) as StoredCodexApprovalState | null;
      if (!state?.request || !state.toolCall) {
        throw new Error(`Approval ${approvalId} has no resumable native Codex state.`);
      }
      const callId = state.toolCall.call_id ?? state.toolCall.id;
      if (!callId) {
        throw new Error(`Approval ${approvalId} is missing a tool call id.`);
      }
      this.approvals.updateStatus(approvalId, 'approved', approval.state);
      const execution = await this.executeApprovedToolCall(state.request, approval.sessionId, state.toolCall);
      const inputHistory = state.inputHistory?.length
        ? [...state.inputHistory]
        : [...buildInput(state.request.prompt), functionCallInput(state.toolCall)];
      const resumed = await this.runToolLoop(
        state.request,
        approval.sessionId,
        [...inputHistory, ...functionCallOutput(callId, execution)],
      );
      outcome = {
        approvalId,
        status: 'approved',
        sessionId: approval.sessionId,
        text: resumed.text,
      };
    }

    addNotification({
      id: `${Date.now()}-approval-${approvalId}-${outcome.status}`,
      kind: 'approval',
      title: `Approval ${outcome.status}: ${approval.toolName}`,
      body: outcome.text,
      createdAt: new Date().toISOString(),
      read: false,
      metadata: {
        approvalId,
        sessionId: approval.sessionId,
        toolName: approval.toolName,
        userId: approval.userId,
        channel: approval.channel,
        discordUserId: approval.channel?.startsWith('discord:') ? approval.userId : undefined,
      },
    });

    return outcome;
  }

  async run(request: RunRequest, callbacks?: AgentRuntimeCallbacks): Promise<RunResult> {
    const sessionId = request.sessionId ?? randomUUID();

    try {
      return await this.runToolLoop(request, sessionId, buildInput(request.prompt), callbacks);
    } catch (error) {
      logger.error({ err: error, sessionId }, 'Native Codex run failed');
      throw error;
    }
  }
}
