/**
 * Transport-only crossing for explicitly reviewed Clementine-local tools.
 *
 * The host owns durable lifecycle, consent, once-only dispatch, and settlement.
 * This leaf independently reconstructs the current registry/schema/safe-mode
 * identity and compares it with the exact manifest expectation carried into
 * the sealed transport call. It contains no event-log or manifest-store read.
 */
import { z } from 'zod';

import {
  normalizeShapeForDeferredJson,
  relaxJsonSchemaForDeferred,
} from '../schema-normalizer.js';
import { stableJsonDigest } from '../../shared/stable-json-digest.js';
import {
  capabilityManifestDigest,
  currentCapabilityManifest,
  type CapabilityManifestV1,
} from './capability-manifest.js';
import {
  TOOL_REGISTRY,
  type LocalPlanningSemantics,
  type ReviewedLocalExecutionContractV1,
  type ToolDecl,
} from '../../tools/tool-registry.js';
import {
  ARTIFACT_BUNDLE_TOOL_PARAMETERS,
  executeArtifactBundleSave,
} from '../../tools/artifact-bundle-contract.js';
import {
  inspectArtifactBundleArtifactId,
} from '../../tools/artifact-bundle-core.js';
import {
  prepareWorkspaceSetData,
  WORKSPACE_SET_DATA_TOOL_PARAMETERS,
  type WorkspaceSetDataArguments,
} from '../../spaces/workspace-set-data-contract.js';
import type { AuthorizedLocalPlanningDefinitionV1 } from './local-planning-capability.js';
import type {
  AttestedTransportCall,
  AttestedTransportObservation,
  AttestedTransportReconcileResult,
} from './implementation-artifacts/attested-transport.js';

export const REVIEWED_LOCAL_PROVIDER_IDENTITY = 'local_registry' as const;
export const REVIEWED_LOCAL_PROVIDER_VERSION = 'local-registry-v1' as const;
export const REVIEWED_LOCAL_OPERATION_VERSION = '1' as const;
export const REVIEWED_LOCAL_ACCOUNT = 'local_registry:host' as const;
export const REVIEWED_LOCAL_ARGUMENT_COMPILER = Object.freeze({
  id: 'compile:reviewed-local-canonical-json:v1',
  version: '1',
});

const AUTHORIZED_LOCAL_REGISTRY_PROVENANCE = 'authorized_local_registry' as const;

export interface ReviewedLocalToolObservation {
  definition: AuthorizedLocalPlanningDefinitionV1;
  execution: ReviewedLocalExecutionContractV1;
  schema: Record<string, unknown>;
  manifestId: string;
  invokePortId: string;
  reconcilePortId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactDeclaration(name: string): ToolDecl | null {
  const rows = TOOL_REGISTRY.filter((entry) => entry.name === name);
  return rows.length === 1 ? rows[0]! : null;
}

function validExecutionContract(value: unknown): value is ReviewedLocalExecutionContractV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const contract = value as Partial<ReviewedLocalExecutionContractV1>;
  return contract.version === 1
    && contract.idempotency === 'content_addressed'
    && (
      (
        contract.adapter === 'artifact_bundle_v1'
        && contract.reconciliation === 'artifact_bundle_v1'
      )
      || (
        contract.adapter === 'workspace_dataset_v1'
        && contract.reconciliation === 'workspace_dataset_v1'
      )
    );
}

function safeToken(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._/-]+/g, '_');
  return normalized && /^[a-z0-9][a-z0-9._/-]{0,63}$/.test(normalized) ? normalized : null;
}

function schemaAllowsExact(schema: unknown, expected: string | number | boolean | null): boolean {
  if (!isRecord(schema)) return false;
  if (expected === null && schema.type === 'null') return true;
  if (schema.const === expected) return true;
  if (Array.isArray(schema.enum) && schema.enum.some((value) => value === expected)) return true;
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.some((branch) => schemaAllowsExact(branch, expected))) return true;
  }
  return false;
}

