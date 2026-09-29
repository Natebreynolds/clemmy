/**
 * The phone's own words and small decisions for projects and delegated tasks.
 *
 * What a project, a task or a scope IS comes from the shared engine
 * (@clem/chat-engine), which the desktop reads too. What lives here is what
 * only a screen decides: how a refusal is said to the owner, what a form sends
 * when it is saved, and what binding an account should ask next.
 *
 * Nothing here shows an id or a record's internal name. A refusal the phone
 * has no words for is said plainly rather than printed as its code.
 */
import type { ProjectAccountChoice } from '@clem/chat-engine';

/** One goal per line, as the owner typed them. */
export function goalsFromText(text: string): string[] {
  const seen = new Set<string>();
  const goals: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    // A pasted list keeps its meaning without its bullets.
    const goal = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();
    if (!goal || seen.has(goal)) continue;
    seen.add(goal);
    goals.push(goal);
  }
  return goals;
}

export function goalsToText(goals: readonly string[] | null | undefined): string {
  return (goals ?? []).map((goal) => goal.trim()).filter(Boolean).join('\n');
}

export interface ProjectDraft {
  name: string;
  purpose: string;
  /** One goal per line. */
  goals: string;
  context: string;
}

export function projectDraftFrom(project: { name: string; purpose: string; goals: readonly string[]; context: string }): ProjectDraft {
  return { name: project.name, purpose: project.purpose, goals: goalsToText(project.goals), context: project.context };
}

/**
 * Only what the owner changed, so a save never writes back a field somebody
 * else changed on the desktop while this form was open. Null = nothing to save.
 */
export function projectDraftChanges(
  project: { name: string; purpose: string; goals: readonly string[]; context: string },
  draft: ProjectDraft,
): { name?: string; purpose?: string; goals?: string[]; context?: string } | null {
  const patch: { name?: string; purpose?: string; goals?: string[]; context?: string } = {};
  const name = draft.name.trim();
  if (name && name !== project.name.trim()) patch.name = name;
  if (draft.purpose.trim() !== project.purpose.trim()) patch.purpose = draft.purpose.trim();
  if (draft.context.trim() !== project.context.trim()) patch.context = draft.context.trim();
  const goals = goalsFromText(draft.goals);
  const before = goalsFromText(goalsToText(project.goals));
  if (goals.length !== before.length || goals.some((goal, index) => goal !== before[index])) patch.goals = goals;
  return Object.keys(patch).length > 0 ? patch : null;
}

const REFUSALS: Record<string, string> = {
  NAME_REQUIRED: 'Give the project a name.',
  NAME_TAKEN: 'You already have a project with that name.',
  NOT_FOUND: 'That project is no longer on your Mac.',
  PROJECT_NOT_FOUND: 'That project is no longer on your Mac.',
  ARCHIVED: 'That project is archived. Restore it to change it.',
  PROJECT_ARCHIVED: 'That project is archived. Restore it to use it.',
  AGENT_NOT_FOUND: 'That agent is no longer available.',
  AGENT_REQUIRED: 'Choose an agent first.',
  RESOURCE_INCOMPLETE: 'That needs a little more detail before it can be added.',
  TOO_MANY_RESOURCES: 'This project already lists as much as it can hold. Remove something first.',
  TOOLKIT_REQUIRED: 'Say which app the account is for.',
  ACCOUNT_NOT_CONNECTED: 'No account for that app is connected on your Mac yet.',
  SESSION_NOT_FOUND: 'That conversation is no longer on your Mac.',
  NOT_A_CONVERSATION: 'Only a conversation can work in a project.',
  INVALID_PROJECT: 'That project could not be used.',
  TASK_NOT_FOUND: 'That task is no longer on your Mac.',
  INSTRUCTION_REQUIRED: 'Say a little more about what should change.',
  TASK_NOT_OPEN: 'This task has already ended, so it cannot take a correction.',
  STOPPING: 'This task is stopping. Correct it once it has stopped.',
  OWNER_UNAVAILABLE: 'The agent that did this is no longer available, so nothing can follow it up.',
  NOT_DELEGATED: 'This work was not handed to anyone, so there is nothing to correct here.',
  FACT_NOT_FOUND: 'That memory is no longer there.',
  INVALID_FACT: 'That memory could not be found.',
  ALREADY_KEPT_THERE: 'It is already kept there.',
  TASK_NOT_RESUMABLE: 'This task cannot be resumed from where it is.',
  TASK_NOT_WAITING: 'This task is no longer waiting on an answer.',
  ALREADY_ANSWERED: 'That was already answered somewhere else.',
  ANSWER_REQUIRED: 'Type an answer first.',
};

