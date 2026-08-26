import { randomUUID } from 'node:crypto';
import { Agent, Runner, setDefaultOpenAIKey } from '@openai/agents';
import { ASSISTANT_NAME, MODELS, OPENAI_API_KEY } from '../config.js';
import type {
  ApprovalResolutionResult,
  PendingApproval,
  RunRequest,
  RunResult,
  RuntimeContextValue,
  ToolActivity,
} from '../types.js';
import { AgentRuntimeCancelledError, type AgentRuntime, type AgentRuntimeCallbacks } from './provider.js';
import { ApprovalStore } from './approval-store.js';
import { addNotification } from './notifications.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseToolInput(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    if (!value.trim()) return {};
    try {
      const parsed = JSON.parse(value);
      return asRecord(parsed) ?? { value };
    } catch {
      return { value };
    }
  }

  return asRecord(value) ?? {};
}

function runItemToJson(item: unknown): Record<string, unknown> | undefined {
  const toJSON = asRecord(item)?.toJSON;
  if (typeof toJSON !== 'function') return undefined;

  try {
    return asRecord(toJSON.call(item));
  } catch {
    return undefined;
  }
}

function toolActivityFromRunItem(item: unknown): ToolActivity | null {
  const itemRecord = asRecord(item);
  const jsonRecord = runItemToJson(item);
  const rawItem = asRecord(itemRecord?.rawItem) ?? asRecord(jsonRecord?.rawItem);
  const itemType = typeof itemRecord?.type === 'string'
    ? itemRecord.type
    : typeof jsonRecord?.type === 'string'
      ? jsonRecord.type
      : '';
  const rawType = typeof rawItem?.type === 'string' ? rawItem.type : '';
  const toolName = typeof rawItem?.name === 'string'
    ? rawItem.name
    : typeof itemRecord?.name === 'string'
      ? itemRecord.name
      : rawType || itemType || 'tool';

  const isToolCall =
    itemType === 'tool_call_item' ||
    itemType === 'tool_approval_item' ||
    itemType === 'handoff_call_item' ||
    rawType === 'function_call' ||
    rawType === 'hosted_tool_call' ||
    rawType === 'computer_call';

  if (!isToolCall) return null;

  return {
    toolName,
    input: parseToolInput(rawItem?.arguments ?? rawItem?.input ?? rawItem?.action ?? itemRecord?.input),
  };
}

export class OpenAIRuntime implements AgentRuntime {
  private readonly runner: Runner;
  private readonly approvals = new ApprovalStore();
  constructor() {
    if (OPENAI_API_KEY) {
      setDefaultOpenAIKey(OPENAI_API_KEY);
    }

    this.runner = new Runner({
      workflowName: 'clementine-next',
      groupId: 'clementine',
    });
    // This compatibility runtime is model-only. Pending SDK RunState rows from
    // older builds carry no authority in the shared host kernel, so preserve
    // their opaque evidence but remove them from the executable queue.
    this.approvals.retirePending();
  }

  private async createAgent(request: RunRequest): Promise<Agent<RuntimeContextValue>> {
    // Direct SDK execution is retained only for model text (for example the
    // controller's strict JSON decisions). The shared host harness is the
    // sole executable tool and handoff owner.
    return new Agent<RuntimeContextValue>({
      name: ASSISTANT_NAME,
      instructions:
        request.instructions ||
        'You are Clementine, a persistent executive assistant. Be concise, accurate, and action-oriented.',
      model: request.model || MODELS.primary,
      tools: [],
      handoffs: [],
    });
  }

  listPendingApprovals(): PendingApproval[] {
    return this.approvals.listPending();
  }

  private notifyApprovalResolved(result: ApprovalResolutionResult, approval: PendingApproval): void {
    addNotification({
      id: `${Date.now()}-approval-${result.approvalId}-${result.status}`,
      kind: 'approval',
      title: `Approval ${result.status}: ${approval.toolName}`,
      body: result.text,
      createdAt: new Date().toISOString(),
      read: false,
      metadata: {
        approvalId: result.approvalId,
        sessionId: result.sessionId,
        toolName: approval.toolName,
        userId: approval.userId,
        channel: approval.channel,
        discordUserId: approval.channel?.startsWith('discord:') ? approval.userId : undefined,
      },
    });
  }

  async resolveApproval(approvalId: string, approved: boolean): Promise<ApprovalResolutionResult> {
    const approval = this.approvals.get(approvalId);
    if (!approval) {
      throw new Error(`Approval ${approvalId} not found.`);
    }

    if (approval.status === 'pending') {
      this.approvals.updateStatus(approvalId, 'rejected');
    }
    const outcome: ApprovalResolutionResult = {
      approvalId,
      status: 'rejected',
      sessionId: approval.sessionId,
      text: approved
        ? `Legacy approval ${approvalId} was retired and was not executed. Re-submit the action through Clementine's shared harness so it can receive current authority.`
        : `Approval ${approvalId} rejected. Its legacy runtime state was not executed.`,
    };
    this.notifyApprovalResolved(outcome, approval);
    return outcome;
  }

