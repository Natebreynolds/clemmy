import { createHash } from 'node:crypto';

import { closedCanonicalJson } from '../shared/closed-canonical-json.js';
import type { SpaceRecord } from './store.js';
import {
  validateWorkflowSurfaceBinding,
  workflowSurfaceBindingDigest,
  type WorkflowSurfaceBindingV1,
} from './workflow-surface-binding.js';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,255}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const WORKSPACE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Exact local Workspace creation bytes shown on their own formal human card.
 * They describe only a collaboration surface. They contain no workflow,
 * schedule, trigger, retry, provider, or execution authority.
 */
export interface CanonicalEntityWorkspaceCreationContractV1 {
  version: 1;
  workspaceId: string;
  title: string;
  objective: string;
  successCriteria: string[];
  invariants: string[];
  originSessionId: string;
}

/**
 * Exact, human-reviewed selection of an already-existing Workspace. It is
 * intentionally not a creation instruction and carries no schedule or
 * execution authority. The pilot reconciler re-reads the current manifest and
 * requires both revision and digest before installing the visual binding.
 */
export interface CanonicalEntityWorkspaceBindingSelectionV1 {
  version: 1;
  workspaceId: string;
  expectedWorkspaceRevision: number;
  expectedWorkspaceDigest: string;
  bindingId: string;
  role: 'primary';
}

export interface CanonicalEntityWorkspaceBindingApprovalV1 {
  version: 1;
  selection: CanonicalEntityWorkspaceBindingSelectionV1;
  binding: WorkflowSurfaceBindingV1;
  bindingDigest: string;
}

