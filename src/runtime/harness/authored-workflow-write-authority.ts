import { createHash } from 'node:crypto';
import path from 'node:path';

import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import { resolveWorkflowRunDefinitionSnapshot } from '../../execution/workflow-run-definition.js';
import { readWorkflowRunRecord } from '../../execution/workflow-run-record.js';
import { getCachedToolSchema } from '../../tools/composio-schema-cache.js';
import { WORKFLOW_RUNS_DIR } from '../../tools/shared.js';
import { digestSchema } from '../../tools/tool-contract-store.js';
import { TOOL_REGISTRY } from '../../tools/tool-registry.js';
import {
  getPlanScope,
  installAuthoredWorkflowWriteAuthorityScope,
  readAuthoredWorkflowWriteAuthorityScope,
  type PlanScope,
} from '../../agents/plan-scope.js';
import {
  actionTopologyRoleForRuntimeCall,
  classifyRuntimeToolEffect,
  unwrapRuntimeEffectiveToolIdentity,
} from './tool-effect.js';
import {
  localPlanningArgumentsMatch,
  observeCurrentLocalPlanningDefinitions,
  type AuthorizedLocalPlanningDefinitionV1,
} from './local-planning-capability.js';
import {
  acceptedTurnSourceEventDigest,
  getSession,
  getRunAttemptBySourceUserSeq,
  openEventLog,
} from './eventlog.js';
import { currentAcceptedSourceCatalogManifestScope } from './accepted-source-catalog-scope.js';
import {
  canonicalCatalogIdentityOf,
  isCurrentCallableCatalogEntry,
  peekHostCapabilityCatalogFactory,
  type CanonicalCatalogIdentityV1,
} from './host-capability-catalog-factory.js';
import {
  deriveExternalCapabilityCallSignalsV1,
  loadCatalogManifestExternalRiskAttestationV1,
} from './external-capability-risk-loader.js';
import {
  evaluateInteractiveConsentV1,
  type CapabilityRiskAttestationV1,
  type ExactUserGrantV1,
  type ExactWorkCoverageV1,
  type InteractiveConsentCrossing,
  type InteractiveConsentDestination,
} from './interactive-consent-policy.js';
import {
  reopenAcceptedModelBatch,
  type AcceptedModelBatchRef,
} from './accepted-model-batch-checkpoint.js';
import type { HostCallAttestation } from './accepted-turn-call-authority.js';
import type { HostInteractiveConsentResult } from './host-interactive-consent.js';

const VERSION = 1 as const;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_BINDINGS = 32;
const EVENT_TYPE = 'authored_workflow_write_authority' as const;

interface SourceEventRow {
  id: string;
  session_id: string;
  seq: number;
  turn: number;
  role: string;
  type: string;
  parent_event_id: string | null;
  data_json: string;
  created_at: string;
}

interface AuthoredWorkflowWriteReceiptV1 {
  version: typeof VERSION;
  sourceUserSeq: number;
  sourceEventId: string;
  sourceEventDigest: string;
  attemptId: string;
  attemptRunId: string;
  workflowRunId: string;
  workflowSlug: string;
  workflowName: string;
  stepId: string;
  planProposalId: string;
  definitionHash: string;
  admissionHash: string;
  /** The immutable step's authored side-effect class. A `send` step also
   * covers the ordinary/local writes it contains; the send itself is decided
   * by its own effect-aware branch. */
  stepSideEffect: 'write' | 'send';
  requiresApproval: boolean;
  promptDigest: string;
  /** Exact external write identities named by the immutable step. Empty for a
   * step whose only mutations are Clementine's own registry ledgers. */
  catalogIdentities: readonly CanonicalCatalogIdentityV1[];
  authorityDigest: string;
}

const AUTHORED_STEP_SIDE_EFFECTS = new Set<string>(['write', 'send']);

export type RecordAuthoredWorkflowWriteAuthorityResult =
  | { status: 'ready'; authorityDigest: string }
  | { status: 'none' }
  | { status: 'refused'; reason: string };

function digest(value: unknown): string {
  return createHash('sha256').update(closedCanonicalJson(value), 'utf8').digest('hex');
}

function sourceEvent(sessionId: string, sourceUserSeq: number): SourceEventRow | null {
  if (!sessionId.trim() || !Number.isSafeInteger(sourceUserSeq) || sourceUserSeq <= 0) return null;
  const row = openEventLog().prepare(`
    SELECT id, session_id, seq, turn, role, type, parent_event_id, data_json, created_at
      FROM events
     WHERE session_id = ? AND seq = ?
       AND role = 'user' AND type = 'user_input_received'
     LIMIT 1
  `).get(sessionId, sourceUserSeq) as SourceEventRow | undefined;
  return row ?? null;
}

function sourceDigest(row: SourceEventRow): string {
  return acceptedTurnSourceEventDigest({
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    turn: row.turn,
    role: row.role,
    type: row.type,
    parentEventId: row.parent_event_id,
    dataJson: row.data_json,
    createdAt: row.created_at,
  });
}

function eventIdFor(row: SourceEventRow): string {
  return `authored-workflow-write:v1:${digest({
    version: VERSION,
    sessionId: row.session_id,
    sourceUserSeq: row.seq,
    sourceEventDigest: sourceDigest(row),
  })}`;
}

function sortedCatalogIdentities(
  identities: readonly CanonicalCatalogIdentityV1[],
): CanonicalCatalogIdentityV1[] {
  return [...identities]
    .map((identity) => structuredClone(identity))
    .sort((left, right) => (
      left.manifestId.localeCompare(right.manifestId)
      || left.capabilityId.localeCompare(right.capabilityId)
    ));
}

function catalogIdentityBytesEqual(
  left: CanonicalCatalogIdentityV1,
  right: CanonicalCatalogIdentityV1,
): boolean {
  return closedCanonicalJson(left) === closedCanonicalJson(right);
}

