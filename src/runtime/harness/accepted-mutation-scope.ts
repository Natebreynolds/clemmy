/**
 * Accepted mutation scope — bind every mutation to the job the owner accepted.
 *
 * THE FAILURE THIS EXISTS FOR. Live 2026-09-07, source 142281: the owner asked
 * Clem to CREATE a workflow. The name already existed, so the create returned a
 * known non-write. Clem then called `workflow_update` on that pre-existing
 * workflow and changed it — receipt 142367 shows a 769-byte file becoming 755
 * bytes. The call was correctly source-bound, schema-valid and consistent with
 * its own coverage, because graphless consent DERIVES that coverage from the
 * proposed call itself. Exact consistency with yourself is not permission.
 *
 * The independent fact this compares against is the scope the source's FIRST
 * accepted mutation froze, plus what that source has actually built. A later
 * call cannot widen it by proposing something wider.
 *
 * Deliberately NOT how this works: no reading of the owner's words, no tool-name
 * list, no argument field names, no mandatory Plan, no same-family permission,
 * and no blanket ban on updates after creates. The inputs are typed descriptor
 * facts the registry already declares plus durable settlement outcomes.
 */
import { appendEvent, listEvents, openEventLog } from './eventlog.js';

export type MutationScopeBasis =
  /** Nothing was frozen yet; this call becomes the source's accepted scope. */
  | 'first_accepted_mutation'
  /** Creating something new is bounded by its own duplicate/consent checks. */
  | 'create_new'
  /** The frozen scope already covers this posture for this deliverable kind. */
  | 'within_accepted_scope'
  /** This source successfully created this kind of artifact; editing its own
   *  work is the same job, not a new one. */
  | 'created_by_this_source'
  /** The owner sent a further instruction after the scope was frozen. */
  | 'owner_amendment';

export type MutationScopeVerdict =
  | { allowed: true; basis: MutationScopeBasis }
  | { allowed: false; reason: 'outside_accepted_scope'; detail: string };

const SCOPE_EVENT = 'accepted_mutation_scope';

interface FrozenScope {
  seq: number;
  postures: Set<string>;
  deliverableKinds: Set<string>;
}

function frozenScopeFor(sessionId: string, sourceUserSeq: number): FrozenScope | null {
  const rows = listEvents(sessionId, { types: [SCOPE_EVENT] })
    .filter((row) => row.data.sourceUserSeq === sourceUserSeq);
  if (rows.length === 0) return null;
  const postures = new Set<string>();
  const deliverableKinds = new Set<string>();
  for (const row of rows) {
    const posture = row.data.destinationPosture;
    const kind = row.data.deliverableKind;
    if (typeof posture === 'string') postures.add(posture);
    if (typeof kind === 'string') deliverableKinds.add(kind);
  }
  return { seq: rows[0]!.seq, postures, deliverableKinds };
}

/**
 * Has this source SUCCESSFULLY created an artifact of this kind?
 *
 * Settlement outcome is the point: source 142281's create returned a duplicate
 * non-write, so it built nothing and its later patch of a pre-existing artifact
 * had no lineage to stand on. An admitted-but-failed create must not become a
 * licence to edit whatever was already there.
 */
function sourceCreatedDeliverable(
  sessionId: string,
  sourceUserSeq: number,
  deliverableKind: string,
): boolean {
  try {
    const rows = listEvents(sessionId, { types: [SCOPE_EVENT] })
      .filter((row) => row.data.sourceUserSeq === sourceUserSeq
        && row.data.destinationPosture === 'create_new'
        && row.data.deliverableKind === deliverableKind
        && typeof row.data.logicalToolCallId === 'string');
    if (rows.length === 0) return false;
    const ids = rows.map((row) => row.data.logicalToolCallId as string);
    const placeholders = ids.map(() => '?').join(',');
    const settled = openEventLog().prepare(
      `SELECT 1 AS ok FROM logical_call_settlements
        WHERE session_id = ? AND source_user_seq = ?
          AND logical_tool_call_id IN (${placeholders})
          AND outcome_kind = 'succeeded'
        LIMIT 1`,
    ).get(sessionId, sourceUserSeq, ...ids) as { ok?: number } | undefined;
    return Boolean(settled?.ok);
  } catch {
    // An unreadable ledger is not proof of lineage. Fail closed: the model can
    // still explain the collision and ask, which is the honest endpoint.
    return false;
  }
}

/** An owner instruction adopted AFTER the scope was frozen re-opens the job. */
function amendmentAfter(sessionId: string, sourceUserSeq: number, seq: number): boolean {
  try {
    return listEvents(sessionId, { types: ['user_steer_note'] })
      .some((row) => row.seq > seq && row.seq > sourceUserSeq);
  } catch {
    return false;
  }
}

/**
 * Admit one proposed mutation against the accepted scope, recording it when it
 * is the scope-setting call. Returns a verdict; it mints no authority.
 */
export function admitMutationIntoAcceptedScope(input: {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  logicalToolCallId: string;
  operationId: string;
  deliverableKind: string;
  destinationPosture: string;
}): MutationScopeVerdict {
  const record = (basis: MutationScopeBasis): MutationScopeVerdict => {
    try {
      appendEvent({
        sessionId: input.sessionId,
        turn: input.turn,
        role: 'system',
        type: SCOPE_EVENT,
        data: {
          sourceUserSeq: input.sourceUserSeq,
          logicalToolCallId: input.logicalToolCallId,
          operationId: input.operationId,
          deliverableKind: input.deliverableKind,
          destinationPosture: input.destinationPosture,
          basis,
        },
      });
    } catch { /* the verdict stands; the audit row is best-effort */ }
    return { allowed: true, basis };
  };

  const frozen = frozenScopeFor(input.sessionId, input.sourceUserSeq);
  if (!frozen) return record('first_accepted_mutation');

  // Creating something NEW is not a scope expansion over someone else's work:
  // its own duplicate and consent checks bound it.
  if (input.destinationPosture === 'create_new') return record('create_new');

  if (frozen.postures.has(input.destinationPosture)
    && frozen.deliverableKinds.has(input.deliverableKind)) {
    return record('within_accepted_scope');
  }

  if (sourceCreatedDeliverable(input.sessionId, input.sourceUserSeq, input.deliverableKind)) {
    return record('created_by_this_source');
  }

  if (amendmentAfter(input.sessionId, input.sourceUserSeq, frozen.seq)) {
    return record('owner_amendment');
  }

  return {
    allowed: false,
    reason: 'outside_accepted_scope',
    detail: `this job accepted ${[...frozen.postures].join('/')} work on `
      + `${[...frozen.deliverableKinds].join('/')}; a ${input.destinationPosture} `
      + `change to an existing ${input.deliverableKind} it did not create is a different instruction`,
  };
}
