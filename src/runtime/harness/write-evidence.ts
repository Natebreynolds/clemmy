/** Canonical pure write-ledger resolution. Reading does not reconcile or replay effects. */
import type { EventRow } from './eventlog.js';

export interface ResolvedWriteEvidence {
  confirmed: EventRow[];
  /** Successful calls explicitly acknowledged as no change; never a new write. */
  unchanged: EventRow[];
  /** Reservations whose exact call recorded a proved not-applied terminal.
   * Kept separate from `uncertain` so settlement/finalization can distinguish
   * a reconciled absence from an effect whose provider outcome is still
   * unknown. */
  failed: EventRow[];
  uncertain: EventRow[];
}

export function writeEvidenceEventText(data: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function writeEvidenceCallId(event: EventRow): string {
  return writeEvidenceEventText(event.data, 'canonicalCallId', 'callId');
}

function writeShape(event: EventRow): string {
  return writeEvidenceEventText(event.data, 'shapeKey', 'slug', 'toolName', 'tool').toLowerCase();
}

function writeTargets(event: EventRow): string[] {
  const value = event.data.targets;
  if (!Array.isArray(value)) return [];
  return value
    .filter((target): target is string => typeof target === 'string' && target.trim().length > 0)
    .map((target) => target.trim().toLowerCase())
    .sort();
}

function sameWriteAttempt(
  attempt: EventRow,
  resolution: EventRow,
  options: { allowUnparentedPreDispatch: boolean },
): boolean {
  const attemptCallId = writeEvidenceCallId(attempt);
  const resolutionCallId = writeEvidenceCallId(resolution);
  // A new reservation must settle the exact call it reserved. Falling back to
  // shape/targets can let a terminal event from another invocation settle it.
  // Reused SDK call ids exist in historical data, so a parented terminal must
  // also name the exact reservation event. An unparented compatibility receipt
  // is accepted only while exactly one reservation owns that call id.
  if (attempt.data.preDispatch === true) {
    if (!attemptCallId || !resolutionCallId || attemptCallId !== resolutionCallId) return false;
    return resolution.parentEventId
      ? resolution.parentEventId === attempt.id
      : options.allowUnparentedPreDispatch;
  }
  if (resolution.parentEventId && resolution.parentEventId !== attempt.id) return false;
  // Legacy rows predate reliable correlation ids. Preserve their historical
  // shape/target reconciliation when one side lacks an id.
  if (attemptCallId && resolutionCallId) return attemptCallId === resolutionCallId;

  const attemptShape = writeShape(attempt);
  const resolutionShape = writeShape(resolution);
  if (!attemptShape || !resolutionShape || attemptShape !== resolutionShape) return false;
  const attemptTargets = writeTargets(attempt);
  const resolutionTargets = writeTargets(resolution);
  if (attemptTargets.length === 0 || resolutionTargets.length === 0) return true;
  return attemptTargets.length === resolutionTargets.length
    && attemptTargets.every((target, index) => target === resolutionTargets[index]);
}

/**
 * New `preDispatch` external-write rows are reservations, not completion
 * evidence. They become confirmed only when the exact same call records
 * `external_write_succeeded`; failure proves no dispatch, while an orphan
 * remains uncertain. Legacy rows without `preDispatch` keep their historical
 * success meaning. Process in sequence order so one invocation cannot settle
 * another retry of the same action.
 */
export function resolveWriteEvidence(events: readonly EventRow[]): ResolvedWriteEvidence {
  const attempts: Array<{
    event: EventRow;
    state: 'pending' | 'confirmed' | 'unchanged' | 'failed' | 'uncertain' | 'conflicted';
    decisive: boolean;
  }> = [];
  const unmatchedOrphans: EventRow[] = [];
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.type === 'external_write') {
      attempts.push({
        event,
        state: event.data.preDispatch === true ? 'pending' : 'confirmed',
        // A legacy reservation without preDispatch historically carried
        // provisional success meaning. A later explicit terminal may still
        // correct it; only a terminal makes the state decisive.
        decisive: false,
      });
      continue;
    }
    if (
      event.type !== 'external_write_succeeded'
      && event.type !== 'external_write_failed'
      && event.type !== 'external_write_orphaned'
    ) continue;
    const resolutionCallId = writeEvidenceCallId(event);
    const matchingPreDispatchReservations = resolutionCallId
      ? attempts.filter((attempt) => (
          attempt.event.data.preDispatch === true
          && writeEvidenceCallId(attempt.event) === resolutionCallId
        )).length
      : 0;
    let match = -1;
    for (let index = attempts.length - 1; index >= 0; index -= 1) {
      if (sameWriteAttempt(attempts[index]!.event, event, {
        allowUnparentedPreDispatch: !event.parentEventId && matchingPreDispatchReservations === 1,
      })) {
        match = index;
        break;
      }
    }
    if (match >= 0) {
      const attempt = attempts[match]!;
      if (event.type === 'external_write_orphaned') {
        // Orphan records an ambiguity observation. Once the exact reservation
        // has a decisive success/failure, an older or racing orphan can never
        // downgrade that truth.
        if (!attempt.decisive) {
          attempt.state = 'uncertain';
        }
      } else if (event.type === 'external_write_succeeded') {
        const nextState = event.data.observedEffect === 'none' ? 'unchanged' : 'confirmed';
        if ((attempt.decisive && attempt.state !== nextState) || attempt.state === 'conflicted') {
          attempt.state = 'conflicted';
        } else {
          attempt.state = nextState;
          attempt.decisive = true;
        }
      } else if (((attempt.state === 'confirmed' || attempt.state === 'unchanged') && attempt.decisive) || attempt.state === 'conflicted') {
        attempt.state = 'conflicted';
      } else {
        attempt.state = 'failed';
        attempt.decisive = true;
      }
    } else if (event.type === 'external_write_orphaned') {
      // A few legacy transports emitted only the timeout row. Preserve that
      // uncertainty instead of dropping the only durable evidence.
      unmatchedOrphans.push(event);
    }
  }
  return {
    confirmed: attempts.filter((attempt) => attempt.state === 'confirmed').map((attempt) => attempt.event),
    unchanged: attempts.filter((attempt) => attempt.state === 'unchanged').map((attempt) => attempt.event),
    failed: attempts.filter((attempt) => attempt.state === 'failed').map((attempt) => attempt.event),
    uncertain: [
      ...attempts
        .filter((attempt) => (
          attempt.state === 'pending'
          || attempt.state === 'uncertain'
          || attempt.state === 'conflicted'
        ))
        .map((attempt) => attempt.event),
      ...unmatchedOrphans,
    ],
  };
}