function sourceMetadata(row: SourceEventRow): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(row.data_json) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function workflowSessionMatches(input: {
  sessionId: string;
  workflowRunId: string;
  workflowName: string;
  stepId: string;
}): boolean {
  const session = getSession(input.sessionId);
  return Boolean(
    session
    && session.kind === 'workflow'
    && session.channel === 'workflow'
    && session.metadata.source === 'workflow'
    && session.metadata.workflowRunId === input.workflowRunId
    && session.metadata.workflowName === input.workflowName
    && session.metadata.stepId === input.stepId
  );
}

function promptContainsExactOperation(prompt: string, operationId: string): boolean {
  const escaped = operationId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Z0-9_])${escaped}(?:$|[^A-Z0-9_])`).test(prompt);
}

function currentIdentitiesAreExact(identities: readonly CanonicalCatalogIdentityV1[]): boolean {
  const factory = peekHostCapabilityCatalogFactory();
  if (!factory) return false;
  return identities.every((identity) => {
    const entry = factory.get(identity.capabilityId);
    const current = entry && isCurrentCallableCatalogEntry(entry)
      ? canonicalCatalogIdentityOf(entry)
      : null;
    return Boolean(current && catalogIdentityBytesEqual(current, identity));
  });
}

function exactReceiptKeys(value: Record<string, unknown>): boolean {
  const expected = [
    'admissionHash', 'attemptId', 'attemptRunId', 'authorityDigest',
    'catalogIdentities', 'definitionHash', 'planProposalId', 'promptDigest',
    'requiresApproval', 'sourceEventDigest', 'sourceEventId', 'sourceUserSeq',
    'stepId', 'stepSideEffect', 'version', 'workflowName', 'workflowRunId',
    'workflowSlug',
  ].sort();
  return Object.keys(value).sort().join('\0') === expected.join('\0');
}

function parseReceipt(value: unknown): AuthoredWorkflowWriteReceiptV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    !exactReceiptKeys(row)
    || row.version !== VERSION
    || !Number.isSafeInteger(row.sourceUserSeq)
    || Number(row.sourceUserSeq) <= 0
    || typeof row.sourceEventId !== 'string'
    || !row.sourceEventId
    || typeof row.sourceEventDigest !== 'string'
    || !DIGEST.test(row.sourceEventDigest)
    || typeof row.attemptId !== 'string'
    || !row.attemptId
    || typeof row.attemptRunId !== 'string'
    || !row.attemptRunId
    || typeof row.workflowRunId !== 'string'
    || !row.workflowRunId
    || typeof row.workflowSlug !== 'string'
    || !row.workflowSlug
    || typeof row.workflowName !== 'string'
    || !row.workflowName
    || typeof row.stepId !== 'string'
    || !row.stepId
    || typeof row.planProposalId !== 'string'
    || !row.planProposalId
    || typeof row.definitionHash !== 'string'
    || !DIGEST.test(row.definitionHash)
    || typeof row.admissionHash !== 'string'
    || !DIGEST.test(row.admissionHash)
    || typeof row.stepSideEffect !== 'string'
    || !AUTHORED_STEP_SIDE_EFFECTS.has(row.stepSideEffect)
    || typeof row.requiresApproval !== 'boolean'
    || typeof row.promptDigest !== 'string'
    || !DIGEST.test(row.promptDigest)
    || !Array.isArray(row.catalogIdentities)
    || row.catalogIdentities.length > MAX_BINDINGS
    || typeof row.authorityDigest !== 'string'
    || !DIGEST.test(row.authorityDigest)
  ) return null;
  const { authorityDigest, ...body } = row;
  if (digest(body) !== authorityDigest) return null;
  return row as unknown as AuthoredWorkflowWriteReceiptV1;
}

function readReceipt(
  sessionId: string,
  sourceUserSeq: number,
): { receipt: AuthoredWorkflowWriteReceiptV1; source: SourceEventRow } | null {
  const source = sourceEvent(sessionId, sourceUserSeq);
  if (!source) return null;
  const expectedId = eventIdFor(source);
  const rows = openEventLog().prepare(`
    SELECT id, session_id, turn, role, type, parent_event_id, data_json, created_at
      FROM events
     WHERE session_id = ?
       AND type = ?
       AND (id = ? OR parent_event_id = ?)
     ORDER BY seq
  `).all(sessionId, EVENT_TYPE, expectedId, source.id) as Array<{
    id: string;
    session_id: string;
    turn: number;
    role: string;
    type: string;
    parent_event_id: string | null;
    data_json: string;
    created_at: string;
  }>;
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  if (
    row.id !== expectedId
    || row.session_id !== sessionId
    || row.turn !== source.turn
    || row.role !== 'system'
    || row.type !== EVENT_TYPE
    || row.parent_event_id !== source.id
  ) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(row.data_json) as unknown; } catch { return null; }
  const receipt = parseReceipt(parsed);
  if (
    !receipt
    || receipt.sourceUserSeq !== sourceUserSeq
    || receipt.sourceEventId !== source.id
    || receipt.sourceEventDigest !== sourceDigest(source)
  ) return null;
  return { receipt, source };
}

export function recordAuthoredWorkflowWriteAuthority(input: {
  sessionId: string;
  sourceUserSeq: number;
  attemptId: string;
  workflowRunId: string;
  workflowSlug: string;
  stepId: string;
  expectedPlanProposalId: string;
  catalogIdentities: readonly CanonicalCatalogIdentityV1[];
}): RecordAuthoredWorkflowWriteAuthorityResult {
  try {
    const externalWrites = sortedCatalogIdentities(input.catalogIdentities.filter((identity) => (
      identity.effect === 'external_write'
    )));
    // Zero external identities is an ordinary authored shape: the step's only
    // mutations are Clementine's own registry ledgers (tasks, goals, spaces).
    // The immutable step is still the accepted work, so the receipt is minted
    // with an empty identity list and the local-envelope branch binds to it.
    if (
      externalWrites.length > 0 && (
      externalWrites.length > MAX_BINDINGS
      || new Set(externalWrites.map((identity) => identity.manifestId)).size !== externalWrites.length
      || new Set(externalWrites.map((identity) => identity.operationId)).size !== externalWrites.length
      || externalWrites.some((identity) => (
        !identity.destination
        || !['create_new', 'named_existing', 'not_applicable'].includes(identity.destination.posture)
      ))
      || !currentIdentitiesAreExact(externalWrites)
      )
    ) return { status: 'refused', reason: 'catalog_identity_missing_or_ambiguous' };

    const source = sourceEvent(input.sessionId, input.sourceUserSeq);
    const metadata = source ? sourceMetadata(source) : null;
    const attempt = getRunAttemptBySourceUserSeq(input.sessionId, input.sourceUserSeq);
    if (
      !source
      || !metadata
      || metadata.workflowRunId !== input.workflowRunId
      || metadata.stepId !== input.stepId
      || metadata.attemptId !== input.attemptId
      || !attempt
      || attempt.status !== 'active'
      || attempt.attemptId !== input.attemptId
      || attempt.sourceUserSeq !== input.sourceUserSeq
      || !attempt.runId
      || (
        attempt.runId !== `workflow-step:${input.workflowRunId}:${input.stepId}`
        && !attempt.runId.startsWith(`workflow-step:${input.workflowRunId}:${input.stepId}:`)
      )
    ) return { status: 'refused', reason: 'workflow_source_or_attempt_mismatch' };

    const run = readWorkflowRunRecord<Record<string, unknown>>(
      path.join(WORKFLOW_RUNS_DIR, `${input.workflowRunId}.json`),
    );
    const resolved = resolveWorkflowRunDefinitionSnapshot(run?.workflowDefinitionSnapshot);
    if (
      !run
      || run.id !== input.workflowRunId
      || run.status !== 'running'
      || resolved.status !== 'valid'
      || resolved.snapshot.workflowSlug !== input.workflowSlug
      || !resolved.snapshot.admissionHash
    ) return { status: 'refused', reason: 'workflow_definition_authority_missing_or_changed' };
    const steps = resolved.snapshot.definition.steps.filter((candidate) => candidate.id === input.stepId);
    const step = steps.length === 1 ? steps[0]! : null;
    // Owner rule: the only human-in-the-loop gate inside a saved workflow is a
    // step AUTHORED `requiresApproval`. Every other authored write/send step's
    // save + enable/run chain is the consent, so it gets an exact receipt. A
    // send step AUTHORED `requiresApproval` also gets a receipt — it carries
    // the gate (requiresApproval:true) so its one approval card can bind to
    // the exact immutable step instead of a TTL-wide scope.
    if (
      !step
      || (step.sideEffect !== 'write' && step.sideEffect !== 'send')
      || (step.sideEffect === 'write' && step.requiresApproval === true)
    ) {
      return { status: 'none' };
    }
    const inheritedAllowed = step.allowedTools && step.allowedTools.length > 0
      ? step.allowedTools
      : resolved.snapshot.definition.allowedTools ?? [];
    const exactAllowed = new Set(inheritedAllowed.map((entry) => (
      typeof entry === 'string' ? entry : entry.name
    )).map((entry) => entry.trim().toUpperCase()));
    if (externalWrites.some((identity) => (
      !promptContainsExactOperation(step.prompt, identity.operationId)
      && !exactAllowed.has(identity.operationId.toUpperCase())
    ))) return { status: 'refused', reason: 'write_operation_not_authored_in_immutable_step' };
    if (!workflowSessionMatches({
      sessionId: input.sessionId,
      workflowRunId: input.workflowRunId,
      workflowName: resolved.snapshot.definition.name,
      stepId: input.stepId,
    })) return { status: 'refused', reason: 'workflow_session_owner_mismatch' };
    const scope = getPlanScope(input.sessionId);
    const expiresAt = Date.parse(scope?.expiresAt ?? '');
    if (
      !scope
      || scope.closedAt
      || scope.goalScoped
      || scope.planProposalId !== input.expectedPlanProposalId
      || !Number.isFinite(expiresAt)
      || expiresAt <= Date.now()
    ) return { status: 'refused', reason: 'workflow_plan_scope_missing_or_changed' };

    const body = {
      version: VERSION,
      sourceUserSeq: input.sourceUserSeq,
      sourceEventId: source.id,
      sourceEventDigest: sourceDigest(source),
      attemptId: attempt.attemptId,
      attemptRunId: attempt.runId,
      workflowRunId: input.workflowRunId,
      workflowSlug: input.workflowSlug,
      workflowName: resolved.snapshot.definition.name,
      stepId: input.stepId,
      planProposalId: input.expectedPlanProposalId,
      definitionHash: resolved.snapshot.definitionHash,
      admissionHash: resolved.snapshot.admissionHash,
      stepSideEffect: step.sideEffect,
      requiresApproval: step.requiresApproval === true,
      promptDigest: digest(step.prompt),
      catalogIdentities: externalWrites,
    };
    const receipt: AuthoredWorkflowWriteReceiptV1 = {
      ...body,
      authorityDigest: digest(body),
    };
    const eventId = eventIdFor(source);
    const dataJson = closedCanonicalJson(receipt);
    const db = openEventLog();
    const committed = db.transaction((): boolean => {
      const rows = db.prepare(`
        SELECT id, session_id, turn, role, type, parent_event_id, data_json
          FROM events
         WHERE session_id = ?
           AND type = ?
           AND (id = ? OR parent_event_id = ?)
         ORDER BY seq
      `).all(input.sessionId, EVENT_TYPE, eventId, source.id) as Array<{
        id: string;
        session_id: string;
        turn: number;
        role: string;
        type: string;
        parent_event_id: string | null;
        data_json: string;
      }>;
      if (rows.length > 0) {
        return rows.length === 1
          && rows[0]!.id === eventId
          && rows[0]!.session_id === input.sessionId
          && rows[0]!.turn === source.turn
          && rows[0]!.role === 'system'
          && rows[0]!.type === EVENT_TYPE
          && rows[0]!.parent_event_id === source.id
          && rows[0]!.data_json === dataJson;
      }
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO events
          (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
        VALUES (?, ?, ?, 'system', ?, ?, ?, ?)
      `).run(eventId, input.sessionId, source.turn, EVENT_TYPE, source.id, dataJson, now);
      db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, input.sessionId);
      return true;
    }).immediate();
    if (!committed) return { status: 'refused', reason: 'workflow_write_receipt_conflict' };
    const installed = installAuthoredWorkflowWriteAuthorityScope({
      sessionId: input.sessionId,
      expectedPlanProposalId: input.expectedPlanProposalId,
      authority: {
        version: VERSION,
        authorityDigest: receipt.authorityDigest,
        sourceUserSeq: input.sourceUserSeq,
        attemptId: input.attemptId,
        workflowRunId: input.workflowRunId,
        stepId: input.stepId,
      },
    });
    return installed
      ? { status: 'ready', authorityDigest: receipt.authorityDigest }
      : { status: 'refused', reason: 'workflow_plan_scope_pointer_conflict' };
  } catch (error) {
    return {
      status: 'refused',
      reason: String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 240),
    };
  }
}

