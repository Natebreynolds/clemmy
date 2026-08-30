/**
 * Blank-state, provider-neutral materialization of one live read capability.
 *
 * Enumeration and the capability index only nominate an exact reference. They
 * never mint authority. Authority is installed only after the carrier has
 * refreshed that reference, reported one complete definition twice, the
 * immutable invocation port exists under the resulting manifest identity, and
 * the shared independent observer agrees with the same definition bytes.
 *
 * This module intentionally contains no carrier-specific discovery or invoke
 * branches. MCP, CLI, gateway, and future carriers provide the same small
 * adapter. Production wiring for those adapters is a separate concern.
 */
import { createHash } from 'node:crypto';

import {
  deactivateCapabilityCarrier,
  recordCapabilityOperations,
  searchCapabilityOperations,
  type CapabilityCarrierKind,
  type CapabilityOperationRow,
} from '../../memory/capability-index.js';
import {
  digestSchema,
  fingerprintSchema,
  saveToolContract,
} from '../../tools/tool-contract-store.js';
import {
  capabilityManifestDigest,
  currentCapabilityManifest,
  validateCapabilityManifestV1,
  type CapabilityManifestExternalDefinitionV1,
  type CapabilityManifestV1,
  type CapabilityProviderKind,
} from './capability-manifest.js';
import {
  peekCapabilityManifestStore,
  resolveCapabilityManifestStore,
  type CapabilityManifestStore,
} from './capability-manifest-store.js';
import {
  createHostCapabilityCatalogFactory,
  installHostCapabilityCatalogFactory,
  peekHostCapabilityCatalogFactory,
  type HostCapabilityCatalogFactory,
  type RegisteredHostCapability,
} from './host-capability-catalog-factory.js';
import {
  observationIsFresh,
  refreshIndependentCapabilityObservation,
  type IndependentCapabilityObservation,
} from './independent-capability-observation.js';
import {
  resolveProductionPortsForManifest,
  portImplementationDigest,
  type ProductionCapabilityPort,
} from './production-capability-ports.js';

const MATERIALIZER_VERSION = 1 as const;
const MATERIALIZER_PREFIX = 'cap:live:v1';
const MAX_SHORTLIST = 100;
const MAX_ENUMERATED_OPERATIONS = 10_000;
const MAX_OBJECTIVE_BYTES = 16_384;
const MAX_IDENTITY_BYTES = 512;
const MAX_HINT_TEXT_BYTES = 16_384;
const MAX_SCHEMA_BYTES = 1_048_576;
const MAX_SCHEMA_DEPTH = 24;
const MAX_SCHEMA_CONTAINER_ITEMS = 1_024;
const MAX_SCHEMA_NODES = 100_000;
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const CAPABILITY_HINT_KEYS = new Set([
  'identifier',
  'carrierKind',
  'carrier',
  'displayName',
  'description',
  'effectClass',
  'effectProvenance',
  'accountIdentity',
  'parentIdentifier',
  'selector',
]);

export interface LiveCapabilityReference {
  identifier: string;
  accountId: string;
}

/** Effect authority is evidence, not a guess copied from the search row. */
export type LiveReadEffectAttestation = 'carrier_declared' | 'host_reviewed';

export interface LiveCapabilityDefinition {
  operationId: string;
  providerKind: CapabilityProviderKind;
  providerIdentity: string;
  providerVersion: string;
  operationVersion: string;
  accountId: string;
  effect: string;
  effectAttestation: LiveReadEffectAttestation | 'none';
  inputSchema: unknown;
  /** Exact normalized provider metadata. Native MCP supplies this directly
   * from the same closed tools/list row as inputSchema. */
  externalDefinition?: CapabilityManifestExternalDefinitionV1;
  /** Optional read-only definition metadata. Its absence never gets filled by
   * sampling a business call; consumers that need output paths must refuse. */
  outputSchema?: unknown;
  outputSchemaAttestation?: LiveReadEffectAttestation;
  observedAt: number;
  invoke: {
    portId: string;
    argumentCompiler: { id: string; version: string };
  };
}

export type LiveCapabilityObservationResult =
  | LiveCapabilityDefinition
  | 'missing'
  | 'ambiguous';

/**
 * A carrier owns live enumeration and observation. `refresh` may perform I/O;
 * `observe` reads the exact current definition cached by that refresh and is
 * deliberately synchronous so the final identity check has no await gap.
 */
export interface LiveCapabilityCarrier {
  identity: {
    kind: CapabilityCarrierKind;
    name: string;
  };
  enumerate(): Promise<readonly CapabilityOperationRow[]>;
  refresh(reference: LiveCapabilityReference): Promise<void>;
  observe(reference: LiveCapabilityReference): LiveCapabilityObservationResult;
}

export interface AttestedLiveReadCapability {
  reference: LiveCapabilityReference;
  providerKind: CapabilityProviderKind;
  providerIdentity: string;
  providerVersion: string;
  operationVersion: string;
  accountId: string;
  effect: 'read';
  effectAttestation: LiveReadEffectAttestation;
  inputSchema: Readonly<Record<string, unknown>>;
  schemaFingerprint: string;
  externalDefinition?: CapabilityManifestExternalDefinitionV1;
  outputSchema?: Readonly<Record<string, unknown>>;
  outputSchemaFingerprint?: string;
  outputSchemaAttestation?: LiveReadEffectAttestation;
  definitionFingerprint: string;
  observedAt: number;
  invoke: {
    portId: string;
    argumentCompiler: { id: string; version: string };
  };
}

/** Complete live external operation attestation used by provider materializers
 * before a catalog_manifest is published. Read-only acquisition keeps its
 * narrower public type below; this type also admits provider-declared writes. */
export type AttestedLiveExternalCapability = Omit<
  AttestedLiveReadCapability,
  'effect'
> & {
  effect: 'read' | 'external_write' | 'admin';
};

/**
 * Exact definition identity carried by a live nomination. The schema bytes are
 * deliberately represented by their fingerprint here: the materializer must
 * re-read the full schema from the carrier before it can install authority.
 */
export type AttestedLiveReadCapabilityIdentity = Omit<
  AttestedLiveReadCapability,
  'inputSchema' | 'outputSchema'
>;

export type LiveCapabilityPortRegistrar = (input: {
  manifest: CapabilityManifestV1;
  attestation: AttestedLiveReadCapability;
}) => Promise<{ ok: true } | { ok: false; reason: string }>
  | { ok: true } | { ok: false; reason: string };

