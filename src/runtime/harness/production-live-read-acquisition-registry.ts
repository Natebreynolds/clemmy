/**
 * Provider-neutral production acquisition for live read capabilities.
 *
 * Every configured carrier is observed before selection. Its nominations are
 * live, exact, and non-authoritative. Exactly one nomination across the full
 * observable carrier set may be re-read and installed by the shared live
 * materializer. Missing, ambiguity, an unavailable carrier, or identity drift
 * fails closed and retires authority previously selected for the requirement.
 */
import type { CapabilityCarrierKind, CapabilityOperationRow } from '../../memory/capability-index.js';
import type { ManagedMcpServer } from '../../types.js';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import { discoverMcpServers } from '../mcp-config.js';
import {
  capabilityManifestDigest,
  currentCapabilityManifest,
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
} from './host-capability-catalog-factory.js';
import {
  attestLiveReadDefinition,
  canonicalLiveCapabilityEnumerationRows,
  closeExternalDefinition,
  liveReadCapabilityIdentity,
  liveReadIdentityMatches,
  retireLiveReadObjectiveAuthority,
  type AttestedLiveReadCapabilityIdentity,
  type LiveCapabilityCarrier,
  type MaterializeLiveReadCapabilityResult,
} from './live-capability-materializer.js';
import {
  createProductionMcpReadCarrier,
  type ProductionMcpRuntime,
} from './production-mcp-read-carrier.js';
import { createProductionReviewedCliReadCarrier } from './production-reviewed-cli-read-carrier.js';
import { listReviewedCliReadDescriptors } from './reviewed-cli-read-config.js';
import { resolveProductionPortsForManifest } from './production-capability-ports.js';

export const PRODUCTION_LIVE_READ_ACQUISITION_VERSION = 1 as const;

const MAX_ADAPTERS = 128;
const MAX_NOMINATIONS_PER_ADAPTER = 1_000;
const MAX_IDENTITY_BYTES = 512;
const MAX_OBJECTIVE_BYTES = 16_384;
const MAX_DETAIL_BYTES = 16_384;
const NOMINATION_JSON_OPTIONS = Object.freeze({
  maxDepth: 10,
  maxNodes: 25_000,
  maxStringBytes: MAX_DETAIL_BYTES,
  maxTotalBytes: 2_000_000,
});
const OBJECTIVE_STOP_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'by', 'can', 'could', 'do', 'for', 'from',
  'get', 'give', 'in', 'into', 'it', 'list', 'me', 'of', 'on', 'please', 'read',
  'retrieve', 'return', 'show', 'that', 'the', 'this', 'to', 'use', 'using',
  'want', 'with', 'would',
]);

type MaybePromise<T> = T | Promise<T>;

export interface ProductionLiveReadRequirementV1 {
  requirementId: string;
  objective: string;
  effect: 'read';
}

export interface ProductionLiveReadNominationV1 {
  version: typeof PRODUCTION_LIVE_READ_ACQUISITION_VERSION;
  adapterId: string;
  carrier: {
    kind: CapabilityCarrierKind;
    name: string;
  };
  identity: AttestedLiveReadCapabilityIdentity;
}

export type ProductionLiveReadCarrierNominationResultV1 =
  | {
      status: 'nominated';
      nominations: readonly ProductionLiveReadNominationV1[];
    }
  | {
      status: 'missing';
    }
  | {
      status: 'unavailable';
      detail: string;
    };

export interface ProductionLiveReadCarrierAdapterV1 {
  version: typeof PRODUCTION_LIVE_READ_ACQUISITION_VERSION;
  adapterId: string;
  carrier: {
    kind: CapabilityCarrierKind;
    name: string;
  };
  nominate(
    requirement: Readonly<ProductionLiveReadRequirementV1>,
  ): Promise<ProductionLiveReadCarrierNominationResultV1>;
  materialize(input: {
    requirement: Readonly<ProductionLiveReadRequirementV1>;
    nomination: Readonly<ProductionLiveReadNominationV1>;
    /** The registry owns this guard. A carrier may finish already-started I/O
     * after it becomes false, but the shared materializer must not publish or
     * retire authority. */
    publicationGuard?: () => boolean;
  }): Promise<MaterializeLiveReadCapabilityResult>;
}

export interface ProductionLiveReadAcquisitionControlV1 {
  signal?: AbortSignal;
  /** Absolute wall deadline shared with the foreground discovery broker. */
  deadlineAt?: number;
}

export interface ProductionLiveReadAcquisitionPortV1 {
  acquire(
    input: ProductionLiveReadRequirementV1,
    control?: ProductionLiveReadAcquisitionControlV1,
  ): Promise<MaterializeLiveReadCapabilityResult>;
}

export type ProductionLiveReadAcquisitionRegistryV1 = ProductionLiveReadAcquisitionPortV1;