function normalizedSemantics(semantics: LocalPlanningSemantics): LocalPlanningSemantics {
  return {
    consequence: semantics.consequence,
    reversibility: semantics.reversibility,
    destructive: semantics.destructive,
    purpose: semantics.purpose.trim(),
    inputKind: semantics.inputKind.trim(),
    outputKind: semantics.outputKind.trim(),
    deliverableKind: semantics.deliverableKind.trim(),
    destinationPosture: semantics.destinationPosture,
    advisoryRoles: [...new Set(semantics.advisoryRoles.map((role) => role.trim()).filter(Boolean))],
    ...(semantics.safeMode
      ? {
          safeMode: {
            id: semantics.safeMode.id.trim(),
            requiredEquals: { ...semantics.safeMode.requiredEquals },
            ...(semantics.safeMode.nullEquivalentToRequired
              ? {
                  nullEquivalentToRequired: [...new Set(
                    semantics.safeMode.nullEquivalentToRequired
                      .map((field) => field.trim())
                      .filter(Boolean),
                  )],
                }
              : {}),
            ...(semantics.safeMode.absentOrNull
              ? { absentOrNull: [...semantics.safeMode.absentOrNull] }
              : {}),
          },
        }
      : {}),
  };
}

function structurallyCarriesSafeMode(
  schema: Record<string, unknown>,
  semantics: LocalPlanningSemantics,
): boolean {
  if (semantics.reversibility !== 'create_only') return semantics.safeMode === undefined;
  const safeMode = semantics.safeMode;
  if (!safeMode || !safeToken(safeMode.id)) return false;
  const properties = isRecord(schema.properties) ? schema.properties : null;
  if (!properties) return false;
  for (const [field, expected] of Object.entries(safeMode.requiredEquals)) {
    if (!Object.hasOwn(properties, field) || !schemaAllowsExact(properties[field], expected)) return false;
  }
  const nullEquivalent = new Set(safeMode.nullEquivalentToRequired ?? []);
  if (nullEquivalent.size !== (safeMode.nullEquivalentToRequired?.length ?? 0)) return false;
  for (const field of nullEquivalent) {
    if (
      !Object.hasOwn(safeMode.requiredEquals, field)
      || !Object.hasOwn(properties, field)
      || !schemaAllowsExact(properties[field], null)
    ) return false;
  }
  for (const field of safeMode.absentOrNull ?? []) {
    if (!Object.hasOwn(properties, field)) return false;
  }
  return true;
}

/**
 * Reconstruct the mutation half of deriveLocalPlanningDefinition without
 * importing its durable event-log readers. The byte-identity parity test pins
 * this projection to the host planner's result.
 */