export type LiveCapabilityMaterializationRefusal =
  | 'empty_objective'
  | 'carrier_unavailable'
  | 'enumeration_invalid'
  | 'enumeration_unbounded'
  | 'missing'
  | 'ambiguous'
  | 'live_unavailable'
  | 'identity_mismatch'
  | 'invalid_definition'
  | 'unattested_effect'
  | 'effect_not_read'
  | 'stale_observation'
  | 'publication_expired'
  | 'port_registration_failed'
  | 'port_identity_mismatch'
  | 'independent_observation_missing'
  | 'schema_contract_conflict'
  | 'manifest_install_failed'
  | 'catalog_registration_failed';

export type MaterializeLiveReadCapabilityResult =
  | {
      status: 'installed';
      manifest: CapabilityManifestV1;
      attestation: AttestedLiveReadCapability;
      replaced: readonly string[];
    }
  | {
      status: 'blocked';
      reason: LiveCapabilityMaterializationRefusal;
      detail: string;
      retired: readonly string[];
    };

type RefreshIndependentObservation = (input: {
  operationId: string;
  accountId: string;
  definitionFingerprint: string;
  providerVersion: string;
  operationVersion: string;
}) => Promise<IndependentCapabilityObservation | null>;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value === value.trim();
}

function boundedIdentity(value: unknown): value is string {
  return nonBlank(value) && Buffer.byteLength(value, 'utf8') <= MAX_IDENTITY_BYTES;
}

function isCapabilityCarrierKind(value: unknown): value is CapabilityCarrierKind {
  return value === 'composio' || value === 'mcp' || value === 'cli' || value === 'host';
}

function normalizeObjective(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedHintText(value: unknown, options: { blank?: boolean } = {}): value is string {
  return typeof value === 'string'
    && value === value.trim()
    && (options.blank === true || value.length > 0)
    && Buffer.byteLength(value, 'utf8') <= MAX_HINT_TEXT_BYTES;
}

/**
 * Enumeration is supplied by a carrier adapter and is still advisory, but it
 * crosses an external-definition boundary. Copy only closed data properties
 * into host-owned rows before the index sees them. This prevents a getter,
 * sparse array, symbol, or future carrier field from executing or silently
 * changing the candidate bytes during materialization.
 */
export function canonicalLiveCapabilityEnumerationRows(
  value: unknown,
  carrier: LiveCapabilityCarrier['identity'],
): { ok: true; rows: CapabilityOperationRow[] } | { ok: false; detail: string } {
  if (!Array.isArray(value)) return { ok: false, detail: 'enumeration is not an array' };
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return { ok: false, detail: 'enumeration contains symbol properties' };
  }
  const arrayDescriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor && 'value' in lengthDescriptor
    ? lengthDescriptor.value
    : undefined;
  if (!Number.isSafeInteger(length) || length < 0) {
    return { ok: false, detail: 'enumeration has an invalid length' };
  }
  if (length > MAX_ENUMERATED_OPERATIONS) {
    return { ok: false, detail: `enumeration has more than ${MAX_ENUMERATED_OPERATIONS} rows` };
  }
  for (const key of Object.keys(arrayDescriptors)) {
    if (key === 'length') continue;
    if (!/^\d+$/.test(key) || Number(key) >= length) {
      return { ok: false, detail: 'enumeration contains non-index properties' };
    }
  }

  const rows: CapabilityOperationRow[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = arrayDescriptors[String(index)];
    if (!item || item.get || item.set || !('value' in item)) {
      return { ok: false, detail: `enumeration row ${index} is sparse or executable` };
    }
    const row = item.value;
    if (!isPlainRecord(row) || Object.getOwnPropertySymbols(row).length > 0) {
      return { ok: false, detail: `enumeration row ${index} is not a plain closed object` };
    }
    const descriptors = Object.getOwnPropertyDescriptors(row);
    if (
      Object.keys(descriptors).some((key) => !CAPABILITY_HINT_KEYS.has(key))
      || Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set || !('value' in descriptor))
    ) {
      return { ok: false, detail: `enumeration row ${index} has unsupported or executable fields` };
    }
    const field = (key: string): unknown => descriptors[key]?.value;
    const identifier = field('identifier');
    const rowCarrier = field('carrier');
    const displayName = field('displayName');
    const description = field('description');
    const carrierKind = field('carrierKind');
    const effectClass = field('effectClass');
    const effectProvenance = field('effectProvenance');
    if (
      !boundedIdentity(identifier)
      || !boundedIdentity(rowCarrier)
      || !boundedHintText(displayName)
      || !boundedHintText(description, { blank: true })
      || !isCapabilityCarrierKind(carrierKind)
      || carrierKind !== carrier.kind
      || String(rowCarrier).toLowerCase() !== carrier.name.trim().toLowerCase()
      || (effectClass !== 'read' && effectClass !== 'write' && effectClass !== 'unknown')
      || (
        effectProvenance !== 'curated'
        && effectProvenance !== 'declared'
        && effectProvenance !== 'inferred'
        && effectProvenance !== 'none'
      )
    ) return { ok: false, detail: `enumeration row ${index} has invalid identity or effect fields` };

    const optionalIdentity = (key: string): string | undefined | null => {
      if (!(key in descriptors)) return undefined;
      const candidate = field(key);
      return boundedIdentity(candidate) ? candidate : null;
    };
    const accountIdentity = optionalIdentity('accountIdentity');
    const parentIdentifier = optionalIdentity('parentIdentifier');
    const selector = optionalIdentity('selector');
    if (accountIdentity === null || parentIdentifier === null || selector === null) {
      return { ok: false, detail: `enumeration row ${index} has an invalid optional identity` };
    }
    rows.push({
      identifier,
      carrierKind,
      carrier: rowCarrier,
      displayName,
      description,
      effectClass,
      effectProvenance,
      ...(accountIdentity ? { accountIdentity } : {}),
      ...(parentIdentifier ? { parentIdentifier } : {}),
      ...(selector ? { selector } : {}),
    });
  }
  return { ok: true, rows };
}

