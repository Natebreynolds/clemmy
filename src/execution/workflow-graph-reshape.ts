/**
 * Release-v3 live graph mutation.
 *
 * The shipped contract is intentionally narrow: an active run may gain
 * additive, read-only prompt nodes and dependency edges into those nodes.
 * Graph-added nodes receive only the structural result channel plus one
 * run-scoped artifact query for exact offloaded upstream data.
 * Edge toggles and dynamic write/send authority remain a later-train feature.
 *
 * Identity, ownership, run liveness, and durable completed/in-flight evidence
 * are admission boundaries. They are checked under the run-record lock before
 * any graph event is emitted, so an unsafe caller cannot create misleading
 * telemetry or race terminal publication.
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import { listWorkflows, readWorkflow, type WorkflowStepInput } from '../memory/workflow-store.js';
import {
  appendWorkflowEvent,
  appendWorkflowEventDurably,
  computeResumeState,
  readWorkflowEvents,
} from './workflow-events.js';
import {
  applyWorkflowGraphPatch,
  compileWorkflowStepsToGraph,
  workflowGraphEdgeId,
  workflowGraphDynamicNodeIdError,
  WORKFLOW_GRAPH_ALLOWED_TOOLS,
  WORKFLOW_GRAPH_ADDITIVE_NODE_MODE,
  type WorkflowGraphDefinition,
  type WorkflowGraphPatch,
  type WorkflowGraphPatchOperation,
} from './workflow-graph.js';
import {
  loadWorkflowGraphSnapshotByRunId,
  persistWorkflowGraphSnapshot,
  type WorkflowGraphSnapshot,
} from './workflow-graph-store.js';
import {
  readWorkflowRunRecordUnlocked,
  withWorkflowRunRecordLock,
} from './workflow-run-record.js';

export interface ReshapeWorkflowGraphInput {
  workflowName: string;
  runId: string;
  patch: WorkflowGraphPatch;
  /**
   * Deprecated compatibility hint. The mutation boundary deliberately ignores
   * caller-supplied completion claims and reconstructs them from the journal.
   */
  completedNodeIds?: Iterable<string>;
  /** Fallback definition when a genuinely active legacy run predates graphs. */
  steps?: WorkflowStepInput[];
}

export interface ReshapeWorkflowGraphResult {
  ok: boolean;
  graph: WorkflowGraphDefinition | null;
  errors: string[];
  warnings: string[];
  /** Ops actually applied, for the human-facing reshape feed. */
  appliedOperations: number;
}

/**
 * Deterministic resource admission for model-owned graph additions.
 *
 * These are execution-shape budgets, not quality judgments: they bound how
 * much concurrency and prompt material one active run can acquire while still
 * leaving enough room for a useful fan-out and its dependency edges.
 */
export const WORKFLOW_RESHAPE_MAX_OPERATIONS_PER_PATCH = 24;
export const WORKFLOW_RESHAPE_MAX_ADDED_NODES_PER_PATCH = 6;
export const WORKFLOW_RESHAPE_MAX_ADDED_NODES_PER_RUN = 24;
export const WORKFLOW_RESHAPE_MAX_PROMPT_BYTES_PER_NODE = 4 * 1024;
export const WORKFLOW_RESHAPE_MAX_TOTAL_ADDED_PROMPT_BYTES_PER_RUN = 32 * 1024;

interface ReshapeRunRecord {
  id?: string;
  workflow?: string;
  status?: string;
  finishedAt?: string;
  targetStepId?: string;
}

interface ReleasePatchAdmission {
  patch: WorkflowGraphPatch | null;
  errors: string[];
}

function rejectedWithoutTelemetry(errors: string[]): ReshapeWorkflowGraphResult {
  return {
    ok: false,
    graph: null,
    errors,
    warnings: [],
    appliedOperations: 0,
  };
}

function identifierError(value: string, label: 'workflow name' | 'run id'): string | null {
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    return `Invalid ${label} "${value}": it must be one safe path segment.`;
  }
  if (label === 'run id') {
    // Match the canonical workflow queue filename contract exactly. Do not
    // impose an extra first-character rule: legacy/current ids may begin with
    // any member of this established safe alphabet.
    const canonical = value.replace(/[^a-zA-Z0-9_.:-]/g, '');
    if (!canonical || canonical !== value) {
      return `Invalid run id "${value}": use only letters, numbers, ".", "_", ":", and "-".`;
    }
  }
  return null;
}

