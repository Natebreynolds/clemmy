/**
 * One semantic interpretation per accepted source, before graph compile.
 * Durable CAS claim so concurrent lanes observe one model call and one result.
 * Failure is blocked/paused — never a manufactured conversation route.
 */
import { isHostAuthorityIdentity, HOST_BIND_IDENTITY, hostCompileDigest } from './host-authority.js';
import { hostDeterministicCompile, HOST_COMPILER_VERSION } from './host-deterministic-compile.js';
import { createHash, randomUUID } from 'node:crypto';
import { appendEvent, getEvent, listEvents, openEventLog, type EventRow } from '../harness/eventlog.js';
import { heldExecutionTextForInternalReason } from '../harness/public-presentation.js';
import {
  admitTurnSemantics,
  type HostSemanticAuthorityV1,
} from './admit-turn-semantics.js';
import type { AdmittedClampedSemanticsV1 } from '../graph/admitted-turn-semantics.js';
import { buildTurnSemanticHostViewV1, type DurableSemanticSnapshotV1 } from './build-semantic-host-view.js';
import { synthesizeCollectionReadOperations, synthesizeConstructOperations, synthesizeRetrieveOperation } from './host-bind-operations.js';
import {
  TURN_SEMANTIC_CALL_PURPOSE,
  TURN_SEMANTIC_PLAN_GROUNDING_PURPOSE,
  type TurnSemanticModelPort,
  type TurnSemanticModelResult,
} from './turn-semantic-model-port.js';
import type { TurnSemanticHostViewV1 } from './turn-semantic-proposal.js';
import { shownGroundingDescriptors, TurnSemanticProposalV1WireSchema } from './turn-semantic-proposal.js';
import {
  bindPlanGroundingReceipt,
  catalogSnapshotDigestFromDescriptors,
  downstreamConsumersOf,
  requireFrozenCatalogForExecutablePlan,
  type GroundingReceiptV1,
  type SemanticValidationIssueV1,
  validateGroundingReceiptReplay,
} from './plan-grounding.js';