function deriveReviewedLocalDefinition(input: {
  declaration: ToolDecl;
  schema: Record<string, unknown>;
}): AuthorizedLocalPlanningDefinitionV1 | null {
  const name = input.declaration.name.trim();
  const semantics = input.declaration.localPlanning;
  if (
    !name
    || input.declaration.sideEffect !== 'write'
    || input.declaration.runtimeEffect === 'host_only'
    || !semantics
    || semantics.destructive
    || (semantics.reversibility !== 'reversible' && semantics.reversibility !== 'create_only')
  ) return null;
  const normalized = normalizedSemantics(semantics);
  if (!structurallyCarriesSafeMode(input.schema, normalized)) return null;
  const variant = safeToken(normalized.safeMode?.id ?? 'reversible');
  const nameToken = safeToken(name);
  if (!variant || !nameToken) return null;
  const capabilityRef = `cap:local:${nameToken}:${variant}`;
  const schemaFingerprint = stableJsonDigest(input.schema);
  const registrySemanticsFingerprint = stableJsonDigest({
    version: 1,
    name,
    sideEffect: input.declaration.sideEffect,
    actionTopologyRole: input.declaration.actionTopologyRole ?? 'business',
    semantics: normalized,
    localExecution: input.declaration.localExecution ?? null,
  });
  const envelopeFingerprint = stableJsonDigest({
    version: 1,
    provenance: AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
    name,
    carrier: 'work_call',
    schemaFingerprint,
    registrySemanticsFingerprint,
  });
  const descriptor = Object.freeze({
    id: capabilityRef,
    effect: 'local_write' as const,
    purpose: normalized.purpose,
    acceptedInputKinds: ['evidence', normalized.inputKind],
    producedOutputKinds: ['evidence', normalized.outputKind],
    applicableDeliverableKinds: ['evidence', normalized.deliverableKind],
    inputShape: normalized.inputKind,
    outputShape: normalized.outputKind,
    outputKind: normalized.outputKind,
    deliverableKind: normalized.deliverableKind,
    destinationPosture: normalized.destinationPosture,
    evidenceKinds: ['local_commit_receipt'],
    handleRequired: normalized.destinationPosture !== null,
    readbackRequired: false,
    accountScope: REVIEWED_LOCAL_ACCOUNT,
    manifestDigest: stableJsonDigest({
      version: 1,
      provenance: AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
      capabilityRef,
      envelopeFingerprint,
    }),
    advisoryRoles: [...normalized.advisoryRoles],
  });
  return Object.freeze({
    version: 1,
    provenance: AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
    name,
    carrier: 'work_call',
    capabilityRef,
    schemaFingerprint,
    registrySemanticsFingerprint,
    envelopeFingerprint,
    consequence: normalized.consequence,
    reversibility: normalized.reversibility,
    destructive: false,
    accountIdentity: REVIEWED_LOCAL_ACCOUNT,
    safeMode: normalized.safeMode ? Object.freeze({ ...normalized.safeMode }) : null,
    descriptor,
  });
}

function currentReviewedLocalSchema(
  execution: ReviewedLocalExecutionContractV1,
): Record<string, unknown> | null {
  // work_call is the physical carrier for reviewed local mutations. Match its
  // current strict deferred schema bytes (Zod's 2020-12 projection), not the
  // separate first-class provider projection used by direct model calling.
  const parametersShape = execution.adapter === 'artifact_bundle_v1'
    ? ARTIFACT_BUNDLE_TOOL_PARAMETERS
    : WORKSPACE_SET_DATA_TOOL_PARAMETERS;
  const deferredParameters = z.strictObject(normalizeShapeForDeferredJson(parametersShape));
  const parameters = z.toJSONSchema(deferredParameters);
  const schema = relaxJsonSchemaForDeferred(parameters);
  return isRecord(schema) ? schema : null;
}

/** Re-observe the exact in-process registration surface synchronously. */
export function observeReviewedLocalTool(
  operationId: string,
): ReviewedLocalToolObservation | null {
  const name = operationId.trim();
  if (!name || name !== operationId) return null;
  const declaration = exactDeclaration(name);
  if (!declaration || !validExecutionContract(declaration.localExecution)) return null;
  const schema = currentReviewedLocalSchema(declaration.localExecution);
  if (!schema) return null;
  const definition = deriveReviewedLocalDefinition({ declaration, schema });
  if (!definition || definition.accountIdentity !== REVIEWED_LOCAL_ACCOUNT) return null;
  const manifestId = `${definition.capabilityRef}:exec:${definition.envelopeFingerprint}`;
  return Object.freeze({
    definition,
    execution: Object.freeze({ ...declaration.localExecution }),
    schema,
    manifestId,
    invokePortId: `port:${manifestId}:${name}`,
    reconcilePortId: `reconcile:port:${manifestId}:${name}`,
  });
}

