/**
 * Who answered each message in a conversation that can move between agents.
 *
 * A reply says which saved agent it ran as on its model-phase row (the turn's
 * route marker); a reopened transcript says it on the turn itself; a message
 * the owner just sent says which agent it was addressed to. From those, one
 * thread gets a speaker per reply and a line wherever the agent changed.
 */
import type { ActivityItem } from './types.js';
import { MODEL_PHASE_ACTIVITY_ID } from './reduce-activity.js';
import { threadChanges } from './thread-marks.js';

export interface AgentAttributed {
  role: 'user' | 'assistant';
  /** Stated on the message: a saved agent's name, null for Clem without an
   *  agent. Absent when the message itself does not say. */
  agentName?: string | null;
  activity?: readonly Pick<ActivityItem, 'id' | 'agentName'>[];
}

/** A saved agent's name, null for Clem, undefined when the message does not say. */
export function messageAgent(message: AgentAttributed): string | null | undefined {
  if (message.agentName !== undefined) return message.agentName?.trim() || null;
  const row = message.activity?.find((item) => item.id === MODEL_PHASE_ACTIVITY_ID);
  if (!row) return undefined;
  return row.agentName?.trim() || null;
}

export interface AgentThreadMark {
  /** Who is speaking at this message: an agent's name, null for Clem. */
  speaker: string | null;
  /** Set on the message the conversation moved to another agent at. */
  switchedTo?: { name: string | null };
}

/**
 * One mark per message. `fallback` names who speaks before any message says
 * (the conversation's own agent, or null). A change is marked on the owner's
 * message that started it, so the line sits above the question, not between
 * the question and its answer.
 */
export function agentThreadMarks(
  messages: readonly AgentAttributed[],
  fallback: string | null = null,
): AgentThreadMark[] {
  // null is a speaker (Clem), so "does not say" is undefined and nothing else.
  return threadChanges<string | null>(messages.map((message) => message.role), messages.map(messageAgent), fallback)
    .map((mark) => ({ speaker: mark.value, ...(mark.changed ? { switchedTo: { name: mark.changed.to } } : {}) }));
}

/** The words on the line where a conversation moved to another agent. */
export function agentSwitchLabel(name: string | null): string {
  return `Switched to ${name ?? 'Clem'}`;
}
