import { randomUUID } from 'node:crypto';
import { Agent, RunState, Runner, setDefaultOpenAIKey } from '@openai/agents';
import { ASSISTANT_NAME, MODELS, OPENAI_API_KEY } from '../config.js';
import type { ApprovalResolutionResult, PendingApproval, RunRequest, RunResult } from '../types.js';
import { AgentRuntimeCancelledError, type AgentRuntime, type AgentRuntimeCallbacks } from './provider.js';
import type { RuntimeContextValue } from '../types.js';
import { ApprovalStore } from './approval-store.js';
import { getCoreTools } from '../tools/registry.js';
import { createConfiguredMcpServers } from './mcp-servers.js';
import { addNotification } from './notifications.js';

export class OpenAIRuntime implements AgentRuntime {
  private readonly runner: Runner;
  private readonly approvals = new ApprovalStore();
  private readonly mcpServers = createConfiguredMcpServers();

  constructor() {
    if (OPENAI_API_KEY) {
      setDefaultOpenAIKey(OPENAI_API_KEY);
    }

    this.runner = new Runner({
      workflowName: 'clementine-next',
      groupId: 'clementine',
    });
  }

  private createAgent(request: RunRequest): Agent<RuntimeContextValue> {
    return new Agent<RuntimeContextValue>({
      name: ASSISTANT_NAME,
      instructions:
        request.instructions ||
        'You are Clementine, a persistent executive assistant. Be concise, accurate, and action-oriented.',
      model: request.model || MODELS.primary,
      tools: getCoreTools(),
      mcpServers: this.mcpServers,
    });
  }

  listPendingApprovals(): PendingApproval[] {
    return this.approvals.listPending();
  }

  private notifyApprovalPending(approval: PendingApproval): void {
    addNotification({
      id: `${Date.now()}-approval-${approval.id}`,
      kind: 'approval',
      title: `Approval required: ${approval.toolName}`,
      body: `Approval ${approval.id} is required before work can continue.`,
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

  private notifyApprovalResolved(result: ApprovalResolutionResult, approval: PendingApproval, approved: boolean): void {
    addNotification({
      id: `${Date.now()}-approval-${result.approvalId}-${approved ? 'approved' : 'rejected'}`,
      kind: 'approval',
      title: `Approval ${approved ? 'approved' : 'rejected'}: ${approval.toolName}`,
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

    const agent = this.createAgent({
      sessionId: approval.sessionId,
      prompt: '',
      model: MODELS.primary,
    });

    const state = await RunState.fromString<RuntimeContextValue, Agent<RuntimeContextValue>>(agent, approval.state);
    const interruption = state.getInterruptions()[0];
    if (!interruption) {
      throw new Error(`Approval ${approvalId} no longer has a pending interruption.`);
    }

    const resolutionStatus: ApprovalResolutionResult['status'] = approved ? 'approved' : 'rejected';

    if (approved) {
      state.approve(interruption);
    } else {
      state.reject(interruption);
    }

    const resumed = await this.runner.run(agent, state, {
      context: {
        sessionId: approval.sessionId,
      },
      maxTurns: 12,
    });

    const nextApproval = resumed.interruptions[0];
    if (nextApproval) {
      this.approvals.updateStatus(approvalId, approved ? 'approved' : 'rejected', resumed.state.toString());
      const followUpId = randomUUID();
      const rawItem = nextApproval.toJSON().rawItem as { name?: string };
      this.approvals.add({
        id: followUpId,
        sessionId: approval.sessionId,
        agentName: ASSISTANT_NAME,
        toolName: rawItem.name || 'unknown_tool',
        userId: approval.userId,
        channel: approval.channel,
        createdAt: new Date().toISOString(),
        status: 'pending',
        state: resumed.state.toString(),
      });

      const outcome = {
        approvalId,
        status: resolutionStatus,
        sessionId: approval.sessionId,
        text: `Resolved ${approvalId}. Another approval is required: ${followUpId}`,
      };
      this.notifyApprovalResolved(outcome, approval, approved);
      this.notifyApprovalPending({
        id: followUpId,
        sessionId: approval.sessionId,
        agentName: ASSISTANT_NAME,
        toolName: rawItem.name || 'unknown_tool',
        userId: approval.userId,
        channel: approval.channel,
        createdAt: new Date().toISOString(),
        status: 'pending',
        state: resumed.state.toString(),
      });
      return outcome;
    }

    const finalText = typeof resumed.finalOutput === 'string'
      ? resumed.finalOutput
      : JSON.stringify(resumed.finalOutput);

    this.approvals.updateStatus(approvalId, approved ? 'approved' : 'rejected', resumed.state.toString());

    const outcome = {
      approvalId,
      status: resolutionStatus,
      sessionId: approval.sessionId,
      text: finalText || `Approval ${approvalId} ${approved ? 'approved' : 'rejected'}.`,
    };
    this.notifyApprovalResolved(outcome, approval, approved);
    return outcome;
  }

	  async run(request: RunRequest, callbacks?: AgentRuntimeCallbacks): Promise<RunResult> {
	    if (await callbacks?.shouldCancel?.()) {
	      throw new AgentRuntimeCancelledError();
	    }
	    const agent = this.createAgent(request);

    const context: RuntimeContextValue = {
      sessionId: request.sessionId ?? randomUUID(),
      userId: request.userId,
      channel: request.channel,
    };

      // Stream when the caller subscribed to onChunk OR onReasoning.
      // Falls back to non-streaming when neither is subscribed — keeps
      // the simpler path for callers that don't care about deltas.
      const wantsStream = Boolean(callbacks?.onChunk || callbacks?.onReasoning);

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

    const approval = result.interruptions[0];
    if (approval) {
      const approvalId = randomUUID();
      const rawItem = approval.toJSON().rawItem as { name?: string };
      const pendingApproval: PendingApproval = {
        id: approvalId,
        sessionId: context.sessionId,
        agentName: ASSISTANT_NAME,
        toolName: rawItem.name || 'unknown_tool',
        userId: context.userId,
        channel: context.channel,
        createdAt: new Date().toISOString(),
        status: 'pending',
        state: result.state.toString(),
      };
      this.approvals.add(pendingApproval);
      this.notifyApprovalPending(pendingApproval);

      return {
        text: `Approval required before I continue. Pending approval ID: ${approvalId}`,
        sessionId: context.sessionId,
        pendingApprovalId: approvalId,
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
      // tool calls, reasoning, handoffs). We capture reasoning here.
      if (event.type === 'run_item_stream_event' && event.name === 'reasoning_item_created') {
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

    await streamed.completed;
    if (streamed.error) throw streamed.error;
    return streamed;
  }
}