	  async run(request: RunRequest, callbacks?: AgentRuntimeCallbacks): Promise<RunResult> {
	    if (await callbacks?.shouldCancel?.()) {
	      throw new AgentRuntimeCancelledError();
	    }
	    const agent = await this.createAgent(request);

    const context: RuntimeContextValue = {
      sessionId: request.sessionId ?? randomUUID(),
      userId: request.userId,
      channel: request.channel,
    };

      // Stream when the caller subscribed to text, reasoning, or tool events.
      // Falls back to non-streaming when neither is subscribed — keeps
      // the simpler path for callers that don't care about deltas.
      const wantsStream = Boolean(callbacks?.onChunk || callbacks?.onReasoning || callbacks?.onToolActivity);

      const result = wantsStream
        ? await this.runStreamed(agent, request.prompt, context, callbacks)
        : await this.runner.run(agent, request.prompt, {
            context,
            maxTurns: 12,
          });

	    if (await callbacks?.shouldCancel?.()) {
	      throw new AgentRuntimeCancelledError();
	    }
    const text = typeof result.finalOutput === 'string' ? result.finalOutput : JSON.stringify(result.finalOutput);

    if (result.interruptions[0]) {
      return {
        text: 'A tool request from the retired direct runtime was not started. Re-submit the work through Clementine\'s shared harness.',
        sessionId: context.sessionId,
        stoppedReason: 'blocked',
        raw: result,
      };
    }

    if (callbacks?.onText) {
      await callbacks.onText(text);
    }

    return {
      text,
      sessionId: context.sessionId,
      raw: result,
    };
  }

  /**
   * Streaming variant of runner.run that fires per-delta callbacks.
   *
   * Iterates the SDK's StreamedRunResult and dispatches:
   *   - raw_model_stream_event of type 'output_text_delta' → onChunk(delta)
   *   - run_item_stream_event of name 'reasoning_item_created' →
   *     onReasoning(joined text) + addRunEvent for the run timeline
   *
   * After iteration, awaits completion so callers can read finalOutput
   * and interruptions the same way as the non-streaming path.
   *
   * Errors during streaming are surfaced via result.error — we rethrow
   * so the outer run() error path handles it identically.
   */
  private async runStreamed(
    agent: Agent<RuntimeContextValue>,
    input: string,
    context: RuntimeContextValue,
    callbacks?: AgentRuntimeCallbacks,
  ) {
    const streamed = await this.runner.run(agent, input, {
      context,
      maxTurns: 12,
      stream: true,
    });

    const emittedToolKeys = new Set<string>();

    for await (const event of streamed) {
      // raw_model_stream_event = wraps a provider-level StreamEvent
      if (event.type === 'raw_model_stream_event') {
        const data = event.data as { type?: string; delta?: string };
        if (data.type === 'output_text_delta' && typeof data.delta === 'string' && data.delta.length > 0) {
          if (callbacks?.onChunk) {
            try { await callbacks.onChunk(data.delta); } catch { /* never let consumer errors abort the stream */ }
          }
        }
        continue;
      }

      // run_item_stream_event = high-level item lifecycle (messages,
      // tool calls, reasoning, handoffs). We capture tool starts and
      // reasoning here so channel UIs can show actual progress.
      if (event.type === 'run_item_stream_event') {
        if (callbacks?.onToolActivity && (event.name === 'tool_called' || event.name === 'tool_approval_requested')) {
          const activity = toolActivityFromRunItem(event.item);
          if (activity) {
            const key = `${activity.toolName}:${JSON.stringify(activity.input)}`;
            if (!emittedToolKeys.has(key)) {
              emittedToolKeys.add(key);
              try { await callbacks.onToolActivity(activity); } catch { /* tolerate consumer errors */ }
            }
          }
        }

        if (event.name === 'reasoning_item_created') {
          const item = event.item as { rawItem?: { content?: Array<{ text?: string }> } };
          const chunks = item.rawItem?.content ?? [];
          const text = chunks.map((c) => c.text ?? '').filter(Boolean).join('\n').trim();
          if (text) {
            if (callbacks?.onReasoning) {
              try { await callbacks.onReasoning(text); } catch { /* tolerate consumer errors */ }
            }
          }
        }
      }
    }

    await streamed.completed;
    if (streamed.error) throw streamed.error;
    return streamed;
  }
}
