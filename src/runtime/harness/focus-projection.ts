import type { FocusRow } from '../../memory/db.js';
import { currentInputSuppressesPriorTask } from './current-task-authority.js';

/**
 * An active focus can point at work from another durable session. That pointer
 * is useful continuity, but its prose summary is historical—not proof that a
 * newly accepted request ran. Automatic projection follows session ownership:
 * "review these drafts" or "continue" cannot select a different conversation's
 * focus. Historical requests can explicitly retrieve the prior session/resource.
 */
export function focusSummaryIsHistoricalForRequest(
  focus: Pick<FocusRow, 'related_session_id'>,
  input?: string | null,
  sessionId?: string | null,
): boolean {
  const text = (input ?? '').trim();
  if (currentInputSuppressesPriorTask(text)) return true;
  // Keep unscoped snapshot rendering available to non-request callers. Once
  // there is a current session, phrase shape cannot widen its scope.
  if (!sessionId) return false;
  return focus.related_session_id !== sessionId;
}

export function renderHistoricalFocusPointer(
  focus: Pick<FocusRow, 'id' | 'title' | 'resource_ref' | 'resource_kind' | 'last_touched_at'>,
): string {
  return [
    `RELATED HISTORICAL focus #${focus.id}: ${focus.title}`,
    `Resource: ${focus.resource_ref}${focus.resource_kind ? ` (${focus.resource_kind})` : ''}`,
    `Last touched: ${focus.last_touched_at}`,
    'This pointer is historical context, not the current task or evidence of its completion. Use explicit session or memory retrieval before relying on prior details; the current user request still defines the work.',
  ].join('\n');
}