/** Host-owned copy of the exact identity a carrier nominated. */
export function liveReadCapabilityIdentity(
  attestation: AttestedLiveReadCapability,
): AttestedLiveReadCapabilityIdentity {
  return Object.freeze({
    reference: Object.freeze({ ...attestation.reference }),
    providerKind: attestation.providerKind,
    providerIdentity: attestation.providerIdentity,
    providerVersion: attestation.providerVersion,
    operationVersion: attestation.operationVersion,
    accountId: attestation.accountId,
    effect: attestation.effect,
    effectAttestation: attestation.effectAttestation,
    schemaFingerprint: attestation.schemaFingerprint,
    ...(attestation.externalDefinition
      ? {
          externalDefinition: Object.freeze({
            ...attestation.externalDefinition,
            behaviorHints: Object.freeze({ ...attestation.externalDefinition.behaviorHints }),
          }),
        }
      : {}),
    ...(attestation.outputSchemaFingerprint && attestation.outputSchemaAttestation
      ? {
          outputSchemaFingerprint: attestation.outputSchemaFingerprint,
          outputSchemaAttestation: attestation.outputSchemaAttestation,
        }
      : {}),
    definitionFingerprint: attestation.definitionFingerprint,
    observedAt: attestation.observedAt,
    invoke: Object.freeze({
      portId: attestation.invoke.portId,
      argumentCompiler: Object.freeze({ ...attestation.invoke.argumentCompiler }),
    }),
  });
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function isCapabilityProviderKind(value: unknown): value is CapabilityProviderKind {
  return value === 'local_registry'
    || value === 'composio'
    || value === 'native_mcp'
    || value === 'reviewed_cli';
}

export function closeExternalDefinition(
  value: unknown,
): CapabilityManifestExternalDefinitionV1 | null {
  if (!isPlainRecord(value)) return null;
  const hasOutputSchemaDigest = Object.hasOwn(value, 'providerOutputSchemaDigest');
  const hasOutputSchemaObservation = Object.hasOwn(value, 'providerOutputSchemaObserved');
  if (!exactKeys(value, [
    'version', 'providerInputSchemaDigest',
    ...(hasOutputSchemaObservation ? ['providerOutputSchemaObserved'] : []),
    ...(hasOutputSchemaDigest ? ['providerOutputSchemaDigest'] : []),
    'semanticName', 'behaviorHints',
  ])) return null;
  const hints = value.behaviorHints;
  if (!isPlainRecord(hints) || !exactKeys(hints, [
    'readOnly', 'destructive', 'idempotent', 'openWorld',
  ])) return null;
  const declared = (candidate: unknown): candidate is boolean | null => (
    candidate === true || candidate === false || candidate === null
  );
  if (
    value.version !== 1
    || typeof value.providerInputSchemaDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.providerInputSchemaDigest)
    || (hasOutputSchemaDigest && (
      typeof value.providerOutputSchemaDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.providerOutputSchemaDigest)
    ))
    || (hasOutputSchemaObservation && value.providerOutputSchemaObserved !== true)
    || (hasOutputSchemaDigest && value.providerOutputSchemaObserved !== true)
    || !boundedIdentity(value.semanticName)
    || !declared(hints.readOnly)
    || !declared(hints.destructive)
    || !declared(hints.idempotent)
    || !declared(hints.openWorld)
  ) return null;
  return Object.freeze({
    version: 1,
    providerInputSchemaDigest: value.providerInputSchemaDigest,
    ...(hasOutputSchemaObservation ? { providerOutputSchemaObserved: true as const } : {}),
    ...(hasOutputSchemaDigest
      ? { providerOutputSchemaDigest: value.providerOutputSchemaDigest as string }
      : {}),
    semanticName: value.semanticName,
    behaviorHints: Object.freeze({
      readOnly: hints.readOnly,
      destructive: hints.destructive,
      idempotent: hints.idempotent,
      openWorld: hints.openWorld,
    }),
  });
}

function closeLiveReadCapabilityIdentity(
  value: unknown,
): AttestedLiveReadCapabilityIdentity | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalJson(value)) as unknown;
  } catch {
    return null;
  }
  const baseKeys = [
    'reference',
    'providerKind',
    'providerIdentity',
    'providerVersion',
    'operationVersion',
    'accountId',
    'effect',
    'effectAttestation',
    'schemaFingerprint',
    'definitionFingerprint',
    'observedAt',
    'invoke',
  ];
  if (!isPlainRecord(parsed)) return null;
  const hasOutputFingerprint = Object.hasOwn(parsed, 'outputSchemaFingerprint');
  const hasOutputAttestation = Object.hasOwn(parsed, 'outputSchemaAttestation');
  const hasExternalDefinition = Object.hasOwn(parsed, 'externalDefinition');
  const externalDefinition = hasExternalDefinition
    ? closeExternalDefinition(parsed.externalDefinition)
    : undefined;
  if (
    hasOutputFingerprint !== hasOutputAttestation
    || (hasExternalDefinition && !externalDefinition)
    || !exactKeys(parsed, hasOutputFingerprint
      ? [
          ...baseKeys,
          'outputSchemaFingerprint',
          'outputSchemaAttestation',
          ...(hasExternalDefinition ? ['externalDefinition'] : []),
        ]
      : [...baseKeys, ...(hasExternalDefinition ? ['externalDefinition'] : [])])
  ) return null;
  const reference = parsed.reference;
  const invoke = parsed.invoke;
  if (
    !isPlainRecord(reference)
    || !exactKeys(reference, ['identifier', 'accountId'])
    || !isPlainRecord(invoke)
    || !exactKeys(invoke, ['portId', 'argumentCompiler'])
    || !isPlainRecord(invoke.argumentCompiler)
    || !exactKeys(invoke.argumentCompiler, ['id', 'version'])
    || !boundedIdentity(reference.identifier)
    || !boundedIdentity(reference.accountId)
    || !isCapabilityProviderKind(parsed.providerKind)
    || !boundedIdentity(parsed.providerIdentity)
    || !boundedIdentity(parsed.providerVersion)
    || !boundedIdentity(parsed.operationVersion)
    || !boundedIdentity(parsed.accountId)
    || parsed.accountId !== reference.accountId
    || parsed.effect !== 'read'
    || (
      parsed.effectAttestation !== 'carrier_declared'
      && parsed.effectAttestation !== 'host_reviewed'
    )
    || !boundedIdentity(parsed.schemaFingerprint)
    || !boundedIdentity(parsed.definitionFingerprint)
    || (hasOutputFingerprint && !boundedIdentity(parsed.outputSchemaFingerprint))
    || (hasOutputAttestation
      && parsed.outputSchemaAttestation !== 'carrier_declared'
      && parsed.outputSchemaAttestation !== 'host_reviewed')
    || typeof parsed.observedAt !== 'number'
    || !Number.isFinite(parsed.observedAt)
    || parsed.observedAt <= 0
    || !boundedIdentity(invoke.portId)
    || !boundedIdentity(invoke.argumentCompiler.id)
    || !boundedIdentity(invoke.argumentCompiler.version)
  ) return null;
  return Object.freeze({
    reference: Object.freeze({
      identifier: reference.identifier,
      accountId: reference.accountId,
    }),
    providerKind: parsed.providerKind,
    providerIdentity: parsed.providerIdentity,
    providerVersion: parsed.providerVersion,
    operationVersion: parsed.operationVersion,
    accountId: parsed.accountId,
    effect: 'read',
    effectAttestation: parsed.effectAttestation,
    schemaFingerprint: parsed.schemaFingerprint,
    ...(externalDefinition ? { externalDefinition } : {}),
    ...(hasOutputFingerprint
      ? {
          outputSchemaFingerprint: parsed.outputSchemaFingerprint as string,
          outputSchemaAttestation: parsed.outputSchemaAttestation as LiveReadEffectAttestation,
        }
      : {}),
    definitionFingerprint: parsed.definitionFingerprint,
    observedAt: parsed.observedAt,
    invoke: Object.freeze({
      portId: invoke.portId,
      argumentCompiler: Object.freeze({
        id: invoke.argumentCompiler.id,
        version: invoke.argumentCompiler.version,
      }),
    }),
  });
}

