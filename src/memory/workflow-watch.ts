/**
 * A watch, in the owner's words: a standing, read-only look at a source the
 * owner handed Clem (an inbox, a channel, a folder, a CRM view). The workflow
 * that carries it owns the read and its schedule; its last step returns
 * `{ findings, learned }` and agents/watches.ts turns those into memory and,
 * for `tell_me`, items in From Clem. Shared by the store and the validator.
 */
export interface WorkflowWatch {
  /** What Clem watches, e.g. "Slack #platform-49" or "my Outlook inbox". */
  source: string;
  /** What matters to the owner there, e.g. "a client who sounds unhappy". */
  lookFor: string;
  /** `learn` only remembers what she sees; `tell_me` also raises what matters. */
  purpose: 'learn' | 'tell_me';
}

const WATCH_TEXT_MAX = 400;

/** The saved watch declaration, or undefined when absent or malformed. */
export function parseWorkflowWatch(value: unknown): WorkflowWatch | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const text = (field: unknown): string => (typeof field === 'string' ? field.trim().slice(0, WATCH_TEXT_MAX) : '');
  const source = text(raw.source);
  const lookFor = text(raw.look_for ?? raw.lookFor);
  if (!source || !lookFor) return undefined;
  return { source, lookFor, purpose: raw.purpose === 'learn' ? 'learn' : 'tell_me' };
}