/**
 * What to tell the owner about a refused request. `error` is whatever the API
 * client threw; an unreachable Mac and an unnamed failure each get their own
 * plain line, and a code never reaches the screen.
 */
export function refusalWords(error: unknown, fallback = 'That did not go through. Try again.'): string {
  const candidate = error as { offline?: boolean; body?: unknown; message?: unknown } | null | undefined;
  if (candidate?.offline) return "Can't reach your Mac right now. Try again when you're back on.";
  const body = candidate?.body as { error?: unknown } | null | undefined;
  const code = body && typeof body === 'object' && typeof body.error === 'string' ? body.error : '';
  if (code && REFUSALS[code]) return REFUSALS[code];
  return fallback;
}

/** A refusal that means "the record moved on": show what the Mac has now, not an error. */
export function refusalIsStale(error: unknown): boolean {
  const body = (error as { body?: unknown } | null | undefined)?.body as { error?: unknown } | null | undefined;
  const code = body && typeof body === 'object' && typeof body.error === 'string' ? body.error : '';
  return code === 'TASK_NOT_OPEN' || code === 'TASK_NOT_RESUMABLE' || code === 'TASK_NOT_WAITING' || code === 'ALREADY_ANSWERED';
}

export type AccountBindStep =
  /** More than one account is connected for the app: the owner picks one. */
  | { step: 'choose'; accounts: ProjectAccountChoice[] }
  /** Nothing is connected for the app; connecting happens on the Mac. */
  | { step: 'not_connected' }
  /** Another account of this app is already bound: confirm, then replace. */
  | { step: 'conflict'; bound: { accountId: string; label: string } }
  | { step: 'failed'; message: string };

function accountChoices(value: unknown): ProjectAccountChoice[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const choices: ProjectAccountChoice[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const accountId = typeof (row as { accountId?: unknown }).accountId === 'string' ? (row as { accountId: string }).accountId.trim() : '';
    if (!accountId || seen.has(accountId)) continue;
    seen.add(accountId);
    const label = typeof (row as { label?: unknown }).label === 'string' ? (row as { label: string }).label.trim() : '';
    choices.push({ accountId, label: label || 'Connected account' });
  }
  return choices;
}

/** What a refused account binding asks of the owner next. */
export function accountBindStep(error: unknown): AccountBindStep {
  const body = (error as { body?: unknown } | null | undefined)?.body as Record<string, unknown> | null | undefined;
  const code = body && typeof body === 'object' && typeof body.error === 'string' ? body.error : '';
  if (code === 'ACCOUNT_CHOICE_REQUIRED') {
    const accounts = accountChoices(body?.accounts);
    // A choice with nothing to choose from is the same as nothing connected.
    return accounts.length > 0 ? { step: 'choose', accounts } : { step: 'not_connected' };
  }
  if (code === 'ACCOUNT_NOT_CONNECTED') return { step: 'not_connected' };
  if (code === 'CONFLICTING_ACCOUNT') {
    const bound = body?.bound as { accountId?: unknown; label?: unknown } | undefined;
    const accountId = typeof bound?.accountId === 'string' ? bound.accountId : '';
    const label = typeof bound?.label === 'string' && bound.label.trim() ? bound.label.trim() : 'another account';
    return { step: 'conflict', bound: { accountId, label } };
  }
  return { step: 'failed', message: refusalWords(error, 'That account could not be added. Try again.') };
}

/**
 * The same failure, with words the owner can read as its message. A screen's
 * notice prints a failure's message, so a refusal's name must not be it; the
 * "can't reach your Mac" fact travels unchanged.
 */
export function inWords(error: unknown, fallback: string): Error {
  const source = (error ?? {}) as { offline?: boolean; status?: number; body?: unknown };
  const plain = new Error(refusalWords(error, fallback)) as Error & { offline?: boolean; status?: number; body?: unknown };
  if (source.offline) plain.offline = true;
  if (typeof source.status === 'number') plain.status = source.status;
  if (source.body !== undefined) plain.body = source.body;
  return plain;
}
