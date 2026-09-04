/**
 * Fused action-topology admission.
 *
 * The model may propose semantic work and select its first concrete tool in one
 * carrier call. The proposal and the current open logical call are committed in
 * one IMMEDIATE transaction before any provider crossing. Tool/provider names
 * are transport data outside the semantic contract and never become planning
 * rules.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';
import { armAcceptedTaskAuthority } from './accepted-task-authority.js';
import {
  authorizeGeneratedArtifactReadback,
  authorizeHostSealedArtifactReadback,
  createHostSealedArtifactContentContract,
  generatedArtifactReadContentVerified,
  generatedArtifactWriteContentVerified,
  hostArtifactContentDigest,
} from './artifact-ledger.js';
import { compileAtomicInputContentContract } from './atomic-input-content-contract.js';
import { currentManifestOperationSemantics } from './current-manifest-operation-semantics.js';
import { classifyExternalWrite } from './confirm-first-gate.js';
import { extractDuplicateIdentityKeys } from './grounding-gate.js';
import { turnGraphFromShadowEvent } from '../graph/turn-graph-shadow.js';
import {
  canonicalExpectedWorkJson,
  expectedWorkDigest,
  freezePreparedExpectedWorkContractInTransaction,
  isBoundedJsonPointer,
  loadExpectedWorkContract,
  prepareActionExpectedWorkContract,
  resolveJsonPointer,
  type AcceptedTaskWorkContractV1,
  type ExpectedWorkOperationV1,
  type ExpectedWorkProposalV1,
  type ExpectedWorkUniverseV1,
} from './expected-work-contract.js';
import {
  amendSourceUniverseMemberIdPointer,
  createExpectedWorkUniverseSealCache,
  resolveExpectedWorkUniverseMembers,
  type ExpectedWorkUniverseSealCache,
} from './expected-work-universe-seal.js';
import { appendEvent, getSession, getTurnGraphEventForSource, listEvents, openEventLog } from './eventlog.js';
import { readConsumedTaskContinuityPacket } from '../../memory/task-continuity.js';
import { computeResultHasSubstance } from './expected-work-matcher.js';
import { durableLogicalCallContract } from './logical-call-contract.js';
import { redeemDurableLogicalCallSettlementForHost } from './logical-call-settlement-store.js';
import { REPAIR_ARGUMENTS_NEEDS_INPUT_TEXT } from './recovery-presentation-truth.js';
import { detectMultiItemIntent } from './multi-item-intent.js';
import {
  proveFiniteReadResultCoverage,
  refinePreDispatchReadEvidence,
  type FiniteReadStructuralProof,
} from './read-evidence-refinement.js';
import {
  inspectProviderEnvelope,
} from './provider-read-evidence.js';
import { recordsAtRecordPath, resultHasMalformedPagination } from './result-facts.js';
import {
  redeemedReadIsExhausted,
  redeemSuccessfulSettlementResultForHost,
} from './result-handle.js';
import { expectedTaskFor } from './resolution-ledger.js';
import {
  catalogOperationIdentityKey,
  isPlainOrClementineLocalTool,
} from './runtime-tool-identity.js';
import {
  getPendingAction,
  verifyConversationalPendingActionAuthority,
} from './pending-actions.js';
import { pendingActionIdFromArgs } from './pending-action-view.js';
import {
  actionTopologyRoleForRuntimeCall,
  classifyRuntimeToolEffect,
  inspectTrustedRuntimeEffectCarrier,
  runtimeExpectedWorkProjection,
  unwrapRuntimeEffectiveToolIdentity,
  type RuntimeToolEffect,
  type TrustedRuntimeEffectCarrier,
} from './tool-effect.js';
import { digestSchema } from '../../tools/tool-contract-store.js';
import {
  loadSealedNodeBinding,
  type SealedNodeBinding,
} from './host-capability-catalog-factory.js';
import { proveFrozenMutationVerification } from './mutation-verification-proof.js';
import { expectsHostLocalWorkspaceCompoundCommit } from './host-local-write-commit.js';
import { WORK_ID_PATTERN } from '../../shared/work-id.js';

export interface ExpectedWorkUniverseSelectorV1 {
  /** RFC 6901 pointer into the normalized inner tool arguments. */
  argumentPointer: string;
  /** Optional RFC 6901 pointer relative to each selected object. */
  memberIdPointer: string | null;
}

export interface ExpectedWorkCallBinding {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  contractId: string;
  requirementId: string;
  effect: Exclude<RuntimeToolEffect, 'unknown'>;
  cardinality: ExpectedWorkOperationV1['cardinality']['kind'];
  universeId?: string;
  universeItemId?: string;
  universeMemberDigest?: string;
  universeMemberCount?: number;
  evidenceMode?: 'point_read' | 'collection_read' | 'finite_read';
  evidenceBasis?: string;
  schemaFingerprint?: string;
  schemaDigest?: string;
  generatedArtifactContentContract?: unknown;
}

export type ExpectedWorkActivationResult =
  | { status: 'activated' | 'replayed'; acceptedTaskId: string }
  | { status: 'not_action' | 'missing' | 'conflict' | 'storage_error'; reason: string };

export type ActionExpectedWorkState =
  | { status: 'required'; acceptedTaskId: string; contractId?: string }
  | { status: 'not_action' }
  | { status: 'missing' | 'conflict' | 'storage_error'; reason: string };

export type ExpectedWorkAdmissionFailureKind =
  | 'work_contract_required'
  | 'work_contract_invalid'
  | 'work_contract_conflict'
  | 'work_binding_required'
  | 'work_requirement_unknown'
  | 'work_effect_mismatch'
  | 'work_dependency_pending'
  | 'work_cardinality_mismatch'
  | 'work_universe_unsealed'
  | 'work_source_witness_missing'
  | 'work_source_selection_invalid'
  | 'work_already_satisfied'
  | 'work_evidence_incomplete'
  | 'work_effect_already_executed'
  | 'work_attempt_budget_exhausted'
  | 'work_authority_unavailable';

/** One line per contract operation: what is owed, what is settled, what
 *  blocks it. Rendered into every refusal so the model steers off the frozen
 *  plan instead of guessing proposal shapes (live 2026-08-11: 84 blind
 *  refusal-retry cycles on one count-only ask). */
export interface ExpectedWorkPlanLine {
  requirementId: string;
  effect: string;
  cardinality: string;
  dependsOn: string[];
  /** Certified discharge — exhausted / sealed / verified. */
  settledInstances: number;
  /** Clean redeemable data that has landed, including unexhausted collections. */
  observedInstances: number;
  requiredInstances: number | 'unknown';
  /** `data_in` is observed work that is not yet certified complete. */
  state: 'satisfied' | 'data_in' | 'open' | 'blocked_on_dependency';
}

export type ExpectedWorkInvocationAdmission =
  | { status: 'bound' | 'replayed'; binding: ExpectedWorkCallBinding; contract: AcceptedTaskWorkContractV1 }
  /** The requirement instance is ALREADY settled — carry the prior call so
   *  the carrier can hand back its stored result instead of an error. */
  | {
      status: 'satisfied';
      priorLogicalToolCallId: string;
      contract: AcceptedTaskWorkContractV1;
      plan: ExpectedWorkPlanLine[];
    }
  /** The exact non-mutating call already settled without discharging the
   * requirement. Return its retained bytes; do not pay for an exact replay
   * and do not label the plan satisfied. */
  | {
      status: 'evidence_retained';
      priorLogicalToolCallId: string;
      contract: AcceptedTaskWorkContractV1;
      plan: ExpectedWorkPlanLine[];
    }
  /** A mutation crossed exactly once but lacks the verification evidence
   * required to discharge the plan. It must not replay and must not be called
   * satisfied. */
  | {
      status: 'effect_already_executed';
      priorLogicalToolCallId: string;
      contract: AcceptedTaskWorkContractV1;
      plan: ExpectedWorkPlanLine[];
    }
  | {
      status: 'refused';
      kind: ExpectedWorkAdmissionFailureKind;
      reason: string;
      errors?: string[];
      /** Present whenever a frozen contract exists at refusal time. */
      plan?: ExpectedWorkPlanLine[];
    };

export class ExpectedWorkBindingRequiredError extends Error {
  override readonly name = 'ExpectedWorkBindingRequiredError';
  readonly kind = 'work_binding_required' as const;
  constructor(readonly reason: string) {
    super(`Business dispatch requires a frozen work binding: ${reason}`);
  }
}

const bindingStorage = new AsyncLocalStorage<ExpectedWorkCallBinding>();

export function currentExpectedWorkBinding(): ExpectedWorkCallBinding | undefined {
  return bindingStorage.getStore();
}

export function withExpectedWorkBinding<T>(
  binding: ExpectedWorkCallBinding,
  work: () => T,
): T {
  return bindingStorage.run(binding, work);
}

/** The requirement a read/compute bypass dispatch was invoked to discharge.
 *  The bypass exists so a checker verdict cannot veto a safe read, but
 *  discarding the requirement the model named made the read's settlement
 *  invisible to the dependency oracle: 55 clean settlements and a write
 *  refused five times for a dependency that was factually complete (live
 *  2026-08-18). The named requirement is a fact about the call; settlement
 *  records it, and only the oracle decides what it is worth. */
const unboundRequirementStorage = new AsyncLocalStorage<string>();

export function currentUnboundWorkRequirementId(): string | undefined {
  return unboundRequirementStorage.getStore();
}

export function withUnboundWorkRequirement<T>(
  requirementId: string,
  work: () => T,
): T {
  return unboundRequirementStorage.run(requirementId, work);
}

function boundedReason(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 300);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allow = new Set(allowed);
  return Object.keys(value).every((key) => allow.has(key));
}

/** A finite response window attested by the provider's own input schema.
 * This is provisional-read evidence only; it never claims source exhaustion. */
function schemaBoundedCollectionWindow(args: unknown, schema: unknown): number | null {
  if (
    !args || typeof args !== 'object' || Array.isArray(args)
    || !schema || typeof schema !== 'object' || Array.isArray(schema)
  ) return null;
  const properties = (schema as Record<string, unknown>).properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null;
  const normalizedWindowKeys = new Set(['limit', 'maxresults', 'count', 'pagesize', 'maxitems', 'maxrecords']);
  const matches = Object.entries(args as Record<string, unknown>).flatMap(([key, value]) => {
    if (!normalizedWindowKeys.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))) return [];
    const property = (properties as Record<string, unknown>)[key];
    if (!property || typeof property !== 'object' || Array.isArray(property)) return [];
    const type = (property as Record<string, unknown>).type;
    if (type !== 'integer' && type !== 'number') return [];
    return Number.isSafeInteger(value) && Number(value) > 0 ? [Number(value)] : [];
  });
  return matches.length === 1 ? matches[0]! : null;
}

export function validateExpectedWorkUniverseSelector(
  value: unknown,
): { ok: true; selector: ExpectedWorkUniverseSelectorV1 } | { ok: false; reason: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'universe_selector must be an object' };
  }
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ['argumentPointer', 'memberIdPointer'])) {
    return { ok: false, reason: 'universe_selector contains an unknown field' };
  }
  if (!isBoundedJsonPointer(record.argumentPointer)) {
    return { ok: false, reason: 'universe_selector.argumentPointer must be a bounded RFC 6901 pointer' };
  }
  if (record.memberIdPointer !== null && !isBoundedJsonPointer(record.memberIdPointer)) {
    return { ok: false, reason: 'universe_selector.memberIdPointer must be null or a bounded RFC 6901 pointer' };
  }
  return {
    ok: true,
    selector: {
      argumentPointer: record.argumentPointer,
      memberIdPointer: record.memberIdPointer as string | null,
    },
  };
}

function selectedMemberIds(
  args: unknown,
  selector: ExpectedWorkUniverseSelectorV1,
  cardinality: 'each' | 'set',
): { ok: true; ids: string[] } | { ok: false; reason: string } {
  const selected = resolveJsonPointer(args, selector.argumentPointer);
  if (!selected.ok) return { ok: false, reason: 'universe selector does not resolve in normalized arguments' };
  const values = cardinality === 'set'
    ? Array.isArray(selected.value) ? selected.value : null
    : [selected.value];
  if (!values) return { ok: false, reason: 'set cardinality selector must resolve to an array' };
  if (values.length < 1 || values.length > 2_048) {
    return { ok: false, reason: 'selected universe member count is outside the bounded contract' };
  }
  const ids: string[] = [];
  for (const value of values) {
    const extracted = selector.memberIdPointer === null
      ? { ok: true as const, value }
      : resolveJsonPointer(value, selector.memberIdPointer);
    if (!extracted.ok || typeof extracted.value !== 'string' || extracted.value.length < 1 || extracted.value.length > 256) {
      return { ok: false, reason: 'every selected member must resolve to one bounded string id' };
    }
    ids.push(extracted.value);
  }
  if (new Set(ids).size !== ids.length) {
    return { ok: false, reason: 'selected universe members contain duplicate ids' };
  }
  return { ok: true, ids: [...ids].sort() };
}

interface AuthorityActivationRow {
  accepted_task_id: string;
  state: 'armed' | 'manifested_verifying' | 'terminal' | 'conflict';
  expected_work_required: number;
  work_contract_id: string | null;
  revision: number;
}

function authorityActivationRow(
  db: Database.Database,
  sessionId: string,
  sourceUserSeq: number,
): AuthorityActivationRow | undefined {
  return db.prepare(`
    SELECT accepted_task_id, state, expected_work_required, work_contract_id, revision
      FROM accepted_task_authority
     WHERE session_id = ? AND source_user_seq = ?
  `).get(sessionId, sourceUserSeq) as AuthorityActivationRow | undefined;
}

/** Durable marker used by dispatch and terminal boundaries. Historical/test
 * callers default to inactive; the production graph spine activates exact act
 * turns immediately before constructing the carrier-enabled agent. */
/** Workflow-controller sessions never enter act expected-work: the step's
 *  authority is the workflow controller (admission, validation, report-back)
 *  and its agent surface mounts no work_call carrier — activation raised a
 *  wall with no door and 500'd plain step dispatch (live 2026-08-11 sweep).
 *  An unreadable session store keeps the act protocol (fail closed). */
function typedWorkGraph(graph: { classification: { route?: string }; nodes: ReadonlyArray<{ kind?: string; operationId?: string }> }): boolean {
  if (graph.classification.route === 'act') return true;
  return graph.classification.route === 'retrieve'
    && graph.nodes.some((node) => node.kind === 'retrieve' && Boolean(node.operationId));
}

function workflowControllerOwned(sessionId: string): boolean {
  try {
    return getSession(sessionId)?.kind === 'workflow';
  } catch {
    return false;
  }
}

