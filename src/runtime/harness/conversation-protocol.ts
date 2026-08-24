import { createHash } from 'node:crypto';
import type { AgentInputItem } from '@openai/agents';

/**
 * Provider-neutral invariants for the canonical function-call transcript.
 *
 * This module deliberately has no provider, database, approval, or user-facing
 * policy dependencies. `inspectConversationProtocol` is an assertion-only
 * canary. The migration is a separate, evidence-requiring operation intended
 * for persisted legacy history before that history is projected to a model.
 */

export type ProtocolIssueCode =
  | 'unmatched_function_call'
  | 'conversation_advanced_with_open_call'
  | 'orphan_function_result'
  | 'duplicate_function_call_id'
  | 'duplicate_function_result'
  | 'function_result_identity_mismatch';

export interface ProtocolIssue {
  code: ProtocolIssueCode;
  callId?: string;
  index: number;
}

export interface ProtocolInspection {
  status: 'valid' | 'invalid';
  issues: ProtocolIssue[];
}

export type MigrationEvidence =
  | {
      kind: 'settled_result';
      result: AgentInputItem;
      resultBytesSha256: string;
    }
  | {
      kind: 'proven_no_crossing';
      executionKind: 'refused_pre_dispatch' | 'not_started';
      physicalDispatchCount: 0;
    }
  | {
      kind: 'physical_crossing_unreadable';
      physicalDispatchId: string;
      state: 'started' | 'timed_out' | 'unknown';
    }
  | {
      kind: 'pending_approval';
      approvalId: string;
    }
  | {
      kind: 'ambiguous';
      reason: 'reused_call_id' | 'orphan_result';
    };

export interface ConversationMigration {
  disposition: 'ready' | 'pending_approval' | 'reconciliation_required';
  migration:
    | 'none'
    | 'paired_exact_result'
    | 'paired_refused_pre_dispatch'
    | 'paired_not_started'
    | 'paired_effect_unknown'
    | 'quarantined';
  history: AgentInputItem[];
  providerHistory: AgentInputItem[] | null;
  quarantine?: {
    originalItems: AgentInputItem[];
    issues: ProtocolIssueCode[];
  };
}

export type ConversationProtocolMigrationErrorCode =
  | 'invalid_history_without_exact_quarantine_evidence'
  | 'missing_call_evidence'
  | 'invalid_evidence'
  | 'settled_result_hash_mismatch'
  | 'settled_result_identity_mismatch';

/** Internal integrity failure. It is not a conversational blocking response. */
export class ConversationProtocolMigrationError extends Error {
  constructor(
    readonly code: ConversationProtocolMigrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ConversationProtocolMigrationError';
  }
}

type ItemRecord = Record<string, unknown>;

interface CallRecord {
  callId: string;
  index: number;
  item: AgentInputItem;
  name: string;
  namespace?: string;
  resultIndex?: number;
}

interface ProtocolAnalysis {
  inspection: ProtocolInspection;
  calls: Map<string, CallRecord>;
}

const ISSUE_ORDER: Readonly<Record<ProtocolIssueCode, number>> = Object.freeze({
  unmatched_function_call: 0,
  conversation_advanced_with_open_call: 1,
  orphan_function_result: 2,
  duplicate_function_call_id: 3,
  duplicate_function_result: 4,
  function_result_identity_mismatch: 5,
});

export const CONVERSATION_PROTOCOL_SYNTHETIC_RESULT =
  'clementine.conversation_protocol_result.v1' as const;

function itemRecord(item: AgentInputItem): ItemRecord {
  return item as unknown as ItemRecord;
}

function itemType(item: AgentInputItem): string | undefined {
  const type = itemRecord(item).type;
  return typeof type === 'string' ? type : undefined;
}

function itemCallId(item: AgentInputItem): string | undefined {
  const callId = itemRecord(item).callId;
  return typeof callId === 'string' && callId.length > 0 ? callId : undefined;
}

