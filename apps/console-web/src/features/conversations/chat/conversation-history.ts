import { readTaskMode, readPlanRevisionRef } from '../../../lib/task-mode';
import { approvalPreviewFrom, approvalRevisionFrom, recordedTurnProject } from '@clem/chat-engine';
import { pendingActionFromEvent, type ChatMessage } from '../../../lib/useChat';
import type { Turn } from '../types';

let seedSeq = 0;

/** Project server-normalized turns into the exact live-card shapes used by
 * the chat UI. Durable plan and approval identities survive navigation; plain
 * assistant history remains terminal text. */
export function historyToMessages(turns: Turn[]): ChatMessage[] {
  return turns.map((turn) => ({ ...historyMessage(turn), ...writtenAt(turn), ...answeredBy(turn), ...workedIn(turn), ...savedWorkflows(turn) }));
}

/** The workflows the reply saved, as the receipt-only rows the live card is
 *  drawn from, so reopening shows the same card the live reply did. */
function savedWorkflows(turn: Turn): Pick<ChatMessage, 'activity'> {
  if (turn.role !== 'assistant' || !turn.workflows?.length) return {};
  return {
    activity: turn.workflows.map((workflow) => ({
      id: `workflow-${workflow.slug}`,
      kind: 'event' as const,
      variant: 'write' as const,
      tone: 'success' as const,
      status: 'done' as const,
      label: workflow.op === 'created' ? `Created workflow “${workflow.name}”` : `Changed workflow “${workflow.name}”`,
      workflow,
    })),
  };
}

/** Who answered the exchange, when the server recorded it. */
function answeredBy(turn: Turn): Pick<ChatMessage, 'agentName'> {
  return turn.agentName !== undefined ? { agentName: turn.agentName } : {};
}

/** Which project the exchange worked in, when the server recorded it. */
function workedIn(turn: Turn): Pick<ChatMessage, 'projectName'> {
  const project = recordedTurnProject(turn);
  return project !== undefined ? { projectName: project } : {};
}

/** When the turn was written, for the reply's header. Display only. */
function writtenAt(turn: Turn): Pick<ChatMessage, 'sentAt'> {
  const at = Date.parse(turn.createdAt);
  return Number.isFinite(at) ? { sentAt: at } : {};
}

function historyMessage(turn: Turn): ChatMessage {
  if (turn.role === 'assistant' && turn.planProposalId) {
    return {
      id: `h${++seedSeq}`,
      role: turn.role,
      text: turn.text,
      taskMode: readTaskMode(turn.taskMode),
      planArtifactRef: readPlanRevisionRef(turn.planArtifactRef),
      status: 'awaiting-plan' as const,
      planProposalId: turn.planProposalId,
    };
  }
  if (turn.role === 'assistant' && turn.approval) {
    return {
      id: `h${++seedSeq}`,
      role: turn.role,
      text: turn.text,
      taskMode: readTaskMode(turn.taskMode),
      planArtifactRef: readPlanRevisionRef(turn.planArtifactRef),
      status: 'awaiting-approval' as const,
      approval: {
        subject: turn.approval.subject,
        reason: turn.approval.reason,
        approvalId: turn.approval.approvalId,
        pendingAction: pendingActionFromEvent(turn.approval.pendingAction),
        ...(approvalPreviewFrom(turn.approval.preview) ? { preview: approvalPreviewFrom(turn.approval.preview) } : {}),
        // A reopened chat draws the change on the card as the live one did.
        ...(approvalRevisionFrom(turn.approval.revises) ? { revises: approvalRevisionFrom(turn.approval.revises) } : {}),
        ...(turn.approval.resolution === 'expired' ? { resolution: 'expired' as const } : {}),
      },
    };
  }
  return {
    id: `h${++seedSeq}`,
    role: turn.role,
    text: turn.text,
    taskMode: readTaskMode(turn.taskMode),
    planArtifactRef: readPlanRevisionRef(turn.planArtifactRef),
    status: turn.role === 'assistant' ? ('complete' as const) : undefined,
  };
}
