/**
 * Read a harness eventlog session back into a clean user/assistant
 * transcript for display in the desktop Conversations UI.
 *
 * The legacy console implemented this extraction inline in the browser
 * (`humanHarnessText` in console.ts). This is the shared server-side
 * version so the unified `/api/console/sessions/:id` endpoint and any UI
 * agree on exactly one rendering of harness history.
 */
import type { UnifiedSessionTurn } from '../../types.js';
import { listEvents } from './eventlog.js';

/**
 * Coerce a harness event payload into the human-facing reply text.
 * `conversation_completed` data can be a string, a JSON-string, or an
 * object with `reply`/`summary` — unwrap all three to the user-visible
 * text, falling back to `fallback`.
 */
export function humanHarnessText(value: unknown, fallback = ''): string {
  if (value == null) return fallback;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const reply = typeof obj.reply === 'string' ? obj.reply.trim() : '';
    const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
    return reply || summary || fallback;
  }
  const text = String(value).trim();
  if (!text) return fallback;
  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        const reply = typeof obj.reply === 'string' ? obj.reply.trim() : '';
        const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
        if (reply || summary) return reply || summary;
      }
    } catch {
      // Not JSON after all; fall through to the raw text.
    }
  }
  return text;
}

/**
 * Reconstruct an ordered user/assistant transcript from a harness
 * session's events. User turns come from `user_input_received` (data.text);
 * assistant turns from `conversation_completed` (data.reply ?? data.summary).
 * Empty assistant turns (reason-only completions) are skipped.
 */
export function reconstructHarnessTranscript(sessionId: string, limit = 1000): UnifiedSessionTurn[] {
  const events = listEvents(sessionId, {
    types: ['user_input_received', 'conversation_completed'],
    limit,
  });
  const turns: UnifiedSessionTurn[] = [];
  for (const event of events) {
    if (event.type === 'user_input_received') {
      // Skip synthetic user turns (outcome relays / report-back directives from
      // runtime/outcome.ts). The user never typed them, so they must not render
      // as user bubbles — the model-facing history keeps them.
      if (event.data.synthetic === true) continue;
      const text = typeof event.data.text === 'string' ? event.data.text.trim() : '';
      if (text) turns.push({ role: 'user', text, createdAt: event.createdAt });
    } else if (event.type === 'conversation_completed') {
      const text = humanHarnessText(event.data.reply ?? event.data.summary, '');
      if (text) turns.push({ role: 'assistant', text, createdAt: event.createdAt });
    }
  }
  return turns;
}

/** The most recent meaningful turn text, for a list preview. Empty if none. */
export function harnessPreview(sessionId: string): string {
  const events = listEvents(sessionId, {
    types: ['user_input_received', 'conversation_completed'],
    limit: 1,
    desc: true,
  });
  const latest = events[0];
  if (!latest) return '';
  if (latest.type === 'user_input_received') {
    return typeof latest.data.text === 'string' ? latest.data.text.trim() : '';
  }
  return humanHarnessText(latest.data.reply ?? latest.data.summary, '');
}
