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
export const COMPILED_WORKFLOW_RUN_DEFINITION_SNAPSHOT_VERSION = 3 as const;
export const COMPILED_WORKFLOW_RUN_DEFINITION_SCOPE = 'compiled' as const;
export const PROJECT_GRAPH_COMPILER_ID = 'project_graph_v2' as const;
export const COMPILED_WORKFLOW_SLUG_RE = /^compiled-[a-f0-9]{32}$/;

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

/**
 * Immutable one-off workflow admitted directly from a durable project plan.
 * Unlike a version-1 catalog snapshot, this definition is intentionally
 * catalogless: no SKILL.md may be created or consulted for its execution.
 */
export interface CompiledWorkflowRunDefinitionSnapshot {
  version: typeof COMPILED_WORKFLOW_RUN_DEFINITION_SNAPSHOT_VERSION;
  scope: typeof COMPILED_WORKFLOW_RUN_DEFINITION_SCOPE;
  compilerId: typeof PROJECT_GRAPH_COMPILER_ID;
  sourceTurnKeyHash: string;
  workflowSlug: string;
  definitionHash: string;
  codeRevision: 'no-code';
  admissionHash: string;
  admittedAt: string;
  definition: WorkflowDefinition;
}

export type AnyWorkflowRunDefinitionSnapshot =
  | WorkflowRunDefinitionSnapshot
  | CompiledWorkflowRunDefinitionSnapshot;

export type WorkflowRunDefinitionSnapshotResolution =
  | { status: 'absent' }
  | { status: 'invalid'; reason: string }
  | { status: 'valid'; snapshot: AnyWorkflowRunDefinitionSnapshot };

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
  scope?: string;
  compilerId?: string;
  sourceTurnKeyHash?: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(input)))
    .digest('hex');
}

function compiledWorkflowUnsupportedCodeReason(definition: WorkflowDefinition): string | null {
  for (const step of definition.steps ?? []) {
    if (step.deterministic) {
      return `compiled workflow step "${step.id}" references a deterministic runner`;
    }
    if (step.loopUntil?.probe) {
      return `compiled workflow step "${step.id}" references a deterministic loop probe`;
    }
  }
  return null;
}

function compiledWorkflowTriggerIsManualOnly(definition: WorkflowDefinition): boolean {
  const trigger = definition.trigger;
  return trigger?.manual === true
    && trigger.schedule === undefined
    && trigger.timezone === undefined
    && trigger.webhookPath === undefined
    && trigger.events === undefined;
}

export function isCompiledWorkflowRunDefinitionSnapshot(
  value: AnyWorkflowRunDefinitionSnapshot,
): value is CompiledWorkflowRunDefinitionSnapshot {
  return value.version === COMPILED_WORKFLOW_RUN_DEFINITION_SNAPSHOT_VERSION
    && 'scope' in value
    && value.scope === COMPILED_WORKFLOW_RUN_DEFINITION_SCOPE;
}

export function isCatalogWorkflowRunDefinitionSnapshot(
  value: AnyWorkflowRunDefinitionSnapshot,
): value is WorkflowRunDefinitionSnapshot {
  return value.version === WORKFLOW_RUN_DEFINITION_SNAPSHOT_VERSION;
}

export function createCompiledWorkflowRunDefinitionSnapshot(input: {
  workflowSlug: string;
  sourceTurnKeyHash: string;
  definition: WorkflowDefinition;
  admittedAt?: string;
}): CompiledWorkflowRunDefinitionSnapshot {
  const workflowSlug = input.workflowSlug.trim();
  if (!COMPILED_WORKFLOW_SLUG_RE.test(workflowSlug)) {
    throw new Error('Compiled workflow definition snapshot requires a reserved compiled workflow slug.');
  }
  const sourceTurnKeyHash = input.sourceTurnKeyHash.trim();
  if (!/^[a-f0-9]{64}$/.test(sourceTurnKeyHash)) {
    throw new Error('Compiled workflow definition snapshot requires an exact source-turn hash.');
  }
  const admittedAt = input.admittedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(admittedAt))) {
    throw new Error('Compiled workflow definition snapshot requires a valid admission timestamp.');
  }
  const definition = cloneDefinition(input.definition);
  if (!definition.enabled || !compiledWorkflowTriggerIsManualOnly(definition)) {
    throw new Error('Compiled workflows must be enabled and manual-only.');
  }
  const unsupportedCode = compiledWorkflowUnsupportedCodeReason(definition);
  if (unsupportedCode) throw new Error(`${unsupportedCode}; run-scoped code bundles are not supported.`);
  const definitionHash = workflowDefinitionHash(definition);
  const codeRevision = 'no-code' as const;
  return {
    version: COMPILED_WORKFLOW_RUN_DEFINITION_SNAPSHOT_VERSION,
    scope: COMPILED_WORKFLOW_RUN_DEFINITION_SCOPE,
    compilerId: PROJECT_GRAPH_COMPILER_ID,
    sourceTurnKeyHash,
    workflowSlug,
    definitionHash,
    codeRevision,
    admissionHash: workflowAdmissionHash({
      version: COMPILED_WORKFLOW_RUN_DEFINITION_SNAPSHOT_VERSION,
      scope: COMPILED_WORKFLOW_RUN_DEFINITION_SCOPE,
      compilerId: PROJECT_GRAPH_COMPILER_ID,
      sourceTurnKeyHash,
      workflowSlug,
      definitionHash,
      codeRevision,
      admittedAt,
    }),
    admittedAt,
    definition,
  };
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

