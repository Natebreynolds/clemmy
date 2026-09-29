/**
 * Which project each thing waiting on the owner belongs to.
 *
 * An Inbox row already says which session it came from: the conversation it
 * was asked in, or the run a delegated task works in. The Mac answers, for a
 * list of those sessions, which project each one works in. One request per
 * load labels every row; a session in no project is simply not in the answer,
 * and its row is drawn exactly as it always was.
 */
import { projectLabelsBySession, sessionProjectLabelText, type SessionProjectLabel } from '@clem/chat-engine';

/** The shape is the shared engine's, so both apps read one definition. */
export type ProjectLabel = SessionProjectLabel;

interface ApprovalLike { sessionId?: string | null; projectName?: string | null }
interface QuestionLike { sessionId?: string | null; taskId?: string | null; projectName?: string | null }
interface NotificationLike { context: { sessionId?: string | null; runSessionId?: string | null } }

/** The most sessions one request names; the Mac reads no more than this. */
const MAX_SESSIONS = 200;

/** A delegated task works in a session of its own, named after the task. */
function taskRunSession(taskId: string | null | undefined): string | null {
  const id = typeof taskId === 'string' ? taskId.trim() : '';
  return id ? `background:${id}` : null;
}

function clean(value: string | null | undefined): string | null {
  const id = typeof value === 'string' ? value.trim() : '';
  // The ids travel in one comma-separated parameter.
  return id && !id.includes(',') ? id : null;
}

/**
 * The sessions a row could be labelled by, most specific first: the run a
 * task works in says which project the WORK is for, and outranks the
 * conversation it happened to be asked from.
 */
export function approvalSessions(row: ApprovalLike): string[] {
  return [clean(row.sessionId)].filter((id): id is string => id !== null);
}
export function questionSessions(row: QuestionLike): string[] {
  return [clean(taskRunSession(row.taskId)), clean(row.sessionId)].filter((id): id is string => id !== null);
}
export function notificationSessions(row: NotificationLike): string[] {
  return [clean(row.context.runSessionId), clean(row.context.sessionId)].filter((id): id is string => id !== null);
}

/** Every session the screen's rows name, once each, in the order first seen. */
export function inboxLabelSessions(input: {
  approvals?: readonly ApprovalLike[];
  questions?: readonly QuestionLike[];
  notifications?: readonly NotificationLike[];
}): string[] {
  const seen = new Set<string>();
  const add = (ids: string[]) => { for (const id of ids) if (seen.size < MAX_SESSIONS) seen.add(id); };
  for (const row of input.questions ?? []) add(questionSessions(row));
  for (const row of input.approvals ?? []) add(approvalSessions(row));
  for (const row of input.notifications ?? []) add(notificationSessions(row));
  return [...seen];
}

export type ProjectLabels = ReadonlyMap<string, ProjectLabel>;

export function indexProjectLabels(labels: readonly ProjectLabel[] | null | undefined): Map<string, ProjectLabel> {
  // An answer can carry rows this build cannot read; they label nothing.
  const usable = (labels ?? []).filter((label) => Boolean(label)
    && typeof label.sessionId === 'string' && typeof label.projectName === 'string');
  return projectLabelsBySession(usable);
}

/**
 * What a row's chip says, in the shared engine's words: the project, and the
 * agent when one is on it. Null when the row belongs to no project. What the
 * row itself says wins over the lookup, so a Mac that names the project on
 * the row is believed first.
 */
export function projectNameFor(
  row: object,
  sessions: readonly string[],
  labels: ProjectLabels | null | undefined,
): string | null {
  const named = (row as { projectName?: unknown }).projectName;
  const own = typeof named === 'string' ? named.trim() : '';
  if (own) return own;
  if (!labels) return null;
  for (const id of sessions) {
    const label = labels.get(id);
    if (label) return sessionProjectLabelText(label);
  }
  return null;
}
