import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  listEvents,
  openEventLog,
  type EventRow,
} from './eventlog.js';
import { hostControlFrameFor } from '../../tools/tool-registry.js';
import {
  HOST_TOOL_DISPOSITION_PROTOCOL,
} from './host-model-result-receipt.js';
import type {
  AuthorityProgressKind,
  AuthorityProgressSnapshot,
  NoProgressConsequence,
  NoProgressAttemptClass,
} from './no-progress-governor.js';
import { NO_PROGRESS_RECOVERY_TOOL_NAME_CAP, createNoProgressConsequence } from './no-progress-governor.js';
import { parseExactPlanTaskRefusal } from './plan-task-result-contract.js';
import { WORK_ID_PATTERN } from '../../shared/work-id.js';

/**
 * Exact, same-source projection for the pure no-progress reducer.
 *
 * Raw operation/account/target ids never leave this module: every token is a
 * domain-separated digest of a host-owned durable row. Model prose, query
 * text, physical call ids, provider names, and returned payload bytes are not
 * inputs and therefore cannot reset the governor.
 */

export type HostNoProgressProjection =
  | { status: 'ok'; authority: AuthorityProgressSnapshot }
  | { status: 'unavailable'; reason: string };

export type HostNoProgressAttemptProjection =
  | { status: 'none' }
  | {
      status: 'ok';
      attemptClass: NoProgressAttemptClass;
      consequence?: NoProgressConsequence;
    }
  | { status: 'unavailable'; reason: string };

interface HostNoProgressIdentity {
  sessionId: string;
  sourceUserSeq: number;
}

type UnknownRow = Record<string, unknown>;

function validIdentity(input: HostNoProgressIdentity): HostNoProgressIdentity {
  const sessionId = input.sessionId.trim();
  if (!sessionId) throw new Error('Host no-progress projection requires a session id.');
  if (!Number.isSafeInteger(input.sourceUserSeq) || input.sourceUserSeq <= 0) {
    throw new Error('Host no-progress projection requires an accepted source sequence.');
  }
  return { sessionId, sourceUserSeq: input.sourceUserSeq };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function record(value: unknown): UnknownRow | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRow
    : null;
}

const PLAN_REPAIR_CAPABILITY_ID = WORK_ID_PATTERN;
const PLAN_REPAIR_WRITE_EFFECTS = new Set(['local_write', 'external_write', 'admin']);

function exactRecordKeys(value: UnknownRow, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length
    && keys.every((key, index) => key === wanted[index]);
}

function exactAdvertisedWriteRepairs(value: unknown): readonly UnknownRow[] | null {
  if (!Array.isArray(value) || value.length > 8) return null;
  const repairs: UnknownRow[] = [];
  for (const candidate of value) {
    const row = record(candidate);
    if (
      !row
      || !exactRecordKeys(row, ['capabilityRef', 'effect', 'purpose'])
      || typeof row.capabilityRef !== 'string'
      || !PLAN_REPAIR_CAPABILITY_ID.test(row.capabilityRef)
      || typeof row.effect !== 'string'
      || !PLAN_REPAIR_WRITE_EFFECTS.has(row.effect)
      || typeof row.purpose !== 'string'
      || !row.purpose.trim()
      || row.purpose !== row.purpose.trim()
      || Buffer.byteLength(row.purpose, 'utf8') > 1_000
    ) return null;
    repairs.push(row);
  }
  return new Set(repairs.map((row) => row.capabilityRef)).size === repairs.length
    ? repairs
    : null;
}

function token(kind: AuthorityProgressKind, owner: string, parts: readonly unknown[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ version: 1, kind, owner, parts }), 'utf8')
    .digest('hex');
}

function exactSourceEvents(identity: HostNoProgressIdentity): EventRow[] {
  return listEvents(identity.sessionId, {
    sinceSeq: identity.sourceUserSeq - 1,
    types: [
      'capability_resolution',
      'capability_discovered',
      'discovery_governor_decision',
      'discovery_governor_outcome',
      'planning_catalog_disclosed',
      'expected_work_progress',
    ],
  }).filter((event) => event.data.sourceUserSeq === identity.sourceUserSeq);
}

function emptySets(): Record<AuthorityProgressKind, Set<string>> {
  return {
    operation: new Set(),
    account: new Set(),
    target: new Set(),
    evidence: new Set(),
    effect: new Set(),
  };
}

function sortedSnapshot(
  tokens: Record<AuthorityProgressKind, Set<string>>,
): AuthorityProgressSnapshot {
  return Object.freeze({
    operation: Object.freeze([...tokens.operation].sort()),
    account: Object.freeze([...tokens.account].sort()),
    target: Object.freeze([...tokens.target].sort()),
    evidence: Object.freeze([...tokens.evidence].sort()),
    effect: Object.freeze([...tokens.effect].sort()),
  });
}