function crossingFor(input: {
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId: string;
}): InteractiveConsentCrossing | null {
  try {
    const db = openEventLog();
    const settlement = db.prepare(`
      SELECT 1 FROM logical_call_settlements
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(input.sessionId, input.sourceUserSeq, input.logicalToolCallId);
    if (settlement) return 'settled';
    const rows = db.prepare(`
      SELECT state FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
       ORDER BY ordinal
    `).all(input.sessionId, input.sourceUserSeq, input.logicalToolCallId) as Array<{ state: string }>;
    if (rows.length === 0) return 'not_started';
    return rows.some((row) => row.state === 'started') ? 'started' : 'possibly_started';
  } catch {
    return null;
  }
}

function interactiveDestination(input: {
  receipt: AuthoredWorkflowWriteReceiptV1;
  identity: CanonicalCatalogIdentityV1;
}): InteractiveConsentDestination | null {
  const posture = input.identity.destination?.posture ?? 'not_applicable';
  if (posture !== 'create_new' && posture !== 'named_existing' && posture !== 'not_applicable') {
    return null;
  }
  return {
    posture,
    digest: digest({
      version: VERSION,
      authorityDigest: input.receipt.authorityDigest,
      destination: input.identity.destination,
      operationId: input.identity.operationId,
      account: input.identity.account,
    }),
  };
}


interface ReopenedAuthoredStep {
  receipt: AuthoredWorkflowWriteReceiptV1;
  step: {
    id: string;
    prompt: string;
    sideEffect?: string;
    requiresApproval?: boolean;
  };
  planScope: PlanScope;
}

/**
 * Re-bind the durable receipt pointer to the exact immutable step it was
 * minted for: session kind/owner, active attempt, unchanged run definition and
 * admission hash, the step's own prompt bytes, and the open step PlanScope.
 * Shared by every effect branch so no branch can bind more loosely than
 * another.
 */
function reopenAuthoredStepAuthority(
  attestation: HostCallAttestation,
): ReopenedAuthoredStep | null {
  const pointer = readAuthoredWorkflowWriteAuthorityScope(attestation.sessionId);
  if (
    !pointer
    || pointer.sourceUserSeq !== attestation.sourceUserSeq
    || pointer.attemptId.trim().length === 0
  ) return null;
  const loaded = readReceipt(attestation.sessionId, attestation.sourceUserSeq);
  if (!loaded || loaded.receipt.authorityDigest !== pointer.authorityDigest) return null;
  const { receipt } = loaded;
  if (
    receipt.attemptId !== pointer.attemptId
    || receipt.workflowRunId !== pointer.workflowRunId
    || receipt.stepId !== pointer.stepId
    || receipt.sourceEventId !== attestation.sourceEventId
    || receipt.sourceEventDigest !== attestation.sourceEventDigest
  ) return null;
  const attempt = getRunAttemptBySourceUserSeq(attestation.sessionId, attestation.sourceUserSeq);
  if (
    !attempt
    || attempt.status !== 'active'
    || attempt.attemptId !== receipt.attemptId
    || attempt.runId !== receipt.attemptRunId
    || attempt.sourceUserSeq !== receipt.sourceUserSeq
  ) return null;
  const run = readWorkflowRunRecord<Record<string, unknown>>(
    path.join(WORKFLOW_RUNS_DIR, `${receipt.workflowRunId}.json`),
  );
  const resolved = resolveWorkflowRunDefinitionSnapshot(run?.workflowDefinitionSnapshot);
  if (
    !run
    || run.id !== receipt.workflowRunId
    || run.status !== 'running'
    || resolved.status !== 'valid'
    || resolved.snapshot.workflowSlug !== receipt.workflowSlug
    || resolved.snapshot.definitionHash !== receipt.definitionHash
    || resolved.snapshot.admissionHash !== receipt.admissionHash
    || resolved.snapshot.definition.name !== receipt.workflowName
  ) return null;
  const steps = resolved.snapshot.definition.steps.filter((candidate) => candidate.id === receipt.stepId);
  const step = steps.length === 1 ? steps[0]! : null;
  if (
    !step
    || step.sideEffect !== receipt.stepSideEffect
    || (step.requiresApproval === true) !== receipt.requiresApproval
    || digest(step.prompt) !== receipt.promptDigest
  ) return null;
  if (!workflowSessionMatches({
    sessionId: attestation.sessionId,
    workflowRunId: receipt.workflowRunId,
    workflowName: receipt.workflowName,
    stepId: receipt.stepId,
  })) return null;
  const planScope = getPlanScope(attestation.sessionId);
  if (
    !planScope
    || planScope.closedAt
    || planScope.goalScoped
    || planScope.planProposalId !== receipt.planProposalId
  ) return null;
  return { receipt, step, planScope };
}

function acceptedOccurrenceBinds(input: {
  attestation: HostCallAttestation;
  acceptedBatch: AcceptedModelBatchRef;
  callIndex: number;
}): boolean {
  const reopened = reopenAcceptedModelBatch(input.acceptedBatch);
  return reopened.status === 'open'
    && input.acceptedBatch.sessionId === input.attestation.sessionId
    && input.acceptedBatch.sourceUserSeq === input.attestation.sourceUserSeq
    && input.acceptedBatch.acceptedTaskId === input.attestation.acceptedTaskId
    && reopened.admission.callIds[input.callIndex] === input.attestation.logicalToolCallId;
}

function occurrenceCardinality(input: {
  receipt: AuthoredWorkflowWriteReceiptV1;
  acceptedBatch: AcceptedModelBatchRef;
}): { kind: 'each'; universeDigest: string } {
  return {
    kind: 'each',
    universeDigest: digest({
      version: VERSION,
      authorityDigest: input.receipt.authorityDigest,
      batchId: input.acceptedBatch.batchId,
      batchOrdinal: input.acceptedBatch.batchOrdinal,
    }),
  };
}

function occurrenceBindingDigest(input: {
  receipt: AuthoredWorkflowWriteReceiptV1;
  attestation: HostCallAttestation;
  argumentDigest: string;
  acceptedBatch: AcceptedModelBatchRef;
  callIndex: number;
}): string {
  return digest({
    version: VERSION,
    authorityDigest: input.receipt.authorityDigest,
    hostBindingDigest: input.attestation.bindingDigest,
    outerArgumentDigest: input.attestation.argumentDigest,
    providerArgsDigest: input.argumentDigest,
    batchId: input.acceptedBatch.batchId,
    batchOrdinal: input.acceptedBatch.batchOrdinal,
    callIndex: input.callIndex,
    logicalToolCallId: input.attestation.logicalToolCallId,
  });
}

function occurrenceReservationKey(input: {
  receipt: AuthoredWorkflowWriteReceiptV1;
  attestation: HostCallAttestation;
  acceptedBatch: AcceptedModelBatchRef;
  callIndex: number;
}): string {
  return digest({
    version: VERSION,
    authorityDigest: input.receipt.authorityDigest,
    acceptedBatchId: input.acceptedBatch.batchId,
    acceptedBatchOrdinal: input.acceptedBatch.batchOrdinal,
    callIndex: input.callIndex,
    logicalToolCallId: input.attestation.logicalToolCallId,
  });
}

function coverageFor(input: {
  receipt: AuthoredWorkflowWriteReceiptV1;
  attestation: HostCallAttestation;
  call: CapabilityRiskAttestationV1;
  acceptedBatch: AcceptedModelBatchRef;
  callIndex: number;
}): ExactWorkCoverageV1 {
  const { call } = input;
  return {
    version: 1,
    source: call.source,
    acceptedTaskId: call.acceptedTaskId,
    contractId: `authored-workflow:${input.receipt.authorityDigest}`,
    requirementId: input.attestation.operationId,
    requirementDigest: input.receipt.authorityDigest,
    semanticScope: {
      operationId: call.operationId,
      schemaFingerprint: call.schemaFingerprint,
      effect: call.effect,
      accountId: call.accountId,
      destination: call.destination,
      cardinality: call.cardinality,
      semanticBasis: call.semanticBasis,
    },
    callBinding: {
      logicalToolCallId: call.logicalToolCallId,
      argumentDigest: call.argumentDigest,
      bindingDigest: call.bindingDigest,
    },
    reservationKey: occurrenceReservationKey(input),
  };
}

/**
 * Process-local same-frame cardinality ledger for authored sends.
 *
 * One authored send per step attempt. The durable ledgers (logical calls,
 * settlements, physical dispatches) only learn about a call once it reaches
 * dispatch, so two send calls inside ONE model frame would each be evaluated
 * before either has a durable row. The host evaluates a frame's calls in
 * order; the first call that binds a send receipt is recorded here and any
 * sibling in the same frame that binds the same receipt is `cardinality_spent`.
 * The same logical call re-evaluated (approval resume in-process) keeps its
 * own reservation. Bounded: oldest frames are forgotten first.
 */
const MAX_TRACKED_SEND_FRAMES = 256;
const sendGrantsByFrame = new Map<string, Map<string, string>>();

function sendFrameKey(ref: AcceptedModelBatchRef): string {
  return `${ref.sessionId}\0${ref.sourceUserSeq}\0${ref.batchId}`;
}

function rememberSendGrant(input: {
  acceptedBatch: AcceptedModelBatchRef;
  authorityDigest: string;
  logicalToolCallId: string;
}): void {
  const key = sendFrameKey(input.acceptedBatch);
  let frame = sendGrantsByFrame.get(key);
  if (!frame) {
    frame = new Map();
    sendGrantsByFrame.set(key, frame);
    while (sendGrantsByFrame.size > MAX_TRACKED_SEND_FRAMES) {
      const oldest = sendGrantsByFrame.keys().next().value;
      if (oldest === undefined) break;
      sendGrantsByFrame.delete(oldest);
    }
  }
  if (!frame.has(input.authorityDigest)) frame.set(input.authorityDigest, input.logicalToolCallId);
}

/**
 * Has this step attempt already spent its one authored send on a DIFFERENT
 * logical call? Same-frame siblings come from the process-local ledger above;
 * earlier frames come from the durable ledgers: any other logical call for the
 * same operation in this session/source that settled as executed (never a
 * refused_pre_dispatch settlement) or that started a physical crossing.
 * Unreadable truth fails closed (spent).
 */
function sendReservationAlreadyClaimed(input: {
  attestation: HostCallAttestation;
  receipt: AuthoredWorkflowWriteReceiptV1;
  acceptedBatch: AcceptedModelBatchRef;
}): boolean {
  const { attestation } = input;
  const holder = sendGrantsByFrame.get(sendFrameKey(input.acceptedBatch))?.get(input.receipt.authorityDigest);
  if (holder && holder !== attestation.logicalToolCallId) return true;
  try {
    // The durable rows record the logical contract's canonical tool name,
    // which normalizes case; compare case-insensitively so a claimed send can
    // never hide behind its spelling.
    const db = openEventLog();
    const settled = db.prepare(`
      SELECT 1
        FROM logical_call_settlements settlement
        JOIN logical_tool_calls call
          ON call.session_id = settlement.session_id
         AND call.source_user_seq = settlement.source_user_seq
         AND call.logical_tool_call_id = settlement.logical_tool_call_id
       WHERE settlement.session_id = ?
         AND settlement.source_user_seq = ?
         AND UPPER(call.tool_name) = UPPER(?)
         AND settlement.execution_kind != 'refused_pre_dispatch'
         AND settlement.logical_tool_call_id != ?
       LIMIT 1
    `).get(
      attestation.sessionId,
      attestation.sourceUserSeq,
      attestation.operationId,
      attestation.logicalToolCallId,
    );
    if (settled) return true;
    const started = db.prepare(`
      SELECT 1
        FROM physical_dispatches
       WHERE session_id = ?
         AND source_user_seq = ?
         AND UPPER(tool_name) = UPPER(?)
         AND logical_tool_call_id != ?
       LIMIT 1
    `).get(
      attestation.sessionId,
      attestation.sourceUserSeq,
      attestation.operationId,
      attestation.logicalToolCallId,
    );
    return Boolean(started);
  } catch {
    return true;
  }
}

type AuthoredCatalogGate = 'ordinary_write' | 'send';

/**
 * Which authored authority class does this exact projection fall under?
 *  - ordinary_write: reversible / ordinary non-destructive external write and
 *    never a send/delete/admin consequence — covered by any authored write or
 *    send step;
 *  - send: an admissible, non-destructive external write whose consequence is
 *    `send` and whose reversibility is `irreversible` — covered ONLY by a step
 *    the author declared `sideEffect: 'send'`.
 * Delete, admin, destructive, protected/untrusted and unknown projections are
 * never authored authority and return null exactly as before.
 */
function authoredCatalogGate(
  stepSideEffect: AuthoredWorkflowWriteReceiptV1['stepSideEffect'],
  projection: {
    effect: string;
    safety: string;
    risk: CapabilityRiskAttestationV1['risk'];
  },
): AuthoredCatalogGate | null {
  if (projection.effect !== 'external_write' || projection.safety !== 'admissible') return null;
  if (projection.risk.destructive) return null;
  if (projection.risk.consequence === 'delete' || projection.risk.consequence === 'admin') return null;
  const ordinary = (projection.risk.reversibility === 'reversible'
    || projection.risk.reversibility === 'ordinary_non_destructive')
    && projection.risk.consequence !== 'send';
  if (ordinary) return 'ordinary_write';
  if (
    stepSideEffect === 'send'
    && projection.risk.consequence === 'send'
    && projection.risk.reversibility === 'irreversible'
  ) return 'send';
  return null;
}

/**
 * Exact external-catalog branch: one frozen catalog identity named by the
 * immutable step, current schema/account/manifest/port, an authored risk
 * class (ordinary write, or send for a send step), and the standing workflow
 * grant. Sends are once per step attempt. Delete/admin/destructive/unknown
 * projections deliberately return null.
 */
async function evaluateAuthoredCatalogWrite(input: {
  attestation: HostCallAttestation;
  args: Record<string, unknown>;
  acceptedBatch: AcceptedModelBatchRef;
  callIndex: number;
  reopened: ReopenedAuthoredStep;
}): Promise<HostInteractiveConsentResult | null> {
  const { attestation, reopened } = input;
  const { receipt } = reopened;
  // A step AUTHORED `requiresApproval` keeps its human gate (its exact card
  // and durable resume are a separate branch); never the standing grant.
  if (receipt.requiresApproval || reopened.step.requiresApproval === true) return null;
  const acceptedScope = currentAcceptedSourceCatalogManifestScope();
  if (!acceptedScope) return null;
  const candidates = receipt.catalogIdentities.filter((identity) => (
    identity.capabilityId === attestation.capabilityId
    && identity.manifestId === attestation.manifestId
    && identity.operationId === attestation.operationId
  ));
  if (candidates.length !== 1) return null;
  const identity = candidates[0]!;
  if (
    !acceptedScope.manifestIds.has(identity.manifestId)
    || !acceptedScope.operationIds.has(identity.operationId.toUpperCase())
    || identity.manifestDigest !== attestation.manifestDigest
    || identity.schemaDigest !== attestation.schemaFingerprint
    || identity.account !== attestation.accountId
    || identity.effect !== attestation.effect
    || identity.invokePortId !== attestation.invokePortId
    || identity.providerInputSchemaDigest !== attestation.providerInputSchemaDigest
  ) return null;
  const factory = peekHostCapabilityCatalogFactory();
  const entry = factory?.get(identity.capabilityId);
  const current = entry && isCurrentCallableCatalogEntry(entry)
    ? canonicalCatalogIdentityOf(entry)
    : null;
  if (!entry || !current || !catalogIdentityBytesEqual(current, identity)) return null;
  const schema = getCachedToolSchema(identity.operationId);
  if (
    !schema
    || !identity.providerInputSchemaDigest
    || digestSchema(schema) !== identity.providerInputSchemaDigest
  ) return null;

  if (!acceptedOccurrenceBinds(input)) return null;
  const destination = interactiveDestination({ receipt, identity });
  if (!destination) return null;
  const providerArgsDigest = digest(input.args);
  const exactDestination: InteractiveConsentDestination = {
    ...destination,
    digest: digest({
      version: VERSION,
      destinationDigest: destination.digest,
      providerArgsDigest,
    }),
  };
  const callSignals = deriveExternalCapabilityCallSignalsV1({
    version: 1,
    inputSchema: schema,
    arguments: input.args,
  });
  if (callSignals.status !== 'projected') return null;
  const risk = loadCatalogManifestExternalRiskAttestationV1({
    version: 1,
    binding: {
      bindingKind: 'catalog_manifest',
      capabilityId: attestation.capabilityId,
      ...(attestation.providerInputSchemaDigest
        ? { providerInputSchemaDigest: attestation.providerInputSchemaDigest }
        : {}),
      schemaFingerprint: attestation.schemaFingerprint,
      accountId: attestation.accountId,
      invokePortId: attestation.invokePortId,
      operationId: attestation.operationId,
      manifestId: attestation.manifestId,
      manifestDigest: attestation.manifestDigest,
      effect: attestation.effect,
    },
    inputSchema: schema,
    destination: exactDestination,
    callSignals: callSignals.callSignals,
    safety: 'admissible',
  });
  if (!risk.ok) return null;
  const projection = risk.attestation.projection;
  const gate = authoredCatalogGate(receipt.stepSideEffect, projection);
  if (!gate) return null;
  const crossing = crossingFor({
    sessionId: attestation.sessionId,
    sourceUserSeq: attestation.sourceUserSeq,
    logicalToolCallId: attestation.logicalToolCallId,
  });
  if (!crossing) return null;
  const cardinality = gate === 'send'
    ? { kind: 'once' as const }
    : occurrenceCardinality({ receipt, acceptedBatch: input.acceptedBatch });
  const call: CapabilityRiskAttestationV1 = {
    version: 1,
    source: {
      kind: 'accepted_turn',
      id: receipt.sourceEventId,
      digest: receipt.sourceEventDigest,
    },
    acceptedTaskId: attestation.acceptedTaskId,
    bindingDigest: occurrenceBindingDigest({ ...input, receipt, argumentDigest: providerArgsDigest }),
    logicalToolCallId: attestation.logicalToolCallId,
    operationId: attestation.operationId,
    argumentDigest: providerArgsDigest,
    schemaFingerprint: attestation.schemaFingerprint,
    effect: 'external_write',
    accountId: attestation.accountId,
    destination: exactDestination,
    cardinality,
    risk: projection.risk,
    semanticBasis: projection.semanticBasis,
    safety: projection.safety,
  };
  const coverage: ExactWorkCoverageV1 = gate === 'send'
    ? {
        ...coverageFor({ ...input, receipt, call }),
        // One authored send per step attempt: the reservation is the receipt
        // itself, not the admitted occurrence.
        reservationKey: digest({
          version: VERSION,
          authorityDigest: receipt.authorityDigest,
          cardinality: 'once',
        }),
      }
    : coverageFor({ ...input, receipt, call });
  const grantScope: ExactUserGrantV1['scope'] = {
    source: call.source,
    acceptedTaskId: call.acceptedTaskId,
    logicalToolCallId: call.logicalToolCallId,
    bindingDigest: call.bindingDigest,
    operationId: call.operationId,
    argumentDigest: call.argumentDigest,
    schemaFingerprint: call.schemaFingerprint,
    effect: call.effect,
    accountId: call.accountId,
    destination: call.destination,
    cardinality: call.cardinality,
    risk: call.risk,
    semanticBasis: call.semanticBasis,
  };
  // Owner rule (2026-07-24): saving + enabling/running the workflow IS the
  // consent for a step the author declared as a send without an approval
  // gate. The exact standing grant binds source, batch occurrence, arguments,
  // destination, account, schema and risk — strictly tighter than any
  // TTL-wide scope flag — and the reducer accepts it before its
  // high-consequence floor.
  const standingGrant: ExactUserGrantV1 = {
    version: 1,
    source: 'standing_workflow_scope',
    grantDigest: digest({
      version: VERSION,
      authorityDigest: receipt.authorityDigest,
      planProposalId: receipt.planProposalId,
      scope: grantScope,
    }),
    scope: grantScope,
  };
  const reservationAlreadyClaimed = gate === 'send'
    ? sendReservationAlreadyClaimed({ attestation, receipt, acceptedBatch: input.acceptedBatch })
    : false;
  const decision = evaluateInteractiveConsentV1({
    call,
    coverage,
    userGrant: standingGrant,
    readiness: { kind: 'ready' },
    crossing,
    reservationAlreadyClaimed,
  });
  if (decision.kind === 'proceed' && ['exact_user_grant', 'settled_replay'].includes(decision.basis)) {
    if (gate === 'send' && decision.basis === 'exact_user_grant') {
      rememberSendGrant({
        acceptedBatch: input.acceptedBatch,
        authorityDigest: receipt.authorityDigest,
        logicalToolCallId: attestation.logicalToolCallId,
      });
    }
    return { status: 'decided', decision, call, coverage };
  }
  // A send that the reducer refuses for an exact reason (its one reservation
  // already spent, or a scope mismatch) is reported as that reason rather than
  // laundered into a generic coverage_missing by the uncovered path.
  if (gate === 'send' && decision.kind === 'repair') {
    return { status: 'decided', decision, call, coverage };
  }
  return null;
}

interface AuthoredLocalWriteRisk {
  risk: CapabilityRiskAttestationV1['risk'];
  destination: InteractiveConsentDestination;
  semanticBasis: CapabilityRiskAttestationV1['semanticBasis'];
}

/**
 * Project one registry-declared local write into exact risk facts.
 *
 * Two legible sources, no tool names:
 *  - a row that DECLARES local planning semantics (write_file, workspace
 *    definition writes) must match exactly one declared, non-destructive,
 *    reversible/create-only definition for THESE arguments — an overwrite or
 *    append mode therefore stays uncovered;
 *  - a row with no declared semantics is covered only when the registry
 *    classifies it as a CONTROL-plane operation: Clementine's own ledgers
 *    (tasks, goals, spaces, execution bookkeeping). Business-role local
 *    writes without declared semantics remain uncovered.
 */
async function authoredLocalWriteRisk(input: {
  receipt: AuthoredWorkflowWriteReceiptV1;
  attestation: HostCallAttestation;
  args: Record<string, unknown>;
}): Promise<AuthoredLocalWriteRisk | null> {
  const { attestation } = input;
  const decision = classifyRuntimeToolEffect(attestation.toolName, input.args);
  if (decision.effect !== 'local_write' || decision.source !== 'registry') return null;
  const effective = unwrapRuntimeEffectiveToolIdentity(attestation.toolName, input.args);
  const effectiveName = effective.toolName?.trim() ?? '';
  if (!effectiveName) return null;
  const rows = TOOL_REGISTRY.filter((row) => row.name === effectiveName);
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  if (row.sideEffect !== 'write' || row.runtimeEffect === 'host_only') return null;
  const declaresSemantics = Boolean(row.localPlanning)
    || (row.localPlanningVariants?.length ?? 0) > 0;
  if (declaresSemantics) {
    const observed = await observeCurrentLocalPlanningDefinitions({
      name: effectiveName,
      carrier: 'work_call',
    });
    if (!observed.ok) return null;
    const matching: AuthorizedLocalPlanningDefinitionV1[] = observed.definitions.filter((definition) => (
      localPlanningArgumentsMatch(definition, effective.args)
    ));
    if (matching.length !== 1) return null;
    const definition = matching[0]!;
    if (
      definition.destructive
      || definition.descriptor.effect !== 'local_write'
      || (definition.reversibility !== 'reversible' && definition.reversibility !== 'create_only')
    ) return null;
    const posture = definition.descriptor.destinationPosture ?? 'not_applicable';
    return {
      risk: {
        reversibility: 'reversible',
        consequence: posture === 'create_new'
          ? 'create'
          : posture === 'named_existing'
            ? 'update'
            : 'execute',
        destructive: false,
      },
      destination: {
        posture,
        digest: digest({
          version: VERSION,
          authorityDigest: input.receipt.authorityDigest,
          capabilityRef: definition.capabilityRef,
          posture,
        }),
      },
      semanticBasis: { kind: 'local_registry', digest: definition.envelopeFingerprint },
    };
  }
  if (actionTopologyRoleForRuntimeCall(attestation.toolName, input.args) !== 'control') return null;
  return {
    risk: { reversibility: 'reversible', consequence: 'update', destructive: false },
    destination: {
      posture: 'not_applicable',
      digest: digest({
        version: VERSION,
        authorityDigest: input.receipt.authorityDigest,
        operationId: attestation.operationId,
        registryOperation: effectiveName,
      }),
    },
    semanticBasis: {
      kind: 'local_registry',
      digest: digest({
        version: VERSION,
        registryOperation: effectiveName,
        sideEffect: row.sideEffect,
        role: 'control',
        schemaFingerprint: attestation.schemaFingerprint,
      }),
    },
  };
}

/**
 * Local-envelope branch: a reversible registry write inside the authored step
 * is the accepted work. The reducer is handed exact coverage (never a user
 * grant), so it proceeds only via exact_reversible_work / exact_ordinary_work
 * or replays a settled occurrence. Anything the reducer would escalate stays
 * null and falls to the uncovered path exactly as before.
 */
async function evaluateAuthoredLocalWrite(input: {
  attestation: HostCallAttestation;
  args: Record<string, unknown>;
  acceptedBatch: AcceptedModelBatchRef;
  callIndex: number;
  reopened: ReopenedAuthoredStep;
}): Promise<HostInteractiveConsentResult | null> {
  const { attestation, reopened } = input;
  const { receipt } = reopened;
  if (attestation.accountId !== '' || attestation.manifestId !== '') return null;
  const projected = await authoredLocalWriteRisk({ receipt, attestation, args: input.args });
  if (!projected) return null;
  if (!acceptedOccurrenceBinds(input)) return null;
  const crossing = crossingFor({
    sessionId: attestation.sessionId,
    sourceUserSeq: attestation.sourceUserSeq,
    logicalToolCallId: attestation.logicalToolCallId,
  });
  if (!crossing) return null;
  const argumentDigest = digest(input.args);
  const call: CapabilityRiskAttestationV1 = {
    version: 1,
    source: {
      kind: 'accepted_turn',
      id: receipt.sourceEventId,
      digest: receipt.sourceEventDigest,
    },
    acceptedTaskId: attestation.acceptedTaskId,
    bindingDigest: occurrenceBindingDigest({ ...input, receipt, argumentDigest }),
    logicalToolCallId: attestation.logicalToolCallId,
    operationId: attestation.operationId,
    argumentDigest,
    schemaFingerprint: attestation.schemaFingerprint,
    effect: 'local_write',
    accountId: '',
    destination: projected.destination,
    cardinality: occurrenceCardinality({ receipt, acceptedBatch: input.acceptedBatch }),
    risk: projected.risk,
    semanticBasis: projected.semanticBasis,
    safety: 'admissible',
  };
  const coverage = coverageFor({ ...input, receipt, call });
  const decision = evaluateInteractiveConsentV1({
    call,
    coverage,
    userGrant: null,
    readiness: { kind: 'ready' },
    crossing,
    reservationAlreadyClaimed: false,
  });
  if (
    decision.kind !== 'proceed'
    || !['exact_reversible_work', 'exact_ordinary_work', 'settled_replay'].includes(decision.basis)
  ) return null;
  return { status: 'decided', decision, call, coverage };
}


/**
 * Reopen one saved workflow's exact, pre-model write receipt and project it
 * into the shared consent reducer. This is coverage, never a bypass: current
 * schema, catalog, account, destination, risk, accepted batch occurrence,
 * active attempt, PlanScope, and source-local catalog narrowing must all still
 * agree. Delete/admin/destructive/unknown projections deliberately return
 * null to the uncovered path.
 */
export async function evaluateAuthoredWorkflowMutationConsent(input: {
  attestation: HostCallAttestation;
  args: Record<string, unknown>;
  acceptedBatch: AcceptedModelBatchRef;
  callIndex: number;
}): Promise<HostInteractiveConsentResult | null> {
  try {
    const attestation = input.attestation;
    if (!Number.isSafeInteger(input.callIndex) || input.callIndex < 0) return null;
    const catalogWrite = attestation.bindingKind === 'catalog_manifest'
      && attestation.effect === 'external_write';
    const localWrite = attestation.bindingKind === 'local_envelope'
      && attestation.effect === 'local_write';
    if (!catalogWrite && !localWrite) return null;
    const reopened = reopenAuthoredStepAuthority(attestation);
    if (!reopened) return null;
    if (localWrite) {
      // A step AUTHORED `requiresApproval` keeps its human gate; local
      // self-coverage never applies to it.
      if (reopened.receipt.requiresApproval || reopened.step.requiresApproval === true) return null;
      return await evaluateAuthoredLocalWrite({ ...input, reopened });
    }
    return await evaluateAuthoredCatalogWrite({ ...input, reopened });
  } catch {
    return null;
  }
}
