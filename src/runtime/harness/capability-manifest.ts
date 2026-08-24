/**
 * Immutable host-owned capability manifest.
 *
 * A manifest is the only record that may authorize dispatch. Search hits,
 * names, descriptions, semantic memory, advisory roles, and previous success
 * may rank candidates. They never mint a manifest, never lower an effect,
 * and never substitute for a current fingerprint.
 */
import { createHash } from 'node:crypto';
import type { RuntimeToolEffect } from './tool-effect.js';

export const CAPABILITY_MANIFEST_VERSION = 1 as const;

export type CapabilityProviderKind =
  | 'local_registry'
  | 'composio'
  | 'native_mcp'
  | 'reviewed_cli';

export type ManifestLifecycleState = 'current' | 'revoked' | 'superseded';

export type ManifestEffect = RuntimeToolEffect | 'none' | 'compute' | 'host_only';

export interface CapabilityArgumentCompilerV1 {
  id: string;
  version: string;
}

export interface CapabilityManifestDestinationV1 {
  family: string;
  posture: string;
}

/**
 * Immutable provider-definition facts needed after discovery has ended.
 *
 * The schema itself stays on the prepared tool surface/tool-contract store;
 * this manifest carries its full canonical digest plus the normalized
 * provider declarations that cannot be reconstructed from an operation name.
 * Keeping these bytes in the manifest makes restart/replay use the same
 * definition that was observed before catalog publication.
 */
export interface CapabilityManifestExternalDefinitionV1 {
  version: 1;
  providerInputSchemaDigest: string;
  /** Present only when the same provider definition explicitly observed the
   * output surface. With no digest this attests an explicit null/absence. */
  providerOutputSchemaObserved?: true;
  providerOutputSchemaDigest?: string;
  semanticName: string;
  behaviorHints: {
    readOnly: boolean | null;
    destructive: boolean | null;
    idempotent: boolean | null;
    openWorld: boolean | null;
  };
}

export interface CapabilityManifestV1 {
  version: typeof CAPABILITY_MANIFEST_VERSION;
  manifestId: string;
  providerKind: CapabilityProviderKind;
  /** Exact operation/tool identity. A multiplexer slug is never this value. */
  operationId: string;
  /** Provider, configured server instance, or reviewed binary identity. */
  providerIdentity: string;
  providerVersion: string;
  operationVersion: string;
  /** Full input schema or complete tool-definition fingerprint. */
  definitionFingerprint: string;
  /** Exact normalized current external definition. Optional for legacy/local
   * manifests; new Composio/native-MCP materializers always persist it. */
  externalDefinition?: CapabilityManifestExternalDefinitionV1;
  effect: ManifestEffect;
  destination?: CapabilityManifestDestinationV1;
  accountId: string;
  idempotency: {
    required: boolean;
    policy: 'none' | 'key_before_dispatch' | 'reconcile_only';
  };
  reconciliation: {
    supported: boolean;
    policy: 'none' | 'exact_artifact' | 'uncertain_if_absent';
  };
  outputContract: { kind: string };
  /** Provider-neutral purpose. Digested. Never a tool slug. */
  purpose: string;
  acceptedInputKinds: readonly string[];
  producedOutputKinds: readonly string[];
  applicableDeliverableKinds: readonly string[];
  evidenceContract: {
    kinds: readonly string[];
    readbackRequired: boolean;
  };
  continuationContract?: { kind: string };
  readbackContract?: {
    required: boolean;
    contentDigestRequired: boolean;
  };
  provenance: {
    issuer: string;
    issuedAt: string;
    trusted: true;
  };
  lifecycle: {
    state: ManifestLifecycleState;
    supersededBy?: string;
  };
  /**
   * Ranking labels only. A unique role match does not grant dispatch.
   * Bind still requires this manifest to be current and fingerprint-fresh.
   */
  advisoryRoles?: readonly string[];
  /**
   * When this capability is the exact child of a multiplexer, the parent's
   * identity. The parent itself is never executable.
   */
  delegatedFrom?: string;
  /** Host-owned argument compiler sealed with the manifest. */
  argumentCompiler: CapabilityArgumentCompilerV1;
  /** Exact invoke-port identity. Dispatch may not rewrite this. */
  invokePortId: string;
  /** Distinct reconcile-port identity. Required for mutating effects. */
  reconcilePortId?: string;
}

