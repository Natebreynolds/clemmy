/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/accepted-mcp-carrier.test.ts */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { MCPServer } from '@openai/agents';
import type { ManagedMcpServer } from '../../types.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-accepted-mcp-carrier-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const contracts = await import('../../tools/tool-contract-store.js');
const eventlog = await import('./eventlog.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const manifestStores = await import('./capability-manifest-store.js');
const ports = await import('./production-capability-ports.js');
const observations = await import('./independent-capability-observation.js');
const registry = await import('./production-live-read-acquisition-registry.js');
const mcp = await import('./production-mcp-read-carrier.js');
const carrier = await import('./accepted-mcp-carrier.js');
const callAuthority = await import('./accepted-turn-call-authority.js');
const identities = await import('./attempt-identity.js');
const hostBindings = await import('./host-call-capability-binding.js');
const logicalContracts = await import('./logical-call-contract.js');

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const generated = (label: string): string => `${label}_${randomUUID().replaceAll('-', '').slice(0, 12)}`.toLowerCase();

interface ToolState {
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  annotations: { readOnlyHint: true; destructiveHint: false };
}

function generatedRuntime() {
  const server = generated('carrier');
  const objective = generated('ledger_snapshot');
  const credential = generated('credential');
  const tool: ToolState = {
    name: `${server}__${generated('inspect')}`,
    description: `Return ${objective} from the configured source.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  };
  const counts = { list: 0, call: 0 };
  const serverPort: Pick<MCPServer, 'listTools' | 'callTool' | 'invalidateToolsCache'> = {
    async invalidateToolsCache() {},
    async listTools() {
      counts.list += 1;
      return [tool] as Awaited<ReturnType<MCPServer['listTools']>>;
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
        command: `/generated/${server}`,
        args: ['--stdio'],
        env: { GENERATED_TOKEN: credential },
        description: 'Generated exact-carrier MCP server',
        enabled: true,
        source: 'user',
      }];
    },
    serverForEnumeration() { return serverPort; },
    serverForOperation() { return serverPort; },
    portIdentity() {
      return {
        portId: `host:test-native-mcp-read:${server}`,
        compiler: { id: 'host:mcp-json-arguments', version: '1' },
      };
    },
  };
  return { server, objective, tool, counts, runtime };
}

function resetAuthoritySurfaces() {
  const store = manifestStores.createCapabilityManifestStore();
  const factory = catalogs.createHostCapabilityCatalogFactory();
  manifestStores.installCapabilityManifestStore(store);
  catalogs.installHostCapabilityCatalogFactory(factory);
  ports.clearProductionCapabilityPorts();
  observations.clearIndependentCapabilityObservations();
  return { store, factory };
}

async function acquireGenericMcpCapability() {
  const live = generatedRuntime();
  const surfaces = resetAuthoritySurfaces();
  const acquisition = registry.createProductionLiveReadAcquisitionRegistry({
    configuredMcpServers: () => live.runtime.configuredServers(),
    mcpRuntimeForServer(serverName) {
      assert.equal(serverName, live.server);
      return live.runtime;
    },
  });
  const result = await acquisition.acquire({
    requirementId: generated('requirement'),
    objective: `retrieve ${live.objective}`,
    effect: 'read',
  });
  assert.equal(result.status, 'installed', JSON.stringify(result));
  if (result.status !== 'installed') throw new Error(JSON.stringify(result));
  assert.equal(result.manifest.provenance.issuer, 'host:live-capability-materializer:v1');
  assert.equal(result.manifest.providerKind, 'native_mcp');
  assert.equal(live.counts.call, 0);
  return { live, surfaces, installed: result };
}

function resolveInsideAcceptedCall(input: {
  installed: Awaited<ReturnType<typeof acquireGenericMcpCapability>>['installed'];
  beforeResolve?: () => void;
}) {
  const { manifest } = input.installed;
  const entry = catalogs.peekHostCapabilityCatalogFactory()?.get(manifest.manifestId);
  const canonical = entry ? catalogs.canonicalCatalogIdentityOf(entry) : null;
  assert.ok(entry && canonical?.providerInputSchemaDigest);
  if (!entry || !canonical?.providerInputSchemaDigest) throw new Error('exact catalog identity missing');

  const session = eventlog.createSession({ id: generated('accepted-mcp'), kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Read the current ledger snapshot.' },
  });
  const catalogRevisionDigest = digest(`catalog:${session.id}`);
  const bindingRevisionDigest = digest(`binding:${session.id}`);
  const armed = callAuthority.armHostCallAuthority({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    catalogRevisionDigest,
    bindingRevisionDigest,
    maxLogicalCalls: 2,
    maxParallelCalls: 1,
  });
  assert.equal(armed.status, 'armed', JSON.stringify(armed));
  const root = callAuthority.acceptedTurnCallAuthorityFor(session.id, source.seq);
  assert.equal(root.status, 'ok', JSON.stringify(root));
  if (root.status !== 'ok') throw new Error(root.reason);

  const acceptedTaskId = identities.acceptedTaskIdFor(session.id, source.seq);
  const args = { query: generated('current') };
  const contract = logicalContracts.durableLogicalCallContract(
    acceptedTaskId,
    manifest.operationId,
    args,
  );
  assert.ok(contract);
  if (!contract) throw new Error('logical contract missing');
  const logicalToolCallId = generated('call');
  const base = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId,
    sourceEventId: root.authority.sourceEventId,
    sourceEventDigest: root.authority.sourceEventDigest,
    logicalToolCallId,
    toolName: contract.toolName,
    argumentDigest: contract.argumentDigest,
    effect: 'read' as const,
    bindingKind: 'catalog_manifest' as const,
    capabilityId: canonical.capabilityId,
    providerInputSchemaDigest: canonical.providerInputSchemaDigest,
    schemaFingerprint: canonical.schemaDigest,
    accountId: canonical.account,
    invokePortId: canonical.invokePortId,
    operationId: canonical.operationId,
    manifestId: canonical.manifestId,
    manifestDigest: canonical.manifestDigest,
    engineVersion: root.authority.engineVersion,
    surfaceVersion: root.authority.surfaceVersion,
    authorityDigest: root.authority.authorityDigest,
    authorityRevision: root.authority.revision,
    surfaceDigest: root.authority.surfaceDigest,
    catalogRevisionDigest,
    bindingRevisionDigest,
  };
  const attestation: callAuthority.HostCallAttestation = {
    ...base,
    bindingDigest: hostBindings.hostCallAttestationBindingDigest(base),
  };

  return callAuthority.withHostCallAttestation(attestation, () => identities.withLogicalToolCall({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    logicalToolCallId,
    tool: manifest.operationId,
    args,
  }, () => {
    const persisted = hostBindings.persistHostCallCapabilityBinding({
      db: eventlog.openEventLog(),
      attestation: callAuthority.currentHostCallAttestation(),
      sessionId: session.id,
      sourceUserSeq: source.seq,
      logicalToolCallId,
      acceptedTaskId,
      toolName: contract.toolName,
      argumentDigest: contract.argumentDigest,
      effect: 'read',
    });
    assert.equal(persisted.status, 'bound', JSON.stringify(persisted));
    input.beforeResolve?.();
    return carrier.resolveAcceptedExactMcpCarrier(manifest.operationId);
  }));
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

test('generic live-read materializer authority resolves the exact accepted native-MCP carrier', async () => {
  const acquired = await acquireGenericMcpCapability();
  const before = { ...acquired.live.counts };
  const resolved = resolveInsideAcceptedCall({ installed: acquired.installed });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  assert.deepEqual(acquired.live.counts, before, 'resolution performs no provider I/O');
});

test('revoked generic live-read manifest refuses before native-MCP provider I/O', async () => {
  const acquired = await acquireGenericMcpCapability();
  const before = { ...acquired.live.counts };
  const resolved = resolveInsideAcceptedCall({
    installed: acquired.installed,
    beforeResolve() {
      assert.equal(acquired.surfaces.store.revoke(acquired.installed.manifest.manifestId), true);
    },
  });
  assert.equal(resolved.ok, false);
  assert.deepEqual(acquired.live.counts, before);
});

test('forged equal-time provider definition conflict refuses before native-MCP provider I/O', async () => {
  const acquired = await acquireGenericMcpCapability();
  const before = { ...acquired.live.counts };
  const resolved = resolveInsideAcceptedCall({
    installed: acquired.installed,
    beforeResolve() {
      const existing = contracts.loadToolContract(acquired.installed.manifest.operationId);
      assert.ok(existing?.providerObservedAt);
      const forged = contracts.saveToolContract({
        identifier: acquired.installed.manifest.operationId,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { forged: { type: 'boolean' } },
          required: ['forged'],
        },
        providerObservedAt: existing!.providerObservedAt,
        providerOperationVersion: acquired.installed.manifest.operationVersion,
        providerOutputSchema: null,
      });
      assert.ok(forged?.providerAuthorityConflictAt);
    },
  });
  assert.equal(resolved.ok, false);
  if (!resolved.ok) assert.match(resolved.reason, /provider definition|schema/);
  assert.deepEqual(acquired.live.counts, before);
});

test('missing exact invoke port refuses before native-MCP provider I/O', async () => {
  const acquired = await acquireGenericMcpCapability();
  const before = { ...acquired.live.counts };
  const resolved = resolveInsideAcceptedCall({
    installed: acquired.installed,
    beforeResolve() { ports.clearProductionCapabilityPorts(); },
  });
  assert.equal(resolved.ok, false);
  assert.deepEqual(acquired.live.counts, before);
});
