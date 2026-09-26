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
  const known = messages.map(messageAgent);
  const firstKnown = known.find((agent) => agent !== undefined);
  let current: string | null = firstKnown === undefined ? fallback : firstKnown;
  const marks: AgentThreadMark[] = [];
  for (let i = 0; i < messages.length; i++) {
    const agent = known[i];
    if (agent !== undefined && agent !== current) {
      // The reply names the change but the question before it did not: the
      // line belongs above that question.
      const at = messages[i].role === 'assistant' && i > 0 && messages[i - 1].role === 'user' && known[i - 1] === undefined
        ? i - 1
        : i;
      // null is a speaker (Clem), so keep an existing mark's speaker as is.
      marks[at] = { speaker: marks[at] ? marks[at].speaker : agent, switchedTo: { name: agent } };
      current = agent;
    }
    marks[i] = { ...marks[i], speaker: current };
  }
  return marks;
}

/** The words on the line where a conversation moved to another agent. */
export function agentSwitchLabel(name: string | null): string {
  return `Switched to ${name ?? 'Clem'}`;
}