export interface ProductionLiveReadAcquisitionRegistryOptions {
  /** Replaces default configured MCP discovery. Intended for another real,
   * attested host registry or isolated proof runtimes. */
  configuredAdapters?: () => MaybePromise<readonly ProductionLiveReadCarrierAdapterV1[]>;
  /** Isolated proof seam for the production MCP inventory reader. */
  configuredMcpServers?: () => readonly ManagedMcpServer[];
  /** Isolated proof seam for generated MCP transports. Production omits it. */
  mcpRuntimeForServer?: (serverName: string) => ProductionMcpRuntime;
  /** Additional real carrier ports. No CLI or gateway authority is invented
   * when this provider is absent. */
  additionalAdapters?: () => MaybePromise<readonly ProductionLiveReadCarrierAdapterV1[]>;
  /** Host policy can remove a carrier before any enumeration. This is used by
   * the foreground MCP scope, while unrelated carrier kinds remain untouched. */
  adapterAllowed?: (
    adapter: Readonly<Pick<ProductionLiveReadCarrierAdapterV1, 'adapterId' | 'carrier'>>,
  ) => boolean;
  /** Final exact-identity policy. It runs only after a carrier returned a
   * closed current nomination and cannot promote a missing nomination. */
  nominationAllowed?: (
    nomination: Readonly<ProductionLiveReadNominationV1>,
  ) => boolean;
  store?: CapabilityManifestStore;
  factory?: HostCapabilityCatalogFactory;
  now?: () => number;
}

function boundedText(value: unknown, maxBytes = MAX_IDENTITY_BYTES): value is string {
  return typeof value === 'string'
    && value === value.trim()
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isCarrierKind(value: unknown): value is CapabilityCarrierKind {
  return value === 'composio' || value === 'mcp' || value === 'cli' || value === 'host';
}

function isProviderKind(value: unknown): value is CapabilityProviderKind {
  return value === 'local_registry'
    || value === 'composio'
    || value === 'native_mcp'
    || value === 'reviewed_cli';
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US');
}

function objectiveTerms(value: string): readonly string[] {
  const terms = normalizeText(value).match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(terms.filter((term) => (
    term.length > 1 && !OBJECTIVE_STOP_WORDS.has(term)
  )))].sort();
}

/**
 * Identity tokens that appear in almost every CLI read operationId. They are
 * not enough, alone, to nominate a reviewed CLI from a tool_search query.
 */
const CLI_IDENTITY_GENERIC_TERMS = new Set([
  'data', 'query', 'list', 'get', 'read', 'info', 'status', 'show', 'cli',
]);

/**
 * Advisory nomination only. Token overlap can put a live definition forward;
 * it cannot choose by catalog order, attest an effect/account/schema, install
 * a manifest, or authorize invocation. Every one of those facts is re-read by
 * the carrier and shared materializer after global exact-one selection.
 *
 * MCP/Composio-style rows keep the historical all-terms haystack. Reviewed CLI
 * rows also nominate when a tool_search query names the closed operation
 * identity (at least two identifier tokens, or one distinctive token). That is
 * how "query Salesforce … via sf CLI" can cite `salesforce_sf_soql_query`
 * without stuffing the user question into the descriptor.
 */
export function rowIsAdvisoryObjectiveNomination(
  row: CapabilityOperationRow,
  objective: string,
  carrierKind?: CapabilityCarrierKind,
): boolean {
  const terms = objectiveTerms(objective);
  if (terms.length === 0) return false;
  const haystack = new Set(objectiveTerms([
    row.identifier,
    row.displayName,
    row.description,
    row.parentIdentifier ?? '',
    row.selector ?? '',
  ].join(' ')));
  if (terms.every((term) => haystack.has(term))) return true;
  if (carrierKind !== 'cli') return false;
  const identityTerms = objectiveTerms(row.identifier);
  if (identityTerms.length < 2) return false;
  const termSet = new Set(terms);
  const overlap = identityTerms.filter((term) => termSet.has(term));
  return overlap.length >= 2
    || overlap.some((term) => !CLI_IDENTITY_GENERIC_TERMS.has(term));
}

function closeRequirement(value: unknown): ProductionLiveReadRequirementV1 | null {
  if (!plainRecord(value) || Object.getOwnPropertySymbols(value).length > 0) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const field = (key: string): unknown => {
    const descriptor = descriptors[key];
    return descriptor && 'value' in descriptor && !descriptor.get && !descriptor.set
      ? descriptor.value
      : undefined;
  };
  const requirementId = field('requirementId');
  const objective = field('objective');
  const effect = field('effect');
  if (
    !boundedText(requirementId)
    || !boundedText(objective, MAX_OBJECTIVE_BYTES)
    || effect !== 'read'
  ) return null;
  // Only these three projected fields influence acquisition. Proposal/session
  // envelope fields accepted by an upstream port are intentionally ignored.
  const projected = { requirementId, objective, effect: 'read' as const };
  try {
    return JSON.parse(closedCanonicalJson(projected, NOMINATION_JSON_OPTIONS)) as ProductionLiveReadRequirementV1;
  } catch {
    return null;
  }
}