export type ManifestValidationRefusal =
  | 'incomplete'
  | 'untrusted_provenance'
  | 'revoked'
  | 'superseded'
  | 'unknown_provider_kind'
  | 'unknown_effect'
  | 'multiplexer_is_not_an_operation';

const PROVIDER_KINDS = new Set<CapabilityProviderKind>([
  'local_registry',
  'composio',
  'native_mcp',
  'reviewed_cli',
]);

const EFFECTS = new Set<string>([
  'none',
  'read',
  'compute',
  'host_only',
  'unknown',
  'local_write',
  'external_write',
  'admin',
]);

export const MAX_MANIFEST_PURPOSE_CHARS = 256;
export const MAX_MANIFEST_KIND_CHARS = 64;
export const MAX_MANIFEST_KIND_COUNT = 8;

function boundKinds(kinds: readonly string[]): string[] {
  return kinds
    .slice(0, MAX_MANIFEST_KIND_COUNT)
    .map((kind) => kind.slice(0, MAX_MANIFEST_KIND_CHARS))
    .filter((kind) => kind.trim().length > 0);
}

export function boundManifestDescriptorFields<T extends {
  purpose: string;
  acceptedInputKinds: readonly string[];
  producedOutputKinds: readonly string[];
  applicableDeliverableKinds: readonly string[];
}>(manifest: T): T {
  return {
    ...manifest,
    purpose: manifest.purpose.slice(0, MAX_MANIFEST_PURPOSE_CHARS),
    acceptedInputKinds: boundKinds(manifest.acceptedInputKinds),
    producedOutputKinds: boundKinds(manifest.producedOutputKinds),
    applicableDeliverableKinds: boundKinds(manifest.applicableDeliverableKinds),
  };
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value === value.trim();
}

export function canonicalManifestBytes(manifest: CapabilityManifestV1): string {
  return JSON.stringify({
    version: manifest.version,
    manifestId: manifest.manifestId,
    providerKind: manifest.providerKind,
    operationId: manifest.operationId,
    providerIdentity: manifest.providerIdentity,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    definitionFingerprint: manifest.definitionFingerprint,
    // Preserve byte compatibility for already-installed manifests: absence is
    // omitted rather than encoded as null. New external manifests bind these
    // facts into their digest.
    ...(manifest.externalDefinition
      ? {
          externalDefinition: {
            version: manifest.externalDefinition.version,
            providerInputSchemaDigest: manifest.externalDefinition.providerInputSchemaDigest,
            ...(manifest.externalDefinition.providerOutputSchemaObserved === true
              ? { providerOutputSchemaObserved: true as const }
              : {}),
            ...(manifest.externalDefinition.providerOutputSchemaDigest
              ? { providerOutputSchemaDigest: manifest.externalDefinition.providerOutputSchemaDigest }
              : {}),
            semanticName: manifest.externalDefinition.semanticName,
            behaviorHints: { ...manifest.externalDefinition.behaviorHints },
          },
        }
      : {}),
    effect: manifest.effect,
    destination: manifest.destination ?? null,
    accountId: manifest.accountId,
    idempotency: manifest.idempotency,
    reconciliation: manifest.reconciliation,
    outputContract: manifest.outputContract,
    purpose: manifest.purpose,
    acceptedInputKinds: [...manifest.acceptedInputKinds],
    producedOutputKinds: [...manifest.producedOutputKinds],
    applicableDeliverableKinds: [...manifest.applicableDeliverableKinds],
    evidenceContract: {
      kinds: [...manifest.evidenceContract.kinds],
      readbackRequired: manifest.evidenceContract.readbackRequired,
    },
    continuationContract: manifest.continuationContract ?? null,
    readbackContract: manifest.readbackContract ?? null,
    provenance: manifest.provenance,
    lifecycle: manifest.lifecycle,
    delegatedFrom: manifest.delegatedFrom ?? null,
    argumentCompiler: manifest.argumentCompiler,
    invokePortId: manifest.invokePortId,
    reconcilePortId: manifest.reconcilePortId ?? null,
  });
}