export function observeReviewedLocalTransport(
  operationId: string,
  accountId: string,
): AttestedTransportObservation | null {
  if (accountId !== REVIEWED_LOCAL_ACCOUNT) return null;
  const observed = observeReviewedLocalTool(operationId);
  if (!observed) return null;
  return {
    operationId,
    accountId,
    definitionFingerprint: observed.definition.envelopeFingerprint,
    providerVersion: REVIEWED_LOCAL_PROVIDER_VERSION,
    operationVersion: REVIEWED_LOCAL_OPERATION_VERSION,
    observedAt: Date.now(),
  };
}

/** Exact deterministic manifest the host persists outside this transport. */
export function reviewedLocalCapabilityManifest(
  observed: ReviewedLocalToolObservation,
): CapabilityManifestV1 | null {
  const descriptor = observed.definition.descriptor;
  return currentCapabilityManifest({
    version: 1,
    manifestId: observed.manifestId,
    providerKind: 'local_registry',
    operationId: observed.definition.name,
    providerIdentity: REVIEWED_LOCAL_PROVIDER_IDENTITY,
    providerVersion: REVIEWED_LOCAL_PROVIDER_VERSION,
    operationVersion: REVIEWED_LOCAL_OPERATION_VERSION,
    definitionFingerprint: observed.definition.envelopeFingerprint,
    effect: 'local_write',
    ...(descriptor.destinationPosture
      ? {
          destination: {
            family: observed.definition.consequence,
            posture: descriptor.destinationPosture,
          },
        }
      : {}),
    accountId: REVIEWED_LOCAL_ACCOUNT,
    idempotency: { required: true, policy: 'key_before_dispatch' },
    reconciliation: { supported: true, policy: 'exact_artifact' },
    outputContract: { kind: descriptor.outputKind ?? observed.definition.consequence },
    purpose: descriptor.purpose,
    acceptedInputKinds: [...descriptor.acceptedInputKinds],
    producedOutputKinds: [...descriptor.producedOutputKinds],
    applicableDeliverableKinds: [...descriptor.applicableDeliverableKinds],
    evidenceContract: { kinds: ['local_commit_receipt'], readbackRequired: false },
    provenance: {
      issuer: 'host:reviewed-local-registry',
      issuedAt: '1970-01-01T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    advisoryRoles: [...(descriptor.advisoryRoles ?? [])],
    argumentCompiler: { ...REVIEWED_LOCAL_ARGUMENT_COMPILER },
    invokePortId: observed.invokePortId,
    reconcilePortId: observed.reconcilePortId,
  });
}

export function reviewedLocalToolArgumentsMatch(
  observed: ReviewedLocalToolObservation,
  args: Record<string, unknown>,
): boolean {
  if (observed.execution.adapter === 'artifact_bundle_v1') {
    const parsed = z.strictObject(ARTIFACT_BUNDLE_TOOL_PARAMETERS).safeParse(args);
    if (!parsed.success) return false;
  } else if (observed.execution.adapter === 'workspace_dataset_v1') {
    try {
      prepareWorkspaceSetData(args);
    } catch {
      return false;
    }
  } else {
    return false;
  }
  const safeMode = observed.definition.safeMode;
  if (!safeMode) return true;
  const nullEquivalent = new Set(safeMode.nullEquivalentToRequired ?? []);
  for (const [field, expected] of Object.entries(safeMode.requiredEquals)) {
    if (args[field] !== expected && !(args[field] === null && nullEquivalent.has(field))) return false;
  }
  for (const field of safeMode.absentOrNull ?? []) {
    if (args[field] !== undefined && args[field] !== null) return false;
  }
  return true;
}

export type PreparedReviewedLocalToolExecution =
  | {
      observed: ReviewedLocalToolObservation;
      adapter: 'artifact_bundle_v1';
      args: {
        bundle_id: string;
        mode: 'content_addressed';
        files: Array<{ path: string; content: string }>;
      };
    }
  | {
      observed: ReviewedLocalToolObservation;
      adapter: 'workspace_dataset_v1';
      args: WorkspaceSetDataArguments;
    };

/**
 * Does a sealed transport expectation name exactly this current reviewed
 * observation? Shared by the transport leaf and the host storage carrier so
 * both crossings apply one identity bar before any execution or probe.
 */
export function reviewedLocalExpectedIdentityMatches(
  call: Pick<AttestedTransportCall, 'accountId' | 'expected'>,
  observed: ReviewedLocalToolObservation,
): boolean {
  const expected = call.expected;
  const manifest = reviewedLocalCapabilityManifest(observed);
  return Boolean(
    expected
    && manifest
    && call.accountId === REVIEWED_LOCAL_ACCOUNT
    && expected.manifestDigest === capabilityManifestDigest(manifest)
    && expected.providerKind === 'local_registry'
    && expected.providerIdentity === REVIEWED_LOCAL_PROVIDER_IDENTITY
    && expected.providerVersion === REVIEWED_LOCAL_PROVIDER_VERSION
    && expected.operationVersion === REVIEWED_LOCAL_OPERATION_VERSION
    && expected.definitionFingerprint === observed.definition.envelopeFingerprint
    && expected.manifestId === observed.manifestId
    && expected.invokePortId === observed.invokePortId
    && expected.argumentCompiler.id === REVIEWED_LOCAL_ARGUMENT_COMPILER.id
    && expected.argumentCompiler.version === REVIEWED_LOCAL_ARGUMENT_COMPILER.version
    && expected.providerInputSchemaDigest === undefined
    && expected.providerOutputSchemaObserved === undefined
    && expected.providerOutputSchemaDigest === undefined
  );
}

/**
 * Revalidate current registry/schema/manifest identity and close arguments.
 * Host-owned storage adapters call this before their first storage lookup;
 * the storage-free transport leaf uses the same function before execution.
 */
export function prepareReviewedLocalToolExecution(
  call: AttestedTransportCall,
): PreparedReviewedLocalToolExecution {
  const observed = observeReviewedLocalTool(call.operationId);
  if (!observed || !reviewedLocalExpectedIdentityMatches(call, observed)) {
    throw new Error('reviewed local execution identity changed before dispatch');
  }
  if (!reviewedLocalToolArgumentsMatch(observed, call.args)) {
    throw new Error('reviewed local execution arguments exceed the declared safe mode');
  }
  if (observed.execution.adapter === 'artifact_bundle_v1') {
    return {
      observed,
      adapter: observed.execution.adapter,
      args: z.strictObject(ARTIFACT_BUNDLE_TOOL_PARAMETERS).parse(call.args),
    };
  }
  return {
    observed,
    adapter: observed.execution.adapter,
    args: prepareWorkspaceSetData(call.args).args,
  };
}

export async function executeReviewedLocalTool(
  call: AttestedTransportCall,
): Promise<unknown> {
  const prepared = prepareReviewedLocalToolExecution(call);
  if (prepared.adapter === 'artifact_bundle_v1') {
    return executeArtifactBundleSave(prepared.args);
  }
  // Workspace persistence belongs to the shipped host invoke carrier. Keeping
  // native DB bindings out of this leaf preserves the transport-only closure.
  throw new Error('reviewed Workspace dataset execution requires the host storage carrier');
}

export async function reconcileReviewedLocalTool(input: {
  operationId: string;
  accountId: string;
  artifactId: string;
}): Promise<AttestedTransportReconcileResult> {
  const observed = observeReviewedLocalTool(input.operationId);
  if (
    !observed
    || input.accountId !== REVIEWED_LOCAL_ACCOUNT
    || observed.execution.reconciliation !== 'artifact_bundle_v1'
  ) return { exists: false };
  const inspected = inspectArtifactBundleArtifactId(input.artifactId);
  if (inspected.status !== 'present_exact') return { exists: false };
  return {
    exists: true,
    artifactId: inspected.result.artifactId,
    handle: inspected.result.directory,
    contentDigest: inspected.result.revisionDigest,
    receipt: inspected.result.manifestPath,
  };
}
