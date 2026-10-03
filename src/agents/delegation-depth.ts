/**
 * Delegation is Clem → lead agent → workers, and no deeper. A worker does one
 * item and starts nothing; a lead running a delegated job runs its own
 * workers but does not hand the job on. Enforced where work starts, so it
 * holds whichever tools a run happens to be shown.
 */
import { getSession } from '../runtime/harness/eventlog.js';

export const WORKER_STARTS_NOTHING = 'A worker does its one item and does not start other workers or tasks. '
  + 'Finish the item and return what is left to the run that started you.';
export const WORKER_DOES_NOT_POST = 'A worker does not post to the conversation or send notifications. '
  + 'Put what you found in your result; the run that started you decides what to say.';
export const LEAD_DOES_NOT_HAND_ON = 'You are leading a job handed to you, so you do not hand it on to another task. '
  + 'Split it into items and run them with run_worker instead.';

/** True inside a run that is itself a job handed to an agent. */
export function sessionIsDelegatedJob(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  try {
    const metadata = getSession(sessionId)?.metadata as Record<string, unknown> | null | undefined;
    return typeof metadata?.delegatedTaskId === 'string' && metadata.delegatedTaskId.length > 0;
  } catch { return false; }
}

/** The delegated task a run is doing, when it is one. */
export function delegatedTaskIdOf(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  try {
    const id = (getSession(sessionId)?.metadata as Record<string, unknown> | null | undefined)?.delegatedTaskId;
    return typeof id === 'string' && id ? id : null;
  } catch { return null; }
}