function workflowDisplayName(workflowSlug: string): string | null {
  try {
    return readWorkflow(workflowSlug)?.data.name ?? null;
  } catch {
    return null;
  }
}

function resolveWorkflowReference(reference: string): string | null {
  try {
    if (readWorkflow(reference)) return reference;
    return listWorkflows().find((entry) => entry.data.name === reference)?.name ?? null;
  } catch {
    return null;
  }
}

function workflowReferenceMatchesOwner(reference: string, ownerSlug: string): boolean {
  return reference === ownerSlug || reference === workflowDisplayName(ownerSlug);
}

function runBelongsToWorkflow(run: ReshapeRunRecord, ownerSlug: string): boolean {
  return run.workflow === ownerSlug || run.workflow === workflowDisplayName(ownerSlug);
}

/**
 * Evidence boundaries are evaluated before proposal telemetry. A completed or
 * currently executing target cannot have its incoming structure changed.
 * Sources may be completed: `completed source -> new read node` is the safe,
 * useful restart/resume shape this release intentionally supports.
 */
function protectedTargetViolations(
  graph: WorkflowGraphDefinition,
  operations: WorkflowGraphPatchOperation[],
  completed: ReadonlySet<string>,
  inFlight: ReadonlySet<string>,
): string[] {
  const errors: string[] = [];
  const protect = (target: string): void => {
    if (completed.has(target)) {
      errors.push(`Edge mutation cannot target completed node "${target}" — its execution boundary is already recorded.`);
    }
    if (inFlight.has(target)) {
      errors.push(`Edge mutation cannot target in-flight node "${target}" — wait for that attempt to settle.`);
    }
  };

  for (const operation of operations) {
    if (operation.op === 'add_node') {
      if (completed.has(operation.node.id)) {
        errors.push(`Completed node "${operation.node.id}" cannot be replaced or re-added.`);
      }
      if (inFlight.has(operation.node.id)) {
        errors.push(`In-flight node "${operation.node.id}" cannot be replaced or re-added.`);
      }
      continue;
    }
    if (operation.op === 'add_edge') {
      protect(operation.edge.target);
      continue;
    }
    const edge = graph.edges.find((candidate) => candidate.id === operation.edgeId);
    if (edge) protect(edge.target);
  }
  return [...new Set(errors)];
}

/**
 * Convert the public patch into the only executable release-v3 shape.
 * Validation here is deterministic and happens after caller/run admission, so
 * ordinary invalid proposals can still receive proposed -> rejected telemetry.
 */