export function liveReadIdentityMatches(
  actual: AttestedLiveReadCapability,
  expected: AttestedLiveReadCapabilityIdentity,
): boolean {
  return actual.reference.identifier === expected.reference.identifier
    && actual.reference.accountId === expected.reference.accountId
    && actual.providerKind === expected.providerKind
    && actual.providerIdentity === expected.providerIdentity
    && actual.providerVersion === expected.providerVersion
    && actual.operationVersion === expected.operationVersion
    && actual.accountId === expected.accountId
    && actual.effect === expected.effect
    && actual.effectAttestation === expected.effectAttestation
    && actual.schemaFingerprint === expected.schemaFingerprint
    && JSON.stringify(actual.externalDefinition ?? null)
      === JSON.stringify(expected.externalDefinition ?? null)
    && actual.outputSchemaFingerprint === expected.outputSchemaFingerprint
    && actual.outputSchemaAttestation === expected.outputSchemaAttestation
    && actual.definitionFingerprint === expected.definitionFingerprint
    && actual.invoke.portId === expected.invoke.portId
    && actual.invoke.argumentCompiler.id === expected.invoke.argumentCompiler.id
    && actual.invoke.argumentCompiler.version === expected.invoke.argumentCompiler.version;
}

interface CanonicalJsonBudget {
  nodes: number;
}