function adapterIdentity(value: unknown): {
  adapter: ProductionLiveReadCarrierAdapterV1;
  id: string;
} | null {
  if (!plainRecord(value) || Object.getOwnPropertySymbols(value).length > 0) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!exactKeys(value, ['version', 'adapterId', 'carrier', 'nominate', 'materialize'])) return null;
  if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) return null;
  const version = descriptors.version?.value;
  const id = descriptors.adapterId?.value;
  const carrier = descriptors.carrier?.value;
  const nominate = descriptors.nominate?.value;
  const materialize = descriptors.materialize?.value;
  if (
    version !== PRODUCTION_LIVE_READ_ACQUISITION_VERSION
    || !boundedText(id)
    || !plainRecord(carrier)
    || !exactKeys(carrier, ['kind', 'name'])
    || !isCarrierKind(carrier.kind)
    || !boundedText(carrier.name)
    || typeof nominate !== 'function'
    || typeof materialize !== 'function'
  ) return null;
  return { adapter: value as unknown as ProductionLiveReadCarrierAdapterV1, id };
}

function closeAdapterInventory(value: unknown): {
  ok: true;
  adapters: readonly ProductionLiveReadCarrierAdapterV1[];
} | { ok: false; reason: 'invalid' | 'unbounded' } {
  if (!Array.isArray(value)) return { ok: false, reason: 'invalid' };
  if (value.length > MAX_ADAPTERS) return { ok: false, reason: 'unbounded' };
  if (Object.getOwnPropertySymbols(value).length > 0) return { ok: false, reason: 'invalid' };
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some((key) => (
    key !== 'length' && (!/^\d+$/.test(key) || Number(key) >= value.length)
  ))) return { ok: false, reason: 'invalid' };
  const adapters: ProductionLiveReadCarrierAdapterV1[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.get || descriptor.set || !('value' in descriptor)) {
      return { ok: false, reason: 'invalid' };
    }
    const closed = adapterIdentity(descriptor.value);
    if (!closed) return { ok: false, reason: 'invalid' };
    adapters.push(closed.adapter);
  }
  adapters.sort((left, right) => left.adapterId.localeCompare(right.adapterId));
  return { ok: true, adapters };
}

function closeIdentity(value: unknown): AttestedLiveReadCapabilityIdentity | null {
  if (!plainRecord(value)) return null;
  const hasExternalDefinition = Object.hasOwn(value, 'externalDefinition');
  const hasOutputFingerprint = Object.hasOwn(value, 'outputSchemaFingerprint');
  const hasOutputAttestation = Object.hasOwn(value, 'outputSchemaAttestation');
  if (hasOutputFingerprint !== hasOutputAttestation || !exactKeys(value, [
    'reference', 'providerKind', 'providerIdentity', 'providerVersion',
    'operationVersion', 'accountId', 'effect', 'effectAttestation',
    'schemaFingerprint', 'definitionFingerprint', 'observedAt', 'invoke',
    ...(hasExternalDefinition ? ['externalDefinition'] : []),
    ...(hasOutputFingerprint ? ['outputSchemaFingerprint', 'outputSchemaAttestation'] : []),
  ])) return null;
  const externalDefinition = hasExternalDefinition
    ? closeExternalDefinition(value.externalDefinition)
    : undefined;
  const reference = value.reference;
  const invoke = value.invoke;
  if (
    !plainRecord(reference)
    || !exactKeys(reference, ['identifier', 'accountId'])
    || !plainRecord(invoke)
    || !exactKeys(invoke, ['portId', 'argumentCompiler'])
    || !plainRecord(invoke.argumentCompiler)
    || !exactKeys(invoke.argumentCompiler, ['id', 'version'])
    || !boundedText(reference.identifier)
    || !boundedText(reference.accountId)
    || !isProviderKind(value.providerKind)
    || !boundedText(value.providerIdentity)
    || !boundedText(value.providerVersion)
    || !boundedText(value.operationVersion)
    || !boundedText(value.accountId)
    || value.accountId !== reference.accountId
    || value.effect !== 'read'
    || (value.effectAttestation !== 'carrier_declared' && value.effectAttestation !== 'host_reviewed')
    || !boundedText(value.schemaFingerprint)
    || (hasOutputFingerprint && !boundedText(value.outputSchemaFingerprint))
    || (hasOutputAttestation
      && value.outputSchemaAttestation !== 'carrier_declared'
      && value.outputSchemaAttestation !== 'host_reviewed')
    || (hasExternalDefinition && !externalDefinition)
    || !boundedText(value.definitionFingerprint)
    || typeof value.observedAt !== 'number'
    || !Number.isFinite(value.observedAt)
    || value.observedAt <= 0
    || !boundedText(invoke.portId)
    || !boundedText(invoke.argumentCompiler.id)
    || !boundedText(invoke.argumentCompiler.version)
  ) return null;
  return Object.freeze({
    ...value,
    ...(externalDefinition ? { externalDefinition } : {}),
  }) as unknown as AttestedLiveReadCapabilityIdentity;
}

