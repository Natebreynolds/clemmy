/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/production-live-read-acquisition-registry.test.ts */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { MCPServer } from '@openai/agents';
import type { AutomationReadPilotCapabilityAcquisitionPortV1 } from '../../execution/automation-read-pilot-control-plane.js';
import type { ManagedMcpServer } from '../../types.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-production-live-read-registry-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const index = await import('../../memory/capability-index.js');
const eventlog = await import('./eventlog.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const manifestStores = await import('./capability-manifest-store.js');
const ports = await import('./production-capability-ports.js');
const observations = await import('./independent-capability-observation.js');
const registry = await import('./production-live-read-acquisition-registry.js');
const mcp = await import('./production-mcp-read-carrier.js');

const generated = (label: string): string => `${label}_${randomUUID().replaceAll('-', '').slice(0, 12)}`.toLowerCase();

interface ToolState {
  name: string;
  description?: string;
  inputSchema: unknown;
  annotations?: unknown;
  [key: string]: unknown;
}

function readTool(input: { server: string; name: string; objective: string }): ToolState {
  return {
    name: `${input.server}__${input.name}`,
    description: `Return ${input.objective} from the connected source.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { token: { type: 'string' } },
      required: ['token'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  };
}

function generatedRuntime(input: {
  objective: string;
  server?: string;
  tools?: ToolState[];
}) {
  const server = input.server ?? generated('server');
  const state: {
    tools: unknown;
    credential: string;
    commandRevision: string;
    portRevision: string;
    unavailable: boolean;
  } = {
    tools: input.tools ?? [readTool({ server, name: generated('inspect'), objective: input.objective })],
    credential: generated('credential'),
    commandRevision: '1',
    portRevision: '1',
    unavailable: false,
  };
  const counts = { list: 0, invalidate: 0, call: 0 };
  const fake: Pick<MCPServer, 'listTools' | 'callTool' | 'invalidateToolsCache'> = {
    async invalidateToolsCache() { counts.invalidate += 1; },
    async listTools() {
      counts.list += 1;
      if (state.unavailable) throw new Error('generated carrier unavailable');
      return state.tools as Awaited<ReturnType<MCPServer['listTools']>>;
    },
    async callTool() {
      counts.call += 1;
      return [{ type: 'text', text: '{"ok":true}' }] as unknown as Awaited<ReturnType<MCPServer['callTool']>>;
    },
  };
  const runtime: mcp.ProductionMcpRuntime = {
    configuredServers(): readonly ManagedMcpServer[] {
      return [{
        name: server,
        type: 'stdio',
        command: `/generated/mcp-${state.commandRevision}`,
        args: ['--stdio'],
        env: { GENERATED_CREDENTIAL: state.credential },
        description: 'Generated server',
        enabled: true,
        source: 'user',
      }];
    },
    serverForEnumeration() { return fake; },
    serverForOperation() { return fake; },
    portIdentity() {
      return {
        portId: `host:test-native-mcp-read:${state.portRevision}`,
        compiler: { id: 'host:mcp-json-arguments', version: state.portRevision },
      };
    },
  };
  return { server, state, counts, runtime };
}

function adapter(runtime: ReturnType<typeof generatedRuntime>) {
  return registry.createProductionMcpLiveReadAcquisitionAdapter({
    serverName: runtime.server,
    runtime: runtime.runtime,
  });
}

function resetAuthoritySurfaces(options: { durable?: boolean } = {}) {
  const factory = catalogs.createHostCapabilityCatalogFactory();
  const store = manifestStores.createCapabilityManifestStore([], {
    durable: options.durable,
  });
  catalogs.installHostCapabilityCatalogFactory(factory);
  manifestStores.installCapabilityManifestStore(store);
  ports.clearProductionCapabilityPorts();
  observations.clearIndependentCapabilityObservations();
  return { store, factory };
}

function requirement(objective: string, requirementId = generated('requirement')) {
  return { requirementId, objective: `retrieve ${objective}`, effect: 'read' as const };
}

function genericCliNominationAdapter(input: {
  rows: ReadonlyArray<{ identifier: string; accountIdentity: string; description: string }>;
  adapterId?: string;
  carrierKind?: 'cli' | 'mcp';
  carrierName?: string;
  onMaterialize?: () => void;
}) {
  const observedAt = Date.now();
  const carrierKind = input.carrierKind ?? 'cli';
  const carrierName = input.carrierName ?? 'reviewed-cli-test';
  const carrier = {
    identity: { kind: carrierKind, name: carrierName },
    async enumerate() {
      return input.rows.map((row) => ({
        identifier: row.identifier,
        carrierKind,
        carrier: carrierName,
        displayName: row.identifier,
        description: row.description,
        effectClass: 'read' as const,
        effectProvenance: carrierKind === 'cli' ? 'curated' as const : 'declared' as const,
        accountIdentity: row.accountIdentity,
      }));
    },
    async refresh() {},
    observe(reference: { identifier: string; accountId: string }) {
      const row = input.rows.find((candidate) => (
        candidate.identifier === reference.identifier
        && candidate.accountIdentity === reference.accountId
      ));
      if (!row) return 'missing' as const;
      return {
        operationId: row.identifier,
        providerKind: carrierKind === 'cli' ? 'reviewed_cli' as const : 'native_mcp' as const,
        providerIdentity: carrierKind === 'cli' ? '/reviewed/cli/test' : `mcp:${carrierName}`,
        providerVersion: 'provider-v1',
        operationVersion: `operation-v1:${row.identifier}:${row.accountIdentity}`,
        accountId: row.accountIdentity,
        effect: 'read' as const,
        effectAttestation: carrierKind === 'cli' ? 'host_reviewed' as const : 'carrier_declared' as const,
        inputSchema: { type: 'object', additionalProperties: false },
        observedAt,
        invoke: {
          portId: `port:${row.identifier}:${row.accountIdentity}`,
          argumentCompiler: {
            id: 'host:reviewed-cli-test',
            version: '1',
          },
        },
      };
    },
  };
  return registry.createAttestedLiveReadCarrierAdapter({
    adapterId: input.adapterId ?? 'reviewed_cli:reviewed-cli-test',
    carrier,
    async materialize() {
      input.onMaterialize?.();
      return {
        status: 'blocked',
        reason: 'missing',
        detail: 'selection probe stops before publication',
        retired: [],
      };
    },
  });
}

test.afterEach(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  ports.clearProductionCapabilityPorts();
  observations.clearIndependentCapabilityObservations();
});
test.after(() => {
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('zero configured carriers stays missing even when advisory memory claims an exact match', async () => {
  const objective = generated('objective');
  resetAuthoritySurfaces();
  index.recordCapabilityOperations([{
    identifier: generated('memory_only'),
    carrierKind: 'mcp',
    carrier: generated('absent_carrier'),
    displayName: objective,
    description: `Return ${objective}`,
    effectClass: 'read',
    effectProvenance: 'declared',
    accountIdentity: generated('account'),
  }]);
  const acquisition = registry.createProductionLiveReadAcquisitionRegistry({
    configuredMcpServers: () => [],
  });
  const result = await acquisition.acquire(requirement(objective));
  assert.equal(result.status, 'blocked');
  if (result.status === 'blocked') {
    assert.equal(result.reason, 'missing');
    assert.equal(result.detail, 'no live-read carrier adapters are configured');
  }
  assert.equal(catalogs.peekHostCapabilityCatalogFactory()?.snapshot().length, 0);
  assert.equal(ports.listProductionCapabilityPorts().length, 0);
});

test('an observable carrier with no matching nomination stays semantically missing', async () => {
  resetAuthoritySurfaces();
  const acquisition = registry.createProductionLiveReadAcquisitionRegistry({
    configuredAdapters: () => [genericCliNominationAdapter({ rows: [] })],
  });
  const result = await acquisition.acquire(requirement(generated('objective')));
  assert.equal(result.status, 'blocked');
  if (result.status === 'blocked') {
    assert.equal(result.reason, 'missing');
    assert.equal(result.detail, 'no current attested read capability matched the objective');
  }
});

test('exact normalized identifier wins over fuzzy sibling nominations', async () => {
  const exactIdentifier = 'Reviewed_CLI_Constellation_Read';
  const candidate = genericCliNominationAdapter({
    rows: [
      {
        identifier: exactIdentifier,
        accountIdentity: 'reviewed_cli:host',
        description: 'Read constellation facts.',
      },
      {
        identifier: 'reviewed_cli_ambiguous_alpha',
        accountIdentity: 'reviewed_cli:host',
        description: 'Inspect ambiguous nebula.',
      },
      {
        identifier: 'reviewed_cli_ambiguous_beta',
        accountIdentity: 'reviewed_cli:host',
        description: 'Inspect ambiguous nebula.',
      },
    ],
  });
  const nominated = await candidate.nominate({
    requirementId: generated('requirement'),
    objective: 'reviewed_cli_constellation_read',
    effect: 'read',
  });
  assert.equal(nominated.status, 'nominated', JSON.stringify(nominated));
  if (nominated.status !== 'nominated') return;
  assert.deepEqual(nominated.nominations.map((row) => ({
    identifier: row.identity.reference.identifier,
    accountId: row.identity.reference.accountId,
  })), [{
    identifier: exactIdentifier,
    accountId: 'reviewed_cli:host',
  }]);
});

test('exact identifier keeps every account nomination ambiguous', async () => {
  const identifier = 'reviewed_cli_constellation_read';
  const candidate = genericCliNominationAdapter({
    rows: [
      { identifier, accountIdentity: 'reviewed_cli:first', description: 'Read constellation facts.' },
      { identifier, accountIdentity: 'reviewed_cli:second', description: 'Read constellation facts.' },
      {
        identifier: 'reviewed_cli_constellation_sibling',
        accountIdentity: 'reviewed_cli:host',
        description: 'Read constellation facts.',
      },
    ],
  });
  const nominated = await candidate.nominate({
    requirementId: generated('requirement'),
    objective: identifier,
    effect: 'read',
  });
  assert.equal(nominated.status, 'nominated', JSON.stringify(nominated));
  if (nominated.status !== 'nominated') return;
  assert.deepEqual(nominated.nominations.map((row) => row.identity.reference.accountId), [
    'reviewed_cli:first',
    'reviewed_cli:second',
  ]);
});

test('registry-wide exact identifier suppresses a fuzzy sibling from another carrier', async () => {
  const identifier = 'generated_mcp__read_constellation';
  const materialized = { exact: 0, fuzzy: 0 };
  const exact = genericCliNominationAdapter({
    adapterId: 'native_mcp:generated-mcp',
    carrierKind: 'mcp',
    carrierName: 'generated-mcp',
    rows: [{ identifier, accountIdentity: 'mcp:generated', description: 'Read constellation facts.' }],
    onMaterialize: () => { materialized.exact += 1; },
  });
  const fuzzy = genericCliNominationAdapter({
    adapterId: 'reviewed_cli:sibling-cli',
    carrierName: 'sibling-cli',
    rows: [{
      identifier: 'generated_mcp__read_constellation_sibling',
      accountIdentity: 'reviewed_cli:host',
      description: 'Read constellation facts.',
    }],
    onMaterialize: () => { materialized.fuzzy += 1; },
  });
  resetAuthoritySurfaces();
  const result = await registry.createProductionLiveReadAcquisitionRegistry({
    configuredAdapters: () => [fuzzy, exact],
  }).acquire({ requirementId: generated('requirement'), objective: identifier, effect: 'read' });
  assert.equal(result.status, 'blocked');
  if (result.status === 'blocked') assert.equal(result.reason, 'missing');
  assert.deepEqual(materialized, { exact: 1, fuzzy: 0 });
});

test('registry-wide exact identifier preserves two exact account nominations', async () => {
  const identifier = 'reviewed_cli_constellation_read';
  const materialized = { first: 0, second: 0 };
  const first = genericCliNominationAdapter({
    adapterId: 'reviewed_cli:first-carrier',
    carrierName: 'first-carrier',
    rows: [{ identifier, accountIdentity: 'reviewed_cli:first', description: 'Read facts.' }],
    onMaterialize: () => { materialized.first += 1; },
  });
  const second = genericCliNominationAdapter({
    adapterId: 'reviewed_cli:second-carrier',
    carrierName: 'second-carrier',
    rows: [{ identifier, accountIdentity: 'reviewed_cli:second', description: 'Read facts.' }],
    onMaterialize: () => { materialized.second += 1; },
  });
  resetAuthoritySurfaces();
  const result = await registry.createProductionLiveReadAcquisitionRegistry({
    configuredAdapters: () => [second, first],
  }).acquire({ requirementId: generated('requirement'), objective: identifier, effect: 'read' });
  assert.equal(result.status, 'blocked');
  if (result.status === 'blocked') {
    assert.equal(result.reason, 'ambiguous');
    assert.match(result.detail, /reviewed_cli:first-carrier/);
    assert.match(result.detail, /reviewed_cli:second-carrier/);
  }
  assert.deepEqual(materialized, { first: 0, second: 0 });
});

test('blank-state configured MCP is acquired without serverName in the request or seeded authority', async () => {
  const objective = generated('objective');
  const live = generatedRuntime({
    objective,
    tools: [],
  });
  live.state.tools = [
    readTool({ server: live.server, name: generated('unrelated'), objective: generated('different') }),
    readTool({ server: live.server, name: generated('matching'), objective }),
  ];
  const { store, factory } = resetAuthoritySurfaces();
  assert.equal(store.list().length, 0);
  assert.equal(factory.snapshot().length, 0);
  assert.equal(ports.listProductionCapabilityPorts().length, 0);

  const canonical = registry.configuredProductionLiveReadAcquisitionPort({
    configuredMcpServers: () => live.runtime.configuredServers(),
    mcpRuntimeForServer(serverName) {
      assert.equal(serverName, live.server);
      return live.runtime;
    },
  });
  const acquisition: AutomationReadPilotCapabilityAcquisitionPortV1 = canonical;
  const request = requirement(objective);
  const result = await acquisition.acquire({
    proposalId: generated('proposal'),
    proposalRevision: 1,
    proposalDigest: generated('proposal_digest'),
    phaseId: generated('phase'),
    requirementId: request.requirementId,
    requirementDigest: generated('requirement_digest'),
    objective: request.objective,
    effect: 'read',
  });
  assert.equal(result.status, 'installed', JSON.stringify(result));
  if (result.status !== 'installed') return;
  assert.match(result.manifest.operationId, /matching/);
  assert.equal(result.manifest.providerKind, 'native_mcp');
  assert.equal(result.manifest.effect, 'read');
  assert.equal(result.attestation.effectAttestation, 'carrier_declared');
  assert.equal(result.manifest.providerIdentity, result.attestation.providerIdentity);
  assert.equal(result.manifest.providerVersion, result.attestation.providerVersion);
  assert.equal(result.manifest.operationVersion, result.attestation.operationVersion);
  assert.equal(result.manifest.definitionFingerprint, result.attestation.definitionFingerprint);
  assert.equal(result.manifest.externalDefinition?.providerOutputSchemaObserved, true,
    'the complete MCP tools/list row authoritatively observes output-schema absence');
  assert.equal(result.manifest.externalDefinition?.providerOutputSchemaDigest, undefined);
  assert.deepEqual(result.manifest.externalDefinition, result.attestation.externalDefinition);
  assert.equal(result.manifest.accountId, result.attestation.accountId);
  assert.equal(result.manifest.invokePortId, result.attestation.invoke.portId);
  assert.deepEqual(result.manifest.argumentCompiler, result.attestation.invoke.argumentCompiler);
  assert.deepEqual(
    result.attestation.inputSchema,
    (live.state.tools as ToolState[])[1]!.inputSchema,
  );
  assert.equal(store.get(result.manifest.manifestId)?.manifest.lifecycle.state, 'current');
  assert.equal(factory.snapshot().length, 1);
  assert.equal(ports.listProductionCapabilityPorts().length, 1);
  assert.equal(live.counts.call, 0);
  assert.equal(live.counts.list, 4, 'nomination plus exact enumerate, refresh, and independent refresh');

  const warm = await acquisition.acquire({
    proposalId: generated('proposal'),
    proposalRevision: 2,
    proposalDigest: generated('proposal_digest'),
    phaseId: generated('phase'),
    requirementId: request.requirementId,
    requirementDigest: generated('requirement_digest'),
    objective: request.objective,
    effect: 'read',
  });
  assert.equal(warm.status, 'installed', JSON.stringify(warm));
  if (warm.status === 'installed') {
    assert.equal(warm.manifest.manifestId, result.manifest.manifestId);
    assert.equal(factory.snapshot().length, 1);
  }
});

test('two matching configured servers are ambiguous with zero materialization', async () => {
  const objective = generated('objective');
  const first = generatedRuntime({ objective });
  const second = generatedRuntime({ objective });
  resetAuthoritySurfaces();
  const forward = registry.createProductionLiveReadAcquisitionRegistry({
    configuredMcpServers: () => [
      ...first.runtime.configuredServers(),
      ...second.runtime.configuredServers(),
    ],
    mcpRuntimeForServer: (serverName) => (
      serverName === first.server ? first.runtime : second.runtime
    ),
  });
  const request = requirement(objective);
  const result = await forward.acquire(request);
  assert.equal(result.status, 'blocked');
  if (result.status !== 'blocked') return;
  assert.equal(result.reason, 'ambiguous');
  assert.equal(catalogs.peekHostCapabilityCatalogFactory()?.snapshot().length, 0);
  assert.equal(ports.listProductionCapabilityPorts().length, 0);
  assert.equal(first.counts.list, 1);
  assert.equal(second.counts.list, 1);

  resetAuthoritySurfaces();
  const reverse = registry.createProductionLiveReadAcquisitionRegistry({
    configuredMcpServers: () => [
      ...second.runtime.configuredServers(),
      ...first.runtime.configuredServers(),
    ],
    mcpRuntimeForServer: (serverName) => (
      serverName === first.server ? first.runtime : second.runtime
    ),
  });
  const permuted = await reverse.acquire(request);
  assert.equal(permuted.status, 'blocked');
  if (permuted.status === 'blocked') {
    assert.equal(permuted.reason, result.reason);
    assert.equal(permuted.detail, result.detail, 'configuration order cannot break ambiguity');
  }
});

test('one unavailable carrier plus one match is unavailable because global uniqueness is unproven', async () => {
  const objective = generated('objective');
  const unavailable = generatedRuntime({ objective });
  unavailable.state.unavailable = true;
  const matching = generatedRuntime({ objective });
  resetAuthoritySurfaces();
  const acquisition = registry.createProductionLiveReadAcquisitionRegistry({
    configuredMcpServers: () => [
      ...matching.runtime.configuredServers(),
      ...unavailable.runtime.configuredServers(),
    ],
    mcpRuntimeForServer: (serverName) => (
      serverName === matching.server ? matching.runtime : unavailable.runtime
    ),
  });
  const result = await acquisition.acquire(requirement(objective));
  assert.equal(result.status, 'blocked');
  if (result.status === 'blocked') assert.equal(result.reason, 'carrier_unavailable');
  assert.equal(catalogs.peekHostCapabilityCatalogFactory()?.snapshot().length, 0);
  assert.equal(ports.listProductionCapabilityPorts().length, 0);
  assert.equal(matching.counts.call, 0);
});

test('identifier token overlap cannot override missing declared effect or an invalid schema', async () => {
  const objective = generated('objective');
  const server = generated('server');
  const tool = readTool({ server, name: objective, objective: generated('different') });
  delete tool.annotations;
  const live = generatedRuntime({ server, objective, tools: [tool] });
  resetAuthoritySurfaces();
  const makeAcquisition = () => registry.createProductionLiveReadAcquisitionRegistry({
    configuredMcpServers: () => live.runtime.configuredServers(),
    mcpRuntimeForServer: () => live.runtime,
  });
  const request = requirement(objective);
  const unattested = await makeAcquisition().acquire(request);
  assert.equal(unattested.status, 'blocked');
  if (unattested.status === 'blocked') assert.equal(unattested.reason, 'missing');
  assert.equal(catalogs.peekHostCapabilityCatalogFactory()?.snapshot().length, 0);

  tool.annotations = { readOnlyHint: true, destructiveHint: false };
  let getterCalls = 0;
  Object.defineProperty(tool, 'inputSchema', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return { type: 'object' };
    },
  });
  const invalidSchema = await makeAcquisition().acquire(request);
  assert.equal(invalidSchema.status, 'blocked');
  if (invalidSchema.status === 'blocked') assert.equal(invalidSchema.reason, 'carrier_unavailable');
  assert.equal(getterCalls, 0);
  assert.equal(catalogs.peekHostCapabilityCatalogFactory()?.snapshot().length, 0);
  assert.equal(ports.listProductionCapabilityPorts().length, 0);
});

test('removal retires prior requirement authority and live recovery reacquires it', async () => {
  const objective = generated('objective');
  const live = generatedRuntime({ objective });
  const { store, factory } = resetAuthoritySurfaces();
  let configured = true;
  const makeAcquisition = () => registry.createProductionLiveReadAcquisitionRegistry({
    configuredMcpServers: () => configured ? live.runtime.configuredServers() : [],
    mcpRuntimeForServer: () => live.runtime,
  });
  const request = requirement(objective);
  const installed = await makeAcquisition().acquire(request);
  assert.equal(installed.status, 'installed');
  if (installed.status !== 'installed') return;

  live.state.tools = [];
  const removed = await makeAcquisition().acquire(request);
  assert.equal(removed.status, 'blocked');
  if (removed.status === 'blocked') {
    assert.equal(removed.reason, 'missing');
    assert.deepEqual(removed.retired, [installed.manifest.manifestId]);
  }
  assert.equal(store.get(installed.manifest.manifestId)?.manifest.lifecycle.state, 'revoked');
  assert.equal(factory.snapshot().length, 0);

  live.state.tools = [readTool({
    server: live.server,
    name: generated('renamed'),
    objective,
  })];
  const recovered = await makeAcquisition().acquire(request);
  assert.equal(recovered.status, 'installed', JSON.stringify(recovered));
  if (recovered.status === 'installed') {
    assert.notEqual(recovered.manifest.manifestId, installed.manifest.manifestId);
    assert.match(recovered.manifest.operationId, /renamed/);
    assert.equal(factory.snapshot().length, 1);
    configured = false;
    const disconnected = await makeAcquisition().acquire(request);
    assert.equal(disconnected.status, 'blocked');
    if (disconnected.status === 'blocked') {
      assert.equal(disconnected.reason, 'missing');
      assert.deepEqual(disconnected.retired, [recovered.manifest.manifestId]);
    }
    assert.equal(store.get(recovered.manifest.manifestId)?.manifest.lifecycle.state, 'revoked');
    assert.equal(factory.snapshot().length, 0);
  }
});

test('fresh registry and durable-store hydration still retire a removed live definition', async () => {
  const objective = generated('objective');
  const live = generatedRuntime({ objective });
  resetAuthoritySurfaces({ durable: true });
  const options: registry.ProductionLiveReadAcquisitionRegistryOptions = {
    configuredMcpServers: () => live.runtime.configuredServers(),
    mcpRuntimeForServer: () => live.runtime,
  };
  const request = requirement(objective);
  const installed = await registry.createProductionLiveReadAcquisitionRegistry(options).acquire(request);
  assert.equal(installed.status, 'installed', JSON.stringify(installed));
  if (installed.status !== 'installed') return;

  live.state.tools = [];
  const restartedFactory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(restartedFactory);
  const rehydrated = manifestStores.createCapabilityManifestStore([], { durable: true });
  manifestStores.installCapabilityManifestStore(rehydrated);
  const removed = await registry.createProductionLiveReadAcquisitionRegistry(options).acquire(request);
  assert.equal(removed.status, 'blocked');
  if (removed.status === 'blocked') {
    assert.equal(removed.reason, 'missing');
    assert.deepEqual(removed.retired, [installed.manifest.manifestId]);
  }
  assert.equal(rehydrated.get(installed.manifest.manifestId)?.manifest.lifecycle.state, 'revoked');
  assert.equal(restartedFactory.snapshot().length, 0);
});

test('rename, schema, account, effect, provider, and invoke drift after nomination install nothing stale', async (t) => {
  for (const drift of ['rename', 'schema', 'account', 'effect', 'provider', 'invoke'] as const) {
    await t.test(drift, async () => {
      const objective = generated(`objective_${drift}`);
      const live = generatedRuntime({ objective });
      const { store, factory } = resetAuthoritySurfaces();
      const base = adapter(live);
      let mutate = false;
      const wrapped: registry.ProductionLiveReadCarrierAdapterV1 = {
        version: 1,
        adapterId: base.adapterId,
        carrier: base.carrier,
        nominate: (input) => base.nominate(input),
        async materialize(input) {
          if (mutate) {
            const tool = (live.state.tools as ToolState[])[0]!;
            if (drift === 'rename') tool.name = `${live.server}__${generated('changed')}`;
            else if (drift === 'schema') {
              tool.inputSchema = {
                type: 'object',
                properties: { replacement: { type: 'string' } },
                required: ['replacement'],
              };
            } else if (drift === 'account') live.state.credential = generated('changed');
            else if (drift === 'effect') {
              tool.annotations = { readOnlyHint: false, destructiveHint: true };
            } else if (drift === 'provider') live.state.commandRevision = '2';
            else live.state.portRevision = '2';
          }
          return base.materialize(input);
        },
      };
      const acquisition = registry.createProductionLiveReadAcquisitionRegistry({
        configuredAdapters: () => [wrapped],
      });
      const request = requirement(objective);
      const installed = await acquisition.acquire(request);
      assert.equal(installed.status, 'installed', JSON.stringify(installed));
      if (installed.status !== 'installed') return;
      mutate = true;
      const refused = await acquisition.acquire(request);
      assert.equal(refused.status, 'blocked');
      if (refused.status === 'blocked') {
        assert.ok(
          refused.reason === 'identity_mismatch' || refused.reason === 'missing',
          JSON.stringify(refused),
        );
      }
      assert.equal(store.get(installed.manifest.manifestId)?.manifest.lifecycle.state, 'revoked');
      assert.equal(factory.snapshot().length, 0);
      assert.equal(live.counts.call, 0);
    });
  }
});

test('hostile nomination envelopes are unavailable and never reach materialization', async (t) => {
  const cases = [
    {
      label: 'getter',
      envelope(counter: { value: number }) {
        const nomination: Record<string, unknown> = { version: 1 };
        Object.defineProperty(nomination, 'identity', {
          enumerable: true,
          get() { counter.value += 1; return {}; },
        });
        return { status: 'nominated', nominations: [nomination] };
      },
    },
    {
      label: 'symbol',
      envelope() {
        const nomination: Record<string | symbol, unknown> = { version: 1 };
        nomination[Symbol('hidden')] = true;
        return { status: 'nominated', nominations: [nomination] };
      },
    },
    {
      label: 'sparse',
      envelope() {
        const nominations = new Array(2);
        nominations[1] = { version: 1 };
        return { status: 'nominated', nominations };
      },
    },
    {
      label: 'oversized',
      envelope() {
        return { status: 'unavailable', detail: 'x'.repeat(20_000) };
      },
    },
  ];
  for (const hostile of cases) {
    await t.test(hostile.label, async () => {
      resetAuthoritySurfaces();
      const counter = { value: 0 };
      const materialized = { value: 0 };
      const carrierName = generated('carrier');
      const adapterId = `host:${carrierName}`;
      const configured: registry.ProductionLiveReadCarrierAdapterV1 = {
        version: 1,
        adapterId,
        carrier: { kind: 'host', name: carrierName },
        async nominate() {
          return hostile.envelope(counter) as registry.ProductionLiveReadCarrierNominationResultV1;
        },
        async materialize() {
          materialized.value += 1;
          throw new Error('must not run');
        },
      };
      const acquisition = registry.createProductionLiveReadAcquisitionRegistry({
        configuredAdapters: () => [configured],
      });
      const result = await acquisition.acquire(requirement(generated('objective')));
      assert.equal(result.status, 'blocked');
      if (result.status === 'blocked') assert.equal(result.reason, 'carrier_unavailable');
      assert.equal(counter.value, 0);
      assert.equal(materialized.value, 0);
      assert.equal(catalogs.peekHostCapabilityCatalogFactory()?.snapshot().length, 0);
    });
  }
});