/** Distinct exact write refs (most recently disclosed first) that may each
 * carry an effect-authority token. Prior authority is cumulative inside the
 * governor, so this bounds the snapshot, never the memory of what was seen. */
const MAX_DISCLOSED_WRITE_REF_TOKENS = 8;

function eventCapabilityTokens(
  events: readonly EventRow[],
  tokens: Record<AuthorityProgressKind, Set<string>>,
): void {
  const disclosedWriteRefs: string[] = [];
  for (const event of events) {
    if (event.type === 'capability_resolution') {
      // Resolution entries are candidate alternatives, even when their
      // accepted-source provenance is authoritative. The task-needed durable
      // call binding below is the first point at which one operation/account
      // becomes selected authority. New resolver alternatives therefore
      // cannot reset a spent no-progress budget.
      continue;
    }

    if (event.type === 'capability_discovered') {
      const capabilities = Array.isArray(event.data.capabilities)
        ? event.data.capabilities
        : [];
      const citable = capabilities.some((candidate) => (
        nonEmptyString(record(candidate)?.capabilityRef) !== null
      ));
      // Pre-graph catalog growth is ONE transition: no citable operation was
      // available, then at least one was. New refs from different queries are
      // still alternatives for the same open planning problem and must not buy
      // another retry. Exact selected node identity joins only through the
      // accepted work contract/binding rows below.
      if (citable) {
        tokens.operation.add(token('operation', 'citable_discovery_available', ['available']));
      }
      // A typed missing-write refusal exposes tool_search so the model can
      // find the exact write the draft lacks. The first same-source write is
      // a new effect authority class (one bounded token), and EACH distinct
      // exact write ref is its own gain as well. Live 2026-09-01: the first
      // broad search of a turn disclosed three unrelated writes and spent the
      // class token; when the refusal's prescribed search later disclosed the
      // exact write it asked for, that disclosure counted as nothing and the
      // spent retry terminalized a converging turn. Re-disclosing a ref the
      // governor already holds is still no gain (its authority is cumulative),
      // and query wording, siblings, and schema churn never enter the token.
      const writeRefs = capabilities.flatMap((candidate) => {
        const row = record(candidate);
        const capabilityRef = nonEmptyString(row?.capabilityRef);
        return capabilityRef !== null && row?.effectClass === 'write' ? [capabilityRef] : [];
      });
      if (writeRefs.length > 0) {
        tokens.effect.add(token('effect', 'citable_discovery_effect', ['write']));
        disclosedWriteRefs.push(...writeRefs);
      }
      continue;
    }

    if (event.type === 'planning_catalog_disclosed') {
      const capabilities = Array.isArray(event.data.capabilities)
        ? event.data.capabilities
        : [];
      if (capabilities.some((candidate) => nonEmptyString(record(candidate)?.id) !== null)) {
        tokens.operation.add(token('operation', 'planning_catalog_available', ['available']));
      }
      continue;
    }

    if (event.type === 'expected_work_progress') {
      const lines = Array.isArray(event.data.lines) ? event.data.lines : [];
      for (const candidate of lines) {
        const line = record(candidate);
        const id = nonEmptyString(line?.id);
        if (!line || !id) continue;
        // State transitions are real graph progress. An unchanged re-render is
        // the same token and cannot reset the reducer.
        tokens.operation.add(token('operation', 'expected_work_progress', [
          id,
          nonEmptyString(line.effect) ?? '',
          nonEmptyString(line.state) ?? '',
          line.settled === true,
          line.observed === true,
        ]));
      }
      continue;
    }
  }
  const recentWriteRefs = [...new Set(disclosedWriteRefs.reverse())]
    .slice(0, MAX_DISCLOSED_WRITE_REF_TOKENS);
  for (const capabilityRef of recentWriteRefs) {
    tokens.effect.add(token('effect', 'citable_write_ref', [capabilityRef]));
  }
}

/**
 * One accepted task may need a small sequence of pre-plan capability
 * discoveries (for example create -> update -> readback).  Catalog breadth is
 * not progress: only the FIRST host-ranked, citable capability in a settled
 * role-bound tool_search result can name a stage.  The stage identity is the
 * exact host-issued capability ref plus its structural effect; query text,
 * result prose, call ids, schema churn, and lower-ranked siblings are absent.
 *
 * Three is deliberately an absolute ceiling rather than a budget per role.
 * It is enough for the common create/update/verify planning sequence while a
 * model that walks arbitrary catalog candidates cannot keep resetting the
 * no-progress reducer.  Set projection also makes A -> B -> A a no-gain cycle.
 */
const MAX_ROLE_BOUND_DISCOVERY_STAGES = 3;

const DISCOVERY_STAGE_EFFECTS = new Set([
  'admin',
  'compute',
  'external_write',
  'host_only',
  'local_write',
  'read',
]);

