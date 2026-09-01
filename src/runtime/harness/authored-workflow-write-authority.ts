import { createHash } from 'node:crypto';
import path from 'node:path';

import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import { resolveWorkflowRunDefinitionSnapshot } from '../../execution/workflow-run-definition.js';
import { readWorkflowRunRecord } from '../../execution/workflow-run-record.js';
import { getCachedToolSchema } from '../../tools/composio-schema-cache.js';
import { WORKFLOW_RUNS_DIR } from '../../tools/shared.js';
import { digestSchema } from '../../tools/tool-contract-store.js';
import {
  getPlanScope,
  installAuthoredWorkflowWriteAuthorityScope,
  readAuthoredWorkflowWriteAuthorityScope,
} from '../../agents/plan-scope.js';
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
  stepSideEffect: 'write';
  requiresApproval: false;
  promptDigest: string;
  catalogIdentities: readonly CanonicalCatalogIdentityV1[];
  authorityDigest: string;
}

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
    || row.stepSideEffect !== 'write'
    || row.requiresApproval !== false
    || typeof row.promptDigest !== 'string'
    || !DIGEST.test(row.promptDigest)
    || !Array.isArray(row.catalogIdentities)
    || row.catalogIdentities.length === 0
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
    if (externalWrites.length === 0) return { status: 'none' };
    if (
      externalWrites.length > MAX_BINDINGS
      || new Set(externalWrites.map((identity) => identity.manifestId)).size !== externalWrites.length
      || new Set(externalWrites.map((identity) => identity.operationId)).size !== externalWrites.length
      || externalWrites.some((identity) => (
        !identity.destination
        || !['create_new', 'named_existing', 'not_applicable'].includes(identity.destination.posture)
      ))
      || !currentIdentitiesAreExact(externalWrites)
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
    if (!step || step.sideEffect !== 'write' || step.requiresApproval === true) {
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
      stepSideEffect: 'write' as const,
      requiresApproval: false as const,
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

/**
 * Reopen one saved workflow's exact, pre-model write receipt and project it
 * into the shared consent reducer. This is coverage, never a bypass: current
 * schema, catalog, account, destination, risk, accepted batch occurrence,
 * active attempt, PlanScope, and source-local catalog narrowing must all still
 * agree. High-consequence calls deliberately return null to their existing
 * authored approval/send policies.
 */
export async function evaluateAuthoredWorkflowMutationConsent(input: {
  attestation: HostCallAttestation;
  args: Record<string, unknown>;
  acceptedBatch: AcceptedModelBatchRef;
  callIndex: number;
}): Promise<HostInteractiveConsentResult | null> {
  try {
    const attestation = input.attestation;
    if (
      attestation.bindingKind !== 'catalog_manifest'
      || attestation.effect !== 'external_write'
      || !Number.isSafeInteger(input.callIndex)
      || input.callIndex < 0
    ) return null;
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
      || step.sideEffect !== 'write'
      || step.requiresApproval === true
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

    const reopened = reopenAcceptedModelBatch(input.acceptedBatch);
    if (
      reopened.status !== 'open'
      || input.acceptedBatch.sessionId !== attestation.sessionId
      || input.acceptedBatch.sourceUserSeq !== attestation.sourceUserSeq
      || input.acceptedBatch.acceptedTaskId !== attestation.acceptedTaskId
      || reopened.admission.callIds[input.callIndex] !== attestation.logicalToolCallId
    ) return null;
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
    const highConsequence = projection.effect !== 'external_write'
      || projection.safety !== 'admissible'
      || projection.risk.destructive
      || !['reversible', 'ordinary_non_destructive'].includes(projection.risk.reversibility)
      || projection.risk.consequence === 'send'
      || projection.risk.consequence === 'delete'
      || projection.risk.consequence === 'admin';
    if (highConsequence) return null;
    const crossing = crossingFor({
      sessionId: attestation.sessionId,
      sourceUserSeq: attestation.sourceUserSeq,
      logicalToolCallId: attestation.logicalToolCallId,
    });
    if (!crossing) return null;
    const cardinality = {
      kind: 'each' as const,
      universeDigest: digest({
        version: VERSION,
        authorityDigest: receipt.authorityDigest,
        batchId: input.acceptedBatch.batchId,
        batchOrdinal: input.acceptedBatch.batchOrdinal,
      }),
    };
    const call: CapabilityRiskAttestationV1 = {
      version: 1,
      source: {
        kind: 'accepted_turn',
        id: receipt.sourceEventId,
        digest: receipt.sourceEventDigest,
      },
      acceptedTaskId: attestation.acceptedTaskId,
      bindingDigest: digest({
        version: VERSION,
        authorityDigest: receipt.authorityDigest,
        hostBindingDigest: attestation.bindingDigest,
        outerArgumentDigest: attestation.argumentDigest,
        providerArgsDigest,
        batchId: input.acceptedBatch.batchId,
        batchOrdinal: input.acceptedBatch.batchOrdinal,
        callIndex: input.callIndex,
        logicalToolCallId: attestation.logicalToolCallId,
      }),
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
    const coverage: ExactWorkCoverageV1 = {
      version: 1,
      source: call.source,
      acceptedTaskId: call.acceptedTaskId,
      contractId: `authored-workflow:${receipt.authorityDigest}`,
      requirementId: attestation.operationId,
      requirementDigest: receipt.authorityDigest,
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
      reservationKey: digest({
        version: VERSION,
        authorityDigest: receipt.authorityDigest,
        acceptedBatchId: input.acceptedBatch.batchId,
        acceptedBatchOrdinal: input.acceptedBatch.batchOrdinal,
        callIndex: input.callIndex,
        logicalToolCallId: attestation.logicalToolCallId,
      }),
    };
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
    const decision = evaluateInteractiveConsentV1({
      call,
      coverage,
      userGrant: standingGrant,
      readiness: { kind: 'ready' },
      crossing,
      reservationAlreadyClaimed: false,
    });
    if (
      decision.kind !== 'proceed'
      || !['exact_user_grant', 'settled_replay'].includes(decision.basis)
    ) return null;
    return { status: 'decided', decision, call, coverage };
  } catch {
    return null;
  }
}