export function capabilityManifestDigest(manifest: CapabilityManifestV1): string {
  return createHash('sha256').update(canonicalManifestBytes(manifest), 'utf8').digest('hex');
}

export function validateCapabilityManifestV1(
  manifest: CapabilityManifestV1 | null | undefined,
): { ok: true; manifest: CapabilityManifestV1 } | { ok: false; reason: ManifestValidationRefusal } {
  if (!manifest || manifest.version !== CAPABILITY_MANIFEST_VERSION) {
    return { ok: false, reason: 'incomplete' };
  }
  if (
    !nonBlank(manifest.manifestId)
    || !nonBlank(manifest.operationId)
    || !nonBlank(manifest.providerIdentity)
    || !nonBlank(manifest.providerVersion)
    || !nonBlank(manifest.operationVersion)
    || !nonBlank(manifest.definitionFingerprint)
    || !nonBlank(manifest.accountId)
    || !nonBlank(manifest.outputContract?.kind)
    || !nonBlank(manifest.purpose)
    || !Array.isArray(manifest.acceptedInputKinds)
    || manifest.acceptedInputKinds.length === 0
    || !manifest.acceptedInputKinds.every((kind) => nonBlank(kind))
    || !Array.isArray(manifest.producedOutputKinds)
    || manifest.producedOutputKinds.length === 0
    || !manifest.producedOutputKinds.every((kind) => nonBlank(kind))
    || !Array.isArray(manifest.applicableDeliverableKinds)
    || manifest.applicableDeliverableKinds.length === 0
    || !manifest.applicableDeliverableKinds.every((kind) => nonBlank(kind))
    || !manifest.idempotency
    || !manifest.reconciliation
    || !manifest.evidenceContract
    || !Array.isArray(manifest.evidenceContract.kinds)
    || !nonBlank(manifest.argumentCompiler?.id)
    || !nonBlank(manifest.argumentCompiler?.version)
    || !nonBlank(manifest.invokePortId)
  ) {
    return { ok: false, reason: 'incomplete' };
  }
  if (!PROVIDER_KINDS.has(manifest.providerKind)) {
    return { ok: false, reason: 'unknown_provider_kind' };
  }
  if (!EFFECTS.has(manifest.effect) || manifest.effect === 'unknown') {
    return { ok: false, reason: 'unknown_effect' };
  }
  if (manifest.externalDefinition) {
    const definition = manifest.externalDefinition;
    const hints = definition.behaviorHints;
    const hint = (value: unknown): boolean => (
      value === true || value === false || value === null
    );
    if (
      (manifest.providerKind !== 'composio' && manifest.providerKind !== 'native_mcp')
      || definition.version !== 1
      || !/^[a-f0-9]{64}$/.test(definition.providerInputSchemaDigest)
      || (definition.providerOutputSchemaObserved !== undefined
        && definition.providerOutputSchemaObserved !== true)
      || (definition.providerOutputSchemaDigest !== undefined
        && definition.providerOutputSchemaObserved !== true)
      || (definition.providerOutputSchemaDigest !== undefined
        && !/^[a-f0-9]{64}$/.test(definition.providerOutputSchemaDigest))
      || !nonBlank(definition.semanticName)
      || !hints
      || !hint(hints.readOnly)
      || !hint(hints.destructive)
      || !hint(hints.idempotent)
      || !hint(hints.openWorld)
    ) return { ok: false, reason: 'incomplete' };
  }
  if (manifest.provenance?.trusted !== true || !nonBlank(manifest.provenance.issuer) || !nonBlank(manifest.provenance.issuedAt)) {
    return { ok: false, reason: 'untrusted_provenance' };
  }
  if (manifest.lifecycle?.state === 'revoked') return { ok: false, reason: 'revoked' };
  if (manifest.lifecycle?.state === 'superseded') return { ok: false, reason: 'superseded' };
  if (manifest.lifecycle?.state !== 'current') return { ok: false, reason: 'incomplete' };
  if (manifest.delegatedFrom && manifest.operationId === manifest.delegatedFrom) {
    return { ok: false, reason: 'multiplexer_is_not_an_operation' };
  }
  if (
    Buffer.byteLength(manifest.purpose, 'utf8') > MAX_MANIFEST_PURPOSE_CHARS
    || manifest.acceptedInputKinds.some((kind) => Buffer.byteLength(kind, 'utf8') > MAX_MANIFEST_KIND_CHARS)
    || manifest.producedOutputKinds.some((kind) => Buffer.byteLength(kind, 'utf8') > MAX_MANIFEST_KIND_CHARS)
    || manifest.applicableDeliverableKinds.some((kind) => Buffer.byteLength(kind, 'utf8') > MAX_MANIFEST_KIND_CHARS)
    || manifest.acceptedInputKinds.length > MAX_MANIFEST_KIND_COUNT
    || manifest.producedOutputKinds.length > MAX_MANIFEST_KIND_COUNT
    || manifest.applicableDeliverableKinds.length > MAX_MANIFEST_KIND_COUNT
  ) {
    return { ok: false, reason: 'incomplete' };
  }
  return { ok: true, manifest: boundManifestDescriptorFields(manifest) };
}

