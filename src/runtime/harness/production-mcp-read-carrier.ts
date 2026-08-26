/**
 * Production blank-state adapter for configured native MCP servers.
 *
 * The configured connection and live `tools/list` response are the only
 * sources. The capability index is populated only as a retrieval aid. A
 * manifest and immutable invoke port are installed after a second live list,
 * an independent observer agrees, and the exact definition remains unchanged.
 * Accepted execution performs one separately-accounted live list immediately
 * before `tools/call`. Its opaque observation proof is consumed by exactly one
 * immutable port invocation, so stale catalog or memory rows can never dispatch
 * and metadata I/O is never hidden inside the business crossing.
 */
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { MCPServer } from '@openai/agents';

import type { ManagedMcpServer } from '../../types.js';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import { discoverMcpServers } from '../mcp-config.js';
import {
  getOrCreateExternalMcpServerForTool,
  getOrCreateExternalMcpServers,
} from '../mcp-servers.js';
import { parseNamespacedTool, slugifyServerName } from '../mcp-namespace-shim.js';
import {
  attestLiveExternalCapabilityDefinition,
  attestLiveReadDefinition,
  materializeLiveReadCapability,
  type AttestedLiveExternalCapability,
  type AttestedLiveReadCapability,
  type AttestedLiveReadCapabilityIdentity,
  type LiveCapabilityCarrier,
  type LiveCapabilityDefinition,
  type LiveCapabilityObservationResult,
  type LiveCapabilityReference,
  type MaterializeLiveReadCapabilityResult,
} from './live-capability-materializer.js';
import {
  refreshIndependentCapabilityObservation,
  type IndependentCapabilityObservation,
} from './independent-capability-observation.js';
import {
  productionPortIdentityFromManifest,
  registerProductionCapabilityPort,
  resolveProductionPortsForManifest,
} from './production-capability-ports.js';
import {
  isShippedInvoke,
  loadShippedImplementations,
  shippedImplementationDigest,
  shippedTransportDigest,
} from './shipped-implementation-identity.js';
import { isolatedTestContractActive } from './isolated-test-contract.js';
import {
  capabilityManifestDigest,
  validateCapabilityManifestV1,
  type CapabilityManifestV1,
} from './capability-manifest.js';
import {
  peekCapabilityManifestStore,
  resolveCapabilityManifestStore,
} from './capability-manifest-store.js';
import {
  createHostCapabilityCatalogFactory,
  installHostCapabilityCatalogFactory,
  peekHostCapabilityCatalogFactory,
} from './host-capability-catalog-factory.js';
import { registeredCapabilityFromManifest } from './production-capability-adapter.js';
import { saveToolContract } from '../../tools/tool-contract-store.js';
import type {
  AttestedTransportCall,
  AttestedTransportObservation,
} from './implementation-artifacts/attested-transport.js';

const MCP_CARRIER_VERSION = 1 as const;
const MCP_PORT_COMPILER = Object.freeze({ id: 'host:mcp-json-arguments', version: '1' });
const MAX_CONFIGS = 1_000;
const MAX_TOOLS = 10_000;
const MAX_IDENTITY_BYTES = 512;
const CLOSED_CONFIG_OPTIONS = Object.freeze({
  maxDepth: 8,
  maxNodes: 20_000,
  maxStringBytes: 128_000,
  maxTotalBytes: 2_000_000,
});
const CLOSED_TOOL_LIST_OPTIONS = Object.freeze({
  maxDepth: 32,
  maxNodes: 250_000,
  maxStringBytes: 1_048_576,
  maxTotalBytes: 16_777_216,
});

type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  [key: string]: unknown;
};

export interface ProductionMcpRuntime {
  configuredServers(): readonly ManagedMcpServer[];
  serverForEnumeration(serverSlug: string): Pick<MCPServer, 'listTools' | 'callTool' | 'invalidateToolsCache'>;
  serverForOperation(operationId: string): Pick<MCPServer, 'listTools' | 'callTool' | 'invalidateToolsCache'>;
  /** Test/build-generation seam. Production always uses shipped artifact IDs. */
  portIdentity?(): { portId: string; compiler: { id: string; version: string } };
}

