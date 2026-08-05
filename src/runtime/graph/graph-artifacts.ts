/**
 * Typed artifact commit and replay verification (R1B/B2).
 *
 * Output and evidence refs were arbitrary strings: a settlement could claim
 * artifacts nobody stored, replay could reuse artifacts whose bytes changed,
 * and nothing bound a ref to the admission, node, and attempt that produced
 * it. This module adds the injected, provider-neutral port that closes that —
 * ADAPTING the existing artifact/evidence stores, never creating a second
 * storage truth.
 *
 * The contract:
 *
 *   - a durable ref binds content digest, store identity, byte length, media
 *     type, scope digest, producing admission/node/attempt, and an immutable
 *     commit id;
 *   - a successful settlement referencing artifacts is durable only after its
 *     refs are committed and verified (the runner decorator runs BEFORE the
 *     executor journals the settlement);
 *   - reuse verifies existence, digest, length, scope, store, and provenance
 *     before descendants become ready;
 *   - raw payloads never cross node boundaries or enter journals — bounded
 *     refs do;
 *   - a missing/altered artifact is NOT automatic redispatch authority: only
 *     a node whose admitted effect class is `read` may rerun; effectful or
 *     unknown nodes refuse with a typed reason;
 *   - content-identical recomputation flows through content-addressed refs,
 *     so unaffected descendants may still reuse.
 *
 * Pure logic over injected ports: no filesystem, no environment, no clock.
 */
import type { GraphAdmission } from './graph-admission.js';
import type { NodeSettledEntry } from './graph-journal.js';
import type { NodeOutcome, NodeRunContext, NodeRunner, ExecutableNode } from './graph-executor.js';

/** The durable commit record an existing store exposes for one ref. */
export interface ArtifactRecord {
  ref: string;
  contentDigest: string;
  storeId: string;
  storeContract: string;
  byteLength: number;
  mediaType: string;
  scopeDigest: string;
  producedBy: { admissionDigest: string; nodeId: string; attemptId: string };
  commitId: string;
}

/** Injected adapter over the EXISTING artifact/evidence stores. */
export interface ArtifactStorePort {
  /** The durable commit record; undefined = never committed. */
  record(ref: string): Promise<ArtifactRecord | undefined>;
  /** Live probe of the currently stored bytes; undefined = bytes missing. */
  stat(ref: string): Promise<{ contentDigest: string; byteLength: number; storeId: string } | undefined>;
}

export type ArtifactFailureKind =
  | 'uncommitted'
  | 'missing'
  | 'altered'
  | 'truncated'
  | 'wrong-scope'
  | 'wrong-producer'
  | 'wrong-store';

export type ArtifactVerification =
  | { ok: true; record: ArtifactRecord }
  | { ok: false; kind: ArtifactFailureKind; reason: string };

export interface ArtifactExpectation {
  admissionDigest: string;
  nodeId: string;
  /** Absent = provenance may come from any attempt of this node/admission
   *  (reuse across activations); present = must be this exact attempt. */
  attemptId?: string;
  scopeDigest?: string;
}

/** Verify one ref against its durable record, live bytes, and expectation. */
export async function verifyArtifact(
  port: ArtifactStorePort,
  ref: string,
  expect: ArtifactExpectation,
): Promise<ArtifactVerification> {
  const record = await port.record(ref);
  if (!record) {
    return { ok: false, kind: 'uncommitted', reason: `artifact "${ref}" has no durable commit record` };
  }
  if (record.producedBy.admissionDigest !== expect.admissionDigest
    || record.producedBy.nodeId !== expect.nodeId
    || (expect.attemptId !== undefined && record.producedBy.attemptId !== expect.attemptId)) {
    return { ok: false, kind: 'wrong-producer', reason: `artifact "${ref}" was produced by ${record.producedBy.nodeId}/${record.producedBy.attemptId} under ${record.producedBy.admissionDigest.slice(0, 12)}…, not this settlement` };
  }
  if (expect.scopeDigest !== undefined && record.scopeDigest !== expect.scopeDigest) {
    return { ok: false, kind: 'wrong-scope', reason: `artifact "${ref}" is scoped to ${record.scopeDigest.slice(0, 12)}…, not this run's account scope` };
  }
  const stat = await port.stat(ref);
  if (!stat) {
    return { ok: false, kind: 'missing', reason: `artifact "${ref}" is committed but its bytes are gone` };
  }
  if (stat.storeId !== record.storeId) {
    return { ok: false, kind: 'wrong-store', reason: `artifact "${ref}" lives in store "${stat.storeId}" but was committed to "${record.storeId}"` };
  }
  if (stat.byteLength !== record.byteLength) {
    return { ok: false, kind: 'truncated', reason: `artifact "${ref}" is ${stat.byteLength} bytes; its commit recorded ${record.byteLength}` };
  }
  if (stat.contentDigest !== record.contentDigest) {
    return { ok: false, kind: 'altered', reason: `artifact "${ref}" content digest changed since its commit` };
  }
  return { ok: true, record };
}

