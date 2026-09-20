/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/production-mcp-read-carrier.test.ts */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { MCPServer } from '@openai/agents';
import type { ManagedMcpServer } from '../../types.js';
import type { CatalogManifestExternalRiskBindingV1 } from './external-capability-risk-loader.js';
import type {
  CapabilityRiskAttestationV1,
  ExactUserGrantV1,
  ExactWorkCoverageV1,
} from './interactive-consent-policy.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-production-mcp-read-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const index = await import('../../memory/capability-index.js');
const contracts = await import('../../tools/tool-contract-store.js');
const eventlog = await import('./eventlog.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const manifests = await import('./capability-manifest.js');
const manifestStores = await import('./capability-manifest-store.js');
const ports = await import('./production-capability-ports.js');
const observations = await import('./independent-capability-observation.js');
const authority = await import('./accepted-turn-call-authority.js');
const plans = await import('../../memory/workflow-node-invocation-plan.js');
const kernel = await import('./workflow-read-only-call-kernel.js');
const mcp = await import('./production-mcp-read-carrier.js');
const externalRisk = await import('./external-capability-risk-loader.js');
const consent = await import('./interactive-consent-policy.js');
const durablePorts = await import('./production-capability-catalog.js');

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const generated = (label: string): string => `${label}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

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
  server?: string;
  objective: string;
  tools?: ToolState[];
  result?: unknown;
  rawResult?: unknown;
}) {
  const server = input.server ?? generated('server').toLowerCase();
  const state: {
    tools: unknown;
    credential: string;
    commandRevision: string;
    portRevision: string;
    unavailable: boolean;
    onList?: (count: number) => void;
  } = {
    tools: input.tools ?? [readTool({ server, name: generated('inspect').toLowerCase(), objective: input.objective })],
    credential: generated('credential'),
    commandRevision: '1',
    portRevision: '1',
    unavailable: false,
  };
  const counts = { list: 0, invalidate: 0, call: 0 };
  const calls: Array<{ name: string; args: Record<string, unknown> | null }> = [];
  const fake: Pick<MCPServer, 'listTools' | 'callTool' | 'invalidateToolsCache'> = {
    async invalidateToolsCache() {
      counts.invalidate += 1;
    },
    async listTools() {
      counts.list += 1;
      state.onList?.(counts.list);
      if (state.unavailable) throw new Error('generated MCP server unavailable');
      return state.tools as Awaited<ReturnType<MCPServer['listTools']>>;
    },
    async callTool(name, args) {
      counts.call += 1;
      calls.push({ name, args });
      if (input.rawResult !== undefined) return input.rawResult as Awaited<ReturnType<MCPServer['callTool']>>;
      const result = [{ type: 'text', text: JSON.stringify(input.result ?? { accepted: true, name, args }) }] as unknown as Awaited<ReturnType<MCPServer['callTool']>>;
      return result;
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
        description: 'Generated MCP server',
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
  return { server, state, counts, calls, runtime };
}

function resetAuthoritySurfaces(options: { durable?: boolean } = {}) {
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  const store = manifestStores.createCapabilityManifestStore([], { durable: options.durable });
  manifestStores.installCapabilityManifestStore(store);
  ports.clearProductionCapabilityPorts();
  observations.clearIndependentCapabilityObservations();
  return { store, factory: catalogs.peekHostCapabilityCatalogFactory()! };
}

function exactExternalBinding(
  entry: catalogs.RegisteredHostCapability,
): {
  binding: CatalogManifestExternalRiskBindingV1;
  identity: catalogs.CanonicalCatalogIdentityV1;
} {
  const identity = catalogs.canonicalCatalogIdentityOf(entry);
  assert.ok(identity);
  assert.ok(identity.providerInputSchemaDigest);
  return {
    binding: {
      bindingKind: 'catalog_manifest',
      capabilityId: identity.capabilityId,
      providerInputSchemaDigest: identity.providerInputSchemaDigest,
      schemaFingerprint: identity.schemaDigest,
      accountId: identity.account,
      invokePortId: identity.invokePortId,
      operationId: identity.operationId,
      manifestId: identity.manifestId,
      manifestDigest: identity.manifestDigest,
      effect: identity.effect,
    },
    identity,
  };
}

function exactCoverage(call: CapabilityRiskAttestationV1): ExactWorkCoverageV1 {
  return {
    version: 1,
    source: { ...call.source },
    acceptedTaskId: call.acceptedTaskId,
    contractId: generated('contract'),
    requirementId: generated('requirement'),
    requirementDigest: digest(generated('requirement-digest')),
    semanticScope: {
      operationId: call.operationId,
      schemaFingerprint: call.schemaFingerprint,
      effect: call.effect,
      accountId: call.accountId,
      destination: { ...call.destination },
      cardinality: { ...call.cardinality },
      semanticBasis: { ...call.semanticBasis },
    },
    callBinding: {
      logicalToolCallId: call.logicalToolCallId,
      argumentDigest: call.argumentDigest,
      bindingDigest: call.bindingDigest,
    },
    reservationKey: generated('reservation'),
  };
}

function exactGrant(call: CapabilityRiskAttestationV1): ExactUserGrantV1 {
  return {
    version: 1,
    source: 'approval_resolution',
    grantDigest: digest(generated('grant')),
    scope: {
      source: { ...call.source },
      acceptedTaskId: call.acceptedTaskId,
      logicalToolCallId: call.logicalToolCallId,
      bindingDigest: call.bindingDigest,
      operationId: call.operationId,
      argumentDigest: call.argumentDigest,
      schemaFingerprint: call.schemaFingerprint,
      effect: call.effect,
      accountId: call.accountId,
      destination: { ...call.destination },
      cardinality: { ...call.cardinality },
      risk: { ...call.risk },
      semanticBasis: { ...call.semanticBasis },
    },
  };
}

function invocationPlan(entry: catalogs.RegisteredHostCapability) {
  const identity = catalogs.canonicalCatalogIdentityOf(entry);
  assert.ok(identity);
  return plans.createWorkflowNodeInvocationPlan({
    requirementId: generated('requirement'),
    logicalCapabilityId: generated('logical-capability'),
    binding: {
      capabilityId: identity.capabilityId,
      manifestId: identity.manifestId,
      manifestDigest: identity.manifestDigest,
      operationId: identity.operationId,
      operationVersion: identity.schemaVersion,
      schemaDigest: identity.schemaDigest,
      providerVersion: identity.providerVersion,
      liveFingerprint: identity.liveFingerprint,
      accountId: identity.account,
      effect: 'read',
      invokePortId: identity.invokePortId,
      argumentCompiler: { ...identity.argumentCompiler },
    },
    arguments: {
      token: {
        source: { kind: 'workflow_input', key: 'token' },
        required: true,
        type: 'string',
      },
    },
    evidence: {
      requiredPaths: ['result'],
      nonEmptyPaths: ['result'],
      minItems: { result: 1 },
    },
    completeness: { kind: 'terminal_result', evidencePaths: ['result'] },
    continuation: { kind: 'none' },
  });
}

function arm(plan: plans.WorkflowNodeInvocationPlanV1, label: string) {
  const session = eventlog.createSession({ id: generated(`workflow-session.${label}`), kind: 'workflow' });
  return authority.armWorkflowReadOnlyCallAuthority({
    sessionId: session.id,
    workflowId: generated(`workflow.${label}`),
    workflowRevision: 1,
    workflowDigest: digest(generated(`workflow-digest.${label}`)),
    runId: generated(`run.${label}`),
    runOccurrenceId: generated(`occurrence.${label}`),
    nodeId: generated(`node.${label}`),
    nodeAttempt: 1,
    invocationPlanDigest: plan.bindingDigest,
    bindingSnapshotDigest: digest(generated(`binding.${label}`)),
    controlDigest: digest(generated(`control.${label}`)),
    logicalCallId: generated(`logical.${label}`),
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

test('empty home accounts exact live preparation and business workflow crossings separately', async () => {
  const objective = generated('objective').toLowerCase();
  const generatedMcp = generatedRuntime({ objective });
  const { store, factory } = resetAuthoritySurfaces({ durable: true });
  assert.equal(index.capabilityIndexStats().operations, 0);
  assert.equal(store.list().length, 0);
  assert.equal(factory.snapshot().length, 0);
  assert.equal(ports.listProductionCapabilityPorts().length, 0);

  const adapter = mcp.createProductionMcpReadCarrier({
    serverName: generatedMcp.server,
    runtime: generatedMcp.runtime,
  });
  const installed = await adapter.materialize(`retrieve ${objective}`);
  assert.equal(installed.status, 'installed', JSON.stringify(installed));
  if (installed.status !== 'installed') return;
  assert.equal(installed.manifest.providerKind, 'native_mcp');
  assert.equal(installed.manifest.effect, 'read');
  assert.equal(installed.attestation.effectAttestation, 'carrier_declared');
  assert.match(installed.manifest.providerIdentity, /^mcp-config:/);
  assert.match(installed.manifest.providerVersion, /^mcp-config-v1:/);
  assert.match(installed.manifest.accountId, /^native_mcp:/);
  assert.match(installed.manifest.operationVersion, /^mcp-tool-v1:/);
  assert.match(installed.manifest.invokePortId, /^host:test-native-mcp-read:/);
  assert.deepEqual(installed.attestation.inputSchema, (generatedMcp.state.tools as ToolState[])[0]!.inputSchema);
  assert.equal(
    contracts.loadToolContract(installed.manifest.operationId)?.fingerprint,
    installed.attestation.schemaFingerprint,
  );
  assert.equal(ports.listProductionCapabilityPorts().length, 1);
  assert.equal(factory.snapshot().length, 1);
  const providerCrossingsBeforeExecution = generatedMcp.counts.list + generatedMcp.counts.call;

  const entry = factory.get(installed.manifest.manifestId);
  assert.ok(entry);
  const plan = invocationPlan(entry);
  const armed = arm(plan, 'blank');
  assert.equal(armed.status, 'armed', JSON.stringify(armed));
  if (armed.status !== 'armed') return;
  const workflowArgs = { token: generated('input') };
  const executed = await kernel.executeWorkflowReadOnlyCall({
    activationId: armed.ref.activationId,
    invocationPlan: plan,
    args: workflowArgs,
  });
  assert.equal(executed.status, 'completed', JSON.stringify(executed));
  assert.equal(generatedMcp.counts.call, 1);
  assert.equal(generatedMcp.calls[0]!.name, installed.manifest.operationId);
  assert.equal(generatedMcp.counts.list, 4, 'execution owns one separately-accounted live preparation list');

  const counts = eventlog.openEventLog().prepare(`
    SELECT
      (SELECT COUNT(*) FROM logical_tool_calls
        WHERE session_id = ? AND source_user_seq = ?) AS logical_n,
      (SELECT COUNT(*) FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ?
          AND io_claimed_at IS NOT NULL AND state = 'returned') AS physical_n,
      (SELECT COUNT(*) FROM logical_call_settlements
        WHERE session_id = ? AND source_user_seq = ?) AS settlement_n
  `).get(
    armed.ref.sessionId,
    armed.ref.sourceEventSeq,
    armed.ref.sessionId,
    armed.ref.sourceEventSeq,
    armed.ref.sessionId,
    armed.ref.sourceEventSeq,
  ) as { logical_n: number; physical_n: number; settlement_n: number };
  assert.deepEqual(counts, { logical_n: 1, physical_n: 2, settlement_n: 1 });
  const crossings = eventlog.openEventLog().prepare(`
    SELECT ordinal, relation, state
      FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
     ORDER BY ordinal
  `).all(armed.ref.sessionId, armed.ref.sourceEventSeq);
  assert.deepEqual(crossings, [
    { ordinal: 1, relation: 'probe', state: 'returned' },
    { ordinal: 2, relation: 'child', state: 'returned' },
  ]);
  assert.equal(
    generatedMcp.counts.list + generatedMcp.counts.call - providerCrossingsBeforeExecution,
    crossings.length,
    'one live list plus one callTool equals two admitted physical starts',
  );

  const providerCrossingsBeforeReplay = generatedMcp.counts.list + generatedMcp.counts.call;
  const replayed = await kernel.executeWorkflowReadOnlyCall({
    activationId: armed.ref.activationId,
    invocationPlan: plan,
    args: workflowArgs,
  });
  assert.equal(replayed.status, 'replayed', JSON.stringify(replayed));
  assert.equal(
    generatedMcp.counts.list + generatedMcp.counts.call,
    providerCrossingsBeforeReplay,
    'exact replay adds no preparation or business provider crossing',
  );
  assert.equal((eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
  `).get(armed.ref.sessionId, armed.ref.sourceEventSeq) as { n: number }).n, 2);

  // A restart observation is necessarily newer than the manifest's original
  // installation provenance. That observation time is not definition drift.
  await new Promise((resolve) => setTimeout(resolve, 5));

  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  manifestStores.installCapabilityManifestStore(
    manifestStores.createCapabilityManifestStore([], { durable: true }),
  );
  ports.clearProductionCapabilityPorts();
  observations.clearIndependentCapabilityObservations();
  const restarted = mcp.createProductionMcpReadCarrier({
    serverName: generatedMcp.server,
    runtime: generatedMcp.runtime,
  });
  const warm = await restarted.materialize(`retrieve ${objective}`);
  assert.equal(warm.status, 'installed', JSON.stringify(warm));
  if (warm.status === 'installed') {
    assert.equal(warm.manifest.manifestId, installed.manifest.manifestId);
    assert.equal(
      manifests.capabilityManifestDigest(warm.manifest),
      manifests.capabilityManifestDigest(installed.manifest),
    );
    assert.equal(warm.manifest.provenance.issuedAt, installed.manifest.provenance.issuedAt);
    assert.equal(catalogs.peekHostCapabilityCatalogFactory()?.snapshot().length, 1);
    assert.equal(ports.listProductionCapabilityPorts().length, 1);
  }
});

