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
  generatedArtifactReadContentVerified,
  generatedArtifactWriteContentVerified,
} from './artifact-ledger.js';
import { compileGoogleSheetsSheetFromJsonContract } from './sheet-from-json-content-contract.js';
import { classifyExternalWrite } from './confirm-first-gate.js';
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
import { getSession, openEventLog } from './eventlog.js';
import { computeResultHasSubstance } from './expected-work-matcher.js';
import { durableLogicalCallContract } from './logical-call-contract.js';
import { detectMultiItemIntent } from './multi-item-intent.js';
import {
  proveFiniteReadResultCoverage,
  refinePreDispatchReadEvidence,
  type FiniteReadStructuralProof,
} from './read-evidence-refinement.js';
import { inspectProviderEnvelope } from './provider-read-evidence.js';
import { recordsAtRecordPath } from './result-facts.js';
import {
  redeemedReadIsExhausted,
  redeemSuccessfulSettlementResultForHost,
} from './result-handle.js';
import { expectedTaskFor } from './resolution-ledger.js';
import {
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
  type RuntimeToolEffect,
  type TrustedRuntimeEffectCarrier,
} from './tool-effect.js';

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
  | 'work_already_satisfied'
  | 'work_evidence_incomplete'
  | 'work_effect_already_executed'
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
  settledInstances: number;
  requiredInstances: number | 'unknown';
  state: 'satisfied' | 'open' | 'blocked_on_dependency';
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

