/**
 * CHANGE 4: Workflow pause gates — mid-execution human-in-the-loop.
 *
 * Allows a workflow step to pause and notify the user, waiting for their
 * response before resuming. Enables workflows like:
 *
 *   - step 1: research
 *   - step 2: review findings + pause_for_user_approval("Look good?")
 *   - step 3: deploy (only if approved)
 */

import { randomUUID } from 'node:crypto';
import { addNotification } from '../runtime/notifications.js';

export interface WorkflowPauseGate {
  id: string;
  workflowName: string;
  workflowRunId: string;
  stepId: string;
  createdAt: string;
  message: string;
  context?: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  userResponse?: string;
  expiresAt: string;
}

// In-memory registry (in production, use database)
const pauseRegistry = new Map<string, WorkflowPauseGate>();

/**
 * Create a pause gate for a workflow step.
 *
 * The step will pause here and emit a notification to the user.
 * The workflow can then check the gate status and decide whether to resume or abort.
 */
export function createPauseGate(options: {
  workflowName: string;
  workflowRunId: string;
  stepId: string;
  message: string;
  context?: Record<string, unknown>;
  expiryMinutes?: number;
}): WorkflowPauseGate {
  const gate: WorkflowPauseGate = {
    id: randomUUID(),
    workflowName: options.workflowName,
    workflowRunId: options.workflowRunId,
    stepId: options.stepId,
    createdAt: new Date().toISOString(),
    message: options.message,
    context: options.context,
    status: 'pending',
    expiresAt: new Date(Date.now() + (options.expiryMinutes || 60) * 60_000).toISOString(),
  };

  pauseRegistry.set(gate.id, gate);

  // Emit notification to user
  try {
    addNotification({
      id: `pause-${gate.id}`,
      kind: 'workflow',
      title: `Workflow paused: ${options.workflowName}`,
      body: options.message,
      createdAt: gate.createdAt,
      read: false,
      silent: false,
      metadata: {
        pauseGateId: gate.id,
        workflowRunId: options.workflowRunId,
        action: 'workflow_pause_await_response',
      },
    });
  } catch (err) {
    console.warn('[workflow-pause-gate] failed to emit notification', err);
  }

  return gate;
}

/**
 * Respond to a pause gate (approve or reject).
 */
export function respondToPauseGate(
  gateId: string,
  approved: boolean,
  userResponse?: string,
): WorkflowPauseGate | null {
  const gate = pauseRegistry.get(gateId);
  if (!gate) return null;

  gate.status = approved ? 'approved' : 'rejected';
  gate.userResponse = userResponse;

  return gate;
}

/**
 * Get a pause gate by ID.
 */
export function getPauseGate(gateId: string): WorkflowPauseGate | null {
  return pauseRegistry.get(gateId) ?? null;
}

/**
 * Check if a gate is still valid (not expired).
 */
export function isPauseGateValid(gate: WorkflowPauseGate): boolean {
  if (gate.status !== 'pending') return false;
  return new Date(gate.expiresAt) > new Date();
}

/**
 * List pending pause gates for a workflow run.
 */
export function listPendingPauseGates(workflowRunId: string): WorkflowPauseGate[] {
  const gates: WorkflowPauseGate[] = [];
  for (const gate of pauseRegistry.values()) {
    if (gate.workflowRunId === workflowRunId && gate.status === 'pending' && isPauseGateValid(gate)) {
      gates.push(gate);
    }
  }
  return gates;
}

/**
 * Clear expired pause gates (cleanup).
 */
export function clearExpiredPauseGates(): number {
  let cleared = 0;
  const now = new Date();
  for (const [id, gate] of pauseRegistry.entries()) {
    if (new Date(gate.expiresAt) < now) {
      pauseRegistry.delete(id);
      cleared++;
    }
  }
  return cleared;
}

/**
 * Tool definition for use in orchestrator/agents.
 *
 * Usage in a step prompt:
 *   "Before deploying, ask the user: 'Are you ready?'
 *    Use pause_for_user_approval('Are you ready to deploy?')
 *    and wait for YES/NO."
 */
export const pauseForUserApprovalToolDef = {
  name: 'pause_for_user_approval',
  description:
    'Pause the workflow and ask the user for approval before continuing. The user will receive a notification and can respond YES to resume or NO to abort. The workflow waits up to 60 minutes for a response.',
  input_schema: {
    type: 'object' as const,
    properties: {
      message: {
        type: 'string',
        description:
          'The question or prompt to show the user. Keep it short and clear, e.g., "Are these findings correct? Approve to deploy."',
      },
      context_json: {
        type: 'string',
        description:
          'Optional JSON string of context to include in the notification, e.g., "{\\"findings\\": \\"3 opportunities found\\"}"',
      },
    },
    required: ['message'],
  },
};

/**
 * TOOL HANDLER: implement this in the orchestrator/harness.
 *
 * Returns { gateId, status } so the step can check status later.
 */
export function handlePauseForUserApproval(
  workflowName: string,
  workflowRunId: string,
  stepId: string,
  message: string,
  contextJson?: string,
): { gateId: string; status: 'created' } {
  let context: Record<string, unknown> | undefined;
  if (contextJson) {
    try {
      context = JSON.parse(contextJson) as Record<string, unknown>;
    } catch {
      // Ignore parse errors; context is optional
    }
  }

  const gate = createPauseGate({
    workflowName,
    workflowRunId,
    stepId,
    message,
    context,
  });

  return {
    gateId: gate.id,
    status: 'created',
  };
}

/**
 * Wait for a pause gate to be resolved (approved/rejected/expired).
 *
 * Polls with exponential backoff to avoid busy-waiting.
 * Use inside a step prompt: after calling pause_for_user_approval,
 * the step can call wait_for_pause_response to block until resolved.
 */
export async function waitForPauseGateResponse(
  gateId: string,
  maxWaitMs: number = 60 * 60_000, // 60 min default
): Promise<{ approved: boolean; userResponse?: string }> {
  const startTime = Date.now();
  let backoffMs = 1000; // Start at 1s
  let gate: WorkflowPauseGate | undefined;

  while (Date.now() - startTime < maxWaitMs) {
    gate = pauseRegistry.get(gateId);

    if (!gate) {
      // Gate was deleted (cleanup ran)
      return { approved: false, userResponse: 'Gate expired' };
    }

    if (gate.status === 'approved') {
      return { approved: true, userResponse: gate.userResponse };
    }

    if (gate.status === 'rejected') {
      return { approved: false, userResponse: gate.userResponse };
    }

    // Still pending — wait with backoff
    await new Promise(resolve => setTimeout(resolve, Math.min(backoffMs, 30_000))); // Cap at 30s
    backoffMs = Math.min(backoffMs * 1.5, 30_000);
  }

  // Timeout reached
  if (gate) {
    gate.status = 'expired';
  }
  return { approved: false, userResponse: 'Pause gate timeout' };
}