test('rename, schema, account, provider-surface, and invoke drift supersede exact prior authority', async () => {
  const objective = generated('objective').toLowerCase();
  const generatedMcp = generatedRuntime({ objective });
  const { store } = resetAuthoritySurfaces();
  const run = () => mcp.createProductionMcpReadCarrier({
    serverName: generatedMcp.server,
    runtime: generatedMcp.runtime,
  }).materialize(`retrieve ${objective}`);
  let prior = await run();
  assert.equal(prior.status, 'installed');
  if (prior.status !== 'installed') return;

  const mutations: Array<() => void> = [
    () => {
      (generatedMcp.state.tools as ToolState[])[0]!.name = `${generatedMcp.server}__${generated('renamed').toLowerCase()}`;
    },
    () => {
      (generatedMcp.state.tools as ToolState[])[0]!.inputSchema = {
        type: 'object',
        additionalProperties: false,
        properties: { token: { type: 'string' }, page: { type: 'integer' } },
        required: ['token', 'page'],
      };
    },
    () => { generatedMcp.state.credential = generated('rotated'); },
    () => {
      (generatedMcp.state.tools as ToolState[])[0]!.description = `Changed provider surface for ${objective}`;
    },
    () => { generatedMcp.state.portRevision = '2'; },
  ];
  for (const mutate of mutations) {
    const priorId = prior.manifest.manifestId;
    mutate();
    const next = await run();
    assert.equal(next.status, 'installed', JSON.stringify(next));
    if (next.status !== 'installed') return;
    assert.notEqual(next.manifest.manifestId, priorId);
    assert.equal(store.get(priorId)?.manifest.lifecycle.state, 'superseded');
    assert.deepEqual(next.replaced, [priorId]);
    prior = next;
  }
});