export interface SemanticInterpretationJudgeRecordV1 {
  modelIdentity: string;
  verdict: 'entailed' | 'conflict' | 'uncertain';
  effect: string;
  destinationPosture: 'create_new' | 'named_existing' | null;
  proposalDigest: string;
  digest: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface SemanticInterpretationRecordV1 {
  purpose: typeof TURN_SEMANTIC_CALL_PURPOSE;
  sourceUserSeq: number;
  inputHash: string;
  audienceHash: string;
  policyRevision: string;
  payloadHash: string;
  contextHash: string;
  modelIdentity: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  proposalInputTokens?: number;
  proposalOutputTokens?: number;
  proposalLatencyMs?: number;
  judgeInputTokens?: number;
  judgeOutputTokens?: number;
  judgeLatencyMs?: number;
  validationOutcome: 'admitted' | 'invalid' | 'model_failed' | 'blocked';
  repairAttempted: boolean;
  raw: unknown;
  judgeIdentity?: string;
  judgeResult?: {
    verdict: 'entailed' | 'conflict' | 'uncertain';
    effect: string;
    destinationPosture: 'create_new' | 'named_existing' | null;
    proposalDigest: string;
  };
  judgeDigest?: string;
  evidenceFloor?: {
    handleRequired: boolean;
    evidenceRequirements: readonly string[];
  };
  groundingIdentity?: string;
  groundingCatalogDigest?: string;
  groundingShownDigest?: string;
  groundingProposalDigest?: string;
  groundingOverallVerdict?: 'entailed' | 'conflict' | 'uncertain';
  groundingReceiptDigest?: string;
  groundingVerdicts?: GroundingReceiptV1['operations'];
  groundingInputTokens?: number;
  groundingOutputTokens?: number;
  groundingLatencyMs?: number;
  proposalCalls?: number;
  effectJudgeCalls?: number;
  groundingJudgeCalls?: number;
  validationIssue?: SemanticValidationIssueV1;
  /** Present ONLY on host deterministic-compile records: the backward digest
   *  link the dispatch guard recomputes from durable inputs. */
  hostCompileDigest?: string;
  hostCompilerVersion?: string;
  hostAdmissionMs?: number;
}

export type InterpretAcceptedSourceResult =
  | {
      status: 'admitted';
      record: SemanticInterpretationRecordV1;
      replayed: boolean;
      clamped: AdmittedClampedSemanticsV1;
      source: { sessionId: string; sourceUserSeq: number; inputHash: string; audienceHash: string };
      payloadHash: string;
      contextHash: string;
    }
  | {
      status: 'blocked';
      reason: string;
      record: SemanticInterpretationRecordV1;
      replayed: boolean;
    };

const inFlight = new Map<string, Promise<InterpretAcceptedSourceResult>>();

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function judgeBindingDigest(input: {
  judgeIdentity: string;
  judgeResult: NonNullable<SemanticInterpretationRecordV1['judgeResult']>;
}): string {
  return sha256(JSON.stringify({
    judgeIdentity: input.judgeIdentity,
    verdict: input.judgeResult.verdict,
    effect: input.judgeResult.effect,
    destinationPosture: input.judgeResult.destinationPosture,
    proposalDigest: input.judgeResult.proposalDigest,
  }));
}

type JudgeBindingIssue = {
  code:
    | 'write_judge_identity_invalid'
    | 'write_not_aligned'
    | 'write_judge_digest_mismatch'
    | 'write_effect_mismatch'
    | 'write_destination_mismatch'
    | 'write_proposal_digest_mismatch';
  reason: string;
};

/** One exact binding check for both a fresh judgment and its durable replay. */
function validateJudgeBinding(input: {
  judgeIdentity: string;
  judgeResult: NonNullable<SemanticInterpretationRecordV1['judgeResult']>;
  judgeDigest: string;
  expectedEffect: string;
  expectedDestinationPosture: 'create_new' | 'named_existing' | null;
  expectedProposalDigest: string;
}): JudgeBindingIssue | null {
  if (!input.judgeIdentity || input.judgeIdentity !== input.judgeIdentity.trim()) {
    return {
      code: 'write_judge_identity_invalid',
      reason: 'judge identity is empty or non-canonical',
    };
  }
  if (input.judgeResult.verdict !== 'entailed') {
    return {
      code: 'write_not_aligned',
      reason: 'judge did not entail the proposed effect and destination posture',
    };
  }
  if (judgeBindingDigest(input) !== input.judgeDigest) {
    return {
      code: 'write_judge_digest_mismatch',
      reason: 'judge digest does not bind the persisted result and identity',
    };
  }
  if (input.judgeResult.proposalDigest !== input.expectedProposalDigest) {
    return {
      code: 'write_proposal_digest_mismatch',
      reason: 'judge is not bound to the admitted proposal digest',
    };
  }
  if (input.judgeResult.effect !== input.expectedEffect) {
    return {
      code: 'write_effect_mismatch',
      reason: 'judge effect does not match the admitted proposal',
    };
  }
  if (input.judgeResult.destinationPosture !== input.expectedDestinationPosture) {
    return {
      code: 'write_destination_mismatch',
      reason: 'judge destination posture does not match the admitted proposal',
    };
  }
  return null;
}

function claimKey(sessionId: string, sourceUserSeq: number): string {
  return `${sessionId}#${sourceUserSeq}`;
}

function readPersistedInterpretation(
  sessionId: string,
  sourceUserSeq: number,
): SemanticInterpretationRecordV1 | null {
  return readClaimLinkedSemanticInterpretation(sessionId, sourceUserSeq)?.record ?? null;
}

/** Load only the interpretation named by the durable claim. Later or
 * unlinked turn_semantics_interpreted events are ignored. */
export function readClaimLinkedSemanticInterpretation(
  sessionId: string,
  sourceUserSeq: number,
): { record: SemanticInterpretationRecordV1; eventId: string } | null {
  const db = openEventLog();
  const claim = db.prepare(
    `SELECT owner, event_id, input_hash, audience_hash, policy_revision, created_at
       FROM turn_semantics_claims
      WHERE session_id = ? AND source_user_seq = ?`,
  ).get(sessionId, sourceUserSeq) as {
    owner: string;
    event_id: string | null;
    input_hash: string | null;
    audience_hash: string | null;
    policy_revision: string | null;
    created_at: string;
  } | undefined;
  if (!claim) return null;
  if (!claim.owner?.trim() || !claim.event_id?.trim()) return null;
  const event = getEvent(claim.event_id);
  if (!event) return null;
  if (event.sessionId !== sessionId) return null;
  if (event.type !== 'turn_semantics_interpreted') return null;
  if (!event.data || typeof event.data !== 'object') return null;
  const data = event.data as unknown as SemanticInterpretationRecordV1;
  if (data.purpose !== TURN_SEMANTIC_CALL_PURPOSE) return null;
  if (data.sourceUserSeq !== sourceUserSeq) return null;
  if (String(data.validationOutcome) === 'claiming') return null;
  if (claim.input_hash && data.inputHash !== claim.input_hash) return null;
  if (claim.audience_hash && data.audienceHash !== claim.audience_hash) return null;
  if (claim.policy_revision && data.policyRevision !== claim.policy_revision) return null;
  return { record: data, eventId: event.id };
}

function persistInterpretation(
  sessionId: string,
  turn: number,
  record: SemanticInterpretationRecordV1,
  owner: string,
): EventRow | null {
  const db = openEventLog();
  return db.transaction((): EventRow | null => {
    const claim = db.prepare(
      `SELECT owner, event_id FROM turn_semantics_claims
        WHERE session_id = ? AND source_user_seq = ?`,
    ).get(sessionId, record.sourceUserSeq) as { owner: string; event_id: string | null } | undefined;
    if (!claim || claim.owner !== owner) return null;
    if (claim.event_id) {
      const existing = getEvent(claim.event_id);
      if (!existing || existing.sessionId !== sessionId || existing.type !== 'turn_semantics_interpreted') {
        return null;
      }
      return existing;
    }
    const event = appendEvent({
      sessionId,
      turn,
      role: 'system',
      type: 'turn_semantics_interpreted',
      data: { ...record },
    });
    const linked = db.prepare(
      `UPDATE turn_semantics_claims
          SET event_id = ?
        WHERE session_id = ? AND source_user_seq = ? AND owner = ? AND event_id IS NULL`,
    ).run(event.id, sessionId, record.sourceUserSeq, owner);
    if (linked.changes !== 1) return null;
    return event;
  }).immediate();
}

const CLAIM_LEASE_MS = Number(process.env.CLEMENTINE_SEMANTIC_CLAIM_LEASE_MS ?? 120_000);
const CLAIM_WAIT_MS = Number(process.env.CLEMENTINE_SEMANTIC_CLAIM_WAIT_MS ?? 5_000);

function claimRow(sessionId: string, sourceUserSeq: number): { owner: string; created_at: string } | undefined {
  return openEventLog().prepare(
    `SELECT owner, created_at FROM turn_semantics_claims WHERE session_id = ? AND source_user_seq = ?`,
  ).get(sessionId, sourceUserSeq) as { owner: string; created_at: string } | undefined;
}

function claimExpired(createdAt: string): boolean {
  const ms = Date.parse(createdAt);
  return !Number.isFinite(ms) || Date.now() - ms > CLAIM_LEASE_MS;
}

function claimInterpretation(
  sessionId: string,
  sourceUserSeq: number,
  hashes: { inputHash: string; audienceHash: string; policyRevision: string },
): { status: 'owner'; owner: string } | { status: 'exists' } {
  const db = openEventLog();
  const owner = randomUUID();
  const now = new Date().toISOString();
  const inserted = db.transaction(() => {
    const existing = db.prepare(
      `SELECT owner, created_at, event_id FROM turn_semantics_claims
        WHERE session_id = ? AND source_user_seq = ?`,
    ).get(sessionId, sourceUserSeq) as { owner: string; created_at: string; event_id: string | null } | undefined;
    if (existing && !claimExpired(existing.created_at) && !existing.event_id) return false;
    if (existing && existing.event_id) return false;
    if (existing) {
      db.prepare(
        `DELETE FROM turn_semantics_claims WHERE session_id = ? AND source_user_seq = ? AND event_id IS NULL`,
      ).run(sessionId, sourceUserSeq);
    }
    db.prepare(
      `INSERT INTO turn_semantics_claims
        (session_id, source_user_seq, owner, created_at, input_hash, audience_hash, policy_revision)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      sourceUserSeq,
      owner,
      now,
      hashes.inputHash,
      hashes.audienceHash,
      hashes.policyRevision,
    );
    return true;
  }).immediate();
  return inserted ? { status: 'owner', owner } : { status: 'exists' };
}

async function waitForInterpretation(
  sessionId: string,
  sourceUserSeq: number,
): Promise<SemanticInterpretationRecordV1 | null> {
  const started = Date.now();
  while (Date.now() - started < CLAIM_WAIT_MS) {
    const persisted = readPersistedInterpretation(sessionId, sourceUserSeq);
    if (persisted) return persisted;
    const claim = claimRow(sessionId, sourceUserSeq);
    if (!claim || claimExpired(claim.created_at)) return null;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return readPersistedInterpretation(sessionId, sourceUserSeq);
}

async function interpretOnce(input: {
  snapshot: DurableSemanticSnapshotV1;
  authority: HostSemanticAuthorityV1;
  port: TurnSemanticModelPort;
  turn: number;
}): Promise<InterpretAcceptedSourceResult> {
  const host = buildTurnSemanticHostViewV1(input.snapshot);
  const replayOf = (persisted: SemanticInterpretationRecordV1): InterpretAcceptedSourceResult => {
    const hashesMatch = persisted.inputHash === host.source.inputHash
      && persisted.audienceHash === host.source.audienceHash
      && persisted.policyRevision === host.policyRevision;
    if (!hashesMatch) {
      return {
        status: 'blocked',
        reason: 'replay hashes do not match accepted source, audience, or policy',
        record: persisted,
        replayed: true,
      };
    }
    if (persisted.validationOutcome === 'admitted') {
      const admitted = admitTurnSemantics(persisted.raw, host, input.authority);
      if (admitted.ok) {
        if (
          admitted.payloadHash !== persisted.payloadHash
          || admitted.contextHash !== persisted.contextHash
        ) {
          return {
            status: 'blocked',
            reason: 'replayed semantic payload or context hash does not match the persisted admission',
            record: persisted,
            replayed: true,
          };
        }
        const requested = admitted.clamped.requestedEffect;
        const write = requested === 'local_write' || requested === 'external_write' || requested === 'admin';
        if (write) {
          if (!persisted.judgeIdentity || !persisted.judgeResult || !persisted.judgeDigest) {
            return {
              status: 'blocked',
              reason: 'replayed consequential semantics are missing the persisted judge',
              record: persisted,
              replayed: true,
            };
          }
          const judgeIssue = validateJudgeBinding({
            judgeIdentity: persisted.judgeIdentity,
            judgeResult: persisted.judgeResult,
            judgeDigest: persisted.judgeDigest,
            expectedEffect: requested,
            expectedDestinationPosture: admitted.clamped.destination?.posture ?? null,
            expectedProposalDigest: admitted.payloadHash,
          });
          if (judgeIssue) {
            return {
              status: 'blocked',
              reason: `replayed consequential semantics failed judge binding: ${judgeIssue.reason}`,
              record: persisted,
              replayed: true,
            };
          }
        }
        const executable = admitted.clamped.operations ?? [];
        if (executable.length > 0) {
          const catalogIssue = requireFrozenCatalogForExecutablePlan({
            operations: executable.map((operation) => ({
              id: operation.id,
              role: operation.role,
              requestedEffect: operation.requestedEffect,
              capabilityRef: operation.capabilityRef,
              dependsOn: operation.dependsOn,
              evidence: operation.evidence,
            })),
            descriptors: host.catalog.capabilities ?? [],
          });
          if (catalogIssue) {
            return {
              status: 'blocked',
              reason: catalogIssue.message,
              record: persisted,
              replayed: true,
            };
          }
          if (
            !persisted.groundingIdentity
            || !persisted.groundingCatalogDigest
            || !persisted.groundingShownDigest
            || !persisted.groundingProposalDigest
            || !persisted.groundingReceiptDigest
            || !persisted.groundingOverallVerdict
            || !persisted.groundingVerdicts
          ) {
            return {
              status: 'blocked',
              reason: 'replayed semantics are missing the persisted grounding receipt',
              record: persisted,
              replayed: true,
            };
          }
          const shown = shownGroundingDescriptors({
            descriptors: host.catalog.capabilities ?? [],
            referencedIds: executable.map((operation) => operation.capabilityRef),
          });
          if (!shown.ok) {
            return {
              status: 'blocked',
              reason: shown.message,
              record: persisted,
              replayed: true,
            };
          }
          const groundingIssue = validateGroundingReceiptReplay({
            persisted: {
              modelIdentity: persisted.groundingIdentity,
              catalogSnapshotDigest: persisted.groundingCatalogDigest,
              shownDescriptorDigest: persisted.groundingShownDigest,
              proposalDigest: persisted.groundingProposalDigest,
              overallVerdict: persisted.groundingOverallVerdict,
              operations: persisted.groundingVerdicts,
              inputTokens: persisted.groundingInputTokens ?? 0,
              outputTokens: persisted.groundingOutputTokens ?? 0,
              latencyMs: persisted.groundingLatencyMs ?? 0,
              digest: persisted.groundingReceiptDigest,
            },
            operations: executable.map((operation) => ({
              id: operation.id,
              role: operation.role,
              requestedEffect: operation.requestedEffect,
              capabilityRef: operation.capabilityRef,
              dependsOn: operation.dependsOn,
              evidence: operation.evidence,
            })),
            descriptors: host.catalog.capabilities ?? [],
            catalogSnapshotDigest: input.snapshot.catalogSnapshotDigest
              ?? catalogSnapshotDigestFromDescriptors(host.catalog.capabilities ?? []),
            shownDescriptorDigest: shown.digest,
            proposalDigest: admitted.payloadHash,
          });
          if (groundingIssue) {
            return {
              status: 'blocked',
              reason: `replayed grounding receipt failed: ${groundingIssue.message}`,
              record: persisted,
              replayed: true,
            };
          }
        }
        return {
          status: 'admitted',
          record: persisted,
          replayed: true,
          clamped: admitted.clamped,
          source: admitted.source,
          payloadHash: admitted.payloadHash,
          contextHash: admitted.contextHash,
        };
      }
    }
    return {
      status: 'blocked',
      reason: persisted.validationOutcome === 'model_failed' ? 'semantic model failed' : 'semantic proposal was not admitted',
      record: persisted,
      replayed: true,
    };
  };

  const persisted = readPersistedInterpretation(input.snapshot.sessionId, input.snapshot.sourceUserSeq);
  if (persisted) return replayOf(persisted);

  let claim = claimInterpretation(input.snapshot.sessionId, input.snapshot.sourceUserSeq, {
    inputHash: host.source.inputHash,
    audienceHash: host.source.audienceHash,
    policyRevision: host.policyRevision,
  });
  if (claim.status === 'exists') {
    const waited = await waitForInterpretation(input.snapshot.sessionId, input.snapshot.sourceUserSeq);
    if (waited) return replayOf(waited);
    claim = claimInterpretation(input.snapshot.sessionId, input.snapshot.sourceUserSeq, {
      inputHash: host.source.inputHash,
      audienceHash: host.source.audienceHash,
      policyRevision: host.policyRevision,
    });
    if (claim.status === 'exists') {
      const again = await waitForInterpretation(input.snapshot.sessionId, input.snapshot.sourceUserSeq);
      if (again) return replayOf(again);
      return {
        status: 'blocked',
        reason: 'semantic interpretation claim is held',
        record: {
          purpose: TURN_SEMANTIC_CALL_PURPOSE,
          sourceUserSeq: host.source.sourceUserSeq,
          inputHash: host.source.inputHash,
          audienceHash: host.source.audienceHash,
          policyRevision: host.policyRevision,
          payloadHash: sha256('claim_held'),
          contextHash: sha256('claim_held'),
          modelIdentity: 'none',
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: 0,
          validationOutcome: 'blocked',
          repairAttempted: false,
          raw: null,
        },
        replayed: false,
      };
    }
  }
  const owner = claim.status === 'owner' ? claim.owner : '';
  if (!owner) {
    return {
      status: 'blocked',
      reason: 'semantic interpretation claim is held',
      record: {
        purpose: TURN_SEMANTIC_CALL_PURPOSE,
        sourceUserSeq: host.source.sourceUserSeq,
        inputHash: host.source.inputHash,
        audienceHash: host.source.audienceHash,
        policyRevision: host.policyRevision,
        payloadHash: sha256('claim_held'),
        contextHash: sha256('claim_held'),
        modelIdentity: 'none',
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        validationOutcome: 'blocked',
        repairAttempted: false,
        raw: null,
      },
      replayed: false,
    };
  }

  // HOST DETERMINISTIC COMPILE fast lane (live 2026-08-19 session-fixture-fast-lane: the
  // ceremony below cost 97s and six model calls to author a plan the host
  // could prove). When every deterministic classifier fires, the host authors
  // and admits the plan itself — same validator, same receipt binder, zero
  // model calls — under the reserved host authority identity the dispatch
  // guard re-proves by recompute. Any decline falls through unchanged.
  {
    const hostCompileStartedAt = Date.now();
    const hostCompiled = hostDeterministicCompile({
      acceptedText: input.snapshot.acceptedText,
      identity: { sessionId: input.snapshot.sessionId, sourceUserSeq: input.snapshot.sourceUserSeq },
      hasOpenContext: (input.snapshot.resumableGoals?.length ?? 0) > 0
        || (input.snapshot.openQuestions?.length ?? 0) > 0,
      allowedEffects: input.authority.allowedEffects.map(String),
    });
    if (hostCompiled) {
      const hostAdmitted = admitTurnSemantics(hostCompiled.proposal, host, input.authority);
      const descriptors = host.catalog.capabilities ?? [];
      const hostCatalogDigest = input.snapshot.catalogSnapshotDigest
        ?? catalogSnapshotDigestFromDescriptors(descriptors);
      if (hostAdmitted.ok
        && !requireFrozenCatalogForExecutablePlan({ operations: hostCompiled.operations, descriptors })) {
        const shown = shownGroundingDescriptors({
          descriptors,
          referencedIds: hostCompiled.operations.map((operation) => operation.capabilityRef),
        });
        if (shown.ok) {
          const bound = bindPlanGroundingReceipt({
            judged: {
              verdict: 'entailed',
              operations: hostCompiled.operations.map((operation) => ({
                operationId: operation.id,
                verdict: 'entailed' as const,
                rationale: 'schema-proven host bind',
              })),
              modelIdentity: HOST_BIND_IDENTITY,
              inputTokens: 0,
              outputTokens: 0,
              latencyMs: 0,
            },
            operations: hostCompiled.operations,
            descriptors,
            catalogSnapshotDigest: hostCatalogDigest,
            shownDescriptorDigest: shown.digest,
            proposalDigest: hostAdmitted.payloadHash,
            hostMinted: true,
          });
          if (bound.ok && bound.receipt.overallVerdict === 'entailed') {
            const hostJudgeResult: NonNullable<SemanticInterpretationRecordV1['judgeResult']> = {
              verdict: 'entailed',
              effect: hostAdmitted.clamped.requestedEffect,
              destinationPosture: hostAdmitted.clamped.destination?.posture ?? null,
              proposalDigest: hostAdmitted.payloadHash,
            };
            const hostAdmissionMs = Date.now() - hostCompileStartedAt;
            const record: SemanticInterpretationRecordV1 = {
              purpose: TURN_SEMANTIC_CALL_PURPOSE,
              sourceUserSeq: host.source.sourceUserSeq,
              inputHash: host.source.inputHash,
              audienceHash: host.source.audienceHash,
              policyRevision: host.policyRevision,
              payloadHash: hostAdmitted.payloadHash,
              contextHash: hostAdmitted.contextHash,
              modelIdentity: HOST_BIND_IDENTITY,
              inputTokens: 0,
              outputTokens: 0,
              latencyMs: hostAdmissionMs,
              proposalInputTokens: 0,
              proposalOutputTokens: 0,
              proposalLatencyMs: 0,
              judgeInputTokens: 0,
              judgeOutputTokens: 0,
              judgeLatencyMs: 0,
              groundingInputTokens: 0,
              groundingOutputTokens: 0,
              groundingLatencyMs: 0,
              proposalCalls: 0,
              effectJudgeCalls: 0,
              groundingJudgeCalls: 0,
              validationOutcome: 'admitted',
              repairAttempted: false,
              raw: hostCompiled.proposal,
              evidenceFloor: {
                handleRequired: Boolean(hostAdmitted.clamped.destination?.handleRequired),
                evidenceRequirements: [],
              },
              judgeIdentity: HOST_BIND_IDENTITY,
              judgeResult: hostJudgeResult,
              judgeDigest: judgeBindingDigest({ judgeIdentity: HOST_BIND_IDENTITY, judgeResult: hostJudgeResult }),
              groundingIdentity: bound.receipt.modelIdentity,
              groundingCatalogDigest: bound.receipt.catalogSnapshotDigest,
              groundingShownDigest: bound.receipt.shownDescriptorDigest,
              groundingProposalDigest: bound.receipt.proposalDigest,
              groundingOverallVerdict: bound.receipt.overallVerdict,
              groundingReceiptDigest: bound.receipt.digest,
              groundingVerdicts: bound.receipt.operations,
              hostCompileDigest: hostCompileDigest({
                compilerVersion: HOST_COMPILER_VERSION,
                inputHash: host.source.inputHash,
                audienceHash: host.source.audienceHash,
                policyRevision: host.policyRevision,
                catalogSnapshotDigest: bound.receipt.catalogSnapshotDigest,
                proposalDigest: hostAdmitted.payloadHash,
              }),
              hostCompilerVersion: HOST_COMPILER_VERSION,
              hostAdmissionMs,
            };
            if (!persistInterpretation(input.snapshot.sessionId, input.turn, record, owner)) {
              return { status: 'blocked', reason: 'semantic interpretation claim was stolen', record, replayed: false };
            }
            return {
              status: 'admitted',
              record,
              replayed: false,
              clamped: {
                ...hostAdmitted.clamped,
                operations: hostCompiled.operations,
              },
              source: hostAdmitted.source,
              payloadHash: hostAdmitted.payloadHash,
              contextHash: hostAdmitted.contextHash,
            };
          }
        }
      }
    }
  }

  let modelResult: TurnSemanticModelResult;
  try {
    modelResult = await input.port.interpret({
      purpose: TURN_SEMANTIC_CALL_PURPOSE,
      host,
      acceptedText: input.snapshot.acceptedText,
      recentTurns: input.snapshot.recentTurns,
    });
  } catch (error) {
    const record: SemanticInterpretationRecordV1 = {
      purpose: TURN_SEMANTIC_CALL_PURPOSE,
      sourceUserSeq: host.source.sourceUserSeq,
      inputHash: host.source.inputHash,
      audienceHash: host.source.audienceHash,
      policyRevision: host.policyRevision,
      payloadHash: sha256('model_failed'),
      contextHash: sha256('model_failed'),
      modelIdentity: 'unknown',
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      validationOutcome: 'model_failed',
      repairAttempted: false,
      raw: { error: error instanceof Error ? error.message : String(error) },
    };
    if (!persistInterpretation(input.snapshot.sessionId, input.turn, record, owner)) {
      return { status: 'blocked', reason: 'semantic interpretation claim was stolen', record, replayed: false };
    }
    return { status: 'blocked', reason: 'semantic model failed', record, replayed: false };
  }

  let admitted = admitTurnSemantics(modelResult.raw, host, input.authority);
  let repairAttempted = false;
  let judgeRecord: SemanticInterpretationJudgeRecordV1 | undefined;
  let groundingReceipt: GroundingReceiptV1 | undefined;
  let validationIssue: SemanticValidationIssueV1 | undefined;
  let judgeInputTokens = 0;
  let judgeOutputTokens = 0;
  let judgeLatencyMs = 0;
  let groundingInputTokens = 0;
  let groundingOutputTokens = 0;
  let groundingLatencyMs = 0;
  let proposalCalls = 1;
  let effectJudgeCalls = 0;
  let groundingJudgeCalls = 0;
  const evidenceFloor = { handleRequired: false, evidenceRequirements: [] as string[] };

  const absorbEvidence = (): void => {
    if (!admitted.ok) return;
    if (admitted.clamped.destination?.handleRequired) evidenceFloor.handleRequired = true;
    for (const item of admitted.clamped.evidenceRequirements ?? []) {
      if (!evidenceFloor.evidenceRequirements.includes(item)) evidenceFloor.evidenceRequirements.push(item);
    }
  };
  absorbEvidence();

  const retryJudge = async <T,>(
    run: () => Promise<T>,
    malformed: (value: T) => boolean,
  ): Promise<T | 'failed'> => {
    try {
      const first = await run();
      if (!malformed(first)) return first;
    } catch {
      // retry once
    }
    try {
      const second = await run();
      if (!malformed(second)) return second;
    } catch {
      return 'failed';
    }
    return 'failed';
  };

  const judgeAdmittedWrite = async (): Promise<void> => {
    if (!admitted.ok) return;
    const requested = admitted.clamped.requestedEffect;
    const write = requested === 'local_write' || requested === 'external_write' || requested === 'admin';
    if (!write) return;
    if (!input.port.judgeSourceEffect) {
      admitted = {
        ok: false,
        issues: [{
          code: 'write_judge_unavailable',
          path: 'work.requestedEffect',
          message: 'consequential work requires an independent source/effect judge',
        }],
      };
      return;
    }
    try {
      if (!admitted.ok) return;
      const proposedConstruct = admitted.clamped.construct;
      const proposedDestinationPosture = admitted.clamped.destination?.posture ?? null;
      const proposalDigest = admitted.payloadHash;
      const proposedHandleRequired = Boolean(admitted.clamped.destination?.handleRequired || evidenceFloor.handleRequired);
      const judged = await retryJudge(async () => {
        effectJudgeCalls += 1;
        return input.port.judgeSourceEffect!({
          purpose: 'turn_semantics_effect_judge',
          sessionId: input.snapshot.sessionId,
          sourceUserSeq: input.snapshot.sourceUserSeq,
          acceptedText: input.snapshot.acceptedText,
          recentTurns: input.snapshot.recentTurns ?? [],
          activeGoals: (input.snapshot.resumableGoals ?? []).map((goal) => ({
            goalId: goal.goalId,
            baseRevision: goal.baseRevision,
          })),
          proposedConstruct,
          proposedEffect: requested,
          proposedDestinationPosture,
          proposalDigest,
          proposedHandleRequired,
        });
      }, (value) => !value.verdict || !value.proposalDigest);
      if (judged === 'failed') throw new Error('write judge malformed');
      // Reserved namespace: a model port cannot return host deterministic-bind
      // authority — only the host compile lane mints that identity.
      if (isHostAuthorityIdentity(judged.modelIdentity)) throw new Error('write judge malformed');
      const judgeResult: NonNullable<SemanticInterpretationRecordV1['judgeResult']> = {
        verdict: judged.verdict,
        effect: judged.effect,
        destinationPosture: judged.destinationPosture,
        proposalDigest: judged.proposalDigest,
      };
      judgeInputTokens += judged.inputTokens;
      judgeOutputTokens += judged.outputTokens;
      judgeLatencyMs += judged.latencyMs;
      judgeRecord = {
        modelIdentity: judged.modelIdentity,
        verdict: judged.verdict,
        effect: judged.effect,
        destinationPosture: judged.destinationPosture,
        proposalDigest: judged.proposalDigest,
        digest: judgeBindingDigest({
          judgeIdentity: judged.modelIdentity,
          judgeResult,
        }),
        inputTokens: judged.inputTokens,
        outputTokens: judged.outputTokens,
        latencyMs: judged.latencyMs,
      };
      const judgeIssue = validateJudgeBinding({
        judgeIdentity: judgeRecord.modelIdentity,
        judgeResult,
        judgeDigest: judgeRecord.digest,
        expectedEffect: requested,
        expectedDestinationPosture: admitted.clamped.destination?.posture ?? null,
        expectedProposalDigest: admitted.payloadHash,
      });
      if (judgeIssue) {
        admitted = {
          ok: false,
          issues: [{
            code: judgeIssue.code,
            path: 'work.requestedEffect',
            message: judgeIssue.reason,
          }],
        };
        validationIssue = admitted.issues[0];
      }
    } catch {
      admitted = {
        ok: false,
        issues: [{
          code: 'write_judge_failed',
          path: 'work.requestedEffect',
          message: 'independent source/effect judge failed',
        }],
      };
      validationIssue = admitted.issues[0];
    }
  };

  const catalogSnapshotDigest = input.snapshot.catalogSnapshotDigest
    ?? catalogSnapshotDigestFromDescriptors(host.catalog.capabilities ?? []);

  const judgePlanGrounding = async (): Promise<void> => {
    if (!admitted.ok) return;
    // Ground only work the PROPOSAL supplied. A slot answer (or any proposal
    // with work: null) carries the resumed goal's already-admitted operations
    // in clamped; re-judging that stored plan against today's catalog could
    // reject the ANSWER — live 2026-09-08: GLM's clean free-text calendar pick
    // was refused as capability_grounding_conflict on the goal's own lookup.
    const proposalWork = modelResult.raw && typeof modelResult.raw === 'object'
      ? (modelResult.raw as { work?: unknown }).work
      : undefined;
    if (proposalWork === null || proposalWork === undefined) return;
    const operations = admitted.clamped.operations ?? [];
    if (operations.length === 0) return;
    if (operations.every((operation) => (
      operation.requestedEffect === 'host_only'
      || operation.requestedEffect === 'none'
      || operation.requestedEffect === 'compute'
    ))) return;
    const descriptors = host.catalog.capabilities ?? [];
    const catalogIssue = requireFrozenCatalogForExecutablePlan({ operations, descriptors });
    if (catalogIssue) {
      admitted = { ok: false, issues: [catalogIssue] };
      validationIssue = catalogIssue;
      return;
    }
    if (!input.port.judgePlanGrounding) {
      admitted = {
        ok: false,
        issues: [{
          code: 'capability_grounding_unavailable',
          path: 'work.operations',
          message: 'named capabilities require an independent whole-plan grounding judge',
        }],
      };
      validationIssue = admitted.issues[0];
      return;
    }
    const raw = modelResult.raw && typeof modelResult.raw === 'object'
      ? modelResult.raw as {
          goal?: { objective?: string; criteria?: Array<{ id: string; statement: string }> };
          work?: {
            construct?: string;
            cardinality?: { count: number; fields: string[] } | null;
            destination?: { posture: string; family: string; handleRequired: boolean } | null;
            requestedEffect?: string;
            deliverables?: Array<{ id: string; kind: string }>;
          };
        }
      : {};
    const downstream = downstreamConsumersOf(operations);
    const shown = shownGroundingDescriptors({
      descriptors,
      referencedIds: operations.map((operation) => operation.capabilityRef),
    });
    if (!shown.ok) {
      const issue = {
        code: shown.code,
        path: 'work.operations',
        message: shown.message,
        capabilityRef: shown.capabilityRef,
      };
      admitted = { ok: false, issues: [issue] };
      validationIssue = issue;
      return;
    }
    const call = {
      purpose: TURN_SEMANTIC_PLAN_GROUNDING_PURPOSE,
      sessionId: input.snapshot.sessionId,
      sourceUserSeq: input.snapshot.sourceUserSeq,
      acceptedText: input.snapshot.acceptedText,
      recentTurns: input.snapshot.recentTurns ?? [],
      goal: raw.goal?.objective
        ? {
            objective: raw.goal.objective,
            criteria: raw.goal.criteria ?? [],
            revision: admitted.clamped.revision ?? 0,
          }
        : null,
      dag: {
        construct: raw.work?.construct ?? admitted.clamped.construct,
        cardinality: raw.work?.cardinality ?? (admitted.clamped.collection
          ? { count: admitted.clamped.collection.count, fields: admitted.clamped.collection.projection }
          : null),
        destination: raw.work?.destination ?? admitted.clamped.destination ?? null,
        requestedEffect: raw.work?.requestedEffect ?? admitted.clamped.requestedEffect,
        operations: operations.map((operation) => ({
          id: operation.id,
          role: operation.role,
          requestedEffect: operation.requestedEffect,
          capabilityRef: operation.capabilityRef,
          dependsOn: operation.dependsOn,
          downstream: downstream.get(operation.id) ?? [],
          evidence: operation.evidence,
        })),
        deliverables: raw.work?.deliverables ?? [],
      },
      descriptors: shown.shown.map((entry) => ({
        id: entry.id,
        effect: entry.effect,
        purpose: entry.purpose,
        acceptedInputKinds: entry.acceptedInputKinds ?? [],
        producedOutputKinds: entry.producedOutputKinds ?? [],
        applicableDeliverableKinds: entry.applicableDeliverableKinds ?? [],
        destinationPosture: entry.destinationPosture,
        evidenceKinds: entry.evidenceKinds,
        handleRequired: entry.handleRequired,
        readbackRequired: entry.readbackRequired,
        accountScope: entry.accountScope,
      })),
      catalogSnapshotDigest,
      proposalDigest: admitted.payloadHash,
    };
    const judged = await retryJudge(async () => {
      groundingJudgeCalls += 1;
      return input.port.judgePlanGrounding!(call);
    }, (value) => !Array.isArray(value.operations) || value.operations.length === 0);
    if (judged === 'failed') {
      admitted = {
        ok: false,
        issues: [{
          code: 'capability_grounding_failed',
          path: 'work.operations',
          message: 'independent whole-plan grounding judge failed',
        }],
      };
      validationIssue = admitted.issues[0];
      return;
    }
    groundingInputTokens += judged.inputTokens;
    groundingOutputTokens += judged.outputTokens;
    groundingLatencyMs += judged.latencyMs;
    const bound = bindPlanGroundingReceipt({
      judged,
      operations,
      descriptors,
      catalogSnapshotDigest,
      shownDescriptorDigest: shown.digest,
      proposalDigest: admitted.payloadHash,
    });
    if (!bound.ok) {
      admitted = { ok: false, issues: [bound.issue] };
      validationIssue = bound.issue;
      return;
    }
    groundingReceipt = bound.receipt;
    if (bound.receipt.overallVerdict !== 'entailed') {
      const failed = bound.receipt.operations.find((operation) => operation.verdict !== 'entailed');
      const issue = {
        code: bound.receipt.overallVerdict === 'conflict' ? 'capability_grounding_conflict' : 'capability_not_grounded',
        path: failed ? `work.operations.${failed.operationId}` : 'work.operations',
        message: failed?.rationale || 'named capabilities are not grounded in the accepted source and proposed plan',
        operationId: failed?.operationId,
        capabilityRef: failed?.capabilityRef,
      };
      admitted = { ok: false, issues: [issue] };
      validationIssue = issue;
    }
  };

  // HOST-BIND (live 2026-08-19 session-fixture-host-bind): an ADMITTED act construct whose
  // proposal left operations empty ("pending resolution") is a host bind
  // failure, not a shadow-label excuse. Bind THIS source's registered
  // goal-carrying capabilities into the exact operations shape the rest of the
  // pipeline already consumes — BEFORE the grounding judge, so the same
  // independent judge audits the host-bound plan and persists the same
  // receipt the executor demands. When nothing can carry the goal the
  // operations stay empty, the graph compiles unbound, and dispatch fails
  // CLOSED as blocked — never tool_search theater.
  const hostBindEmptyActOperations = (): void => {
    if (!admitted.ok) return;
    if ((admitted.clamped.operations?.length ?? 0) > 0) return;
    const identity = {
      sessionId: input.snapshot.sessionId,
      sourceUserSeq: input.snapshot.sourceUserSeq,
    };
    const collection = synthesizeCollectionReadOperations({
      construct: admitted.clamped.construct,
      route: admitted.clamped.route,
      effectCeiling: String(admitted.clamped.effectCeiling),
      objective: input.snapshot.acceptedText,
      count: admitted.clamped.collection?.count,
      identity,
    });
    if (collection && collection.length > 0) {
      admitted = {
        ok: true,
        clamped: { ...admitted.clamped, operations: collection },
        source: admitted.source,
        policyRevision: admitted.policyRevision,
        payloadHash: admitted.payloadHash,
        contextHash: admitted.contextHash,
      } as typeof admitted;
      return;
    }
    const retrieve = synthesizeRetrieveOperation({
      construct: admitted.clamped.construct,
      route: admitted.clamped.route,
      effectCeiling: String(admitted.clamped.effectCeiling),
      objective: input.snapshot.acceptedText,
      identity,
    });
    if (retrieve && retrieve.length > 0) {
      admitted = {
        ok: true,
        clamped: { ...admitted.clamped, operations: retrieve },
        source: admitted.source,
        policyRevision: admitted.policyRevision,
        payloadHash: admitted.payloadHash,
        contextHash: admitted.contextHash,
      } as typeof admitted;
      return;
    }
    if (admitted.clamped.route !== 'act') return;
    const hostBound = synthesizeConstructOperations({
      construct: admitted.clamped.construct,
      objective: input.snapshot.acceptedText,
      destinationFamily: admitted.clamped.destination?.family,
      destinationFamilies: (admitted.clamped.destinations ?? []).map((entry) => entry.family),
      effectCeiling: String(admitted.clamped.effectCeiling),
      count: admitted.clamped.collection?.count,
      fields: admitted.clamped.collection?.projection,
      identity,
    });
    if (!hostBound || hostBound.length === 0) return;
    admitted = {
      ok: true,
      clamped: { ...admitted.clamped, operations: hostBound },
      source: admitted.source,
      policyRevision: admitted.policyRevision,
      payloadHash: admitted.payloadHash,
      contextHash: admitted.contextHash,
    } as typeof admitted;
  };

  const assess = async (): Promise<void> => {
    absorbEvidence();
    await judgeAdmittedWrite();
    hostBindEmptyActOperations();
    if (admitted.ok) await judgePlanGrounding();
    else if (!validationIssue && admitted.ok === false) validationIssue = admitted.issues[0];
  };

  await assess();

  const genuineConflict = !admitted.ok && (
    judgeRecord?.verdict === 'conflict'
    || groundingReceipt?.overallVerdict === 'conflict'
    || validationIssue?.code === 'capability_grounding_conflict'
  );
  const unboundTypedWork = admitted.ok
    && (admitted.clamped.operations?.length ?? 0) === 0
    && admitted.clamped.route !== 'direct_reply'
    && (
      admitted.clamped.requestedEffect === 'read'
      || admitted.clamped.requestedEffect === 'local_write'
      || admitted.clamped.requestedEffect === 'external_write'
      || admitted.clamped.requestedEffect === 'admin'
      || admitted.clamped.route === 'retrieve'
      || admitted.clamped.route === 'act'
    );
  // A VALIDATION FAILURE IS REPAIRABLE BY DEFINITION.
  //
  // This was an allowlist of eight blessed codes, and it did not match what
  // actually fails. Measured on the production home: of 14 real planner
  // validation failures, 10 carried codes absent from that list —
  // dag_kind_mismatch, capability_grounding_conflict (the list named
  // capability_grounding_FAILED), illegal_relation_payload, write_not_aligned,
  // effect_exceeds_ceiling, capability_ref_effect_mismatch. Every one of those
  // ended its run with "I could not finish planning that, so I stopped before
  // using any tools. You can restate it." — addressed to the USER, for a
  // structural mistake the MODEL had just been told about in precise terms and
  // was never shown. Six different scheduled workflows died this way.
  //
  // The validator's own output is the repair hint: it names the exact path and
  // the exact problem, and it is already threaded into the repair prompt below.
  // Whether the model can act on that does not depend on which code it is, so
  // the code no longer decides. The attempt stays bounded to ONE by
  // repairAttempted; an unrepairable proposal costs one model call, where the
  // alternative cost a dead run and a human restating it.
  const repairableGrounding = !admitted.ok && Boolean(validationIssue?.code);
  if (genuineConflict || unboundTypedWork || repairableGrounding) {
    repairAttempted = true;
    // When a citation failed because NO disclosed capability carries the
    // operation's requested effect, the repair must not re-cite from the same
    // menu — every option is wrong by the same measurement. State the measured
    // fact and the admissible expression instead. Deliberately no enumeration
    // of near-miss refs or alternative effects: a hint listing them coaches
    // the model to flip an effect until something validates, which launders a
    // foreign operation through admission instead of repairing the proposal.
    let hostNativeGuidance: { reason: string; require: string } | null = null;
    if (!admitted.ok) {
      const HOST_NATIVE_REQUIRE = 'work the host itself performs — including reading or updating the host\'s own tasks, goals, and working memory — declares requestedEffect host_only, none, or compute with a host-native capabilityRef naming the operation itself; only cite a disclosed capability for genuinely external work, and never one whose effect or purpose does not match the operation';
      const citationIssues = admitted.issues.filter(
        (entry) => entry.code === 'capability_ref_effect_mismatch' || entry.code === 'unknown_capability_ref',
      );
      if (citationIssues.length > 0) {
        const disclosedEffects = new Set(
          (host.catalog.capabilities ?? []).map((descriptor) => descriptor.effect),
        );
        const wire = TurnSemanticProposalV1WireSchema.safeParse(modelResult.raw);
        const operations = wire.success ? wire.data.work?.operations ?? [] : [];
        const unsatisfiable = citationIssues.some((entry) => {
          const match = /^work\.operations\.(\d+)\./.exec(entry.path);
          const operation = match ? operations[Number(match[1])] : undefined;
          return operation ? !disclosedEffects.has(operation.requestedEffect) : false;
        });
        if (unsatisfiable) {
          hostNativeGuidance = {
            reason: 'no_disclosed_capability_carries_requested_effect',
            require: HOST_NATIVE_REQUIRE,
          };
        }
      } else if (admitted.issues.some((entry) => (
        entry.code === 'dag_kind_mismatch'
        || entry.code === 'dag_kind_metadata_missing'
        || entry.code === 'illegal_relation_payload'
        || (typeof entry.path === 'string' && entry.path.startsWith('work.topology'))
      ))) {
        // Structured work failed its own internal consistency (live
        // 2026-08-25, GPT lane: a fabricated topology for a host-native
        // briefing died on coverage-vs-cardinality — twice, because the
        // repair rebuilt the same needless structure). The hint names the
        // act-directly alternative: structure is only owed when the task
        // genuinely claims typed external work.
        hostNativeGuidance = {
          reason: 'structured_work_shape_failed',
          require: 'structured work and topology are only required when the task claims typed external operations; a host-native task may declare its goal with requestedEffect host_only, none, or compute and NO operations or topology — the tool loop executes it directly',
        };
      } else if (admitted.issues.some((entry) => entry.code === 'capability_grounding_conflict')) {
        // The grounding judge measured that the cited capability does not
        // serve the operation (live: an Apify queue-lock endpoint cited for
        // "collect available context" — a host task/goal/memory read). The
        // effect may match, so the menu test above never fires; the hint
        // still names the admissible host-native expression and still
        // enumerates nothing — re-citing a different menu entry is exactly
        // the doubling-down the live repair attempted.
        hostNativeGuidance = {
          reason: 'cited_capability_rejected_for_operation',
          require: HOST_NATIVE_REQUIRE,
        };
      }
    }
    try {
      const repaired = await input.port.interpret({
        purpose: TURN_SEMANTIC_CALL_PURPOSE,
        host,
        acceptedText: input.snapshot.acceptedText,
        repairHint: JSON.stringify(unboundTypedWork
          ? {
              reason: 'exact_capability_unbound',
              require: 'name work.operations[].capabilityRef from host.catalog.capabilities ids only',
            }
          : {
              issues: admitted.ok ? [] : admitted.issues,
              hostNative: hostNativeGuidance,
              judge: judgeRecord
                ? {
                    verdict: judgeRecord.verdict,
                    effect: judgeRecord.effect,
                    destinationPosture: judgeRecord.destinationPosture,
                    proposalDigest: judgeRecord.proposalDigest,
                  }
                : null,
              grounding: groundingReceipt
                ? {
                    verdict: groundingReceipt.overallVerdict,
                    operations: groundingReceipt.operations.map((operation) => ({
                      operationId: operation.operationId,
                      verdict: operation.verdict,
                      rationale: operation.rationale,
                    })),
                  }
                : null,
            }),
      });
      proposalCalls += 1;
      modelResult = {
        raw: repaired.raw,
        modelIdentity: modelResult.modelIdentity,
        inputTokens: modelResult.inputTokens + repaired.inputTokens,
        outputTokens: modelResult.outputTokens + repaired.outputTokens,
        latencyMs: modelResult.latencyMs + repaired.latencyMs,
      };
      admitted = admitTurnSemantics(repaired.raw, host, input.authority);
      judgeRecord = undefined;
      groundingReceipt = undefined;
      validationIssue = undefined;
      await assess();
    } catch {
      // keep the first invalid outcome
    }
  }

  const record: SemanticInterpretationRecordV1 = {
    purpose: TURN_SEMANTIC_CALL_PURPOSE,
    sourceUserSeq: host.source.sourceUserSeq,
    inputHash: host.source.inputHash,
    audienceHash: host.source.audienceHash,
    policyRevision: host.policyRevision,
    payloadHash: admitted.ok ? admitted.payloadHash : sha256('invalid'),
    contextHash: admitted.ok ? admitted.contextHash : sha256('invalid'),
    modelIdentity: modelResult.modelIdentity,
    inputTokens: modelResult.inputTokens + judgeInputTokens + groundingInputTokens,
    outputTokens: modelResult.outputTokens + judgeOutputTokens + groundingOutputTokens,
    latencyMs: modelResult.latencyMs + judgeLatencyMs + groundingLatencyMs,
    proposalInputTokens: modelResult.inputTokens,
    proposalOutputTokens: modelResult.outputTokens,
    proposalLatencyMs: modelResult.latencyMs,
    judgeInputTokens,
    judgeOutputTokens,
    judgeLatencyMs,
    groundingInputTokens,
    groundingOutputTokens,
    groundingLatencyMs,
    proposalCalls,
    effectJudgeCalls,
    groundingJudgeCalls,
    validationOutcome: admitted.ok ? 'admitted' : 'invalid',
    repairAttempted,
    raw: modelResult.raw,
    evidenceFloor,
    ...(validationIssue ? { validationIssue } : {}),
    ...(judgeRecord ? {
      judgeIdentity: judgeRecord.modelIdentity,
      judgeResult: {
        verdict: judgeRecord.verdict,
        effect: judgeRecord.effect,
        destinationPosture: judgeRecord.destinationPosture,
        proposalDigest: judgeRecord.proposalDigest,
      },
      judgeDigest: judgeRecord.digest,
    } : {}),
    ...(groundingReceipt ? {
      groundingIdentity: groundingReceipt.modelIdentity,
      groundingCatalogDigest: groundingReceipt.catalogSnapshotDigest,
      groundingShownDigest: groundingReceipt.shownDescriptorDigest,
      groundingProposalDigest: groundingReceipt.proposalDigest,
      groundingOverallVerdict: groundingReceipt.overallVerdict,
      groundingReceiptDigest: groundingReceipt.digest,
      groundingVerdicts: groundingReceipt.operations,
    } : {}),
  };
  if (!persistInterpretation(input.snapshot.sessionId, input.turn, record, owner)) {
    return { status: 'blocked', reason: 'semantic interpretation claim was stolen', record, replayed: false };
  }

  if (!admitted.ok) {
    return { status: 'blocked', reason: 'semantic proposal was not admitted', record, replayed: false };
  }
  return {
    status: 'admitted',
    record,
    replayed: false,
    clamped: admitted.clamped,
    source: admitted.source,
    payloadHash: admitted.payloadHash,
    contextHash: admitted.contextHash,
  };
}

export async function interpretAcceptedSource(input: {
  snapshot: DurableSemanticSnapshotV1;
  authority: HostSemanticAuthorityV1;
  port: TurnSemanticModelPort;
  turn: number;
}): Promise<InterpretAcceptedSourceResult> {
  const key = claimKey(input.snapshot.sessionId, input.snapshot.sourceUserSeq);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const work = interpretOnce(input).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, work);
  return work;
}

export type TypedClarificationClassificationV1 =
  | { disposition: 'selected' | 'provided'; selectedOption?: string }
  | {
      keepOpen: true;
      metaAction?: 'explain' | 'customize';
      questionId?: string;
      slotKey?: string;
      optionId?: string;
    };

/** Admitted task relation for this exact accepted source. Consumers should
 * prefer this checked relation over guessing continuation from wording. */
export function taskRelationFromLastInterpretation(
  sessionId: string,
  sourceUserSeq: number,
): import('../harness/current-task-authority.js').CurrentTaskSemanticRelation | undefined {
  const persisted = readPersistedInterpretation(sessionId, sourceUserSeq);
  if (
    !persisted
    || persisted.validationOutcome !== 'admitted'
    || !persisted.raw
    || typeof persisted.raw !== 'object'
    || Array.isArray(persisted.raw)
  ) return undefined;
  const relation = (persisted.raw as Record<string, unknown>).relation;
  switch (relation) {
    case 'conversation':
    case 'new_goal':
    case 'continue_goal':
    case 'answer_open_slot':
    case 'amend_goal':
    case 'abandon_goal':
    case 'ambiguous':
      return relation;
    default:
      return undefined;
  }
}

/** Exact persisted relation identity for the one unresolved-slot reoffer
 * owner. A generic keepOpen projection also covers a legitimately new goal
 * with its own questions, so callers cloning the prior Q must require this
 * narrower admitted `ambiguous` record and its original goal revision. */
export function ambiguousOpenSlotTargetFromLastInterpretation(
  sessionId: string,
  sourceUserSeq: number,
): { target: { goalId: string; baseRevision: number } | null } | null {
  const persisted = readPersistedInterpretation(sessionId, sourceUserSeq);
  if (
    !persisted
    || persisted.validationOutcome !== 'admitted'
    || !persisted.raw
    || typeof persisted.raw !== 'object'
    || Array.isArray(persisted.raw)
  ) return null;
  const raw = persisted.raw as Record<string, unknown>;
  const target = raw.targetGoal;
  if (
    raw.relation !== 'ambiguous'
    || raw.goal !== null
    || raw.work !== null
    || !Array.isArray(raw.slotAnswers)
    || raw.slotAnswers.length !== 0
  ) return null;
  // A legal ambiguous interpretation may be unable to nominate a goal at all
  // (the exact live workflow-name correction did this). Absence carries no
  // goal authority; when the model does nominate one, bind it exactly below.
  if (target === null) return { target: null };
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
  const goalId = (target as Record<string, unknown>).goalId;
  const baseRevision = (target as Record<string, unknown>).baseRevision;
  return typeof goalId === 'string'
    && goalId.length > 0
    && Number.isSafeInteger(baseRevision)
    && Number(baseRevision) >= 0
    ? { target: { goalId, baseRevision: Number(baseRevision) } }
    : null;
}

/** Exact admitted semantic witness for a caller that needs to act on a
 * free-text open-slot answer. A consumed continuity row is a replay store,
 * not authority by itself; callers must bind it back to this claim-linked
 * interpretation before treating the answer as an executable correction. */
export function admittedOpenSlotValueFromLastInterpretation(
  sessionId: string,
  sourceUserSeq: number,
): {
  goalId: string;
  baseRevision: number;
  questionId: string;
  slotKey: string;
  value: string;
} | null {
  const persisted = readPersistedInterpretation(sessionId, sourceUserSeq);
  if (
    !persisted
    || persisted.validationOutcome !== 'admitted'
    || !persisted.raw
    || typeof persisted.raw !== 'object'
    || Array.isArray(persisted.raw)
  ) return null;
  const raw = persisted.raw as Record<string, unknown>;
  const target = raw.targetGoal;
  const answers = raw.slotAnswers;
  if (
    raw.relation !== 'answer_open_slot'
    || raw.goal !== null
    || raw.work !== null
    || !target
    || typeof target !== 'object'
    || Array.isArray(target)
    || !Array.isArray(answers)
    || answers.length !== 1
  ) return null;
  const answer = answers[0];
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null;
  const goalId = (target as Record<string, unknown>).goalId;
  const baseRevision = (target as Record<string, unknown>).baseRevision;
  const fields = answer as Record<string, unknown>;
  const questionId = fields.questionId;
  const slotKey = fields.slotKey;
  const value = fields.value;
  return fields.kind === 'value'
    && typeof goalId === 'string'
    && goalId.length > 0
    && Number.isSafeInteger(baseRevision)
    && Number(baseRevision) >= 0
    && typeof questionId === 'string'
    && questionId.length > 0
    && typeof slotKey === 'string'
    && slotKey.length > 0
    && typeof value === 'string'
    && value.length > 0
    ? {
        goalId,
        baseRevision: Number(baseRevision),
        questionId,
        slotKey,
        value,
      }
    : null;
}

export function typedClassificationFromLastInterpretation(
  sessionId: string,
  sourceUserSeq: number,
): TypedClarificationClassificationV1 | undefined {
  const persisted = readPersistedInterpretation(sessionId, sourceUserSeq);
  if (!persisted) return undefined;
  if (persisted.validationOutcome !== 'admitted' || !persisted.raw || typeof persisted.raw !== 'object') {
    return { keepOpen: true };
  }
  const raw = persisted.raw as {
    relation?: string;
    work?: unknown;
    goal?: { openSlots?: unknown[] } | null;
    slotAnswers?: Array<{
      kind?: string;
      questionId?: string;
      slotKey?: string;
      optionId?: string;
      action?: string;
    }>;
  };
  if (raw.relation === 'ambiguous') return { keepOpen: true };
  if (
    raw.relation === 'new_goal'
    && raw.work == null
    && Array.isArray(raw.goal?.openSlots)
    && raw.goal.openSlots.length > 0
  ) {
    return { keepOpen: true };
  }
  if (raw.relation === 'answer_open_slot') {
    const answer = raw.slotAnswers?.[0];
    if (
      answer?.kind === 'meta'
      && (answer.action === 'explain' || answer.action === 'customize')
      && answer.questionId
      && answer.slotKey
      && answer.optionId
    ) {
      return {
        keepOpen: true,
        metaAction: answer.action,
        questionId: answer.questionId,
        slotKey: answer.slotKey,
        optionId: answer.optionId,
      };
    }
    if (answer?.kind === 'option' && answer.optionId) {
      return { disposition: 'selected', selectedOption: answer.optionId };
    }
    return { disposition: 'provided' };
  }
  return undefined;
}

export function hostViewOf(snapshot: DurableSemanticSnapshotV1): TurnSemanticHostViewV1 {
  return buildTurnSemanticHostViewV1(snapshot);
}

export function readPersistedSemanticInterpretation(
  sessionId: string,
  sourceUserSeq: number,
): SemanticInterpretationRecordV1 | null {
  return readPersistedInterpretation(sessionId, sourceUserSeq);
}

/** Host copy for an admitted new_goal whose only remaining work is open slots. */
export function clarifyingOpenSlotQuestionForSource(
  sessionId: string,
  sourceUserSeq: number,
): string | null {
  const persisted = readPersistedInterpretation(sessionId, sourceUserSeq);
  if (!persisted || persisted.validationOutcome !== 'admitted' || !persisted.raw || typeof persisted.raw !== 'object') {
    return null;
  }
  const raw = persisted.raw as {
    relation?: string;
    work?: {
      requestedEffect?: unknown;
      operations?: unknown[];
      destination?: { posture?: unknown; handleRequired?: unknown } | null;
      destinations?: Array<{ posture?: unknown; handleRequired?: unknown }> | null;
    } | null;
    goal?: { openSlots?: Array<{ question?: unknown }>; objective?: unknown } | null;
  };
  if (raw.relation !== 'new_goal') return null;
  const slots = Array.isArray(raw.goal?.openSlots) ? raw.goal.openSlots : [];
  const questions = slots
    .map((slot) => String(slot?.question ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((question) => (question.endsWith('?') ? question : `${question}?`));
  const sinks = [
    ...(Array.isArray(raw.work?.destinations) ? raw.work.destinations : []),
    ...(raw.work?.destination ? [raw.work.destination] : []),
  ];
  const operations = Array.isArray(raw.work?.operations) ? raw.work.operations : [];
  const unboundOps = operations.length > 0
    && operations.every((operation) => {
      const ref = (operation as { capabilityRef?: unknown }).capabilityRef;
      return !ref || ref === 'unknown';
    });
  const underspecifiedWrite = Boolean(
    raw.work
    && (
      unboundOps
      || (
        operations.length === 0
        && (
          raw.work.requestedEffect === 'unknown'
          || raw.work.requestedEffect === 'none'
          || (
            (raw.work.requestedEffect === 'external_write' || raw.work.requestedEffect === 'local_write')
            && (
              sinks.length === 0
              || sinks.some((sink) => sink.posture === 'named_existing' && sink.handleRequired === true)
            )
          )
        )
      )
    ),
  );
  if (questions.length === 0 && !underspecifiedWrite) return null;
  const objective = String(raw.goal?.objective ?? '').replace(/\s+/g, ' ').trim();
  if (objective) {
    questions.push(
      `Which system, workspace, sheet, or channel should I use before I start — ${objective.replace(/[.?!]+$/, '')}?`,
    );
  }
  return questions.length > 0 ? questions.join(' ') : null;
}

/** Host-only sketches are not connected-app binds. The model loop may emit structured output. */
export function hostOnlySketchForSource(
  sessionId: string,
  sourceUserSeq: number,
): boolean {
  const persisted = readPersistedInterpretation(sessionId, sourceUserSeq);
  if (!persisted || persisted.validationOutcome !== 'admitted' || !persisted.raw || typeof persisted.raw !== 'object') {
    return false;
  }
  return isHostOnlySketchProposal(persisted.raw);
}

/** An ADMITTED proposal that claims no typed operations has nothing to bind:
 *  "unbound work" requires claimed work. Zero-op turns dispatch to the gated
 *  model loop, where every actual call still meets its own effect gate — a
 *  write cannot happen ungated there. Live 2026-08-25 (unified lane, three
 *  variants in a row): honest zero-op proposals declaring host_only, then
 *  null work, then unknown each fell into the unbound-work walls built for
 *  claimed-but-unbindable plans, blocking or parking a fully-specified step. */
export function admittedProposalClaimsNoTypedWork(
  sessionId: string,
  sourceUserSeq: number,
): boolean {
  const persisted = readPersistedInterpretation(sessionId, sourceUserSeq);
  if (!persisted || persisted.validationOutcome !== 'admitted' || !persisted.raw || typeof persisted.raw !== 'object') {
    return false;
  }
  const raw = persisted.raw as { work?: { operations?: unknown[] | null } | null };
  if (raw.work === null || raw.work === undefined) return true;
  const operations = Array.isArray(raw.work.operations) ? raw.work.operations : [];
  return operations.length === 0;
}

/** Pure shape decision behind hostOnlySketchForSource, exported for pins. */
export function isHostOnlySketchProposal(rawProposal: unknown): boolean {
  if (!rawProposal || typeof rawProposal !== 'object') return false;
  const raw = rawProposal as {
    work?: {
      requestedEffect?: unknown;
      operations?: Array<{ requestedEffect?: unknown }> | null;
    } | null;
  };
  const hostNative = (effect: unknown): boolean => (
    effect === 'host_only' || effect === 'none' || effect === 'compute'
  );
  const operations = Array.isArray(raw.work?.operations) ? raw.work.operations : [];
  if (operations.length > 0) {
    return operations.every((operation) => hostNative(operation.requestedEffect));
  }
  // Zero operations is the ACT-DIRECTLY shape (live 2026-08-25, unified-lane
  // morning-briefing): an admitted goal whose work is absent, or declares a
  // host-native effect with nothing typed to bind, is host work for the model
  // loop — the same loop that would have run it as a chat turn. A zero-op
  // work that DECLARES a write keeps the fail-closed wall: consequential
  // writes never fall through to the conversation loop unbound.
  if (raw.work === null || raw.work === undefined) return true;
  return hostNative(raw.work.requestedEffect);
}

export function blockedPresentationForSemanticRecord(
  record: SemanticInterpretationRecordV1 | null,
): string {
  const issue = record?.validationIssue?.code ?? '';
  if (/capability|grounding|catalog|schema|account|provider|identity/i.test(issue)) {
    const held = heldExecutionTextForInternalReason(issue, 'blocked');
    if (held !== issue) return held;
  }
  if (!record || record.validationOutcome === 'model_failed') {
    return 'I could not finish planning that, so I stopped before using any tools. You can restate it.';
  }
  // A record that was ADMITTED and still reaches this blocked presentation
  // means the failure came AFTER planning — observed live 2026-08-25: the
  // repaired plan was admitted and the graph persist was refused, yet the user
  // was told the plan "did not pass my own structural check either time". A
  // blocked message must never contradict the durable record it is standing on.
  if (record.validationOutcome === 'admitted') {
    return 'I planned that successfully, but an internal step failed before I could start executing, so nothing ran and nothing changed. This is a fault on my side — not your wording, and not the plan. Ask me to run it again.';
  }
  // "Restate it" is aimed at the user, but a validation failure is the PLAN
  // failing its own structural check — the request was understood, and
  // rewording it changes nothing. Say which of the two it was, so a scheduled
  // run that nobody rephrased does not read as the owner's fault.
  if (record.repairAttempted) {
    return 'I built a plan for that twice and it did not pass my own structural check either time, so I stopped before using any tools. This is not your wording — the plan itself was inconsistent.';
  }
  return 'I could not finish planning that, so I stopped before using any tools. You can restate or continue.';
}