function closeNominationResult(input: {
  value: unknown;
  adapter: ProductionLiveReadCarrierAdapterV1;
  now: number;
}): ProductionLiveReadCarrierNominationResultV1 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(closedCanonicalJson(input.value, NOMINATION_JSON_OPTIONS)) as unknown;
  } catch {
    return null;
  }
  if (!plainRecord(parsed) || typeof parsed.status !== 'string') return null;
  if (parsed.status === 'missing') {
    return exactKeys(parsed, ['status']) ? { status: 'missing' } : null;
  }
  if (parsed.status === 'unavailable') {
    return exactKeys(parsed, ['status', 'detail']) && boundedText(parsed.detail, MAX_DETAIL_BYTES)
      ? { status: 'unavailable', detail: parsed.detail }
      : null;
  }
  if (
    parsed.status !== 'nominated'
    || !exactKeys(parsed, ['status', 'nominations'])
    || !Array.isArray(parsed.nominations)
    || parsed.nominations.length === 0
    || parsed.nominations.length > MAX_NOMINATIONS_PER_ADAPTER
  ) return null;
  const nominations: ProductionLiveReadNominationV1[] = [];
  for (const value of parsed.nominations) {
    if (!plainRecord(value) || !exactKeys(value, ['version', 'adapterId', 'carrier', 'identity'])) {
      return null;
    }
    const carrier = value.carrier;
    const identity = closeIdentity(value.identity);
    if (
      value.version !== PRODUCTION_LIVE_READ_ACQUISITION_VERSION
      || value.adapterId !== input.adapter.adapterId
      || !plainRecord(carrier)
      || !exactKeys(carrier, ['kind', 'name'])
      || carrier.kind !== input.adapter.carrier.kind
      || carrier.name !== input.adapter.carrier.name
      || !identity
      || identity.observedAt > input.now
      || input.now - identity.observedAt > 60_000
    ) return null;
    nominations.push({
      version: PRODUCTION_LIVE_READ_ACQUISITION_VERSION,
      adapterId: input.adapter.adapterId,
      carrier: { kind: input.adapter.carrier.kind, name: input.adapter.carrier.name },
      identity,
    });
  }
  nominations.sort((left, right) => nominationKey(left).localeCompare(nominationKey(right)));
  return { status: 'nominated', nominations };
}

function nominationKey(nomination: ProductionLiveReadNominationV1): string {
  return closedCanonicalJson(nomination, NOMINATION_JSON_OPTIONS);
}

function nominationLabel(nomination: ProductionLiveReadNominationV1): string {
  return `${nomination.adapterId}:${nomination.identity.reference.identifier}`;
}

function configuredMcpServerNames(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_ADAPTERS) {
    throw new Error('configured MCP carrier inventory is unavailable or unbounded');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error('configured MCP carrier inventory is not closed data');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.get || descriptor.set || !('value' in descriptor)) {
      throw new Error('configured MCP carrier inventory is sparse or executable');
    }
    const server = descriptor.value;
    if (!plainRecord(server) || Object.getOwnPropertySymbols(server).length > 0) {
      throw new Error('configured MCP carrier identity is not closed data');
    }
    const fields = Object.getOwnPropertyDescriptors(server);
    const name = fields.name;
    const enabled = fields.enabled;
    if (
      !name || name.get || name.set || !('value' in name)
      || !enabled || enabled.get || enabled.set || !('value' in enabled)
      || !boundedText(name.value)
      || typeof enabled.value !== 'boolean'
    ) throw new Error('configured MCP carrier identity is incomplete');
    if (enabled.value) names.push(name.value);
  }
  return names.sort((left, right) => left.localeCompare(right));
}

/**
 * Adapt any exact live carrier to the registry contract. A future reviewed CLI
 * or authenticated gateway can use this same port; it must supply its real
 * observation/materialization implementation rather than a name branch.
 */