function resolveCompiledWorkflowRunDefinitionSnapshot(
  value: Record<string, unknown>,
): WorkflowRunDefinitionSnapshotResolution {
  const candidate = value as unknown as Partial<CompiledWorkflowRunDefinitionSnapshot>;
  if (candidate.scope !== COMPILED_WORKFLOW_RUN_DEFINITION_SCOPE) {
    return { status: 'invalid', reason: 'compiled snapshot scope is invalid' };
  }
  if (candidate.compilerId !== PROJECT_GRAPH_COMPILER_ID) {
    return { status: 'invalid', reason: 'compiled snapshot compiler is unsupported' };
  }
  if (
    typeof candidate.sourceTurnKeyHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(candidate.sourceTurnKeyHash)
  ) {
    return { status: 'invalid', reason: 'compiled snapshot source-turn hash is invalid' };
  }
  if (
    typeof candidate.workflowSlug !== 'string'
    || !COMPILED_WORKFLOW_SLUG_RE.test(candidate.workflowSlug)
  ) {
    return { status: 'invalid', reason: 'compiled snapshot workflow slug is invalid' };
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
  if (candidate.codeRevision !== 'no-code') {
    return { status: 'invalid', reason: 'compiled snapshot code revision must be no-code' };
  }
  if (
    typeof candidate.admissionHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(candidate.admissionHash)
  ) {
    return { status: 'invalid', reason: 'admission hash is invalid' };
  }
  const expectedAdmissionHash = workflowAdmissionHash({
    version: COMPILED_WORKFLOW_RUN_DEFINITION_SNAPSHOT_VERSION,
    scope: COMPILED_WORKFLOW_RUN_DEFINITION_SCOPE,
    compilerId: PROJECT_GRAPH_COMPILER_ID,
    sourceTurnKeyHash: candidate.sourceTurnKeyHash,
    workflowSlug: candidate.workflowSlug,
    definitionHash: candidate.definitionHash,
    codeRevision: candidate.codeRevision,
    admittedAt: candidate.admittedAt,
  });
  if (candidate.admissionHash !== expectedAdmissionHash) {
    return { status: 'invalid', reason: 'compiled admission metadata does not match its hash' };
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
  if (!definition.enabled || !compiledWorkflowTriggerIsManualOnly(definition)) {
    return { status: 'invalid', reason: 'compiled workflow definition is not enabled and manual-only' };
  }
  const unsupportedCode = compiledWorkflowUnsupportedCodeReason(definition);
  if (unsupportedCode) return { status: 'invalid', reason: unsupportedCode };
  if (workflowDefinitionHash(definition) !== candidate.definitionHash) {
    return { status: 'invalid', reason: 'definition content does not match its admission hash' };
  }
  return {
    status: 'valid',
    snapshot: {
      version: COMPILED_WORKFLOW_RUN_DEFINITION_SNAPSHOT_VERSION,
      scope: COMPILED_WORKFLOW_RUN_DEFINITION_SCOPE,
      compilerId: PROJECT_GRAPH_COMPILER_ID,
      sourceTurnKeyHash: candidate.sourceTurnKeyHash,
      workflowSlug: candidate.workflowSlug,
      definitionHash: candidate.definitionHash,
      codeRevision: 'no-code',
      admissionHash: candidate.admissionHash,
      admittedAt: candidate.admittedAt,
      definition: cloneDefinition(definition),
    },
  };
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
  const version = (value as { version?: unknown }).version;
  if (version === COMPILED_WORKFLOW_RUN_DEFINITION_SNAPSHOT_VERSION) {
    return resolveCompiledWorkflowRunDefinitionSnapshot(value as Record<string, unknown>);
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
