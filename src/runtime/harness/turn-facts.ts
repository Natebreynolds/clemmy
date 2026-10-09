/**
 * Facts the harness knows about the turn that is about to run, as transient
 * system context for the brain. Facts only: the harness never writes the
 * sentence the owner reads; Clem drives and the harness is the vehicle.
 */
import { peekTaskContinuityPacket } from '../../memory/task-continuity.js';
import * as approvalRegistry from './approval-registry.js';
import { listEvents } from './eventlog.js';

/** All facts that hold for this session's next turn, or undefined. */
export function turnFactsFor(sessionId: string): string | undefined {
  const facts = [situationFacts(sessionId), voiceFacts(sessionId)].filter((fact): fact is string => Boolean(fact));
  return facts.length ? ['[turn-facts:v1]', ...facts].join('\n') : undefined;
}

/** Nothing is waiting on the owner and their last turn ended done: a bare
 * "yes" or "go ahead" now approves nothing, so the brain answers it in its
 * own words instead of inventing or repeating work. A stop the owner pressed
 * is their decision, not a tool failure with an unknown effect. */
function situationFacts(sessionId: string): string | undefined {
  try {
    if (peekTaskContinuityPacket({ sessionId }).status !== 'none') return undefined;
    if (approvalRegistry.listPending({ sessionId, status: 'pending' }).some((row) => approvalRegistry.isActionable(row))) return undefined;
    const last = listEvents(sessionId, { types: ['conversation_completed'], desc: true, limit: 1 })[0];
    const presentation = last?.data.presentation as { status?: unknown; kind?: unknown } | undefined;
    if (presentation?.status === 'cancelled' || presentation?.kind === 'stopped') {
      return [
        'The owner stopped your previous turn themselves while its work was running; the host ended any command that was still running. That stop is their decision, not a failure to reconcile, and nothing from that turn is owed.',
        'Answer from what the transcript shows was started and stopped; do not restart the stopped work unless they ask for it.',
      ].join('\n');
    }
    if (presentation?.status !== 'done') return undefined;
    return [
      'Nothing is waiting on the owner: no open question and no pending card. Your previous turn ended done.',
      'A bare "yes", "go ahead" or "continue" now approves nothing and asks for nothing new: answer it as conversation (what is already done, what you can do next) and do not repeat finished work unless they ask for it.',
    ].join('\n');
  } catch {
    return undefined;
  }
}

/** The owner spoke this turn in voice mode: the reply will be heard, so it is
 * shaped to be said. Tools, memory and approvals work exactly as in any turn. */
function voiceFacts(sessionId: string): string | undefined {
  try {
    const source = listEvents(sessionId, { types: ['user_input_received'], desc: true, limit: 1 })[0];
    if (source?.data.voice !== true) return undefined;
    return [
      'The owner said this out loud in voice mode and will hear your reply read aloud.',
      'Answer the way you would say it to them: lead with the answer in one to three short sentences of plain speech. No lists, tables, headings, links, code or symbols that read badly aloud; say numbers, dates and names the way a person would.',
      'Use your tools and memory exactly as you would in text. When the full answer is longer than a short spoken reply, give the gist and tell them the rest is on screen. When they ask for work that takes a while, say what you are starting and that you will tell them when it is done.',
    ].join('\n');
  } catch {
    return undefined;
  }
}