export function createAttestedLiveReadCarrierAdapter(input: {
  adapterId: string;
  carrier: LiveCapabilityCarrier;
  materialize(
    objective: string,
    expectedIdentity: AttestedLiveReadCapabilityIdentity,
    publicationGuard?: () => boolean,
  ): Promise<MaterializeLiveReadCapabilityResult>;
  now?: () => number;
}): ProductionLiveReadCarrierAdapterV1 {
  if (!boundedText(input.adapterId) || !boundedText(input.carrier.identity.name)) {
    throw new TypeError('live read carrier adapter identity is incomplete');
  }
  const adapterId = input.adapterId;
  const carrier = Object.freeze({ ...input.carrier.identity });
  const adapter: ProductionLiveReadCarrierAdapterV1 = {
    version: PRODUCTION_LIVE_READ_ACQUISITION_VERSION,
    adapterId,
    carrier,
    async nominate(requirement) {
      let rawRows: unknown;
      try {
        rawRows = await input.carrier.enumerate();
      } catch {
        return { status: 'unavailable', detail: 'the carrier could not be enumerated' };
      }
      let closed: ReturnType<typeof canonicalLiveCapabilityEnumerationRows>;
      try {
        closed = canonicalLiveCapabilityEnumerationRows(rawRows, input.carrier.identity);
      } catch {
        return { status: 'unavailable', detail: 'the carrier enumeration is not closed data' };
      }
      if (!closed.ok) return { status: 'unavailable', detail: closed.detail };
      const eligible = closed.rows.filter((row) => (
        row.effectClass === 'read'
        && (row.effectProvenance === 'declared' || row.effectProvenance === 'curated')
        && boundedText(row.accountIdentity)
      ));
      // An exact operation identifier is stronger than advisory token overlap.
      // Keep every exact account row so genuine account ambiguity still fails
      // closed; use fuzzy nomination only when the carrier has no exact row.
      const normalizedObjective = normalizeText(requirement.objective);
      const exact = eligible.filter((row) => (
        normalizeText(row.identifier) === normalizedObjective
      ));
      const rows = (exact.length > 0 ? exact : eligible.filter((row) => (
        rowIsAdvisoryObjectiveNomination(
          row,
          requirement.objective,
          input.carrier.identity.kind,
        )
      )))
        .sort((left, right) => (
          `${left.identifier}\0${left.accountIdentity}`
            .localeCompare(`${right.identifier}\0${right.accountIdentity}`)
        ));
      if (rows.length === 0) return { status: 'missing' };
      const nominations: ProductionLiveReadNominationV1[] = [];
      for (const row of rows) {
        const reference = Object.freeze({
          identifier: row.identifier,
          accountId: row.accountIdentity!,
        });
        let observed: ReturnType<LiveCapabilityCarrier['observe']>;
        try {
          observed = input.carrier.observe(reference);
        } catch {
          return { status: 'unavailable', detail: 'a nominated definition could not be observed' };
        }
        const attested = attestLiveReadDefinition({
          carrier: input.carrier.identity,
          reference,
          definition: observed,
          now: (input.now ?? Date.now)(),
        });
        if (!attested.ok) {
          return { status: 'unavailable', detail: 'a matching definition is not currently attested' };
        }
        nominations.push({
          version: PRODUCTION_LIVE_READ_ACQUISITION_VERSION,
          adapterId,
          carrier,
          identity: liveReadCapabilityIdentity(attested.attestation),
        });
      }
      return { status: 'nominated', nominations };
    },
    materialize({ requirement, nomination, publicationGuard }) {
      return input.materialize(
        requirement.objective,
        nomination.identity,
        publicationGuard,
      );
    },
  };
  return Object.freeze(adapter);
}

/** Real native-MCP adapter; listTools and the configured server are its source. */
export function createProductionMcpLiveReadAcquisitionAdapter(input: {
  serverName: string;
  runtime?: ProductionMcpRuntime;
}): ProductionLiveReadCarrierAdapterV1 {
  const mcp = createProductionMcpReadCarrier(input);
  return createAttestedLiveReadCarrierAdapter({
    adapterId: `native_mcp:${mcp.carrier.identity.name}`,
    carrier: mcp.carrier,
    materialize: (objective, expectedIdentity, publicationGuard) => (
      mcp.materialize(objective, expectedIdentity, publicationGuard)
    ),
  });
}

/** Real reviewed-CLI adapter. Its sole inventory is the durable closed
 * descriptor registry; PATH discovery and saved CLI names never call this. */
export function createProductionReviewedCliLiveReadAcquisitionAdapter(): ProductionLiveReadCarrierAdapterV1 {
  const cli = createProductionReviewedCliReadCarrier();
  return createAttestedLiveReadCarrierAdapter({
    adapterId: `reviewed_cli:${cli.carrier.identity.name}`,
    carrier: cli.carrier,
    materialize: (objective, expectedIdentity, publicationGuard) => (
      cli.materialize(objective, expectedIdentity, publicationGuard)
    ),
  });
}