test('removal and outage retire stale authority; live recovery reacquires it', async () => {
  const objective = generated('objective').toLowerCase();
  const generatedMcp = generatedRuntime({ objective });
  const { store, factory } = resetAuthoritySurfaces();
  const adapter = () => mcp.createProductionMcpReadCarrier({
    serverName: generatedMcp.server,
    runtime: generatedMcp.runtime,
  });
  const installed = await adapter().materialize(`retrieve ${objective}`);
  assert.equal(installed.status, 'installed');
  if (installed.status !== 'installed') return;

  generatedMcp.state.tools = [];
  const removed = await adapter().materialize(`retrieve ${objective}`);
  assert.equal(removed.status, 'blocked');
  if (removed.status === 'blocked') assert.equal(removed.reason, 'missing');
  assert.equal(store.get(installed.manifest.manifestId)?.manifest.lifecycle.state, 'revoked');
  assert.equal(factory.snapshot().length, 0);

  generatedMcp.state.tools = [readTool({
    server: generatedMcp.server,
    name: installed.manifest.operationId.split('__')[1]!,
    objective,
  })];
  generatedMcp.state.unavailable = true;
  const unavailable = await adapter().materialize(`retrieve ${objective}`);
  assert.equal(unavailable.status, 'blocked');
  if (unavailable.status === 'blocked') assert.equal(unavailable.reason, 'carrier_unavailable');
  generatedMcp.state.unavailable = false;
  const recovered = await adapter().materialize(`retrieve ${objective}`);
  assert.equal(recovered.status, 'installed', JSON.stringify(recovered));
  if (recovered.status === 'installed') {
    assert.notEqual(recovered.manifest.manifestId, installed.manifest.manifestId);
    assert.equal(factory.snapshot().length, 1);
  }
});

test('ambiguous relevant definitions and unrelated operations install or execute nothing unintended', async () => {
  const objective = generated('objective').toLowerCase();
  const server = generated('server').toLowerCase();
  const ambiguousRuntime = generatedRuntime({
    server,
    objective,
    tools: [
      readTool({ server, name: generated('inspect-a').toLowerCase(), objective }),
      readTool({ server, name: generated('inspect-b').toLowerCase(), objective }),
    ],
  });
  resetAuthoritySurfaces();
  const ambiguous = await mcp.createProductionMcpReadCarrier({
    serverName: server,
    runtime: ambiguousRuntime.runtime,
  }).materialize(`retrieve ${objective}`);
  assert.equal(ambiguous.status, 'blocked');
  if (ambiguous.status === 'blocked') assert.equal(ambiguous.reason, 'ambiguous');
  assert.equal(ports.listProductionCapabilityPorts().length, 0);
  assert.equal(catalogs.peekHostCapabilityCatalogFactory()?.snapshot().length, 0);
  assert.equal(ambiguousRuntime.counts.call, 0);

  resetAuthoritySurfaces();
  const exactObjective = generated('exact-objective').toLowerCase();
  const irrelevant = generated('irrelevant-objective').toLowerCase();
  const exactRuntime = generatedRuntime({
    server,
    objective: exactObjective,
    tools: [
      readTool({ server, name: generated('exact').toLowerCase(), objective: exactObjective }),
      readTool({ server, name: generated('other').toLowerCase(), objective: irrelevant }),
    ],
  });
  const exact = await mcp.createProductionMcpReadCarrier({
    serverName: server,
    runtime: exactRuntime.runtime,
  }).materialize(`retrieve ${exactObjective}`);
  assert.equal(exact.status, 'installed', JSON.stringify(exact));
  if (exact.status === 'installed') {
    assert.match(exact.manifest.operationId, /exact/);
    assert.doesNotMatch(exact.manifest.operationId, /other/);
    assert.equal(catalogs.peekHostCapabilityCatalogFactory()?.snapshot().length, 1);
  }
});

test('getter, symbol, sparse, and oversized live definitions execute no code and mint no authority', async (t) => {
  const cases: Array<{ label: string; value(getterCount: { n: number }, server: string, objective: string): unknown }> = [
    {
      label: 'getter',
      value(getterCount, server, objective) {
        const tool: Record<string, unknown> = readTool({ server, name: 'getter_probe', objective });
        Object.defineProperty(tool, 'inputSchema', {
          enumerable: true,
          get() {
            getterCount.n += 1;
            return { type: 'object' };
          },
        });
        return [tool];
      },
    },
    {
      label: 'symbol',
      value(_getterCount, server, objective) {
        const schema: Record<string | symbol, unknown> = { type: 'object' };
        schema[Symbol('hidden')] = true;
        return [{ ...readTool({ server, name: 'symbol_probe', objective }), inputSchema: schema }];
      },
    },
    {
      label: 'sparse',
      value(_getterCount, server, objective) {
        const rows = new Array(2);
        rows[1] = readTool({ server, name: 'sparse_probe', objective });
        return rows;
      },
    },
    {
      label: 'oversized',
      value(_getterCount, server, objective) {
        return [{
          ...readTool({ server, name: 'oversized_probe', objective }),
          description: 'x'.repeat(1_048_577),
        }];
      },
    },
  ];
  for (const hostile of cases) {
    await t.test(hostile.label, async () => {
      resetAuthoritySurfaces();
      const objective = generated(`objective-${hostile.label}`).toLowerCase();
      const runtime = generatedRuntime({ objective });
      const getterCount = { n: 0 };
      runtime.state.tools = hostile.value(getterCount, runtime.server, objective);
      const result = await mcp.createProductionMcpReadCarrier({
        serverName: runtime.server,
        runtime: runtime.runtime,
      }).materialize(`retrieve ${objective}`);
      assert.equal(result.status, 'blocked');
      assert.equal(getterCount.n, 0);
      assert.equal(runtime.counts.call, 0);
      assert.equal(ports.listProductionCapabilityPorts().length, 0);
      assert.equal(catalogs.peekHostCapabilityCatalogFactory()?.snapshot().length, 0);
    });
  }
});

test('schema, account, and invoke drift after admission are blocked before MCP callTool', async (t) => {
  for (const drift of ['schema', 'account', 'invoke'] as const) {
    await t.test(drift, async () => {
      const objective = generated(`objective-${drift}`).toLowerCase();
      const runtime = generatedRuntime({ objective });
      const { factory } = resetAuthoritySurfaces();
      const installed = await mcp.createProductionMcpReadCarrier({
        serverName: runtime.server,
        runtime: runtime.runtime,
      }).materialize(`retrieve ${objective}`);
      assert.equal(installed.status, 'installed', JSON.stringify(installed));
      if (installed.status !== 'installed') return;
      const entry = factory.get(installed.manifest.manifestId);
      assert.ok(entry);
      const plan = invocationPlan(entry);
      const armed = arm(plan, `crossing-${drift}`);
      assert.equal(armed.status, 'armed');
      if (armed.status !== 'armed') return;
      if (drift === 'schema') {
        (runtime.state.tools as ToolState[])[0]!.inputSchema = {
          type: 'object',
          properties: { replacement: { type: 'string' } },
          required: ['replacement'],
        };
      } else if (drift === 'account') {
        runtime.state.credential = generated('changed-account');
      } else {
        runtime.state.portRevision = 'changed';
      }
      const providerCrossingsBeforeExecution = runtime.counts.list + runtime.counts.call;
      const result = await kernel.executeWorkflowReadOnlyCall({
        activationId: armed.ref.activationId,
        invocationPlan: plan,
        args: { token: generated('input') },
      });
      const physicalStarts = (eventlog.openEventLog().prepare(`
        SELECT COUNT(*) AS n
          FROM physical_dispatches
         WHERE session_id = ? AND source_user_seq = ?
      `).get(armed.ref.sessionId, armed.ref.sourceEventSeq) as { n: number }).n;
      const providerCrossings = runtime.counts.list + runtime.counts.call
        - providerCrossingsBeforeExecution;
      assert.equal(providerCrossings, physicalStarts);
      if (drift === 'schema') {
        assert.equal(result.status, 'failed', JSON.stringify(result));
        assert.equal(physicalStarts, 1, 'live schema drift settles one admitted preparation crossing');
      } else {
        assert.equal(result.status, 'blocked', JSON.stringify(result));
        assert.equal(physicalStarts, 0, 'local account/invoke drift blocks before physical admission');
      }
      assert.equal(runtime.counts.call, 0, 'drift is detected before tools/call');
    });
  }
});

