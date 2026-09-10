/**
 * DELEGATED EXPECTED WORK — a worker child writes one planned item.
 *
 * The parent's frozen contract names a per-item requirement (`each` over a
 * sealed universe). Until 2026-09-09 a nested worker child (its own session,
 * its own accepted task, its own root attestation) had no contract of its
 * own, so its business writes were refused at the write door and every
 * fan-out serialized through the parent. The owner's ask: workers write.
 *
 * Two host-owned halves, no new model behaviour:
 *
 *  1. delegateExpectedWorkToChild — once the host has armed the child: if the
 *     packet names a requirement the parent's contract really holds as `each`
 *     and the child's item is a member of that universe, the child carries the
 *     parent's planning surface (tool_search, plan_task, the proposal-free
 *     work_call) with the packet's local tools disclosed to its own catalog,
 *     and plans its one item itself: the same doors the parent walked, the
 *     same ledger proofs, its own attestation and settlement.
 *
 *  2. creditDelegatedExpectedWork — after the child returns: the parent's plan
 *     line for that item is credited only when the child's OWN contract reports
 *     the item discharged (dischargedRequirementItems — the same proof the
 *     parent applies to itself: succeeded, reconciled, crossed, commit-
 *     verified). A worker's prose "done" credits nothing.
 *
 * External writes are untouched: the child's compose-only boundary
 * (WORKER_COMPOSE_ONLY) still refuses them; this delegates local writes.
 */
import { appendEvent, listEvents, openEventLog } from './eventlog.js';
import { loadExpectedWorkContract } from './expected-work-contract.js';
import { dischargedRequirementItems, publishExpectedWorkProgress } from './expected-work-admission.js';
import { createExpectedWorkUniverseSealCache, resolveExpectedWorkUniverseMembers } from './expected-work-universe-seal.js';
import { isRegistryDeclaredLocalPlanningCapability, issueAuthorizedLocalPlanningDisclosureCandidate } from './local-planning-capability.js';
import { disclosePrimaryModelPlanningCapabilities, type HostFreshPlanningContextV1 } from '../semantic-boundary/admit-and-compile-accepted-source.js';

export interface DelegableExpectedWork {
  requirementId: string;
  universeId: string;
  effect: string;
  contractId: string;
}

/** Whether the parent's frozen contract really delegates this item. Pure read. */
export function delegableExpectedWorkForItem(input: {
  parentSessionId: string;
  parentSourceUserSeq: number;
  expectedWork: { requirementId: string; universeId?: string | null } | null | undefined;
  item: string;
}): DelegableExpectedWork | null {
  if (!input.expectedWork?.requirementId || !input.item) return null;
  try {
    const loaded = loadExpectedWorkContract(input.parentSessionId, input.parentSourceUserSeq);
    if (loaded.status !== 'ok') return null;
    const contract = loaded.contract;
    const operation = contract.operations.find((entry) => entry.id === input.expectedWork!.requirementId);
    if (!operation || operation.cardinality.kind !== 'each') return null;
    // Delegation covers correctable work. An external effect stays with the
    // parent's compose-then-commit boundary.
    if (operation.effect !== 'local_write' && operation.effect !== 'compute' && operation.effect !== 'read') return null;
    const universeId = operation.cardinality.universeId;
    if (input.expectedWork.universeId && input.expectedWork.universeId !== universeId) return null;
    const universe = contract.universes.find((entry) => entry.id === universeId);
    if (!universe) return null;
    const resolved = resolveExpectedWorkUniverseMembers({
      db: openEventLog(), contract, universe, cache: createExpectedWorkUniverseSealCache(),
    });
    if (resolved.status !== 'resolved' || !resolved.members.includes(input.item)) return null;
    return { requirementId: operation.id, universeId, effect: operation.effect, contractId: contract.contractId };
  } catch {
    return null;
  }
}

export type DelegationResult =
  | { status: 'delegated'; requirementId: string; item: string }
  | { status: 'not_delegated'; reason: string };

/**
 * Prepare the child to PLAN AND WRITE its one item through the exact doors the
 * parent used (tool_search -> plan_task -> work_call, proven live on GLM 5.3,
 * 2026-09-09): disclose the packet's parent-resolved local tools to the
 * child's own planning catalog, and record the delegation lineage on the
 * parent. The child's contract is then its own plan_task freeze — every ledger
 * proof (activation receipt, binding seal, checkpoint) comes from the real
 * control, never from a host-forged shortcut. A host-frozen contract was tried
 * and refused by the schema itself: graph resolution over a host root demands
 * the settled plan_task proof.
 */
