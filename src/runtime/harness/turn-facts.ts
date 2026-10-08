/**
 * Facts the harness knows about the turn that is about to run, as transient
 * system context for the brain. Facts only: the harness never writes the
 * sentence the owner reads (owner 2026-10-08: "Clem is driving the harness;
 * the harness is just the vehicle").
 */
import { peekTaskContinuityPacket } from '../../memory/task-continuity.js';
import * as approvalRegistry from './approval-registry.js';
import { listEvents } from './eventlog.js';

/** Nothing is waiting on the owner and their last turn ended done: a bare
 * "yes" or "go ahead" now approves nothing. The brain reads that as a fact
 * and answers in its own words instead of inventing work (live 2026-10-08:
 * a stray "Yes, go ahead." after a finished append rewrote the file; another
 * re-ran a finished command). */
export function turnFactsFor(sessionId: string): string | undefined {
  try {
    if (peekTaskContinuityPacket({ sessionId }).status !== 'none') return undefined;
    if (approvalRegistry.listPending({ sessionId, status: 'pending' }).some((row) => approvalRegistry.isActionable(row))) return undefined;
    const last = listEvents(sessionId, { types: ['conversation_completed'], desc: true, limit: 1 })[0];
    const presentation = last?.data.presentation as { status?: unknown; kind?: unknown } | undefined;
    if (presentation?.status === 'cancelled' || presentation?.kind === 'stopped') {
      // The owner pressed Stop: the next turn reads that as their decision,
      // not as a tool that failed with an unknown effect (live 2026-10-08:
      // "it wasn't stopped by you or me" and the count was run again).
      return [
        '[turn-facts:v1]',
        'The owner stopped your previous turn themselves while its work was running; the host ended any command that was still running. That stop is their decision, not a failure to reconcile, and nothing from that turn is owed.',
        'Answer from what the transcript shows was started and stopped; do not restart the stopped work unless they ask for it.',
      ].join('\n');
    }
    if (presentation?.status !== 'done') return undefined;
    return [
      '[turn-facts:v1]',
      'Nothing is waiting on the owner: no open question and no pending card. Your previous turn ended done.',
      'A bare "yes", "go ahead" or "continue" now approves nothing and asks for nothing new: answer it as conversation (what is already done, what you can do next) and do not repeat finished work unless they ask for it.',
    ].join('\n');
  } catch {
    return undefined;
  }
}