function admitReleasePatch(
  current: WorkflowGraphDefinition,
  patch: WorkflowGraphPatch,
): ReleasePatchAdmission {
  const operations = patch.operations ?? [];
  const errors: string[] = [];
  const addedNodes = operations
    .filter((operation): operation is Extract<WorkflowGraphPatchOperation, { op: 'add_node' }> =>
      operation.op === 'add_node');
  const existingAddedNodes = current.nodes.filter(
    (node) => node.config?.runtimeMode === WORKFLOW_GRAPH_ADDITIVE_NODE_MODE,
  );
  const existingPromptBytes = existingAddedNodes.reduce(
    (total, node) => total + Buffer.byteLength(node.prompt?.trim() ?? '', 'utf-8'),
    0,
  );
  const proposedPromptBytes = addedNodes.reduce(
    (total, operation) => total + Buffer.byteLength(operation.node.prompt?.trim() ?? '', 'utf-8'),
    0,
  );

  if (operations.length > WORKFLOW_RESHAPE_MAX_OPERATIONS_PER_PATCH) {
    errors.push(
      `A reshape patch may contain at most ${WORKFLOW_RESHAPE_MAX_OPERATIONS_PER_PATCH} operations; received ${operations.length}. Split the new structure into smaller patches.`,
    );
  }
  if (addedNodes.length > WORKFLOW_RESHAPE_MAX_ADDED_NODES_PER_PATCH) {
    errors.push(
      `A reshape patch may add at most ${WORKFLOW_RESHAPE_MAX_ADDED_NODES_PER_PATCH} new nodes; received ${addedNodes.length}.`,
    );
  }
  if (existingAddedNodes.length + addedNodes.length > WORKFLOW_RESHAPE_MAX_ADDED_NODES_PER_RUN) {
    errors.push(
      `An active run may contain at most ${WORKFLOW_RESHAPE_MAX_ADDED_NODES_PER_RUN} graph-added nodes; this patch would bring the run to ${existingAddedNodes.length + addedNodes.length}.`,
    );
  }
  for (const operation of addedNodes) {
    const promptBytes = Buffer.byteLength(operation.node.prompt?.trim() ?? '', 'utf-8');
    if (promptBytes > WORKFLOW_RESHAPE_MAX_PROMPT_BYTES_PER_NODE) {
      errors.push(
        `Dynamic node "${operation.node.id}" prompt must be at most ${WORKFLOW_RESHAPE_MAX_PROMPT_BYTES_PER_NODE} UTF-8 bytes; received ${promptBytes} bytes. Put large context in the run workspace and query it instead.`,
      );
    }
  }
  if (
    existingPromptBytes + proposedPromptBytes
    > WORKFLOW_RESHAPE_MAX_TOTAL_ADDED_PROMPT_BYTES_PER_RUN
  ) {
    errors.push(
      `Graph-added prompts may total at most ${WORKFLOW_RESHAPE_MAX_TOTAL_ADDED_PROMPT_BYTES_PER_RUN} UTF-8 bytes per run; this patch would bring the run to ${existingPromptBytes + proposedPromptBytes} bytes. Put source material in the run workspace instead.`,
    );
  }

  const addedNodeIds = new Set(
    addedNodes.map((operation) => operation.node.id),
  );
  const canonicalNodeIds = new Set([
    ...current.nodes.map((node) => node.id),
    ...addedNodeIds,
  ]);
  const normalized: WorkflowGraphPatchOperation[] = [];

  for (const operation of operations) {
    if (operation.op === 'disable_edge' || operation.op === 'enable_edge') {
      errors.push(
        `Edge ${operation.op === 'disable_edge' ? 'disable' : 'restore'} operations are not supported by the additive read-only graph runtime in this release.`,
      );
      continue;
    }

    if (operation.op === 'add_node') {
      const node = operation.node;
      const allowedTools = node.allowedTools ?? [];
      const idError = workflowGraphDynamicNodeIdError(node.id);
      if (idError) errors.push(idError);
      if (node.type !== 'step') {
        errors.push(`Dynamic node "${node.id}" must be a prompt step.`);
      }
      if (!node.prompt?.trim()) {
        errors.push(`Dynamic node "${node.id}" needs a non-empty prompt.`);
      }
      if (node.stepId && node.stepId !== node.id) {
        errors.push(`Dynamic node "${node.id}" must use the same stepId.`);
      }
      if (node.sideEffect && node.sideEffect !== 'read') {
        errors.push(`Dynamic ${node.sideEffect} node "${node.id}" is not allowed; this release admits read-only prompt nodes only.`);
      }
      if (node.deterministic) {
        errors.push(`Dynamic node "${node.id}" cannot execute an authored script; this release is prompt-only.`);
      }
      if (node.forEach) {
        errors.push(`Dynamic node "${node.id}" cannot fan out in this release.`);
      }
      if (node.usesSkill) {
        errors.push(`Dynamic node "${node.id}" cannot acquire skill authority in this release.`);
      }
      if (node.loopUntil || node.loopSafe) {
        errors.push(`Dynamic node "${node.id}" cannot acquire loop authority in this release.`);
      }
      if (
        allowedTools.length > 0
        && allowedTools.some(
          (toolName) => !WORKFLOW_GRAPH_ALLOWED_TOOLS.includes(
            toolName as (typeof WORKFLOW_GRAPH_ALLOWED_TOOLS)[number],
          ),
        )
      ) {
        errors.push(
          `Dynamic node "${node.id}" cannot acquire work or wildcard authority; only ${WORKFLOW_GRAPH_ALLOWED_TOOLS.join(' and ')} are available.`,
        );
      }

      normalized.push({
        op: 'add_node',
        node: {
          ...node,
          type: 'step',
          stepId: node.id,
          prompt: node.prompt?.trim(),
          sideEffect: 'read',
          allowedTools: [...WORKFLOW_GRAPH_ALLOWED_TOOLS],
          deterministic: undefined,
          forEach: undefined,
          usesSkill: undefined,
          loopUntil: undefined,
          loopSafe: undefined,
          requiresApproval: false,
          config: {
            ...(node.config ?? {}),
            runtimeMode: WORKFLOW_GRAPH_ADDITIVE_NODE_MODE,
            toolAuthority: 'result_only',
          },
        },
      });
      continue;
    }

    const { edge } = operation;
    if (edge.type !== 'dependency') {
      errors.push(`Dynamic edge "${operation.edge.id}" must be a dependency edge.`);
    }
    if (edge.disabled) {
      errors.push(`Dynamic edge "${operation.edge.id}" cannot be added disabled in this release.`);
    }
    if (!canonicalNodeIds.has(edge.source)) {
      errors.push(
        `Dynamic edge "${edge.id}" source "${edge.source}" is not a canonical node in the live graph or this patch.`,
      );
    }
    if (!addedNodeIds.has(edge.target)) {
      errors.push(
        `Dynamic edge "${operation.edge.id}" must target a node added in the same patch; dependencies cannot be attached to an already schedulable node.`,
      );
    }
    const expectedEdgeId = workflowGraphEdgeId(edge.source, edge.target, 'dependency');
    if (edge.id !== expectedEdgeId) {
      errors.push(
        `Dynamic edge id "${edge.id}" is not canonical; use "${expectedEdgeId}" for ${edge.source} -> ${edge.target}.`,
      );
    }
    normalized.push({
      op: 'add_edge',
      edge: {
        ...edge,
        type: 'dependency',
        disabled: undefined,
      },
    });
  }

  return {
    patch: errors.length === 0
      ? {
          ...patch,
          operations: normalized,
        }
      : null,
    errors,
  };
}

