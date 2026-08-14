/**
 * Durable expected-work observation projector.
 *
 * This seam joins an accepted operation to the one immutable logical
 * settlement that created it. Requirement identity is read from that join;
 * callers cannot restate it here. Read coverage is preliminary host evidence
 * derived only from the settlement-bound raw result handle. The later
 * manifest receipt redeems the same handle for terminal proof.
 */
import type Database from 'better-sqlite3';
import { generatedArtifactReadContentVerified } from './artifact-ledger.js';
import type { AcceptedTaskWorkContractV1 } from './expected-work-contract.js';
import {
  computeResultHasSubstance,
  type ObservedExpectedWorkHistoryV1,
  type ObservedExpectedWorkOperationV1,
  type ObservedExpectedWorkUniverseV1,
} from './expected-work-matcher.js';
import {
  createExpectedWorkUniverseSealCache,
  sealSourceDerivedUniverse,
} from './expected-work-universe-seal.js';
import { openEventLog } from './eventlog.js';
import { operationEvidenceContract } from '../graph/operation-evidence-contract.js';
import {
  redeemedReadIsExhausted,
  redeemSuccessfulSettlementResultForHost,
} from './result-handle.js';
import { redeemDurableLogicalCallSettlementForHost } from './logical-call-settlement-store.js';
import { proveFiniteReadResultCoverage } from './read-evidence-refinement.js';
import { inspectProviderEnvelope } from './provider-read-evidence.js';
import type { RuntimeToolEffect } from './tool-effect.js';
import type { ObservedReversibility } from './resolution-ledger.js';

interface AcceptedOperationProjectionRow {
  operation_id: string;
  logical_tool_call_id: string;
  resolved_tool: string;
  effect_kind: RuntimeToolEffect;
  reversibility: ObservedReversibility;
  outcome_kind: string | null;
  dispatch_state: 'not_started' | 'dispatched' | null;
  physical_dispatch_id: string | null;
  requirement_id: string | null;
  universe_item_id: string | null;
  universe_id: string | null;
  universe_selector_json: string | null;
  universe_member_digest: string | null;
  universe_member_count: number | null;
  schema_digest: string | null;
  bound_evidence_mode: 'point_read' | 'collection_read' | 'finite_read' | null;
}

export type ExpectedWorkObservedProjection =
  | { status: 'ok'; history: ObservedExpectedWorkHistoryV1 }
  | { status: 'storage_error'; reason: string };

/**
 * Re-derive each source-derived universe from its producer's settled result,
 * then require every consumer binding that already recorded a seal to agree
 * with what was just derived. A universe that cannot be re-derived, or whose
 * durable digest disagrees, is simply not projected: the matcher then reports
 * it unsealed rather than matching against a member list nobody can prove.
 */
function sealedUniversesFor(
  db: Database.Database,
  contract: AcceptedTaskWorkContractV1,
): ObservedExpectedWorkUniverseV1[] {
  const cache = createExpectedWorkUniverseSealCache();
  const projected: ObservedExpectedWorkUniverseV1[] = [];
  for (const universe of contract.universes) {
    if (universe.seal !== 'complete_source_receipt') continue;
    const sealed = sealSourceDerivedUniverse({ db, contract, universe, cache });
    if (sealed.status !== 'sealed') continue;
    const recorded = db.prepare(`
      SELECT DISTINCT input_source_kind, input_source_ref, input_source_digest
        FROM expected_work_call_bindings
       WHERE session_id = ? AND source_user_seq = ?
         AND contract_id = ? AND universe_id = ?
    `).all(
      contract.identity.sessionId,
      contract.identity.sourceUserSeq,
      contract.contractId,
      universe.id,
    ) as Array<{
      input_source_kind: string | null;
      input_source_ref: string | null;
      input_source_digest: string | null;
    }>;
    if (recorded.some((row) =>
      row.input_source_kind !== 'complete_source_receipt'
      || row.input_source_ref !== sealed.seal.producerLogicalToolCallId
      || row.input_source_digest !== sealed.seal.digest)) continue;
    projected.push({
      universeId: universe.id,
      seal: 'complete_source_receipt',
      producerRequirementId: sealed.seal.producerRequirementId,
      complete: true,
      members: sealed.seal.members,
    });
  }
  return projected;
}

