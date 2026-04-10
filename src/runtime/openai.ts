import { randomUUID } from 'node:crypto';
import { Agent, RunState, Runner, setDefaultOpenAIKey } from '@openai/agents';
import { ASSISTANT_NAME, MODELS, OPENAI_API_KEY } from '../config.js';
import type { ApprovalResolutionResult, PendingApproval, RunRequest, RunResult } from '../types.js';
import type { AgentRuntime, AgentRuntimeCallbacks } from './provider.js';
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
    const agent = this.createAgent(request);

    const context: RuntimeContextValue = {
      sessionId: request.sessionId ?? randomUUID(),
      userId: request.userId,
      channel: request.channel,
    };

    const result = await this.runner.run(agent, request.prompt, {
      context,
      maxTurns: 12,
    });
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
}
