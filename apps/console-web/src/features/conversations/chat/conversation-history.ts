import { readTaskMode, readPlanRevisionRef } from '../../../lib/task-mode';
import { applyApprovalDecisionAck, approvalDecisionFallback, readApprovalDecisionAck, readSteerReceipt, approvalPreviewFrom, approvalRevisionFrom, recordedTurnProject, terminalCompletionPresentation, approvalResultFields } from '@clem/chat-engine';
import { pendingActionFromEvent, type ChatMessage } from '../../../lib/useChat';
import type { Turn } from '../types';

let seedSeq = 0;

/** Project server-normalized turns into the exact live-card shapes used by
 * the chat UI. Durable plan and approval identities survive navigation; plain
 * assistant history remains terminal text. */
export function historyToMessages(turns: Turn[]): ChatMessage[] {
  const suppressed = new Set<string>();
  let messages = turns.map((turn) => ({ ...historyMessage(turn), ...acceptedSource(turn), ...writtenAt(turn), ...answeredBy(turn), ...workedIn(turn), ...savedWork(turn) }));
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index]!;
    const terminal = turn.terminal as Record<string, unknown> | undefined;
    if (turn.role !== 'assistant' || !terminal || turn.files?.length || turn.workflows?.length || turn.planArtifactRef) continue;
    const presentation = terminal.presentation as { identity?: { sessionId?: unknown } } | undefined;
    const sessionId = presentation?.identity?.sessionId;
    if (typeof sessionId !== 'string' || typeof terminal.terminalSeq !== 'number') continue;
    const ack = readApprovalDecisionAck({ seq: terminal.terminalSeq, type: 'conversation_completed', sessionId,
      data: terminal }, sessionId);
    if (!ack) continue;
    const id = messages[index]?.id;
    const resolution = applyApprovalDecisionAck(messages, ack);
    messages = resolution.messages.map(message => message.id === id
      ? { ...message, text: resolution.matched ? '' : approvalDecisionFallback(ack),
        ...(resolution.matched ? { status: undefined } : { status: 'complete' as const }), terminal: undefined } : message);
    // Preserve indices until every exact terminal has been inspected.
    if (resolution.matched && id) suppressed.add(id);
  }
  return messages.filter(message => !suppressed.has(message.id));
}

/** Only the server's exact source pairing survives. Text, order, timestamps
 * and the conversation's latest execution head never supply a missing ID. */
function acceptedSource(turn: Turn): Pick<ChatMessage, 'acceptedSource'> {
  const source = turn.acceptedSource;
  if (turn.checkIn || turn.fromClem || turn.steerNote || !source || typeof source !== 'object' || Array.isArray(source)
    || typeof source.sessionId !== 'string' || !source.sessionId.trim() || source.sessionId.length > 256
    || !Number.isSafeInteger(source.sourceUserSeq) || source.sourceUserSeq <= 0
    || !Number.isSafeInteger(source.turn) || source.turn < 0) return {};
  return { acceptedSource: { sessionId: source.sessionId, sourceUserSeq: source.sourceUserSeq, turn: source.turn } };
}

/** Only the normalized server history prop may supply this list. Never build
 * it from live chat messages: a foreign live claim cannot authorize itself. */
export function historyHandlingSources(turns: readonly Turn[]): ReadonlySet<string> {
  const sources = new Set<string>();
  for (const turn of turns) {
    if (turn.role !== 'assistant') continue;
    const source = acceptedSource(turn).acceptedSource;
    if (source) sources.add(JSON.stringify([source.sessionId, source.sourceUserSeq, source.turn]));
  }
  return sources;
}

/** The workflows and files the reply saved, as the receipt-only rows the live card is
 *  drawn from, so reopening shows the same card the live reply did. */
