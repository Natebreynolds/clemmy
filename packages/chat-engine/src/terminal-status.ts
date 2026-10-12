/**
 * The app's own status line under a turn: the pill for how the turn ended,
 * what it kept, what happened in another app, and the notice for a turn no
 * model spoke for (or, for a format notice, beside the draft Clem wrote).
 * Desktop and phone draw these from one place so they never disagree.
 *
 * This is chrome, not Clem. Nothing here says "I", and nothing here is ever
 * shown as her reply or read aloud as her words.
 */
import type { ChatMessage, TerminalFacts, TerminalRetained } from './types.js';

export type TerminalStatusTone = 'info' | 'warning' | 'danger' | 'neutral';

export interface TerminalStatusPill {
  label: string;
  tone: TerminalStatusTone;
}

const CONTINUE_EDGE = 'say “continue” to pick up';

/** "3 results kept", or '' when nothing was kept. */
export function retainedResultsPhrase(retained: TerminalRetained | undefined): string {
  const n = retained?.results ?? 0;
  return n > 0 ? `${n} ${n === 1 ? 'result' : 'results'} kept` : '';
}

/**
 * The pill for a typed terminal, with what it kept appended. `wordless` says
 * the turn shows no reply: a stop the owner did not choose then names its next
 * edge on the pill, since there are no words of Clem's to carry one. A plain
 * question and a finished answer have no shared pill: each surface draws its
 * own reply prompt, and a finished answer needs none.
 */
export function terminalStatusPill(
  terminal: TerminalFacts | undefined,
  options: { wordless?: boolean } = {},
): TerminalStatusPill | null {
  if (!terminal) return null;
  const kept = retainedResultsPhrase(terminal.retained);
  const parts = (...items: string[]) => items.filter(Boolean).join(' · ');
  const edge = options.wordless && terminal.resumable !== false ? CONTINUE_EDGE : '';
  switch (terminal.status) {
    case 'blocked':
      return { label: parts(kept ? `Stopped here — ${kept}` : 'Stopped here — your work is kept', edge), tone: 'warning' };
    case 'failed':
      return { label: parts('Didn’t finish', kept, edge), tone: 'danger' };
    case 'uncertain':
      return { label: parts('Outcome uncertain — check before repeating', kept), tone: 'warning' };
    case 'cancelled':
      return { label: parts('Cancelled', kept), tone: 'neutral' };
    case 'transferred':
      return { label: parts('Handed off', kept), tone: 'neutral' };
    case 'needs_input':
      if (terminal.kind === 'continue' || terminal.needs === 'continue') {
        return { label: parts('Paused — say “continue” to pick up', kept), tone: 'info' };
      }
      if (terminal.kind === 'approval') return { label: 'Waiting for your approval', tone: 'info' };
      return null;
    case 'done':
      return null;
  }
}

/** What happened in another app, when the turn's retained facts say. An
 *  uncertain outside change on an uncertain turn is already the pill. */
export function retainedOutsideChange(terminal: TerminalFacts | undefined): TerminalStatusPill | null {
  switch (terminal?.retained?.outsideChange) {
    case 'went_through': return { label: 'Change in another app went through', tone: 'neutral' };
    case 'did_not': return { label: 'Change in another app didn’t go through', tone: 'warning' };
    case 'mixed': return { label: 'Some changes in other apps went through', tone: 'warning' };
    case 'refused': return { label: 'Another app turned the change down', tone: 'warning' };
    case 'uncertain':
      return terminal.status === 'uncertain'
        ? null
        : { label: 'Change in another app not confirmed — check before repeating', tone: 'warning' };
    default: return null;
  }
}

/** What the owner can do about a notice. A surface offers only the actions it
 *  can perform; "Try again" sends those words as the owner's next message. */
export type TerminalNoticeAction = 'change_model' | 'sign_in' | 'add_credit' | 'try_again';

export const NOTICE_ACTION_LABEL: Record<TerminalNoticeAction, string> = {
  change_model: 'Change model',
  sign_in: 'Sign in',
  add_credit: 'Add credit',
  try_again: 'Try again',
};

