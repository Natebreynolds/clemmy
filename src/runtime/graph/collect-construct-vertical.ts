/**
 * One executable vertical: collect → extract → create → exact-id readback →
 * verify → publish. Other routes may stay shadow. This module owns the host
 * gate: a write is not admitted until collection cardinality and required
 * fields are proven. tool_returned is never success.
 */
import { evaluateGoalEvidence, type GoalEvidenceObservation } from './goal-evidence.js';
import type { TurnGraphIR } from './turn-graph-ir.js';

export type CollectConstructPhase =
  | 'source_read'
  | 'collection_read'
  | 'extract'
  | 'create'
  | 'readback'
  | 'verify'
  | 'publish';

export type VerticalAdmission =
  | { ok: true; next: CollectConstructPhase }
  | { ok: false; reason: string; next: CollectConstructPhase };

const PHASE_ORDER: CollectConstructPhase[] = [
  'source_read',
  'collection_read',
  'extract',
  'create',
  'readback',
  'verify',
  'publish',
];

export function nextCollectConstructPhase(
  current: CollectConstructPhase,
): CollectConstructPhase | null {
  const index = PHASE_ORDER.indexOf(current);
  return index >= 0 && index < PHASE_ORDER.length - 1 ? PHASE_ORDER[index + 1]! : null;
}

/** Refuse a write when the collection/projection predicates are unmet. */
export function admitConstructWrite(input: {
  graph: TurnGraphIR;
  observation: GoalEvidenceObservation;
}): VerticalAdmission {
  const constraints = input.graph.classification.goalConstraints;
  if (!constraints || constraints.construct === 'none') {
    return { ok: false, reason: 'no construct goal to write', next: 'verify' };
  }
  const beforeWrite: GoalEvidenceObservation = {
    collectedCount: input.observation.collectedCount,
    projectionPresent: input.observation.projectionPresent,
    sourceLocated: input.observation.sourceLocated,
  };
  const collection = constraints.collection;
  if (collection && (collection.count >= 1 || collection.completeness === 'exhaust' || collection.projection.length > 0)) {
    const records = input.observation.records ?? [];
    const identityFields = collection.identityFields ?? [];
    const identityKey = (record: Record<string, unknown>): string => (
      identityFields.length > 0
        ? identityFields.map((field) => JSON.stringify(record[field] ?? null)).join('\0')
        : JSON.stringify(record)
    );
    const distinct = new Set(records.map((record) => identityKey(record))).size;
    if (records.length > 0 && distinct !== records.length) {
      return { ok: false, reason: 'collection members are not distinct', next: 'extract' };
    }
    const got = beforeWrite.collectedCount ?? distinct;
    if (collection.completeness === 'exhaust' && got < 1) {
      return {
        ok: false,
        reason: 'exhaust collection has no proven members before write',
        next: beforeWrite.sourceLocated ? 'collection_read' : 'extract',
      };
    }
    if (collection.count >= 1 && got < collection.count) {
      return {
        ok: false,
        reason: `collection requires ${collection.count} members before write; observed ${got}`,
        next: got === 0 && beforeWrite.sourceLocated ? 'collection_read' : 'extract',
      };
    }
    if (records.length > 0) {
      for (const [index, record] of records.entries()) {
        const missing = collection.projection.filter((role) => (
          !(role in record) || record[role] == null || record[role] === ''
        ));
        if (missing.length > 0) {
          return {
            ok: false,
            reason: `record ${index} missing required projection: ${missing.join(', ')}`,
            next: 'extract',
          };
        }
      }
    } else {
      const missing = collection.projection.filter((role) => (
        !(beforeWrite.projectionPresent ?? []).includes(role)
      ));
      if (missing.length > 0) {
        return {
          ok: false,
          reason: `missing required projection before write: ${missing.join(', ')}`,
          next: 'extract',
        };
      }
    }
  }
  return { ok: true, next: 'create' };
}

export function admitConstructPublish(input: {
  graph: TurnGraphIR;
  observation: GoalEvidenceObservation;
}): VerticalAdmission {
  const verdict = evaluateGoalEvidence(input);
  if (verdict.status === 'done') return { ok: true, next: 'publish' };
  return {
    ok: false,
    reason: verdict.status === 'awaiting' ? verdict.reason : verdict.reason,
    next: verdict.status === 'awaiting' ? 'verify' : 'readback',
  };
}
