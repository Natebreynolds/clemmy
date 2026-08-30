/**
 * Normalized, occurrence-scoped authority for large approved automations.
 *
 * WorkTopology deliberately keeps its inline/source-seal member ceiling. A
 * closed workflow read can be much larger, so this lane redeems the exact
 * settled result handles, projects only the human-reviewed partition keys,
 * and stores one normalized row per partition. Only a closed ledger may be
 * compiled into the existing durable-fanout journal.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { BASE_DIR } from '../config.js';
import {
  parseWorkflowNodeInvocationPlan,
  type WorkflowNodeInvocationPlanV1,
} from '../memory/workflow-node-invocation-plan.js';
import {
  parseWorkflowCanonicalEntityResultProjection,
  type WorkflowCanonicalEntityFieldProjectionV1,
  type WorkflowCanonicalEntityResultProjection,
} from '../memory/workflow-result-projection-contract.js';
import { closedCanonicalJson } from '../shared/closed-canonical-json.js';
import { projectProviderResultEvidenceView } from '../runtime/harness/result-facts.js';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import {
  admitDurableFanoutPlan,
  loadFanoutPlan,
  type FanoutPlanRow,
} from './durable-fanout.js';
import {
  listAutomationOpportunityReviewProjections,
  type AutomationOpportunityReviewProjectionV1,
} from './automation-opportunity-review-control-plane.js';
import {
  loadAutomationOpportunityProposal,
  type AutomationOpportunityProposalRecordV1,
} from './automation-opportunity-store.js';
import type { CanonicalEntityWorkflowResultRootV1 } from './canonical-entity-workflow-lineage-producer.js';
import type { WorkDisposition } from './work-disposition.js';
import {
  redeemVerifiedClosedWorkflowReadResult,
  type VerifiedClosedWorkflowReadResultV1,
} from './workflow-read-result-redemption.js';
import {
  resolveWorkflowRunDefinitionSnapshot,
  type WorkflowRunDefinitionSnapshot,
} from './workflow-run-definition.js';
import {
  readWorkflowRunRecord,
  readWorkflowRunRecordSnapshot,
} from './workflow-run-record.js';
import {
  resolveWorkflowRecurringReadAdmission,
  workflowRecurringReadInputsDigest,
  type WorkflowRecurringReadAdmissionV1,
} from './workflow-recurring-read-admission.js';
import type { QueuedRunRecord } from './workflow-runner.js';

export const AUTOMATION_PARTITION_AUTHORITY_VERSION = 1 as const;

const DIGEST_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,511}$/;
const MAX_REASON_BYTES = 2_000;

type AuthorityStatus = 'sealed' | 'admitted';

export interface AutomationPartitionAuthorityV1 {
  version: typeof AUTOMATION_PARTITION_AUTHORITY_VERSION;
  authorityId: string;
  proposalId: string;
  proposalRevision: number;
  proposalDigest: string;
  reviewProjectionId: string;
  reviewApprovalId: string;
  reviewArgsDigest: string;
  occurrenceId: string;
  partitionProjectionDigest: string;
  keyFields: string[];
  dimensions: string[];
  invocationPlanDigest: string;
  source: {
    executionKind: 'single_read' | 'paginated_read';
    activationId: string;
    activationDigest: string;
    authorityRootId: string;
    aggregateReceiptId?: string;
    aggregateReceiptDigest?: string;
    pageCount: number;
    resultHandleDigest: string;
    exhausted: true;
  };
  partitionCount: number;
  ledgerDigest: string;
  maxConcurrentPartitions: number;
  maxAttemptsPerPartition: number;
  status: AuthorityStatus;
  fanoutPlanId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationPartitionRowV1 {
  authorityId: string;
  ordinal: number;
  partitionId: string;
  keyDigest: string;
  key: Record<string, string | number | boolean>;
  sourcePageOrdinal: number;
  sourceRecordOrdinal: number;
  resultHandleId: string;
  settledResultDigest: string;
}

export type SealAutomationPartitionAuthorityResult =
  | { ok: true; state: 'sealed' | 'replayed'; authority: AutomationPartitionAuthorityV1 }
  | { ok: false; code: string; reason: string };

export type AdmitAutomationPartitionAuthorityResult =
  | {
      ok: true;
      state: 'admitted' | 'replayed';
      authority: AutomationPartitionAuthorityV1;
      plan: FanoutPlanRow;
    }
  | { ok: false; code: string; reason: string };

interface AuthorityRow {
  authority_id: string;
  proposal_id: string;
  proposal_revision: number;
  proposal_digest: string;
  review_projection_id: string;
  review_approval_id: string;
  review_args_digest: string;
  occurrence_id: string;
  partition_projection_digest: string;
  key_fields_json: string;
  dimensions_json: string;
  invocation_plan_digest: string;
  execution_kind: 'single_read' | 'paginated_read';
  source_activation_id: string;
  source_activation_digest: string;
  source_authority_root_id: string;
  aggregate_receipt_id: string | null;
  aggregate_receipt_digest: string | null;
  page_count: number;
  result_handle_digest: string;
  partition_count: number;
  ledger_digest: string;
  max_concurrent_partitions: number;
  max_attempts_per_partition: number;
  status: AuthorityStatus;
  fanout_plan_id: string | null;
  created_at: string;
  updated_at: string;
}

interface PartitionRow {
  authority_id: string;
  ordinal: number;
  partition_id: string;
  key_digest: string;
  key_json: string;
  source_page_ordinal: number;
  source_record_ordinal: number;
  result_handle_id: string;
  settled_result_digest: string;
}

interface SourcePageRow {
  authority_id: string;
  page_ordinal: number;
  page_receipt_id: string;
  page_receipt_digest: string;
  result_handle_id: string;
  settled_result_digest: string;
  exhausted: number;
  item_count: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS automation_partition_authorities (
  authority_id                 TEXT PRIMARY KEY,
  proposal_id                  TEXT NOT NULL,
  proposal_revision            INTEGER NOT NULL CHECK (proposal_revision >= 1),
  proposal_digest              TEXT NOT NULL CHECK (length(proposal_digest) = 64),
  review_projection_id         TEXT NOT NULL,
  review_approval_id           TEXT NOT NULL,
  review_args_digest           TEXT NOT NULL CHECK (length(review_args_digest) = 64),
  occurrence_id                TEXT NOT NULL,
  partition_projection_digest  TEXT NOT NULL CHECK (length(partition_projection_digest) = 64),
  key_fields_json              TEXT NOT NULL,
  dimensions_json              TEXT NOT NULL,
  invocation_plan_digest       TEXT NOT NULL CHECK (length(invocation_plan_digest) = 64),
  execution_kind               TEXT NOT NULL CHECK (execution_kind IN ('single_read','paginated_read')),
  source_activation_id         TEXT NOT NULL,
  source_activation_digest     TEXT NOT NULL CHECK (length(source_activation_digest) = 64),
  source_authority_root_id      TEXT NOT NULL,
  aggregate_receipt_id         TEXT,
  aggregate_receipt_digest     TEXT CHECK (aggregate_receipt_digest IS NULL OR length(aggregate_receipt_digest) = 64),
  page_count                   INTEGER NOT NULL CHECK (page_count >= 1),
  result_handle_digest         TEXT NOT NULL CHECK (length(result_handle_digest) = 64),
  partition_count              INTEGER NOT NULL CHECK (partition_count >= 1),
  ledger_digest                TEXT NOT NULL CHECK (length(ledger_digest) = 64),
  max_concurrent_partitions    INTEGER NOT NULL CHECK (max_concurrent_partitions >= 1),
  max_attempts_per_partition   INTEGER NOT NULL CHECK (max_attempts_per_partition >= 1),
  status                       TEXT NOT NULL CHECK (status IN ('sealed','admitted')),
  fanout_plan_id               TEXT,
  created_at                   TEXT NOT NULL,
  updated_at                   TEXT NOT NULL,
  UNIQUE (proposal_digest, occurrence_id)
);

CREATE TABLE IF NOT EXISTS automation_partition_source_pages (
  authority_id          TEXT NOT NULL,
  page_ordinal          INTEGER NOT NULL CHECK (page_ordinal >= 0),
  page_receipt_id       TEXT NOT NULL,
  page_receipt_digest   TEXT NOT NULL CHECK (length(page_receipt_digest) = 64),
  result_handle_id      TEXT NOT NULL,
  settled_result_digest TEXT NOT NULL CHECK (length(settled_result_digest) = 64),
  exhausted             INTEGER NOT NULL CHECK (exhausted IN (0,1)),
  item_count            INTEGER NOT NULL CHECK (item_count >= 0),
  PRIMARY KEY (authority_id, page_ordinal),
  UNIQUE (authority_id, result_handle_id),
  FOREIGN KEY (authority_id) REFERENCES automation_partition_authorities(authority_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS automation_partitions (
  authority_id          TEXT NOT NULL,
  ordinal               INTEGER NOT NULL CHECK (ordinal >= 0),
  partition_id          TEXT NOT NULL,
  key_digest            TEXT NOT NULL CHECK (length(key_digest) = 64),
  key_json              TEXT NOT NULL,
  source_page_ordinal   INTEGER NOT NULL CHECK (source_page_ordinal >= 0),
  source_record_ordinal INTEGER NOT NULL CHECK (source_record_ordinal >= 0),
  result_handle_id      TEXT NOT NULL,
  settled_result_digest TEXT NOT NULL CHECK (length(settled_result_digest) = 64),
  PRIMARY KEY (authority_id, partition_id),
  UNIQUE (authority_id, ordinal),
  UNIQUE (authority_id, key_digest),
  FOREIGN KEY (authority_id) REFERENCES automation_partition_authorities(authority_id) ON DELETE CASCADE,
  FOREIGN KEY (authority_id, source_page_ordinal)
    REFERENCES automation_partition_source_pages(authority_id, page_ordinal)
);

CREATE INDEX IF NOT EXISTS automation_partition_authorities_status
  ON automation_partition_authorities(status, updated_at, authority_id);
`;

let handle: Database.Database | null = null;
let handlePath = '';

function database(): Database.Database {
  const dir = path.join(BASE_DIR, 'state', 'automation-partitions');
  const file = path.join(dir, 'automation-partitions.db');
  if (handle && handlePath === file) return handle;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  handle = new Database(file);
  handlePath = file;
  handle.pragma('journal_mode = WAL');
  handle.pragma('synchronous = FULL');
  handle.pragma('foreign_keys = ON');
  handle.pragma('busy_timeout = 10000');
  handle.exec(SCHEMA);
  return handle;
}

export function closeAutomationPartitionAuthorityForTests(): void {
  handle?.close();
  handle = null;
  handlePath = '';
}

function canonicalJson(value: unknown): string {
  return closedCanonicalJson(value, {
    maxDepth: 40,
    maxNodes: 50_000,
    maxStringBytes: 128_000,
    maxTotalBytes: 2_000_000,
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function digestValue(domain: string, value: unknown): string {
  return sha256(canonicalJson({ domain, version: AUTOMATION_PARTITION_AUTHORITY_VERSION, value }));
}

function exactId(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && ID_RE.test(value);
}

function exactDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_RE.test(value);
}

function boundedReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_REASON_BYTES);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function pathSegments(value: string): Array<string | number> | null {
  const segments: Array<string | number> = [];
  let cursor = 0;
  while (cursor < value.length) {
    const property = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(value.slice(cursor));
    if (!property || ['__proto__', 'prototype', 'constructor'].includes(property[0])) return null;
    segments.push(property[0]);
    cursor += property[0].length;
    while (value[cursor] === '[') {
      const index = /^\[(0|[1-9]\d*)\]/.exec(value.slice(cursor));
      if (!index) return null;
      segments.push(Number(index[1]));
      cursor += index[0].length;
    }
    if (cursor === value.length) break;
    if (value[cursor] !== '.') return null;
    cursor += 1;
  }
  return segments;
}

function valueAtPath(value: unknown, expression: string): unknown {
  const segments = pathSegments(expression);
  if (!segments) return undefined;
  let current = value;
  for (const segment of segments) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current) || segment >= current.length) return undefined;
      current = current[segment];
    } else {
      if (!plainRecord(current) || !Object.hasOwn(current, segment)) return undefined;
      current = current[segment];
    }
  }
  return current;
}

function exactPartitionValue(
  value: unknown,
  field: WorkflowCanonicalEntityFieldProjectionV1,
): string | number | boolean | null {
  if (field.type === 'string' || field.type === 'timestamp') {
    if (typeof value !== 'string') return null;
    const normalized = value.normalize('NFC');
    return normalized.length > 0 && normalized === normalized.trim() ? normalized : null;
  }
  if (field.type === 'number') {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
  if (field.type === 'boolean') return typeof value === 'boolean' ? value : null;
  return null;
}

function approvedReviewFor(
  proposal: AutomationOpportunityProposalRecordV1,
): { ok: true; review: AutomationOpportunityReviewProjectionV1 }
  | { ok: false; code: string; reason: string } {
  const matches = listAutomationOpportunityReviewProjections({
    status: 'approved',
    proposalId: proposal.proposalId,
    limit: 2,
  })
    .filter((review) => (
      review.proposalId === proposal.proposalId
      && review.proposalDigest === proposal.digest
      && review.reviewedRevision + 1 === proposal.revision
      && review.approvalId
    ));
  if (matches.length === 0) {
    return { ok: false, code: 'approved_review_missing', reason: 'The exact approved proposal has no resolved human review projection.' };
  }
  if (matches.length !== 1) {
    return { ok: false, code: 'approved_review_ambiguous', reason: 'More than one human review projection claims this proposal revision.' };
  }
  return { ok: true, review: matches[0]! };
}

function exactApprovedProposal(input: {
  proposalId: string;
  proposalRevision: number;
  proposalDigest: string;
}): { ok: true; proposal: AutomationOpportunityProposalRecordV1; review: AutomationOpportunityReviewProjectionV1 }
  | { ok: false; code: string; reason: string } {
  if (!exactId(input.proposalId) || !Number.isSafeInteger(input.proposalRevision)
    || input.proposalRevision < 1 || !exactDigest(input.proposalDigest)) {
    return { ok: false, code: 'proposal_lineage_invalid', reason: 'Automation proposal lineage is malformed.' };
  }
  const proposal = loadAutomationOpportunityProposal(input.proposalId);
  if (!proposal) return { ok: false, code: 'proposal_missing', reason: 'Automation proposal is missing.' };
  if (proposal.status !== 'approved') {
    return { ok: false, code: 'proposal_not_approved', reason: 'Partition enumeration requires a separately approved proposal.' };
  }
  if (proposal.revision !== input.proposalRevision || proposal.digest !== input.proposalDigest) {
    return { ok: false, code: 'proposal_stale', reason: 'Automation proposal revision or digest is stale.' };
  }
  if (proposal.opportunity.partition.mode !== 'finite') {
    return { ok: false, code: 'partition_universe_not_closed', reason: 'Only a reviewed finite partition universe can be sealed.' };
  }
  if (!proposal.opportunity.phases.some((phase) => phase.partitioned)) {
    return { ok: false, code: 'partition_work_missing', reason: 'The approved proposal contains no partitioned phase to execute.' };
  }
  const review = approvedReviewFor(proposal);
  return review.ok ? { ok: true, proposal, review: review.review } : review;
}

function keyProjection(input: {
  proposal: AutomationOpportunityProposalRecordV1;
  plan: WorkflowNodeInvocationPlanV1;
}): { ok: true; projection: WorkflowCanonicalEntityResultProjection; fields: WorkflowCanonicalEntityFieldProjectionV1[]; digest: string }
  | { ok: false; code: string; reason: string } {
  const parsed = parseWorkflowCanonicalEntityResultProjection(input.plan.resultProjection);
  if (!parsed.ok) {
    return { ok: false, code: 'partition_projection_missing', reason: `The settled read has no valid reviewed result projection: ${parsed.errors.join(' ')}` };
  }
  const keyFields = input.proposal.opportunity.partition.mode === 'finite'
    ? input.proposal.opportunity.partition.keyFields
    : [];
  const mappings: WorkflowCanonicalEntityFieldProjectionV1[] = [];
  for (const key of keyFields) {
    const field = parsed.contract.fields.find((candidate) => candidate.field === key);
    if (!field || !field.required || !['string', 'timestamp', 'number', 'boolean'].includes(field.type)) {
      return {
        ok: false,
        code: 'partition_key_unrepresented',
        reason: `Reviewed partition key "${key}" is not a required scalar in the settled result projection.`,
      };
    }
    mappings.push(field);
  }
  const digest = digestValue('automation-partition-key-projection', {
    proposalDigest: input.proposal.digest,
    partition: input.proposal.opportunity.partition,
    resultProjectionDigest: parsed.contract.projectionDigest,
    invocationPlanDigest: input.plan.bindingDigest,
    mappings: mappings.map((field) => ({
      field: field.field,
      recordPath: field.recordPath,
      type: field.type,
      required: field.required,
    })),
  });
  return { ok: true, projection: parsed.contract, fields: mappings, digest };
}

function partitionShapeIssue(input: {
  proposal: AutomationOpportunityProposalRecordV1;
  plan: WorkflowNodeInvocationPlanV1;
  sourceNodeId: string;
}): string | null {
  const phases = input.proposal.opportunity.phases;
  const source = phases.find((phase) => phase.id === input.sourceNodeId);
  if (!source || source.partitioned || source.effect.class !== 'read'
    || input.plan.binding.effect !== 'read'
    || !source.capabilityRequirementIds.includes(input.plan.requirementId)) {
    return 'The settled enumeration is not the exact unpartitioned read phase reviewed by the proposal.';
  }
  const unpartitioned = phases.filter((phase) => !phase.partitioned);
  if (unpartitioned.length !== 1 || unpartitioned[0]?.id !== source.id) {
    return 'This release lane supports one settled enumeration phase followed only by partitioned phases.';
  }
  const byId = new Map(phases.map((phase) => [phase.id, phase]));
  for (const phase of phases.filter((candidate) => candidate.partitioned)) {
    const visited = new Set<string>();
    const pending = [...phase.dependsOn];
    let reachesSource = false;
    while (pending.length > 0) {
      const dependency = pending.pop()!;
      if (visited.has(dependency)) continue;
      visited.add(dependency);
      if (dependency === source.id) {
        reachesSource = true;
        continue;
      }
      const dependencyPhase = byId.get(dependency);
      if (!dependencyPhase?.partitioned) {
        return `Partitioned phase "${phase.id}" depends on work not represented by the normalized partition ledger.`;
      }
      pending.push(...dependencyPhase.dependsOn);
    }
    if (!reachesSource) {
      return `Partitioned phase "${phase.id}" is not downstream of the exact settled enumeration.`;
    }
  }
  return null;
}

interface PreparedPartition {
  partitionId: string;
  keyDigest: string;
  keyJson: string;
  key: Record<string, string | number | boolean>;
  sourcePageOrdinal: number;
  sourceRecordOrdinal: number;
  resultHandleId: string;
  settledResultDigest: string;
}

function preparePartitions(input: {
  redeemed: VerifiedClosedWorkflowReadResultV1;
  projection: WorkflowCanonicalEntityResultProjection;
  keyFields: WorkflowCanonicalEntityFieldProjectionV1[];
}): { ok: true; partitions: PreparedPartition[] }
  | { ok: false; code: string; reason: string } {
  const partitions: PreparedPartition[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const [pageIndex, page] of input.redeemed.pages.entries()) {
    if (page.pageOrdinal !== pageIndex
      || page.rawByteCount > input.projection.bounds.maxPageBytes
      || page.itemCount > input.projection.bounds.maxRecordsPerPage) {
      return { ok: false, code: 'partition_source_bounds_exceeded', reason: 'Settled page order, byte count, or item count exceeds the reviewed projection.' };
    }
    totalBytes += page.rawByteCount;
    const evidence = projectProviderResultEvidenceView(page.rawPayload);
    if (evidence.kind !== 'provider_payload') {
      return { ok: false, code: 'partition_records_invalid', reason: 'Settled page has no unambiguous provider result payload.' };
    }
    const records = valueAtPath(evidence.payload, input.projection.recordsPath);
    if (!Array.isArray(records) || records.length !== page.itemCount) {
      return { ok: false, code: 'partition_records_invalid', reason: 'Reviewed records path does not match the settled page item count.' };
    }
    for (const [recordOrdinal, record] of records.entries()) {
      if (!plainRecord(record)) {
        return { ok: false, code: 'partition_records_invalid', reason: 'A settled partition source record is not a closed object.' };
      }
      let recordJson: string;
      try { recordJson = canonicalJson(record); }
      catch { return { ok: false, code: 'partition_records_invalid', reason: 'A settled partition source record is outside bounded JSON.' }; }
      if (Buffer.byteLength(recordJson, 'utf8') > input.projection.bounds.maxRecordBytes) {
        return { ok: false, code: 'partition_source_bounds_exceeded', reason: 'A settled partition source record exceeds its reviewed byte ceiling.' };
      }
      const key: Record<string, string | number | boolean> = {};
      for (const mapping of input.keyFields) {
        const value = exactPartitionValue(valueAtPath(record, mapping.recordPath), mapping);
        if (value === null) {
          return { ok: false, code: 'partition_key_invalid', reason: `Partition key "${mapping.field}" is missing, non-scalar, or non-canonical.` };
        }
        key[mapping.field] = value;
      }
      const keyJson = canonicalJson(key);
      const keyDigest = digestValue('automation-partition-key', key);
      if (seen.has(keyDigest)) {
        return { ok: false, code: 'partition_key_ambiguous', reason: 'Two settled records project to the same reviewed partition key.' };
      }
      seen.add(keyDigest);
      partitions.push({
        partitionId: `automation-partition:v1:${keyDigest}`,
        keyDigest,
        keyJson,
        key,
        sourcePageOrdinal: page.pageOrdinal,
        sourceRecordOrdinal: recordOrdinal,
        resultHandleId: page.resultHandleId,
        settledResultDigest: page.settledResultDigest,
      });
    }
  }
  if (totalBytes > input.projection.bounds.maxTotalBytes
    || partitions.length > input.projection.bounds.maxRecords) {
    return { ok: false, code: 'partition_source_bounds_exceeded', reason: 'Closed result exceeds its reviewed total byte or record ceiling.' };
  }
  partitions.sort((left, right) => left.keyJson.localeCompare(right.keyJson)
    || left.keyDigest.localeCompare(right.keyDigest));
  return { ok: true, partitions };
}

interface ResultHandleDigestPage {
  pageOrdinal: number;
  pageReceiptId: string;
  pageReceiptDigest: string;
  resultHandleId: string;
  settledResultDigest: string;
  exhausted: boolean;
  itemCount: number;
}

function resultHandleDigest(pages: readonly ResultHandleDigestPage[]): string {
  const hash = createHash('sha256');
  hash.update('automation-partition-result-handles:v1\n', 'utf8');
  for (const page of pages) {
    hash.update(canonicalJson({
      pageOrdinal: page.pageOrdinal,
      pageReceiptId: page.pageReceiptId,
      pageReceiptDigest: page.pageReceiptDigest,
      resultHandleId: page.resultHandleId,
      settledResultDigest: page.settledResultDigest,
      exhausted: page.exhausted,
      itemCount: page.itemCount,
    }), 'utf8');
    hash.update('\n', 'utf8');
  }
  return hash.digest('hex');
}

function authorityIdentityValue(authority: AutomationPartitionAuthorityV1): Record<string, unknown> {
  return {
    proposalId: authority.proposalId,
    proposalRevision: authority.proposalRevision,
    proposalDigest: authority.proposalDigest,
    reviewProjectionId: authority.reviewProjectionId,
    reviewApprovalId: authority.reviewApprovalId,
    reviewArgsDigest: authority.reviewArgsDigest,
    occurrenceId: authority.occurrenceId,
    partitionProjectionDigest: authority.partitionProjectionDigest,
    keyFields: authority.keyFields,
    dimensions: authority.dimensions,
    invocationPlanDigest: authority.invocationPlanDigest,
    source: authority.source,
    partitionCount: authority.partitionCount,
    ledgerDigest: authority.ledgerDigest,
    maxConcurrentPartitions: authority.maxConcurrentPartitions,
    maxAttemptsPerPartition: authority.maxAttemptsPerPartition,
  };
}

function ledgerDigest(partitions: readonly PreparedPartition[] | readonly AutomationPartitionRowV1[]): string {
  const hash = createHash('sha256');
  hash.update('automation-partition-ledger:v1\n', 'utf8');
  for (const [ordinal, partition] of partitions.entries()) {
    hash.update(canonicalJson({
      ordinal,
      partitionId: partition.partitionId,
      keyDigest: partition.keyDigest,
      key: partition.key,
      sourcePageOrdinal: partition.sourcePageOrdinal,
      sourceRecordOrdinal: partition.sourceRecordOrdinal,
      resultHandleId: partition.resultHandleId,
      settledResultDigest: partition.settledResultDigest,
    }), 'utf8');
    hash.update('\n', 'utf8');
  }
  return hash.digest('hex');
}

function rowToAuthority(row: AuthorityRow): AutomationPartitionAuthorityV1 {
  return {
    version: AUTOMATION_PARTITION_AUTHORITY_VERSION,
    authorityId: row.authority_id,
    proposalId: row.proposal_id,
    proposalRevision: row.proposal_revision,
    proposalDigest: row.proposal_digest,
    reviewProjectionId: row.review_projection_id,
    reviewApprovalId: row.review_approval_id,
    reviewArgsDigest: row.review_args_digest,
    occurrenceId: row.occurrence_id,
    partitionProjectionDigest: row.partition_projection_digest,
    keyFields: JSON.parse(row.key_fields_json) as string[],
    dimensions: JSON.parse(row.dimensions_json) as string[],
    invocationPlanDigest: row.invocation_plan_digest,
    source: {
      executionKind: row.execution_kind,
      activationId: row.source_activation_id,
      activationDigest: row.source_activation_digest,
      authorityRootId: row.source_authority_root_id,
      ...(row.aggregate_receipt_id ? { aggregateReceiptId: row.aggregate_receipt_id } : {}),
      ...(row.aggregate_receipt_digest ? { aggregateReceiptDigest: row.aggregate_receipt_digest } : {}),
      pageCount: row.page_count,
      resultHandleDigest: row.result_handle_digest,
      exhausted: true,
    },
    partitionCount: row.partition_count,
    ledgerDigest: row.ledger_digest,
    maxConcurrentPartitions: row.max_concurrent_partitions,
    maxAttemptsPerPartition: row.max_attempts_per_partition,
    status: row.status,
    ...(row.fanout_plan_id ? { fanoutPlanId: row.fanout_plan_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rawAuthority(authorityId: string): AuthorityRow | undefined {
  return database().prepare(
    'SELECT * FROM automation_partition_authorities WHERE authority_id = ?',
  ).get(authorityId) as AuthorityRow | undefined;
}

function rawOccurrenceAuthority(proposalDigest: string, occurrenceId: string): AuthorityRow | undefined {
  return database().prepare(`
    SELECT * FROM automation_partition_authorities
     WHERE proposal_digest = ? AND occurrence_id = ?
  `).get(proposalDigest, occurrenceId) as AuthorityRow | undefined;
}

function rawPartitions(authorityId: string): PartitionRow[] {
  return database().prepare(
    'SELECT * FROM automation_partitions WHERE authority_id = ? ORDER BY ordinal',
  ).all(authorityId) as PartitionRow[];
}

function projectPartition(row: PartitionRow): AutomationPartitionRowV1 | null {
  try {
    const key = JSON.parse(row.key_json) as Record<string, string | number | boolean>;
    if (!plainRecord(key) || canonicalJson(key) !== row.key_json
      || digestValue('automation-partition-key', key) !== row.key_digest
      || row.partition_id !== `automation-partition:v1:${row.key_digest}`) return null;
    return {
      authorityId: row.authority_id,
      ordinal: row.ordinal,
      partitionId: row.partition_id,
      keyDigest: row.key_digest,
      key,
      sourcePageOrdinal: row.source_page_ordinal,
      sourceRecordOrdinal: row.source_record_ordinal,
      resultHandleId: row.result_handle_id,
      settledResultDigest: row.settled_result_digest,
    };
  } catch {
    return null;
  }
}

function authorityIntegrity(row: AuthorityRow): AutomationPartitionAuthorityV1 | null {
  try {
    const authority = rowToAuthority(row);
    const partitions = rawPartitions(row.authority_id).map(projectPartition);
    const pages = database().prepare(
      'SELECT * FROM automation_partition_source_pages WHERE authority_id = ? ORDER BY page_ordinal',
    ).all(row.authority_id) as SourcePageRow[];
    if (!exactId(authority.authorityId) || !exactId(authority.occurrenceId)
      || authority.authorityId !== `automation-partition-authority:v1:${digestValue(
        'automation-partition-authority', authorityIdentityValue(authority),
      )}`
      || partitions.some((partition) => !partition)
      || partitions.length !== authority.partitionCount
      || partitions.some((partition, ordinal) => partition?.ordinal !== ordinal)
      || ledgerDigest(partitions as AutomationPartitionRowV1[]) !== authority.ledgerDigest
      || pages.length !== authority.source.pageCount
      || pages.some((page, ordinal) => page.page_ordinal !== ordinal)
      || pages.at(-1)?.exhausted !== 1
      || pages.slice(0, -1).some((page) => page.exhausted !== 0)
      || resultHandleDigest(pages.map((page) => ({
        pageOrdinal: page.page_ordinal,
        pageReceiptId: page.page_receipt_id,
        pageReceiptDigest: page.page_receipt_digest,
        resultHandleId: page.result_handle_id,
        settledResultDigest: page.settled_result_digest,
        exhausted: page.exhausted === 1,
        itemCount: page.item_count,
      }))) !== authority.source.resultHandleDigest) return null;
    return authority;
  } catch {
    return null;
  }
}

export function loadAutomationPartitionAuthority(
  authorityId: string,
): AutomationPartitionAuthorityV1 | undefined {
  const row = exactId(authorityId) ? rawAuthority(authorityId) : undefined;
  return row ? authorityIntegrity(row) ?? undefined : undefined;
}

export function listAutomationPartitions(
  authorityId: string,
  input: { offset?: number; limit?: number } = {},
): AutomationPartitionRowV1[] {
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 256;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError('partition page requires offset >= 0 and limit from 1 through 1000');
  }
  if (!loadAutomationPartitionAuthority(authorityId)) return [];
  const rows = database().prepare(`
    SELECT * FROM automation_partitions WHERE authority_id = ?
     ORDER BY ordinal LIMIT ? OFFSET ?
  `).all(authorityId, limit, offset) as PartitionRow[];
  return rows.map(projectPartition).filter((row): row is AutomationPartitionRowV1 => Boolean(row));
}

export function sealAutomationPartitionAuthority(input: {
  proposalId: string;
  proposalRevision: number;
  proposalDigest: string;
  occurrenceId: string;
  root: CanonicalEntityWorkflowResultRootV1;
  invocationPlan: unknown;
}): SealAutomationPartitionAuthorityResult {
  try {
    const approved = exactApprovedProposal(input);
    if (!approved.ok) return approved;
    if (!exactId(input.occurrenceId)
      || input.root.version !== 1
      || input.root.lineage.runOccurrenceId !== input.occurrenceId) {
      return { ok: false, code: 'occurrence_lineage_mismatch', reason: 'Partition occurrence does not match the settled workflow read.' };
    }
    const parsedPlan = parseWorkflowNodeInvocationPlan(input.invocationPlan);
    if (!parsedPlan.ok || parsedPlan.plan.bindingDigest !== input.root.lineage.invocationPlanDigest) {
      return { ok: false, code: 'invocation_plan_drift', reason: 'Settled read and supplied invocation plan do not share exact reviewed bytes.' };
    }
    const shapeIssue = partitionShapeIssue({
      proposal: approved.proposal,
      plan: parsedPlan.plan,
      sourceNodeId: input.root.lineage.nodeId,
    });
    if (shapeIssue) {
      return { ok: false, code: 'partition_shape_unsupported', reason: shapeIssue };
    }
    const key = keyProjection({ proposal: approved.proposal, plan: parsedPlan.plan });
    if (!key.ok) return key;
    const redeemed = redeemVerifiedClosedWorkflowReadResult({
      executionKind: input.root.executionKind,
      activationId: input.root.activationId,
      lineage: input.root.lineage,
    });
    if (!redeemed.ok) {
      return { ok: false, code: 'partition_source_not_closed', reason: redeemed.reason };
    }
    if (redeemed.value.pages.length < 1
      || redeemed.value.pages.at(-1)?.exhausted !== true
      || redeemed.value.pages.slice(0, -1).some((page) => page.exhausted)) {
      return { ok: false, code: 'partition_source_not_exhaustive', reason: 'Settled result does not prove one exact exhausted page chain.' };
    }
    const prepared = preparePartitions({
      redeemed: redeemed.value,
      projection: key.projection,
      keyFields: key.fields,
    });
    if (!prepared.ok) return prepared;
    const partition = approved.proposal.opportunity.partition;
    if (partition.mode !== 'finite') {
      return { ok: false, code: 'partition_universe_not_closed', reason: 'Partition contract is not finite.' };
    }
    if (prepared.partitions.length < 1) {
      return { ok: false, code: 'partition_universe_empty', reason: 'Closed enumeration produced no partition identities.' };
    }
    if (partition.completion.kind === 'exact_count'
      && prepared.partitions.length !== partition.completion.expected) {
      return { ok: false, code: 'partition_count_mismatch', reason: 'Closed enumeration differs from the reviewed exact partition count.' };
    }
    if (prepared.partitions.length > approved.proposal.opportunity.budgets.maxPartitionsPerRun) {
      return { ok: false, code: 'partition_run_budget_exceeded', reason: 'Closed enumeration exceeds the approved per-occurrence partition budget.' };
    }
    const digest = ledgerDigest(prepared.partitions);
    const handlesDigest = resultHandleDigest(redeemed.value.pages);
    const identityAuthority: AutomationPartitionAuthorityV1 = {
      version: AUTOMATION_PARTITION_AUTHORITY_VERSION,
      authorityId: '',
      proposalId: approved.proposal.proposalId,
      proposalRevision: approved.proposal.revision,
      proposalDigest: approved.proposal.digest,
      reviewProjectionId: approved.review.projectionId,
      reviewApprovalId: approved.review.approvalId!,
      reviewArgsDigest: approved.review.approvalArgsDigest,
      occurrenceId: input.occurrenceId,
      partitionProjectionDigest: key.digest,
      keyFields: partition.keyFields,
      dimensions: partition.dimensions,
      invocationPlanDigest: parsedPlan.plan.bindingDigest,
      source: {
        executionKind: redeemed.value.executionKind,
        activationId: redeemed.value.activationId,
        activationDigest: redeemed.value.activationDigest,
        authorityRootId: redeemed.value.authorityRootId,
        ...(redeemed.value.aggregateReceiptId
          ? { aggregateReceiptId: redeemed.value.aggregateReceiptId }
          : {}),
        ...(redeemed.value.aggregateReceiptDigest
          ? { aggregateReceiptDigest: redeemed.value.aggregateReceiptDigest }
          : {}),
        pageCount: redeemed.value.pages.length,
        resultHandleDigest: handlesDigest,
        exhausted: true,
      },
      partitionCount: prepared.partitions.length,
      ledgerDigest: digest,
      maxConcurrentPartitions: approved.proposal.opportunity.budgets.maxConcurrentPartitions,
      maxAttemptsPerPartition: approved.proposal.opportunity.budgets.maxAttemptsPerPartition,
      status: 'sealed',
      createdAt: '',
      updatedAt: '',
    };
    const authorityId = `automation-partition-authority:v1:${digestValue(
      'automation-partition-authority', authorityIdentityValue(identityAuthority),
    )}`;
    const at = new Date().toISOString();
    const db = database();
    const write = db.transaction((): AutomationPartitionAuthorityV1 => {
      const existingOccurrence = db.prepare(`
        SELECT * FROM automation_partition_authorities
         WHERE proposal_digest = ? AND occurrence_id = ?
      `).get(approved.proposal.digest, input.occurrenceId) as AuthorityRow | undefined;
      if (existingOccurrence) {
        if (existingOccurrence.authority_id !== authorityId) {
          throw new Error('occurrence_conflict: the same proposal occurrence names different source or partition authority');
        }
        const replay = authorityIntegrity(existingOccurrence);
        if (!replay) throw new Error('authority_integrity_failure: stored partition authority does not replay');
        return replay;
      }
      db.prepare(`
        INSERT INTO automation_partition_authorities (
          authority_id, proposal_id, proposal_revision, proposal_digest,
          review_projection_id, review_approval_id, review_args_digest,
          occurrence_id, partition_projection_digest, key_fields_json,
          dimensions_json, invocation_plan_digest, execution_kind,
          source_activation_id, source_activation_digest, source_authority_root_id,
          aggregate_receipt_id, aggregate_receipt_digest, page_count,
          result_handle_digest, partition_count, ledger_digest,
          max_concurrent_partitions, max_attempts_per_partition,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sealed', ?, ?)
      `).run(
        authorityId, approved.proposal.proposalId, approved.proposal.revision,
        approved.proposal.digest, approved.review.projectionId, approved.review.approvalId,
        approved.review.approvalArgsDigest, input.occurrenceId, key.digest,
        JSON.stringify(partition.keyFields), JSON.stringify(partition.dimensions),
        parsedPlan.plan.bindingDigest, redeemed.value.executionKind,
        redeemed.value.activationId, redeemed.value.activationDigest,
        redeemed.value.authorityRootId, redeemed.value.aggregateReceiptId ?? null,
        redeemed.value.aggregateReceiptDigest ?? null, redeemed.value.pages.length,
        handlesDigest, prepared.partitions.length, digest,
        approved.proposal.opportunity.budgets.maxConcurrentPartitions,
        approved.proposal.opportunity.budgets.maxAttemptsPerPartition, at, at,
      );
      const pageInsert = db.prepare(`
        INSERT INTO automation_partition_source_pages (
          authority_id, page_ordinal, page_receipt_id, page_receipt_digest,
          result_handle_id, settled_result_digest, exhausted, item_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const page of redeemed.value.pages) {
        pageInsert.run(
          authorityId, page.pageOrdinal, page.pageReceiptId, page.pageReceiptDigest,
          page.resultHandleId, page.settledResultDigest, page.exhausted ? 1 : 0, page.itemCount,
        );
      }
      const partitionInsert = db.prepare(`
        INSERT INTO automation_partitions (
          authority_id, ordinal, partition_id, key_digest, key_json,
          source_page_ordinal, source_record_ordinal, result_handle_id,
          settled_result_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const [ordinal, item] of prepared.partitions.entries()) {
        partitionInsert.run(
          authorityId, ordinal, item.partitionId, item.keyDigest, item.keyJson,
          item.sourcePageOrdinal, item.sourceRecordOrdinal, item.resultHandleId,
          item.settledResultDigest,
        );
      }
      const retained = rawAuthority(authorityId);
      const projected = retained ? authorityIntegrity(retained) : null;
      if (!projected) throw new Error('authority_integrity_failure: partition authority did not round-trip');
      return projected;
    });
    const before = rawAuthority(authorityId);
    const authority = write.immediate();
    return { ok: true, state: before ? 'replayed' : 'sealed', authority };
  } catch (error) {
    const reason = boundedReason(error);
    return {
      ok: false,
      code: reason.startsWith('occurrence_conflict:') ? 'occurrence_conflict'
        : reason.startsWith('authority_integrity_failure:') ? 'authority_integrity_failure'
          : 'partition_authority_storage_error',
      reason,
    };
  }
}

function fanoutDisposition(input: {
  authority: AutomationPartitionAuthorityV1;
  proposal: AutomationOpportunityProposalRecordV1;
  partitions: AutomationPartitionRowV1[];
}): WorkDisposition | null {
  const partitioned = input.proposal.opportunity.phases.filter((phase) => phase.partitioned);
  if (partitioned.length === 0) return null;
  const partitionedIds = new Set(partitioned.map((phase) => phase.id));
  return {
    kind: 'durable_manifest',
    objective: input.proposal.opportunity.objective,
    successCriteria: input.proposal.opportunity.successCriteria.map((criterion) => criterion.description),
    missingRequiredInputs: input.proposal.opportunity.missingInputs
      .filter((missing) => missing.required)
      .map((missing) => missing.description),
    effectCeiling: input.proposal.opportunity.effectCeiling.class === 'read' ? 'read' : 'write',
    estimatedActivations: input.partitions.length * partitioned.length,
    manifest: {
      manifestId: input.authority.authorityId,
      contractVersion: 'automation-partition-v1',
      canonicalItems: input.partitions.map((partition) => ({
        id: partition.partitionId,
        inputRef: `automation-partition-row:v1:${input.authority.authorityId}:${partition.ordinal}`,
      })),
      phases: partitioned.map((phase) => ({
        id: phase.id,
        dependsOn: phase.dependsOn.filter((dependency) => partitionedIds.has(dependency)),
        runnerClass: `automation_partition_${phase.effect.class}`,
      })),
      reducer: {
        id: `automation-partition-reducer:${input.authority.partitionProjectionDigest.slice(0, 24)}`,
        requiredPhases: partitioned.map((phase) => phase.id),
        outputContract: 'automation-partition-summary@1',
      },
    },
  };
}

export function admitAutomationPartitionAuthority(
  authorityId: string,
): AdmitAutomationPartitionAuthorityResult {
  try {
    const authority = loadAutomationPartitionAuthority(authorityId);
    if (!authority) return { ok: false, code: 'authority_missing_or_corrupt', reason: 'Partition authority is missing or failed integrity replay.' };
    const approved = exactApprovedProposal({
      proposalId: authority.proposalId,
      proposalRevision: authority.proposalRevision,
      proposalDigest: authority.proposalDigest,
    });
    if (!approved.ok) return approved;
    if (approved.review.projectionId !== authority.reviewProjectionId
      || approved.review.approvalId !== authority.reviewApprovalId
      || approved.review.approvalArgsDigest !== authority.reviewArgsDigest) {
      return { ok: false, code: 'approved_review_drift', reason: 'Partition authority no longer matches its exact human review lineage.' };
    }
    if (authority.status === 'admitted' && authority.fanoutPlanId) {
      const plan = loadFanoutPlan(authority.fanoutPlanId);
      return plan
        ? { ok: true, state: 'replayed', authority, plan }
        : { ok: false, code: 'fanout_plan_missing', reason: 'Partition authority names a missing durable fan-out plan.' };
    }
    const partitions: AutomationPartitionRowV1[] = [];
    for (let offset = 0; offset < authority.partitionCount; offset += 1_000) {
      partitions.push(...listAutomationPartitions(authorityId, { offset, limit: 1_000 }));
    }
    if (partitions.length !== authority.partitionCount) {
      return { ok: false, code: 'authority_integrity_failure', reason: 'Normalized partition rows are incomplete.' };
    }
    const disposition = fanoutDisposition({ authority, proposal: approved.proposal, partitions });
    if (!disposition) return { ok: false, code: 'partition_work_missing', reason: 'Approved proposal has no partitioned execution phase.' };
    const admitted = admitDurableFanoutPlan(disposition, {
      originSessionId: approved.review.ownerSessionId,
      sourceUserSeq: approved.review.requestSourceUserSeq,
      attemptId: authority.occurrenceId,
      route: { source: 'daemon' },
      maxConcurrentWindows: Math.min(
        authority.maxConcurrentPartitions,
        Math.max(1, Math.ceil(authority.partitionCount / 256)),
      ),
      maxWindowAttempts: authority.maxAttemptsPerPartition,
      contract: {
        automationPartitionAuthority: {
          version: authority.version,
          authorityId: authority.authorityId,
          proposalId: authority.proposalId,
          proposalRevision: authority.proposalRevision,
          proposalDigest: authority.proposalDigest,
          reviewProjectionId: authority.reviewProjectionId,
          occurrenceId: authority.occurrenceId,
          partitionProjectionDigest: authority.partitionProjectionDigest,
          sourceActivationDigest: authority.source.activationDigest,
          resultHandleDigest: authority.source.resultHandleDigest,
          partitionCount: authority.partitionCount,
          ledgerDigest: authority.ledgerDigest,
        },
      },
    });
    if (!admitted.ok) {
      return {
        ok: false,
        code: `fanout_${admitted.kind}`,
        reason: admitted.kind === 'needs_input' ? admitted.missing.join('; ') : admitted.errors.join('; '),
      };
    }
    const linked = database().prepare(`
      UPDATE automation_partition_authorities
         SET status = 'admitted', fanout_plan_id = ?, updated_at = ?
       WHERE authority_id = ? AND status = 'sealed' AND fanout_plan_id IS NULL
    `).run(admitted.plan.planId, new Date().toISOString(), authorityId);
    const retained = loadAutomationPartitionAuthority(authorityId);
    if (!retained || retained.fanoutPlanId !== admitted.plan.planId
      || (linked.changes !== 1 && retained.status !== 'admitted')) {
      return { ok: false, code: 'fanout_link_conflict', reason: 'Durable fan-out admission lost its authority link CAS.' };
    }
    return {
      ok: true,
      state: linked.changes === 1 ? 'admitted' : 'replayed',
      authority: retained,
      plan: admitted.plan,
    };
  } catch (error) {
    return { ok: false, code: 'partition_admission_failed', reason: boundedReason(error) };
  }
}

export type ReconcileAutomationPartitionRunResult =
  | { ok: true; state: 'admitted' | 'replayed'; authority: AutomationPartitionAuthorityV1; plan: FanoutPlanRow }
  | { ok: false; code: string; reason: string };

/** Production owner for one completed recurring enumeration run. */
export function reconcileAutomationPartitionRun(runId: string): ReconcileAutomationPartitionRunResult {
  if (!exactId(runId)) return { ok: false, code: 'run_identity_invalid', reason: 'Workflow run identity is malformed.' };
  let run: QueuedRunRecord | null;
  try { run = readWorkflowRunRecord<QueuedRunRecord>(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`)); }
  catch { run = null; }
  if (!run || run.id !== runId) return { ok: false, code: 'run_missing', reason: 'Workflow run record is missing.' };
  if (run.status !== 'completed' || run.terminalOutcome !== 'succeeded'
    || run.needsAttention === true || run.goalOutcome !== 'satisfied') {
    return { ok: false, code: 'run_not_clean', reason: 'Only a clean goal-satisfied completed enumeration may dispatch partition work.' };
  }
  const resolvedSnapshot = resolveWorkflowRunDefinitionSnapshot(run.workflowDefinitionSnapshot);
  if (resolvedSnapshot.status !== 'valid' || resolvedSnapshot.snapshot.version !== 1) {
    return { ok: false, code: 'run_snapshot_invalid', reason: 'Workflow run lacks an exact catalog definition snapshot.' };
  }
  const snapshot = resolvedSnapshot.snapshot as WorkflowRunDefinitionSnapshot;
  const candidate = run.workflowRecurringReadAdmission as Partial<WorkflowRecurringReadAdmissionV1> | undefined;
  if (!candidate?.authoritySnapshot || !candidate.activationAuthority?.activationId) {
    return { ok: false, code: 'recurrence_admission_missing', reason: 'Run has no exact standing recurrence admission.' };
  }
  // The runner checked live capability authority before the provider crossing.
  // This post-settlement consumer must replay that occurrence's frozen receipt
  // snapshot: later provider drift cannot erase an already-settled result, while
  // create/resolve below still rechecks the standing activation and exact bytes.
  const recurring = resolveWorkflowRecurringReadAdmission({
    value: run.workflowRecurringReadAdmission,
    runId,
    snapshot,
    currentAuthoritySnapshot: candidate.authoritySnapshot,
  });
  if (!recurring.ok) return { ok: false, code: 'recurrence_admission_invalid', reason: recurring.reason };
  const forbiddenLineage = run.source !== 'schedule'
    || run.workflowSlug !== snapshot.workflowSlug
    || run.triggerReceiptId !== recurring.admission.runOccurrenceId
    || run.acceptDisabled === true
    || run.targetStepId !== undefined
    || Boolean(run.catchupFire)
    || run.catchupDisposition !== undefined
    || run.catchupOccurrenceAtMs !== undefined
    || run.requeuedFromRunId !== undefined
    || run.retryFailedItemsFromRunId !== undefined
    || (run.selfHealAttempt ?? 0) > 0
    || (run.goalAttempt ?? 0) > 0;
  const runInputs = run.inputs ?? {};
  if (forbiddenLineage
    || Object.values(runInputs).some((value) => typeof value !== 'string')
    || workflowRecurringReadInputsDigest(runInputs) !== recurring.admission.workflowInputsDigest) {
    return { ok: false, code: 'recurrence_run_lineage_invalid', reason: 'Run queue source, occurrence receipt, inputs, or recovery lineage is outside the standing recurrence admission.' };
  }
  const root = run.canonicalEntityWorkflowResultRoot;
  if (!root || root.lineage.runId !== runId
    || root.lineage.runOccurrenceId !== recurring.admission.runOccurrenceId
    || root.lineage.workflowId !== recurring.admission.workflowId
    || root.lineage.workflowRevision !== recurring.admission.workflowRevision
    || root.lineage.workflowDigest !== recurring.admission.workflowDigest
    || root.lineage.nodeId !== recurring.admission.nodeId
    || root.lineage.nodeAttempt !== recurring.admission.nodeAttempt
    || root.lineage.invocationPlanDigest !== recurring.admission.invocationPlanDigest
    || root.lineage.bindingSnapshotDigest !== recurring.admission.bindingSnapshotDigest
    || root.lineage.controlDigest !== recurring.admission.controlDigest) {
    return { ok: false, code: 'result_root_lineage_mismatch', reason: 'Run result root and recurrence admission do not share exact lineage.' };
  }
  const step = snapshot.definition.steps.find((item) => item.id === recurring.admission.nodeId);
  if (!step?.invocationPlan) {
    return { ok: false, code: 'invocation_plan_missing', reason: 'Recurring enumeration node has no exact invocation plan.' };
  }
  const sealed = sealAutomationPartitionAuthority({
    proposalId: recurring.admission.proposalId,
    proposalRevision: recurring.admission.proposalRevision,
    proposalDigest: recurring.admission.proposalDigest,
    occurrenceId: recurring.admission.runOccurrenceId,
    root,
    invocationPlan: step.invocationPlan,
  });
  if (!sealed.ok) return sealed;
  return admitAutomationPartitionAuthority(sealed.authority.authorityId);
}

export interface ReconcileAutomationPartitionRunsResult {
  scanned: number;
  admitted: number;
  replayed: number;
  skipped: number;
  failed: number;
}

/** Boot/tick scan. Exact occurrence uniqueness makes the scan replay-safe. */
export function reconcileAutomationPartitionRuns(input: { limit?: number } = {}): ReconcileAutomationPartitionRunsResult {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError('automation partition reconciliation limit must be from 1 through 1000');
  }
  const result: ReconcileAutomationPartitionRunsResult = {
    scanned: 0,
    admitted: 0,
    replayed: 0,
    skipped: 0,
    failed: 0,
  };
  if (!existsSync(WORKFLOW_RUNS_DIR)) return result;
  let files: string[];
  try {
    files = readdirSync(WORKFLOW_RUNS_DIR).filter((file) => file.endsWith('.json')).sort();
  } catch {
    result.failed = 1;
    return result;
  }
  for (const file of files) {
    let run: QueuedRunRecord | null;
    try { run = readWorkflowRunRecordSnapshot<QueuedRunRecord>(path.join(WORKFLOW_RUNS_DIR, file)); }
    catch { run = null; }
    if (!run?.workflowRecurringReadAdmission || !run.canonicalEntityWorkflowResultRoot) {
      result.skipped += 1;
      continue;
    }
    const candidate = run.workflowRecurringReadAdmission as Partial<WorkflowRecurringReadAdmissionV1>;
    const existing = typeof candidate.proposalDigest === 'string'
      && typeof candidate.runOccurrenceId === 'string'
      ? rawOccurrenceAuthority(candidate.proposalDigest, candidate.runOccurrenceId)
      : undefined;
    if (existing?.status === 'admitted' && existing.fanout_plan_id
      && loadFanoutPlan(existing.fanout_plan_id)) {
      result.skipped += 1;
      continue;
    }
    if (result.scanned >= limit) break;
    result.scanned += 1;
    const reconciled = reconcileAutomationPartitionRun(run.id);
    if (reconciled.ok) {
      if (reconciled.state === 'admitted') result.admitted += 1;
      else result.replayed += 1;
    } else if (reconciled.code === 'partition_universe_not_closed'
      || reconciled.code === 'partition_work_missing') {
      result.skipped += 1;
    } else {
      result.failed += 1;
    }
  }
  return result;
}

export const automationPartitionAuthorityInternalsForTest = {
  database,
  ledgerDigest,
  resultHandleDigest,
};