export function activateActionExpectedWork(input: {
  sessionId: string;
  sourceUserSeq: number;
}): ExpectedWorkActivationResult {
  const expected = expectedTaskFor(input.sessionId, input.sourceUserSeq);
  if (expected.status !== 'ok') {
    return {
      status: expected.status === 'missing' ? 'missing' : 'conflict',
      reason: expected.reason,
    };
  }
  if (!typedWorkGraph(expected.graph)) {
    return { status: 'not_action', reason: 'the exact persisted graph is not an action turn' };
  }
  if (workflowControllerOwned(input.sessionId)) {
    return { status: 'not_action', reason: 'workflow-controller sessions own their own step authority' };
  }
  const armed = armAcceptedTaskAuthority(input);
  if (armed.status !== 'armed' && armed.status !== 'existing') {
    const failure = armed as Exclude<typeof armed, { status: 'armed' | 'existing' }>;
    return { status: failure.status, reason: failure.reason } as ExpectedWorkActivationResult;
  }
  try {
    const db = openEventLog();
    const tx = db.transaction((): ExpectedWorkActivationResult => {
      const row = authorityActivationRow(db, input.sessionId, input.sourceUserSeq);
      if (!row) return { status: 'missing', reason: 'accepted task authority is missing' };
      if (row.state === 'conflict') return { status: 'conflict', reason: 'accepted task authority is conflicted' };
      if (row.expected_work_required === 1) {
        return { status: 'replayed', acceptedTaskId: row.accepted_task_id };
      }
      if (row.state !== 'armed') {
        return { status: 'conflict', reason: `action work cannot activate from ${row.state}` };
      }
      const updated = db.prepare(`
        UPDATE accepted_task_authority
           SET expected_work_required = 1, revision = revision + 1, updated_at = ?
         WHERE session_id = ? AND source_user_seq = ?
           AND state = 'armed' AND expected_work_required = 0 AND revision = ?
      `).run(new Date().toISOString(), input.sessionId, input.sourceUserSeq, row.revision);
      if (updated.changes !== 1) throw new Error('action expected-work activation lost its CAS');
      return { status: 'activated', acceptedTaskId: row.accepted_task_id };
    });
    return tx.immediate();
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export function actionExpectedWorkRequired(input: {
  sessionId: string;
  sourceUserSeq: number;
}): boolean {
  return actionExpectedWorkState(input).status === 'required';
}

/** Typed authority read for terminal and dispatch boundaries. Storage failure
 * and a missing activation marker on an accepted action never become false. */
export function actionExpectedWorkState(input: {
  sessionId: string;
  sourceUserSeq: number;
}): ActionExpectedWorkState {
  const expected = expectedTaskFor(input.sessionId, input.sourceUserSeq);
  if (expected.status !== 'ok') {
    return {
      status: expected.status === 'missing' ? 'missing' : 'conflict',
      reason: expected.reason,
    };
  }
  if (!typedWorkGraph(expected.graph)) return { status: 'not_action' };
  if (workflowControllerOwned(input.sessionId)) return { status: 'not_action' };
  try {
    const row = authorityActivationRow(openEventLog(), input.sessionId, input.sourceUserSeq);
    if (!row) return { status: 'missing', reason: 'accepted action authority row is missing' };
    if (row.state === 'conflict') return { status: 'conflict', reason: 'accepted action authority is conflicted' };
    if (row.expected_work_required !== 1) {
      return { status: 'conflict', reason: 'accepted action was not durably activated before execution' };
    }
    return {
      status: 'required',
      acceptedTaskId: row.accepted_task_id,
      ...(row.work_contract_id ? { contractId: row.work_contract_id } : {}),
    };
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

function isCarrier(tool: string): boolean {
  return isPlainOrClementineLocalTool(tool, 'work_call');
}

/** Primary local/Agents bypass wall. Reads before the contract remain available
 * for schema/capability discovery and conversational clarification, but no
 * compute or mutation can run. Once a contract exists, every classified
 * business call must carry its immutable binding. Provider crossings also hit
 * the database backstop in dispatch-ledger. */
export function assertExpectedWorkLogicalAdmission(input: {
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId?: string;
  /** A bound orchestration parent may authorize a genuinely distinct child
   * call. Prefer the child's own binding when it has one; retain the parent as
   * a compatibility fallback for existing host orchestrators. */
  fallbackLogicalToolCallId?: string;
  tool: string;
  args?: unknown;
  /** Opaque host provenance retained when a trusted wrapper has already been
   * peeled to this exact provider call. Models cannot mint this carrier. */
  trustedEffectCarrier?: TrustedRuntimeEffectCarrier;
}): void {
  const db = openEventLog();
  const authority = authorityActivationRow(db, input.sessionId, input.sourceUserSeq);
  if (!authority || authority.expected_work_required !== 1 || isCarrier(input.tool)) return;
  const candidateLogicalIds = [
    input.logicalToolCallId,
    input.fallbackLogicalToolCallId,
  ].filter((value, index, all): value is string => (
    typeof value === 'string' && value.length > 0 && all.indexOf(value) === index
  ));
  if (candidateLogicalIds.length > 0) {
    const bound = db.prepare(`
      SELECT 1 FROM expected_work_call_bindings
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id IN (${candidateLogicalIds.map(() => '?').join(', ')})
       LIMIT 1
    `).get(input.sessionId, input.sourceUserSeq, ...candidateLogicalIds);
    if (bound) return;
  }
  // Control-role tools (ask/status/discovery/execution bookkeeping) are exempt
  // REGARDLESS of contract state — the wall exists for BUSINESS dispatch, and
  // a status probe after freezing is still acquisition, not work. Gating the
  // exemption on !work_contract_id turned the first post-freeze mcp_status
  // into a turn-killing 500 on a plain conversational scenario (live
  // 2026-08-11, converse-first: run_failed ExpectedWorkBindingRequiredError).
  if (actionTopologyRoleForRuntimeCall(input.tool, input.args) === 'control') return;
  // Some host adapters peel a trusted wrapper before opening the provider's
  // logical call. The bare slug then loses the wrapper's effect vocabulary:
  // `APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS` is conservatively unknown even
  // though the exact Composio invocation is a proven read. Preserve that
  // provenance across this wall only when BOTH forms canonicalize to the same
  // accepted-task contract. The opaque carrier is WeakSet-backed, so a model
  // field or structural lookalike cannot nominate read authority.
  const trustedCarrier = inspectTrustedRuntimeEffectCarrier(input.trustedEffectCarrier);
  if (
    trustedCarrier
    && (trustedCarrier.decision.effect === 'read' || trustedCarrier.decision.effect === 'compute')
  ) {
    const directContract = durableLogicalCallContract(
      authority.accepted_task_id,
      input.tool,
      input.args,
    );
    const carrierContract = durableLogicalCallContract(
      authority.accepted_task_id,
      trustedCarrier.toolName,
      trustedCarrier.args,
    );
    if (
      directContract
      && carrierContract
      && directContract.toolName === carrierContract.toolName
      && directContract.argumentDigest === carrierContract.argumentDigest
    ) return;
  }
  // THE CONTRACT IS REQUIRED WHERE ITS GUARANTEE IS LOAD-BEARING, NOT EVERYWHERE.
  // A frozen plan exists to prove per-item once-ness and to stop an
  // unproposed irreversible effect. For a read, a compute, a local write, or
  // a reversible external write, it proves nothing the settlement ledger and
  // the evidence gates do not already prove — and demanding it first turned
  // the planner's grammar into a wall in front of every tool: three live
  // fan-out workers spent their entire budget being refused for `coverage`
  // and `dataFrom` bookkeeping, made ZERO business calls, and honestly
  // reported they had verified nothing (2026-08-12). The boundary is the
  // codebase's own definition of a dangerous effect — the same test that
  // decides whether a human must approve it.
  // A READ OR COMPUTE IS NEVER GATED BY THE BINDING. It cannot duplicate an
  // effect, so there is nothing for a frozen plan to protect — and gating it
  // makes recovery impossible: an uncertain write can only be resolved by
  // READING the destination, and nobody declares "the verification read I
  // will need if my write comes back unacknowledged" in advance. Live
  // 2026-08-12: an Apify actor run settled uncertain_write, the exact status
  // read (APIFY_ACTOR_RUNS_GET) was refused `work_binding_required`, the
  // refusal advised "use a different action or tool", and the run escalated
  // to a browser workaround and then parked asking the user to enable Chrome
  // remote debugging — to answer a question one API read answers.
  const runtimeEffect = classifyRuntimeToolEffect(input.tool, input.args).effect;
  if (runtimeEffect === 'read' || runtimeEffect === 'compute') return;
  if (!authority.work_contract_id && !frozenContractRequiredForCall(input.tool, input.args)) return;
  // A user-approved card for this EXACT call is the strongest mandate the
  // system holds: the user reviewed this payload and said yes. The wall
  // exists to stop UNPROPOSED business work; the approved card IS the
  // proposal, ratified by the one authority above any frozen contract.
  // Without this door the approve-resume dispatch of an act-routed turn died
  // here with the approval consumed and nothing sent (live 2026-08-12,
  // apr-r7i2: run_failed ExpectedWorkBindingRequiredError). Exact-payload
  // once-ness stays owned by the pending-action execution claim and the send
  // gates; this admits the dispatch, it never bypasses those.
  if (approvedMandateAdmitsCall(db, input.sessionId, input.sourceUserSeq, input.tool, input.args)) return;
  throw new ExpectedWorkBindingRequiredError(
    authority.work_contract_id
      ? `call ${input.logicalToolCallId ?? '(unidentified)'} is not bound to the frozen contract`
      : 'the action topology must be frozen before any business call',
  );
}

/**
 * Whether this exact call may only run under a frozen expected-work contract.
 *
 * IRREVERSIBILITY is the property that makes a pre-declared plan load-bearing:
 * only an effect that cannot be redone or corrected needs its once-ness proved
 * BEFORE it happens. A reversible external write (create a doc, update a
 * sheet) that ran twice is fixable, and a call the taxonomy has never seen —
 * which is most third-party actions, including the Apify actor runs at the
 * center of the live failure — is not evidence of danger, it is evidence of an
 * unfamiliar name. Making the unknown bucket require a plan put the planner's
 * grammar back in front of exactly the work that kept failing.
 *
 * Unknown-but-mutating calls are NOT unguarded: the pending-action policy
 * still fails closed on them for HUMAN approval, and that gate is unchanged.
 * A classifier that throws still fails closed here.
 */
export function frozenContractRequiredForCall(tool: string, args: unknown): boolean {
  try {
    return classifyExternalWrite(tool, args).irreversible === true;
  } catch {
    return true;
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

/**
 * True when a resolved-approved pending approval in this session names this
 * exact tool call (tool + canonical argument identity). Deliberately session-
 * scoped and exact: an approval admits only the byte-payload the user saw.
 * Shared by BOTH walls — logical admission and the dispatch ledger's paid-
 * crossing backstop — so an approved resume cannot pass one and die at the
 * other (live 2026-08-12, apr-r7i2).
 */
export function approvedMandateAdmitsCall(
  db: ReturnType<typeof openEventLog>,
  sessionId: string,
  sourceUserSeq: number,
  tool: string,
  args: unknown,
): boolean {
  try {
    const rows = db.prepare(`
      SELECT approval_id, tool, args_json, presentation_json FROM pending_approvals
       WHERE session_id = ? AND status = 'resolved' AND resolution = 'approved'
         AND (tool = ? OR presentation_json IS NOT NULL)
       ORDER BY resolved_at DESC
    `).all(sessionId, tool) as Array<{
      approval_id: string;
      tool: string;
      args_json: string | null;
      presentation_json: string | null;
    }>;
    if (rows.length === 0) return false;
    const dispatchIdentity = stableJson(args ?? null);
    return rows.some((row) => {
      if (!row.args_json) return false;
      try {
        const approvedArgs = JSON.parse(row.args_json) as unknown;
        if (!row.presentation_json && row.tool === tool && stableJson(approvedArgs) === dispatchIdentity) {
          return true;
        }
        // Autonomous conversational consent deliberately registers the
        // control surface as request_approval while freezing the real provider
        // call in a PendingAction. Admit that provider call only when the
        // resolved row points to the exact immutable action, its complete
        // human conversation provenance verifies, and the dispatched payload
        // is byte-equivalent. This is the same mandate as a formal exact-call
        // card, without falsely claiming a card was shown.
        const pendingActionId = pendingActionIdFromArgs(approvedArgs);
        const pendingAction = pendingActionId ? getPendingAction(pendingActionId) : null;
        const presentation = row.presentation_json
          ? JSON.parse(row.presentation_json) as { responseSourceUserSeq?: unknown }
          : null;
        return Boolean(
          pendingAction
          && presentation?.responseSourceUserSeq === sourceUserSeq
          && pendingAction.approvalId === row.approval_id
          && pendingAction.sessionId === sessionId
          && pendingAction.toolName === tool
          && stableJson(pendingAction.payload) === dispatchIdentity
          && verifyConversationalPendingActionAuthority(pendingAction)
        );
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function universeFor(
  contract: AcceptedTaskWorkContractV1,
  operation: ExpectedWorkOperationV1,
): ExpectedWorkUniverseV1 | undefined {
  const cardinality = operation.cardinality;
  return cardinality.kind === 'once'
    ? undefined
    : contract.universes.find((entry) => entry.id === cardinality.universeId);
}

function sourceWitness(
  db: Database.Database,
  contract: AcceptedTaskWorkContractV1,
  universe: ExpectedWorkUniverseV1,
  selectedIds: readonly string[],
):
  | { ok: true; kind: string; ref: string; digest: string }
  | { ok: false; reason: string; callTargetFallback: boolean } {
  if (universe.seal !== 'accepted_input') {
    return {
      ok: false,
      reason: 'complete-source universes remain sealed until their host receipt is redeemable',
      callTargetFallback: false,
    };
  }
  const row = db.prepare(`
    SELECT id, data_json FROM events
     WHERE session_id = ? AND seq = ? AND type = 'user_input_received'
  `).get(contract.identity.sessionId, contract.identity.sourceUserSeq) as {
    id: string;
    data_json: string;
  } | undefined;
  if (!row) {
    return { ok: false, reason: 'accepted user input witness is missing', callTargetFallback: false };
  }
  let text = '';
  try {
    const parsed = JSON.parse(row.data_json) as { text?: unknown };
    text = typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    return { ok: false, reason: 'accepted user input witness is unreadable', callTargetFallback: false };
  }
  const detected = detectMultiItemIntent(text);
  const exactMembers = detected.exactMembers ? [...detected.exactMembers].sort() : null;
  const proposedMembers = [...universe.members].sort();
  const exactAcceptedMembers = (
    !detected.isMultiItem
    || !exactMembers
    || detected.itemCount !== exactMembers.length
    || proposedMembers.length !== exactMembers.length
    || proposedMembers.some((member, index) => member !== exactMembers[index])
  ) ? null : exactMembers;
  if (exactAcceptedMembers) {
    if (selectedIds.some((id) => !proposedMembers.includes(id))) {
      return {
        ok: false,
        reason: 'selected members are outside the exact accepted-input universe',
        callTargetFallback: false,
      };
    }
    return {
      ok: true,
      kind: 'accepted_user_input',
      ref: row.id,
      digest: expectedWorkDigest(canonicalExpectedWorkJson(exactAcceptedMembers)),
    };
  }

  if (durableAcceptedLoopBound(contract) !== proposedMembers.length) {
    return {
      ok: false,
      reason: 'the accepted count does not match this count-only work bound',
      callTargetFallback: false,
    };
  }

  // A count-only request names the cardinality, not the eventual records. The
  // immutable result handle that returned those records owns their lineage;
  // accepted source prose does not need to enumerate them first. Require one
  // exact returned record set rather than searching serialized bytes or
  // accepting a subset/substring coincidence.
  const memberDigest = expectedWorkDigest(canonicalExpectedWorkJson(proposedMembers));
  const resultRows = db.prepare(`
    SELECT s.logical_tool_call_id
      FROM logical_call_settlements s
      JOIN logical_tool_calls l
        ON l.session_id = s.session_id
       AND l.source_user_seq = s.source_user_seq
       AND l.logical_tool_call_id = s.logical_tool_call_id
     WHERE s.session_id = ? AND s.source_user_seq = ?
       AND l.accepted_task_id = ?
       AND s.outcome_kind = 'succeeded'
       AND s.mutating = 0
       AND s.result_handle_id IS NOT NULL
     ORDER BY s.settled_at DESC, s.logical_tool_call_id
  `).all(
    contract.identity.sessionId,
    contract.identity.sourceUserSeq,
    contract.acceptedTaskId,
  ) as Array<{ logical_tool_call_id: string }>;
  for (const resultRow of resultRows) {
    const redeemed = redeemSuccessfulSettlementResultForHost({
      sessionId: contract.identity.sessionId,
      sourceUserSeq: contract.identity.sourceUserSeq,
      acceptedTaskId: contract.acceptedTaskId,
      logicalToolCallId: resultRow.logical_tool_call_id,
    });
    if (redeemed.status !== 'ok') continue;
    const records = recordsAtRecordPath(
      redeemed.value.rawPayload,
      redeemed.value.handle.recordPath,
    );
    if (!records) continue;
    const coverage = proveFiniteReadResultCoverage({
      proof: {
        universeId: universe.id,
        memberCount: proposedMembers.length,
        argumentPointer: '',
        memberIdPointer: null,
        schemaDigest: expectedWorkDigest('settled-result-member-witness'),
        memberDigest,
      },
      requestedMembers: proposedMembers,
      rawResult: records,
    });
    if (coverage.status !== 'proved') continue;
    if (selectedIds.some((id) => !proposedMembers.includes(id))) {
      return {
        ok: false,
        reason: 'selected members are outside the settled result universe',
        callTargetFallback: false,
      };
    }
    return {
      ok: true,
      kind: 'complete_source_receipt',
      ref: resultRow.logical_tool_call_id,
      digest: memberDigest,
    };
  }
  return {
    ok: false,
    reason: 'count-only accepted input has neither one exact settled result-member set nor a concrete call target',
    callTargetFallback: true,
  };
}

const HOST_DERIVED_CALL_TARGET_SELECTOR: ExpectedWorkUniverseSelectorV1 = {
  // The full normalized call is the immutable selection surface. Concrete
  // recipient/record identity is extracted by the same provider-neutral
  // target oracle used by duplicate-write protection.
  argumentPointer: '',
  memberIdPointer: null,
};

function durableAcceptedLoopBound(contract: AcceptedTaskWorkContractV1): number | null {
  try {
    const graph = turnGraphFromShadowEvent(getTurnGraphEventForSource(
      contract.identity.sessionId,
      contract.identity.sourceUserSeq,
    ));
    const count = graph?.classification.goalConstraints?.collection?.count;
    return typeof count === 'number' && Number.isSafeInteger(count) && count > 0
      ? count
      : null;
  } catch {
    return null;
  }
}

function callTargetWitness(input: {
  db: Database.Database;
  contract: AcceptedTaskWorkContractV1;
  universe: ExpectedWorkUniverseV1;
  logicalToolCallId: string;
  universeItemId: string;
  args: unknown;
}): { ok: true; kind: string; ref: string; digest: string } | { ok: false; reason: string } {
  const source = input.db.prepare(`
    SELECT id, data_json FROM events
     WHERE session_id = ? AND seq = ? AND type = 'user_input_received'
  `).get(input.contract.identity.sessionId, input.contract.identity.sourceUserSeq) as {
    id: string;
    data_json: string;
  } | undefined;
  try {
    if (source) JSON.parse(source.data_json);
  } catch {
    return { ok: false, reason: 'count-only accepted source is unreadable' };
  }
  if (
    !source
    || input.universe.seal !== 'accepted_input'
    || durableAcceptedLoopBound(input.contract) !== input.universe.members.length
  ) {
    return { ok: false, reason: 'call-target membership does not match one count-only accepted request' };
  }
  const targets = [...new Set(
    extractDuplicateIdentityKeys(input.args)
      .map((target) => target.normalize('NFKC').trim())
      .filter(Boolean),
  )].sort();
  if (targets.length !== 1) {
    return { ok: false, reason: 'the per-item write must name exactly one concrete target identity' };
  }
  return {
    ok: true,
    // The binding row and logical-call argument digest retain this target
    // receipt. The contract member is only a quota slot for count-only input.
    kind: 'complete_source_receipt',
    ref: input.logicalToolCallId,
    digest: expectedWorkDigest(canonicalExpectedWorkJson({
      acceptedSource: source.id,
      count: input.universe.members.length,
      targets,
    })),
  };
}

/**
 * The requirement instances that are DURABLY DISCHARGED — the one reader of
 * that question.
 *
 * The dependency gate and the plan card used to answer it separately: the gate
 * demanded redeemable, exhausted evidence while the card counted any settled
 * binding. They disagreed in the same refusal payload — the card told the model
 * its producer read was satisfied while the gate refused the work waiting on it
 * (live 2026-08-11, count-only-drafts: every worker, twice each). A card that
 * can contradict the gate is its own truth defect, so both now derive from here
 * and the card can only ever be equal to the gate or more conservative.
 */
function dischargedRequirementSettlements(
  db: Database.Database,
  contract: AcceptedTaskWorkContractV1,
  requirementId: string,
): Array<{ logical_tool_call_id: string; universe_item_id: string | null }> {
  const rows = db.prepare(`
    SELECT b.logical_tool_call_id, b.effect_kind, b.cardinality_kind,
           b.universe_id, b.universe_item_id, b.universe_selector_json,
           b.universe_member_digest, b.universe_member_count,
           b.evidence_mode, b.evidence_basis, b.schema_digest,
           s.outcome_kind, s.recovery_action, s.retry_same_candidate,
           s.requires_reconciliation, s.continues_requirement,
           s.execution_kind, s.result_handle_id
      FROM expected_work_call_bindings b
      JOIN logical_call_settlements s
        ON s.session_id = b.session_id
       AND s.source_user_seq = b.source_user_seq
       AND s.logical_tool_call_id = b.logical_tool_call_id
     WHERE b.session_id = ? AND b.source_user_seq = ?
       AND b.contract_id = ? AND b.requirement_id = ?
  `).all(
    contract.identity.sessionId,
    contract.identity.sourceUserSeq,
    contract.contractId,
    requirementId,
  ) as Array<{
    logical_tool_call_id: string;
    effect_kind: RuntimeToolEffect;
    cardinality_kind: 'once' | 'each' | 'set';
    universe_id: string | null;
    universe_item_id: string | null;
    universe_selector_json: string | null;
    universe_member_digest: string | null;
    universe_member_count: number | null;
    evidence_mode: 'point_read' | 'collection_read' | 'finite_read' | null;
    evidence_basis: string | null;
    schema_digest: string | null;
    outcome_kind: string;
    recovery_action: string;
    retry_same_candidate: number;
    requires_reconciliation: number;
    continues_requirement: number;
    execution_kind: string;
    result_handle_id: string | null;
  }>;
  const discharged = rows.filter((row) => {
    if (
      (row.outcome_kind !== 'succeeded' && row.outcome_kind !== 'empty_result')
      || row.continues_requirement !== 0
    ) return false;
    if (row.effect_kind === 'compute') {
      if (row.outcome_kind !== 'succeeded') return false;
      const redeemed = redeemSuccessfulSettlementResultForHost({
        sessionId: contract.identity.sessionId,
        sourceUserSeq: contract.identity.sourceUserSeq,
        acceptedTaskId: contract.acceptedTaskId,
        logicalToolCallId: row.logical_tool_call_id,
      });
      return redeemed.status === 'ok' && computeResultHasSubstance(redeemed.value.rawPayload);
    }
    // Mutation dependencies require a host-issued commit/send/readback proof.
    // Nominal provider success is intentionally insufficient here. A generated
    // artifact write discharges only after a downstream exact-ID read, bound
    // to this same contract, proves the frozen content contract.
    if (row.effect_kind !== 'read') {
      const frozenVerification = proveFrozenMutationVerification({
        sessionId: contract.identity.sessionId,
        sourceUserSeq: contract.identity.sourceUserSeq,
        ownerLogicalToolCallId: row.logical_tool_call_id,
      });
      if (frozenVerification.status === 'verified') return true;
      return generatedArtifactWriteContentVerified({
        sessionId: contract.identity.sessionId,
        sourceUserSeq: contract.identity.sourceUserSeq,
        contractId: contract.contractId,
        createLogicalToolCallId: row.logical_tool_call_id,
      });
    }
    if (generatedArtifactReadContentVerified({
      sessionId: contract.identity.sessionId,
      sourceUserSeq: contract.identity.sourceUserSeq,
      contractId: contract.contractId,
      verificationLogicalToolCallId: row.logical_tool_call_id,
    })) return true;
    const redeemed = redeemSuccessfulSettlementResultForHost({
      sessionId: contract.identity.sessionId,
      sourceUserSeq: contract.identity.sourceUserSeq,
      acceptedTaskId: contract.acceptedTaskId,
      logicalToolCallId: row.logical_tool_call_id,
    });
    if (redeemed.status !== 'ok' || inspectProviderEnvelope(redeemed.value.rawPayload).verdict !== 'clean') {
      return false;
    }
    if (row.evidence_mode === 'point_read') return true;
    // Exhaustion has ONE authority, shared with the seal and the projector.
    if (row.evidence_mode === 'collection_read') {
      const records = recordsAtRecordPath(
        redeemed.value.rawPayload,
        redeemed.value.handle.recordPath,
      );
      const hasSubstantiveCollectionData = records !== null
        ? records.length === redeemed.value.handle.recordCount
          && records.some((record) => computeResultHasSubstance(record))
        : computeResultHasSubstance(redeemed.value.rawPayload);
      if (!hasSubstantiveCollectionData) return false;
      // A complete requested response window is useful predecessor evidence,
      // but it is not provider exhaustion. Keep `complete_set` open for the
      // terminal judge and irreversible consumers unless this shared oracle
      // has actual exhaustion evidence.
      return redeemedReadIsExhausted(redeemed.value);
    }
    if (
      row.evidence_mode !== 'finite_read'
      || !row.universe_id
      || !row.universe_selector_json
      || !row.universe_member_digest
      || !row.universe_member_count
      || !row.schema_digest
    ) return false;
    let selector: ExpectedWorkUniverseSelectorV1;
    try {
      selector = JSON.parse(row.universe_selector_json) as ExpectedWorkUniverseSelectorV1;
    } catch {
      return false;
    }
    const finiteUniverse = contract.universes.find((entry) => entry.id === row.universe_id);
    if (!finiteUniverse || finiteUniverse.seal !== 'accepted_input') return false;
    const requestedMembers = row.cardinality_kind === 'each'
      ? row.universe_item_id ? [row.universe_item_id] : []
      : [...finiteUniverse.members];
    const proof: FiniteReadStructuralProof = {
      universeId: row.universe_id,
      memberCount: row.universe_member_count,
      argumentPointer: selector.argumentPointer,
      memberIdPointer: selector.memberIdPointer,
      schemaDigest: row.schema_digest,
      memberDigest: row.universe_member_digest,
    };
    return proveFiniteReadResultCoverage({
      proof,
      requestedMembers,
      rawResult: redeemed.value.rawPayload,
    }).status === 'proved';
  });
  return discharged.map((row) => ({
    logical_tool_call_id: row.logical_tool_call_id,
    universe_item_id: row.universe_item_id,
  }));
}

/** Clean redeemable predecessor reads — data that has landed. Shared by the
 *  dependency gate and the plan card so "data in" and "may proceed" cannot
 *  disagree. This is not certified complete: a collection window can be
 *  useful without proving provider exhaustion. */
function isCleanRedeemablePredecessorRead(
  contract: AcceptedTaskWorkContractV1,
  logicalToolCallId: string,
  evidenceBasis: string | null,
): boolean {
  const redeemed = redeemSuccessfulSettlementResultForHost({
    sessionId: contract.identity.sessionId,
    sourceUserSeq: contract.identity.sourceUserSeq,
    acceptedTaskId: contract.acceptedTaskId,
    logicalToolCallId,
  });
  if (redeemed.status !== 'ok') return false;
  const records = recordsAtRecordPath(
    redeemed.value.rawPayload,
    redeemed.value.handle.recordPath,
  );
  // Substance is the bar, enumeration is not. When the handle recognized a
  // record collection, every record fact must hold. A provider shape the
  // deriver cannot enumerate (live 2026-08-18: Firecrawl's data.web array,
  // Drive's data.files) still lands usable data — whole-payload substance
  // keeps empty results out without demanding a recognizable collection key.
  // Coverage/exhaustion claims still live only in the discharge oracle.
  const recordsClean = records !== null
    ? records.length === redeemed.value.handle.recordCount
      && records.some((record) => computeResultHasSubstance(record))
    : computeResultHasSubstance(redeemed.value.rawPayload);
  // A provider-unknown collection is useful provisional data only when the
  // accepted graph bounded the collection. This preserves the top-N staging
  // lane without letting an arbitrary first page stand in for "all rows".
  // Explicitly complete provider results do not need that provisional door.
  const boundedOrComplete = redeemed.value.handle.completeness === 'complete'
    || goalDeclaresBoundedCollection(contract)
    || /^expected_complete_set:bounded_window=\d+$/.test(evidenceBasis ?? '');
  return redeemed.value.handle.success
    && recordsClean
    // Unknown pagination is acceptable provisional data; internally
    // contradictory pagination is not. The result-facts seam owns this
    // provider-neutral distinction so a reversible successor cannot turn an
    // impossible total into dependency authority.
    && !resultHasMalformedPagination(redeemed.value.rawPayload)
    && boundedOrComplete
    && redeemed.value.handle.completeness !== 'partial'
    && redeemed.value.handle.continuationRef === null
    && !redeemed.value.handle.continuationRepeated
    && inspectProviderEnvelope(redeemed.value.rawPayload).verdict === 'clean';
}

function goalDeclaresBoundedCollection(contract: AcceptedTaskWorkContractV1): boolean {
  return durableAcceptedLoopBound(contract) !== null;
}

function observedRequirementSettlements(
  db: Database.Database,
  contract: AcceptedTaskWorkContractV1,
  requirementId: string,
): Array<{ logical_tool_call_id: string; universe_item_id: string | null }> {
  // Two evidence tiers, one truth. Bound rows are admission-time authority.
  // Unbound rows are read settlements that named this requirement on a
  // bypass dispatch — the data landed, the contract just never admitted the
  // call. Readiness may consume both; discharge still requires bound rows.
  // Without the second tier, a checker refusal on a safe read erased the
  // read's existence and deadlocked its dependents forever (live 2026-08-18:
  // sheet write refused 5x against 55 clean settlements).
  const rows = db.prepare(`
    SELECT b.logical_tool_call_id, b.universe_item_id, b.evidence_basis
      FROM expected_work_call_bindings b
      JOIN logical_call_settlements s
        ON s.session_id = b.session_id
       AND s.source_user_seq = b.source_user_seq
       AND s.logical_tool_call_id = b.logical_tool_call_id
     WHERE b.session_id = ? AND b.source_user_seq = ?
       AND b.contract_id = ? AND b.requirement_id = ?
       AND b.effect_kind = 'read'
       AND s.outcome_kind = 'succeeded'
       AND s.continues_requirement = 0
     UNION
    SELECT s.logical_tool_call_id, NULL AS universe_item_id, NULL AS evidence_basis
      FROM logical_call_settlements s
     WHERE s.session_id = ? AND s.source_user_seq = ?
       AND s.requirement_id = ?
       AND s.mutating = 0
       AND s.outcome_kind = 'succeeded'
       AND s.continues_requirement = 0
       AND NOT EXISTS (
         SELECT 1 FROM expected_work_call_bindings b
          WHERE b.session_id = s.session_id
            AND b.source_user_seq = s.source_user_seq
            AND b.logical_tool_call_id = s.logical_tool_call_id
       )
  `).all(
    contract.identity.sessionId,
    contract.identity.sourceUserSeq,
    contract.contractId,
    requirementId,
    contract.identity.sessionId,
    contract.identity.sourceUserSeq,
    requirementId,
  ) as Array<{
    logical_tool_call_id: string;
    universe_item_id: string | null;
    evidence_basis: string | null;
  }>;
  return rows.filter((row) => isCleanRedeemablePredecessorRead(
    contract,
    row.logical_tool_call_id,
    row.evidence_basis,
  ));
}

function dependencyReadyForCurrentOperation(
  db: Database.Database,
  contract: AcceptedTaskWorkContractV1,
  dependency: ExpectedWorkOperationV1,
  current: ExpectedWorkOperationV1,
  currentItemId: string | undefined,
  currentTool: string,
  currentArgs: unknown,
  currentEvidenceArgs: unknown,
  currentEvidenceInputSchema: unknown,
): boolean {
  const discharged = dischargedRequirementSettlements(db, contract, dependency.id);
  const instancesReady = (
    rows: Array<{ logical_tool_call_id: string; universe_item_id: string | null }>,
  ): boolean => {
    if (dependency.cardinality.kind === 'once' || dependency.cardinality.kind === 'set') {
      return rows.length >= 1;
    }
    if (
      current.cardinality.kind === 'each'
      && dependency.cardinality.universeId === current.cardinality.universeId
      && currentItemId
    ) return rows.some((row) => row.universe_item_id === currentItemId);
    const dependencyCardinality = dependency.cardinality;
    if (dependencyCardinality.kind !== 'each') return false;
    const universe = contract.universes.find((entry) => entry.id === dependencyCardinality.universeId);
    return universe?.seal === 'accepted_input'
      && universe.members.every((member) => rows.some((row) => row.universe_item_id === member));
  };
  if (instancesReady(discharged)) return true;

  // A declared readback may begin before its reversible create predecessor is
  // itself discharged, because the readback is the act that supplies that
  // discharge proof. This edge is generated-target-only: the exact read id
  // must equal the single artifact id retained from the predecessor's clean
  // settled create. A title/list lookup, an ambient id, a different create, or
  // an ambiguous artifact root stays blocked.
  if (
    current.effect === 'read'
    && current.cardinality.kind === 'once'
    && dependency.effect === 'external_write'
    && dependency.cardinality.kind === 'once'
  ) {
    const predecessors = db.prepare(`
      SELECT b.logical_tool_call_id
        FROM expected_work_call_bindings b
        JOIN logical_call_settlements s
          ON s.session_id = b.session_id
         AND s.source_user_seq = b.source_user_seq
         AND s.logical_tool_call_id = b.logical_tool_call_id
       WHERE b.session_id = ? AND b.source_user_seq = ?
         AND b.contract_id = ? AND b.requirement_id = ?
         AND b.effect_kind = 'external_write'
         AND s.outcome_kind = 'succeeded'
         AND s.continues_requirement = 0
    `).all(
      contract.identity.sessionId,
      contract.identity.sourceUserSeq,
      contract.contractId,
      dependency.id,
    ) as Array<{ logical_tool_call_id: string }>;
    if (predecessors.length === 1) {
      const generated = authorizeGeneratedArtifactReadback({
        sessionId: contract.identity.sessionId,
        sourceUserSeq: contract.identity.sourceUserSeq,
        contractId: contract.contractId,
        createLogicalToolCallId: predecessors[0]!.logical_tool_call_id,
        verificationRequirementId: current.id,
        readToolName: currentTool,
        readArgs: currentArgs,
      });
      if (generated.status === 'authorized') return true;
      const hostSealed = authorizeHostSealedArtifactReadback({
        sessionId: contract.identity.sessionId,
        sourceUserSeq: contract.identity.sourceUserSeq,
        contractId: contract.contractId,
        createLogicalToolCallId: predecessors[0]!.logical_tool_call_id,
        verificationRequirementId: current.id,
        readToolName: unwrapRuntimeEffectiveToolIdentity(currentTool, currentArgs).toolName ?? currentTool,
        readArgs: currentEvidenceArgs,
        readProviderInputSchemaDigest: digestSchema(currentEvidenceInputSchema),
        readAccountId: currentArgs && typeof currentArgs === 'object' && !Array.isArray(currentArgs)
          && typeof (currentArgs as Record<string, unknown>).connected_account_id === 'string'
          ? (currentArgs as Record<string, unknown>).connected_account_id as string
          : undefined,
      });
      if (hostSealed.status === 'authorized') return true;
    }
  }

  // Readiness is not discharge. A specifically known reversible successor may
  // consume a clean, redeemable predecessor read while coverage stays open for
  // the plan projector/terminal judge. This lets the system stage/edit useful
  // work without turning a provider alias or an unproved `complete_set` claim
  // into authority for an irreversible send.
  const successorCanBeCorrected = (() => {
    if (current.effect === 'read' || current.effect === 'compute' || current.effect === 'local_write') {
      return true;
    }
    if (current.effect !== 'external_write') return false;
    try {
      const effect = classifyExternalWrite(currentTool, currentArgs);
      if (effect.external && effect.mutating && effect.reversibility === 'reversible') return true;
      if (effect.irreversible || !effect.mutating) return false;
      // Goal posture constrains WHAT the turn wants, not WHAT this selected
      // tool does. `create_new` cannot upgrade an unknown mutation into a
      // reversible one; only documented operation semantics grant this path.
      return false;
    } catch {
      return false;
    }
  })();
  if (
    !successorCanBeCorrected
    || dependency.effect !== 'read'
    // Provisional evidence cannot authorize a set/each lane: fanout cardinality
    // still requires strict discharge and, for source-derived universes, the
    // canonical complete-source seal.
    || dependency.cardinality.kind !== 'once'
    || current.cardinality.kind !== 'once'
  ) return false;

  return instancesReady(observedRequirementSettlements(db, contract, dependency.id));
}

/**
 * Compiles the content contract a generated Sheet create must later prove by
 * exact readback. The shape checks below are properties of the declared work —
 * one create, one exact read behind it — so they hold for any provider and any
 * column layout. Whether the created rows actually descend from that read is a
 * separate question this function deliberately does not answer: proving it
 * requires deriving the mapping from the settled source result, not consulting
 * a table of request shapes someone enumerated ahead of time.
 */
function generatedAtomicContentContractForAdmission(input: {
  contract: AcceptedTaskWorkContractV1;
  operation: ExpectedWorkOperationV1;
  tool: string;
  callArgs: unknown;
  providerArguments: unknown;
  providerArgumentsVisible: boolean;
}): { ok: true; contentContract: unknown } | { ok: false; reason: string } | null {
  if (!input.providerArgumentsVisible) return null;
  const effective = unwrapRuntimeEffectiveToolIdentity(input.tool, input.callArgs);
  if (!effective.toolName) return null;
  const sealed = loadSealedNodeBinding(
    input.contract.identity.sessionId,
    input.contract.identity.sourceUserSeq,
    input.operation.id,
  );
  if (sealed && sealed.providerOperationId.trim().toLowerCase() !== effective.toolName.trim().toLowerCase()) {
    return { ok: false, reason: 'atomic content call contradicts its sealed operation identity' };
  }
  const declaration = sealed
    ? sealed.operationSemantics?.atomicInputContent
    : currentManifestOperationSemantics(effective.toolName)?.semantics.atomicInputContent;
  if (!declaration) return null;
  const contentContract = compileAtomicInputContentContract({
    declaration,
    providerArguments: input.providerArguments === input.callArgs
      ? effective.args
      : input.providerArguments,
  });
  if (!contentContract) {
    return { ok: false, reason: 'atomic content arguments do not satisfy the sealed compiler contract' };
  }
  if (
    input.operation.cardinality.kind !== 'once'
    || (input.operation.effect !== 'external_write' && input.operation.effect !== 'local_write')
  ) {
    return { ok: false, reason: 'atomic generated content requires one declared create operation' };
  }
  const sourceRequirements = input.operation.dataFrom;
  if (sourceRequirements.length !== 1) {
    return { ok: false, reason: 'atomic generated content requires exactly one declared dataFrom source' };
  }
  const sourceOperation = input.contract.operations.find((operation) => operation.id === sourceRequirements[0]);
  if (!sourceOperation || sourceOperation.effect !== 'read' || sourceOperation.cardinality.kind !== 'once') {
    return { ok: false, reason: 'atomic generated content dataFrom source must be one exact read' };
  }
  return { ok: true, contentContract };
}

function exactContentDigestOccurrences(value: unknown, targetDigest: string, depth = 0): number {
  if (depth > 8) return 0;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > 16_000_000) return 0;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (hostArtifactContentDigest(parsed) === targetDigest) return 1;
      return exactContentDigestOccurrences(parsed, targetDigest, depth + 1);
    } catch {
      return 0;
    }
  }
  if (Array.isArray(value)) {
    if (hostArtifactContentDigest(value) === targetDigest) return 1;
    return value.reduce(
      (count, child) => count + exactContentDigestOccurrences(child, targetDigest, depth + 1),
      0,
    );
  }
  if (!value || typeof value !== 'object') return 0;
  if (hostArtifactContentDigest(value) === targetDigest) return 1;
  return Object.values(value as Record<string, unknown>)
    .reduce<number>(
      (count, child) => count + exactContentDigestOccurrences(child, targetDigest, depth + 1),
      0,
    );
}

type HostSealedArtifactLineage = {
  /** Immediate producer whose exact settled bytes the create must consume. */
  contentNode: ExpectedWorkOperationV1;
  /** One dataFrom chain, ordered from its terminal read to contentNode. */
  orderedNodes: ExpectedWorkOperationV1[];
};

function resolveHostSealedArtifactLineage(
  contract: AcceptedTaskWorkContractV1,
  create: ExpectedWorkOperationV1,
): { ok: true; lineage: HostSealedArtifactLineage } | { ok: false; reason: string } {
  if (create.dataFrom.length !== 1 || !create.dependsOn.includes(create.dataFrom[0]!)) {
    return {
      ok: false,
      reason: 'generated artifact create requires one exact dependency-bound dataFrom source',
    };
  }
  const byId = new Map(contract.operations.map((operation) => [operation.id, operation]));
  const contentNode = byId.get(create.dataFrom[0]!);
  if (!contentNode) {
    return { ok: false, reason: 'generated artifact dataFrom lineage is missing' };
  }
  const reverseNodes: ExpectedWorkOperationV1[] = [];
  const visited = new Set<string>();
  let current: ExpectedWorkOperationV1 | undefined = contentNode;
  while (current) {
    if (visited.has(current.id) || reverseNodes.length >= contract.operations.length) {
      return { ok: false, reason: 'generated artifact dataFrom lineage is cyclic or ambiguous' };
    }
    visited.add(current.id);
    reverseNodes.push(current);
    if (current.cardinality.kind !== 'once') {
      return { ok: false, reason: 'generated artifact lineage nodes must be exact once operations' };
    }
    if (current.effect === 'read') {
      if (current.dataFrom.length !== 0) {
        return { ok: false, reason: 'generated artifact source read cannot inherit another dataFrom source' };
      }
      return {
        ok: true,
        lineage: { contentNode, orderedNodes: [...reverseNodes].reverse() },
      };
    }
    if (current.effect !== 'compute') {
      return {
        ok: false,
        reason: 'generated artifact lineage permits only exact compute nodes after one source read',
      };
    }
    if (current.dataFrom.length !== 1 || !current.dependsOn.includes(current.dataFrom[0]!)) {
      return {
        ok: false,
        reason: 'generated artifact compute lineage requires one exact dependency-bound dataFrom source',
      };
    }
    current = byId.get(current.dataFrom[0]!);
    if (!current) {
      return { ok: false, reason: 'generated artifact dataFrom lineage is missing' };
    }
  }
  return { ok: false, reason: 'generated artifact lineage has no exact source read' };
}

function sealedBindingEffectMatches(
  operation: ExpectedWorkOperationV1,
  binding: SealedNodeBinding,
): boolean {
  if (binding.nodeId !== operation.id) return false;
  if (operation.effect === 'compute') {
    return binding.effect === 'compute'
      || binding.effect === 'host_only'
      || binding.effect === 'none';
  }
  return binding.effect === operation.effect;
}

interface SettledHostSealedLineageNode {
  operation: ExpectedWorkOperationV1;
  binding: SealedNodeBinding;
  logicalToolCallId: string;
  argumentDigest: string;
  records: unknown[];
}

function exactSettledHostSealedLineageNode(input: {
  db: Database.Database;
  contract: AcceptedTaskWorkContractV1;
  operation: ExpectedWorkOperationV1;
}): { ok: true; node: SettledHostSealedLineageNode } | { ok: false; reason: string } {
  const rows = input.db.prepare(`
    SELECT b.logical_tool_call_id, b.tool_name, b.argument_digest,
           b.effect_kind, b.cardinality_kind
      FROM expected_work_call_bindings b
      JOIN logical_call_settlements s
        ON s.session_id = b.session_id
       AND s.source_user_seq = b.source_user_seq
       AND s.logical_tool_call_id = b.logical_tool_call_id
     WHERE b.session_id = ? AND b.source_user_seq = ?
       AND b.contract_id = ? AND b.requirement_id = ?
       AND s.outcome_kind = 'succeeded'
       AND s.continues_requirement = 0
  `).all(
    input.contract.identity.sessionId,
    input.contract.identity.sourceUserSeq,
    input.contract.contractId,
    input.operation.id,
  ) as Array<{
    logical_tool_call_id: string;
    tool_name: string;
    argument_digest: string;
    effect_kind: string;
    cardinality_kind: string;
  }>;
  if (rows.length !== 1) {
    return {
      ok: false,
      reason: `generated artifact lineage settlement for ${input.operation.id} is missing or ambiguous`,
    };
  }
  const row = rows[0]!;
  const binding = loadSealedNodeBinding(
    input.contract.identity.sessionId,
    input.contract.identity.sourceUserSeq,
    input.operation.id,
  );
  if (
    !binding
    || !sealedBindingEffectMatches(input.operation, binding)
    || binding.logicalToolName !== row.tool_name
    || row.effect_kind !== input.operation.effect
    || row.cardinality_kind !== 'once'
  ) {
    return {
      ok: false,
      reason: `generated artifact lineage binding for ${input.operation.id} is not exact`,
    };
  }
  const redeemed = redeemSuccessfulSettlementResultForHost({
    sessionId: input.contract.identity.sessionId,
    sourceUserSeq: input.contract.identity.sourceUserSeq,
    acceptedTaskId: input.contract.acceptedTaskId,
    logicalToolCallId: row.logical_tool_call_id,
  });
  if (redeemed.status !== 'ok') {
    return {
      ok: false,
      reason: `generated artifact lineage bytes for ${input.operation.id} are unavailable: ${redeemed.reason}`,
    };
  }
  const records = recordsAtRecordPath(
    redeemed.value.rawPayload,
    redeemed.value.handle.recordPath,
  );
  if (
    inspectProviderEnvelope(redeemed.value.rawPayload).verdict !== 'clean'
    || !records
  ) {
    return {
      ok: false,
      reason: `generated artifact lineage result for ${input.operation.id} is not one clean record collection`,
    };
  }
  return {
    ok: true,
    node: {
      operation: input.operation,
      binding,
      logicalToolCallId: row.logical_tool_call_id,
      argumentDigest: row.argument_digest,
      records,
    },
  };
}

function hostExecutorPayloadDigest(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? null : expectedWorkDigest(json);
  } catch {
    return null;
  }
}

function exactHostExecutorLineageArgs(input: {
  args: unknown;
  nodeId: string;
  binding: SealedNodeBinding;
  payload: unknown;
}): boolean {
  if (!input.args || typeof input.args !== 'object' || Array.isArray(input.args)) return false;
  const args = input.args as Record<string, unknown>;
  const expectedKeys = ['capabilityId', 'digest', 'nodeId', 'schemaDigest', 'schemaVersion'];
  if (
    Object.keys(args).length !== expectedKeys.length
    || expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(args, key))
  ) return false;
  const payloadDigest = hostExecutorPayloadDigest(input.payload);
  return payloadDigest !== null
    && args.nodeId === input.nodeId
    && args.capabilityId === input.binding.capabilityId
    && args.schemaVersion === input.binding.schemaVersion
    && args.schemaDigest === input.binding.schemaDigest
    && args.digest === payloadDigest;
}

function exactHostExecutorLineageArgumentDigest(input: {
  contract: AcceptedTaskWorkContractV1;
  node: SettledHostSealedLineageNode;
  payload: unknown;
}): boolean {
  const payloadDigest = hostExecutorPayloadDigest(input.payload);
  if (!payloadDigest) return false;
  const exactArgs = {
    nodeId: input.node.operation.id,
    capabilityId: input.node.binding.capabilityId,
    schemaVersion: input.node.binding.schemaVersion,
    schemaDigest: input.node.binding.schemaDigest,
    digest: payloadDigest,
  };
  const logical = durableLogicalCallContract(
    input.contract.acceptedTaskId,
    input.node.binding.logicalToolName,
    exactArgs,
  );
  return logical?.argumentDigest === input.node.argumentDigest;
}

/**
 * Provider-neutral content authority for a generic create. It is minted only
 * when the frozen DAG has one exact read, an optional exact compute chain, the
 * create, and one exact-id readback. The create must consume the immediate
 * producer's settled bytes; a transformed artifact can never borrow authority
 * from the raw ancestor. No semantic label can substitute for byte equality.
 */
function hostSealedContentContractForAdmission(input: {
  db: Database.Database;
  contract: AcceptedTaskWorkContractV1;
  operation: ExpectedWorkOperationV1;
  evidenceArgs: unknown;
}): { ok: true; contentContract: unknown } | { ok: false; reason: string } | null {
  if (
    input.operation.cardinality.kind !== 'once'
    || (input.operation.effect !== 'external_write' && input.operation.effect !== 'local_write')
    // This proof protects content claimed to descend from a prior source.
    // A zero-lineage create carries user/model-supplied content directly and
    // remains governed by its exact plan, capability risk, and consent proof.
    || input.operation.dataFrom.length === 0
  ) return null;
  const createBindingRow = input.db.prepare(`
    SELECT binding_json, binding_digest
      FROM graph_node_bindings
     WHERE session_id = ? AND source_user_seq = ? AND node_id = ?
  `).get(
    input.contract.identity.sessionId,
    input.contract.identity.sourceUserSeq,
    input.operation.id,
  ) as { binding_json: string; binding_digest: string } | undefined;
  if (!createBindingRow) return null;
  const sealedCreate = loadSealedNodeBinding(
    input.contract.identity.sessionId,
    input.contract.identity.sourceUserSeq,
    input.operation.id,
  );
  if (!sealedCreate) return { ok: false, reason: 'generated artifact create binding is unreadable' };
  if (sealedCreate.destination?.posture !== 'create_new') return null;
  if (
    sealedCreate.nodeId !== input.operation.id
    || sealedCreate.bindingDigest !== createBindingRow.binding_digest
    || !sealedBindingEffectMatches(input.operation, sealedCreate)
  ) return { ok: false, reason: 'generated artifact create binding contradicts the frozen DAG' };
  const lineage = resolveHostSealedArtifactLineage(input.contract, input.operation);
  if (!lineage.ok) return lineage;
  const readbacks = input.contract.operations.filter((operation) => (
    operation.effect === 'read'
    && operation.cardinality.kind === 'once'
    && operation.dependsOn.includes(input.operation.id)
  ));
  if (
    readbacks.length === 0
    && input.operation.effect === 'local_write'
    && expectsHostLocalWorkspaceCompoundCommit({
      toolName: sealedCreate.logicalToolName,
      args: input.evidenceArgs,
    })
  ) {
    // The successful local result must still pass the post-write compound
    // descriptor re-open before evidence/terminal publication. Admission only
    // recognizes that this exact one-call tool supplies its own readback; it
    // does not fabricate a success receipt or relax any other create.
    return null;
  }
  if (readbacks.length !== 1) {
    return { ok: false, reason: 'generated artifact requires one exact declared create successor readback' };
  }
  const readback = readbacks[0]!;
  const settledLineage: SettledHostSealedLineageNode[] = [];
  for (const operation of lineage.lineage.orderedNodes) {
    const settled = exactSettledHostSealedLineageNode({
      db: input.db,
      contract: input.contract,
      operation,
    });
    if (!settled.ok) return settled;
    if (operation.effect === 'compute') {
      const predecessor = settledLineage.at(-1);
      if (
        !predecessor
        || !exactHostExecutorLineageArgumentDigest({
          contract: input.contract,
          node: settled.node,
          payload: predecessor.records,
        })
      ) {
        return {
          ok: false,
          reason: `generated artifact transform ${operation.id} did not consume its exact settled predecessor bytes`,
        };
      }
    }
    settledLineage.push(settled.node);
  }
  const contentNode = settledLineage.at(-1);
  if (!contentNode || contentNode.operation.id !== lineage.lineage.contentNode.id) {
    return { ok: false, reason: 'generated artifact settled content lineage is missing or ambiguous' };
  }
  const records = contentNode.records;
  const contentDigest = hostArtifactContentDigest(records);
  if (
    !exactHostExecutorLineageArgs({
      args: input.evidenceArgs,
      nodeId: input.operation.id,
      binding: sealedCreate,
      payload: records,
    })
    && exactContentDigestOccurrences(input.evidenceArgs, contentDigest) !== 1
  ) {
    return { ok: false, reason: 'generated artifact create arguments do not contain the exact source records once' };
  }

  const readbackBindingRow = input.db.prepare(`
    SELECT binding_json, binding_digest
      FROM graph_node_bindings
     WHERE session_id = ? AND source_user_seq = ? AND node_id = ?
  `).get(
    input.contract.identity.sessionId,
    input.contract.identity.sourceUserSeq,
    readback.id,
  ) as { binding_json: string; binding_digest: string } | undefined;
  const sealedReadback = readbackBindingRow
    ? loadSealedNodeBinding(
        input.contract.identity.sessionId,
        input.contract.identity.sourceUserSeq,
        readback.id,
      )
    : null;
  if (!readbackBindingRow || !sealedReadback) {
    return { ok: false, reason: 'generated artifact readback binding is missing or unreadable' };
  }
  if (
    sealedReadback.nodeId !== readback.id
    || sealedReadback.bindingDigest !== readbackBindingRow.binding_digest
    || !sealedBindingEffectMatches(readback, sealedReadback)
  ) return { ok: false, reason: 'generated artifact sealed bindings contradict the frozen DAG' };
  return {
    ok: true,
    contentContract: createHostSealedArtifactContentContract({
      acceptedTaskId: input.contract.acceptedTaskId,
      graphId: input.contract.graphId,
      graphHash: input.contract.graphHash,
      lineageNodeId: contentNode.operation.id,
      createNodeId: input.operation.id,
      readbackNodeId: readback.id,
      lineageContentDigest: contentDigest,
      intendedContentDigest: contentDigest,
      createBindingDigest: createBindingRow.binding_digest,
      readbackBindingDigest: readbackBindingRow.binding_digest,
      createEffect: input.operation.effect,
      readbackEffect: 'read',
    }),
  };
}

function ensureGeneratedArtifactContractSchema(db: Database.Database): void {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  const present = new Set(rows.map((row) => row.name));
  if (!present.has('expected_work_generated_artifact_contracts')) {
    throw new Error('generated artifact content contract schema migration is unavailable');
  }
}

function generatedArtifactContractForBinding(
  db: Database.Database,
  binding: ExpectedWorkCallBinding,
): ExpectedWorkCallBinding {
  const row = db.prepare(`
    SELECT contract_json FROM expected_work_generated_artifact_contracts
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(
    binding.sessionId,
    binding.sourceUserSeq,
    binding.logicalToolCallId,
  ) as { contract_json: string } | undefined;
  if (!row) return binding;
  try {
    return { ...binding, generatedArtifactContentContract: JSON.parse(row.contract_json) as unknown };
  } catch {
    throw new Error('persisted generated artifact contract is unreadable');
  }
}

/**
 * A host-resolved capability id is a durable definition identity, while a
 * provider/model call names the operation on that definition. Requiring the
 * caller to echo the host's `cap:resolved:...:definition:...` spelling makes
 * transport syntax an admission gate. Recover only the standard resolved
 * capability family here; arbitrary work ids remain exact-only.
 */
function frozenResolvedCapabilityOperationKey(requirementId: string): string | null {
  const match = /^cap:resolved:([^:]+)(?::definition:[^:]+)?$/i.exec(requirementId.trim());
  if (!match?.[1]) return null;
  const key = catalogOperationIdentityKey(match[1]);
  return key || null;
}

function invocationOperationForContract(input: {
  contract: AcceptedTaskWorkContractV1;
  requirementId: string;
  tool: string;
  args: unknown;
}): ExpectedWorkOperationV1 | null {
  const exact = input.contract.operations.find((entry) => entry.id === input.requirementId);
  if (exact) return exact;

  const requestedKey = catalogOperationIdentityKey(input.requirementId);
  const effective = unwrapRuntimeEffectiveToolIdentity(input.tool, input.args);
  const invokedKey = effective.toolName
    ? catalogOperationIdentityKey(effective.toolName)
    : '';
  if (!requestedKey || requestedKey !== invokedKey) return null;

  const candidates = input.contract.operations.filter((entry) => (
    frozenResolvedCapabilityOperationKey(entry.id) === invokedKey
  ));
  return candidates.length === 1 ? candidates[0]! : null;
}

function priorRequirementAllowsAdmission(
  db: Database.Database,
  contract: AcceptedTaskWorkContractV1,
  operation: ExpectedWorkOperationV1,
  universeItemId: string | undefined,
  currentTool: string,
  currentArgumentDigest: string,
  currentInvocation: { tool: string; args: unknown },
): { ok: true } | {
  ok: false;
  reason: string;
  refusalKind?: ExpectedWorkAdmissionFailureKind;
  satisfiedByLogicalToolCallId?: string;
  retainedByLogicalToolCallId?: string;
  executedByLogicalToolCallId?: string;
} {
  const rows = db.prepare(`
    SELECT b.tool_name, b.argument_digest, b.universe_item_id,
           b.logical_tool_call_id, l.state,
           s.execution_kind, s.outcome_kind, s.recovery_action, s.retry_same_candidate,
           s.eliminates_candidate, s.requires_reconciliation,
           s.physical_crossing_count
      FROM expected_work_call_bindings b
      JOIN logical_tool_calls l
        ON l.session_id = b.session_id
       AND l.source_user_seq = b.source_user_seq
       AND l.logical_tool_call_id = b.logical_tool_call_id
      LEFT JOIN logical_call_settlements s
        ON s.session_id = b.session_id
       AND s.source_user_seq = b.source_user_seq
       AND s.logical_tool_call_id = b.logical_tool_call_id
     WHERE b.session_id = ? AND b.source_user_seq = ?
       AND b.contract_id = ? AND b.requirement_id = ?
     ORDER BY l.opened_at, b.logical_tool_call_id
  `).all(
    contract.identity.sessionId,
    contract.identity.sourceUserSeq,
    contract.contractId,
    operation.id,
  ) as Array<{
    tool_name: string;
    argument_digest: string;
    universe_item_id: string | null;
    logical_tool_call_id: string;
    state: string;
    execution_kind: string | null;
    outcome_kind: string | null;
    recovery_action: string | null;
    retry_same_candidate: number | null;
    eliminates_candidate: number | null;
    requires_reconciliation: number | null;
    physical_crossing_count: number | null;
  }>;
  const relevant = operation.cardinality.kind === 'each'
    ? rows.filter((row) => row.universe_item_id === universeItemId)
    : rows;
  if (relevant.length === 0) return { ok: true };
  if (relevant.some((row) => row.state === 'open' || row.outcome_kind === null)) {
    return { ok: false, reason: 'this requirement instance already has an open logical call' };
  }
  // The same oracle that drives dependency admission and plan projection is
  // the only authority allowed to say a read/compute requirement is
  // satisfied. Nominal settlement alone is not evidence discharge.
  const dischargedIds = new Set(
    dischargedRequirementSettlements(db, contract, operation.id)
      .map((row) => row.logical_tool_call_id),
  );
  const latestDischarged = [...relevant]
    .reverse()
    .find((row) => dischargedIds.has(row.logical_tool_call_id));
  if (latestDischarged) {
    return {
      ok: false,
      reason: 'this requirement instance is already durably discharged',
      satisfiedByLogicalToolCallId: latestDischarged.logical_tool_call_id,
    };
  }
  // A projector/policy refusal before provider entry is a host miss, not a
  // business attempt and not discharge. Remove it from attempt accounting so
  // the same frozen requirement can continue after metadata/identity repair.
  // A mutation with any physical crossing remains governed by the ordinary
  // one-crossing and reconciliation branches below.
  const attempts = relevant.filter((row) => !(
    row.outcome_kind === 'policy_denial'
    && row.execution_kind === 'refused_pre_dispatch'
    && row.physical_crossing_count === 0
  ));
  if (attempts.length === 0) return { ok: true };
  if (operation.effect === 'read' || operation.effect === 'compute') {
    const exactRetained = [...attempts].reverse().find((row) => (
      (row.outcome_kind === 'succeeded' || row.outcome_kind === 'empty_result')
      && row.tool_name === currentTool
      && row.argument_digest === currentArgumentDigest
    ));
    if (exactRetained) {
      return {
        ok: false,
        refusalKind: 'work_evidence_incomplete',
        reason: 'the exact read or compute already settled, but its retained evidence does not durably discharge this requirement; reuse the retained result or change the call to gather different evidence',
        retainedByLogicalToolCallId: exactRetained.logical_tool_call_id,
      };
    }
    // Landed provisional data is not itself an attempt-budget refusal. Exact
    // replays returned above, certified completeness returned as discharged,
    // and malformed/empty/unbounded results never enter the observed oracle.
    // A genuinely different clean query may therefore use the bounded
    // READ_EXPLORATION_CEILING below instead of dying after its first window.
  }
  const settledAttempts = attempts.filter((row) => row.outcome_kind !== null);
  if (settledAttempts.length >= 2) {
    // VALUE-AWARE READ EXPLORATION (live 2026-08-18, third specimen of the
    // class): "my search tool only allows one query per task pass" surfaced
    // as a needs_input question — the harness making the USER do its budget
    // accounting, the exact north-star violation. Collection legitimately
    // takes several reads. A further read admits while every prior attempt
    // settled cleanly AND the new call is genuinely different, under a
    // bounded ceiling; the 2026-08-14 eight-search certainty loop stays
    // bounded (and same-args replays never reach here — the retained-result
    // branches above return the stored bytes instead). Writes keep the
    // strict one-attempt-one-repair budget.
    const READ_EXPLORATION_CEILING = 6;
    if (
      (operation.effect === 'read' || operation.effect === 'compute')
      && settledAttempts.length < READ_EXPLORATION_CEILING
      && settledAttempts.every((row) =>
        row.outcome_kind === 'succeeded' || row.outcome_kind === 'empty_result')
      && !settledAttempts.some((row) =>
        row.tool_name === currentTool && row.argument_digest === currentArgumentDigest)
    ) {
      return { ok: true };
    }
    return {
      ok: false,
      refusalKind: 'work_attempt_budget_exhausted',
      reason: operation.effect === 'read' || operation.effect === 'compute'
        ? 'this requirement\u2019s read exploration is exhausted; synthesize from the landed evidence or explain the precise blocker'
        : 'this requirement already used its one attempt and one repair; further calls cannot advance the plan. Use landed data or explain the precise blocker',
    };
  }
  const latest = attempts.at(-1)!;
  if (latest.outcome_kind === 'succeeded' || latest.outcome_kind === 'empty_result') {
    if (operation.effect === 'read' || operation.effect === 'compute') {
      // One hollow success may take exactly one different-args repair. A
      // second try is the unrecoverable complete-set loop (live 2026-08-14:
      // eight Firecrawl searches that could not certify the internet).
      return { ok: true };
    }
    return {
      ok: false,
      refusalKind: 'work_effect_already_executed',
      reason: 'this mutation already crossed once but is not yet durably verified; do not repeat it — verify or reconcile the existing effect',
      executedByLogicalToolCallId: latest.logical_tool_call_id,
    };
  }
  if (latest.outcome_kind === 'uncertain_write' || latest.requires_reconciliation === 1) {
    return { ok: false, reason: 'an uncertain mutation must be reconciled before any retry' };
  }
  // `repair_arguments` authorizes a corrected attempt, not a byte-equivalent
  // replay.  The binding digest is the frozen effective logical contract, so
  // this comparison stays provider-neutral even when an outer carrier was
  // refined to provider-ready arguments before binding.
  if (
    latest.recovery_action === 'repair_arguments'
    && latest.tool_name === currentTool
    && latest.argument_digest === currentArgumentDigest
  ) {
    return {
      ok: false,
      refusalKind: 'work_attempt_budget_exhausted',
      reason: 'the prior invalid-argument outcome authorizes one repair only after the effective arguments change; an identical replay is not a repair',
    };
  }
  const sameCandidateRepair = latest.retry_same_candidate === 1
    && latest.tool_name === currentTool
    && (
      latest.recovery_action !== 'repair_arguments'
      || latest.argument_digest !== currentArgumentDigest
    );
  // A read/compute that never produced evidence cannot seal the retrieve.
  // Unknown and unsupported outcomes eliminate that candidate even when the
  // settlement flag was left inert (live 2026-08-14: unknown MCP tool bound
  // the set-read, then Firecrawl was refused as already satisfied).
  const readNeverLanded = (operation.effect === 'read' || operation.effect === 'compute')
    && (latest.outcome_kind === 'unknown' || latest.outcome_kind === 'unsupported_capability');
  const siblingRecovery = latest.tool_name !== currentTool
    && (latest.eliminates_candidate === 1 || readNeverLanded);
  if (!sameCandidateRepair && !siblingRecovery) {
    return {
      ok: false,
      reason: `the prior ${latest.outcome_kind ?? 'unknown'} outcome authorizes no retry for this requirement`,
    };
  }
  return { ok: true };
}

type ContinuationArgumentRepairProjection =
  | { status: 'none' | 'changed' }
  | { status: 'identical'; parentLogicalToolCallId: string }
  | { status: 'unavailable'; reason: string };

/**
 * Compare B's proposed effective call against the repair-rejected call from A.
 * Durable logical argument digests are intentionally accepted-task salted, so
 * equality cannot be checked by comparing A's digest to B's digest directly.
 * Recompute B's canonical effective contract with A's exact accepted-task salt;
 * equal bytes then reproduce A's frozen digest without storing raw arguments or
 * adding a provider-specific identity.
 */
function continuationArgumentRepairProjection(input: {
  db: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  tool: string;
  args: unknown;
}): ContinuationArgumentRepairProjection {
  try {
    const graphEvent = getTurnGraphEventForSource(input.sessionId, input.sourceUserSeq);
    if (!graphEvent || !turnGraphFromShadowEvent(graphEvent)) return { status: 'none' };
    const lineage = graphEvent.data.taskContinuationLineage;
    if (!lineage || typeof lineage !== 'object' || Array.isArray(lineage)) return { status: 'none' };
    const row = lineage as Record<string, unknown>;
    if (
      row.consumingSourceUserSeq !== input.sourceUserSeq
      || typeof row.parentSourceUserSeq !== 'number'
      || !Number.isSafeInteger(row.parentSourceUserSeq)
      || row.parentSourceUserSeq <= 0
      || typeof row.parentAcceptedTaskId !== 'string'
      || !row.parentAcceptedTaskId.trim()
      || (row.disposition !== 'affirmed' && row.disposition !== 'selected' && row.disposition !== 'provided')
    ) return { status: 'none' };

    const consumed = readConsumedTaskContinuityPacket({
      sessionId: input.sessionId,
      consumingSourceUserSeq: input.sourceUserSeq,
    });
    if (
      consumed.status !== 'consumed'
      || consumed.packet.originatingSourceUserSeq !== row.parentSourceUserSeq
      || consumed.packet.pause.kind !== 'clarification'
      || consumed.packet.pause.question.replace(/\s+/g, ' ').trim().toLowerCase()
        !== REPAIR_ARGUMENTS_NEEDS_INPUT_TEXT.replace(/\s+/g, ' ').trim().toLowerCase()
    ) return { status: 'none' };

    const latest = input.db.prepare(`
      SELECT l.accepted_task_id, s.logical_tool_call_id
        FROM logical_call_settlements s
        JOIN logical_tool_calls l
          ON l.session_id = s.session_id
         AND l.source_user_seq = s.source_user_seq
         AND l.logical_tool_call_id = s.logical_tool_call_id
        JOIN accepted_task_resolutions r
          ON r.session_id = s.session_id
         AND r.source_user_seq = s.source_user_seq
        JOIN events e ON e.id = s.settlement_event_id
       WHERE s.session_id = ? AND s.source_user_seq = ?
         AND s.business_call = 1
         AND r.state != 'legacy_ambiguous'
       ORDER BY e.seq DESC
       LIMIT 1
    `).get(input.sessionId, row.parentSourceUserSeq) as {
      accepted_task_id: string;
      logical_tool_call_id: string;
    } | undefined;
    if (!latest) return { status: 'none' };
    if (latest.accepted_task_id !== row.parentAcceptedTaskId) {
      return { status: 'unavailable', reason: 'continuation parent accepted-task identity is inconsistent' };
    }
    const redeemed = redeemDurableLogicalCallSettlementForHost({
      sessionId: input.sessionId,
      sourceUserSeq: row.parentSourceUserSeq,
      acceptedTaskId: latest.accepted_task_id,
      logicalToolCallId: latest.logical_tool_call_id,
    });
    if (redeemed.status !== 'ok') {
      return { status: 'unavailable', reason: `continuation parent repair settlement is ${redeemed.status}` };
    }
    const prior = redeemed.settlement;
    if (
      !prior.recovery.businessCall
      || prior.outcome.kind !== 'invalid_arguments'
      || prior.outcome.directive.action !== 'repair_arguments'
    ) return { status: 'none' };

    const proposedAsParent = durableLogicalCallContract(
      latest.accepted_task_id,
      input.tool,
      input.args,
    );
    if (!proposedAsParent) {
      return { status: 'unavailable', reason: 'continuation repair arguments are not contractible' };
    }
    return proposedAsParent.toolName === prior.toolName
      && proposedAsParent.argumentDigest === prior.argumentDigest
      ? { status: 'identical', parentLogicalToolCallId: latest.logical_tool_call_id }
      : { status: 'changed' };
  } catch {
    return { status: 'unavailable', reason: 'continuation repair authority could not be read' };
  }
}

function bindingFromRow(row: Record<string, unknown>): ExpectedWorkCallBinding {
  return {
    sessionId: String(row.session_id),
    sourceUserSeq: Number(row.source_user_seq),
    acceptedTaskId: String(row.accepted_task_id),
    logicalToolCallId: String(row.logical_tool_call_id),
    contractId: String(row.contract_id),
    requirementId: String(row.requirement_id),
    effect: row.effect_kind as ExpectedWorkCallBinding['effect'],
    cardinality: row.cardinality_kind as ExpectedWorkCallBinding['cardinality'],
    ...(typeof row.universe_id === 'string' ? { universeId: row.universe_id } : {}),
    ...(typeof row.universe_item_id === 'string' ? { universeItemId: row.universe_item_id } : {}),
    ...(typeof row.universe_member_digest === 'string'
      ? { universeMemberDigest: row.universe_member_digest }
      : {}),
    ...(typeof row.universe_member_count === 'number'
      ? { universeMemberCount: row.universe_member_count }
      : {}),
    ...(typeof row.evidence_mode === 'string'
      ? { evidenceMode: row.evidence_mode as ExpectedWorkCallBinding['evidenceMode'] }
      : {}),
    ...(typeof row.evidence_basis === 'string' ? { evidenceBasis: row.evidence_basis } : {}),
    ...(typeof row.schema_fingerprint === 'string'
      ? { schemaFingerprint: row.schema_fingerprint }
      : {}),
    ...(typeof row.schema_digest === 'string' ? { schemaDigest: row.schema_digest } : {}),
  };
}

export type ExpectedWorkCallBindingState =
  | { status: 'ok'; binding: ExpectedWorkCallBinding }
  | { status: 'missing' }
  | { status: 'storage_error'; reason: string };

export function loadExpectedWorkCallBindingState(input: {
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId: string;
}): ExpectedWorkCallBindingState {
  try {
    const db = openEventLog();
    const row = db.prepare(`
      SELECT * FROM expected_work_call_bindings
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(input.sessionId, input.sourceUserSeq, input.logicalToolCallId) as Record<string, unknown> | undefined;
    return row
      ? { status: 'ok', binding: generatedArtifactContractForBinding(db, bindingFromRow(row)) }
      : { status: 'missing' };
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

/** Compatibility view for non-authoritative diagnostics. Authority callers
 * must consume loadExpectedWorkCallBindingState and fail closed. */
export function loadExpectedWorkCallBinding(input: {
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId: string;
}): ExpectedWorkCallBinding | undefined {
  const state = loadExpectedWorkCallBindingState(input);
  return state.status === 'ok' ? state.binding : undefined;
}

function refusal(
  kind: ExpectedWorkAdmissionFailureKind,
  reason: string,
): ExpectedWorkInvocationAdmission {
  return { status: 'refused', kind, reason };
}

/**
 * A compute requirement no tool call has ever attempted is undischargeable by
 * construction: nothing will ever settle it, so every operation depending on it
 * blocks forever. That is almost always model-composed content proposed as work
 * a tool would do (live 2026-08-11 run 5: drafts composed in-model behind a
 * compute op, 800s of blocked writes).
 *
 * The refusal names the way out as DATA, exactly like the record-keys detail on
 * a seal miss. No proposal shape is refused that was not already refused; the
 * model simply learns which of its operations can never complete.
 */
function undischargeableComputeAdvisory(
  db: Database.Database,
  contract: AcceptedTaskWorkContractV1,
  dependency: ExpectedWorkOperationV1 | undefined,
): string {
  if (dependency?.effect !== 'compute') return '';
  const attempts = db.prepare(`
    SELECT COUNT(*) AS count FROM expected_work_call_bindings
     WHERE session_id = ? AND source_user_seq = ? AND contract_id = ? AND requirement_id = ?
  `).get(
    contract.identity.sessionId,
    contract.identity.sourceUserSeq,
    contract.contractId,
    dependency.id,
  ) as { count: number };
  return attempts.count > 0
    ? ''
    : '; no tool call has ever attempted this compute requirement — if this content is model-composed, it belongs inside the consuming write\'s args (re-propose without the compute operation)';
}


/** Compute the remaining-plan card from the frozen contract + settled
 *  bindings. Cheap (one SELECT per contract) and safe inside the admission
 *  transaction. */
function planLinesFor(
  db: Database.Database,
  contract: AcceptedTaskWorkContractV1,
  sealCache?: ExpectedWorkUniverseSealCache,
): ExpectedWorkPlanLine[] {
  // DERIVED FROM THE GATE, never counted separately. A settled binding is not
  // a discharged one: the card used to count anything that settled and so told
  // the model a requirement was satisfied while the gate refused the work
  // waiting on it.
  const settledByRequirement = new Map<string, Set<string>>();
  const observedByRequirement = new Map<string, Set<string>>();
  for (const operation of contract.operations) {
    const settled = new Set<string>();
    for (const row of dischargedRequirementSettlements(db, contract, operation.id)) {
      settled.add(row.universe_item_id ?? '');
    }
    settledByRequirement.set(operation.id, settled);
    const observed = new Set<string>(settled);
    if (operation.effect === 'read') {
      for (const row of observedRequirementSettlements(db, contract, operation.id)) {
        observed.add(row.universe_item_id ?? '');
      }
    }
    observedByRequirement.set(operation.id, observed);
  }
  // Compute intrinsic completion independently from presentation order. The
  // canonical contract sorts operations by id for stable hashing, but ids do
  // not encode dependency order: `a_write -> z_source` is valid. Building the
  // satisfied set while walking that lexical order made readiness depend on
  // how the model happened to name operations.
  const intrinsic = new Map<string, {
    settled: number;
    observed: number;
    required: number | 'unknown';
    done: boolean;
    dataIn: boolean;
  }>();
  for (const operation of contract.operations) {
    const settled = settledByRequirement.get(operation.id)?.size ?? 0;
    const observed = observedByRequirement.get(operation.id)?.size ?? 0;
    let required: number | 'unknown' = 1;
    if (operation.cardinality.kind !== 'once') {
      const universe = contract.universes.find((entry) =>
        entry.id === (operation.cardinality as { universeId: string }).universeId);
      // A sealed source universe knows its own size once its producer read has
      // settled; before that the count is honestly unknown, not zero.
      const resolved = universe
        ? resolveExpectedWorkUniverseMembers({
            db,
            contract,
            universe,
            ...(sealCache ? { cache: sealCache } : {}),
          })
        : { status: 'unsealed' as const, reason: 'operation universe is missing' };
      required = resolved.status === 'resolved'
        ? (operation.cardinality.kind === 'each' ? resolved.members.length : 1)
        : 'unknown';
    }
    const done = typeof required === 'number' && settled >= required;
    intrinsic.set(operation.id, {
      settled,
      observed,
      required,
      done,
      dataIn: !done && observed > 0,
    });
  }
  const byId = new Map(contract.operations.map((operation) => [operation.id, operation]));
  const predecessorReady = (dependencyId: string, current: ExpectedWorkOperationV1): boolean => {
    const depState = intrinsic.get(dependencyId);
    if (!depState) return false;
    if (depState.done) return true;
    // Same once→once provisional path as the gate: data in unblocks the next
    // step without certifying complete_set. Fan-out still needs a seal.
    const dependency = byId.get(dependencyId);
    return Boolean(
      dependency
      && dependency.effect === 'read'
      && dependency.cardinality.kind === 'once'
      && current.cardinality.kind === 'once'
      && depState.dataIn,
    );
  };
  const lines: ExpectedWorkPlanLine[] = [];
  for (const operation of contract.operations) {
    const state = intrinsic.get(operation.id)!;
    const { settled, observed, required, done, dataIn } = state;
    const blocked = !done && operation.dependsOn.some((dep) => !predecessorReady(dep, operation));
    lines.push({
      requirementId: operation.id,
      effect: operation.effect,
      cardinality: operation.cardinality.kind,
      dependsOn: operation.dependsOn,
      settledInstances: settled,
      observedInstances: observed,
      requiredInstances: required,
      state: done ? 'satisfied' : blocked ? 'blocked_on_dependency' : dataIn ? 'data_in' : 'open',
    });
  }
  return lines;
}

/** Public plan card for one frozen contract. Same oracle as admission refusals. */
export function expectedWorkPlanLines(input: {
  sessionId: string;
  sourceUserSeq: number;
}): ExpectedWorkPlanLine[] {
  const loaded = loadExpectedWorkContract(input.sessionId, input.sourceUserSeq);
  if (loaded.status !== 'ok') return [];
  return planLinesFor(openEventLog(), loaded.contract);
}

const WORK_PROGRESS_ID_RE = WORK_ID_PATTERN;

function publicWorkPlanDigest(lines: ExpectedWorkPlanLine[]): string {
  return JSON.stringify(lines.map((line) => ({
    id: line.requirementId,
    effect: line.effect,
    state: line.state,
    settled: line.settledInstances,
    observed: line.observedInstances,
    required: line.requiredInstances === 'unknown' ? null : line.requiredInstances,
    dependsOn: line.dependsOn.filter((dep) => WORK_PROGRESS_ID_RE.test(dep)),
  })));
}

const seenUnsatisfiableRefusals = new Set<string>();

function repeatedUnsatisfiableDependencyRefusal(
  sessionId: string,
  sourceUserSeq: number,
  requirementId: string,
  lines: ExpectedWorkPlanLine[],
): boolean {
  const key = `${sessionId}:${sourceUserSeq}:${requirementId}:${publicWorkPlanDigest(lines)}`;
  if (seenUnsatisfiableRefusals.has(key)) return true;
  seenUnsatisfiableRefusals.add(key);
  if (seenUnsatisfiableRefusals.size > 2_048) {
    const oldest = seenUnsatisfiableRefusals.values().next().value;
    if (typeof oldest === 'string') seenUnsatisfiableRefusals.delete(oldest);
  }
  return false;
}

/** Project the host plan card onto the public activity bus. Deduped on digest
 *  so a bind/settle storm does not replay an unchanged board. */
export function publishExpectedWorkProgress(input: {
  sessionId: string;
  sourceUserSeq: number;
}): void {
  try {
    const lines = expectedWorkPlanLines(input);
    if (lines.length === 0) return;
    const payload = {
      version: 1 as const,
      sourceUserSeq: input.sourceUserSeq,
      lines: JSON.parse(publicWorkPlanDigest(lines)) as Array<Record<string, unknown>>,
    };
    const digest = publicWorkPlanDigest(lines);
    const prior = listEvents(input.sessionId, { types: ['expected_work_progress'] })
      .filter((event) => event.data.sourceUserSeq === input.sourceUserSeq)
      .at(-1);
    if (prior && JSON.stringify(prior.data.lines) === digest) return;
    appendEvent({
      sessionId: input.sessionId,
      turn: 0,
      role: 'system',
      type: 'expected_work_progress',
      data: payload,
    });
  } catch {
    // Presentation never owns the turn.
  }
}

/**
 * Deterministic packet binding for a fan-out under a frozen contract.
 *
 * Live 2026-08-11: contracted workers were dispatched blind — no requirement
 * or item named in the packet — and a worker that saw no first-class write
 * tool quit with zero calls ("write_file capability was not available").
 * When the binding is UNAMBIGUOUS (exactly one non-satisfied each-cardinality
 * requirement whose sealed universe covers every fanned item), the dispatch
 * site injects it into the packet so instruction and surface agree. Any
 * ambiguity or error returns null — advisory injection, never a gate.
 */
export function deriveWorkerPacketExpectedWork(input: {
  sessionId: string;
  sourceUserSeq: number | undefined;
  items: string[];
}): { requirementId: string; universeId: string } | null {
  if (typeof input.sourceUserSeq !== 'number' || input.items.length === 0) return null;
  try {
    const state = actionExpectedWorkState({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
    });
    if (state.status !== 'required' || !state.contractId) return null;
    const loaded = loadExpectedWorkContract(input.sessionId, input.sourceUserSeq);
    if (loaded.status !== 'ok' || loaded.contract.contractId !== state.contractId) return null;
    const contract = loaded.contract;
    const db = openEventLog();
    const sealCache: ExpectedWorkUniverseSealCache = new Map();
    const candidates: Array<{ requirementId: string; universeId: string }> = [];
    for (const line of planLinesFor(db, contract, sealCache)) {
      if (line.state === 'satisfied' || line.cardinality !== 'each') continue;
      const operation = contract.operations.find((op) => op.id === line.requirementId);
      if (!operation || operation.cardinality.kind !== 'each') continue;
      const universeId = operation.cardinality.universeId;
      const universe = contract.universes.find((entry) => entry.id === universeId);
      if (!universe) continue;
      const resolved = resolveExpectedWorkUniverseMembers({ db, contract, universe, cache: sealCache });
      if (resolved.status !== 'resolved') continue;
      const members = new Set(resolved.members);
      if (!input.items.every((item) => members.has(item))) continue;
      candidates.push({ requirementId: line.requirementId, universeId });
    }
    // Two open per-item requirements over these members would make the
    // injection a guess — the worker still gets the plan card on refusal.
    return candidates.length === 1 ? candidates[0] : null;
  } catch {
    return null;
  }
}

/**
 * Attach the host-derived frozen-work binding to a worker packet.
 *
 * Every worker lane uses this one function immediately before dispatch. The
 * packet supplied by a model is not authority: when the durable accepted-task
 * contract yields one unambiguous binding, that binding wins even if a caller
 * supplied a stale or conflicting hint. When no binding can be proved, the
 * packet is left unchanged and the ordinary admission wall remains in force.
 */
export function bindWorkerPacketExpectedWork<
  T extends { expectedWork?: { requirementId: string; universeId?: string | null } | null },
>(input: {
  packet: T;
  sessionId: string;
  sourceUserSeq: number | undefined;
  items: string[];
}): T {
  if (!input.sessionId) return input.packet;
  const derived = deriveWorkerPacketExpectedWork({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    items: input.items,
  });
  if (!derived) return input.packet;
  if (
    input.packet.expectedWork?.requirementId === derived.requirementId
    && input.packet.expectedWork?.universeId === derived.universeId
  ) return input.packet;
  return {
    ...input.packet,
    expectedWork: {
      requirementId: derived.requirementId,
      universeId: derived.universeId,
    },
  };
}

/** Freeze/replay the proposal and bind the exact current logical call in one
 * transaction. The call must already have been monotonically refined from the
 * outer carrier to the normalized inner tool contract. */
export function admitExpectedWorkInvocation(input: {
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId: string;
  proposal?: ExpectedWorkProposalV1 | null;
  requirementId: string;
  universeItemId?: string | null;
  universeSelector?: ExpectedWorkUniverseSelectorV1 | null;
  /** ONE correction to where member identity lives in the producer's records,
   *  after a seal refusal named what those records actually carry. Everything
   *  else in the frozen proposal stays fixed. */
  sealAmendment?: { universeId: string; memberIdPointer: string } | null;
  tool: string;
  args: unknown;
  /** Exact provider-ready callable schema observed before dispatch. */
  inputSchema?: unknown;
  /** Optional semantic inner payload/schema for a transport carrier. These
   * refine evidence only; logical identity and effect remain bound to args. */
  evidenceArgs?: unknown;
  evidenceInputSchema?: unknown;
  /** Effect attested by the exact host-sealed graph-node binding. This is not
   * caller authority: the admission boundary re-reads and matches the durable
   * binding before using it. A pure `none` graph capability is represented as
   * compute evidence because it executes work without granting a mutation. */
  hostSealedEffect?: Exclude<RuntimeToolEffect, 'unknown'>;
  /** Synchronous durable-continuation owner written in the SAME IMMEDIATE
   * transaction as this expected-work binding. It must perform no I/O beyond
   * the supplied DB transaction and must be idempotent for replay. */
  recordContinuationInTransaction?: (input: {
    db: Database.Database;
    binding: ExpectedWorkCallBinding;
    argumentDigest: string;
  }) => void;
}): ExpectedWorkInvocationAdmission {
  const loaded = loadExpectedWorkContract(input.sessionId, input.sourceUserSeq);
  let contract: AcceptedTaskWorkContractV1;
  let prepared: AcceptedTaskWorkContractV1 | undefined;
  if (loaded.status === 'ok') {
    contract = loaded.contract;
    if (input.proposal) {
      const candidate = prepareActionExpectedWorkContract({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        proposal: input.proposal,
      });
      if (candidate.status !== 'prepared') {
        return refusal('work_contract_invalid', candidate.reason);
      }
      if (candidate.contract.contractId !== contract.contractId) {
        return refusal('work_contract_conflict', 'a different action topology is already frozen');
      }
      prepared = candidate.contract;
    }
  } else if (loaded.status === 'missing') {
    if (!input.proposal) {
      return refusal('work_contract_required', 'the first work_call must include the complete semantic proposal');
    }
    const candidate = prepareActionExpectedWorkContract({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      proposal: input.proposal,
    });
    if (candidate.status !== 'prepared') {
      return refusal('work_contract_invalid', candidate.reason);
    }
    contract = candidate.contract;
    prepared = candidate.contract;
  } else {
    return refusal(
      loaded.status === 'conflict' || loaded.status === 'corrupt'
        ? 'work_contract_conflict'
        : 'work_authority_unavailable',
      loaded.reason,
    );
  }

  // Every refusal from here on carries the remaining-plan card: the frozen
  // contract + settled bindings are fully computable, and a refusal without
  // them sent the model into blind proposal-retry cycles (live 2026-08-11:
  // 84 refusals on one count-only ask).
  const db = openEventLog();
  const sealCache = createExpectedWorkUniverseSealCache();
  const refusedWithPlan = (
    kind: ExpectedWorkAdmissionFailureKind,
    reason: string,
  ): ExpectedWorkInvocationAdmission => {
    try {
      const plan = planLinesFor(db, contract, sealCache);
      if (
        kind === 'work_dependency_pending'
        && plan.some((line) => line.state === 'data_in' || line.state === 'satisfied')
        && plan.some((line) => line.state === 'blocked_on_dependency')
        && repeatedUnsatisfiableDependencyRefusal(
          contract.identity.sessionId,
          contract.identity.sourceUserSeq,
          input.requirementId,
          plan,
        )
      ) {
        return {
          status: 'refused',
          kind: 'work_attempt_budget_exhausted',
          reason: `${reason}; the plan did not change — useful results cannot satisfy this graph`,
          plan,
        };
      }
      return { status: 'refused', kind, reason, plan };
    } catch {
      return refusal(kind, reason);
    }
  };
  const operation = invocationOperationForContract({
    contract,
    requirementId: input.requirementId,
    tool: input.tool,
    args: input.args,
  });
  if (!operation) return refusedWithPlan('work_requirement_unknown', `requirement ${input.requirementId} is not in the frozen proposal`);
  const runtimeProjection = runtimeExpectedWorkProjection(input.tool, input.args);
  if (!runtimeProjection.mayBindBusinessWork) {
    return refusedWithPlan(
      'work_effect_mismatch',
      `requirement ${operation.id} is business work; this control call cannot bind it`,
    );
  }
  const runtime = runtimeProjection.decision;
  const sealedEffect = (() => {
    if (!input.hostSealedEffect) return null;
    if (!input.args || typeof input.args !== 'object' || Array.isArray(input.args)) return null;
    const args = input.args as Record<string, unknown>;
    if (args.nodeId !== operation.id) return null;
    try {
      const row = openEventLog().prepare(`
        SELECT binding_json, binding_digest
          FROM graph_node_bindings
         WHERE session_id = ? AND source_user_seq = ? AND node_id = ?
      `).get(input.sessionId, input.sourceUserSeq, operation.id) as {
        binding_json: string;
        binding_digest: string;
      } | undefined;
      if (!row) return null;
      const binding = JSON.parse(row.binding_json) as Record<string, unknown>;
      if (
        binding.bindingDigest !== row.binding_digest
        || binding.toolName !== input.tool
        || binding.capabilityId !== args.capabilityId
        || binding.schemaVersion !== args.schemaVersion
        || binding.schemaDigest !== args.schemaDigest
      ) return null;
      const effect = binding.effect;
      if ((effect === 'none' || effect === 'host_only') && input.hostSealedEffect === 'compute') {
        return 'compute' as const;
      }
      return effect === input.hostSealedEffect ? input.hostSealedEffect : null;
    } catch {
      return null;
    }
  })();
  const admittedEffect = input.hostSealedEffect ? sealedEffect : runtime.effect;
  if (!admittedEffect || admittedEffect === 'unknown' || admittedEffect !== operation.effect) {
    return refusedWithPlan(
      'work_effect_mismatch',
      `requirement ${operation.id} expects ${operation.effect}; the resolved call is ${admittedEffect ?? 'unsealed'}`,
    );
  }
  const logicalContract = durableLogicalCallContract(contract.acceptedTaskId, input.tool, input.args);
  if (!logicalContract) return refusedWithPlan('work_authority_unavailable', 'resolved logical call contract is unsafe');

  const continuationRepair = continuationArgumentRepairProjection({
    db: openEventLog(),
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    tool: input.tool,
    args: input.args,
  });
  if (continuationRepair.status === 'identical') {
    return refusedWithPlan(
      'work_attempt_budget_exhausted',
      'the durable parent outcome requires corrected arguments; this continuation reproduced the same effective call, so an identical replay is not a repair',
    );
  }
  if (continuationRepair.status === 'unavailable') {
    return refusedWithPlan(
      'work_authority_unavailable',
      `the continuation repair requirement cannot be verified: ${continuationRepair.reason}`,
    );
  }

  try {
    const evidenceArgs = input.evidenceArgs ?? input.args;
    const evidenceInputSchema = input.evidenceInputSchema ?? input.inputSchema;
    const db = openEventLog();
    ensureGeneratedArtifactContractSchema(db);
    const tx = db.transaction((): ExpectedWorkInvocationAdmission => {
      const authority = authorityActivationRow(db, input.sessionId, input.sourceUserSeq);
      if (
        !authority
        || authority.expected_work_required !== 1
        || authority.accepted_task_id !== contract.acceptedTaskId
        || authority.state !== 'armed'
      ) return refusedWithPlan('work_authority_unavailable', 'action expected-work authority is not active and armed');

      const logical = db.prepare(`
        SELECT accepted_task_id, tool_name, argument_digest, state
          FROM logical_tool_calls
         WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
      `).get(input.sessionId, input.sourceUserSeq, input.logicalToolCallId) as {
        accepted_task_id: string;
        tool_name: string;
        argument_digest: string;
        state: string;
      } | undefined;
      if (
        !logical
        || logical.accepted_task_id !== contract.acceptedTaskId
        || logical.tool_name !== logicalContract.toolName
        || logical.argument_digest !== logicalContract.argumentDigest
        || logical.state !== 'open'
      ) return refusedWithPlan('work_authority_unavailable', 'logical call is not the exact open normalized inner call');
      const crossingCount = (db.prepare(`
        SELECT COUNT(*) AS count FROM physical_dispatches
         WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
      `).get(input.sessionId, input.sourceUserSeq, input.logicalToolCallId) as { count: number }).count;
      if (crossingCount !== 0) {
        return refusedWithPlan('work_authority_unavailable', 'logical call already crossed a provider boundary');
      }

      const existing = db.prepare(`
        SELECT * FROM expected_work_call_bindings
         WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
      `).get(input.sessionId, input.sourceUserSeq, input.logicalToolCallId) as Record<string, unknown> | undefined;
      if (existing) {
        const binding = bindingFromRow(existing);
        if (
          binding.contractId === contract.contractId
          && binding.requirementId === operation.id
          && binding.universeItemId === (input.universeItemId ?? undefined)
          && String(existing.tool_name) === logicalContract.toolName
          && String(existing.argument_digest) === logicalContract.argumentDigest
        ) {
          const replayed = generatedArtifactContractForBinding(db, binding);
          input.recordContinuationInTransaction?.({
            db,
            binding: replayed,
            argumentDigest: logicalContract.argumentDigest,
          });
          return { status: 'replayed', binding: replayed, contract };
        }
        return refusedWithPlan('work_contract_conflict', 'logical call already owns a different work binding');
      }

      const prior = priorRequirementAllowsAdmission(
        db,
        contract,
        operation,
        input.universeItemId ?? undefined,
        logicalContract.toolName,
        logicalContract.argumentDigest,
        { tool: input.tool, args: input.args },
      );
      if (!prior.ok) {
        // A SETTLED requirement instance is not an error: hand the carrier
        // the prior call so it can return the stored result (the model asked
        // because it needs the data — an error here restarted the whole
        // guess-loop; live 2026-08-11: 6 pure-waste retries in one run).
        if (prior.satisfiedByLogicalToolCallId) {
          return {
            status: 'satisfied',
            priorLogicalToolCallId: prior.satisfiedByLogicalToolCallId,
            contract,
            plan: planLinesFor(db, contract, sealCache),
          };
        }
        if (prior.retainedByLogicalToolCallId) {
          return {
            status: 'evidence_retained',
            priorLogicalToolCallId: prior.retainedByLogicalToolCallId,
            contract,
            plan: planLinesFor(db, contract, sealCache),
          };
        }
        if (prior.executedByLogicalToolCallId) {
          return {
            status: 'effect_already_executed',
            priorLogicalToolCallId: prior.executedByLogicalToolCallId,
            contract,
            plan: planLinesFor(db, contract, sealCache),
          };
        }
        return refusedWithPlan(prior.refusalKind ?? 'work_already_satisfied', prior.reason);
      }

      for (const dependencyId of operation.dependsOn) {
        const dependency = contract.operations.find((entry) => entry.id === dependencyId);
        if (!dependency || !dependencyReadyForCurrentOperation(
          db,
          contract,
          dependency,
          operation,
          input.universeItemId ?? undefined,
          input.tool,
          input.args,
          evidenceArgs,
          evidenceInputSchema,
        )) return refusedWithPlan(
          'work_dependency_pending',
          `dependency ${dependencyId} is not durably satisfied${
            undischargeableComputeAdvisory(db, contract, dependency)}`,
        );
      }

      const universe = universeFor(contract, operation);
      let selectorJson: string | null = null;
      let memberDigest: string | null = null;
      let memberCount: number | null = null;
      let inputSourceKind: string | null = null;
      let inputSourceRef: string | null = null;
      let inputSourceDigest: string | null = null;
      let universeMembers: string[] | null = null;
      if (operation.cardinality.kind === 'once') {
        if (input.universeItemId != null || input.universeSelector != null) {
          return refusedWithPlan('work_cardinality_mismatch', 'once cardinality accepts neither an item nor universe selector');
        }
      } else {
        if (!universe) return refusedWithPlan('work_cardinality_mismatch', 'operation universe is missing');
        if (operation.cardinality.kind === 'each' && !input.universeItemId) {
          return refusedWithPlan('work_cardinality_mismatch', 'each cardinality requires universe_item_id');
        }
        if (operation.cardinality.kind === 'set' && input.universeItemId != null) {
          return refusedWithPlan('work_cardinality_mismatch', 'set cardinality binds the full set, not one item');
        }
        const hostMayBindPerItemTarget = operation.cardinality.kind === 'each'
          && (operation.effect === 'external_write' || operation.effect === 'local_write')
          && !input.universeSelector;
        if (!input.universeSelector && !hostMayBindPerItemTarget) {
          return refusedWithPlan('work_cardinality_mismatch', 'set/read cardinality requires an immutable argument selector');
        }
        const selected = input.universeSelector
          ? selectedMemberIds(evidenceArgs, input.universeSelector, operation.cardinality.kind)
          : { ok: true as const, ids: [input.universeItemId as string] };
        if (!selected.ok) return refusedWithPlan('work_cardinality_mismatch', selected.reason);
        // A pointer frozen before the read that proves it may be corrected
        // once, here, in the same call that binds the first member — so the
        // model's recovery is one work_call, not a dead turn.
        if (input.sealAmendment) {
          if (universe.seal !== 'complete_source_receipt') {
            return refusedWithPlan(
              'work_universe_unsealed',
              'only a source-derived universe has a member-id pointer to correct',
            );
          }
          if (input.sealAmendment.universeId !== universe.id) {
            return refusedWithPlan(
              'work_universe_unsealed',
              `the amendment names universe ${input.sealAmendment.universeId}, but this call binds ${universe.id}`,
            );
          }
          const amended = amendSourceUniverseMemberIdPointer({
            db,
            contract,
            universe,
            memberIdPointer: input.sealAmendment.memberIdPointer,
            motivatingRefusal: `binding ${operation.id}`,
            cache: sealCache,
          });
          if (amended.status !== 'amended') {
            return refusedWithPlan('work_universe_unsealed', amended.reason);
          }
        }
        // Accepted input is exact at freeze; a source-derived universe is
        // sealed here from its producer read's own settled complete result.
        const resolvedUniverse = resolveExpectedWorkUniverseMembers({
          db,
          contract,
          universe,
          cache: sealCache,
        });
        if (resolvedUniverse.status !== 'resolved') {
          return refusedWithPlan('work_universe_unsealed', resolvedUniverse.reason);
        }
        const expectedMembers = resolvedUniverse.members;
        const requiredMembers = operation.cardinality.kind === 'each'
          ? [input.universeItemId as string]
          : expectedMembers;
        if (
          requiredMembers.length !== selected.ids.length
          || requiredMembers.some((member, index) => member !== selected.ids[index])
          || requiredMembers.some((member) => !expectedMembers.includes(member))
        ) return refusedWithPlan('work_cardinality_mismatch', 'selected argument members do not match the accepted universe instance');
        universeMembers = expectedMembers;
        if (resolvedUniverse.seal) {
          // The consumer binding carries the seal durably: which producer call
          // sealed the universe, and the digest of the exact member list every
          // later reader must recompute.
          inputSourceKind = 'complete_source_receipt';
          inputSourceRef = resolvedUniverse.seal.producerLogicalToolCallId;
          inputSourceDigest = resolvedUniverse.seal.digest;
        } else {
          const witness = sourceWitness(db, contract, universe, selected.ids);
          const grounded = witness.ok
            ? witness
            : hostMayBindPerItemTarget && witness.callTargetFallback
              ? callTargetWitness({
                  db,
                  contract,
                  universe,
                  logicalToolCallId: input.logicalToolCallId,
                  universeItemId: input.universeItemId as string,
                  args: evidenceArgs,
                })
              : witness;
          if (!grounded.ok) return refusedWithPlan('work_source_witness_missing', grounded.reason);
          if (grounded.ref === input.logicalToolCallId) {
            const duplicateTarget = db.prepare(`
              SELECT universe_item_id
                FROM expected_work_call_bindings
               WHERE session_id = ? AND source_user_seq = ?
                 AND contract_id = ? AND requirement_id = ?
                 AND universe_id = ?
                 AND input_source_kind = 'complete_source_receipt'
                 AND input_source_ref = logical_tool_call_id
                 AND input_source_digest = ?
                 AND universe_item_id <> ?
               LIMIT 1
            `).get(
              contract.identity.sessionId,
              contract.identity.sourceUserSeq,
              contract.contractId,
              operation.id,
              universe.id,
              grounded.digest,
              input.universeItemId as string,
            ) as { universe_item_id: string } | undefined;
            if (duplicateTarget) {
              return refusedWithPlan(
                'work_cardinality_mismatch',
                `the concrete call target is already bound to count-only slot ${duplicateTarget.universe_item_id}`,
              );
            }
          }
          inputSourceKind = grounded.kind;
          inputSourceRef = grounded.ref;
          inputSourceDigest = grounded.digest;
        }
        selectorJson = canonicalExpectedWorkJson(
          input.universeSelector ?? HOST_DERIVED_CALL_TARGET_SELECTOR,
        );
        memberDigest = expectedWorkDigest(canonicalExpectedWorkJson(selected.ids));
        memberCount = selected.ids.length;
      }

      let evidenceMode: 'point_read' | 'collection_read' | 'finite_read' | null = null;
      let evidenceBasis: string | null = null;
      let schemaFingerprint: string | null = null;
      let schemaDigest: string | null = null;
      if (operation.effect === 'read') {
        const refinement = refinePreDispatchReadEvidence({
          operation,
          universes: contract.universes,
          ...(input.universeItemId ? { universeItemId: input.universeItemId } : {}),
          // A per-item read over a sealed source universe is proven against the
          // members the host just sealed, not against a member list the
          // contract could not have known at accept time.
          ...(universeMembers ? { universeMembers } : {}),
          inputSchema: evidenceInputSchema,
          args: evidenceArgs,
        });
        if (refinement.status !== 'authoritative') {
          return refusedWithPlan(
            'work_cardinality_mismatch',
            `read evidence shape is not structurally provable: ${refinement.reason}`,
          );
        }
        evidenceMode = refinement.mode;
        const boundedWindow = operation.coverage === 'complete_set'
          ? schemaBoundedCollectionWindow(evidenceArgs, evidenceInputSchema)
          : null;
        evidenceBasis = boundedWindow === null
          ? refinement.basis
          : `${refinement.basis}:bounded_window=${boundedWindow}`;
        if ('proof' in refinement) {
          const derivedSelector: ExpectedWorkUniverseSelectorV1 = {
            argumentPointer: refinement.proof.argumentPointer,
            memberIdPointer: refinement.proof.memberIdPointer,
          };
          if (
            !input.universeSelector
            || canonicalExpectedWorkJson(input.universeSelector)
              !== canonicalExpectedWorkJson(derivedSelector)
          ) {
            return refusedWithPlan(
              'work_cardinality_mismatch',
              'the proposed universe selector does not equal the unique schema-derived selector',
            );
          }
          selectorJson = canonicalExpectedWorkJson(derivedSelector);
          memberDigest = refinement.proof.memberDigest;
          memberCount = refinement.proof.memberCount;
          schemaDigest = refinement.proof.schemaDigest;
          schemaFingerprint = `json-schema:sha256:${refinement.proof.schemaDigest}`;
        }
      }

      const generatedAtomicContract = generatedAtomicContentContractForAdmission({
        contract,
        operation,
        tool: input.tool,
        callArgs: input.args,
        providerArguments: evidenceArgs,
        providerArgumentsVisible: !input.hostSealedEffect,
      });
      if (generatedAtomicContract && !generatedAtomicContract.ok) {
        return refusedWithPlan('work_source_witness_missing', generatedAtomicContract.reason);
      }
      const generatedArtifactContract = generatedAtomicContract ?? hostSealedContentContractForAdmission({
        db,
        contract,
        operation,
        evidenceArgs,
      });
      if (generatedArtifactContract && !generatedArtifactContract.ok) {
        return refusedWithPlan('work_source_witness_missing', generatedArtifactContract.reason);
      }

      const freeze = prepared
        ? freezePreparedExpectedWorkContractInTransaction(db, {
            sessionId: input.sessionId,
            sourceUserSeq: input.sourceUserSeq,
            contract: prepared,
          })
        : { status: 'replayed' as const, contract };
      if (freeze.status !== 'fixed' && freeze.status !== 'replayed') {
        return refusedWithPlan(
          freeze.status === 'invalid' || freeze.status === 'conflict'
            ? 'work_contract_conflict'
            : 'work_authority_unavailable',
          'reason' in freeze ? freeze.reason : 'expected-work contract freeze failed',
        );
      }
      contract = freeze.contract;

      db.prepare(`
        INSERT INTO expected_work_call_bindings
          (session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
           contract_id, requirement_id, tool_name, argument_digest, effect_kind,
           cardinality_kind, universe_id, universe_seal, universe_item_id,
           universe_selector_json, universe_member_digest, universe_member_count,
           input_source_kind, input_source_ref, input_source_digest,
           evidence_mode, evidence_basis, schema_fingerprint, schema_digest, bound_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.sessionId,
        input.sourceUserSeq,
        contract.acceptedTaskId,
        input.logicalToolCallId,
        contract.contractId,
        operation.id,
        logicalContract.toolName,
        logicalContract.argumentDigest,
        operation.effect,
        operation.cardinality.kind,
        operation.cardinality.kind === 'once' ? null : operation.cardinality.universeId,
        universe?.seal ?? null,
        operation.cardinality.kind === 'each' ? input.universeItemId : null,
        selectorJson,
        memberDigest,
        memberCount,
        inputSourceKind,
        inputSourceRef,
        inputSourceDigest,
        evidenceMode,
        evidenceBasis,
        schemaFingerprint,
        schemaDigest,
        new Date().toISOString(),
      );
      if (generatedArtifactContract?.ok) {
        const frozenJson = JSON.stringify(generatedArtifactContract.contentContract);
        if (Buffer.byteLength(frozenJson, 'utf8') > 1_000_000) {
          throw new Error('generated artifact content contract exceeds the durable bound');
        }
        db.prepare(`
          INSERT INTO expected_work_generated_artifact_contracts
            (session_id, source_user_seq, logical_tool_call_id, contract_json, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          input.sessionId,
          input.sourceUserSeq,
          input.logicalToolCallId,
          frozenJson,
          new Date().toISOString(),
        );
      }
      const binding: ExpectedWorkCallBinding = {
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        acceptedTaskId: contract.acceptedTaskId,
        logicalToolCallId: input.logicalToolCallId,
        contractId: contract.contractId,
        requirementId: operation.id,
        effect: operation.effect,
        cardinality: operation.cardinality.kind,
        ...(operation.cardinality.kind === 'once'
          ? {}
          : { universeId: operation.cardinality.universeId }),
        ...(operation.cardinality.kind === 'each' && input.universeItemId
          ? { universeItemId: input.universeItemId }
          : {}),
        ...(memberDigest ? { universeMemberDigest: memberDigest } : {}),
        ...(memberCount ? { universeMemberCount: memberCount } : {}),
        ...(evidenceMode ? { evidenceMode } : {}),
        ...(evidenceBasis ? { evidenceBasis } : {}),
        ...(schemaFingerprint ? { schemaFingerprint } : {}),
        ...(schemaDigest ? { schemaDigest } : {}),
        ...(generatedArtifactContract?.ok
          ? { generatedArtifactContentContract: generatedArtifactContract.contentContract }
          : {}),
      };
      input.recordContinuationInTransaction?.({
        db,
        binding,
        argumentDigest: logicalContract.argumentDigest,
      });
      return { status: 'bound', binding, contract };
    });
    const result = tx.immediate();
    publishExpectedWorkProgress({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
    });
    return result;
  } catch (error) {
    const refused = refusedWithPlan('work_authority_unavailable', boundedReason(error));
    publishExpectedWorkProgress({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
    });
    return refused;
  }
}
