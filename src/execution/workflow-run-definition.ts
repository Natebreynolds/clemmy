import { createHash } from 'node:crypto';
import type { WorkflowDefinition } from '../memory/workflow-store.js';
import { workflowCodeRevisionFingerprint } from './workflow-code-certification.js';

/**
 * Immutable workflow definition admitted with a run.
 *
 * A workflow name is mutable configuration: the owner can edit its steps while
 * an earlier run is queued, parked, or recovering after a daemon restart. A run
 * must therefore carry the exact definition it was authorized to execute,
 * rather than resolving today's SKILL.md and mixing new instructions with old
 * checkpoints.
 */
export const WORKFLOW_RUN_DEFINITION_SNAPSHOT_VERSION = 1 as const;

export interface WorkflowRunDefinitionSnapshot {
  version: typeof WORKFLOW_RUN_DEFINITION_SNAPSHOT_VERSION;
  workflowSlug: string;
  definitionHash: string;
  /** Revision of every deterministic runner referenced by this definition.
   * Optional only for compatibility with runs admitted before code pinning. */
  codeRevision?: string;
  /** Authenticates the admission metadata, including codeRevision. */
  admissionHash?: string;
  admittedAt: string;
  definition: WorkflowDefinition;
}

export type WorkflowRunDefinitionSnapshotResolution =
  | { status: 'absent' }
  | { status: 'invalid'; reason: string }
  | { status: 'valid'; snapshot: WorkflowRunDefinitionSnapshot };

/** JSON-compatible canonicalization: object key order never changes the hash,
 * while array order (notably workflow step order) remains significant. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) out[key] = canonicalize(item);
  }
  return out;
}

function cloneDefinition(definition: WorkflowDefinition): WorkflowDefinition {
  return JSON.parse(JSON.stringify(definition)) as WorkflowDefinition;
}

export function workflowDefinitionHash(definition: WorkflowDefinition): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(definition)))
    .digest('hex');
}

function workflowAdmissionHash(input: {
  version: number;
  workflowSlug: string;
  definitionHash: string;
  codeRevision: string;
  admittedAt: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(input)))
    .digest('hex');
}

export function createWorkflowRunDefinitionSnapshot(
  workflowSlug: string,
  definition: WorkflowDefinition,
  admittedAt = new Date().toISOString(),
): WorkflowRunDefinitionSnapshot {
  const normalizedSlug = workflowSlug.trim();
  if (!normalizedSlug) throw new Error('Workflow definition snapshot needs a workflow slug.');
  const cloned = cloneDefinition(definition);
  const definitionHash = workflowDefinitionHash(cloned);
  const codeRevision = workflowCodeRevisionFingerprint(cloned, normalizedSlug);
  return {
    version: WORKFLOW_RUN_DEFINITION_SNAPSHOT_VERSION,
    workflowSlug: normalizedSlug,
    definitionHash,
    codeRevision,
    admissionHash: workflowAdmissionHash({
      version: WORKFLOW_RUN_DEFINITION_SNAPSHOT_VERSION,
      workflowSlug: normalizedSlug,
      definitionHash,
      codeRevision,
      admittedAt,
    }),
    admittedAt,
    definition: cloned,
  };
}

/** Re-evaluate the code bytes immediately before execution. Definitions and
 * authored code have separate lifecycles on disk, so pinning only SKILL.md is
 * not enough to prevent a queued run from mixing revisions. */
export function workflowCodeRevisionMatchesSnapshot(
  snapshot: WorkflowRunDefinitionSnapshot,
  definition: WorkflowDefinition = snapshot.definition,
): boolean {
  if (!snapshot.codeRevision) return true;
  return workflowCodeRevisionFingerprint(definition, snapshot.workflowSlug) === snapshot.codeRevision;
}

/** Creation tests may legitimately flip only `enabled:false -> true`. Compare
 * the current definition to the admitted one while neutralizing that single
 * control-plane bit; any step/input/resource/trigger edit still counts as
 * drift and requires a fresh test. */
export function workflowDefinitionMatchesSnapshotIgnoringEnabled(
  snapshot: WorkflowRunDefinitionSnapshot,
  current: WorkflowDefinition,
): boolean {
  return workflowDefinitionHash({
    ...cloneDefinition(current),
    enabled: snapshot.definition.enabled,
  }) === snapshot.definitionHash;
}