interface ClosedConfiguredServer {
  name: string;
  type: 'stdio' | 'http' | 'sse';
  enabled: true;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

interface ObservedMcpDefinition {
  definition: LiveCapabilityDefinition;
  toolBytes: string;
  effectProvenance: 'declared' | 'none';
}

interface McpSnapshot {
  providerIdentity: string;
  providerVersion: string;
  accountId: string;
  server: Pick<MCPServer, 'listTools' | 'callTool' | 'invalidateToolsCache'>;
  definitions: readonly ObservedMcpDefinition[];
}

/** Opaque hand-off from one separately-accounted live-definition probe to the
 * immediately following exact business call. Object shape is never authority. */
export interface PreparedProductionMcpInvocationV1 {
  readonly version: 1;
}

interface PreparedProductionMcpInvocationState {
  runtime: ProductionMcpRuntime;
  snapshot: McpSnapshot;
  manifestDigest: string;
  operationId: string;
  accountId: string;
  entered: boolean;
  used: boolean;
}

const runtimeByManifestDigest = new Map<string, ProductionMcpRuntime>();
const preparedInvocations = new WeakMap<object, PreparedProductionMcpInvocationState>();
const preparedInvocationStorage = new AsyncLocalStorage<PreparedProductionMcpInvocationState>();

export interface ProductionMcpReadCarrier {
  carrier: LiveCapabilityCarrier;
  materialize(
    objective: string,
    expectedIdentity?: AttestedLiveReadCapabilityIdentity,
  ): Promise<MaterializeLiveReadCapabilityResult>;
  refreshIndependentObservation(input: {
    operationId: string;
    accountId: string;
    definitionFingerprint: string;
    providerVersion: string;
    operationVersion: string;
  }): Promise<IndependentCapabilityObservation | null>;
  /** Materialize one exact tools/list operation already returned by foreground
   * tool_search. Unlike the advisory read shortlist, this path admits both
   * declared reads and declared writes and never selects by model prose. */
  materializeExact(input: {
    operationId: string;
    inputSchema: unknown;
  }): Promise<MaterializeProductionMcpCapabilityResult>;
}

export type ProductionMcpCapabilityMaterializationRefusal =
  | 'invalid_operation'
  | 'live_unavailable'
  | 'missing'
  | 'ambiguous'
  | 'unknown_effect'
  | 'schema_drift'
  | 'definition_drift'
  | 'port_registration_failed'
  | 'independent_observation_missing'
  | 'schema_contract_conflict'
  | 'manifest_install_failed'
  | 'catalog_registration_failed';

export type MaterializeProductionMcpCapabilityResult =
  | {
      status: 'installed';
      manifest: CapabilityManifestV1;
      attestation: AttestedLiveExternalCapability;
      replaced: readonly string[];
    }
  | {
      status: 'blocked';
      reason: ProductionMcpCapabilityMaterializationRefusal;
      detail: string;
      retired: readonly string[];
    };

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function boundedIdentity(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && Buffer.byteLength(value, 'utf8') <= MAX_IDENTITY_BYTES;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clonedClosedRecord(value: unknown): Record<string, unknown> {
  const bytes = closedCanonicalJson(value, CLOSED_TOOL_LIST_OPTIONS);
  const parsed = JSON.parse(bytes) as unknown;
  if (!plainRecord(parsed)) throw new Error('MCP schema is not a closed JSON object');
  return parsed;
}

function ownDataValue(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return undefined;
  if ('get' in descriptor || 'set' in descriptor) {
    throw new Error(`configured MCP server field ${key} is executable`);
  }
  return descriptor.value;
}

function closedStringMap(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const bytes = closedCanonicalJson(value, CLOSED_CONFIG_OPTIONS);
  const parsed = JSON.parse(bytes) as unknown;
  if (!plainRecord(parsed)) throw new Error(`configured MCP ${field} is not an object`);
  const entries = Object.entries(parsed);
  if (entries.some(([key, item]) => !boundedIdentity(key) || typeof item !== 'string')) {
    throw new Error(`configured MCP ${field} is not a string map`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function closeConfiguredServer(value: unknown): ClosedConfiguredServer {
  if (!plainRecord(value) || Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error('configured MCP server is not a closed object');
  }
  const allowed = new Set([
    'name', 'type', 'command', 'args', 'url', 'headers', 'env',
    'description', 'enabled', 'source',
  ]);
  if (Object.getOwnPropertyNames(value).some((key) => !allowed.has(key))) {
    throw new Error('configured MCP server has an unsupported identity field');
  }
  const name = ownDataValue(value, 'name');
  const type = ownDataValue(value, 'type');
  const enabled = ownDataValue(value, 'enabled');
  if (!boundedIdentity(name) || (type !== 'stdio' && type !== 'http' && type !== 'sse') || enabled !== true) {
    throw new Error('configured MCP server identity is incomplete');
  }
  const command = ownDataValue(value, 'command');
  const url = ownDataValue(value, 'url');
  if (command !== undefined && !boundedIdentity(command)) {
    throw new Error('configured MCP command identity is invalid');
  }
  if (url !== undefined && !boundedIdentity(url)) {
    throw new Error('configured MCP URL identity is invalid');
  }
  const rawArgs = ownDataValue(value, 'args');
  let args: string[] | undefined;
  if (rawArgs !== undefined) {
    const bytes = closedCanonicalJson(rawArgs, CLOSED_CONFIG_OPTIONS);
    const parsed = JSON.parse(bytes) as unknown;
    if (!Array.isArray(parsed) || parsed.length > 256 || parsed.some((item) => typeof item !== 'string')) {
      throw new Error('configured MCP argv is invalid');
    }
    args = parsed;
  }
  const headers = closedStringMap(ownDataValue(value, 'headers'), 'headers');
  const env = closedStringMap(ownDataValue(value, 'env'), 'environment');
  const closed: ClosedConfiguredServer = {
    name,
    type,
    enabled: true,
    ...(command !== undefined ? { command } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(env !== undefined ? { env } : {}),
  };
  if (type === 'stdio' && !closed.command) throw new Error('configured stdio MCP server has no command');
  if ((type === 'http' || type === 'sse') && !closed.url) {
    throw new Error('configured remote MCP server has no URL');
  }
  return closed;
}

function productionRuntime(): ProductionMcpRuntime {
  return {
    configuredServers: () => discoverMcpServers().filter((server) => server.enabled),
    serverForEnumeration: (serverSlug) => getOrCreateExternalMcpServers({
      reason: 'live capability materialization for one configured MCP server',
      authority: 'catalog',
      allowedServerSlugs: [serverSlug],
    }),
    serverForOperation: (operationId) => getOrCreateExternalMcpServerForTool(operationId),
  };
}

function portIdentity(runtime: ProductionMcpRuntime): {
  portId: string;
  compiler: { id: string; version: string };
} {
  const injected = runtime.portIdentity?.();
  if (injected) {
    if (
      !boundedIdentity(injected.portId)
      || !boundedIdentity(injected.compiler?.id)
      || !boundedIdentity(injected.compiler?.version)
    ) throw new Error('MCP host port identity is incomplete');
    return {
      portId: injected.portId,
      compiler: { ...injected.compiler },
    };
  }
  const generation = sha256(JSON.stringify({
    invoke: shippedImplementationDigest('invoke'),
    transport: shippedTransportDigest(),
  }));
  return {
    portId: `host:native-mcp-read:${generation}`,
    compiler: { ...MCP_PORT_COMPILER },
  };
}

function exactConfiguredServer(
  runtime: ProductionMcpRuntime,
  requestedSlug: string,
): { server: ClosedConfiguredServer; bytes: string; digest: string } {
  const configured = runtime.configuredServers();
  if (!Array.isArray(configured) || configured.length > MAX_CONFIGS) {
    throw new Error('configured MCP inventory is unavailable or unbounded');
  }
  const matches = configured
    .map((entry) => closeConfiguredServer(entry))
    .filter((entry) => slugifyServerName(entry.name) === requestedSlug);
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `configured MCP server ${requestedSlug} is unavailable`
      : `configured MCP server ${requestedSlug} is ambiguous`);
  }
  const server = matches[0]!;
  const bytes = closedCanonicalJson(server, CLOSED_CONFIG_OPTIONS);
  return { server, bytes, digest: sha256(bytes) };
}

function parseClosedToolList(raw: unknown, serverSlug: string): Array<{
  tool: McpToolDefinition;
  bytes: string;
  parsedName: { serverSlug: string; toolName: string };
}> {
  const bytes = closedCanonicalJson(raw, CLOSED_TOOL_LIST_OPTIONS);
  const parsed = JSON.parse(bytes) as unknown;
  if (!Array.isArray(parsed) || parsed.length > MAX_TOOLS) {
    throw new Error('MCP tools/list response is not a bounded array');
  }
  return parsed.map((entry) => {
    if (!plainRecord(entry)) throw new Error('MCP tool definition is not an object');
    const name = entry.name;
    const description = entry.description;
    const inputSchema = entry.inputSchema;
    const outputSchema = entry.outputSchema;
    const annotations = entry.annotations;
    if (
      !boundedIdentity(name)
      || (description !== undefined && typeof description !== 'string')
      || !plainRecord(inputSchema)
      || (outputSchema !== undefined && !plainRecord(outputSchema))
      || (annotations !== undefined && !plainRecord(annotations))
    ) throw new Error('MCP tool definition is incomplete');
    const parsedName = parseNamespacedTool(name);
    if (!parsedName || parsedName.serverSlug !== serverSlug) {
      throw new Error('MCP tool identity is outside the configured server namespace');
    }
    return {
      tool: entry as McpToolDefinition,
      bytes: closedCanonicalJson(entry, CLOSED_TOOL_LIST_OPTIONS),
      parsedName,
    };
  });
}

function effectOf(tool: McpToolDefinition): {
  effect: 'read' | 'external_write' | 'unknown';
  attestation: LiveCapabilityDefinition['effectAttestation'];
  provenance: 'declared' | 'none';
  behaviorHints: {
    readOnly: boolean | null;
    destructive: boolean | null;
    idempotent: boolean | null;
    openWorld: boolean | null;
  };
} {
  const annotations = tool.annotations;
  const declared = (key: string): boolean | null => {
    if (!annotations || !Object.hasOwn(annotations, key)) return null;
    const value = annotations[key];
    return typeof value === 'boolean' ? value : null;
  };
  const behaviorHints = {
    readOnly: declared('readOnlyHint'),
    destructive: declared('destructiveHint'),
    idempotent: declared('idempotentHint'),
    openWorld: declared('openWorldHint'),
  };
  const anyEffectDeclaration = behaviorHints.readOnly !== null
    || behaviorHints.destructive !== null;
  // Contradictory declarations are never resolved by the operation name.
  if (behaviorHints.readOnly === true && behaviorHints.destructive === true) {
    return {
      effect: 'unknown',
      attestation: 'none',
      provenance: 'declared',
      behaviorHints,
    };
  }
  if (behaviorHints.readOnly === true) {
    return {
      effect: 'read',
      attestation: 'carrier_declared',
      provenance: 'declared',
      behaviorHints,
    };
  }
  if (behaviorHints.readOnly === false || behaviorHints.destructive !== null) {
    return {
      effect: 'external_write',
      attestation: 'carrier_declared',
      provenance: 'declared',
      behaviorHints,
    };
  }
  return {
    effect: 'unknown',
    attestation: 'none',
    provenance: anyEffectDeclaration ? 'declared' : 'none',
    behaviorHints,
  };
}

async function freshSnapshot(input: {
  runtime: ProductionMcpRuntime;
  serverSlug: string;
  operationId?: string;
}): Promise<McpSnapshot> {
  const config = exactConfiguredServer(input.runtime, input.serverSlug);
  // Metadata preparation is scoped by the exact manifest server slug. It may
  // never re-select a server from an operation name at this last edge.
  const server = input.runtime.serverForEnumeration(input.serverSlug);
  await server.invalidateToolsCache();
  const rawTools = await server.listTools();
  const tools = parseClosedToolList(rawTools, input.serverSlug);
  const catalogBytes = closedCanonicalJson(
    tools.map((entry) => entry.bytes).sort(),
    CLOSED_TOOL_LIST_OPTIONS,
  );
  const observedAt = Date.now();
  const providerIdentity = `mcp-config:${input.serverSlug}:${config.digest}`;
  const providerVersion = `mcp-catalog-v${MCP_CARRIER_VERSION}:${sha256(`${config.bytes}\0${catalogBytes}`)}`;
  const accountId = `native_mcp:${input.serverSlug}:${config.digest}`;
  const invoke = portIdentity(input.runtime);
  const definitions = tools.map(({ tool, bytes, parsedName }) => {
    const operationVersion = `mcp-tool-v1:${sha256(bytes)}`;
    const effect = effectOf(tool);
    const definition: LiveCapabilityDefinition = {
      operationId: tool.name,
      providerKind: 'native_mcp',
      providerIdentity,
      providerVersion,
      operationVersion,
      accountId,
      effect: effect.effect,
      effectAttestation: effect.attestation,
      inputSchema: clonedClosedRecord(tool.inputSchema),
      externalDefinition: {
        version: 1,
        providerInputSchemaDigest: sha256(closedCanonicalJson(
          tool.inputSchema,
          CLOSED_TOOL_LIST_OPTIONS,
        )),
        providerOutputSchemaObserved: true,
        ...(tool.outputSchema
          ? {
              providerOutputSchemaDigest: sha256(closedCanonicalJson(
                tool.outputSchema,
                CLOSED_TOOL_LIST_OPTIONS,
              )),
            }
          : {}),
        semanticName: parsedName.toolName,
        behaviorHints: { ...effect.behaviorHints },
      },
      ...(tool.outputSchema
        ? {
            outputSchema: clonedClosedRecord(tool.outputSchema),
            outputSchemaAttestation: 'carrier_declared' as const,
          }
        : {}),
      observedAt,
      invoke: {
        portId: invoke.portId,
        argumentCompiler: { ...invoke.compiler },
      },
    };
    return { definition, toolBytes: bytes, effectProvenance: effect.provenance };
  });
  return {
    providerIdentity,
    providerVersion,
    accountId,
    server,
    definitions,
  };
}

function cloneDefinition(definition: LiveCapabilityDefinition): LiveCapabilityDefinition {
  return {
    ...definition,
    inputSchema: clonedClosedRecord(definition.inputSchema),
    ...(definition.outputSchema
      ? { outputSchema: clonedClosedRecord(definition.outputSchema) }
      : {}),
    ...(definition.externalDefinition
      ? {
          externalDefinition: {
            ...definition.externalDefinition,
            behaviorHints: { ...definition.externalDefinition.behaviorHints },
          },
        }
      : {}),
    invoke: {
      portId: definition.invoke.portId,
      argumentCompiler: { ...definition.invoke.argumentCompiler },
    },
  };
}

function observeFromSnapshot(
  snapshot: McpSnapshot | null,
  reference: LiveCapabilityReference,
): LiveCapabilityObservationResult {
  if (!snapshot) return 'missing';
  const exactOperation = snapshot.definitions.filter(
    (entry) => entry.definition.operationId === reference.identifier,
  );
  if (exactOperation.length === 0) return 'missing';
  if (exactOperation.length !== 1) return 'ambiguous';
  // Return the current account even when it differs from the nominated one;
  // the shared attester then reports identity_mismatch instead of silently
  // treating account drift as a removed tool.
  return cloneDefinition(exactOperation[0]!.definition);
}

function rowForDefinition(
  serverSlug: string,
  observed: ObservedMcpDefinition,
): {
  identifier: string;
  carrierKind: 'mcp';
  carrier: string;
  displayName: string;
  description: string;
  effectClass: 'read' | 'write' | 'unknown';
  effectProvenance: 'declared' | 'none';
  accountIdentity: string;
} {
  const parsed = parseNamespacedTool(observed.definition.operationId);
  if (!parsed) throw new Error('MCP operation identity is malformed');
  const raw = JSON.parse(observed.toolBytes) as McpToolDefinition;
  return {
    identifier: observed.definition.operationId,
    carrierKind: 'mcp',
    carrier: serverSlug,
    displayName: parsed.toolName,
    description: typeof raw.description === 'string' ? raw.description : '',
    effectClass: observed.definition.effect === 'read'
      ? 'read'
      : observed.definition.effect === 'external_write' ? 'write' : 'unknown',
    effectProvenance: observed.effectProvenance,
    accountIdentity: observed.definition.accountId,
  };
}

function definitionMatchesAttestation(input: {
  carrier: LiveCapabilityCarrier['identity'];
  reference: LiveCapabilityReference;
  definition: LiveCapabilityObservationResult;
  expected: AttestedLiveExternalCapability;
}): { ok: true; observedAt: number } | { ok: false } {
  const attested = attestLiveExternalCapabilityDefinition({
    carrier: input.carrier,
    reference: input.reference,
    definition: input.definition,
    now: Date.now(),
  });
  if (!attested.ok) return { ok: false };
  const actual = attested.attestation;
  return actual.definitionFingerprint === input.expected.definitionFingerprint
    && actual.schemaFingerprint === input.expected.schemaFingerprint
    && actual.providerIdentity === input.expected.providerIdentity
    && actual.providerVersion === input.expected.providerVersion
    && actual.operationVersion === input.expected.operationVersion
    && actual.accountId === input.expected.accountId
    && actual.effect === input.expected.effect
    && JSON.stringify(actual.externalDefinition ?? null)
      === JSON.stringify(input.expected.externalDefinition ?? null)
    && actual.invoke.portId === input.expected.invoke.portId
    && actual.invoke.argumentCompiler.id === input.expected.invoke.argumentCompiler.id
    && actual.invoke.argumentCompiler.version === input.expected.invoke.argumentCompiler.version
    ? { ok: true, observedAt: actual.observedAt }
    : { ok: false };
}

function snapshotMatchesManifest(
  snapshot: McpSnapshot,
  manifest: CapabilityManifestV1,
): boolean {
  const parsed = parseNamespacedTool(manifest.operationId);
  if (!parsed || manifest.providerKind !== 'native_mcp' || !manifest.externalDefinition) return false;
  const live = observeFromSnapshot(snapshot, {
    identifier: manifest.operationId,
    accountId: manifest.accountId,
  });
  const attested = attestLiveExternalCapabilityDefinition({
    carrier: { kind: 'mcp', name: parsed.serverSlug },
    reference: { identifier: manifest.operationId, accountId: manifest.accountId },
    definition: live,
    now: Date.now(),
  });
  if (!attested.ok) return false;
  const actual = attested.attestation;
  return actual.providerIdentity === manifest.providerIdentity
    && actual.providerVersion === manifest.providerVersion
    && actual.operationVersion === manifest.operationVersion
    && actual.definitionFingerprint === manifest.definitionFingerprint
    && actual.accountId === manifest.accountId
    && actual.invoke.portId === manifest.invokePortId
    && actual.invoke.argumentCompiler.id === manifest.argumentCompiler.id
    && actual.invoke.argumentCompiler.version === manifest.argumentCompiler.version
    && JSON.stringify(actual.externalDefinition ?? null)
      === JSON.stringify(manifest.externalDefinition);
}

/**
 * Perform the network/stdio tools/list freshness probe as its own provider
 * crossing. The caller owns physical admission/settlement around this method;
 * the returned opaque proof can authorize exactly one following callTool.
 */
export async function prepareProductionMcpInvocation(
  manifest: CapabilityManifestV1,
): Promise<PreparedProductionMcpInvocationV1> {
  const current = validateCapabilityManifestV1(manifest);
  if (!current.ok || current.manifest.providerKind !== 'native_mcp') {
    throw new Error('native MCP preparation requires one current exact manifest');
  }
  const parsed = parseNamespacedTool(current.manifest.operationId);
  if (!parsed) throw new Error('native MCP preparation operation is malformed');
  const manifestDigest = capabilityManifestDigest(current.manifest);
  const runtime = runtimeByManifestDigest.get(manifestDigest) ?? productionRuntime();
  const snapshot = await freshSnapshot({
    runtime,
    serverSlug: parsed.serverSlug,
    operationId: current.manifest.operationId,
  });
  if (!snapshotMatchesManifest(snapshot, current.manifest)) {
    throw new Error('native MCP preparation refused: live definition drifted');
  }
  const proof = Object.freeze({ version: 1 as const });
  preparedInvocations.set(proof, {
    runtime,
    snapshot,
    manifestDigest,
    operationId: current.manifest.operationId,
    accountId: current.manifest.accountId,
    entered: false,
    used: false,
  });
  return proof;
}

function assertProductionMcpPreparationLocally(
  manifest: CapabilityManifestV1,
  runtime: ProductionMcpRuntime,
): void {
  const current = validateCapabilityManifestV1(manifest);
  if (!current.ok || current.manifest.providerKind !== 'native_mcp') {
    throw new Error('native MCP local preparation requires one current exact manifest');
  }
  const parsed = parseNamespacedTool(current.manifest.operationId);
  if (!parsed) throw new Error('native MCP local preparation operation is malformed');
  const config = exactConfiguredServer(runtime, parsed.serverSlug);
  const providerIdentity = `mcp-config:${parsed.serverSlug}:${config.digest}`;
  const accountId = `native_mcp:${parsed.serverSlug}:${config.digest}`;
  const invoke = portIdentity(runtime);
  if (
    current.manifest.providerIdentity !== providerIdentity
    || current.manifest.accountId !== accountId
    || current.manifest.invokePortId !== invoke.portId
    || current.manifest.argumentCompiler.id !== invoke.compiler.id
    || current.manifest.argumentCompiler.version !== invoke.compiler.version
  ) {
    throw new Error('native MCP configured server/account/invoke identity changed before preparation');
  }
}

/** Bind an authentic fresh probe to one immutable port invocation. */
export async function withPreparedProductionMcpInvocation<T>(
  proof: PreparedProductionMcpInvocationV1,
  work: () => Promise<T>,
): Promise<T> {
  const prepared = preparedInvocations.get(proof as object);
  preparedInvocations.delete(proof as object);
  if (!prepared || prepared.entered) {
    throw new Error('native MCP preparation proof is absent, consumed, or inauthentic');
  }
  prepared.entered = true;
  return preparedInvocationStorage.run(prepared, async () => {
    const result = await work();
    if (!prepared.used) {
      throw new Error('native MCP immutable port did not consume its exact preparation proof');
    }
    return result;
  });
}

async function executeWithRuntime(
  runtime: ProductionMcpRuntime,
  call: AttestedTransportCall,
): Promise<unknown> {
  const expected = call.expected;
  if (!expected || expected.providerKind !== 'native_mcp') {
    throw new Error(`${call.operationId} has no exact native MCP transport identity`);
  }
  const parsed = parseNamespacedTool(call.operationId);
  if (!parsed) throw new Error(`${call.operationId} is not a namespaced MCP operation`);
  const prepared = preparedInvocationStorage.getStore();
  if (!prepared) throw new Error('native MCP crossing refused: exact preparation proof is missing');
  if (prepared.used) throw new Error('native MCP crossing refused: exact preparation proof is consumed');
  if (prepared.operationId !== call.operationId) {
    throw new Error('native MCP crossing refused: prepared operation identity mismatched');
  }
  if (prepared.accountId !== call.accountId) {
    throw new Error('native MCP crossing refused: prepared account identity mismatched');
  }
  if (prepared.manifestDigest !== expected.manifestDigest) {
    throw new Error('native MCP crossing refused: prepared manifest digest mismatched');
  }
  if (prepared.snapshot.providerIdentity !== expected.providerIdentity) {
    throw new Error('native MCP crossing refused: prepared provider identity mismatched');
  }
  if (prepared.snapshot.providerVersion !== expected.providerVersion) {
    throw new Error('native MCP crossing refused: prepared provider version mismatched');
  }
  // Re-read only the local closed configuration bytes between probe and body.
  // No server metadata call is hidden inside this business crossing.
  const config = exactConfiguredServer(prepared.runtime, parsed.serverSlug);
  if (`mcp-config:${parsed.serverSlug}:${config.digest}` !== expected.providerIdentity) {
    throw new Error('native MCP crossing refused: configured server changed after preparation');
  }
  prepared.used = true;
  void runtime;
  const result = await prepared.snapshot.server.callTool(call.operationId, call.args);
  const metadata = result as unknown as { isError?: unknown };
  if (metadata?.isError === true) throw new Error('native MCP operation returned isError');
  return result;
}

/** Production transport hook, loaded lazily by the shipped artifact. */
export async function executeProductionMcpRead(
  call: AttestedTransportCall,
): Promise<unknown> {
  return executeWithRuntime(productionRuntime(), call);
}

/** Production observer hook, loaded lazily by the shipped artifact. */
export async function refreshProductionMcpReadObservation(input: {
  operationId: string;
  accountId: string;
}): Promise<AttestedTransportObservation | null> {
  const parsed = parseNamespacedTool(input.operationId);
  if (!parsed) return null;
  try {
    const snapshot = await freshSnapshot({
      runtime: productionRuntime(),
      serverSlug: parsed.serverSlug,
      operationId: input.operationId,
    });
    const definition = observeFromSnapshot(snapshot, {
      identifier: input.operationId,
      accountId: input.accountId,
    });
    const attested = attestLiveExternalCapabilityDefinition({
      carrier: { kind: 'mcp', name: parsed.serverSlug },
      reference: { identifier: input.operationId, accountId: input.accountId },
      definition,
      now: Date.now(),
    });
    if (!attested.ok) return null;
    return {
      operationId: input.operationId,
      accountId: attested.attestation.accountId,
      definitionFingerprint: attested.attestation.definitionFingerprint,
      providerVersion: attested.attestation.providerVersion,
      operationVersion: attested.attestation.operationVersion,
      observedAt: attested.attestation.observedAt,
    };
  } catch {
    return null;
  }
}

function semanticDestinationPosture(semanticName: string): 'create_new' | 'named_existing' {
  const action = semanticName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .find(Boolean) ?? '';
  return new Set([
    'CREATE', 'ADD', 'INSERT', 'APPEND', 'UPLOAD', 'IMPORT', 'GENERATE', 'POST',
  ]).has(action)
    ? 'create_new'
    : 'named_existing';
}

function exactMcpManifest(
  attestation: AttestedLiveExternalCapability,
): CapabilityManifestV1 {
  const externalDefinition = attestation.externalDefinition;
  if (!externalDefinition) throw new Error('native MCP definition metadata is missing');
  const namespaced = parseNamespacedTool(attestation.reference.identifier);
  if (!namespaced) throw new Error('native MCP operation identity is malformed');
  const scopeDigest = sha256(closedCanonicalJson({
    domain: 'native-mcp-live-operation-scope',
    version: MCP_CARRIER_VERSION,
    providerIdentity: attestation.providerIdentity,
    operationId: attestation.reference.identifier,
    accountId: attestation.accountId,
  }, CLOSED_TOOL_LIST_OPTIONS)).slice(0, 24);
  const write = attestation.effect === 'external_write' || attestation.effect === 'admin';
  const manifest: CapabilityManifestV1 = {
    version: 1,
    manifestId: `cap:live:mcp:v1:${scopeDigest}:${attestation.definitionFingerprint}`,
    providerKind: 'native_mcp',
    operationId: attestation.reference.identifier,
    providerIdentity: attestation.providerIdentity,
    providerVersion: attestation.providerVersion,
    operationVersion: attestation.operationVersion,
    definitionFingerprint: attestation.definitionFingerprint,
    externalDefinition,
    effect: attestation.effect,
    ...(write
      ? {
          destination: {
            family: namespaced.serverSlug,
            posture: semanticDestinationPosture(externalDefinition.semanticName),
          },
        }
      : {}),
    accountId: attestation.accountId,
    // The native transport does not claim a provider idempotency key or a
    // reconcile endpoint merely because the server supplied an idempotentHint.
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'result' },
    purpose: write ? 'persist_collection' : 'collect_records',
    acceptedInputKinds: ['arguments'],
    producedOutputKinds: ['result'],
    applicableDeliverableKinds: ['result'],
    evidenceContract: { kinds: ['result'], readbackRequired: false },
    provenance: {
      issuer: 'host:native-mcp-live-materializer:v1',
      issuedAt: new Date(attestation.observedAt).toISOString(),
      trusted: true,
    },
    lifecycle: { state: 'current' },
    advisoryRoles: write
      ? ['destination', semanticDestinationPosture(externalDefinition.semanticName) === 'create_new'
        ? 'create'
        : 'update']
      : ['source', 'collection', 'lookup'],
    argumentCompiler: { ...attestation.invoke.argumentCompiler },
    invokePortId: attestation.invoke.portId,
  };
  const checked = validateCapabilityManifestV1(manifest);
  if (!checked.ok) throw new Error(`native MCP manifest is ${checked.reason}`);
  return checked.manifest;
}

function exactMcpScopeManifests(
  manifest: CapabilityManifestV1,
): CapabilityManifestV1[] {
  const store = peekCapabilityManifestStore() ?? resolveCapabilityManifestStore();
  return store.list().flatMap((entry) => {
    const candidate = entry.manifest;
    return candidate.lifecycle.state === 'current'
      && candidate.providerKind === 'native_mcp'
      && candidate.providerIdentity === manifest.providerIdentity
      && candidate.operationId === manifest.operationId
      && candidate.accountId === manifest.accountId
      && candidate.provenance.issuer === 'host:native-mcp-live-materializer:v1'
      ? [candidate]
      : [];
  }).sort((left, right) => left.manifestId.localeCompare(right.manifestId));
}

export function createProductionMcpReadCarrier(input: {
  serverName: string;
  runtime?: ProductionMcpRuntime;
}): ProductionMcpReadCarrier {
  const serverSlug = slugifyServerName(input.serverName);
  const runtime = input.runtime ?? productionRuntime();
  let snapshot: McpSnapshot | null = null;
  const expectedByOperation = new Map<string, AttestedLiveExternalCapability>();
  const carrier: LiveCapabilityCarrier = {
    identity: { kind: 'mcp', name: serverSlug },
    async enumerate() {
      snapshot = await freshSnapshot({ runtime, serverSlug });
      return snapshot.definitions.map((definition) => rowForDefinition(serverSlug, definition));
    },
    async refresh(reference) {
      snapshot = await freshSnapshot({
        runtime,
        serverSlug,
        operationId: reference.identifier,
      });
    },
    observe(reference) {
      return observeFromSnapshot(snapshot, reference);
    },
  };

  const registerPort = ({
    manifest,
    attestation,
  }: {
    manifest: CapabilityManifestV1;
    attestation: AttestedLiveExternalCapability;
  }): { ok: true } | { ok: false; reason: string } => {
    expectedByOperation.set(`${attestation.reference.identifier}\0${attestation.accountId}`, attestation);
    const manifestDigest = capabilityManifestDigest(manifest);
    const existing = resolveProductionPortsForManifest(manifest);
    if (existing) {
      if (
        !isShippedInvoke(existing.invoke)
        || typeof existing.admitPreparation !== 'function'
        || typeof existing.prepareInvocation !== 'function'
        || typeof existing.invokeWithPreparation !== 'function'
      ) {
        return { ok: false, reason: 'the exact port is not a shipped implementation' };
      }
      // The first exact materializer to register this immutable port owns its
      // runtime. Never let a later same-digest carrier silently retarget it.
      if (!runtimeByManifestDigest.has(manifestDigest)) {
        runtimeByManifestDigest.set(manifestDigest, runtime);
      }
      return { ok: true };
    }
    let shipped: ReturnType<typeof loadShippedImplementations>;
    try {
      shipped = loadShippedImplementations();
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    if (isolatedTestContractActive()) {
      shipped.bindIsolatedTransport((call) => executeWithRuntime(runtime, call));
    }
    const invoke = shipped.invokeForSealedManifest(manifest);
    const registered = registerProductionCapabilityPort(
      productionPortIdentityFromManifest(manifest),
      {
        admitPreparation: () => assertProductionMcpPreparationLocally(manifest, runtime),
        prepareInvocation: () => prepareProductionMcpInvocation(manifest),
        invokeWithPreparation: (proof, work) => withPreparedProductionMcpInvocation(
          proof as PreparedProductionMcpInvocationV1,
          work,
        ),
        invoke,
        observe: () => {
          const live = observeFromSnapshot(snapshot, attestation.reference);
          const matched = definitionMatchesAttestation({
            carrier: carrier.identity,
            reference: attestation.reference,
            definition: live,
            expected: attestation,
          });
          if (!matched.ok) return 'mismatched';
          return {
            definitionFingerprint: attestation.definitionFingerprint,
            providerVersion: attestation.providerVersion,
            operationVersion: attestation.operationVersion,
            accountId: attestation.accountId,
            observedAt: matched.observedAt,
          };
        },
      },
    );
    if (!registered.ok) return { ok: false, reason: registered.reason };
    if (!runtimeByManifestDigest.has(manifestDigest)) {
      runtimeByManifestDigest.set(manifestDigest, runtime);
    }
    return { ok: true };
  };

  const refreshIndependentObservation = async (expected: {
    operationId: string;
    accountId: string;
    definitionFingerprint: string;
    providerVersion: string;
    operationVersion: string;
  }): Promise<IndependentCapabilityObservation | null> => {
    const attestation = expectedByOperation.get(`${expected.operationId}\0${expected.accountId}`);
    if (!attestation) return null;
    await carrier.refresh({ identifier: expected.operationId, accountId: expected.accountId });
    const live = carrier.observe({ identifier: expected.operationId, accountId: expected.accountId });
    const matched = definitionMatchesAttestation({
      carrier: carrier.identity,
      reference: { identifier: expected.operationId, accountId: expected.accountId },
      definition: live,
      expected: attestation,
    });
    if (!matched.ok) return null;
    // In isolated proof runs, the shipped fake transport learns its remote
    // observation from the live generated MCP server. Tests do not seed it.
    if (isolatedTestContractActive()) {
      loadShippedImplementations().registerIsolatedObservation({
        ...expected,
        observedAt: matched.observedAt,
      });
    }
    return refreshIndependentCapabilityObservation(expected);
  };

  const materializeExact = async (input: {
    operationId: string;
    inputSchema: unknown;
  }): Promise<MaterializeProductionMcpCapabilityResult> => {
    const installedFactory = peekHostCapabilityCatalogFactory();
    const factory = installedFactory ?? createHostCapabilityCatalogFactory();
    if (!installedFactory) installHostCapabilityCatalogFactory(factory);
    const store = peekCapabilityManifestStore() ?? resolveCapabilityManifestStore();
    const retireOperation = (preserveManifestId?: string): string[] => {
      const retired: string[] = [];
      for (const entry of store.list()) {
        const manifest = entry.manifest;
        if (
          manifest.manifestId === preserveManifestId
          || manifest.lifecycle.state !== 'current'
          || manifest.providerKind !== 'native_mcp'
          || manifest.operationId !== input.operationId
          || manifest.provenance.issuer !== 'host:native-mcp-live-materializer:v1'
        ) continue;
        factory.forget(manifest.manifestId);
        if (store.revoke(manifest.manifestId)) retired.push(manifest.manifestId);
      }
      return retired.sort();
    };
    const block = (
      reason: ProductionMcpCapabilityMaterializationRefusal,
      detail: string,
      retire = false,
    ): MaterializeProductionMcpCapabilityResult => ({
      status: 'blocked',
      reason,
      detail,
      retired: retire ? retireOperation() : [],
    });

    const parsedOperation = parseNamespacedTool(input.operationId);
    if (!parsedOperation || parsedOperation.serverSlug !== serverSlug) {
      return block(
        'invalid_operation',
        'the disclosed operation is outside this configured MCP server namespace',
      );
    }
    let expectedSchema: Record<string, unknown>;
    let expectedSchemaDigest: string;
    try {
      expectedSchema = clonedClosedRecord(input.inputSchema);
      expectedSchemaDigest = sha256(closedCanonicalJson(
        expectedSchema,
        CLOSED_TOOL_LIST_OPTIONS,
      ));
    } catch (error) {
      return block('schema_drift', error instanceof Error ? error.message : String(error));
    }

    try {
      await carrier.enumerate();
    } catch (error) {
      return block(
        'live_unavailable',
        error instanceof Error ? error.message : String(error),
        true,
      );
    }
    const reference: LiveCapabilityReference = {
      identifier: input.operationId,
      accountId: snapshot?.accountId ?? '',
    };
    if (!reference.accountId) {
      return block('missing', 'the live MCP definition has no exact account identity', true);
    }
    const matches = snapshot?.definitions.filter(
      (entry) => entry.definition.operationId === input.operationId,
    ) ?? [];
    if (matches.length === 0) {
      return block('missing', 'the disclosed MCP operation is no longer listed', true);
    }
    if (matches.length !== 1) {
      return block('ambiguous', 'the configured MCP server listed the operation more than once', true);
    }
    const first = attestLiveExternalCapabilityDefinition({
      carrier: carrier.identity,
      reference,
      definition: cloneDefinition(matches[0]!.definition),
      now: Date.now(),
    });
    if (!first.ok) {
      return block(
        first.reason === 'unattested_effect' ? 'unknown_effect' : 'definition_drift',
        first.detail,
        true,
      );
    }
    const externalDefinition = first.attestation.externalDefinition;
    if (!externalDefinition) {
      return block('definition_drift', 'the live MCP definition omitted normalized annotations', true);
    }
    if (externalDefinition.providerInputSchemaDigest !== expectedSchemaDigest) {
      return block(
        'schema_drift',
        'the foreground disclosure schema differs from the current tools/list definition',
        true,
      );
    }

    let manifest: CapabilityManifestV1;
    try {
      manifest = exactMcpManifest(first.attestation);
    } catch (error) {
      return block('definition_drift', error instanceof Error ? error.message : String(error), true);
    }
    const registeredPort = await registerPort({ manifest, attestation: first.attestation });
    if (!registeredPort.ok) {
      return block('port_registration_failed', registeredPort.reason, true);
    }
    const port = resolveProductionPortsForManifest(manifest);
    if (!port?.invoke) {
      return block('port_registration_failed', 'the exact immutable invoke port is absent', true);
    }

    let independent: IndependentCapabilityObservation | null;
    try {
      independent = await refreshIndependentObservation({
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
        true,
      );
    }
    if (
      !independent
      || independent.origin !== 'independent'
      || independent.operationId !== first.attestation.reference.identifier
      || independent.accountId !== first.attestation.accountId
      || independent.definitionFingerprint !== first.attestation.definitionFingerprint
      || independent.providerVersion !== first.attestation.providerVersion
      || independent.operationVersion !== first.attestation.operationVersion
    ) {
      return block(
        'independent_observation_missing',
        'the independent observer did not confirm the exact tools/list definition',
        true,
      );
    }

    const final = attestLiveExternalCapabilityDefinition({
      carrier: carrier.identity,
      reference,
      definition: carrier.observe(reference),
      now: Date.now(),
    });
    if (
      !final.ok
      || final.attestation.definitionFingerprint !== first.attestation.definitionFingerprint
      || final.attestation.effect !== first.attestation.effect
      || final.attestation.externalDefinition?.providerInputSchemaDigest !== expectedSchemaDigest
      || JSON.stringify(final.attestation.externalDefinition?.behaviorHints ?? null)
        !== JSON.stringify(first.attestation.externalDefinition?.behaviorHints ?? null)
    ) {
      return block(
        'definition_drift',
        final.ok ? 'the tools/list definition changed during materialization' : final.detail,
        true,
      );
    }

    let contractInstalled = false;
    try {
      const contract = saveToolContract({
        identifier: manifest.operationId,
        schema: final.attestation.inputSchema,
        providerObservedAt: new Date(final.attestation.observedAt).toISOString(),
      });
      contractInstalled = Boolean(
        contract
        && contract.providerObservedFingerprint === final.attestation.schemaFingerprint
        && sha256(closedCanonicalJson(contract.schema, CLOSED_TOOL_LIST_OPTIONS))
          === expectedSchemaDigest,
      );
    } catch {
      contractInstalled = false;
    }
    if (!contractInstalled) {
      return block(
        'schema_contract_conflict',
        'the exact provider input schema could not be persisted',
        true,
      );
    }

    const prior = exactMcpScopeManifests(manifest)
      .filter((candidate) => candidate.manifestId !== manifest.manifestId);
    const same = store.get(manifest.manifestId);
    let lifecycle: ReturnType<typeof store.install> | ReturnType<typeof store.supersede>;
    if (same) lifecycle = store.install(manifest);
    else if (prior.length > 0) lifecycle = store.supersede(prior[0]!.manifestId, manifest);
    else lifecycle = store.install(manifest);
    if (!lifecycle.ok) {
      return block('manifest_install_failed', lifecycle.reason, true);
    }
    const replaced: string[] = [];
    for (const candidate of prior) {
      factory.forget(candidate.manifestId);
      replaced.push(candidate.manifestId);
    }
    for (const extra of prior.slice(1)) store.revoke(extra.manifestId);

    try {
      factory.register({
        ...registeredCapabilityFromManifest({
          manifest,
          observation: {
            definitionFingerprint: final.attestation.definitionFingerprint,
            providerVersion: final.attestation.providerVersion,
            operationVersion: final.attestation.operationVersion,
            accountId: final.attestation.accountId,
            observedAt: final.attestation.observedAt,
          },
          invoke: port.invoke,
        }),
        sourceSchemaFingerprint: final.attestation.schemaFingerprint,
        providerInputSchemaDigest: expectedSchemaDigest,
      });
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
  };

  return {
    carrier,
    refreshIndependentObservation,
    materializeExact,
    materialize(objective, expectedIdentity) {
      return materializeLiveReadCapability({
        objective,
        carrier,
        registerPort,
        refreshIndependentObservation,
        ...(expectedIdentity ? { expectedIdentity } : {}),
      });
    },
  };
}