function durableRoleBoundDiscoveryStageTokens(
  db: Database.Database,
  identity: HostNoProgressIdentity,
  events: readonly EventRow[],
  tokens: Record<AuthorityProgressKind, Set<string>>,
): void {
  const roleKeys = new Set(rows<{ role_key: string }>(db, `
    SELECT role_key
      FROM discovery_governor_roles
     WHERE session_id = ? AND source_user_seq = ?
  `, [identity.sessionId, identity.sourceUserSeq]).map((row) => row.role_key));
  if (roleKeys.size === 0) return;

  // A citable result is still not authority unless its exact ref/effect came
  // from the host's same-source capability disclosure. Ambiguous ref/effect
  // pairs fail closed instead of letting event ordering choose one.
  const capabilityEffects = new Map<string, string | null>();
  for (const event of events) {
    if (event.type !== 'capability_discovered') continue;
    const capabilities = Array.isArray(event.data.capabilities)
      ? event.data.capabilities
      : [];
    for (const value of capabilities) {
      const candidate = record(value);
      const capabilityRef = nonEmptyString(candidate?.capabilityRef);
      const descriptor = record(candidate?.descriptor);
      const descriptorId = nonEmptyString(descriptor?.id);
      const effect = nonEmptyString(descriptor?.effect);
      if (
        !capabilityRef
        || descriptorId !== capabilityRef
        || !effect
        || !DISCOVERY_STAGE_EFFECTS.has(effect)
      ) continue;
      const existing = capabilityEffects.get(capabilityRef);
      capabilityEffects.set(
        capabilityRef,
        existing === undefined || existing === effect ? effect : null,
      );
    }
  }
  if (capabilityEffects.size === 0) return;

  const succeededCallSeqById = new Map<string, number>();
  for (const event of events) {
    if (event.type !== 'discovery_governor_outcome' || event.data.outcome !== 'succeeded') continue;
    const callId = nonEmptyString(event.data.callId);
    if (callId && !succeededCallSeqById.has(callId)) {
      succeededCallSeqById.set(callId, event.seq);
    }
  }
  const decisions = events.flatMap((event) => {
    if (event.type !== 'discovery_governor_decision') return [];
    const callId = nonEmptyString(event.data.callId);
    const subject = nonEmptyString(event.data.subject);
    const settledAt = callId ? succeededCallSeqById.get(callId) : undefined;
    return callId
      && subject
      && event.data.category === 'broad_discovery'
      && event.data.decision === 'admitted'
      && roleKeys.has(subject)
      && settledAt !== undefined
      && settledAt > event.seq
      ? [{ callId, subject }]
      : [];
  });
  if (decisions.length === 0) return;
  const callIds = [...new Set(decisions.map((decision) => decision.callId))];
  const placeholders = callIds.map(() => '?').join(', ');
  const outputs = new Map(rows<{
    call_id: string;
    tool: string | null;
    output_full: string;
  }>(db, `
    SELECT call_id, tool, output_full
      FROM tool_outputs
     WHERE session_id = ? AND call_id IN (${placeholders})
  `, [identity.sessionId, ...callIds]).map((row) => [row.call_id, row] as const));

  const seenStages = new Set<string>();
  for (const decision of decisions) {
    if (seenStages.size >= MAX_ROLE_BOUND_DISCOVERY_STAGES) break;
    const output = outputs.get(decision.callId);
    if (!output || output.tool?.split('__').at(-1)?.toLowerCase() !== 'tool_search') continue;
    if (Buffer.byteLength(output.output_full, 'utf8') > 64 * 1024) continue;
    let payload: UnknownRow | null = null;
    try { payload = record(JSON.parse(output.output_full)); } catch { /* malformed is inert */ }
    if (!payload || nonEmptyString(payload.role_key) !== decision.subject) continue;
    const ranked = Array.isArray(payload.results) ? record(payload.results[0]) : null;
    const capabilityRef = nonEmptyString(ranked?.capabilityRef);
    const effect = capabilityRef ? capabilityEffects.get(capabilityRef) : null;
    if (!capabilityRef || !effect) continue;
    const stage = token('operation', 'role_bound_discovery_stage', [
      decision.subject,
      capabilityRef,
      effect,
    ]);
    if (seenStages.has(stage)) continue;
    seenStages.add(stage);
    tokens.operation.add(stage);
  }
}

function rows<T extends UnknownRow>(
  db: Database.Database,
  sql: string,
  params: readonly unknown[],
): T[] {
  return db.prepare(sql).all(...params) as T[];
}