function boundedReason(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 300);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allow = new Set(allowed);
  return Object.keys(value).every((key) => allow.has(key));
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
  if (expected.graph.classification.route !== 'act') {
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
  if (expected.graph.classification.route !== 'act') return { status: 'not_action' };
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
): { ok: true; kind: string; ref: string; digest: string } | { ok: false; reason: string } {
  if (universe.seal !== 'accepted_input') {
    return { ok: false, reason: 'complete-source universes remain sealed until their host receipt is redeemable' };
  }
  const row = db.prepare(`
    SELECT id, data_json FROM events
     WHERE session_id = ? AND seq = ? AND type = 'user_input_received'
  `).get(contract.identity.sessionId, contract.identity.sourceUserSeq) as {
    id: string;
    data_json: string;
  } | undefined;
  if (!row) return { ok: false, reason: 'accepted user input witness is missing' };
  let text = '';
  try {
    const parsed = JSON.parse(row.data_json) as { text?: unknown };
    text = typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    return { ok: false, reason: 'accepted user input witness is unreadable' };
  }
  const detected = detectMultiItemIntent(text);
  const exactMembers = detected.exactMembers ? [...detected.exactMembers].sort() : null;
  const proposedMembers = [...universe.members].sort();
  if (
    !detected.isMultiItem
    || !exactMembers
    || detected.itemCount !== exactMembers.length
    || proposedMembers.length !== exactMembers.length
    || proposedMembers.some((member, index) => member !== exactMembers[index])
  ) {
    return {
      ok: false,
      reason: 'accepted-input universe is not the exact host-extracted enumerated set; count-only or ambiguous input must use a later sealed source universe',
    };
  }
  if (selectedIds.some((id) => !proposedMembers.includes(id))) {
    return { ok: false, reason: 'selected members are outside the exact accepted-input universe' };
  }
  return {
    ok: true,
    kind: 'accepted_user_input',
    ref: row.id,
    digest: expectedWorkDigest(canonicalExpectedWorkJson(exactMembers)),
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

function dependencyReadyForCurrentOperation(
  db: Database.Database,
  contract: AcceptedTaskWorkContractV1,
  dependency: ExpectedWorkOperationV1,
  current: ExpectedWorkOperationV1,
  currentItemId: string | undefined,
  currentTool: string,
  currentArgs: unknown,
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
      return effect.external
        && effect.mutating
        && effect.reversibility === 'reversible';
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

  const provisionalRows = db.prepare(`
    SELECT b.logical_tool_call_id, b.universe_item_id
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
  `).all(
    contract.identity.sessionId,
    contract.identity.sourceUserSeq,
    contract.contractId,
    dependency.id,
  ) as Array<{ logical_tool_call_id: string; universe_item_id: string | null }>;
  const cleanRedeemable = provisionalRows.filter((row) => {
    const redeemed = redeemSuccessfulSettlementResultForHost({
      sessionId: contract.identity.sessionId,
      sourceUserSeq: contract.identity.sourceUserSeq,
      acceptedTaskId: contract.acceptedTaskId,
      logicalToolCallId: row.logical_tool_call_id,
    });
    if (redeemed.status !== 'ok') return false;
    const records = recordsAtRecordPath(
      redeemed.value.rawPayload,
      redeemed.value.handle.recordPath,
    );
    return redeemed.value.handle.success
      && records !== null
      && records.length === redeemed.value.handle.recordCount
      && records.some((record) => computeResultHasSubstance(record))
      && redeemed.value.handle.completeness !== 'partial'
      && redeemed.value.handle.continuationRef === null
      && !redeemed.value.handle.continuationRepeated
      && inspectProviderEnvelope(redeemed.value.rawPayload).verdict === 'clean';
  });
  return instancesReady(cleanRedeemable);
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
function generatedSheetContentContractForAdmission(input: {
  contract: AcceptedTaskWorkContractV1;
  operation: ExpectedWorkOperationV1;
  tool: string;
  args: unknown;
}): { ok: true; contentContract: unknown } | { ok: false; reason: string } | null {
  const sheetContract = compileGoogleSheetsSheetFromJsonContract(input.tool, input.args);
  if (!sheetContract) return null;
  if (input.operation.cardinality.kind !== 'once' || input.operation.effect !== 'external_write') {
    return { ok: false, reason: 'a generated Sheet requires one declared create operation' };
  }
  const sourceRequirements = input.operation.dataFrom;
  if (sourceRequirements.length !== 1) {
    return { ok: false, reason: 'generated Sheet create requires exactly one declared dataFrom source' };
  }
  const sourceOperation = input.contract.operations.find((operation) => operation.id === sourceRequirements[0]);
  if (!sourceOperation || sourceOperation.effect !== 'read' || sourceOperation.cardinality.kind !== 'once') {
    return { ok: false, reason: 'generated Sheet dataFrom source must be one exact read' };
  }
  return { ok: true, contentContract: sheetContract };
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

function priorRequirementAllowsAdmission(
  db: Database.Database,
  contract: AcceptedTaskWorkContractV1,
  operation: ExpectedWorkOperationV1,
  universeItemId: string | undefined,
  currentTool: string,
  currentArgumentDigest: string,
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
           s.outcome_kind, s.recovery_action, s.retry_same_candidate,
           s.eliminates_candidate, s.requires_reconciliation
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
    outcome_kind: string | null;
    recovery_action: string | null;
    retry_same_candidate: number | null;
    eliminates_candidate: number | null;
    requires_reconciliation: number | null;
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
  if (operation.effect === 'read' || operation.effect === 'compute') {
    const exactRetained = [...relevant].reverse().find((row) => (
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
  }
  const latest = relevant.at(-1)!;
  if (latest.outcome_kind === 'succeeded' || latest.outcome_kind === 'empty_result') {
    if (operation.effect === 'read' || operation.effect === 'compute') {
      // Reads and computes are safe to retry when their normalized identity
      // changes. The terminal discharge oracle remains strict, so a changed
      // query can gather better evidence but cannot claim complete coverage.
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
  const sameCandidateRepair = latest.retry_same_candidate === 1
    && latest.tool_name === currentTool;
  const siblingRecovery = latest.eliminates_candidate === 1
    && latest.tool_name !== currentTool;
  if (!sameCandidateRepair && !siblingRecovery) {
    return {
      ok: false,
      reason: `the prior ${latest.outcome_kind ?? 'unknown'} outcome authorizes no retry for this requirement`,
    };
  }
  return { ok: true };
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
    const row = openEventLog().prepare(`
      SELECT * FROM expected_work_call_bindings
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(input.sessionId, input.sourceUserSeq, input.logicalToolCallId) as Record<string, unknown> | undefined;
    return row ? { status: 'ok', binding: bindingFromRow(row) } : { status: 'missing' };
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
  for (const operation of contract.operations) {
    const set = new Set<string>();
    for (const row of dischargedRequirementSettlements(db, contract, operation.id)) {
      set.add(row.universe_item_id ?? '');
    }
    settledByRequirement.set(operation.id, set);
  }
  // Compute intrinsic completion independently from presentation order. The
  // canonical contract sorts operations by id for stable hashing, but ids do
  // not encode dependency order: `a_write -> z_source` is valid. Building the
  // satisfied set while walking that lexical order made readiness depend on
  // how the model happened to name operations.
  const intrinsic = new Map<string, {
    settled: number;
    required: number | 'unknown';
    done: boolean;
  }>();
  for (const operation of contract.operations) {
    const settled = settledByRequirement.get(operation.id)?.size ?? 0;
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
    intrinsic.set(operation.id, {
      settled,
      required,
      done: typeof required === 'number' && settled >= required,
    });
  }
  const satisfied = new Set(
    [...intrinsic.entries()]
      .filter(([, state]) => state.done)
      .map(([requirementId]) => requirementId),
  );
  const lines: ExpectedWorkPlanLine[] = [];
  for (const operation of contract.operations) {
    const state = intrinsic.get(operation.id)!;
    const { settled, required, done } = state;
    const blocked = !done && operation.dependsOn.some((dep) => !satisfied.has(dep));
    lines.push({
      requirementId: operation.id,
      effect: operation.effect,
      cardinality: operation.cardinality.kind,
      dependsOn: operation.dependsOn,
      settledInstances: settled,
      requiredInstances: required,
      state: done ? 'satisfied' : blocked ? 'blocked_on_dependency' : 'open',
    });
  }
  return lines;
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
      return { status: 'refused', kind, reason, plan: planLinesFor(db, contract, sealCache) };
    } catch {
      return refusal(kind, reason);
    }
  };
  const operation = contract.operations.find((entry) => entry.id === input.requirementId);
  if (!operation) return refusedWithPlan('work_requirement_unknown', `requirement ${input.requirementId} is not in the frozen proposal`);
  if (actionTopologyRoleForRuntimeCall(input.tool, input.args) === 'control') {
    return refusedWithPlan(
      'work_effect_mismatch',
      `requirement ${operation.id} is business work; a control call cannot discharge it`,
    );
  }
  const runtime = classifyRuntimeToolEffect(input.tool, input.args);
  if (runtime.effect === 'unknown' || runtime.effect !== operation.effect) {
    return refusedWithPlan(
      'work_effect_mismatch',
      `requirement ${operation.id} expects ${operation.effect}; the resolved call is ${runtime.effect}`,
    );
  }
  const logicalContract = durableLogicalCallContract(contract.acceptedTaskId, input.tool, input.args);
  if (!logicalContract) return refusedWithPlan('work_authority_unavailable', 'resolved logical call contract is unsafe');

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
        ) return { status: 'replayed', binding: generatedArtifactContractForBinding(db, binding), contract };
        return refusedWithPlan('work_contract_conflict', 'logical call already owns a different work binding');
      }

      // Accepted-input universes are authority at contract freeze, not when a
      // later item happens to dispatch. Prove every one against the immutable
      // accepted source now so a first unrelated call cannot freeze an omitted
      // or substring-only member set.
      for (const acceptedUniverse of contract.universes) {
        if (acceptedUniverse.seal !== 'accepted_input') continue;
        const witness = sourceWitness(
          db,
          contract,
          acceptedUniverse,
          acceptedUniverse.members,
        );
        if (!witness.ok) return refusedWithPlan('work_source_witness_missing', witness.reason);
      }

      const prior = priorRequirementAllowsAdmission(
        db,
        contract,
        operation,
        input.universeItemId ?? undefined,
        logicalContract.toolName,
        logicalContract.argumentDigest,
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
        if (!input.universeSelector) {
          return refusedWithPlan('work_cardinality_mismatch', 'each/set cardinality requires an immutable argument selector');
        }
        if (operation.cardinality.kind === 'each' && !input.universeItemId) {
          return refusedWithPlan('work_cardinality_mismatch', 'each cardinality requires universe_item_id');
        }
        if (operation.cardinality.kind === 'set' && input.universeItemId != null) {
          return refusedWithPlan('work_cardinality_mismatch', 'set cardinality binds the full set, not one item');
        }
        const selected = selectedMemberIds(evidenceArgs, input.universeSelector, operation.cardinality.kind);
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
          if (!witness.ok) return refusedWithPlan('work_source_witness_missing', witness.reason);
          inputSourceKind = witness.kind;
          inputSourceRef = witness.ref;
          inputSourceDigest = witness.digest;
        }
        selectorJson = canonicalExpectedWorkJson(input.universeSelector);
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
        evidenceBasis = refinement.basis;
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

      const generatedSheetContract = generatedSheetContentContractForAdmission({
        contract,
        operation,
        tool: input.tool,
        args: input.args,
      });
      if (generatedSheetContract && !generatedSheetContract.ok) {
        return refusedWithPlan('work_source_witness_missing', generatedSheetContract.reason);
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
      if (generatedSheetContract?.ok) {
        const frozenJson = JSON.stringify(generatedSheetContract.contentContract);
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
        ...(generatedSheetContract?.ok
          ? { generatedArtifactContentContract: generatedSheetContract.contentContract }
          : {}),
      };
      return { status: 'bound', binding, contract };
    });
    return tx.immediate();
  } catch (error) {
    return refusedWithPlan('work_authority_unavailable', boundedReason(error));
  }
}