/**
 * A held scheduled occurrence has already been admitted at one concrete due
 * time. Changing `enabled` or `trigger` controls only future admissions, so it
 * must not strand that occurrence. Everything that can change execution
 * (steps/prompts/calls, inputs, resources, tools, models, goals, etc.) remains
 * pinned and must match before Resume is allowed.
 */
export function workflowDefinitionMatchesScheduledCatchupSnapshot(
  snapshot: WorkflowRunDefinitionSnapshot,
  current: WorkflowDefinition,
): boolean {
  const normalized = cloneDefinition(current);
  normalized.enabled = snapshot.definition.enabled;
  normalized.trigger = cloneDefinition(snapshot.definition).trigger;
  return workflowDefinitionHash(normalized) === snapshot.definitionHash;
}

/**
 * Validate an untrusted run-record value, including its content hash. A present
 * but corrupt snapshot is never treated like a legacy run: falling back to the
 * current workflow would silently authorize definition drift.
 */
export function resolveWorkflowRunDefinitionSnapshot(
  value: unknown,
): WorkflowRunDefinitionSnapshotResolution {
  if (value === undefined || value === null) return { status: 'absent' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'invalid', reason: 'snapshot is not an object' };
  }
  const candidate = value as Partial<WorkflowRunDefinitionSnapshot>;
  if (candidate.version !== WORKFLOW_RUN_DEFINITION_SNAPSHOT_VERSION) {
    return { status: 'invalid', reason: `unsupported snapshot version ${String(candidate.version ?? 'missing')}` };
  }
  if (typeof candidate.workflowSlug !== 'string' || !candidate.workflowSlug.trim()) {
    return { status: 'invalid', reason: 'workflow slug is missing' };
  }
  if (typeof candidate.admittedAt !== 'string' || !Number.isFinite(Date.parse(candidate.admittedAt))) {
    return { status: 'invalid', reason: 'admission timestamp is invalid' };
  }
  if (
    typeof candidate.definitionHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(candidate.definitionHash)
  ) {
    return { status: 'invalid', reason: 'definition hash is invalid' };
  }
  const hasCodeRevision = candidate.codeRevision !== undefined;
  const hasAdmissionHash = candidate.admissionHash !== undefined;
  if (hasCodeRevision !== hasAdmissionHash) {
    return { status: 'invalid', reason: 'code admission metadata is incomplete' };
  }
  if (
    hasCodeRevision
    && (
      typeof candidate.codeRevision !== 'string'
      || (candidate.codeRevision !== 'no-code' && !/^[a-f0-9]{64}$/.test(candidate.codeRevision))
    )
  ) {
    return { status: 'invalid', reason: 'code revision is invalid' };
  }
  if (
    hasAdmissionHash
    && (typeof candidate.admissionHash !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.admissionHash))
  ) {
    return { status: 'invalid', reason: 'admission hash is invalid' };
  }
  if (hasCodeRevision && hasAdmissionHash) {
    const actualAdmissionHash = workflowAdmissionHash({
      version: candidate.version,
      workflowSlug: candidate.workflowSlug.trim(),
      definitionHash: candidate.definitionHash,
      codeRevision: candidate.codeRevision as string,
      admittedAt: candidate.admittedAt,
    });
    if (actualAdmissionHash !== candidate.admissionHash) {
      return { status: 'invalid', reason: 'admission metadata does not match its hash' };
    }
  }
  const definition = candidate.definition;
  if (
    !definition
    || typeof definition !== 'object'
    || Array.isArray(definition)
    || typeof definition.name !== 'string'
    || !definition.name.trim()
    || !Array.isArray(definition.steps)
  ) {
    return { status: 'invalid', reason: 'workflow definition is malformed' };
  }
  const actualHash = workflowDefinitionHash(definition);
  if (actualHash !== candidate.definitionHash) {
    return { status: 'invalid', reason: 'definition content does not match its admission hash' };
  }
  return {
    status: 'valid',
    snapshot: {
      version: WORKFLOW_RUN_DEFINITION_SNAPSHOT_VERSION,
      workflowSlug: candidate.workflowSlug.trim(),
      definitionHash: candidate.definitionHash,
      ...(hasCodeRevision ? { codeRevision: candidate.codeRevision as string } : {}),
      ...(hasAdmissionHash ? { admissionHash: candidate.admissionHash as string } : {}),
      admittedAt: candidate.admittedAt,
      definition: cloneDefinition(definition),
    },
  };
}
