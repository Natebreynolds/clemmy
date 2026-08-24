/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/production-mcp-read-carrier.test.ts */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
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
const manifestStores = await import('./capability-manifest-store.js');
const ports = await import('./production-capability-ports.js');
const observations = await import('./independent-capability-observation.js');
const authority = await import('./accepted-turn-call-authority.js');
const plans = await import('../../memory/workflow-node-invocation-plan.js');
const kernel = await import('./workflow-read-only-call-kernel.js');
const mcp = await import('./production-mcp-read-carrier.js');
const externalRisk = await import('./external-capability-risk-loader.js');
const consent = await import('./interactive-consent-policy.js');

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
      const result = [{ type: 'text', text: JSON.stringify({ accepted: true, name, args }) }] as unknown as Awaited<ReturnType<MCPServer['callTool']>>;
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

test('empty home uses live listTools only, installs exact authority, and crosses the shared workflow kernel once', async () => {
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
  assert.match(installed.manifest.providerVersion, /^mcp-catalog-v1:/);
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

  const entry = factory.get(installed.manifest.manifestId);
  assert.ok(entry);
  const plan = invocationPlan(entry);
  const armed = arm(plan, 'blank');
  assert.equal(armed.status, 'armed', JSON.stringify(armed));
  if (armed.status !== 'armed') return;
  const executed = await kernel.executeWorkflowReadOnlyCall({
    activationId: armed.ref.activationId,
    invocationPlan: plan,
    args: { token: generated('input') },
  });
  assert.equal(executed.status, 'completed', JSON.stringify(executed));
  assert.equal(generatedMcp.counts.call, 1);
  assert.equal(generatedMcp.calls[0]!.name, installed.manifest.operationId);
  assert.equal(generatedMcp.counts.list, 4, 'enumerate, refresh, independent refresh, and crossing each re-list');

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
  assert.deepEqual(counts, { logical_n: 1, physical_n: 1, settlement_n: 1 });

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
      const result = await kernel.executeWorkflowReadOnlyCall({
        activationId: armed.ref.activationId,
        invocationPlan: plan,
        args: { token: generated('input') },
      });
      assert.equal(result.status, 'failed', JSON.stringify(result));
      assert.equal(runtime.counts.call, 0, 'last-edge list detects drift before tools/call');
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