function defaultConfiguredMcpAdapters(
  options: Pick<
    ProductionLiveReadAcquisitionRegistryOptions,
    'configuredMcpServers' | 'mcpRuntimeForServer'
  >,
): readonly ProductionLiveReadCarrierAdapterV1[] {
  const inventory = options.configuredMcpServers?.() ?? discoverMcpServers();
  return configuredMcpServerNames(inventory).map((serverName) => (
    createProductionMcpLiveReadAcquisitionAdapter({
      serverName,
      ...(options.mcpRuntimeForServer
        ? { runtime: options.mcpRuntimeForServer(serverName) }
        : {}),
    })
  ));
}

function defaultConfiguredAdapters(
  options: Pick<
    ProductionLiveReadAcquisitionRegistryOptions,
    'configuredMcpServers' | 'mcpRuntimeForServer'
  >,
): readonly ProductionLiveReadCarrierAdapterV1[] {
  const mcp = defaultConfiguredMcpAdapters(options);
  // Absence is ordinary blank state. A present malformed registry throws and
  // makes the complete configured inventory unavailable rather than silently
  // ignoring reviewed authority whose bytes cannot be closed.
  const reviewedCli = listReviewedCliReadDescriptors().length > 0
    ? [createProductionReviewedCliLiveReadAcquisitionAdapter()]
    : [];
  return [...mcp, ...reviewedCli];
}

function manifestMatchesNomination(
  manifest: CapabilityManifestV1,
  nomination: ProductionLiveReadNominationV1,
): boolean {
  const identity = nomination.identity;
  return manifest.operationId === identity.reference.identifier
    && manifest.providerKind === identity.providerKind
    && manifest.providerIdentity === identity.providerIdentity
    && manifest.providerVersion === identity.providerVersion
    && manifest.operationVersion === identity.operationVersion
    && manifest.definitionFingerprint === identity.definitionFingerprint
    && manifest.accountId === identity.accountId
    && manifest.effect === 'read'
    && manifest.invokePortId === identity.invoke.portId
    && manifest.argumentCompiler.id === identity.invoke.argumentCompiler.id
    && manifest.argumentCompiler.version === identity.invoke.argumentCompiler.version;
}

async function mapBounded<T, R>(
  values: readonly T[],
  worker: (value: T) => Promise<R>,
  width = 8,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const lane = async (): Promise<void> => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, values.length) }, () => lane()));
  return results;
}

type ControlledAwaitResult<T> =
  | { status: 'settled'; value: T }
  | { status: 'failed'; error: unknown }
  | { status: 'expired' };

function acquisitionControlActive(
  control: ProductionLiveReadAcquisitionControlV1 | undefined,
): boolean {
  return !control?.signal?.aborted
    && (control?.deadlineAt === undefined || Date.now() < control.deadlineAt);
}

/** Consume both late fulfillment and late rejection. Expiry stops the registry
 * continuation; the materializer's publication guard separately prevents the
 * already-started carrier promise from changing authority later. */
async function awaitControlled<T>(input: {
  start: () => Promise<T> | T;
  control?: ProductionLiveReadAcquisitionControlV1;
}): Promise<ControlledAwaitResult<T>> {
  if (!acquisitionControlActive(input.control)) return { status: 'expired' };
  let work: Promise<T>;
  try {
    work = Promise.resolve(input.start());
  } catch (error) {
    return { status: 'failed', error };
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: ControlledAwaitResult<T>): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      input.control?.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = (): void => finish({ status: 'expired' });
    work.then(
      (value) => finish({ status: 'settled', value }),
      (error) => finish({ status: 'failed', error }),
    );
    input.control?.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.control?.signal?.aborted) onAbort();
    if (!settled && input.control?.deadlineAt !== undefined) {
      timer = setTimeout(
        () => finish({ status: 'expired' }),
        Math.max(0, input.control.deadlineAt - Date.now()),
      );
    }
  });
}

/**
 * Enumerates all currently configured adapters, admits exactly one live
 * nomination, and delegates installation to that adapter's shared materializer.
 */