export function currentCapabilityManifest(
  manifest: CapabilityManifestV1 | null | undefined,
): CapabilityManifestV1 | null {
  const checked = validateCapabilityManifestV1(manifest);
  return checked.ok ? checked.manifest : null;
}

/** Fill required semantic-contract fields from role/effect when a fixture
 * omitted them. Production catalog entries set these explicitly. */
export function attachSemanticContract(
  manifest: Omit<
    CapabilityManifestV1,
    'purpose' | 'acceptedInputKinds' | 'producedOutputKinds' | 'applicableDeliverableKinds' | 'argumentCompiler' | 'invokePortId' | 'reconcilePortId'
  > & Partial<Pick<
    CapabilityManifestV1,
    'purpose' | 'acceptedInputKinds' | 'producedOutputKinds' | 'applicableDeliverableKinds' | 'argumentCompiler' | 'invokePortId' | 'reconcilePortId'
  >>,
): CapabilityManifestV1 {
  const write = manifest.effect === 'external_write' || manifest.effect === 'local_write';
  const role = manifest.advisoryRoles?.[0] ?? 'capability';
  const purpose = manifest.purpose ?? (
    write ? 'persist_collection'
      : role === 'source' ? 'locate_source'
        : role === 'collection' || role === 'collect' ? 'collect_records'
          : role === 'transform' || role === 'extract' ? 'project_records'
            : role === 'readback' ? 'verify_created_resource'
              : role === 'lookup' ? 'lookup_records'
                : 'host_capability'
  );
  const outputKind = manifest.outputContract.kind;
  const argumentCompiler = manifest.argumentCompiler ?? {
    id: `compiler:${manifest.operationId}`,
    version: manifest.operationVersion,
  };
  const invokePortId = manifest.invokePortId ?? `port:${manifest.manifestId}:${manifest.operationId}`;
  const reconcilePortId = write
    ? (manifest.reconcilePortId && manifest.reconcilePortId !== invokePortId
      ? manifest.reconcilePortId
      : `reconcile:${invokePortId}`)
    : manifest.reconcilePortId;
  const acceptedInputKinds = manifest.acceptedInputKinds ?? (
    write ? ['records']
      : role === 'source' || role === 'lookup' ? ['query']
        : role === 'collection' || role === 'collect' ? ['locator']
          : role === 'readback' ? ['created_resource']
            : ['records']
  );
  const producedOutputKinds = manifest.producedOutputKinds ?? (
    role === 'source' ? ['locator'] : [outputKind]
  );
  return boundManifestDescriptorFields({
    ...manifest,
    purpose,
    acceptedInputKinds,
    producedOutputKinds,
    applicableDeliverableKinds: manifest.applicableDeliverableKinds ?? [outputKind],
    argumentCompiler,
    invokePortId,
    ...(reconcilePortId ? { reconcilePortId } : {}),
  });
}