function canonicalJson(value: unknown): string {
  return closedCanonicalJson(value, {
    maxDepth: 24,
    maxNodes: 20_000,
    maxStringBytes: 64_000,
    maxTotalBytes: 256_000,
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function parseCanonicalEntityWorkspaceCreationContract(
  value: unknown,
): { ok: true; contract: CanonicalEntityWorkspaceCreationContractV1 } | {
  ok: false;
  errors: string[];
} {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['workspace creation contract must be an object'] };
  }
  const row = value as Record<string, unknown>;
  const expected = [
    'version', 'workspaceId', 'title', 'objective', 'successCriteria', 'invariants',
    'originSessionId',
  ];
  const keys = Object.keys(row);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    errors.push('workspace creation contract has unknown or missing fields');
  }
  if (row.version !== 1) errors.push('workspace creation contract version must be 1');
  if (typeof row.workspaceId !== 'string' || !WORKSPACE_ID_RE.test(row.workspaceId)) {
    errors.push('workspaceId must be a lowercase kebab-case identifier');
  }
  if (typeof row.title !== 'string' || row.title !== row.title.trim()
    || row.title.length < 1 || row.title.length > 200) errors.push('title must be 1 through 200 trimmed characters');
  if (typeof row.objective !== 'string' || row.objective !== row.objective.trim()
    || row.objective.length < 1 || row.objective.length > 2_000) {
    errors.push('objective must be 1 through 2000 trimmed characters');
  }
  for (const field of ['successCriteria', 'invariants'] as const) {
    const list = row[field];
    if (!Array.isArray(list) || list.length < 1 || list.length > 64
      || list.some((entry) => typeof entry !== 'string'
        || entry !== entry.trim() || entry.length < 1 || entry.length > 1_000)
      || new Set(list).size !== list.length) {
      errors.push(`${field} must contain 1 through 64 unique trimmed strings`);
    }
  }
  if (typeof row.originSessionId !== 'string' || !ID_RE.test(row.originSessionId)) {
    errors.push('originSessionId is invalid');
  }
  if (errors.length > 0) return { ok: false, errors };
  try {
    return {
      ok: true,
      contract: JSON.parse(canonicalJson(value)) as CanonicalEntityWorkspaceCreationContractV1,
    };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

export function canonicalEntityWorkspaceCreationContractDigest(
  contract: CanonicalEntityWorkspaceCreationContractV1,
): string {
  const parsed = parseCanonicalEntityWorkspaceCreationContract(contract);
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return sha256(canonicalJson({
    domain: 'canonical-entity-workspace-creation-contract',
    version: 1,
    contract: parsed.contract,
  }));
}

/** Exact reviewed target state, excluding store-generated timestamps only. */
export function canonicalEntityWorkspaceMatchesCreationContract(
  record: SpaceRecord,
  contract: CanonicalEntityWorkspaceCreationContractV1,
): boolean {
  const parsed = parseCanonicalEntityWorkspaceCreationContract(contract);
  if (!parsed.ok) return false;
  const expected = parsed.contract;
  try {
    return canonicalJson({
      id: record.id,
      title: record.title,
      status: record.status,
      contract: record.contract ?? null,
      viewEntry: record.viewEntry,
      dataSources: record.dataSources,
      actions: record.actions,
      originSessionId: record.originSessionId ?? null,
      focusId: record.focusId ?? null,
      version: record.version,
      revisions: record.revisions,
      reengage: record.reengage ?? null,
      recipe: record.recipe ?? null,
      mobile: record.mobile ?? null,
    }) === canonicalJson({
      id: expected.workspaceId,
      title: expected.title,
      status: 'active',
      contract: {
        objective: expected.objective,
        successCriteria: expected.successCriteria,
        invariants: expected.invariants,
      },
      viewEntry: 'view/index.html',
      dataSources: [],
      actions: [],
      originSessionId: expected.originSessionId,
      focusId: null,
      version: 1,
      revisions: [],
      reengage: null,
      recipe: null,
      mobile: null,
    });
  } catch {
    return false;
  }
}

/** Normalize only durable manifest fields; transient diagnostics are omitted. */
export function canonicalEntityWorkspaceSelectionDigest(record: SpaceRecord): string {
  return sha256(canonicalJson({
    version: 1,
    workspace: {
      id: record.id,
      title: record.title,
      status: record.status,
      ...(record.contract ? { contract: record.contract } : {}),
      viewEntry: record.viewEntry,
      dataSources: record.dataSources,
      actions: record.actions,
      ...(record.reengage ? { reengage: record.reengage } : {}),
      ...(record.originSessionId ? { originSessionId: record.originSessionId } : {}),
      ...(record.focusId !== undefined ? { focusId: record.focusId } : {}),
      version: record.version,
      revisions: record.revisions,
      createdAt: record.createdAt,
      ...(record.recipe ? { recipe: record.recipe } : {}),
      ...(record.mobile ? { mobile: record.mobile } : {}),
    },
  }));
}

export function parseCanonicalEntityWorkspaceBindingSelection(
  value: unknown,
): { ok: true; selection: CanonicalEntityWorkspaceBindingSelectionV1 } | {
  ok: false;
  errors: string[];
} {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['workspace binding selection must be an object'] };
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  const expected = [
    'version',
    'workspaceId',
    'expectedWorkspaceRevision',
    'expectedWorkspaceDigest',
    'bindingId',
    'role',
  ];
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    errors.push('workspace binding selection has unknown or missing fields');
  }
  if (row.version !== 1) errors.push('workspace binding selection version must be 1');
  if (typeof row.workspaceId !== 'string' || !ID_RE.test(row.workspaceId)) errors.push('workspaceId is invalid');
  if (!Number.isSafeInteger(row.expectedWorkspaceRevision) || Number(row.expectedWorkspaceRevision) < 1) {
    errors.push('expectedWorkspaceRevision must be a positive integer');
  }
  if (typeof row.expectedWorkspaceDigest !== 'string' || !DIGEST_RE.test(row.expectedWorkspaceDigest)) {
    errors.push('expectedWorkspaceDigest must be sha256 hex');
  }
  if (typeof row.bindingId !== 'string' || !ID_RE.test(row.bindingId)) errors.push('bindingId is invalid');
  if (row.role !== 'primary') errors.push('role must be primary');
  if (errors.length > 0) return { ok: false, errors };
  try {
    const selection = JSON.parse(canonicalJson(value)) as CanonicalEntityWorkspaceBindingSelectionV1;
    return { ok: true, selection };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

export function createCanonicalEntityWorkspaceBindingApproval(input: {
  selection: CanonicalEntityWorkspaceBindingSelectionV1;
  workflowId: string;
  at: string;
}): CanonicalEntityWorkspaceBindingApprovalV1 {
  const parsed = parseCanonicalEntityWorkspaceBindingSelection(input.selection);
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  const binding: WorkflowSurfaceBindingV1 = {
    version: 1,
    bindingId: parsed.selection.bindingId,
    workflowId: input.workflowId,
    workspaceId: parsed.selection.workspaceId,
    revision: 1,
    role: parsed.selection.role,
    projectionVersion: 1,
    scheduleAuthority: 'workflow',
    state: 'active',
    createdAt: input.at,
    updatedAt: input.at,
  };
  const validation = validateWorkflowSurfaceBinding(binding);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return JSON.parse(canonicalJson({
    version: 1,
    selection: parsed.selection,
    binding,
    bindingDigest: workflowSurfaceBindingDigest(binding),
  })) as CanonicalEntityWorkspaceBindingApprovalV1;
}

export function parseCanonicalEntityWorkspaceBindingApproval(
  value: unknown,
): { ok: true; approval: CanonicalEntityWorkspaceBindingApprovalV1 } | {
  ok: false;
  errors: string[];
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['workspace binding approval must be an object'] };
  }
  const row = value as Record<string, unknown>;
  if (
    row.version !== 1
    || Object.keys(row).length !== 4
    || !Object.hasOwn(row, 'selection')
    || !Object.hasOwn(row, 'binding')
    || !Object.hasOwn(row, 'bindingDigest')
  ) return { ok: false, errors: ['workspace binding approval has unknown, missing, or invalid fields'] };
  const selection = parseCanonicalEntityWorkspaceBindingSelection(row.selection);
  const bindingValidation = validateWorkflowSurfaceBinding(row.binding);
  if (!selection.ok || !bindingValidation.ok) {
    return { ok: false, errors: [...(!selection.ok ? selection.errors : []), ...bindingValidation.errors] };
  }
  const binding = row.binding as WorkflowSurfaceBindingV1;
  if (
    binding.bindingId !== selection.selection.bindingId
    || binding.workspaceId !== selection.selection.workspaceId
    || binding.role !== selection.selection.role
    || binding.revision !== 1
    || binding.state !== 'active'
    || binding.createdAt !== binding.updatedAt
    || typeof row.bindingDigest !== 'string'
    || !DIGEST_RE.test(row.bindingDigest)
    || workflowSurfaceBindingDigest(binding) !== row.bindingDigest
  ) return { ok: false, errors: ['workspace binding approval identity or digest is contradictory'] };
  try {
    return {
      ok: true,
      approval: JSON.parse(canonicalJson(value)) as CanonicalEntityWorkspaceBindingApprovalV1,
    };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}
