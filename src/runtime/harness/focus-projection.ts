import type { FocusRow } from '../../memory/db.js';

const HISTORICAL_REVIEW_RE =
  /\b(?:continue|pick\s+up|resume|reopen|review|inspect|recap|summari[sz]e|status|what\s+(?:happened|did)|where\s+(?:is|did)|show\s+me\s+(?:the\s+)?(?:status|progress|history))\b/i;
const EXPLICIT_FRESH_RE =
  /\b(?:fresh|new|again|rerun|re-run|run\s+again|perform|right\s+now)\b/i;
const ACTION_RE =
  /\b(?:add|build|create|delete|deploy|draft|edit|execute|generate|make|modify|post|publish|remove|run|schedule|send|set\s+up|update|upload|write)\b/i;

/**
 * An active focus can point at work from another durable session. That pointer
 * is useful continuity, but its prose summary is historical—not proof that a
 * newly accepted request ran. Hide the summary on fresh action requests while
 * preserving it for explicit status/review/resume turns.
 */
export function focusSummaryIsHistoricalForRequest(
  focus: Pick<FocusRow, 'related_session_id'>,
  input?: string | null,
  sessionId?: string | null,
): boolean {
  const text = (input ?? '').trim();
  if (!text || !sessionId || focus.related_session_id === sessionId) return false;
  if (EXPLICIT_FRESH_RE.test(text)) return true;
  if (HISTORICAL_REVIEW_RE.test(text)) return false;
  return ACTION_RE.test(text);
}

export function renderHistoricalFocusPointer(
  focus: Pick<FocusRow, 'id' | 'title' | 'resource_ref' | 'resource_kind' | 'last_touched_at'>,
): string {
  return [
    `RELATED HISTORICAL focus #${focus.id}: ${focus.title}`,
    `Resource: ${focus.resource_ref}${focus.resource_kind ? ` (${focus.resource_kind})` : ''}`,
    `Last touched: ${focus.last_touched_at}`,
    'This pointer is context only, never completion evidence for the current request. Its prior summary and receipts are intentionally withheld. Perform fresh requested work now and only cite receipts produced after this user request.',
  ].join('\n');
}
