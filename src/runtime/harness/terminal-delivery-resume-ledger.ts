/**
 * The terminal delivery judge may send a turn back ONCE to close a gap it
 * found (a RESUME verdict). That "once" used to live in a variable local to
 * one activation; when the resumed turn ran as a fresh activation (a held
 * turn woken by checkpoint recovery, an approval resume), the counter started
 * at zero again and the judge resumed the same source nine times in a row
 * (live 2026-10-06: 223 s, nine judge rounds, every one "fulfilled", ended
 * blocked). The journal is the only memory that survives an activation.
 */
import { openEventLog } from './eventlog.js';

export const TERMINAL_DELIVERY_RESUME_HEARTBEAT = 'terminal_delivery_resume' as const;

/** Whether this accepted source has already been resumed by the delivery judge. */
export function priorTerminalDeliveryResumes(sessionId: string, sourceUserSeq: number | undefined): 0 | 1 {
  // An unbound legacy activation cannot establish an unused allowance.
  if (!sessionId || !Number.isSafeInteger(sourceUserSeq) || (sourceUserSeq ?? 0) <= 0) return 1;
  try {
    const resumed = openEventLog().prepare(`
      SELECT 1 FROM events
      WHERE session_id = ? AND type = 'heartbeat'
        AND json_extract(data_json, '$.kind') = ?
        AND json_extract(data_json, '$.sourceUserSeq') = ?
      LIMIT 1
    `).get(sessionId, TERMINAL_DELIVERY_RESUME_HEARTBEAT, sourceUserSeq);
    return resumed ? 1 : 0;
  } catch {
    // An unreadable journal must not buy the judge another resume.
    return 1;
  }
}