/** Canonical JSON with rejection instead of lossy coercion or object access. */
function canonicalJson(
  value: unknown,
  ancestors = new Set<object>(),
  depth = 0,
  budget: CanonicalJsonBudget = { nodes: 0 },
): string {
  budget.nodes += 1;
  if (budget.nodes > MAX_SCHEMA_NODES) throw new Error('JSON value exceeds its node budget');
  if (depth > MAX_SCHEMA_DEPTH) throw new Error('JSON value exceeds its depth budget');
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite JSON number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error('cyclic JSON value');
    if (value.length > MAX_SCHEMA_CONTAINER_ITEMS) throw new Error('JSON array exceeds its item budget');
    if (Object.getOwnPropertySymbols(value).length > 0) throw new Error('JSON array contains symbol keys');
    if (Object.keys(value).some((key) => !/^\d+$/.test(key) || Number(key) >= value.length)) {
      throw new Error('JSON array contains non-index properties');
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index) || value[index] === undefined) {
        throw new Error('JSON array contains a sparse or undefined item');
      }
    }
    ancestors.add(value);
    try {
      return `[${value.map((entry) => canonicalJson(entry, ancestors, depth + 1, budget)).join(',')}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  if (!isPlainRecord(value)) throw new Error('non-JSON object');
  if (ancestors.has(value)) throw new Error('cyclic JSON value');
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error('JSON object contains symbol keys');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) {
    throw new Error('JSON object contains accessor properties');
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_SCHEMA_CONTAINER_ITEMS) throw new Error('JSON object exceeds its key budget');
  ancestors.add(value);
  try {
    const entries = keys.sort().map((key) => {
      if (
        key.length === 0
        || Buffer.byteLength(key, 'utf8') > MAX_IDENTITY_BYTES
        || FORBIDDEN_OBJECT_KEYS.has(key)
      ) throw new Error('JSON object contains an unsafe key');
      const entry = value[key];
      if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol' || typeof entry === 'bigint') {
        throw new Error('non-JSON schema value');
      }
      return `${JSON.stringify(key)}:${canonicalJson(entry, ancestors, depth + 1, budget)}`;
    });
    const encoded = `{${entries.join(',')}}`;
    if (Buffer.byteLength(encoded, 'utf8') > MAX_SCHEMA_BYTES) {
      throw new Error('JSON value exceeds its byte budget');
    }
    return encoded;
  } finally {
    ancestors.delete(value);
  }
}

function scopePrefix(input: {
  objective: string;
  carrier: LiveCapabilityCarrier['identity'];
}): string {
  const objective = normalizeObjective(input.objective);
  const objectiveScope = sha256(JSON.stringify({
    version: MATERIALIZER_VERSION,
    objective,
  })).slice(0, 24);
  const carrierScope = sha256(JSON.stringify({
    version: MATERIALIZER_VERSION,
    carrierKind: input.carrier.kind,
    carrierName: input.carrier.name.trim().toLowerCase(),
  })).slice(0, 24);
  return `${MATERIALIZER_PREFIX}:${objectiveScope}:${carrierScope}`;
}

function objectivePrefix(objective: string): string {
  const objectiveScope = sha256(JSON.stringify({
    version: MATERIALIZER_VERSION,
    objective: normalizeObjective(objective),
  })).slice(0, 24);
  return `${MATERIALIZER_PREFIX}:${objectiveScope}`;
}

function currentOwnedManifests(
  store: CapabilityManifestStore,
  prefix: string,
): CapabilityManifestV1[] {
  return store.list()
    .map((entry) => entry.manifest)
    .filter((manifest) => (
      manifest.manifestId.startsWith(`${prefix}:`)
      && manifest.lifecycle.state === 'current'
      && Boolean(currentCapabilityManifest(manifest))
    ));
}

function retireScope(input: {
  store: CapabilityManifestStore;
  factory: HostCapabilityCatalogFactory;
  prefix: string;
  preserveManifestId?: string;
}): string[] {
  const retired: string[] = [];
  for (const manifest of currentOwnedManifests(input.store, input.prefix)) {
    if (manifest.manifestId === input.preserveManifestId) continue;
    input.factory.forget(manifest.manifestId);
    if (input.store.revoke(manifest.manifestId)) retired.push(manifest.manifestId);
  }
  return retired.sort();
}

/**
 * Retire every live-materializer manifest for one exact objective, independent
 * of carrier identity. The objective scope is embedded in the manifest ID so
 * this remains correct after a process restart or configured-carrier removal;
 * no parallel acquisition ledger is required.
 */
export function retireLiveReadObjectiveAuthority(input: {
  objective: string;
  preserveManifestId?: string;
  store?: CapabilityManifestStore;
  factory?: HostCapabilityCatalogFactory;
}): readonly string[] {
  const objective = normalizeObjective(input.objective);
  if (!objective || Buffer.byteLength(objective, 'utf8') > MAX_OBJECTIVE_BYTES) return [];
  const store = input.store
    ?? peekCapabilityManifestStore()
    ?? resolveCapabilityManifestStore();
  const installedFactory = peekHostCapabilityCatalogFactory();
  const factory = input.factory ?? installedFactory ?? createHostCapabilityCatalogFactory();
  if (!input.factory && !installedFactory) installHostCapabilityCatalogFactory(factory);
  return retireScope({
    store,
    factory,
    prefix: objectivePrefix(objective),
    ...(input.preserveManifestId ? { preserveManifestId: input.preserveManifestId } : {}),
  });
}

function blocked(input: {
  reason: LiveCapabilityMaterializationRefusal;
  detail: string;
  store: CapabilityManifestStore;
  factory: HostCapabilityCatalogFactory;
  prefix: string;
}): MaterializeLiveReadCapabilityResult {
  return {
    status: 'blocked',
    reason: input.reason,
    detail: input.detail,
    retired: retireScope(input),
  };
}

/**
 * Close and fingerprint one carrier observation with the exact same rules the
 * materializer uses. Production carrier transports use this export when they
 * re-read a provider at the final invocation edge; duplicating the digest
 * recipe in each carrier would let the install and crossing disagree.
 */
export function attestLiveExternalCapabilityDefinition(input: {
  carrier: LiveCapabilityCarrier['identity'];
  reference: LiveCapabilityReference;
  definition: LiveCapabilityObservationResult;
  now: number;
}): { ok: true; attestation: AttestedLiveExternalCapability } | {
  ok: false;
  reason: LiveCapabilityMaterializationRefusal;
  detail: string;
} {
  if (input.definition === 'missing' || input.definition === 'ambiguous') {
    return {
      ok: false,
      reason: input.definition === 'ambiguous' ? 'ambiguous' : 'live_unavailable',
      detail: `the selected live definition is ${input.definition}`,
    };
  }
  const definition = input.definition;
  const externalDefinition = definition.externalDefinition === undefined
    ? undefined
    : closeExternalDefinition(definition.externalDefinition);
  const hasOutputSchema = definition.outputSchema !== undefined;
  const hasOutputAttestation = definition.outputSchemaAttestation !== undefined;
  if (
    !boundedIdentity(definition.operationId)
    || !boundedIdentity(definition.providerIdentity)
    || !boundedIdentity(definition.providerVersion)
    || !boundedIdentity(definition.operationVersion)
    || !boundedIdentity(definition.accountId)
    || !boundedIdentity(definition.invoke?.portId)
    || !boundedIdentity(definition.invoke?.argumentCompiler?.id)
    || !boundedIdentity(definition.invoke?.argumentCompiler?.version)
    || !isPlainRecord(definition.inputSchema)
    || (definition.externalDefinition !== undefined && !externalDefinition)
    || hasOutputSchema !== hasOutputAttestation
    || (hasOutputSchema && !isPlainRecord(definition.outputSchema))
    || (hasOutputAttestation
      && definition.outputSchemaAttestation !== 'carrier_declared'
      && definition.outputSchemaAttestation !== 'host_reviewed')
  ) {
    return { ok: false, reason: 'invalid_definition', detail: 'the live definition is incomplete' };
  }
  if (
    definition.operationId !== input.reference.identifier
    || definition.accountId !== input.reference.accountId
  ) {
    return {
      ok: false,
      reason: 'identity_mismatch',
      detail: 'the refreshed operation or account differs from the shortlisted exact reference',
    };
  }
  if (
    definition.effect !== 'read'
    && definition.effect !== 'external_write'
    && definition.effect !== 'admin'
  ) {
    return {
      ok: false,
      reason: 'unattested_effect',
      detail: `the live definition reports no executable effect (${definition.effect || 'unknown'})`,
    };
  }
  if (
    definition.effectAttestation !== 'carrier_declared'
    && definition.effectAttestation !== 'host_reviewed'
  ) {
    return {
      ok: false,
      reason: 'unattested_effect',
      detail: 'a read hint without carrier or host attestation cannot lower the effect ceiling',
    };
  }
  if (
    !Number.isFinite(definition.observedAt)
    || definition.observedAt <= 0
    || definition.observedAt > input.now
    || input.now - definition.observedAt > 60_000
  ) {
    return {
      ok: false,
      reason: 'stale_observation',
      detail: 'the live definition observation is absent, future-dated, or stale',
    };
  }
  try {
    const canonicalSchema = canonicalJson(definition.inputSchema);
    const inputSchema = Object.freeze(JSON.parse(canonicalSchema) as Record<string, unknown>);
    const providerInputSchemaDigest = digestSchema(inputSchema);
    if (
      externalDefinition
      && externalDefinition.providerInputSchemaDigest !== providerInputSchemaDigest
    ) {
      return {
        ok: false,
        reason: 'invalid_definition',
        detail: 'the normalized external definition does not match the exact input schema',
      };
    }
    const schemaFingerprint = fingerprintSchema(inputSchema);
    const outputSchema = hasOutputSchema
      ? Object.freeze(JSON.parse(canonicalJson(definition.outputSchema)) as Record<string, unknown>)
      : undefined;
    const outputSchemaFingerprint = outputSchema ? fingerprintSchema(outputSchema) : undefined;
    if (
      externalDefinition?.providerOutputSchemaDigest !== undefined
      && (!outputSchema
        || digestSchema(outputSchema) !== externalDefinition.providerOutputSchemaDigest)
    ) {
      return {
        ok: false,
        reason: 'invalid_definition',
        detail: 'the normalized external definition does not match the exact output schema',
      };
    }
    const definitionFingerprint = sha256(canonicalJson({
      domain: 'live-read-capability-definition',
      version: MATERIALIZER_VERSION,
      carrier: {
        kind: input.carrier.kind,
        name: input.carrier.name.trim().toLowerCase(),
      },
      provider: {
        kind: definition.providerKind,
        identity: definition.providerIdentity,
        version: definition.providerVersion,
      },
      operation: {
        id: definition.operationId,
        version: definition.operationVersion,
      },
      accountId: definition.accountId,
      effect: definition.effect,
      effectAttestation: definition.effectAttestation,
      schemaFingerprint,
      inputSchema,
      ...(externalDefinition ? { externalDefinition } : {}),
      ...(outputSchema && outputSchemaFingerprint
        ? {
            outputSchema,
            outputSchemaFingerprint,
            outputSchemaAttestation: definition.outputSchemaAttestation,
          }
        : {}),
      invoke: {
        portId: definition.invoke.portId,
        argumentCompiler: definition.invoke.argumentCompiler,
      },
    }));
    return {
      ok: true,
      attestation: Object.freeze({
        reference: Object.freeze({ ...input.reference }),
        providerKind: definition.providerKind,
        providerIdentity: definition.providerIdentity,
        providerVersion: definition.providerVersion,
        operationVersion: definition.operationVersion,
        accountId: definition.accountId,
        effect: definition.effect,
        effectAttestation: definition.effectAttestation,
        inputSchema,
        schemaFingerprint,
        ...(externalDefinition ? { externalDefinition } : {}),
        ...(outputSchema && outputSchemaFingerprint
          ? {
              outputSchema,
              outputSchemaFingerprint,
              outputSchemaAttestation: definition.outputSchemaAttestation!,
            }
          : {}),
        definitionFingerprint,
        observedAt: definition.observedAt,
        invoke: Object.freeze({
          portId: definition.invoke.portId,
          argumentCompiler: Object.freeze({ ...definition.invoke.argumentCompiler }),
        }),
      }),
    };
  } catch {
    return { ok: false, reason: 'invalid_definition', detail: 'the input or output schema is not canonical JSON' };
  }
}

/** Backward-compatible narrow attester for the blank-state read acquisition
 * registry. Provider-declared writes use the exact-operation materializer and
 * never enter the read shortlist. */
export function attestLiveReadDefinition(input: {
  carrier: LiveCapabilityCarrier['identity'];
  reference: LiveCapabilityReference;
  definition: LiveCapabilityObservationResult;
  now: number;
}): { ok: true; attestation: AttestedLiveReadCapability } | {
  ok: false;
  reason: LiveCapabilityMaterializationRefusal;
  detail: string;
} {
  if (
    input.definition !== 'missing'
    && input.definition !== 'ambiguous'
    && input.definition.effect !== 'read'
  ) {
    return {
      ok: false,
      reason: 'effect_not_read',
      detail: `the live definition reports effect ${input.definition.effect || 'unknown'}`,
    };
  }
  const attested = attestLiveExternalCapabilityDefinition(input);
  if (!attested.ok) return attested;
  if (attested.attestation.effect !== 'read') {
    return {
      ok: false,
      reason: 'effect_not_read',
      detail: `the live definition reports effect ${attested.attestation.effect}`,
    };
  }
  return {
    ok: true,
    attestation: attested.attestation as AttestedLiveReadCapability,
  };
}

function manifestMatchesAttestation(
  manifest: CapabilityManifestV1,
  attestation: AttestedLiveReadCapability,
): boolean {
  return manifest.providerKind === attestation.providerKind
    && manifest.operationId === attestation.reference.identifier
    && manifest.providerIdentity === attestation.providerIdentity
    && manifest.providerVersion === attestation.providerVersion
    && manifest.operationVersion === attestation.operationVersion
    && manifest.definitionFingerprint === attestation.definitionFingerprint
    && JSON.stringify(manifest.externalDefinition ?? null)
      === JSON.stringify(attestation.externalDefinition ?? null)
    && manifest.accountId === attestation.accountId
    && manifest.effect === 'read'
    && manifest.invokePortId === attestation.invoke.portId
    && manifest.argumentCompiler.id === attestation.invoke.argumentCompiler.id
    && manifest.argumentCompiler.version === attestation.invoke.argumentCompiler.version;
}

function newManifest(input: {
  manifestId: string;
  attestation: AttestedLiveReadCapability;
}): CapabilityManifestV1 {
  const manifest: CapabilityManifestV1 = {
    version: 1,
    manifestId: input.manifestId,
    providerKind: input.attestation.providerKind,
    operationId: input.attestation.reference.identifier,
    providerIdentity: input.attestation.providerIdentity,
    providerVersion: input.attestation.providerVersion,
    operationVersion: input.attestation.operationVersion,
    definitionFingerprint: input.attestation.definitionFingerprint,
    ...(input.attestation.externalDefinition
      ? { externalDefinition: input.attestation.externalDefinition }
      : {}),
    effect: 'read',
    accountId: input.attestation.accountId,
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'result' },
    purpose: 'invoke_live_read',
    acceptedInputKinds: ['arguments'],
    producedOutputKinds: ['result'],
    applicableDeliverableKinds: ['result'],
    evidenceContract: { kinds: ['result'], readbackRequired: false },
    provenance: {
      issuer: 'host:live-capability-materializer:v1',
      issuedAt: new Date(input.attestation.observedAt).toISOString(),
      trusted: true,
    },
    lifecycle: { state: 'current' },
    argumentCompiler: { ...input.attestation.invoke.argumentCompiler },
    invokePortId: input.attestation.invoke.portId,
  };
  const checked = validateCapabilityManifestV1(manifest);
  if (!checked.ok) throw new Error(`generated manifest is ${checked.reason}`);
  return checked.manifest;
}

function manifestForAttestation(input: {
  store: CapabilityManifestStore;
  prefix: string;
  attestation: AttestedLiveReadCapability;
}): CapabilityManifestV1 {
  const baseId = `${input.prefix}:${input.attestation.definitionFingerprint}`;
  const prior = input.store.get(baseId);
  if (
    prior
    && prior.manifest.lifecycle.state === 'current'
    && manifestMatchesAttestation(prior.manifest, input.attestation)
  ) return prior.manifest;
  const manifestId = prior
    ? `${baseId}:reacquired:${sha256(String(input.attestation.observedAt)).slice(0, 16)}`
    : baseId;
  return newManifest({ manifestId, attestation: input.attestation });
}

function independentMatches(
  observation: IndependentCapabilityObservation | null,
  attestation: AttestedLiveReadCapability,
): observation is IndependentCapabilityObservation {
  return Boolean(
    observation
    && observation.origin === 'independent'
    && observationIsFresh(observation)
    && observation.operationId === attestation.reference.identifier
    && observation.accountId === attestation.accountId
    && observation.definitionFingerprint === attestation.definitionFingerprint
    && observation.providerVersion === attestation.providerVersion
    && observation.operationVersion === attestation.operationVersion,
  );
}

function catalogEntry(input: {
  manifest: CapabilityManifestV1;
  port: ProductionCapabilityPort;
  sourceSchemaFingerprint: string;
}): RegisteredHostCapability {
  return {
    capabilityId: input.manifest.manifestId,
    toolName: input.manifest.operationId,
    schemaVersion: input.manifest.operationVersion,
    schemaDigest: input.manifest.definitionFingerprint,
    effect: 'read',
    account: input.manifest.accountId,
    manifestDigest: capabilityManifestDigest(input.manifest),
    providerKind: input.manifest.providerKind,
    // Keep workflow definition authority and source-selector identity in
    // distinct sealed fields: the former is a full definition sha256, while
    // the latter is the selector-visible input-schema fingerprint.
    liveFingerprint: input.manifest.definitionFingerprint,
    sourceSchemaFingerprint: input.sourceSchemaFingerprint,
    ...(input.manifest.externalDefinition
      ? {
          providerInputSchemaDigest:
            input.manifest.externalDefinition.providerInputSchemaDigest,
        }
      : {}),
    manifest: input.manifest,
    invoke: input.port.invoke,
    implementationDigest: portImplementationDigest(input.port),
    invokeImplementationDigest: portImplementationDigest(input.port, 'invoke'),
  };
}

/**
 * Materialize exactly one currently observable read capability for an
 * objective. Every substantive blocked outcome retires authority previously
 * materialized for the same carrier/objective scope. Cancellation/deadline
 * expiry is different: abandoned work may neither publish nor revoke
 * authority after its caller stopped awaiting it.
 */
export async function materializeLiveReadCapability(input: {
  objective: string;
  carrier: LiveCapabilityCarrier;
  registerPort: LiveCapabilityPortRegistrar;
  /**
   * Optional exact live nomination. When supplied, current enumeration and
   * observation must reproduce this identity; the capability index is not
   * consulted to choose or replace it.
   */
  expectedIdentity?: AttestedLiveReadCapabilityIdentity;
  store?: CapabilityManifestStore;
  factory?: HostCapabilityCatalogFactory;
  refreshIndependentObservation?: RefreshIndependentObservation;
  /** Owned by the bounded caller. Once false, this invocation may finish
   * consuming already-started carrier I/O but may neither retire nor publish
   * manifest/catalog authority. */
  publicationGuard?: () => boolean;
  now?: () => number;
}): Promise<MaterializeLiveReadCapabilityResult> {
  const store = input.store
    ?? peekCapabilityManifestStore()
    ?? resolveCapabilityManifestStore();
  const installedFactory = peekHostCapabilityCatalogFactory();
  const factory = input.factory ?? installedFactory ?? createHostCapabilityCatalogFactory();
  if (!input.factory && !installedFactory) installHostCapabilityCatalogFactory(factory);
  const objective = normalizeObjective(input.objective);
  const prefix = scopePrefix({ objective, carrier: input.carrier.identity });
  const publicationActive = (): boolean => {
    try {
      return input.publicationGuard?.() !== false;
    } catch {
      return false;
    }
  };
  const publicationExpired = (): MaterializeLiveReadCapabilityResult => ({
    status: 'blocked',
    reason: 'publication_expired',
    detail: 'the bounded acquisition caller stopped awaiting this materialization',
    retired: [],
  });
  const block = (
    reason: LiveCapabilityMaterializationRefusal,
    detail: string,
  ): MaterializeLiveReadCapabilityResult => publicationActive()
    ? blocked({ reason, detail, store, factory, prefix })
    : publicationExpired();
  if (!publicationActive()) return publicationExpired();
  if (!objective) return block('empty_objective', 'an objective is required');
  if (Buffer.byteLength(objective, 'utf8') > MAX_OBJECTIVE_BYTES) {
    return block('empty_objective', 'the objective exceeds its canonical byte budget');
  }
  if (!boundedIdentity(input.carrier.identity.name)) {
    return block('invalid_definition', 'the carrier identity is incomplete');
  }
  const expectedIdentity = input.expectedIdentity === undefined
    ? undefined
    : closeLiveReadCapabilityIdentity(input.expectedIdentity);
  if (input.expectedIdentity !== undefined && !expectedIdentity) {
    return block('invalid_definition', 'the exact carrier nomination is incomplete');
  }
  const nominationCheckNow = (input.now ?? Date.now)();
  if (
    expectedIdentity
    && (
      expectedIdentity.observedAt > nominationCheckNow
      || nominationCheckNow - expectedIdentity.observedAt > 60_000
    )
  ) {
    return block('stale_observation', 'the exact carrier nomination is future-dated or stale');
  }

  let enumerated: unknown;
  try {
    enumerated = await input.carrier.enumerate();
  } catch (error) {
    return block(
      'carrier_unavailable',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!publicationActive()) return publicationExpired();
  if (Array.isArray(enumerated) && enumerated.length > MAX_ENUMERATED_OPERATIONS) {
    return block(
      'enumeration_unbounded',
      `the carrier returned more than ${MAX_ENUMERATED_OPERATIONS} operation hints`,
    );
  }
  let canonicalEnumeration: ReturnType<typeof canonicalLiveCapabilityEnumerationRows>;
  try {
    canonicalEnumeration = canonicalLiveCapabilityEnumerationRows(enumerated, input.carrier.identity);
  } catch (error) {
    return block(
      'enumeration_invalid',
      error instanceof Error ? error.message : 'the carrier enumeration could not be inspected safely',
    );
  }
  if (!canonicalEnumeration.ok) {
    return block('enumeration_invalid', canonicalEnumeration.detail);
  }
  const carrierName = input.carrier.identity.name.trim().toLowerCase();
  const currentHints = canonicalEnumeration.rows.filter((row) => (
    row.carrierKind === input.carrier.identity.kind
    && row.carrier.trim().toLowerCase() === carrierName
    && nonBlank(row.identifier)
  ));
  try {
    deactivateCapabilityCarrier(input.carrier.identity.kind, carrierName);
    recordCapabilityOperations(currentHints);
  } catch {
    // The index is an optimization. Failure to update it cannot create
    // authority; shortlist below simply resolves to no candidate.
  }
  const expectedReference = expectedIdentity?.reference;
  const candidates = expectedReference
    ? currentHints.filter((hint) => (
        hint.identifier === expectedReference.identifier
        && hint.accountIdentity === expectedReference.accountId
        && hint.effectClass === 'read'
        && (
          hint.effectProvenance === 'declared'
          || hint.effectProvenance === 'curated'
        )
      ))
    : searchCapabilityOperations(objective, {
        carrierKind: input.carrier.identity.kind,
        effectClass: 'read',
        limit: MAX_SHORTLIST,
      }).filter((hit) => hit.carrier.trim().toLowerCase() === carrierName);
  if (candidates.length === 0) return block('missing', 'no exact candidate matched the objective');
  if (candidates.length !== 1) {
    return block('ambiguous', `${candidates.length} candidates matched the objective`);
  }
  const selected = candidates[0]!;
  const reference: LiveCapabilityReference = {
    identifier: selected.identifier,
    accountId: selected.accountIdentity?.trim() ?? '',
  };
  if (!reference.accountId) {
    return block('identity_mismatch', 'the shortlisted reference has no exact account identity');
  }

  try {
    await input.carrier.refresh(Object.freeze({ ...reference }));
  } catch (error) {
    return block('live_unavailable', error instanceof Error ? error.message : String(error));
  }
  if (!publicationActive()) return publicationExpired();
  let firstLive: LiveCapabilityObservationResult;
  try {
    firstLive = input.carrier.observe(Object.freeze({ ...reference }));
  } catch (error) {
    return block('live_unavailable', error instanceof Error ? error.message : String(error));
  }
  const first = attestLiveReadDefinition({
    carrier: input.carrier.identity,
    reference,
    definition: firstLive,
    now: (input.now ?? Date.now)(),
  });
  if (!first.ok) return block(first.reason, first.detail);
  if (
    expectedIdentity
    && !liveReadIdentityMatches(first.attestation, expectedIdentity)
  ) {
    return block(
      'identity_mismatch',
      'the refreshed live definition differs from the exact carrier nomination',
    );
  }
  let manifest: CapabilityManifestV1;
  try {
    manifest = manifestForAttestation({ store, prefix, attestation: first.attestation });
  } catch (error) {
    return block(
      'invalid_definition',
      error instanceof Error ? error.message : String(error),
    );
  }

  let registered: Awaited<ReturnType<LiveCapabilityPortRegistrar>>;
  try {
    registered = await input.registerPort({ manifest, attestation: first.attestation });
  } catch (error) {
    return block(
      'port_registration_failed',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!publicationActive()) return publicationExpired();
  if (!registered.ok) return block('port_registration_failed', registered.reason);
  const port = resolveProductionPortsForManifest(manifest);
  if (!port || typeof port.invoke !== 'function') {
    return block('port_identity_mismatch', 'the exact manifest-keyed invocation port is absent');
  }

  const refreshObservation = input.refreshIndependentObservation
    ?? refreshIndependentCapabilityObservation;
  let independent: IndependentCapabilityObservation | null;
  try {
    independent = await refreshObservation({
      operationId: first.attestation.reference.identifier,
      accountId: first.attestation.accountId,
      definitionFingerprint: first.attestation.definitionFingerprint,
      providerVersion: first.attestation.providerVersion,
      operationVersion: first.attestation.operationVersion,
    });
  } catch (error) {
    return block(
      'independent_observation_missing',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!publicationActive()) return publicationExpired();
  if (!independentMatches(independent, first.attestation)) {
    return block(
      'independent_observation_missing',
      'the shared independent observer did not confirm the exact live identity',
    );
  }

  // Re-read synchronously after every asynchronous setup edge. A carrier that
  // renamed, removed, or reshaped the selected operation during materialization
  // cannot ride the earlier snapshot into the authority stores.
  let finalLive: LiveCapabilityObservationResult;
  try {
    finalLive = input.carrier.observe(Object.freeze({ ...reference }));
  } catch (error) {
    return block('live_unavailable', error instanceof Error ? error.message : String(error));
  }
  const final = attestLiveReadDefinition({
    carrier: input.carrier.identity,
    reference,
    definition: finalLive,
    now: (input.now ?? Date.now)(),
  });
  if (!final.ok) return block(final.reason, final.detail);
  if (final.attestation.definitionFingerprint !== first.attestation.definitionFingerprint) {
    return block('identity_mismatch', 'the live definition changed during materialization');
  }

  if (!publicationActive()) return publicationExpired();
  let contractInstalled = false;
  try {
    const savedContract = saveToolContract({
      identifier: final.attestation.reference.identifier,
      schema: final.attestation.inputSchema,
      providerObservedAt: new Date(final.attestation.observedAt).toISOString(),
    });
    contractInstalled = Boolean(
      savedContract
      && savedContract.fingerprint === final.attestation.schemaFingerprint
      && canonicalJson(savedContract.schema) === canonicalJson(final.attestation.inputSchema),
    );
  } catch {
    contractInstalled = false;
  }
  if (!contractInstalled) {
    return block(
      'schema_contract_conflict',
      'the exact observed schema could not be installed in the contract store',
    );
  }

  const prior = currentOwnedManifests(store, prefix)
    .filter((candidate) => candidate.manifestId !== manifest.manifestId)
    .sort((left, right) => left.manifestId.localeCompare(right.manifestId));
  let lifecycle:
    | ReturnType<CapabilityManifestStore['install']>
    | ReturnType<CapabilityManifestStore['supersede']>;
  // Everything below is synchronous. Take the guard immediately before this
  // critical section so an abort delivered on a later event-loop turn cannot
  // leave a half-published manifest/catalog pair.
  if (!publicationActive()) return publicationExpired();
  if (prior.length > 0) {
    lifecycle = store.supersede(prior[0]!.manifestId, manifest);
  } else {
    lifecycle = store.install(manifest);
  }
  if (!lifecycle.ok) {
    factory.forget(manifest.manifestId);
    for (const candidate of prior) factory.forget(candidate.manifestId);
    return block('manifest_install_failed', lifecycle.reason);
  }
  const replaced: string[] = [];
  for (const candidate of prior) {
    factory.forget(candidate.manifestId);
    replaced.push(candidate.manifestId);
  }
  for (const extra of prior.slice(1)) store.revoke(extra.manifestId);

  try {
    factory.register(catalogEntry({
      manifest,
      port,
      sourceSchemaFingerprint: final.attestation.schemaFingerprint,
    }));
  } catch (error) {
    factory.forget(manifest.manifestId);
    store.revoke(manifest.manifestId);
    return {
      status: 'blocked',
      reason: 'catalog_registration_failed',
      detail: error instanceof Error ? error.message : String(error),
      retired: [...replaced, manifest.manifestId].sort(),
    };
  }
  return {
    status: 'installed',
    manifest,
    attestation: final.attestation,
    replaced: replaced.sort(),
  };
}
