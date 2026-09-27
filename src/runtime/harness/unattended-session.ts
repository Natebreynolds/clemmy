import { getSession, listEvents } from './eventlog.js';

/** An unattended run has no human to answer an infra ask. Signalled by the run
 *  session id prefix (`workflow:` / `background:`) — the robust allocation-time
 *  signal — with an execution-kind fallback. Interactive sessions are attended,
 *  UNLESS the turn currently failing was daemon-driven: a synthetic directive
 *  (a proactive report-back relay) runs ON the chat session, and asking the
 *  user "retry / switch / stop?" about a turn they never sent is noise — the
 *  passive outcome staging already guarantees the content. Fail quiet; the
 *  deferred-report queue and the passive turn remain the floor. */
export function isUnattendedSession(sessionId: string): boolean {
  if (sessionId.startsWith('workflow:') || sessionId.startsWith('background:')) return true;
  try {
    if (getSession(sessionId)?.kind === 'execution') return true;
  } catch { return false; }
  try {
    const lastInput = listEvents(sessionId, { types: ['user_input_received'], desc: true, limit: 1 })[0];
    return (lastInput?.data as { synthetic?: boolean } | undefined)?.synthetic === true;
  } catch { return false; }
}