function boundedReason(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 240);
}

function projectedEffect(effect: RuntimeToolEffect): ObservedExpectedWorkOperationV1['effect'] {
  return effect === 'read'
    || effect === 'compute'
    || effect === 'local_write'
    || effect === 'external_write'
    || effect === 'admin'
    ? effect
    : 'unknown';
}

/**
 * Project the currently closed-or-tentatively-closed observed set.
 *
 * `finalized:true` may be supplied inside the resolution close transaction to
 * ask whether that exact frozen set is admissible. It does not assert that the
 * row has already closed; only the resolution CAS may do that.
 */
export function projectObservedExpectedWorkHistory(input: {
  contract: AcceptedTaskWorkContractV1;
  finalized: boolean;
}): ExpectedWorkObservedProjection {
  try {
    const db = openEventLog();
    const rows = db.prepare(`
      SELECT o.operation_id, o.logical_tool_call_id, o.resolved_tool,
             o.effect_kind, o.reversibility, o.outcome_kind, o.dispatch_state,
             o.physical_dispatch_id,
             b.requirement_id, b.universe_item_id, b.universe_id,
             b.universe_selector_json, b.universe_member_digest,
             b.universe_member_count, b.schema_digest,
             b.evidence_mode AS bound_evidence_mode
        FROM accepted_task_operations o
        LEFT JOIN expected_work_call_bindings b
          ON b.session_id = o.session_id
         AND b.source_user_seq = o.source_user_seq
         AND b.logical_tool_call_id = o.logical_tool_call_id
       WHERE o.session_id = ? AND o.source_user_seq = ?
       ORDER BY o.recorded_at, o.operation_id
    `).all(
      input.contract.identity.sessionId,
      input.contract.identity.sourceUserSeq,
    ) as AcceptedOperationProjectionRow[];

    const operations: ObservedExpectedWorkOperationV1[] = rows.map((row) => {
      const effect = projectedEffect(row.effect_kind);
      const lexicalEvidence = operationEvidenceContract({
        resolvedTool: row.resolved_tool,
        effectKind: row.effect_kind,
        reversibility: row.reversibility,
      });
      const evidenceMode = row.bound_evidence_mode ?? lexicalEvidence.mode;
      const redeemedSettlement = redeemDurableLogicalCallSettlementForHost({
        sessionId: input.contract.identity.sessionId,
        sourceUserSeq: input.contract.identity.sourceUserSeq,
        acceptedTaskId: input.contract.acceptedTaskId,
        logicalToolCallId: row.logical_tool_call_id,
      });
      const settlement = redeemedSettlement.status === 'ok'
        ? redeemedSettlement.settlement
        : undefined;
      const exactSettlement = settlement !== undefined
        && settlement.toolName === row.resolved_tool
        && settlement.recovery.businessCall === true
        && (row.requirement_id === null
          || settlement.recovery.requirementId === row.requirement_id)
        && settlement.recovery.continuesRequirement !== true
        && settlement.outcome.kind === row.outcome_kind
        && (settlement.outcome.kind === 'succeeded' || settlement.outcome.kind === 'empty_result')
        && row.dispatch_state === 'dispatched'
        && row.physical_dispatch_id !== null
        && settlement.crossings.at(-1)?.physicalDispatchId === row.physical_dispatch_id;
      let coverage: ObservedExpectedWorkOperationV1['coverage'] = effect === 'read'
        ? 'partial'
        : 'not_applicable';

      // A settled local compute execution can carry the deterministic
      // retrieve route's one read (the safety taxonomy labels read-only
      // CLI/shell work 'compute'). Coverage 'observed' asserts exactly what
      // the host can prove: it executed the call itself and holds a
      // substantive redeemable payload. An envelope-only acknowledgement
      // stays 'not_applicable' and discharges nothing.
      if (effect === 'compute' && exactSettlement) {
        const redeemed = redeemSuccessfulSettlementResultForHost({
          sessionId: input.contract.identity.sessionId,
          sourceUserSeq: input.contract.identity.sourceUserSeq,
          acceptedTaskId: input.contract.acceptedTaskId,
          logicalToolCallId: row.logical_tool_call_id,
        });
        if (redeemed.status === 'ok' && computeResultHasSubstance(redeemed.value.rawPayload)) {
          coverage = 'observed';
        }
      }

      if (effect === 'read' && exactSettlement) {
        const redeemed = redeemSuccessfulSettlementResultForHost({
          sessionId: input.contract.identity.sessionId,
          sourceUserSeq: input.contract.identity.sourceUserSeq,
          acceptedTaskId: input.contract.acceptedTaskId,
          logicalToolCallId: row.logical_tool_call_id,
        });
        if (redeemed.status === 'ok') {
          if (generatedArtifactReadContentVerified({
            sessionId: input.contract.identity.sessionId,
            sourceUserSeq: input.contract.identity.sourceUserSeq,
            contractId: input.contract.contractId,
            verificationLogicalToolCallId: row.logical_tool_call_id,
          })) {
            // The provider-reviewed generated-artifact contract compares the
            // full exact destination (including header/cell/row order), which
            // is stronger than generic collection exhaustion.
            coverage = 'complete';
          } else if (evidenceMode === 'point_read' && inspectProviderEnvelope(redeemed.value.rawPayload).verdict === 'clean') {
            coverage = 'observed';
          } else if (
            evidenceMode === 'collection_read'
            && redeemedReadIsExhausted(redeemed.value)
          ) {
            coverage = 'complete';
          } else if (
            // A clean collection read with no outstanding continuation and no
            // provider-reported partiality is durably OBSERVED even when
            // exhaustion is unprovable (completeness 'unknown' with no
            // cursor). Whether observation suffices is the matcher's call:
            // resolved-operation coverage accepts it; complete_set never does.
            evidenceMode === 'collection_read'
            && inspectProviderEnvelope(redeemed.value.rawPayload).verdict === 'clean'
            && redeemed.value.handle.continuationRef === null
            && !redeemed.value.handle.continuationRepeated
            && redeemed.value.handle.completeness !== 'partial'
          ) {
            coverage = 'observed';
          } else if (
            evidenceMode === 'finite_read'
            && row.universe_id
            && row.universe_selector_json
            && row.universe_member_digest
            && row.universe_member_count
            && row.schema_digest
          ) {
            const universe = input.contract.universes.find((entry) => entry.id === row.universe_id);
            try {
              const selector = JSON.parse(row.universe_selector_json) as {
                argumentPointer: string;
                memberIdPointer: string | null;
              };
              const members = row.universe_item_id
                ? [row.universe_item_id]
                : universe?.seal === 'accepted_input' ? universe.members : [];
              if (proveFiniteReadResultCoverage({
                proof: {
                  universeId: row.universe_id,
                  memberCount: row.universe_member_count,
                  argumentPointer: selector.argumentPointer,
                  memberIdPointer: selector.memberIdPointer,
                  schemaDigest: row.schema_digest,
                  memberDigest: row.universe_member_digest,
                },
                requestedMembers: members,
                rawResult: redeemed.value.rawPayload,
              }).status === 'proved') coverage = 'complete';
            } catch {
              coverage = 'partial';
            }
          }
        }
      }

      return {
        id: row.operation_id,
        ...((row.requirement_id ?? settlement?.recovery.requirementId)
          ? { requirementId: (row.requirement_id ?? settlement?.recovery.requirementId) as string }
          : {}),
        ...(row.universe_item_id ? { universeItemId: row.universe_item_id } : {}),
        effect,
        // The host's own reversibility classification travels with the
        // observation: only an irreversible effect can turn off-plan work into
        // a contract violation.
        reversibility: row.reversibility,
        outcome: exactSettlement ? 'succeeded' : 'failed',
        evidenceMode,
        coverage,
      };
    });

    return {
      status: 'ok',
      history: {
        finalized: input.finalized,
        operations,
        // Source-derived universes are sealed from the producer read's own
        // settled complete result and cross-checked against the digest every
        // consumer binding froze. No caller may hand in a seal.
        universes: sealedUniversesFor(db, input.contract),
      },
    };
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}