function itemName(item: AgentInputItem): string | undefined {
  const name = itemRecord(item).name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

function itemNamespace(item: AgentInputItem): string | undefined {
  const namespace = itemRecord(item).namespace;
  return typeof namespace === 'string' ? namespace : undefined;
}

/**
 * Reasoning and compaction records may appear anywhere inside a tool frame.
 * A role-bearing message advances the conversation and therefore cannot cross
 * an open function call. Other tool protocol items are not treated as prose.
 */
function advancesConversation(item: AgentInputItem): boolean {
  const role = itemRecord(item).role;
  return role === 'user' || role === 'assistant' || role === 'system';
}

function analyzeConversationProtocol(history: readonly AgentInputItem[]): ProtocolAnalysis {
  const issues: ProtocolIssue[] = [];
  const calls = new Map<string, CallRecord>();
  const openCalls = new Map<string, CallRecord>();
  const resultCount = new Map<string, number>();
  const advancedCallIds = new Set<string>();

  for (let index = 0; index < history.length; index += 1) {
    const item = history[index]!;
    const type = itemType(item);

    if (type === 'function_call') {
      const callId = itemCallId(item);
      const name = itemName(item);
      if (!callId || !name) {
        issues.push({ code: 'unmatched_function_call', ...(callId ? { callId } : {}), index });
        continue;
      }
      if (calls.has(callId)) {
        issues.push({ code: 'duplicate_function_call_id', callId, index });
        continue;
      }
      const call: CallRecord = {
        callId,
        index,
        item,
        name,
        ...(itemNamespace(item) !== undefined ? { namespace: itemNamespace(item) } : {}),
      };
      calls.set(callId, call);
      openCalls.set(callId, call);
      continue;
    }

    if (type === 'function_call_result') {
      const callId = itemCallId(item);
      if (!callId) {
        issues.push({ code: 'orphan_function_result', index });
        continue;
      }
      const priorResults = resultCount.get(callId) ?? 0;
      resultCount.set(callId, priorResults + 1);
      if (priorResults > 0) {
        issues.push({ code: 'duplicate_function_result', callId, index });
        continue;
      }
      const call = calls.get(callId);
      if (!call) {
        issues.push({ code: 'orphan_function_result', callId, index });
        continue;
      }
      call.resultIndex = index;
      openCalls.delete(callId);
      // Agents SDK result items historically omit name/namespace and rely on
      // callId for pairing. Absence is therefore not a contradiction; an
      // explicitly present value must agree with the originating call.
      const resultName = itemName(item);
      const resultNamespace = itemNamespace(item);
      if (
        (resultName !== undefined && resultName !== call.name)
        || (resultNamespace !== undefined && resultNamespace !== call.namespace)
      ) {
        issues.push({ code: 'function_result_identity_mismatch', callId, index });
      }
      continue;
    }

    if (advancesConversation(item)) {
      for (const call of openCalls.values()) {
        if (advancedCallIds.has(call.callId)) continue;
        issues.push({
          code: 'conversation_advanced_with_open_call',
          callId: call.callId,
          index,
        });
        advancedCallIds.add(call.callId);
      }
    }
  }

  for (const call of openCalls.values()) {
    issues.push({ code: 'unmatched_function_call', callId: call.callId, index: call.index });
  }

  issues.sort((left, right) => (
    left.index - right.index
    || ISSUE_ORDER[left.code] - ISSUE_ORDER[right.code]
    || (left.callId ?? '').localeCompare(right.callId ?? '')
  ));

  return {
    inspection: {
      status: issues.length === 0 ? 'valid' : 'invalid',
      issues,
    },
    calls,
  };
}

/**
 * Inspect canonical history without cloning, rewriting, repairing, or exposing
 * a provider projection. The returned value contains assertions only.
 */
export function inspectConversationProtocol(
  history: readonly AgentInputItem[],
): ProtocolInspection {
  return analyzeConversationProtocol(history).inspection;
}

/**
 * Hash contract for `settled_result` evidence.
 *
 * Persisted result evidence is bound to the exact JSON byte sequence produced
 * by `JSON.stringify(result)`. This intentionally follows the frozen migration
 * contract; key-sorting canonical JSON would produce different bytes and must
 * not be substituted at this boundary.
 */
export function conversationProtocolItemBytesSha256(value: AgentInputItem): string {
  let bytes: string | undefined;
  try {
    bytes = JSON.stringify(value);
  } catch (error) {
    throw new ConversationProtocolMigrationError(
      'invalid_evidence',
      `Settled result cannot be serialized as exact JSON bytes: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof bytes !== 'string') {
    throw new ConversationProtocolMigrationError(
      'invalid_evidence',
      'Settled result does not have an exact JSON byte representation.',
    );
  }
  return createHash('sha256').update(bytes).digest('hex');
}

function evidenceFor(
  evidenceByCallId: Readonly<Record<string, MigrationEvidence>>,
  callId: string,
): MigrationEvidence | undefined {
  return Object.prototype.hasOwnProperty.call(evidenceByCallId, callId)
    ? evidenceByCallId[callId]
    : undefined;
}

function earliestCallIndex(
  history: readonly AgentInputItem[],
  callId: string,
): number | undefined {
  for (let index = 0; index < history.length; index += 1) {
    const item = history[index]!;
    if (itemType(item) === 'function_call' && itemCallId(item) === callId) return index;
  }
  return undefined;
}

function uniqueIssueCodes(issues: readonly ProtocolIssue[]): ProtocolIssueCode[] {
  const seen = new Set<ProtocolIssueCode>();
  const codes: ProtocolIssueCode[] = [];
  for (const issue of issues) {
    if (seen.has(issue.code)) continue;
    seen.add(issue.code);
    codes.push(issue.code);
  }
  return codes;
}

function tryExactAmbiguityQuarantine(input: {
  history: readonly AgentInputItem[];
  evidenceByCallId: Readonly<Record<string, MigrationEvidence>>;
  inspection: ProtocolInspection;
}): ConversationMigration | null {
  const starts: number[] = [];

  for (const issue of input.inspection.issues) {
    if (!issue.callId) continue;
    const evidence = evidenceFor(input.evidenceByCallId, issue.callId);
    if (
      issue.code === 'duplicate_function_call_id'
      && evidence?.kind === 'ambiguous'
      && evidence.reason === 'reused_call_id'
    ) {
      const start = earliestCallIndex(input.history, issue.callId);
      if (start !== undefined) starts.push(start);
    } else if (
      issue.code === 'orphan_function_result'
      && evidence?.kind === 'ambiguous'
      && evidence.reason === 'orphan_result'
    ) {
      starts.push(issue.index);
    }
  }

  if (starts.length === 0) return null;
  const suffixStart = Math.min(...starts);
  const prefix = input.history.slice(0, suffixStart) as AgentInputItem[];
  if (inspectConversationProtocol(prefix).status !== 'valid') return null;

  const suffixIssues = input.inspection.issues.filter((issue) => {
    if (issue.index >= suffixStart) return true;
    if (!issue.callId) return false;
    const origin = earliestCallIndex(input.history, issue.callId);
    return origin !== undefined && origin >= suffixStart;
  });
  const originalItems = input.history.slice(suffixStart) as AgentInputItem[];
  return {
    disposition: 'ready',
    migration: 'quarantined',
    history: prefix,
    providerHistory: prefix.slice(),
    quarantine: {
      originalItems,
      issues: uniqueIssueCodes(suffixIssues),
    },
  };
}

function exactSettledResult(call: CallRecord, evidence: Extract<MigrationEvidence, {
  kind: 'settled_result';
}>): AgentInputItem {
  const actualHash = conversationProtocolItemBytesSha256(evidence.result);
  if (actualHash !== evidence.resultBytesSha256) {
    throw new ConversationProtocolMigrationError(
      'settled_result_hash_mismatch',
      `Settled result bytes for ${call.callId} do not match their durable SHA-256 evidence.`,
    );
  }

  const result = itemRecord(evidence.result);
  const identityMatches = result.type === 'function_call_result'
    && result.callId === call.callId
    && result.name === call.name
    && result.status === 'completed'
    && itemNamespace(evidence.result) === call.namespace;
  if (!identityMatches) {
    throw new ConversationProtocolMigrationError(
      'settled_result_identity_mismatch',
      `Settled result identity does not exactly match function call ${call.callId}.`,
    );
  }
  return evidence.result;
}

function syntheticResult(
  call: CallRecord,
  payload: Record<string, unknown>,
): AgentInputItem {
  return {
    type: 'function_call_result',
    callId: call.callId,
    name: call.name,
    ...(call.namespace !== undefined ? { namespace: call.namespace } : {}),
    output: {
      type: 'text',
      text: JSON.stringify({
        protocol: CONVERSATION_PROTOCOL_SYNTHETIC_RESULT,
        ...payload,
      }),
    },
    status: 'completed',
  } as AgentInputItem;
}

function resultText(item: AgentInputItem): string | undefined {
  const output = itemRecord(item).output;
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const text = (output as ItemRecord).text;
    return typeof text === 'string' ? text : undefined;
  }
  return undefined;
}

function syntheticResultDisposition(item: AgentInputItem): string | undefined {
  const text = resultText(item);
  if (!text) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return undefined;
  const payload = decoded as ItemRecord;
  return payload.protocol === CONVERSATION_PROTOCOL_SYNTHETIC_RESULT
    && typeof payload.disposition === 'string'
    ? payload.disposition
    : undefined;
}

function sameExactJsonBytes(left: AgentInputItem, right: AgentInputItem): boolean {
  return conversationProtocolItemBytesSha256(left) === conversationProtocolItemBytesSha256(right);
}

function migrateAlreadyPairedConversation(input: {
  history: readonly AgentInputItem[];
  evidenceByCallId: Readonly<Record<string, MigrationEvidence>>;
  calls: ReadonlyMap<string, CallRecord>;
}): ConversationMigration {
  const history = input.history.slice() as AgentInputItem[];
  let reconciledExactResult = false;
  let reconciliationRequired = false;

  for (const call of input.calls.values()) {
    if (call.resultIndex === undefined) continue;
    const existingResult = history[call.resultIndex]!;
    const existingDisposition = syntheticResultDisposition(existingResult);
    const evidence = evidenceFor(input.evidenceByCallId, call.callId);

    if (!evidence) {
      if (existingDisposition === 'effect_unknown') reconciliationRequired = true;
      continue;
    }

    if (evidence.kind === 'settled_result') {
      const exactResult = exactSettledResult(call, evidence);
      if (sameExactJsonBytes(existingResult, exactResult)) continue;
      if (existingDisposition !== 'effect_unknown') {
        throw new ConversationProtocolMigrationError(
          'settled_result_hash_mismatch',
          `Existing result bytes for ${call.callId} disagree with durable settled-result evidence.`,
        );
      }
      history[call.resultIndex] = exactResult;
      reconciledExactResult = true;
      continue;
    }

    if (evidence.kind === 'proven_no_crossing') {
      if (
        (evidence.executionKind !== 'refused_pre_dispatch'
          && evidence.executionKind !== 'not_started')
        || evidence.physicalDispatchCount !== 0
      ) {
        throw new ConversationProtocolMigrationError(
          'invalid_evidence',
          `Zero-crossing evidence for ${call.callId} is internally inconsistent.`,
        );
      }
      const expected = syntheticResult(call, {
        disposition: evidence.executionKind,
        effect: 'none',
        retry: 'replan',
      });
      if (!sameExactJsonBytes(existingResult, expected)) {
        throw new ConversationProtocolMigrationError(
          'invalid_evidence',
          `Existing result for ${call.callId} does not match its zero-crossing evidence.`,
        );
      }
      continue;
    }

    if (evidence.kind === 'physical_crossing_unreadable') {
      if (
        typeof evidence.physicalDispatchId !== 'string'
        || evidence.physicalDispatchId.length === 0
        || !['started', 'timed_out', 'unknown'].includes(evidence.state)
      ) {
        throw new ConversationProtocolMigrationError(
          'invalid_evidence',
          `Physical-crossing evidence for ${call.callId} is internally inconsistent.`,
        );
      }
      const expected = syntheticResult(call, {
        disposition: 'effect_unknown',
        effect: 'unknown',
        retry: 'do_not_retry',
        next: 'reconcile',
        physicalDispatchId: evidence.physicalDispatchId,
        physicalDispatchState: evidence.state,
      });
      if (!sameExactJsonBytes(existingResult, expected)) {
        throw new ConversationProtocolMigrationError(
          'invalid_evidence',
          `Existing result for ${call.callId} does not match its physical-crossing evidence.`,
        );
      }
      reconciliationRequired = true;
      continue;
    }

    throw new ConversationProtocolMigrationError(
      'invalid_evidence',
      `Paired function call ${call.callId} contradicts ${evidence.kind} evidence.`,
    );
  }

  return {
    disposition: reconciliationRequired ? 'reconciliation_required' : 'ready',
    migration: reconciledExactResult ? 'paired_exact_result' : 'none',
    history,
    providerHistory: reconciliationRequired ? null : history.slice(),
  };
}

function repairInsertionIndex(
  history: readonly AgentInputItem[],
  callIndex: number,
): number {
  for (let index = callIndex + 1; index < history.length; index += 1) {
    if (advancesConversation(history[index]!)) return index;
  }
  return history.length;
}

interface Repair {
  call: CallRecord;
  item: AgentInputItem;
  migration: Exclude<ConversationMigration['migration'], 'none' | 'quarantined'>;
}

function repairForEvidence(call: CallRecord, evidence: MigrationEvidence): Repair {
  if (evidence.kind === 'settled_result') {
    return {
      call,
      item: exactSettledResult(call, evidence),
      migration: 'paired_exact_result',
    };
  }
  if (evidence.kind === 'proven_no_crossing') {
    if (
      (evidence.executionKind !== 'refused_pre_dispatch'
        && evidence.executionKind !== 'not_started')
      || evidence.physicalDispatchCount !== 0
    ) {
      throw new ConversationProtocolMigrationError(
        'invalid_evidence',
        `Zero-crossing evidence for ${call.callId} is internally inconsistent.`,
      );
    }
    return {
      call,
      item: syntheticResult(call, {
        disposition: evidence.executionKind,
        effect: 'none',
        retry: 'replan',
      }),
      migration: evidence.executionKind === 'not_started'
        ? 'paired_not_started'
        : 'paired_refused_pre_dispatch',
    };
  }
  if (evidence.kind !== 'physical_crossing_unreadable'
    || typeof evidence.physicalDispatchId !== 'string'
    || evidence.physicalDispatchId.length === 0
    || !['started', 'timed_out', 'unknown'].includes(evidence.state)) {
    throw new ConversationProtocolMigrationError(
      'invalid_evidence',
      `Physical-crossing evidence for ${call.callId} is internally inconsistent.`,
    );
  }
  return {
    call,
    item: syntheticResult(call, {
      disposition: 'effect_unknown',
      effect: 'unknown',
      retry: 'do_not_retry',
      next: 'reconcile',
      physicalDispatchId: evidence.physicalDispatchId,
      physicalDispatchState: evidence.state,
    }),
    migration: 'paired_effect_unknown',
  };
}

function applyRepairs(
  history: readonly AgentInputItem[],
  repairs: readonly Repair[],
): AgentInputItem[] {
  const beforeIndex = new Map<number, Repair[]>();
  for (const repair of repairs) {
    const insertionIndex = repairInsertionIndex(history, repair.call.index);
    const group = beforeIndex.get(insertionIndex) ?? [];
    group.push(repair);
    beforeIndex.set(insertionIndex, group);
  }
  for (const group of beforeIndex.values()) {
    group.sort((left, right) => left.call.index - right.call.index);
  }

  const migrated: AgentInputItem[] = [];
  for (let index = 0; index <= history.length; index += 1) {
    for (const repair of beforeIndex.get(index) ?? []) migrated.push(repair.item);
    if (index < history.length) migrated.push(history[index]!);
  }
  return migrated;
}

function primaryMigration(repairs: readonly Repair[]): ConversationMigration['migration'] {
  if (repairs.some((repair) => repair.migration === 'paired_effect_unknown')) {
    return 'paired_effect_unknown';
  }
  if (repairs.some((repair) => repair.migration === 'paired_exact_result')) {
    return 'paired_exact_result';
  }
  if (repairs.some((repair) => repair.migration === 'paired_not_started')) {
    return 'paired_not_started';
  }
  return 'paired_refused_pre_dispatch';
}

function tryRepairResultIdentityMismatches(input: {
  history: readonly AgentInputItem[];
  evidenceByCallId: Readonly<Record<string, MigrationEvidence>>;
  analysis: ProtocolAnalysis;
}): ConversationMigration | null {
  const mismatchedCallIds = [...new Set(input.analysis.inspection.issues
    .filter((issue) => issue.code === 'function_result_identity_mismatch' && issue.callId)
    .map((issue) => issue.callId!))];
  if (mismatchedCallIds.length === 0) return null;

  const repairedHistory = input.history.slice() as AgentInputItem[];
  const repairs = mismatchedCallIds.map((callId): Repair => {
    const call = input.analysis.calls.get(callId);
    const evidence = evidenceFor(input.evidenceByCallId, callId);
    if (!call || call.resultIndex === undefined || !evidence) {
      throw new ConversationProtocolMigrationError(
        'missing_call_evidence',
        `Mismatched function result ${callId} has no exact durable migration evidence.`,
      );
    }
    if (evidence.kind === 'pending_approval' || evidence.kind === 'ambiguous') {
      throw new ConversationProtocolMigrationError(
        'invalid_evidence',
        `Mismatched function result ${callId} contradicts ${evidence.kind} evidence.`,
      );
    }
    const repair = repairForEvidence(call, evidence);
    repairedHistory[call.resultIndex] = repair.item;
    return repair;
  });

  const migrated = migratePersistedConversationProtocol({
    history: repairedHistory,
    evidenceByCallId: input.evidenceByCallId,
  });
  return {
    ...migrated,
    migration: migrated.migration === 'none' ? primaryMigration(repairs) : migrated.migration,
  };
}

/**
 * Repair persisted legacy history only from exact durable evidence.
 *
 * - settled bytes are inserted verbatim after their SHA-256 binding is checked;
 * - proof of zero dispatch becomes an ordinary no-effect result for replanning;
 * - any possible physical crossing becomes effect-unknown and is withheld from
 *   providers until reconciliation;
 * - pending approvals remain byte-identical and withheld;
 * - only an exact ambiguous suffix may be quarantined.
 */
export function migratePersistedConversationProtocol(input: {
  history: readonly AgentInputItem[];
  evidenceByCallId: Readonly<Record<string, MigrationEvidence>>;
}): ConversationMigration {
  const analysis = analyzeConversationProtocol(input.history);
  if (analysis.inspection.status === 'valid') {
    return migrateAlreadyPairedConversation({
      history: input.history,
      evidenceByCallId: input.evidenceByCallId,
      calls: analysis.calls,
    });
  }

  const identityRepaired = tryRepairResultIdentityMismatches({
    history: input.history,
    evidenceByCallId: input.evidenceByCallId,
    analysis,
  });
  if (identityRepaired) return identityRepaired;

  const quarantined = tryExactAmbiguityQuarantine({
    history: input.history,
    evidenceByCallId: input.evidenceByCallId,
    inspection: analysis.inspection,
  });
  if (quarantined) return quarantined;

  const repairableCodes = new Set<ProtocolIssueCode>([
    'unmatched_function_call',
    'conversation_advanced_with_open_call',
  ]);
  if (analysis.inspection.issues.some((issue) => !repairableCodes.has(issue.code))) {
    throw new ConversationProtocolMigrationError(
      'invalid_history_without_exact_quarantine_evidence',
      'Persisted conversation is ambiguous and has no exact suffix-quarantine evidence.',
    );
  }

  const openCalls = [...analysis.calls.values()]
    .filter((call) => call.resultIndex === undefined)
    .sort((left, right) => left.index - right.index);
  if (openCalls.length === 0) {
    throw new ConversationProtocolMigrationError(
      'invalid_history_without_exact_quarantine_evidence',
      'Persisted conversation is invalid but has no uniquely repairable open function call.',
    );
  }

  const resolvedEvidence = openCalls.map((call) => {
    const evidence = evidenceFor(input.evidenceByCallId, call.callId);
    if (!evidence) {
      throw new ConversationProtocolMigrationError(
        'missing_call_evidence',
        `Open function call ${call.callId} has no durable migration evidence.`,
      );
    }
    if (evidence.kind === 'ambiguous') {
      throw new ConversationProtocolMigrationError(
        'invalid_evidence',
        `Open function call ${call.callId} cannot be repaired from ambiguity evidence.`,
      );
    }
    return { call, evidence };
  });

  const pendingCount = resolvedEvidence.filter(
    ({ evidence }) => evidence.kind === 'pending_approval',
  ).length;
  if (pendingCount > 0 && pendingCount !== resolvedEvidence.length) {
    throw new ConversationProtocolMigrationError(
      'invalid_evidence',
      'A held approval frame cannot be combined with a different unresolved execution state.',
    );
  }
  if (pendingCount > 0) {
    if (resolvedEvidence.some(({ evidence }) => (
      evidence.kind === 'pending_approval'
      && (typeof evidence.approvalId !== 'string' || evidence.approvalId.length === 0)
    ))) {
      throw new ConversationProtocolMigrationError(
        'invalid_evidence',
        'Pending approval evidence must carry a non-empty durable approval identity.',
      );
    }
    const history = input.history.slice() as AgentInputItem[];
    return {
      disposition: 'pending_approval',
      migration: 'none',
      history,
      providerHistory: null,
    };
  }

  const repairs: Repair[] = resolvedEvidence.map(({ call, evidence }): Repair => (
    repairForEvidence(call, evidence)
  ));

  const history = applyRepairs(input.history, repairs);
  const repairedAnalysis = analyzeConversationProtocol(history);
  if (repairedAnalysis.inspection.status !== 'valid') {
    throw new ConversationProtocolMigrationError(
      'invalid_evidence',
      'Evidence-driven migration did not produce a valid one-to-one conversation transcript.',
    );
  }

  // Re-run the paired-state verifier across the complete repaired transcript.
  // This prevents an older effect-unknown pair elsewhere in the same history
  // from becoming provider-visible merely because a different open call was
  // repaired in this invocation.
  const pairedState = migrateAlreadyPairedConversation({
    history,
    evidenceByCallId: input.evidenceByCallId,
    calls: repairedAnalysis.calls,
  });
  const repairMigration = primaryMigration(repairs);
  const migration = repairMigration === 'paired_effect_unknown'
    ? repairMigration
    : pairedState.migration === 'paired_exact_result'
      ? pairedState.migration
      : repairMigration;
  return {
    ...pairedState,
    migration,
  };
}