function refsOf(entry: { outputRef?: string; evidenceRefs?: readonly string[] }): string[] {
  return [...(entry.outputRef ? [entry.outputRef] : []), ...(entry.evidenceRefs ?? [])];
}

/**
 * Runner decorator: a completion's refs must be committed and verified BEFORE
 * the outcome reaches the executor — so the settlement the executor journals
 * is durable only after its artifacts are. An unproven claim fails the NODE:
 * asserting outputs that do not verifiably exist is node logic, not weather.
 */
export function withArtifactCommit(
  runner: NodeRunner,
  port: ArtifactStorePort,
  admission: GraphAdmission,
): NodeRunner {
  return {
    ...runner,
    async run(node: ExecutableNode, context: NodeRunContext): Promise<NodeOutcome> {
      const outcome = await runner.run(node, context);
      if (outcome.status !== 'completed') return outcome;
      for (const ref of refsOf(outcome)) {
        const verified = await verifyArtifact(port, ref, {
          admissionDigest: admission.admissionDigest,
          nodeId: node.id,
          attemptId: context.attemptId,
          scopeDigest: admission.identity?.accountScopeDigest,
        });
        if (!verified.ok) {
          return {
            status: 'failed',
            reason: `artifact commit unproven (${verified.kind}): ${verified.reason}`,
            settlementClass: 'node',
          };
        }
      }
      return outcome;
    },
  };
}

export type ReuseVerification =
  | { verdict: 'verified' }
  | { verdict: 'rerun'; reason: string }
  | { verdict: 'refuse'; reason: string };

/**
 * The reuse-side verifier the executor consults before a trusted settlement
 * replays: every referenced artifact must still exist with the committed
 * digest, length, store, scope, and provenance.
 *
 * A failed verification is not automatically permission to redispatch: only
 * a node whose ADMITTED effect class is `read` may rerun to regenerate its
 * artifacts. Effectful (`write`/`send`) or unknown nodes refuse — re-running
 * them could repeat an external effect on the strength of a storage problem.
 * Corruption that verification can prove (wrong scope, producer, or store)
 * always refuses: that journal does not describe these artifacts.
 */
export function reuseVerifierFor(
  port: ArtifactStorePort,
  admission: GraphAdmission,
): (entry: NodeSettledEntry) => Promise<ReuseVerification> {
  return async (entry) => {
    for (const ref of refsOf(entry)) {
      const verified = await verifyArtifact(port, ref, {
        admissionDigest: entry.admissionDigest,
        nodeId: entry.nodeId,
        attemptId: entry.attemptId,
        scopeDigest: admission.identity?.accountScopeDigest,
      });
      if (verified.ok) continue;
      if (verified.kind === 'wrong-scope' || verified.kind === 'wrong-producer' || verified.kind === 'wrong-store') {
        return { verdict: 'refuse', reason: `artifact ${verified.kind}: ${verified.reason}` };
      }
      const effectClass = admission.identity?.nodes[entry.nodeId]?.effectClass;
      if (effectClass === 'read') {
        return { verdict: 'rerun', reason: `artifact ${verified.kind}: ${verified.reason} — read node reruns` };
      }
      return {
        verdict: 'refuse',
        reason: `artifact ${verified.kind}: ${verified.reason} — "${entry.nodeId}" is ${effectClass ?? 'of unknown effect class'} and a missing artifact is not redispatch authority for an effectful node`,
      };
    }
    return { verdict: 'verified' };
  };
}