function savedWork(turn: Turn): Pick<ChatMessage, 'activity'> {
  if (turn.role !== 'assistant') return {};
  const activity: NonNullable<ChatMessage['activity']> = (turn.workflows ?? []).map((workflow) => ({
    id: `workflow-${workflow.slug}`,
    kind: 'event' as const,
    variant: 'write' as const,
    tone: 'success' as const,
    status: 'done' as const,
    label: workflow.op === 'created' ? `Created workflow “${workflow.name}”` : `Changed workflow “${workflow.name}”`,
    workflow,
  }));
  const files = turn.files ?? [];
  const latest = files.at(-1);
  if (latest) activity.push({
    id: 'deliverables', kind: 'event', variant: 'write', tone: 'success', status: 'done',
    label: files.length === 1 ? `Saved ${latest.name}${latest.dir ? ` in ${latest.dir}` : ''}` : `Saved ${files.length} files · latest ${latest.name}`,
    count: files.length, deliverable: latest, deliverables: files,
  });
  return activity.length ? { activity } : {};
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
        ...approvalResultFields(turn.approval as unknown as Record<string, unknown>, turn.approval.ownerSessionId),
        pendingAction: pendingActionFromEvent(turn.approval.pendingAction),
        ...(approvalPreviewFrom(turn.approval.preview) ? { preview: approvalPreviewFrom(turn.approval.preview) } : {}),
        // A reopened chat draws the change on the card as the live one did.
        ...(approvalRevisionFrom(turn.approval.revises) ? { revises: approvalRevisionFrom(turn.approval.revises) } : {}),
        ...(['approved', 'declined', 'changed', 'expired', 'cancelled'].includes(String(turn.approval.resolution))
          ? { resolution: turn.approval.resolution as 'approved' | 'declined' | 'changed' | 'expired' | 'cancelled' } : {}),
      },
    };
  }
  const typed = turn.role === 'assistant' ? reopenedTerminal(turn) : null;
  const steerReceipt = turn.role === 'user' ? readSteerReceipt(turn.steerReceipt) : null;
  return {
    id: `h${++seedSeq}`,
    role: turn.role,
    text: typed ? typed.text : turn.text,
    ...(steerReceipt ? { steer: 'delivered' as const, steerReceipt } : turn.steerNote ? { steer: 'delivered' as const } : {}),
    ...(steerReceipt ? { requestSessionId: steerReceipt.sessionId, steerNoteSeq: steerReceipt.noteSeq }
      : turn.steerNote && typeof turn.steerNoteSessionId === 'string' && /^[A-Za-z0-9:._/-]{1,240}$/.test(turn.steerNoteSessionId)
        && Number.isSafeInteger(turn.steerNoteSeq) && Number(turn.steerNoteSeq) > 0
        ? { requestSessionId: turn.steerNoteSessionId, steerNoteSeq: turn.steerNoteSeq } : {}),
    taskMode: readTaskMode(turn.taskMode),
    planArtifactRef: readPlanRevisionRef(turn.planArtifactRef),
    status: typed ? typed.status : turn.role === 'assistant' ? ('complete' as const) : undefined,
    ...(typed?.terminal ? { terminal: typed.terminal } : {}),
  };
}

/** A reply the server reopened with its typed terminal reads exactly as it
 *  did live: a notice in place of a reply is the app's status line rather
 *  than a finished reply in Clem's place, a stop keeps its pill and what it
 *  kept, and the review chip keeps its ruling. Without one (an older Mac) the
 *  reply stays plain text. */
function reopenedTerminal(turn: Turn): Pick<ChatMessage, 'text' | 'status' | 'terminal'> | null {
  const terminal = turn.terminal;
  if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) return null;
  const presentation = terminal.presentation && typeof terminal.presentation === 'object' ? terminal.presentation : {};
  const reopened = terminalCompletionPresentation({ ...terminal, reply: turn.text, presentation: { ...presentation, text: turn.text } }, '');
  return reopened.terminal ? { text: reopened.text, status: reopened.status, terminal: reopened.terminal } : null;
}