/** Completed work is evidence. Additive patches should never alter it; this
 * second check protects the invariant even if patch operations expand later. */
function completedWorkViolations(
  before: WorkflowGraphDefinition,
  after: WorkflowGraphDefinition,
  completedNodeIds: ReadonlySet<string>,
): string[] {
  if (completedNodeIds.size === 0) return [];
  const violations: string[] = [];
  const beforeById = new Map((before.nodes ?? []).map((node) => [node.id, node]));
  const afterById = new Map((after.nodes ?? []).map((node) => [node.id, node]));
  for (const nodeId of completedNodeIds) {
    if (!beforeById.has(nodeId)) continue;
    const next = afterById.get(nodeId);
    if (!next) {
      violations.push(`Completed node "${nodeId}" cannot be removed — its result is already recorded.`);
      continue;
    }
    if (JSON.stringify(next) !== JSON.stringify(beforeById.get(nodeId))) {
      violations.push(`Completed node "${nodeId}" cannot be rewritten — reshape what happens next instead.`);
    }
  }
  return violations;
}

function reshapeActiveWorkflowGraph(
  input: ReshapeWorkflowGraphInput,
  runFile: string,
): ReshapeWorkflowGraphResult {
  const { workflowName: workflowReference, runId } = input;
  const patch: WorkflowGraphPatch = {
    ...input.patch,
    reason: input.patch.reason?.trim(),
  };
  const operations = patch.operations ?? [];
  const run = readWorkflowRunRecordUnlocked<ReshapeRunRecord>(runFile);
  if (!run) {
    return rejectedWithoutTelemetry([`Run "${runId}" does not exist, so it cannot be reshaped.`]);
  }
  if (run.id !== runId) {
    return rejectedWithoutTelemetry([`Run record ownership mismatch: expected "${runId}", found "${run.id ?? '(missing id)'}".`]);
  }
  if (run.status !== 'running' || Boolean(run.finishedAt)) {
    return rejectedWithoutTelemetry([
      `Run "${runId}" is no longer active (status: ${run.status ?? 'unknown'}); terminal or non-running runs cannot be reshaped.`,
    ]);
  }
  if (run.targetStepId?.trim()) {
    return rejectedWithoutTelemetry([
      `Run "${runId}" is a single-step TRY run for "${run.targetStepId}" and cannot execute added graph nodes.`,
    ]);
  }

  let snapshot;
  try {
    snapshot = loadWorkflowGraphSnapshotByRunId(runId);
  } catch (error) {
    return rejectedWithoutTelemetry([
      `The live graph for run "${runId}" could not be read safely: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  const workflowName = snapshot?.workflowName
    ?? resolveWorkflowReference(workflowReference)
    ?? workflowReference;
  if (
    !workflowReferenceMatchesOwner(workflowReference, workflowName)
    || !runBelongsToWorkflow(run, workflowName)
  ) {
    return rejectedWithoutTelemetry([
      `Workflow "${workflowReference}" does not own run "${runId}"${snapshot ? ` (graph owner: "${snapshot.workflowName}")` : ''}.`,
    ]);
  }
  if (snapshot) {
    try {
      // lastAppliedPatch is the transactional source of truth for the prior
      // reshape. Reconcile it before another patch can overwrite that single
      // receipt slot, or fail closed and leave the receipt intact for retry.
      reconcileWorkflowGraphPatchTelemetry(snapshot);
    } catch (error) {
      return rejectedWithoutTelemetry([
        `The previous graph patch receipt for run "${runId}" could not be reconciled safely: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
  }
  const current = snapshot?.graph
    ?? (input.steps ? compileWorkflowStepsToGraph(input.steps, { id: `${workflowName}:${runId}` }) : null);
  if (!current) {
    return rejectedWithoutTelemetry([
      `No graph is available for active run "${runId}", so it cannot be reshaped.`,
    ]);
  }

  let resume;
  try {
    resume = computeResumeState(workflowName, runId);
  } catch (error) {
    return rejectedWithoutTelemetry([
      `Run "${runId}" evidence could not be read safely: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  if (resume.terminal) {
    return rejectedWithoutTelemetry([
      `Run "${runId}" has terminal journal evidence and cannot be reshaped.`,
    ]);
  }
  const completed = new Set(resume.completedSteps.keys());
  const inFlight = new Set(resume.inFlightStepIds);
  const protectedViolations = protectedTargetViolations(current, operations, completed, inFlight);
  if (protectedViolations.length > 0) {
    return rejectedWithoutTelemetry(protectedViolations);
  }
  if (!patch.reason) {
    return rejectedWithoutTelemetry([
      'A reshape reason is required: explain in one plain sentence why this active run needs a new branch.',
    ]);
  }
  if (patch.reason.length > 500) {
    return rejectedWithoutTelemetry([
      'A reshape reason must be 500 characters or fewer.',
    ]);
  }

  const record = (
    kind: 'workflow_graph_patch_proposed' | 'workflow_graph_patch_applied' | 'workflow_graph_patch_rejected',
    meta: Record<string, unknown>,
  ): void => {
    try {
      appendWorkflowEvent(workflowName, runId, {
        kind,
        meta: {
          reason: patch.reason,
          proposedByNodeId: patch.proposedByNodeId,
          operationCount: operations.length,
          ...meta,
        },
      });
    } catch { /* telemetry is best-effort after admission */ }
  };
  const fail = (errors: string[], warnings: string[] = []): ReshapeWorkflowGraphResult => {
    record('workflow_graph_patch_rejected', { errors });
    return { ok: false, graph: null, errors, warnings, appliedOperations: 0 };
  };

  record('workflow_graph_patch_proposed', {
    operations: operations.map((operation) => operation.op),
  });
  if (operations.length === 0) {
    return fail(['A reshape needs at least one operation.']);
  }

  const admission = admitReleasePatch(current, patch);
  if (!admission.patch) return fail(admission.errors);

  const applied = applyWorkflowGraphPatch(current, admission.patch);
  if (!applied.ok) return fail(applied.errors, applied.warnings);

  const evidenceViolations = completedWorkViolations(current, applied.graph, completed);
  if (evidenceViolations.length > 0) return fail(evidenceViolations, applied.warnings);

  const appliedAt = new Date().toISOString();
  const patchFingerprint = createHash('sha256')
    .update(JSON.stringify(admission.patch))
    .digest('hex');
  const durableGraph: WorkflowGraphDefinition = {
    ...applied.graph,
    metadata: {
      ...(applied.graph.metadata ?? {}),
      lastAppliedPatch: {
        fingerprint: patchFingerprint,
        reason: patch.reason,
        proposedByNodeId: patch.proposedByNodeId ?? null,
        operationCount: operations.length,
        operations: operations.map((operation) => operation.op),
        appliedAt,
      },
    },
  };
  try {
    // The graph and its exact applied-patch receipt share one SQLite snapshot
    // transaction. If the process dies before the JSONL event below, the next
    // graph load reconciles that event from this durable metadata.
    persistWorkflowGraphSnapshot({ workflowName, runId, graph: durableGraph });
  } catch (error) {
    return fail([
      `The reshape validated but could not be saved: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  record('workflow_graph_patch_applied', {
    operations: operations.map((operation) => operation.op),
    nodeCount: durableGraph.nodes.length,
    edgeCount: durableGraph.edges.length,
    patchFingerprint,
    warnings: applied.warnings,
  });
  return {
    ok: true,
    graph: durableGraph,
    errors: [],
    warnings: applied.warnings,
    appliedOperations: operations.length,
  };
}

export function reshapeWorkflowGraph(input: ReshapeWorkflowGraphInput): ReshapeWorkflowGraphResult {
  const workflowError = identifierError(input.workflowName, 'workflow name');
  const runError = identifierError(input.runId, 'run id');
  if (workflowError || runError) {
    return rejectedWithoutTelemetry([workflowError, runError].filter((error): error is string => Boolean(error)));
  }
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${input.runId}.json`);
  try {
    return withWorkflowRunRecordLock(
      runFile,
      () => reshapeActiveWorkflowGraph(input, runFile),
    );
  } catch (error) {
    return rejectedWithoutTelemetry([
      `Run "${input.runId}" could not be locked and read safely: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}

interface AppliedPatchReceipt {
  fingerprint: string;
  reason: string;
  proposedByNodeId: string | null;
  operationCount: number;
  operations: string[];
  appliedAt: string;
}

function appliedPatchReceipt(graph: WorkflowGraphDefinition): AppliedPatchReceipt | null {
  const raw = graph.metadata?.lastAppliedPatch;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.fingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || typeof value.reason !== 'string'
    || !value.reason.trim()
    || typeof value.operationCount !== 'number'
    || !Number.isSafeInteger(value.operationCount)
    || !Array.isArray(value.operations)
    || !value.operations.every((operation) => typeof operation === 'string')
    || typeof value.appliedAt !== 'string'
  ) {
    return null;
  }
  return {
    fingerprint: value.fingerprint,
    reason: value.reason,
    proposedByNodeId: typeof value.proposedByNodeId === 'string' ? value.proposedByNodeId : null,
    operationCount: value.operationCount,
    operations: value.operations as string[],
    appliedAt: value.appliedAt,
  };
}

/**
 * Reconcile the non-transactional JSONL audit mirror from the transactional
 * graph snapshot. This closes the crash window after SQLite commit but before
 * workflow_graph_patch_applied could be appended.
 */
export function reconcileWorkflowGraphPatchTelemetry(
  snapshot: WorkflowGraphSnapshot,
): 'none' | 'already_recorded' | 'recovered' {
  const rawReceipt = snapshot.graph.metadata?.lastAppliedPatch;
  if (rawReceipt === undefined) return 'none';
  const receipt = appliedPatchReceipt(snapshot.graph);
  if (!receipt) {
    throw new Error(
      `Persisted graph patch receipt for run "${snapshot.runId}" is malformed and cannot be overwritten safely.`,
    );
  }
  const alreadyRecorded = readWorkflowEvents(snapshot.workflowName, snapshot.runId)
    .some((event) =>
      event.kind === 'workflow_graph_patch_applied'
      && event.meta?.patchFingerprint === receipt.fingerprint);
  if (alreadyRecorded) return 'already_recorded';
  appendWorkflowEventDurably(snapshot.workflowName, snapshot.runId, {
    kind: 'workflow_graph_patch_applied',
    meta: {
      reason: receipt.reason,
      proposedByNodeId: receipt.proposedByNodeId,
      operationCount: receipt.operationCount,
      operations: receipt.operations,
      patchFingerprint: receipt.fingerprint,
      appliedAt: receipt.appliedAt,
      recoveredFromGraphSnapshot: true,
      nodeCount: snapshot.graph.nodes.length,
      edgeCount: snapshot.graph.edges.length,
    },
  });
  const recovered = readWorkflowEvents(snapshot.workflowName, snapshot.runId)
    .some((event) =>
      event.kind === 'workflow_graph_patch_applied'
      && event.meta?.patchFingerprint === receipt.fingerprint);
  if (!recovered) {
    throw new Error(
      `Persisted graph patch receipt for run "${snapshot.runId}" was appended but could not be read back safely.`,
    );
  }
  return 'recovered';
}

/** The live graph a run should execute from, or null when it predates
 * persistence. Supplying workflowName also enforces graph ownership. */
export function loadLiveWorkflowGraph(
  runId: string,
  workflowReference?: string,
): WorkflowGraphDefinition | null {
  if (identifierError(runId, 'run id')) return null;
  if (workflowReference && identifierError(workflowReference, 'workflow name')) return null;
  try {
    const snapshot = loadWorkflowGraphSnapshotByRunId(runId);
    if (!snapshot) return null;
    if (
      workflowReference
      && !workflowReferenceMatchesOwner(workflowReference, snapshot.workflowName)
    ) return null;
    reconcileWorkflowGraphPatchTelemetry(snapshot);
    return snapshot.graph;
  } catch {
    return null;
  }
}
