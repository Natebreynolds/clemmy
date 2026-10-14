import type { ChatMessage } from './types.js';

/** A convenience for the owner's next message, never permission to repeat an
 * outside effect. The caller must also own the latest, idle reply target.
 * Questions, approvals, recovery notices and uncertain changes keep their own
 * controls. Nothing is inferred from the model's prose or a legacy stop. */
export function canContinueTerminal(message: Pick<ChatMessage,
  'role' | 'status' | 'terminal' | 'options' | 'approval' | 'planProposalId' | 'planArtifactRef'>): boolean {
  const terminal = message.terminal;
  if (message.role !== 'assistant' || message.status !== 'awaiting-reply'
    || message.options?.length || message.approval || message.planProposalId || message.planArtifactRef
    || !terminal || terminal.status !== 'needs_input' || terminal.resumable !== true
    || terminal.notice) return false;
  if (terminal.kind !== 'continue' || terminal.needs !== 'continue') return false;
  const outside = terminal.retained?.outsideChange;
  return outside !== 'uncertain' && outside !== 'mixed' && outside !== 'refused';
}

/** Recheck after asynchronous conversation preparation. A stale click must
 * not answer a replacement terminal, even when it reused the bubble's id. */
type ContinueMessage = Pick<ChatMessage, 'id' | 'role' | 'status' | 'terminal' | 'options'
  | 'approval' | 'planProposalId' | 'planArtifactRef' | 'acceptedSource' | 'taskMode'>;

export function sameTerminalContinuation(expected: ContinueMessage, current: ContinueMessage | undefined): boolean {
  return Boolean(current && expected.id === current.id
    && canContinueTerminal(expected) && canContinueTerminal(current)
    && JSON.stringify(expected.acceptedSource) === JSON.stringify(current.acceptedSource)
    && JSON.stringify(expected.terminal) === JSON.stringify(current.terminal)
    && JSON.stringify(expected.taskMode) === JSON.stringify(current.taskMode));
}

/** A click is latched synchronously, including two clicks in one render. A
 * successful send stays latched for this terminal; a rejected send can retry.
 * Surfaces mount a new gate for each distinct message, never reset it on a
 * rerender or use its state as proof that any task effect has happened. */
export class TerminalContinueGate {
  private state: 'idle' | 'sending' | 'sent' = 'idle';

  get phase(): 'idle' | 'sending' | 'sent' { return this.state; }

  async run(send: () => Promise<void> | void): Promise<boolean> {
    if (this.state !== 'idle') return false;
    this.state = 'sending';
    try {
      await send();
      this.state = 'sent';
      return true;
    } catch (error) {
      this.state = 'idle';
      throw error;
    }
  }
}