test('undeclared names stay unknown and declared destructive effects stay non-authoritative', async () => {
  const server = generated('server').toLowerCase();
  for (const [name, annotations, expectedProvenance] of [
    ['opaque_probe', undefined, 'none'],
    ['delete_all', undefined, 'none'],
    ['declared_destructive', { readOnlyHint: true, destructiveHint: true }, 'declared'],
  ] as const) {
    resetAuthoritySurfaces();
    const objective = generated(`objective-${name}`).toLowerCase();
    const tool = readTool({ server, name, objective });
    if (annotations === undefined) delete tool.annotations;
    else tool.annotations = annotations;
    const runtime = generatedRuntime({
      server,
      objective,
      tools: [tool],
    });
    const result = await mcp.createProductionMcpReadCarrier({
      serverName: server,
      runtime: runtime.runtime,
    }).materialize(`retrieve ${objective}`);
    assert.equal(result.status, 'blocked');
    assert.equal(runtime.counts.call, 0);
    assert.equal(ports.listProductionCapabilityPorts().length, 0);
    const [hint] = index.listCapabilityOperationsForCarrier('mcp', server, 10);
    assert.ok(hint);
    assert.equal(hint.effectProvenance, expectedProvenance);
  }
});

test('exact foreground MCP disclosure materializes one declared ordinary write with full definition authority', async () => {
  const server = generated('server').toLowerCase();
  const objective = generated('objective').toLowerCase();
  const tool: ToolState = {
    name: `${server}__create_record`,
    description: `Create one ${objective} record.`,
    inputSchema: {
      type: 'object',
      properties: { body: { type: 'string' } },
      required: ['body'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  };
  const runtime = generatedRuntime({ server, objective, tools: [tool] });
  const { factory } = resetAuthoritySurfaces();
  const result = await mcp.createProductionMcpReadCarrier({
    serverName: server,
    runtime: runtime.runtime,
  }).materializeExact({
    operationId: tool.name,
    inputSchema: tool.inputSchema,
  });
  assert.equal(result.status, 'installed', JSON.stringify(result));
  if (result.status !== 'installed') return;
  assert.equal(result.manifest.effect, 'external_write');
  assert.equal(result.manifest.destination?.posture, 'create_new');
  assert.deepEqual(result.manifest.externalDefinition?.behaviorHints, {
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: false,
  });
  assert.match(result.manifest.externalDefinition?.providerInputSchemaDigest ?? '', /^[a-f0-9]{64}$/);
  const entry = factory.get(result.manifest.manifestId);
  assert.ok(entry);
  assert.equal(
    entry.providerInputSchemaDigest,
    result.manifest.externalDefinition?.providerInputSchemaDigest,
  );
  assert.equal(runtime.counts.call, 0, 'materialization performs metadata I/O only');
});

for (const reacquire of [false, true]) test(`objective MCP discovery retains its disclosed identity across repeat and reopen (reacquired=${reacquire})`, async () => {
  const objective = generated('discovery').toLowerCase();
  const runtime = generatedRuntime({ objective });
  const { store, factory } = resetAuthoritySurfaces({ durable: true });
  const discover = () => mcp.createProductionMcpReadCarrier({ serverName: runtime.server, runtime: runtime.runtime })
    .materialize(`retrieve ${objective}`);
  const first = await discover();
  assert.equal(first.status, 'installed', JSON.stringify(first));
  if (first.status !== 'installed') return;
  let retained = first.manifest;
  if (reacquire) {
    assert.ok(store.revoke(retained.manifestId));
    factory.forget(retained.manifestId);
    const fresh = await discover();
    assert.equal(fresh.status, 'installed', JSON.stringify(fresh));
    if (fresh.status !== 'installed') return;
    assert.notEqual(fresh.manifest.manifestId, retained.manifestId, 'do not revive a retired plan reference');
    retained = fresh.manifest;
  }
  await new Promise(resolve => setTimeout(resolve, 5));
  const again = await discover();
  assert.equal(again.status, 'installed', JSON.stringify(again));
  if (again.status !== 'installed') return;
  assert.deepEqual(again.manifest, retained, 'unchanged live schema keeps the exact disclosed reference and issuance');
  const materializer = await import('./live-capability-materializer.js');
  const { closedCanonicalJson } = await import('../../shared/closed-canonical-json.js');
  assert.equal(materializer.liveReadIdentityMatches(again.attestation, {
    ...again.attestation,
    externalDefinition: JSON.parse(closedCanonicalJson(again.attestation.externalDefinition)),
  }), true, 'JSON object enumeration order is not a provider definition change');
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  eventlog.closeEventLog();
  manifestStores.installCapabilityManifestStore(manifestStores.createCapabilityManifestStore([], { durable: true }));
  ports.clearProductionCapabilityPorts();
  observations.clearIndependentCapabilityObservations();
  durablePorts.reconstructShippedPortsForDurableSuccessors();
  const reopened = await discover();
  assert.equal(reopened.status, 'installed', JSON.stringify(reopened));
  if (reopened.status !== 'installed') return;
  assert.deepEqual(reopened.manifest, retained, 'SQLite reopen must not invalidate the reviewed reference');
  const entry = catalogs.peekHostCapabilityCatalogFactory()!.get(retained.manifestId);
  assert.ok(entry);
  const plan = invocationPlan(entry);
  const armed = arm(plan, 'objective-reopen');
  assert.equal(armed.status, 'armed', JSON.stringify(armed));
  if (armed.status !== 'armed') return;
  const executed = await kernel.executeWorkflowReadOnlyCall({ activationId: armed.ref.activationId, invocationPlan: plan, args: { token: 'reviewed' } });
  assert.equal(executed.status, 'completed', JSON.stringify(executed));
  assert.equal(runtime.counts.call, 1);
});

for (const effect of ['read', 'external_write'] as const) for (const reacquire of [false, true]) for (const mixedDiscovery of (effect === 'read' ? [false, true] : [false])) for (const retireBeforeRead of (mixedDiscovery ? [false, true] : [false])) for (const literalControls of (effect === 'read' && mixedDiscovery && !reacquire && !retireBeforeRead ? [false, true] : [false])) test(`repeated exact MCP discovery preserves the published identity across a later observation and reopen (${effect}, reacquired=${reacquire}, mixed=${mixedDiscovery}, retired=${retireBeforeRead}, literalControls=${literalControls})`, async () => {
  // One variant exercises the whole native transport, including dependencies
  // submitted out of order in one model frame and final receipt certification.
  const completeJourney = effect === 'read' && mixedDiscovery && !reacquire && !retireBeforeRead;
  const objective = generated('research').toLowerCase();
  const runtime = generatedRuntime({ objective, ...(completeJourney ? { result: [{ id: 'a', score: 7 }, { id: 'b', score: 9 }, { id: 'c', score: 11 }] } : {}) });
  const tool = (runtime.state.tools as ToolState[])[0]!;
  tool.annotations = { readOnlyHint: effect === 'read', destructiveHint: false };
  const { store } = resetAuthoritySurfaces({ durable: true });
  const carrier = mcp.createProductionMcpReadCarrier({ serverName: runtime.server, runtime: runtime.runtime });
  const discover = () => mixedDiscovery ? carrier.materialize(`retrieve ${objective}`)
    : carrier.materializeExact({ operationId: tool.name, inputSchema: tool.inputSchema });
  let first = await discover();
  assert.equal(first.status, 'installed', JSON.stringify(first));
  if (first.status !== 'installed') return;
  if (mixedDiscovery) {
    const exact = await carrier.materializeExact({ operationId: tool.name, inputSchema: tool.inputSchema });
    assert.equal(exact.status, 'installed', JSON.stringify(exact));
    first = await discover();
    assert.equal(first.status, 'installed', JSON.stringify(first));
    if (first.status !== 'installed') return;
  }
  if (reacquire) {
    assert.ok(store.revoke(first.manifest.manifestId));
    catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
    first = await discover();
    assert.equal(first.status, 'installed', JSON.stringify(first));
    if (first.status !== 'installed') return;
    assert.ok(first.manifest.manifestId.length > 128, 'exercise the full reacquired reference through Plan and Execute');
  }
  const { closedCanonicalJson } = await import('../../shared/closed-canonical-json.js');
  const reorderedManifest = {
    ...first.manifest,
    externalDefinition: {
      ...JSON.parse(closedCanonicalJson(first.manifest.externalDefinition)),
      // Keep the existing manifest hash dialect: this control changes only
      // property enumeration at the definition boundary, not its nested hints.
      behaviorHints: first.manifest.externalDefinition!.behaviorHints,
    },
  };
  assert.equal(manifests.capabilityManifestDigest(reorderedManifest), manifests.capabilityManifestDigest(first.manifest));
  await mcp.prepareProductionMcpInvocation(reorderedManifest);
  await new Promise(resolve => setTimeout(resolve, 5));
  const again = await discover();
  assert.equal(again.status, 'installed', JSON.stringify(again));
  if (again.status !== 'installed') return;
  assert.deepEqual(again.manifest, first.manifest, 'observation time is not manifest issuance time');
  assert.equal(store.get(first.manifest.manifestId)?.manifest.lifecycle.state, 'current');
  const semantic = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
  const publisher = await import('../../tools/publish-plan.js');
  const artifacts = await import('./plan-artifacts.js');
  const reviewed = await import('./reviewed-plan-runtime.js');
  const session = eventlog.createSession({ id: generated('mcp-plan'), kind: 'chat' });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Prepare a plan using my connected records.', taskMode: { version: 1, kind: 'plan' } } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.ok(primed.ok, JSON.stringify(primed)); if (!primed.ok) return;
  await semantic.disclosePrimaryModelPlanningCapabilities({ authority: primed.planning.authority,
    candidates: [{ sourceKind: 'authorized_external_mcp', name: tool.name, schema: tool.inputSchema as Record<string, unknown>, carrier: 'work_call' }] });
  const synthesisSteps: unknown[] = [];
  const outputPath = path.join(TEST_HOME, `reviewed-native-comparison-${source.seq}.md`);
  const content = 'The source reports a: 7, b: 9, c: 11. These are observations, not causal claims.\n';
  const synthesisArgs = JSON.stringify({ step_id: 'synthesize', data: { markdown: content } });
  const modelSynthesisArgs = literalControls ? synthesisArgs.replaceAll('\\n', '\n') : synthesisArgs;
  if (literalControls) assert.throws(() => JSON.parse(modelSynthesisArgs));
  if (effect === 'read') {
    const local = await import('./local-planning-capability.js');
    const { getCoreTools } = await import('../../tools/registry.js');
    const names = new Set(getCoreTools().map(tool => tool.name));
    const candidates = await Promise.all(['write_file', 'read_file'].map(name => local.issueAuthorizedLocalPlanningDisclosureCandidate({ name, carrier: 'work_call', configuredNames: names })));
    assert.ok(candidates.every(candidate => candidate && !('refused' in candidate)));
    const refs = await semantic.disclosePrimaryModelPlanningCapabilities({ authority: primed.planning.authority, candidates: candidates as any });
    const base = { dynamicBindings: [], dependsOn: [], subagentRole: null };
    synthesisSteps.push(
      { ...base, id: 'synthesize', action: 'Interpret the connected records and compose a briefing.', effect: 'compute', capabilityRef: null,
        staticArguments: {}, dependsOn: completeJourney ? ['records', 'metrics'] : ['records'], verification: 'The briefing cites the records.' },
      { ...base, id: 'save', action: 'Save the composed briefing.', effect: 'local_write', capabilityRef: refs.write_file,
        staticArguments: { path: outputPath }, dynamicBindings: [{ producerStepId: 'synthesize', outputPath: '/markdown', targetPath: '/content', expectedType: 'string' }], verification: 'Committed composed bytes.' },
      { ...base, id: 'verify', action: 'Read the saved briefing.', effect: 'read', capabilityRef: refs.read_file,
        staticArguments: { path: outputPath }, dependsOn: ['save'], verification: 'Readback matches the composed briefing.' },
    );
  }
  const outline = await publisher.preparePlanOutline({ ...identity, planning: primed.planning, ready: true, raw: {
    steps: [{ id: 'records', action: 'Use the exact connected operation.', effect, capabilityRef: first.manifest.manifestId,
      staticArguments: mixedDiscovery ? {} : { token: 'reviewed-token' },
      ...(mixedDiscovery ? { forEach: { items: [{ id: 'member-a', token: 'reviewed-token' }], memberIdPath: '/id',
        bindings: [{ itemPath: '/token', targetPath: '/token' }] } } : {}),
      dynamicBindings: [], dependsOn: completeJourney ? ['brief'] : [], subagentRole: null, verification: 'Returned records.' },
      ...(completeJourney ? [
        { id: 'brief', action: 'Read the brief before researching.', effect: 'read', capabilityRef: first.manifest.manifestId,
          staticArguments: { token: 'brief-token' }, dynamicBindings: [], dependsOn: [], subagentRole: null, verification: 'Brief read.' },
        { id: 'metrics', action: 'Read comparative metrics after the brief.', effect: 'read', capabilityRef: first.manifest.manifestId,
          staticArguments: { token: 'metrics-token' }, dynamicBindings: [], dependsOn: ['brief'], subagentRole: null, verification: 'Metrics read.' },
      ] : []), ...synthesisSteps],
    successCriteria: ['Connected result retained.'], subagents: [],
  } });
  const plan = artifacts.publishPlanRevision({ ...identity, principalId: session.id, fullText: 'Use the connected operation with reviewed-token.', structuredPlan: outline, readiness: 'ready' });
  const ref = { planId: plan.planId, revision: plan.revision, digest: plan.digest };
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  eventlog.closeEventLog();
  manifestStores.installCapabilityManifestStore(manifestStores.createCapabilityManifestStore([], { durable: true }));
  ports.clearProductionCapabilityPorts();
  observations.clearIndependentCapabilityObservations();
  durablePorts.reconstructShippedPortsForDurableSuccessors();
  const reopened = await discover();
  assert.equal(reopened.status, 'installed', JSON.stringify(reopened));
  if (reopened.status === 'installed') assert.deepEqual(reopened.manifest, first.manifest);
  if (mixedDiscovery) {
    const other = await carrier.materializeExact({ operationId: tool.name, inputSchema: tool.inputSchema });
    assert.equal(other.status, 'installed', JSON.stringify(other));
    if (other.status === 'installed') assert.notEqual(other.manifest.manifestId, first.manifest.manifestId);
  }
  const execute = eventlog.appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Execute this plan.', taskMode: { version: 1, kind: 'execute', executeRef: ref } } });
  artifacts.claimPlanExecution({ sessionId: session.id, sourceUserSeq: execute.seq, principalId: session.id, executeRef: ref });
  const selected = await semantic.primePrimaryModelPlanningCatalog({ sessionId: session.id, sourceUserSeq: execute.seq });
  assert.ok(selected.ok, JSON.stringify(selected)); if (!selected.ok) return;
  await reviewed.revalidateReviewedPlanPreparation(selected.planning);
  if (effect === 'read') {
    const brackets = await import('./brackets.js');
    const { EventEmitter } = await import('node:events');
    const envelopes = await import('../../agents/capability-envelope.js');
    const host = await import('./host-turn-runner.js');
    const { buildPlanTaskTool } = await import('../../tools/plan-tools.js');
    const { buildWorkCall } = await import('../../tools/work-call.js');
    const { buildPlanStepResultTool } = await import('../../tools/plan-step-result.js');
    const { loadExpectedWorkContract } = await import('./expected-work-contract.js');
    const { acceptedPlanExecutionText } = await import('./accepted-plan-execution.js');
    const activationIdentity = { sessionId: session.id, sourceUserSeq: execute.seq, turn: 2 };
    const planTool = brackets.wrapToolForHarness(buildPlanTaskTool({ planning: selected.planning }) as never);
    const workTool = brackets.wrapToolForHarness(buildWorkCall({ requireHostPlan: true, reachableBuiltinNames: new Set(completeJourney ? ['write_file', 'read_file'] : []),
      firstClassNames: new Set(), catalogIdentifiers: [tool.name], hostPlanningReady: () => true }) as never);
    const resultTool = brackets.wrapToolForHarness(buildPlanStepResultTool(activationIdentity) as never);
    const reviewedManifestId = first.manifest.manifestId;
    let requests = 0;
    const model = {
      async getResponse() {
        const frame = requests++;
        if (frame === 1 && retireBeforeRead) {
          assert.ok(manifestStores.resolveCapabilityManifestStore().revoke(reviewedManifestId));
          catalogs.peekHostCapabilityCatalogFactory()!.forget(reviewedManifestId);
        }
        const output = frame === 0
          ? [{ type: 'function_call', callId: 'activate-native-synthesis', name: 'plan_task', arguments: '{}' }]
          : frame === 1
          ? [{ type: 'function_call', callId: 'read-native-synthesis', name: 'work_call', arguments: JSON.stringify({ requirement_id: 'records',
            ...(mixedDiscovery ? { universe_item_id: 'member-a' } : {}), name: tool.name, args_json: JSON.stringify({ token: 'reviewed-token' }) }) },
            ...(completeJourney ? ['metrics', 'brief'].map(id => ({ type: 'function_call', callId: `read-native-${id}`, name: 'work_call', arguments: JSON.stringify({ requirement_id: id, name: tool.name, args_json: JSON.stringify({ token: `${id}-token` }) }) })) : [])]
          : completeJourney && frame === 2
          ? [{ type: 'function_call', callId: 'compose-native-synthesis', name: 'plan_step_result', arguments: modelSynthesisArgs }]
          : completeJourney && (frame === 3 || frame === 4)
          ? [{ type: 'function_call', callId: frame === 3 ? 'save-native-synthesis' : 'verify-native-synthesis', name: 'work_call', arguments: JSON.stringify({ requirement_id: frame === 3 ? 'save' : 'verify', name: frame === 3 ? 'write_file' : 'read_file', args_json: JSON.stringify({ path: outputPath }) }) }]
          : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: completeJourney ? 'The briefing is saved.' : 'Fixture stops after the approved read.' }] }];
        return { output, responseId: `native-plan-${requests}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      },
      async *getStreamedResponse() {
        const response = await this.getResponse();
        yield { type: 'response_started' } as never;
        yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
      },
    };
    const agent = { model, tools: [planTool, workTool, ...(completeJourney ? [resultTool] : [])] };
    const turnLimit = completeJourney ? 6 : 3;
    const callLimit = completeJourney ? 8 : 3;
    const sealed = envelopes.sealAgentCapabilityUniverse({ sessionId: session.id, universeTools: agent.tools, activeToolNames: agent.tools.map(t => t.name), policyHash: 'native-plan-activation',
      budget: { maxUncachedTokens: 20_000, maxModelCalls: turnLimit, maxToolCalls: callLimit, maxElapsedMs: 60_000 } });
    assert.ok(sealed.ok); if (!sealed.ok) return;
    envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
    envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
    const runner = new EventEmitter();
    (runner as any).run = () => { throw new Error('SDK runner must not execute this host turn.'); };
    const outcome = await brackets.withHarnessRunContext({ ...activationIdentity, counter: new brackets.ToolCallsCounter(callLimit) },
      () => host.hostRunRunner(runner as never, agent as never, [{ type: 'message', role: 'user', content: acceptedPlanExecutionText(session.id, execute.seq)! }] as never,
        { maxTurns: turnLimit, hostTurnEngine: 'host_v1', hostJudgeCompletion: false, context: activationIdentity } as never));
    assert.equal(loadExpectedWorkContract(session.id, execute.seq).status, 'ok', JSON.stringify(outcome));
    const activationResult = outcome.history.find((item: any) => item.type === 'function_call_result' && item.callId === 'activate-native-synthesis');
    assert.match(JSON.stringify(activationResult), /\\"ok\\":true/);
    const settlement = eventlog.openEventLog().prepare('SELECT outcome_kind, physical_crossing_count FROM logical_call_settlements WHERE session_id=? AND source_user_seq=? AND logical_tool_call_id=?')
      .get(session.id, execute.seq, 'read-native-synthesis');
    if (retireBeforeRead) {
      assert.notEqual((settlement as any)?.outcome_kind, 'succeeded', 'do not replace a revoked reviewed identity with its unreviewed sibling');
      assert.equal((settlement as any)?.physical_crossing_count ?? 0, 0);
    } else {
      assert.deepEqual(settlement, { outcome_kind: 'succeeded', physical_crossing_count: 2 }, JSON.stringify(outcome.history));
      const binding = eventlog.openEventLog().prepare('SELECT capability_id FROM host_call_capability_bindings WHERE session_id=? AND source_user_seq=? AND logical_tool_call_id=?')
        .get(session.id, execute.seq, 'read-native-synthesis') as { capability_id: string };
      assert.equal(binding.capability_id, first.manifest.manifestId, 'the approved identity, not its other current transport, owns dispatch');
    }
    const frozen = (artifacts.getPlanRevision({ sessionId: session.id, principalId: session.id, ref }).structuredPlan as any);
    assert.deepEqual(frozen.steps.find((step: any) => step.id === 'save').dynamicBindings,
      [{ producerStepId: 'synthesize', outputPath: '/markdown', targetPath: '/content', expectedType: 'string' }]);
    assert.deepEqual(frozen.executionDraft.topology.operations.find((step: any) => step.id === 'save').dependsOn, completeJourney ? ['records', 'metrics'] : ['records']);
    assert.deepEqual(frozen.executionDraft.topology.operations.find((step: any) => step.id === 'save').dataFrom, []);
    if (completeJourney) {
      assert.equal(runtime.calls[0]?.args?.token, 'brief-token', 'the root must settle before either dependent read, regardless of model call order');
      assert.deepEqual(runtime.calls.map(call => call.args?.token).sort(), ['brief-token', 'metrics-token', 'reviewed-token']);
      const write = eventlog.openEventLog().prepare('SELECT outcome_kind FROM logical_call_settlements WHERE session_id=? AND source_user_seq=? AND logical_tool_call_id=?')
        .get(session.id, execute.seq, 'save-native-synthesis') as { outcome_kind?: string } | undefined;
      assert.equal(write?.outcome_kind, 'succeeded', JSON.stringify(outcome.history));
      assert.equal(readFileSync(outputPath, 'utf8'), content, JSON.stringify(outcome.history));
      assert.equal((outcome.history.find((item: any) => item.type === 'function_call' && item.callId === 'compose-native-synthesis') as any)?.arguments, modelSynthesisArgs, 'admission/history retain the original model bytes, including malformed string escapes');
      eventlog.closeEventLog();
      const terminal = (await import('./accepted-task-terminal-preparation.js')).prepareAcceptedTaskTerminal({ ...activationIdentity, proposedReply: 'The briefing is saved.' });
      assert.equal(terminal.status, 'ready', JSON.stringify(terminal));
      const { commitTurnOutcome } = await import('./delivery-committer.js');
      const { turnOutcomeId } = await import('./turn-outcome.js');
      const committed = commitTurnOutcome({ version: 2, id: turnOutcomeId(activationIdentity), identity: activationIdentity,
        status: 'done', resumable: false, presentation: { kind: 'answer', text: 'The briefing is saved.' } });
      assert.equal(committed.presentation.status, 'done', JSON.stringify(committed.presentation));
    }
  }
  assert.equal(runtime.counts.call, completeJourney ? 3 : effect === 'read' && !retireBeforeRead ? 1 : 0, 'only the exact current Execute reads reach the provider');
});

test('fresh MCP discovery reacquires a revoked definition without reviving its old plan identity', async () => {
  const runtime = generatedRuntime({ objective: generated('research') });
  const tool = (runtime.state.tools as ToolState[])[0]!;
  const { store, factory } = resetAuthoritySurfaces({ durable: true });
  const discover = () => mcp.createProductionMcpReadCarrier({ serverName: runtime.server, runtime: runtime.runtime })
    .materializeExact({ operationId: tool.name, inputSchema: tool.inputSchema });
  const first = await discover(); assert.equal(first.status, 'installed'); if (first.status !== 'installed') return;
  store.revoke(first.manifest.manifestId); factory.forget(first.manifest.manifestId);
  const fresh = await discover(); assert.equal(fresh.status, 'installed', JSON.stringify(fresh)); if (fresh.status !== 'installed') return;
  assert.notEqual(fresh.manifest.manifestId, first.manifest.manifestId);
  assert.equal(store.get(first.manifest.manifestId)?.manifest.lifecycle.state, 'revoked');
  const repeat = await discover(); assert.equal(repeat.status, 'installed');
  if (repeat.status === 'installed') assert.deepEqual(repeat.manifest, fresh.manifest);
  assert.equal(factory.get(first.manifest.manifestId), undefined);
});

test('concurrent exact MCP discoveries converge on one immutable current contract', async () => {
  const runtime = generatedRuntime({ objective: generated('research') });
  const tool = (runtime.state.tools as ToolState[])[0]!;
  const { store, factory } = resetAuthoritySurfaces();
  const results = await Promise.all(Array.from({ length: 3 }, () =>
    mcp.createProductionMcpReadCarrier({ serverName: runtime.server, runtime: runtime.runtime })
      .materializeExact({ operationId: tool.name, inputSchema: tool.inputSchema })));
  for (const result of results) assert.equal(result.status, 'installed', JSON.stringify(result));
  assert.equal(new Set(results.map(r => r.status === 'installed' ? manifests.capabilityManifestDigest(r.manifest) : '')).size, 1);
  assert.equal(factory.snapshot().length, 1);
  assert.equal(store.list().filter(r => r.manifest.lifecycle.state === 'current').length, 1);
});

test('production native MCP definitions drive provider-neutral read, ordinary-write, and approval decisions', async (t) => {
  const cases: Array<{
    name: string;
    annotations: Record<string, boolean>;
    inputSchema: Record<string, unknown>;
    args: Record<string, unknown>;
    expected: CapabilityRiskAttestationV1['risk'];
    decision: 'read' | 'ordinary' | 'approval';
  }> = [
    {
      name: 'list_records',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
      args: { query: 'current records' },
      expected: { reversibility: 'read_only', consequence: 'read', destructive: false },
      decision: 'read',
    },
    {
      name: 'create_record',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        type: 'object',
        properties: { body: { type: 'string' } },
        required: ['body'],
        additionalProperties: false,
      },
      args: { body: 'new record' },
      expected: {
        reversibility: 'ordinary_non_destructive', consequence: 'create', destructive: false,
      },
      decision: 'ordinary',
    },
    {
      name: 'update_record',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: 'object',
        properties: { recordId: { type: 'string' }, body: { type: 'string' } },
        required: ['recordId', 'body'],
        additionalProperties: false,
      },
      args: { recordId: 'record-1', body: 'updated record' },
      expected: {
        reversibility: 'ordinary_non_destructive', consequence: 'update', destructive: false,
      },
      decision: 'ordinary',
    },
    {
      name: 'send_message',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: 'object',
        properties: {
          body: { type: 'string' },
          sendNow: { type: 'boolean' },
        },
        required: ['body', 'sendNow'],
        additionalProperties: false,
      },
      args: { body: 'hello', sendNow: true },
      expected: { reversibility: 'irreversible', consequence: 'send', destructive: false },
      decision: 'approval',
    },
    {
      name: 'delete_record',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        type: 'object',
        properties: { recordId: { type: 'string' } },
        required: ['recordId'],
        additionalProperties: false,
      },
      args: { recordId: 'record-1' },
      expected: { reversibility: 'unknown', consequence: 'delete', destructive: true },
      decision: 'approval',
    },
  ];

  for (const caseInput of cases) {
    await t.test(caseInput.name, async () => {
      const server = generated('server').toLowerCase();
      const tool: ToolState = {
        name: `${server}__${caseInput.name}`,
        description: `Production-shaped ${caseInput.name} definition.`,
        inputSchema: caseInput.inputSchema,
        annotations: caseInput.annotations,
      };
      const runtime = generatedRuntime({
        server,
        objective: generated('objective').toLowerCase(),
        tools: [tool],
      });
      const { factory } = resetAuthoritySurfaces();
      const materialized = await mcp.createProductionMcpReadCarrier({
        serverName: server,
        runtime: runtime.runtime,
      }).materializeExact({
        operationId: tool.name,
        inputSchema: tool.inputSchema,
      });
      assert.equal(materialized.status, 'installed', JSON.stringify(materialized));
      if (materialized.status !== 'installed') return;

      const entry = factory.get(materialized.manifest.manifestId);
      assert.ok(entry);
      const { binding, identity } = exactExternalBinding(entry);
      assert.equal(
        materialized.manifest.externalDefinition?.providerInputSchemaDigest,
        externalRisk.canonicalExternalInputSchemaDigestV1(tool.inputSchema),
      );
      assert.deepEqual(materialized.manifest.externalDefinition?.behaviorHints, {
        readOnly: caseInput.annotations.readOnlyHint,
        destructive: caseInput.annotations.destructiveHint,
        idempotent: caseInput.annotations.idempotentHint,
        openWorld: caseInput.annotations.openWorldHint,
      });

      const signals = externalRisk.deriveExternalCapabilityCallSignalsV1({
        version: 1,
        inputSchema: tool.inputSchema,
        arguments: caseInput.args,
      });
      assert.equal(signals.status, 'projected', JSON.stringify(signals));
      if (signals.status !== 'projected') return;
      if (caseInput.name === 'send_message') {
        assert.equal(signals.resolution, 'affirmative');
        assert.equal(signals.callSignals.outboundDelivery, true);
      }

      const destination = {
        digest: digest(`${caseInput.name}-destination`),
        posture: materialized.manifest.destination?.posture ?? 'not_applicable',
      } as const;
      const loaded = externalRisk.loadCatalogManifestExternalRiskAttestationV1({
        version: 1,
        binding,
        inputSchema: tool.inputSchema,
        destination,
        callSignals: signals.callSignals,
        safety: 'admissible',
      });
      assert.equal(loaded.ok, true, JSON.stringify(loaded));
      if (!loaded.ok) return;
      assert.equal(loaded.attestation.currentDefinition.schemaDigest, binding.providerInputSchemaDigest);
      assert.deepEqual(loaded.attestation.projection.risk, caseInput.expected);

      const call: CapabilityRiskAttestationV1 = {
        version: 1,
        source: {
          kind: 'accepted_turn',
          id: generated('source'),
          digest: digest(generated('source-digest')),
        },
        acceptedTaskId: generated('accepted-task'),
        bindingDigest: digest(generated('binding')),
        logicalToolCallId: generated('logical-call'),
        operationId: identity.operationId,
        argumentDigest: digest(JSON.stringify(caseInput.args)),
        schemaFingerprint: identity.schemaDigest,
        effect: loaded.attestation.projection.effect,
        accountId: identity.account,
        destination,
        cardinality: { kind: 'once' },
        risk: { ...loaded.attestation.projection.risk },
        semanticBasis: { ...loaded.attestation.projection.semanticBasis },
        safety: loaded.attestation.projection.safety,
      };
      const coverage = exactCoverage(call);
      const decision = consent.evaluateInteractiveConsentV1({
        call,
        coverage: caseInput.decision === 'read' ? null : coverage,
        userGrant: null,
        readiness: { kind: 'ready' },
        crossing: 'not_started',
        reservationAlreadyClaimed: false,
      });
      if (caseInput.decision === 'read') {
        assert.equal(decision.kind, 'proceed');
        if (decision.kind === 'proceed') assert.equal(decision.basis, 'no_effect');
      } else if (caseInput.decision === 'ordinary') {
        assert.equal(decision.kind, 'proceed');
        if (decision.kind === 'proceed') assert.equal(decision.basis, 'exact_ordinary_work');
      } else {
        assert.equal(decision.kind, 'needs_user');
        if (decision.kind === 'needs_user') assert.equal(decision.need, 'approval');
        const grant = exactGrant(call);
        const approved = consent.evaluateInteractiveConsentV1({
          call,
          coverage,
          userGrant: grant,
          readiness: { kind: 'ready' },
          crossing: 'not_started',
          reservationAlreadyClaimed: false,
        });
        assert.equal(approved.kind, 'proceed');
        if (approved.kind === 'proceed') assert.equal(approved.basis, 'exact_user_grant');
      }
      assert.equal(runtime.counts.call, 0, 'risk and consent admission perform no provider mutation');
    });
  }
});

test('unknown declarations, contradictory hints, schema drift, and definition drift stay zero-I/O', async (t) => {
  const cases: Array<{
    name: string;
    annotations: unknown;
    expectedReason: mcp.ProductionMcpCapabilityMaterializationRefusal;
    disclosedSchema?: Record<string, unknown>;
    mutateOnSecondList?: boolean;
  }> = [
    { name: 'unknown_effect', annotations: undefined, expectedReason: 'unknown_effect' },
    {
      name: 'contradictory_hints',
      annotations: { readOnlyHint: true, destructiveHint: true },
      expectedReason: 'unknown_effect',
    },
    {
      name: 'schema_drift',
      annotations: { readOnlyHint: false, destructiveHint: false },
      expectedReason: 'schema_drift',
      disclosedSchema: {
        type: 'object',
        properties: { changed: { type: 'string' } },
        required: ['changed'],
        additionalProperties: false,
      },
    },
    {
      name: 'definition_drift',
      annotations: { readOnlyHint: false, destructiveHint: false },
      expectedReason: 'independent_observation_missing',
      mutateOnSecondList: true,
    },
  ];

  for (const caseInput of cases) {
    await t.test(caseInput.name, async () => {
      const server = generated('server').toLowerCase();
      const inputSchema = {
        type: 'object',
        properties: { body: { type: 'string' } },
        required: ['body'],
        additionalProperties: false,
      };
      const tool: ToolState = {
        name: `${server}__create_record`,
        inputSchema,
        ...(caseInput.annotations === undefined ? {} : { annotations: caseInput.annotations }),
      };
      const runtime = generatedRuntime({
        server,
        objective: generated('objective').toLowerCase(),
        tools: [tool],
      });
      if (caseInput.mutateOnSecondList) {
        runtime.state.onList = (count) => {
          if (count === 2) tool.annotations = {
            readOnlyHint: false,
            destructiveHint: true,
          };
        };
      }
      resetAuthoritySurfaces();
      const result = await mcp.createProductionMcpReadCarrier({
        serverName: server,
        runtime: runtime.runtime,
      }).materializeExact({
        operationId: tool.name,
        inputSchema: caseInput.disclosedSchema ?? inputSchema,
      });
      assert.equal(result.status, 'blocked', JSON.stringify(result));
      if (result.status === 'blocked') assert.equal(result.reason, caseInput.expectedReason);
      assert.equal(runtime.counts.call, 0, 'metadata disagreement never reaches MCP callTool');
      assert.equal(catalogs.peekHostCapabilityCatalogFactory()?.snapshot().length, 0);
    });
  }
});

for (const shape of ['sdk_array', 'envelope', 'structured', 'empty', 'success_text'] as const) {
  test(`native MCP ${shape} preserves provider repair details without treating text as authority`, async () => {
    const detail = 'Missing required argument: path. Use the documented endpoint path.';
    const blocks = [{ type: 'text', text: detail }];
    const rawResult = shape === 'sdk_array' ? Object.assign(blocks, { isError: true })
      : shape === 'envelope' ? { content: blocks, isError: true }
      : shape === 'structured' ? { content: [], structuredContent: { error: detail }, isError: true }
      : shape === 'empty' ? { content: [{ type: 'image', data: 'not-an-error-message' }], isError: true }
      : { content: [{ type: 'text', text: 'A document that discusses an error.' }], isError: false };
    const objective = generated('provider_error');
    const runtime = generatedRuntime({ objective, rawResult });
    const { factory } = resetAuthoritySurfaces();
    const installed = await mcp.createProductionMcpReadCarrier({ serverName: runtime.server, runtime: runtime.runtime }).materialize(`retrieve ${objective}`);
    assert.equal(installed.status, 'installed', JSON.stringify(installed));
    if (installed.status !== 'installed') return;
    const entry = factory.get(installed.manifest.manifestId)!;
    const plan = invocationPlan(entry); const armed = arm(plan, 'provider-error-detail');
    assert.equal(armed.status, 'armed', JSON.stringify(armed)); if (armed.status !== 'armed') return;
    const result = await kernel.executeWorkflowReadOnlyCall({ activationId: armed.ref.activationId, invocationPlan: plan, args: { token: 'fixture' } });
    assert.equal(runtime.counts.call, 1);
    if (shape === 'success_text') assert.equal(result.status, 'completed', JSON.stringify(result));
    else {
      assert.notEqual(result.status, 'completed');
      if (shape === 'empty') assert.match(JSON.stringify(result), /native MCP operation returned isError/);
      else assert.match(JSON.stringify(result), /Missing required argument: path/, 'the actual provider explanation reaches the caller');
    }
  });
}