export function createProductionLiveReadAcquisitionRegistry(
  options: ProductionLiveReadAcquisitionRegistryOptions = {},
): ProductionLiveReadAcquisitionRegistryV1 {
  let queue: Promise<void> = Promise.resolve();

  const configured = async (): Promise<{
    adapters: readonly ProductionLiveReadCarrierAdapterV1[];
    policyExcluded: number;
  }> => {
    const primary = options.configuredAdapters
      ? await options.configuredAdapters()
      : defaultConfiguredAdapters(options);
    const additional = options.additionalAdapters ? await options.additionalAdapters() : [];
    const combined = [...primary, ...additional];
    const closed = closeAdapterInventory(combined);
    if (!closed.ok) {
      throw new Error(closed.reason === 'unbounded'
        ? 'configured carrier adapter inventory is unbounded'
        : 'configured carrier adapter inventory is invalid');
    }
    const adapters = closed.adapters.filter((adapter) => (
      options.adapterAllowed?.(Object.freeze({
        adapterId: adapter.adapterId,
        carrier: Object.freeze({ ...adapter.carrier }),
      })) ?? true
    ));
    return {
      adapters,
      policyExcluded: closed.adapters.length - adapters.length,
    };
  };

  const surfaces = (): {
    store: CapabilityManifestStore;
    factory: HostCapabilityCatalogFactory;
  } => {
    const store = options.store
      ?? peekCapabilityManifestStore()
      ?? resolveCapabilityManifestStore();
    const installedFactory = peekHostCapabilityCatalogFactory();
    const factory = options.factory ?? installedFactory ?? createHostCapabilityCatalogFactory();
    if (!options.factory && !installedFactory) installHostCapabilityCatalogFactory(factory);
    return { store, factory };
  };

  const retire = (
    requirement: ProductionLiveReadRequirementV1,
    extra: readonly string[] = [],
    preserveManifestId?: string,
  ): readonly string[] => {
    const { store, factory } = surfaces();
    const retired = new Set(retireLiveReadObjectiveAuthority({
      objective: requirement.objective,
      store,
      factory,
      ...(preserveManifestId ? { preserveManifestId } : {}),
    }));
    for (const id of [...new Set(extra)].sort()) {
      if (id === preserveManifestId) continue;
      factory.forget(id);
      const current = store.get(id)?.manifest.lifecycle.state === 'current';
      if (current && store.revoke(id)) retired.add(id);
      else if (!current) retired.add(id);
    }
    return [...retired].sort();
  };

  const block = (
    requirement: ProductionLiveReadRequirementV1,
    reason: Extract<MaterializeLiveReadCapabilityResult, { status: 'blocked' }>['reason'],
    detail: string,
    extra: readonly string[] = [],
  ): MaterializeLiveReadCapabilityResult => ({
    status: 'blocked',
    reason,
    detail,
    retired: retire(requirement, extra),
  });

  const refuseWithoutRetiring = (
    reason: Extract<MaterializeLiveReadCapabilityResult, { status: 'blocked' }>['reason'],
    detail: string,
  ): MaterializeLiveReadCapabilityResult => ({
    status: 'blocked',
    reason,
    detail,
    retired: [],
  });

  const expired = (): MaterializeLiveReadCapabilityResult => refuseWithoutRetiring(
    'publication_expired',
    'the bounded acquisition caller stopped awaiting live-read discovery',
  );

  const acquireOnce = async (
    raw: ProductionLiveReadRequirementV1,
    control?: ProductionLiveReadAcquisitionControlV1,
  ): Promise<MaterializeLiveReadCapabilityResult> => {
    if (!acquisitionControlActive(control)) return expired();
    const requirement = closeRequirement(raw);
    if (!requirement) {
      return {
        status: 'blocked',
        reason: 'invalid_definition',
        detail: 'the live-read requirement is incomplete',
        retired: [],
      };
    }
    const configuredResult = await awaitControlled({ start: configured, control });
    if (configuredResult.status === 'expired') return expired();
    if (configuredResult.status === 'failed') {
      return block(requirement, 'carrier_unavailable', 'configured carrier adapters are unavailable');
    }
    const { adapters, policyExcluded } = configuredResult.value;
    if (adapters.length === 0) {
      if (policyExcluded > 0) {
        return refuseWithoutRetiring(
          'missing',
          'all otherwise configured live-read carriers are outside this request scope',
        );
      }
      return block(requirement, 'missing', 'no live-read carrier adapters are configured');
    }
    const duplicateIds = adapters
      .map((adapter) => adapter.adapterId)
      .filter((id, index, all) => all.indexOf(id) !== index);
    if (duplicateIds.length > 0) {
      return block(
        requirement,
        'ambiguous',
        `configured carrier adapter identities are ambiguous: ${[...new Set(duplicateIds)].sort().join(', ')}`,
      );
    }

    const observed = await mapBounded(adapters, async (adapter) => {
      const nominated = await awaitControlled({
        start: () => adapter.nominate(Object.freeze({ ...requirement })),
        control,
      });
      if (nominated.status === 'expired') return { status: 'expired' as const };
      if (nominated.status === 'settled') {
        const result = closeNominationResult({
          value: nominated.value,
          adapter,
          now: (options.now ?? Date.now)(),
        });
        return result ?? {
          status: 'unavailable' as const,
          detail: 'the carrier returned an invalid nomination envelope',
        };
      }
      return {
        status: 'unavailable' as const,
        detail: 'the carrier nomination failed',
      };
    });
    if (observed.some((result) => result.status === 'expired')) return expired();
    if (!acquisitionControlActive(control)) return expired();
    const unavailable = observed.flatMap((result, index) => (
      result.status === 'unavailable' ? [adapters[index]!.adapterId] : []
    )).sort();
    if (unavailable.length > 0) {
      return block(
        requirement,
        'carrier_unavailable',
        `configured carrier adapters could not be fully observed: ${unavailable.join(', ')}`,
      );
    }
    const allNominated = observed.flatMap((result) => (
      result.status === 'nominated' ? [...result.nominations] : []
    )).sort((left, right) => nominationKey(left).localeCompare(nominationKey(right)));
    // Exact identity precedence is global across the configured carrier set.
    // A sibling carrier's fuzzy hit cannot dilute an exact operation exposed
    // by another carrier. Preserve every exact account/provider nomination so
    // genuine cross-carrier or multi-account ambiguity remains closed.
    const normalizedObjective = normalizeText(requirement.objective);
    const exactNominated = allNominated.filter((nomination) => (
      normalizeText(nomination.identity.reference.identifier) === normalizedObjective
    ));
    const nominated = exactNominated.length > 0 ? exactNominated : allNominated;
    let nominationPolicyExcluded = 0;
    let nominations: ProductionLiveReadNominationV1[];
    try {
      nominations = nominated.filter((nomination) => {
        const allowed = options.nominationAllowed?.(Object.freeze(nomination)) ?? true;
        if (!allowed) nominationPolicyExcluded += 1;
        return allowed;
      });
    } catch {
      return refuseWithoutRetiring(
        'carrier_unavailable',
        'the live-read nomination policy could not be evaluated',
      );
    }
    if (nominations.length === 0) {
      if (policyExcluded > 0 || nominationPolicyExcluded > 0) {
        return refuseWithoutRetiring(
          'missing',
          'current matching live-read capabilities are outside this request scope',
        );
      }
      return block(requirement, 'missing', 'no current attested read capability matched the objective');
    }
    if (nominations.length !== 1) {
      return block(
        requirement,
        'ambiguous',
        `${nominations.length} current attested read capabilities matched: ${nominations.map(nominationLabel).join(', ')}`,
      );
    }
    const nomination = nominations[0]!;
    const adapter = adapters.find((candidate) => candidate.adapterId === nomination.adapterId)!;
    const materializedResult = await awaitControlled({
      start: () => adapter.materialize({
        requirement: Object.freeze({ ...requirement }),
        nomination: Object.freeze(nomination),
        publicationGuard: () => acquisitionControlActive(control),
      }),
      control,
    });
    if (materializedResult.status === 'expired') return expired();
    if (materializedResult.status === 'failed') {
      return block(requirement, 'live_unavailable', 'the nominated carrier could not materialize');
    }
    const materialized = materializedResult.value;
    if (materialized.status === 'blocked') {
      if (
        materialized.reason === 'publication_expired'
        || !acquisitionControlActive(control)
      ) return expired();
      return block(
        requirement,
        materialized.reason,
        materialized.detail,
        materialized.retired,
      );
    }
    if (!acquisitionControlActive(control)) return expired();
    const { store, factory } = surfaces();
    const stored = store.get(materialized.manifest.manifestId);
    const catalog = factory.get(materialized.manifest.manifestId);
    const port = resolveProductionPortsForManifest(materialized.manifest);
    const current = currentCapabilityManifest(materialized.manifest);
    if (
      !current
      || !manifestMatchesNomination(current, nomination)
      || !liveReadIdentityMatches(materialized.attestation, nomination.identity)
      || !stored
      || stored.digest !== capabilityManifestDigest(current)
      || stored.manifest.lifecycle.state !== 'current'
      || !catalog
      || catalog.manifestDigest !== stored.digest
      || !port
      || typeof port.invoke !== 'function'
    ) {
      return block(
        requirement,
        'identity_mismatch',
        'the installed authority does not reproduce the exact live nomination',
        [materialized.manifest.manifestId],
      );
    }
    if (!acquisitionControlActive(control)) return expired();
    const registryReplaced = retire(requirement, [], current.manifestId);
    return {
      ...materialized,
      replaced: [...new Set([...materialized.replaced, ...registryReplaced])].sort(),
    };
  };

  const registry: ProductionLiveReadAcquisitionRegistryV1 = {
    acquire(raw, control) {
      const run = queue.then(() => acquireOnce(raw, control));
      queue = run.then(() => undefined, () => undefined);
      return run;
    },
  };
  return Object.freeze(registry);
}

/** Canonical production port consumed structurally by the automation pilot. */
export function configuredProductionLiveReadAcquisitionPort(
  options: ProductionLiveReadAcquisitionRegistryOptions = {},
): ProductionLiveReadAcquisitionPortV1 {
  return createProductionLiveReadAcquisitionRegistry(options);
}
