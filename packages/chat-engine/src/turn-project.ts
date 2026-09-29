/**
 * Which project each message in a conversation worked in.
 *
 * A conversation can move into a project, to another one, or out of it,
 * between exchanges. A reply says which project it ran in on its model-phase
 * row (the turn's route marker); a reopened transcript says it on the turn; a
 * message the owner just sent says which project it was sent into. From
 * those, one thread gets a project per message and a line wherever it
 * changed. Older replies keep the project they were written in.
 */
import type { ActivityItem } from './types.js';
import { MODEL_PHASE_ACTIVITY_ID } from './reduce-activity.js';
import { threadChanges } from './thread-marks.js';

export interface ProjectAttributed {
  role: 'user' | 'assistant';
  /** Stated on the message: a project's name, null for no project. Absent
   *  when the message itself does not say. */
  projectName?: string | null;
  activity?: readonly Pick<ActivityItem, 'id' | 'projectName'>[];
}

/** A project's name, null for none, undefined when the message does not say. */
export function messageProject(message: ProjectAttributed): string | null | undefined {
  if (message.projectName !== undefined) return message.projectName?.trim() || null;
  const row = message.activity?.find((item) => item.id === MODEL_PHASE_ACTIVITY_ID);
  if (!row) return undefined;
  return row.projectName?.trim() || null;
}

/**
 * What a saved turn says about its project. The server names the project
 * only on a turn that worked in one, and names who answered on every turn it
 * has a record for. So a turn that says who answered and names no project
 * worked in none; a turn with no record at all does not say.
 */
export function recordedTurnProject(turn: { agentName?: string | null; projectName?: string | null }): string | null | undefined {
  if (typeof turn.projectName === 'string') return turn.projectName.trim() || null;
  if (turn.projectName === null) return null;
  return turn.agentName !== undefined ? null : undefined;
}

export interface ProjectThreadMark {
  /** The project this message worked in: its name, null for none. */
  project: string | null;
  /** Set on the message the conversation changed project at. */
  movedTo?: { name: string | null; from: string | null };
}

/**
 * One mark per message. `fallback` is the project before any message says
 * (the conversation's own project, or null). A change is marked on the
 * owner's message that started it, so the line sits above the question.
 */
export function projectThreadMarks(
  messages: readonly ProjectAttributed[],
  fallback: string | null = null,
): ProjectThreadMark[] {
  return threadChanges<string | null>(messages.map((message) => message.role), messages.map(messageProject), fallback)
    .map((mark) => ({
      project: mark.value,
      ...(mark.changed ? { movedTo: { name: mark.changed.to, from: mark.changed.from } } : {}),
    }));
}

/** The words on the line where a conversation changed project. */
export function projectSwitchLabel(name: string | null, from: string | null = null): string {
  if (name) return `Now working in ${name}`;
  return from ? `Left ${from}` : 'Left the project';
}