function durableAuthorityTokens(
  db: Database.Database,
  identity: HostNoProgressIdentity,
  tokens: Record<AuthorityProgressKind, Set<string>>,
): void {
  const params = [identity.sessionId, identity.sourceUserSeq] as const;

  for (const row of rows<{
    contract_id: string;
    graph_hash: string;
  }>(db, `
    SELECT contract_id, graph_hash
      FROM accepted_task_work_contracts
     WHERE session_id = ? AND source_user_seq = ?
  `, params)) {
    tokens.operation.add(token('operation', 'accepted_work_contract', [
      row.contract_id,
      row.graph_hash,
    ]));
  }

  for (const row of rows<{
    capability_id: string;
    operation_id: string;
    schema_fingerprint: string;
    account_id: string;
  }>(db, `
    SELECT host.capability_id, host.operation_id,
           host.schema_fingerprint, host.account_id
      FROM host_call_capability_bindings host
      JOIN expected_work_call_bindings work
        ON work.session_id = host.session_id
       AND work.source_user_seq = host.source_user_seq
       AND work.logical_tool_call_id = host.logical_tool_call_id
     WHERE host.session_id = ? AND host.source_user_seq = ?
  `, params)) {
    // Logical call id and argument digest are deliberately absent: retries or
    // pagination over one selected accepted node remain one operation fact.
    tokens.operation.add(token('operation', 'expected_work_capability_binding', [
      row.capability_id,
      row.operation_id,
      row.schema_fingerprint,
    ]));
    if (row.account_id) tokens.account.add(token('account', 'expected_work_capability_binding', [
      row.account_id,
    ]));
  }

  for (const row of rows<{
    progress_key_digest: string | null;
    progress_claimed: number;
  }>(db, `
    SELECT progress_key_digest, progress_claimed
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ?
  `, params)) {
    if (row.progress_claimed === 1 && row.progress_key_digest) {
      tokens.evidence.add(token('evidence', 'logical_progress_claim', [row.progress_key_digest]));
    }
  }

  for (const row of rows<{
    manifest_id: string;
    node_id: string;
    obligation: string;
  }>(db, `
    SELECT manifest_id, node_id, obligation FROM evidence_receipts
     WHERE session_id = ? AND source_user_seq = ?
  `, params)) {
    tokens.evidence.add(token('evidence', 'closed_read_obligation', [
      row.manifest_id,
      row.node_id,
      row.obligation,
    ]));
  }

  for (const row of rows<{
    requirement_id: string;
    target_digest: string;
  }>(db, `
    SELECT requirement_id, target_digest FROM write_evidence_bindings
     WHERE session_id = ? AND source_user_seq = ?
  `, params)) {
    tokens.target.add(token('target', 'accepted_write_target', [
      row.requirement_id,
      row.target_digest,
    ]));
  }

  for (const row of rows<{
    manifest_id: string;
    node_id: string;
    obligation: string;
  }>(db, `
    SELECT manifest_id, node_id, obligation FROM write_evidence_proofs
     WHERE session_id = ? AND source_user_seq = ?
  `, params)) {
    tokens.effect.add(token('effect', 'closed_write_obligation', [
      row.manifest_id,
      row.node_id,
      row.obligation,
    ]));
  }
}

