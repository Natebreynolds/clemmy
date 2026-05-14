import { randomUUID } from 'node:crypto';
import pino from 'pino';
import type { ApprovalResolutionResult, PendingApproval, RunRequest, RunResult } from '../types.js';
import { AgentRuntimeCancelledError, type AgentRuntime, type AgentRuntimeCallbacks } from './provider.js';
import { ApprovalStore } from './approval-store.js';
import { addNotification } from './notifications.js';
import { ASSISTANT_NAME } from '../config.js';
import { getStoredCodexOAuthTokens, refreshStoredNativeOAuth } from './auth-store.js';
import { getCoreTools } from '../tools/registry.js';
import type { RuntimeContextValue, ToolActivity } from '../types.js';

const logger = pino({ name: 'clementine-next.codex-native-runtime' });

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CODEX_USER_AGENT = 'Codex/0.118.0';
const DEFAULT_CODEX_MODEL = 'gpt-5.4';

interface CodexSseEvent {
  event?: string;
  data?: string;
}

interface CodexFunctionCall {
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

async function throwIfCancelled(callbacks?: AgentRuntimeCallbacks): Promise<void> {
  if (await callbacks?.shouldCancel?.()) {
    throw new AgentRuntimeCancelledError();
  }
}

function createCodexToolDefinitions() {
  return getCoreTools()
    .filter((tool) => tool.type === 'function')
    .map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: tool.strict,
    }));
}

function createToolMap() {
  return new Map(getCoreTools()
    .filter((tool) => tool.type === 'function')
    .map((tool) => [tool.name, tool]));
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

function functionCallInput(toolCall: CodexFunctionCall): CodexInputMessage {
  const callId = toolCall.call_id ?? toolCall.id ?? randomUUID();
  const item: CodexInputMessage = {
    type: 'function_call',
    call_id: callId,
    name: toolCall.name ?? 'unknown_tool',
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

  return `Codex request failed (${status}).`;
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

  const body = {
    model: resolveCodexModel(request.model),
    instructions: request.instructions || 'You are Clementine, a persistent executive assistant. Be concise, accurate, and action-oriented.',
    store: false,
    stream: true,
    input,
    tools: createCodexToolDefinitions(),
  };

  const abortController = callbacks?.shouldCancel ? new AbortController() : undefined;
  let cancelPoll: ReturnType<typeof setInterval> | undefined;
	  if (abortController && callbacks?.shouldCancel) {
	    cancelPoll = setInterval(() => {
	      void Promise.resolve(callbacks.shouldCancel?.())
	        .then((cancelled) => {
	          if (cancelled) abortController.abort();
	        })
        .catch(() => undefined);
    }, 2000);
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
    });
	  } catch (error) {
	    if (abortController?.signal.aborted) {
	      throw new AgentRuntimeCancelledError();
	    }
	    throw error;
	  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new CodexRuntimeError(formatCodexApiError(response.status, errorText), response.status);
  }

  if (!response.body) {
    throw new CodexRuntimeError('Codex returned an empty response body.');
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
	  }

  return {
    text: finalText.trim(),
    toolCalls,
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

    const tool = createToolMap().get(name);
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
      return { pendingApprovalId: approvalId };
    }

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
	      return { output: stringifyToolOutput(output) };
    } catch (error) {
      logger.warn({ err: error, tool: name }, 'Native Codex tool execution failed');
      return { output: `Tool "${name}" failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private async executeApprovedToolCall(
    request: RunRequest,
    sessionId: string,
    toolCall: CodexFunctionCall,
  ): Promise<string> {
    const name = toolCall.name;
    if (!name) return 'Tool call is missing a name.';

    const tool = createToolMap().get(name);
    if (!tool) return `Tool "${name}" is not available in this Clementine runtime.`;

    const runContext = {
      context: {
        sessionId,
        userId: request.userId,
        channel: request.channel,
      } satisfies RuntimeContextValue,
    } as any;

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
      return stringifyToolOutput(output);
    } catch (error) {
      logger.warn({ err: error, tool: name }, 'Approved native Codex tool execution failed');
      return `Tool "${name}" failed after approval: ${error instanceof Error ? error.message : String(error)}`;
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

	    for (let turn = 0; turn < 10; turn++) {
	      await throwIfCancelled(callbacks);
	      latestResult = await this.performWithRefresh(
        { ...request, sessionId },
        currentInput,
        callbacks,
      );

      if (latestResult.toolCalls.length === 0) {
        const finalText = latestResult.text || 'Codex returned no final message.';
        if (callbacks?.onText) {
          await callbacks.onText(finalText);
        }
        return {
          text: finalText,
          sessionId,
          raw: latestResult,
        };
      }

	      const nextInput: CodexInputMessage[] = [...currentInput];
	      for (const toolCall of latestResult.toolCalls) {
	        await throwIfCancelled(callbacks);
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
            raw: latestResult,
          };
        }

        nextInput.push(...functionCallOutput(callId, execution.output ?? 'Tool completed with no output.'));
      }

      currentInput = nextInput;
    }

    return {
      text: latestResult?.text || 'Stopped after the maximum native tool-call turns.',
      sessionId,
      raw: latestResult,
    };
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