export async function delegateExpectedWorkToChild(input: {
  parentSessionId: string;
  parentSourceUserSeq: number;
  childSessionId: string;
  childSourceUserSeq: number;
  childTurn: number;
  item: string;
  delegable: DelegableExpectedWork;
  /** The packet's exact local tools (parent-resolved). Their authorized local
   *  definitions are disclosed to the child's planning catalog the way its own
   *  tool_search would, so plan_task can bind them and the consent edge finds
   *  a bound definition. */
  resolvedTools?: readonly string[];
  planning?: HostFreshPlanningContextV1;
}): Promise<DelegationResult> {
  const not = (reason: string): DelegationResult => ({ status: 'not_delegated', reason });
  try {
    if (input.planning && input.resolvedTools?.length) {
      const candidates = [];
      for (const name of input.resolvedTools) {
        const exact = name.trim();
        if (!exact || !isRegistryDeclaredLocalPlanningCapability(exact)) continue;
        const candidate = await issueAuthorizedLocalPlanningDisclosureCandidate({
          name: exact, carrier: 'work_call', configuredNames: new Set([exact]),
        });
        if (candidate && !('refused' in candidate)) candidates.push(candidate);
      }
      if (candidates.length > 0) {
        await disclosePrimaryModelPlanningCapabilities({ authority: input.planning.authority, candidates });
      }
    }
    appendEvent({
      sessionId: input.parentSessionId, turn: 0, role: 'system', type: 'expected_work_delegated',
      data: {
        sourceUserSeq: input.parentSourceUserSeq, contractId: input.delegable.contractId,
        requirementId: input.delegable.requirementId, universeItemId: input.item, effect: input.delegable.effect,
        childSessionId: input.childSessionId, childSourceUserSeq: input.childSourceUserSeq,
      },
    });
    return { status: 'delegated', requirementId: input.delegable.requirementId, item: input.item };
  } catch (error) {
    return not(error instanceof Error ? error.message : String(error));
  }
}

export type DelegatedCreditResult =
  | { status: 'credited'; childLogicalToolCallId: string }
  | { status: 'already_credited' }
  | { status: 'not_discharged'; reason: string };

/** Credit the parent's plan line from the child's PROVEN discharge: the
 * child's OWN frozen contract must report the item discharged (succeeded,
 * reconciled, crossed, commit-verified — the same proof the parent applies to
 * itself) under a requirement of the delegated effect. */
export function creditDelegatedExpectedWork(input: {
  parentSessionId: string;
  parentSourceUserSeq: number;
  childSessionId: string;
  childSourceUserSeq: number;
  requirementId: string;
  item: string;
  effect?: string;
}): DelegatedCreditResult {
  const parent = loadExpectedWorkContract(input.parentSessionId, input.parentSourceUserSeq);
  if (parent.status !== 'ok') return { status: 'not_discharged', reason: `parent contract ${parent.status}` };
  const child = loadExpectedWorkContract(input.childSessionId, input.childSourceUserSeq);
  if (child.status !== 'ok') return { status: 'not_discharged', reason: `child contract ${child.status}` };
  const parentOperation = parent.contract.operations.find((entry) => entry.id === input.requirementId);
  if (!parentOperation) return { status: 'not_discharged', reason: 'parent requirement is not in its contract' };
  let discharged: { logicalToolCallId: string; childRequirementId: string } | null = null;
  for (const operation of child.contract.operations) {
    if (operation.cardinality.kind !== 'each' || operation.effect !== parentOperation.effect) continue;
    const row = dischargedRequirementItems({
      sessionId: input.childSessionId, sourceUserSeq: input.childSourceUserSeq, requirementId: operation.id,
    }).find((entry) => entry.universeItemId === input.item);
    if (row) { discharged = { logicalToolCallId: row.logicalToolCallId, childRequirementId: operation.id }; break; }
  }
  if (!discharged) return { status: 'not_discharged', reason: 'the child has no discharged settlement for this item' };
  const db = openEventLog();
  const inserted = db.prepare(`
    INSERT OR IGNORE INTO expected_work_delegated_discharges (
      session_id, source_user_seq, contract_id, requirement_id, universe_item_id,
      child_session_id, child_source_user_seq, child_contract_id, child_logical_tool_call_id, child_result_handle_id, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `).run(
    input.parentSessionId, input.parentSourceUserSeq, parent.contract.contractId, input.requirementId, input.item,
    input.childSessionId, input.childSourceUserSeq, child.contract.contractId, discharged.logicalToolCallId, new Date().toISOString(),
  );
  if (inserted.changes === 0) return { status: 'already_credited' };
  appendEvent({
    sessionId: input.parentSessionId, turn: 0, role: 'system', type: 'expected_work_delegated_discharge',
    data: {
      sourceUserSeq: input.parentSourceUserSeq, contractId: parent.contract.contractId,
      requirementId: input.requirementId, universeItemId: input.item,
      childSessionId: input.childSessionId, childRequirementId: discharged.childRequirementId,
      childLogicalToolCallId: discharged.logicalToolCallId,
    },
  });
  publishExpectedWorkProgress({ sessionId: input.parentSessionId, sourceUserSeq: input.parentSourceUserSeq });
  return { status: 'credited', childLogicalToolCallId: discharged.logicalToolCallId };
}

/** The delegation recorded for one child, if any (read back by the credit step). */
export function delegatedExpectedWorkForChild(parentSessionId: string, childSessionId: string): { requirementId: string; item: string } | null {
  const row = listEvents(parentSessionId, { types: ['expected_work_delegated'] })
    .find((event) => event.data.childSessionId === childSessionId);
  return row ? { requirementId: String(row.data.requirementId), item: String(row.data.universeItemId) } : null;
}