export function projectHostNoProgressAuthority(
  input: HostNoProgressIdentity,
  database: Database.Database = openEventLog(),
): HostNoProgressProjection {
  try {
    const identity = validIdentity(input);
    const tokens = emptySets();
    const events = exactSourceEvents(identity);
    eventCapabilityTokens(events, tokens);
    durableAuthorityTokens(database, identity, tokens);
    durableRoleBoundDiscoveryStageTokens(database, identity, events, tokens);
    return { status: 'ok', authority: sortedSnapshot(tokens) };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function functionResultText(item: unknown): string | null {
  const candidate = record(item);
  if (candidate?.type !== 'function_call_result') return null;
  const output = candidate.output;
  if (typeof output === 'string') return output;
  const objectOutput = record(output);
  if (typeof objectOutput?.text === 'string') return objectOutput.text;
  if (!Array.isArray(output)) return null;
  for (const part of output) {
    const value = record(part);
    if (typeof value?.text === 'string') return value.text;
  }
  return null;
}

/** Host-authored repair keys are hex digests (or a bounded prefix of one);
 * anything else on the marker is ignored, never a stage input. */
const REPAIR_KEY_RE = /^[a-f0-9]{16,64}$/;

interface RefusedPreDispatchMarker {
  repairKey?: string;
}

/** Read the exact host disposition marker for a pre-dispatch refusal. Only
 * protocol, disposition, and the host-authored `repairKey` participate; the
 * free-text diagnostic is never an input. */
function refusedPreDispatchMarker(item: unknown): RefusedPreDispatchMarker | null {
  const text = functionResultText(item);
  if (!text) return null;
  try {
    const parsed = record(JSON.parse(text));
    if (
      parsed?.protocol !== HOST_TOOL_DISPOSITION_PROTOCOL
      || parsed.disposition !== 'refused_pre_dispatch'
    ) return null;
    return typeof parsed.repairKey === 'string' && REPAIR_KEY_RE.test(parsed.repairKey)
      ? { repairKey: parsed.repairKey }
      : {};
  } catch {
    return null;
  }
}

function refusedPreDispatch(item: unknown): boolean {
  return refusedPreDispatchMarker(item) !== null;
}

function refusedPreDispatchMarkersByCallId(
  history: readonly unknown[],
): Map<string, RefusedPreDispatchMarker> {
  const markers = new Map<string, RefusedPreDispatchMarker>();
  for (const item of history) {
    const marker = refusedPreDispatchMarker(item);
    if (!marker) continue;
    const callId = nonEmptyString(record(item)?.callId);
    if (callId) markers.set(callId, marker);
  }
  return markers;
}

/**
 * Stage for a pre-dispatch schema refusal keyed on the host-authored repair
 * material. A NEW failing-path set is a new stage (bounded structural
 * progress for the governor); a byte-identical repeat re-enters the seen key.
 * Bounded: at most 8 distinct 16-char prefixes joined with '.' (< 192 chars
 * and inside the governor's stage-token alphabet `[A-Za-z0-9:._/-]`).
 */
function schemaInvalidStage(repairKeys: readonly string[]): string {
  const prefixes = [...new Set(repairKeys.map((key) => key.slice(0, 16)))].sort().slice(0, 8);
  return `schema_invalid:${prefixes.join('.')}`;
}

interface HistoryCall {
  callId: string;
  name: string;
}

function historyCalls(history: readonly unknown[]): HistoryCall[] {
  return history.flatMap((item) => {
    const row = record(item);
    if (row?.type !== 'function_call') return [];
    const callId = nonEmptyString(row.callId);
    const name = nonEmptyString(row.name);
    return callId && name ? [{ callId, name }] : [];
  });
}

function historyResultCallIds(history: readonly unknown[]): Set<string> {
  return new Set(history.flatMap((item) => {
    const row = record(item);
    if (row?.type !== 'function_call_result') return [];
    const callId = nonEmptyString(row.callId);
    return callId ? [callId] : [];
  }));
}

function historyResultTextByCallId(history: readonly unknown[]): Map<string, string> {
  const results = new Map<string, string>();
  for (const item of history) {
    const row = record(item);
    const callId = row?.type === 'function_call_result'
      ? nonEmptyString(row.callId)
      : null;
    const text = callId ? functionResultText(item) : null;
    if (callId && text !== null) results.set(callId, text);
  }
  return results;
}

interface NoProgressSettlementRow extends UnknownRow {
  logical_tool_call_id: string;
  observer_call_id: string | null;
  execution_kind: string;
  outcome_kind: string;
  recovery_action: string;
  business_call: number;
  mutating: number;
  requires_reconciliation: number;
  physical_crossing_count: number;
  host_crossing_count: number | null;
  /** Bounded host-owned outcome detail; `validation:<hex>` carries the
   * repair key for a schema refusal settled on the preparation path. */
  outcome_detail: string | null;
}

function callForSettlement(
  row: NoProgressSettlementRow,
  calls: readonly HistoryCall[],
): HistoryCall | null {
  return calls.find((call) => (
    call.callId === row.logical_tool_call_id
    || (row.observer_call_id !== null && call.callId === row.observer_call_id)
  )) ?? null;
}

function parsedResultRecord(text: string | undefined): UnknownRow | null {
  if (!text || Buffer.byteLength(text, 'utf8') > 64 * 1024) return null;
  try { return record(JSON.parse(text)); } catch { return null; }
}

const HOST_OWNED_PLAN_DETAIL_PREFIXES = new Set([
  'host_destination_identity_unavailable',
  'host_planning_catalog_unavailable',
  'host_capability_catalog_unavailable',
  'selected_definition_not_proven',
  'selected_definition_revalidation_refused',
  'selected_definition_exact_refresh_unavailable',
  'selected_definition_operation_version_unavailable',
]);

const SEMANTIC_PLAN_DETAIL_PREFIXES = new Set([
  'write_not_aligned',
  'read_not_aligned',
  'effect_not_aligned',
  'capability_not_disclosed',
  'missing_requirement',
  'invalid_dependency',
]);

function stablePlanDetailPrefix(value: unknown): string {
  if (typeof value !== 'string') return 'other';
  const candidate = value.trim().split(':', 1)[0] ?? '';
  if (HOST_OWNED_PLAN_DETAIL_PREFIXES.has(candidate)
    || SEMANTIC_PLAN_DETAIL_PREFIXES.has(candidate)) return candidate;
  return 'other';
}

function exactUserInput(value: UnknownRow): {
  question: string;
  choices: readonly string[];
  purpose: 'clarification';
} | null {
  if (value.code !== 'account_selection_required' && value.code !== 'input_required') return null;
  const question = nonEmptyString(value.question);
  const rawChoices = Array.isArray(value.accountChoices)
    ? value.accountChoices
    : Array.isArray(value.choices)
      ? value.choices
      : null;
  if (!question || question.length > 500 || !rawChoices || rawChoices.length > 5) return null;
  const choices = [...new Set(rawChoices.flatMap((choice) => {
    const normalized = nonEmptyString(choice);
    return normalized && normalized.length <= 256 ? [normalized] : [];
  }))];
  if (choices.length !== rawChoices.length) return null;
  return { question, choices: Object.freeze(choices), purpose: 'clarification' };
}

function controlConsequence(input: {
  call: HistoryCall;
  settlement: NoProgressSettlementRow;
  resultText?: string;
}): NoProgressConsequence | null {
  if (hostControlFrameFor(input.call.name) === null) return null;
  const hostExecuted = input.settlement.execution_kind === 'local_execution'
    && input.settlement.physical_crossing_count === 0
    && (input.settlement.host_crossing_count ?? 0) === 1;
  const refusedBeforeBody = input.settlement.execution_kind === 'refused_pre_dispatch'
    && input.settlement.physical_crossing_count === 0
    && (input.settlement.host_crossing_count ?? 0) === 0;
  if (
    input.settlement.mutating !== 0
    || input.settlement.requires_reconciliation !== 0
    || (!hostExecuted && !refusedBeforeBody)
  ) return null;
  const payload = parsedResultRecord(input.resultText);
  if (!payload || payload.ok !== false) return null;
  const planRefusal = input.call.name === 'plan_task'
    ? parseExactPlanTaskRefusal(payload)
    : null;
  // plan_task control routing consumes the same exact closed union as durable
  // settlement. Raw JSON code/prose is never independent recovery authority.
  if (input.call.name === 'plan_task' && !planRefusal) return null;
  if (
    input.settlement.outcome_kind === 'input_required'
    && input.settlement.recovery_action === 'ask_user'
    && input.settlement.physical_crossing_count === 0
  ) {
    const userInput = exactUserInput(payload);
    if (userInput) return createNoProgressConsequence({
      stage: payload.code === 'account_selection_required'
        ? 'input_required:account_selection'
        : 'input_required:exact_choice',
      recovery: 'ask_user',
      effectState: 'not_started',
      recoveryToolNames: [],
      userInput,
    });
  }
  if (payload.code === 'plan_invalid_input') {
    // Keyed on the host-authored digest of the violated paths when present:
    // a draft that repaired one complaint and met a different one is a new
    // stage (progress), an identical complaint is the same stage (the loop
    // floor). Legacy payloads without a key keep the flat stage.
    const planRepairKey = typeof payload.repairKey === 'string' && REPAIR_KEY_RE.test(payload.repairKey)
      ? payload.repairKey
      : null;
    return createNoProgressConsequence({
      stage: planRepairKey ? schemaInvalidStage([planRepairKey]) : 'schema_invalid',
      recovery: 'repair_model',
      effectState: 'not_started',
      recoveryToolNames: [input.call.name],
    });
  }
  if (
    payload.code === 'plan_incomplete_missing_write'
    || payload.code === 'plan_incomplete_data_lineage'
  ) {
    const advertisedWriteRepairs = payload.code === 'plan_incomplete_missing_write'
      ? exactAdvertisedWriteRepairs(payload.admissibleCapabilities)
      : null;
    return createNoProgressConsequence({
      // Missing a write and missing its payload edge are distinct, finite plan
      // repairs. Keeping them distinct lets the model advance through both in
      // one turn without prose, arguments, or call ids minting new stages.
      stage: payload.code === 'plan_incomplete_missing_write'
        ? 'plan_incomplete:missing_write'
        : 'plan_incomplete:data_lineage',
      recovery: 'repair_model',
      effectState: 'not_started',
      // A current card write makes this a plan-only repair. When the exact
      // closed refusal says the bounded card has no write at all, one search
      // is the only operation that can create a new plan path. Old durable
      // payloads did not carry this field and retain their historical
      // plan_task-only recovery semantics.
      recoveryToolNames: planRefusal?.recoveryTool === 'tool_search'
        ? ['tool_search']
        : planRefusal?.recoveryTool === 'plan_task'
          ? ['plan_task']
          : payload.code === 'plan_incomplete_missing_write'
            && advertisedWriteRepairs?.length === 0
            ? ['tool_search']
            : [input.call.name],
    });
  }
  if (payload.code === 'plan_not_admitted') {
    const prefix = planRefusal?.structural && typeof payload.reasonCode === 'string'
      ? payload.reasonCode
      : stablePlanDetailPrefix(payload.detail);
    const recoveryTool = planRefusal?.recoveryTool;
    return createNoProgressConsequence({
      stage: `semantic_admission:${prefix}`,
      recovery: recoveryTool === 'stop_factual'
        ? 'stop_factual'
        : recoveryTool === 'retry_host'
          || (hostExecuted && HOST_OWNED_PLAN_DETAIL_PREFIXES.has(prefix))
          ? 'retry_host'
          : 'repair_model',
      effectState: recoveryTool === 'stop_factual' ? 'known_terminal' : 'not_started',
      recoveryToolNames: recoveryTool === 'stop_factual'
        ? []
        : recoveryTool === 'tool_search'
          ? ['tool_search']
          : ['plan_task'],
    });
  }
  if (payload.code === 'plan_not_required') {
    const uniqueWorkflow = typeof payload.workflowName === 'string' && payload.workflowName.trim();
    const recoveryTool = planRefusal?.recoveryTool
      ?? (uniqueWorkflow ? 'workflow_run' : null);
    if (recoveryTool !== 'call_tool' && recoveryTool !== 'workflow_run') return null;
    return createNoProgressConsequence({
      stage: recoveryTool === 'workflow_run'
        ? 'plan_not_required:unique_workflow'
        : 'plan_not_required:graph_neutral',
      recovery: 'repair_model',
      effectState: 'not_started',
      recoveryToolNames: [recoveryTool],
    });
  }
  if (payload.code === 'verification_successor_required') {
    const recoveryTool = planRefusal?.recoveryTool;
    if (recoveryTool === 'stop_factual') {
      return createNoProgressConsequence({
        stage: 'plan_binding:verification_successor_required',
        recovery: 'stop_factual',
        effectState: 'known_terminal',
        recoveryToolNames: [],
      });
    }
    if (recoveryTool !== 'plan_task' && recoveryTool !== 'tool_search') return null;
    return createNoProgressConsequence({
      stage: 'plan_binding:verification_successor_required',
      recovery: 'repair_model',
      effectState: 'not_started',
      recoveryToolNames: [recoveryTool],
    });
  }
  if (payload.code === 'plan_binding_not_sealed') {
    if (planRefusal?.recoveryTool !== 'stop_factual') return null;
    return createNoProgressConsequence({
      stage: 'plan_binding:not_sealed',
      recovery: 'stop_factual',
      effectState: 'known_terminal',
      recoveryToolNames: [],
    });
  }
  return null;
}

function settlementConsequence(input: {
  call: HistoryCall;
  settlement: NoProgressSettlementRow;
}): NoProgressConsequence | null {
  const { call, settlement } = input;
  if (
    settlement.requires_reconciliation === 1
    || settlement.outcome_kind === 'uncertain_write'
    || (
      settlement.mutating === 1
      && settlement.physical_crossing_count > 0
      && settlement.outcome_kind === 'unknown'
    )
  ) {
    return createNoProgressConsequence({
      stage: 'execution:effect_unknown',
      recovery: 'reconcile',
      effectState: 'unknown',
      recoveryToolNames: [],
    });
  }
  const notStarted = settlement.execution_kind === 'refused_pre_dispatch'
    && settlement.physical_crossing_count === 0
    && (settlement.host_crossing_count ?? 0) === 0;
  const effectState = notStarted ? 'not_started' : 'known_terminal';
  switch (settlement.outcome_kind) {
    case 'invalid_arguments': {
      // A host-authored repair key in the bounded outcome detail keys the
      // stage on the failing-path set; without one the stage is unchanged.
      const repairKey = /^validation:([a-f0-9]{16,64})$/.exec(settlement.outcome_detail ?? '')?.[1];
      return createNoProgressConsequence({
        stage: repairKey ? schemaInvalidStage([repairKey]) : 'schema_invalid',
        recovery: 'repair_model',
        effectState,
        recoveryToolNames: [call.name],
      });
    }
    case 'transient':
      return createNoProgressConsequence({
        stage: 'execution:transient',
        recovery: 'repair_model',
        effectState,
        recoveryToolNames: [call.name],
      });
    case 'unsupported_capability':
      return createNoProgressConsequence({
        stage: `execution:${settlement.outcome_kind}`,
        recovery: 'repair_model',
        effectState,
        // The immutable candidate is no longer suitable. Repeating its carrier
        // cannot repair that fact; one bounded current-source search can.
        recoveryToolNames: ['tool_search'],
      });
    case 'ignored_requirement':
    case 'empty_result':
      return createNoProgressConsequence({
        stage: `execution:${settlement.outcome_kind}`,
        recovery: 'repair_model',
        effectState,
        recoveryToolNames: [call.name],
      });
    case 'auth_failure':
    case 'policy_denial':
    case 'input_required':
    case 'unknown':
      return createNoProgressConsequence({
        stage: `execution:${settlement.outcome_kind}`,
        recovery: 'stop_factual',
        effectState,
        recoveryToolNames: [],
      });
    default:
      return null;
  }
}

/**
 * Classify one already-committed history delta by durable topology/effect
 * facts. Tool/provider vocabulary and argument text are deliberately ignored.
 */
export function projectHostNoProgressAttempt(input: HostNoProgressIdentity & {
  historyDelta: readonly unknown[];
}, database: Database.Database = openEventLog()): HostNoProgressAttemptProjection {
  try {
    const identity = validIdentity(input);
    const calls = historyCalls(input.historyDelta);
    const resultCallIds = historyResultCallIds(input.historyDelta);
    if (
      calls.length === 0
      || calls.some((call) => !resultCallIds.has(call.callId))
    ) return { status: 'none' };
    const resultTextByCallId = historyResultTextByCallId(input.historyDelta);

    const settlements = rows<NoProgressSettlementRow>(database, `
      SELECT logical_tool_call_id, observer_call_id, execution_kind,
             outcome_kind, recovery_action, business_call, mutating,
             requires_reconciliation, physical_crossing_count,
             COALESCE(host_crossing_count, 0) AS host_crossing_count,
             outcome_detail
        FROM logical_call_settlements
       WHERE session_id = ? AND source_user_seq = ?
    `, [identity.sessionId, identity.sourceUserSeq]);
    const matchedSettlements = settlements.flatMap((settlement) => {
      const matchedCall = callForSettlement(settlement, calls);
      return matchedCall ? [{ settlement, call: matchedCall }] : [];
    });

    const uncertain = matchedSettlements.find(({ settlement }) => (
      settlement.requires_reconciliation === 1
      || settlement.outcome_kind === 'uncertain_write'
      || (
        settlement.mutating === 1
        && settlement.physical_crossing_count > 0
        && settlement.outcome_kind === 'unknown'
      )
    ));
    if (uncertain) return {
      status: 'ok',
      attemptClass: 'zero_crossing_repair',
      consequence: settlementConsequence(uncertain)!,
    };

    const control = matchedSettlements.flatMap(({ call: matchedCall, settlement }) => {
      const consequence = controlConsequence({
        call: matchedCall,
        settlement,
        resultText: resultTextByCallId.get(matchedCall.callId),
      });
      return consequence ? [{ call: matchedCall, consequence }] : [];
    }).sort((left, right) => left.consequence.key.localeCompare(right.consequence.key))[0];
    if (control) return {
      status: 'ok',
      attemptClass: 'plan_admission',
      consequence: control.consequence,
    };

    const failed = matchedSettlements.flatMap(({ call: matchedCall, settlement }) => {
      const consequence = settlementConsequence({ call: matchedCall, settlement });
      return consequence ? [{ call: matchedCall, consequence }] : [];
    }).sort((left, right) => left.consequence.key.localeCompare(right.consequence.key))[0];
    if (failed) return {
      status: 'ok',
      attemptClass: 'zero_crossing_repair',
      consequence: failed.consequence,
    };

    if (matchedSettlements.some(({ settlement }) => (
      (settlement.business_call === 1 || settlement.mutating === 1)
      && (settlement.outcome_kind === 'succeeded' || settlement.outcome_kind === 'empty_result')
    ))) return { status: 'ok', attemptClass: 'task_work' };

    if (input.historyDelta.some(refusedPreDispatch)) {
      const refusedMarkers = refusedPreDispatchMarkersByCallId(input.historyDelta);
      const refusedCalls = calls.filter((call) => refusedMarkers.has(call.callId));
      const repairKeys = refusedCalls.map((call) => refusedMarkers.get(call.callId)?.repairKey);
      // Every refused call carrying a host-authored repair key means the
      // frame was refused for its argument shape; key the stage on that
      // material so a genuinely new repair registers as progress while the
      // recovery surface (the refused carriers only) is unchanged.
      const schemaKeyed = refusedCalls.length > 0
        && repairKeys.every((key): key is string => typeof key === 'string');
      // The recovery surface is the set of DISTINCT refused carriers, bounded
      // to the governor's cap. Live 2026-09-01: one frame carried nine refused
      // call_tool siblings; mapping every call (duplicates included) exceeded
      // the cap, the governor constructor threw, and a projection exception
      // became a blocked run after two successful reads. A repair surface is
      // never wider than the distinct names anyway.
      const refusedCarrierNames = [...new Set(refusedCalls.map((call) => call.name))]
        .slice(0, NO_PROGRESS_RECOVERY_TOOL_NAME_CAP);
      return {
        status: 'ok',
        attemptClass: 'zero_crossing_repair',
        consequence: createNoProgressConsequence({
          stage: schemaKeyed
            ? schemaInvalidStage(repairKeys as string[])
            : 'host_disposition:refused_pre_dispatch',
          recovery: 'repair_model',
          effectState: 'not_started',
          recoveryToolNames: refusedCarrierNames,
        }),
      };
    }

    const discovery = listEvents(identity.sessionId, {
      sinceSeq: identity.sourceUserSeq - 1,
      types: ['discovery_governor_decision'],
    }).some((event) => (
      event.data.sourceUserSeq === identity.sourceUserSeq
      && typeof event.data.callId === 'string'
      && calls.some((call) => call.callId === event.data.callId)
    ));
    if (discovery) return { status: 'ok', attemptClass: 'authority_acquisition' };

    if (calls.some((call) => hostControlFrameFor(call.name) !== null)) {
      return { status: 'ok', attemptClass: 'plan_admission' };
    }

    return { status: 'ok', attemptClass: 'dependency_lookup' };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
