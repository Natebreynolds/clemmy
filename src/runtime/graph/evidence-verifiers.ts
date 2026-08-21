/**
 * Manifest-owned evidence verifiers. Required kinds must resolve to a
 * registered verifier. Unsupported kinds fail closed.
 */
import type { GoalEvidenceObservation, GoalEvidenceVerdict } from './goal-evidence.js';
import type { TurnGraphIR } from './turn-graph-ir.js';

export interface EvidenceVerifierV1 {
  kind: string;
  verify(input: {
    graph: TurnGraphIR;
    observation: GoalEvidenceObservation;
  }): GoalEvidenceVerdict | null;
}

const verifiers = new Map<string, EvidenceVerifierV1>();

export function registerEvidenceVerifier(verifier: EvidenceVerifierV1): void {
  verifiers.set(verifier.kind, verifier);
}

export function peekEvidenceVerifier(kind: string): EvidenceVerifierV1 | null {
  return verifiers.get(kind) ?? null;
}

export function listEvidenceVerifierKinds(): readonly string[] {
  return [...verifiers.keys()];
}

function incomplete(reason: string, repair: 'retry' | 'add-read-node' | 'rebind-schema' = 'retry'): GoalEvidenceVerdict {
  return { status: 'incomplete', reason, repair };
}

function verifyCollection(input: {
  graph: TurnGraphIR;
  observation: GoalEvidenceObservation;
}): GoalEvidenceVerdict | null {
  const collection = input.graph.classification.goalConstraints?.collection;
  if (!collection || collection.count < 1) return null;
  const records = input.observation.records;
  if (records) {
    const distinct = new Set(records.map((record) => JSON.stringify(record))).size;
    if (distinct !== records.length) {
      return incomplete('collection members are not distinct');
    }
    if (distinct !== (input.observation.collectedCount ?? distinct)) {
      return incomplete('collectedCount does not match distinct record identity');
    }
    for (const [index, record] of records.entries()) {
      const missing = collection.projection.filter((role) => !(role in record) || record[role] == null || record[role] === '');
      if (missing.length > 0) {
        return incomplete(`record ${index} missing required projection: ${missing.join(', ')}`, 'rebind-schema');
      }
    }
  }
  const got = input.observation.collectedCount ?? records?.length ?? 0;
  if (got < collection.count) {
    const sourceOnly = input.observation.sourceLocated === true && got === 0;
    return {
      status: 'incomplete',
      reason: sourceOnly
        ? 'source located; collection not yet retrieved'
        : `collection requires ${collection.count} members; observed ${got}`,
      repair: sourceOnly ? 'add-read-node' : 'retry',
    };
  }
  const missing = collection.projection.filter((role) => (
    !(input.observation.projectionPresent ?? []).includes(role)
  ));
  if (missing.length > 0) {
    return incomplete(`missing required projection: ${missing.join(', ')}`, 'rebind-schema');
  }
  return { status: 'done' };
}

function verifyCreateReceipt(input: {
  graph: TurnGraphIR;
  observation: GoalEvidenceObservation;
}): GoalEvidenceVerdict | null {
  const sinks = input.observation.sinks;
  if (sinks && sinks.length > 0) {
    const missing = sinks.find((sink) => !sink.createReceiptId && !sink.createdArtifactId);
    if (missing) {
      return incomplete(`destination ${missing.family} has no exact created id`);
    }
    return { status: 'done' };
  }
  if (!input.observation.createReceiptId && !input.observation.createdArtifactId) {
    return incomplete('destination artifact has no exact created id');
  }
  return { status: 'done' };
}

function verifyReadback(input: {
  observation: GoalEvidenceObservation;
}): GoalEvidenceVerdict | null {
  const sinks = input.observation.sinks;
  if (sinks && sinks.length > 0) {
    const missing = sinks.find((sink) => sink.readbackVerified !== true || sink.readbackContent === undefined);
    if (missing) {
      return incomplete(`destination ${missing.family} is not verified by exact-id content readback`);
    }
    return { status: 'done' };
  }
  if (input.observation.readbackVerified !== true || input.observation.readbackContent === undefined) {
    return incomplete('create is not verified by exact-id content readback');
  }
  return { status: 'done' };
}

function verifyHandle(input: {
  graph: TurnGraphIR;
  observation: GoalEvidenceObservation;
}): GoalEvidenceVerdict | null {
  const required = (input.graph.classification.goalConstraints?.destinations
    ?? (input.graph.classification.goalConstraints?.destination
      ? [input.graph.classification.goalConstraints.destination]
      : [])).filter((sink) => sink.handleRequired);
  if (required.length === 0) return { status: 'done' };
  const sinks = input.observation.sinks;
  if (sinks && sinks.length > 0) {
    const missing = required.find((sink) => !sinks.some((observed) => (
      observed.family === sink.family && Boolean(observed.artifactHandle)
    )));
    if (missing) return incomplete(`verified artifact handle is missing for ${missing.family}`);
    return { status: 'done' };
  }
  if (!input.observation.artifactHandle) {
    return incomplete('verified artifact handle is missing');
  }
  return { status: 'done' };
}

function verifyLineage(input: {
  observation: GoalEvidenceObservation;
}): GoalEvidenceVerdict | null {
  if (input.observation.lineagePresent === false) {
    return incomplete('transform lineage is missing');
  }
  return { status: 'done' };
}

function verifyPayload(): GoalEvidenceVerdict | null {
  return { status: 'done' };
}

function verifySourceLocator(input: {
  observation: GoalEvidenceObservation;
}): GoalEvidenceVerdict | null {
  if (input.observation.sourceLocated === false) {
    return incomplete('source locator is missing', 'add-read-node');
  }
  return { status: 'done' };
}

const builtins: EvidenceVerifierV1[] = [
  { kind: 'collection', verify: verifyCollection },
  { kind: 'create_receipt', verify: verifyCreateReceipt },
  { kind: 'create-receipt', verify: verifyCreateReceipt },
  { kind: 'readback', verify: verifyReadback },
  { kind: 'exact_readback', verify: verifyReadback },
  { kind: 'artifact_handle', verify: verifyHandle },
  { kind: 'receipt', verify: verifyCreateReceipt },
  { kind: 'payload', verify: verifyPayload },
  { kind: 'lineage', verify: verifyLineage },
  { kind: 'source_locator', verify: verifySourceLocator },
  { kind: 'source-locator', verify: verifySourceLocator },
];

for (const verifier of builtins) registerEvidenceVerifier(verifier);

export function verifyRequiredEvidence(input: {
  graph: TurnGraphIR;
  observation: GoalEvidenceObservation;
  requiredKinds: readonly string[];
}): GoalEvidenceVerdict {
  for (const kind of [...new Set(input.requiredKinds)]) {
    const verifier = peekEvidenceVerifier(kind);
    if (!verifier) {
      return {
        status: 'incomplete',
        reason: `unsupported evidence verifier: ${kind}`,
        repair: 'rebind-schema',
      };
    }
    const verdict = verifier.verify(input);
    if (verdict && verdict.status !== 'done') return verdict;
  }
  return { status: 'done' };
}