export interface TerminalNoticeLine {
  label: string;
  tone: TerminalStatusTone;
  /** The provider's own words, labelled as the provider's. */
  detail?: string;
  action?: TerminalNoticeAction;
}

/**
 * The status line for a notice terminal, in the app's voice. Null for a stop
 * the owner asked for (the pill says it) and for a card decision (the card
 * says it), and for a terminal with no notice.
 */
export function terminalNoticeLine(terminal: TerminalFacts | undefined): TerminalNoticeLine | null {
  const notice = terminal?.notice;
  if (!notice) return null;
  const model = notice.model;
  const kept = retainedResultsPhrase(terminal.retained);
  const line = (label: string, tone: TerminalStatusTone, action?: TerminalNoticeAction): TerminalNoticeLine => ({
    label: kept ? `${label} · ${kept}` : label,
    tone,
    ...(notice.providerSaid ? { detail: `The provider said: ${notice.providerSaid}` } : {}),
    ...(action ? { action } : {}),
  });
  switch (notice.code) {
    case 'stopped':
    case 'card_decision':
      return null;
    case 'response_format_unmet':
      return line('Not in the format you asked for — say “continue” to have it fixed', 'warning');
    case 'response_format_unqualified':
      return line('The format you asked for wasn’t confirmed — say “continue” to have it checked', 'warning');
    case 'provider_quota':
      return line(`${model ?? 'This model'} reached its usage limit`, 'warning', 'change_model');
    case 'saved_model_unavailable': {
      const owner = notice.agentName ? `${notice.agentName}’s saved model` : 'The saved model';
      return line(`${owner}${model ? `, ${model},` : ''} isn’t available`, 'warning', 'change_model');
    }
    case 'model_unavailable_on_sign_in':
      return line(`${model ?? 'This model'} isn’t available on the current sign-in`, 'warning', 'change_model');
    case 'no_model_connected':
      return line('No model is connected', 'warning', 'change_model');
    case 'codex_sign_in_expired':
      return line('The Codex sign-in expired', 'warning', 'sign_in');
    case 'provider_out_of_credit':
      return line(model ? `The account behind ${model} is out of credit` : 'The model account is out of credit', 'danger', 'add_credit');
    case 'model_stalled':
      return line(`${model ?? 'The model'} stopped responding`, 'warning', 'try_again');
    case 'run_failed':
      return line('This run stopped on an error', 'danger', 'try_again');
  }
}

/** A card decision's acknowledgement with nothing else to show: the card
 *  already carries the decision, so the conversation draws nothing. */
export function cardDecisionNoticeOnly(message: Pick<ChatMessage, 'terminal' | 'text' | 'activity' | 'status'>): boolean {
  return message.terminal?.notice?.code === 'card_decision'
    && !message.text.trim()
    && !(message.activity?.length)
    && message.status !== 'failed';
}

/**
 * What live voice is told when the request it is waiting on ends on a notice:
 * the typed fact (the code, the model or agent it names, the provider's own
 * words, the action on screen, what was kept), never the notice's wording, so
 * the voice tells the owner in its own words and the request is not left in
 * silence. Null for a stop the owner chose and for a card decision, which need
 * no explaining, and for a terminal with no notice.
 */
export function terminalNoticeVoiceFact(terminal: Pick<TerminalFacts, 'notice' | 'retained'> | undefined): string | null {
  const notice = terminal?.notice;
  if (!notice || notice.code === 'stopped' || notice.code === 'card_decision') return null;
  const named = [
    notice.model ? `model: ${notice.model}` : '',
    notice.agentName ? `agent: ${notice.agentName}` : '',
  ].filter(Boolean).join('; ');
  const action = terminalNoticeLine({ status: 'failed', notice })?.action;
  const kept = retainedResultsPhrase(terminal?.retained);
  return [
    `App status for this request, not Clem's words: ${notice.code}${named ? ` (${named})` : ''}.`,
    notice.providerSaid ? `The provider said: ${notice.providerSaid}` : '',
    action ? `On screen the owner can choose ${NOTICE_ACTION_LABEL[action]}.` : '',
    kept ? `${kept[0]!.toUpperCase()}${kept.slice(1)}.` : '',
    'Tell the owner briefly, in your own words.',
  ].filter(Boolean).join(' ');
}
