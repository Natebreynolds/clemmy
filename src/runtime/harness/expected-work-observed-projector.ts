/**
 * Durable expected-work observation projector.
 *
 * This seam joins an accepted operation to the one immutable logical
 * settlement that created it. Requirement identity is read from that join;
 * callers cannot restate it here. Read coverage is preliminary host evidence
 * derived only from the settlement-bound raw result handle. The later
 * manifest receipt redeems the same handle for terminal proof.
 */
import type { AcceptedTaskWorkContractV1 } from './expected-work-contract.js';
import {
  type ObservedExpectedWorkHistoryV1,
  type ObservedExpectedWorkOperationV1,
} from './expected-work-matcher.js';
import { openEventLog } from './eventlog.js';
import { operationEvidenceContract } from '../graph/operation-evidence-contract.js';
import { redeemSuccessfulSettlementResultForHost } from './result-handle.js';
import { redeemDurableLogicalCallSettlementForHost } from './logical-call-settlement-store.js';
import { proveFiniteReadResultCoverage } from './read-evidence-refinement.js';
import { providerEnvelopeHasContradiction } from './provider-read-evidence.js';
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

      if (effect === 'read' && exactSettlement) {
        const redeemed = redeemSuccessfulSettlementResultForHost({
          sessionId: input.contract.identity.sessionId,
          sourceUserSeq: input.contract.identity.sourceUserSeq,
          acceptedTaskId: input.contract.acceptedTaskId,
          logicalToolCallId: row.logical_tool_call_id,
        });
        if (redeemed.status === 'ok') {
          if (evidenceMode === 'point_read' && !providerEnvelopeHasContradiction(redeemed.value.rawPayload)) {
            coverage = 'observed';
          } else if (
            evidenceMode === 'collection_read'
            && redeemed.value.handle.completeness === 'complete'
            && redeemed.value.handle.continuationRef === null
            && redeemed.value.handle.continuationRepeated === false
            && !providerEnvelopeHasContradiction(redeemed.value.rawPayload)
          ) {
            coverage = 'complete';
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
        // Dynamic universes remain staged until a scheduler-owned item/seal
        // projection exists. An action contract therefore fails closed here;
        // no caller may fabricate a complete-source seal.
        universes: [],
      },
    };
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}
