/**
 * Provider-neutral foreground discovery -> primary planning authority proof.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs \
 *     src/journeys/provider-neutral-live-read-planning.acceptance.test.ts
 *
 * The fixtures are real production carrier shapes: one explicitly reviewed
 * executable and one configured stdio MCP peer. Discovery may enumerate and
 * attest them, but this proof intentionally stops at an admitted graph binding
 * and asserts that neither business body ran.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-live-read-planning-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_AUTHORITY_SEAL_KEY = 'd3'.repeat(32);
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.COMPOSIO_API_KEY = '';
process.env.COMPOSIO_USER_ID = '';

mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-live-read-planning\n', 'utf8');

const reviewedCli = await import('../runtime/harness/reviewed-cli-read-config.js');
const providerSources = await import('../tools/tool-search-provider-sources.js');
const toolSearch = await import('../tools/tool-search-tool.js');
const semantic = await import('../runtime/semantic-boundary/admit-and-compile-accepted-source.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const manifestStores = await import('../runtime/harness/capability-manifest-store.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const capabilityIndex = await import('../memory/capability-index.js');
const mcpConfig = await import('../runtime/mcp-config.js');
const mcpServers = await import('../runtime/mcp-servers.js');
const topology = await import('../runtime/graph/work-topology.js');
const nodeCapabilities = await import('../runtime/harness/graph-node-capability.js');
const attemptIdentity = await import('../runtime/harness/attempt-identity.js');
const manifests = await import('../runtime/harness/capability-manifest.js');
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');

const nonce = randomBytes(7).toString('hex');
const cliExecutable = path.join(HOME, `reviewed-cli-${nonce}`);
const cliBusinessCounter = path.join(HOME, `reviewed-cli-business-${nonce}`);
const cliOperation = `reviewed_cli_constellation_read_${nonce}`;
const cliField = `query_${nonce}`;
const ambiguousObjective = `inspect ambiguous nebula ${nonce}`;
const ambiguousOperations = [
  `reviewed_cli_ambiguous_a_${nonce}`,
  `reviewed_cli_ambiguous_b_${nonce}`,
] as const;

const mcpServerName = `generated_mcp_${nonce}`;
const mcpToolName = `read_records_${nonce}`;
const mcpOperation = `${mcpServerName}__${mcpToolName}`;
const mcpField = `filter_${nonce}`;
const mcpStartupCounter = path.join(HOME, `mcp-startup-${nonce}`);
const mcpListCounter = path.join(HOME, `mcp-list-${nonce}`);
const mcpBusinessCounter = path.join(HOME, `mcp-business-${nonce}`);

const GENERATED_MCP_PEER = String.raw`
const fs = require('node:fs');
const bump = (file) => { if (file) fs.appendFileSync(file, '1\n'); };
bump(process.env.LR_STARTUP_COUNTER);
let pending = '';
const send = (id, result, error) => {
  process.stdout.write(JSON.stringify(error
    ? { jsonrpc: '2.0', id, error }
    : { jsonrpc: '2.0', id, result }) + '\n');
};
const handle = (request) => {
  if (request.method === 'notifications/initialized') return;
  if (request.id === undefined || request.id === null) return;
  if (request.method === 'initialize') {
    send(request.id, {
      protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: process.env.LR_SERVER_NAME, version: '1' },
    });
    return;
  }
  if (request.method === 'ping') { send(request.id, {}); return; }
  if (request.method === 'tools/list') {
    bump(process.env.LR_LIST_COUNTER);
    send(request.id, { tools: [{
      name: process.env.LR_TOOL_NAME,
      description: 'Read generated records from the exact configured peer.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: [process.env.LR_FIELD],
        properties: { [process.env.LR_FIELD]: { type: 'string' } },
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    }] });
    return;
  }
  if (request.method === 'tools/call') {
    bump(process.env.LR_BUSINESS_COUNTER);
    send(request.id, {
      content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
      structuredContent: { ok: true },
      isError: false,
    });
    return;
  }
  send(request.id, undefined, { code: -32601, message: 'method not found' });
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  for (;;) {
    const newline = pending.indexOf('\n');
    if (newline < 0) break;
    const line = pending.slice(0, newline).trim();
    pending = pending.slice(newline + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); }
    catch (error) { process.stderr.write(String(error?.stack ?? error) + '\n'); }
  }
});
`;

type Scope = import('../runtime/mcp-tool-scope.js').McpToolScope;
type Planning = Extract<
  Awaited<ReturnType<typeof semantic.primePrimaryModelPlanningCatalog>>,
  { ok: true }
>['planning'];

function countLines(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  return readFileSync(filePath, 'utf8').split('\n').filter(Boolean).length;
}

function resetAuthoritySurfaces(): void {
  eventlog.resetEventLog();
  manifestStores.installCapabilityManifestStore(
    manifestStores.createCapabilityManifestStore([], { durable: false }),
  );
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  ports.clearProductionCapabilityPorts();
  observations.clearIndependentCapabilityObservations();
  capabilityIndex._resetCapabilityIndexForTest();
}

async function createPlanning(label: string, objective: string): Promise<{
  identity: { sessionId: string; sourceUserSeq: number; turn: number };
  planning: Planning;
}> {
  const session = eventlog.createSession({ id: `live-read-${label}-${nonce}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: objective },
  });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) throw new Error(primed.reason);
  return { identity, planning: primed.planning };
}

function liveReadSource(scope: Scope, identity: { sessionId: string; sourceUserSeq: number }) {
  const sources = providerSources.buildAuthorizedToolSearchCandidateSources(scope, identity);
  assert.deepEqual(
    sources.map((source) => source.kind),
    ['authorized_live_read_registry', 'authorized_composio'],
    'planning callers mount one registry path and never the legacy MCP fallback',
  );
  const source = sources.find((candidate) => candidate.kind === 'authorized_live_read_registry');
  assert.ok(source);
  return { source: source!, sources };
}

async function ordinaryPlanningSearch(input: {
  objective: string;
  scope: Scope;
  identity: { sessionId: string; sourceUserSeq: number };
  planning: Planning;
}) {
  const { sources } = liveReadSource(input.scope, input.identity);
  const server = new McpServer({ name: `live-read-search-${nonce}`, version: '1' });
  toolSearch.registerToolSearchTool(server as never, {
    candidateSources: sources,
    dispatchCarrier: 'work_call',
    discloseForPlanning: async (candidates, control) => {
      const staged = await providerSources.stageDisclosedPlanningProviderCandidates({
        sessionId: input.identity.sessionId,
        sourceUserSeq: input.identity.sourceUserSeq,
        candidates,
        signal: control?.signal,
        deadlineAt: control?.deadlineAt,
      });
      const refs = await semantic.disclosePrimaryModelPlanningCapabilities({
        authority: input.planning.authority,
        candidates,
        signal: control?.signal,
        deadlineAt: control?.deadlineAt,
      });
      return { version: 1 as const, refs, blockers: staged.blockers };
    },
  });
  const handler = (server as never as {
    _registeredTools: Record<string, {
      handler(input: Record<string, unknown>): Promise<{ content: Array<{ text: string }> }>;
    }>;
  })._registeredTools.tool_search.handler;
  const result = await handler({
    query: input.objective,
    role_key: 'clause-0:read',
    limit: 8,
    cursor: null,
  });
  const raw = result.content[0]!.text;
  assert.doesNotMatch(raw, /planningAuthority|authorized_live_read_planning_v1/,
    'the process-only source token leaked into model-visible JSON');
  return JSON.parse(raw) as {
    brokerCoverage: string;
    hint: string;
    unavailable?: Array<{ source: string; code: string; reason: string }>;
    results: Array<{
      name: string;
      capabilityRef?: string;
      planningProvenance?: string;
      planningRefStatus?: string;
    }>;
  };
}

function readProposal(input: { objective: string; capabilityRef: string; operationId: string }) {
  const workTopology = {
    version: 1 as const,
    operations: [{
      id: input.operationId,
      effect: 'read' as const,
      coverage: 'single' as const,
      dependsOn: [],
      dataFrom: [],
      cardinality: { kind: 'once' as const },
    }],
    universes: [],
  };
  return {
    version: 1 as const,
    relation: 'new_goal' as const,
    targetGoal: null,
    goal: {
      objective: input.objective,
      criteria: [{ id: 'criterion_1', statement: 'The exact current read result is returned.' }],
      openSlots: [],
      candidates: [{ kind: 'capability' as const, id: input.capabilityRef }],
    },
    work: {
      construct: 'single_act' as const,
      cardinality: null,
      destinations: null,
      destination: null,
      requestedEffect: 'read' as const,
      topology: workTopology,
      topologyHash: topology.workTopologyDigest(workTopology),
      operations: [{
        id: input.operationId,
        role: 'source',
        requestedEffect: 'read' as const,
        capabilityRef: input.capabilityRef,
        dependsOn: [],
        evidence: ['tool_result'],
      }],
      deliverables: [{ id: 'read_evidence', kind: 'evidence' }],
      evidenceRequirements: ['tool_result'],
    },
    slotAnswers: [],
    rationale: 'Use the exact live read capability disclosed by ordinary tool_search.',
  };
}

async function citeAdmitAndBind(input: {
  label: string;
  objective: string;
  operationName: string;
  scope: Scope;
  providerKind: 'reviewed_cli' | 'native_mcp';
}) {
  const run = await createPlanning(input.label, input.objective);
  const body = await ordinaryPlanningSearch({
    objective: input.objective,
    scope: input.scope,
    identity: run.identity,
    planning: run.planning,
  });
  assert.equal(body.brokerCoverage, 'authorized_external_v1');
  const row = body.results.find((candidate) => candidate.name === input.operationName);
  assert.ok(row, JSON.stringify({
    names: body.results.map((candidate) => candidate.name),
    hint: body.hint,
    unavailable: body.unavailable,
  }));
  assert.match(row?.capabilityRef ?? '', /^cap:live:/);
  assert.equal(row?.planningProvenance, 'authorized_live_read_registry');
  assert.equal(row?.planningRefStatus, undefined);

  const operationId = `read_${input.label}_${nonce}`;
  const admitted = await semantic.admitAndCompilePrimaryModelProposal({
    identity: run.identity,
    surface: 'direct',
    proposal: readProposal({
      objective: input.objective,
      capabilityRef: row!.capabilityRef!,
      operationId,
    }),
    planningCatalogAuthority: run.planning.authority,
  });
  assert.equal(admitted.ok, true, admitted.ok ? '' : admitted.reason);
  if (!admitted.ok) throw new Error(admitted.reason);
  const graph = admitted.compiled.graph;
  const node = graph.nodes.find((candidate) => candidate.operationId === operationId);
  assert.ok(node);
  assert.ok(node?.kind === 'retrieve' || node?.kind === 'execute', node?.kind);
  assert.deepEqual(node?.capabilities, [{
    kind: 'tool',
    resolution: 'explicit',
    names: [row!.capabilityRef!],
  }]);

  const frozen = catalogs.peekCatalogSnapshotForSource(run.identity);
  assert.equal(frozen.ok, true, frozen.ok ? '' : frozen.reason);
  if (!frozen.ok) throw new Error(frozen.reason);
  const bound = nodeCapabilities.bindAdmittedNodeCapability({
    node: node!,
    graph,
    identity: {
      sessionId: run.identity.sessionId,
      sourceUserSeq: run.identity.sourceUserSeq,
      acceptedTaskId: attemptIdentity.acceptedTaskIdFor(
        run.identity.sessionId,
        run.identity.sourceUserSeq,
      ),
    },
    acceptedText: input.objective,
    catalog: frozen.catalog,
  });
  assert.equal(bound.ok, true, bound.ok ? '' : bound.reason);
  if (!bound.ok) throw new Error(bound.reason);
  assert.equal(bound.binding.capabilityId, row!.capabilityRef);
  assert.equal(bound.binding.toolName, input.operationName);
  assert.equal(bound.binding.effect, 'read');
  assert.equal(bound.binding.providerKind, input.providerKind);
  assert.equal(bound.binding.manifest?.providerKind, input.providerKind);
  assert.equal(
    bound.binding.manifestDigest,
    manifests.capabilityManifestDigest(bound.binding.manifest!),
  );
  assert.equal(typeof bound.binding.invoke, 'function');
  return { run, row, bound };
}

test.after(async () => {
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  ports.clearProductionCapabilityPorts();
  observations.clearIndependentCapabilityObservations();
  capabilityIndex._resetCapabilityIndexForTest();
  await mcpServers.invalidateConfiguredMcpServers();
  mcpConfig.invalidateMcpServerDiscoveryCache();
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

test('real reviewed CLI and native MCP enter planning only through the provider-neutral live-read registry', {
  timeout: 120_000,
}, async () => {
  writeFileSync(cliExecutable, [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(cliBusinessCounter)}, '1\\n');`,
    "process.stdout.write(JSON.stringify({ ok: true }) + '\\n');",
  ].join('\n'), 'utf8');
  chmodSync(cliExecutable, 0o700);

  const provision = (descriptorId: string, operationId: string, description: string) => (
    reviewedCli.provisionReviewedCliReadDescriptor({
      version: 1,
      descriptorId,
      operationId,
      displayName: description,
      description,
      effect: 'read',
      accountId: 'reviewed_cli:host',
      executablePath: cliExecutable,
      argvPrefix: [`subcommand-${nonce}`],
      arguments: [{
        name: cliField,
        kind: 'option',
        token: `--${cliField}`,
        valueType: 'string',
        required: true,
      }],
      limits: {
        timeoutMs: 2_000,
        maxStdoutBytes: 16_384,
        maxStderrBytes: 4_096,
        maxArgumentBytes: 4_096,
      },
    })
  );
  await provision(`descriptor-primary-${nonce}`, cliOperation, `Read reviewed CLI facts ${nonce}`);
  await provision(`descriptor-ambiguous-a-${nonce}`, ambiguousOperations[0], ambiguousObjective);
  await provision(`descriptor-ambiguous-b-${nonce}`, ambiguousOperations[1], ambiguousObjective);

  const mcpDir = path.join(HOME, 'mcp');
  mkdirSync(mcpDir, { recursive: true });
  writeFileSync(path.join(mcpDir, 'servers.json'), JSON.stringify({
    [mcpServerName]: {
      type: 'stdio',
      command: process.execPath,
      args: ['-e', GENERATED_MCP_PEER],
      env: {
        LR_SERVER_NAME: mcpServerName,
        LR_TOOL_NAME: mcpToolName,
        LR_FIELD: mcpField,
        LR_STARTUP_COUNTER: mcpStartupCounter,
        LR_LIST_COUNTER: mcpListCounter,
        LR_BUSINESS_COUNTER: mcpBusinessCounter,
      },
      description: `Generated native MCP read ${nonce}`,
      enabled: true,
    },
  }), 'utf8');
  mcpConfig.invalidateMcpServerDiscoveryCache();
  await mcpServers.invalidateConfiguredMcpServers();

  // Scope exclusion happens before MCP enumeration. The reviewed CLI adapter
  // still exists, but cannot match this exact MCP operation.
  resetAuthoritySurfaces();
  const deniedRun = await createPlanning('mcp-scope-denied', mcpOperation);
  const denied = liveReadSource({
    reason: 'explicitly denied external connectors',
    authority: 'none',
    allowedServerSlugs: [],
    allowedToolNames: [],
    maxTools: 0,
  }, deniedRun.identity);
  assert.deepEqual(await denied.source.search({ query: mcpOperation, limit: 8 }), []);
  assert.equal(countLines(mcpStartupCounter), 0, 'scope-denied MCP discovery started its transport');
  assert.deepEqual(manifestStores.peekCapabilityManifestStore()?.list(), []);
  assert.deepEqual(catalogs.peekHostCapabilityCatalogFactory()?.snapshot(), []);

  // The same none scope applies only to MCP. A generic reviewed CLI remains
  // discoverable, citable, and bindable without a provider-name exception.
  resetAuthoritySurfaces();
  await citeAdmitAndBind({
    label: 'reviewed-cli-positive',
    objective: cliOperation,
    operationName: cliOperation,
    scope: {
      reason: 'no MCP authority is needed for a reviewed host CLI read',
      authority: 'none',
      allowedServerSlugs: [],
      maxTools: 0,
    },
    providerKind: 'reviewed_cli',
  });
  assert.equal(countLines(cliBusinessCounter), 0, 'planning invoked the reviewed CLI body');
  assert.equal(countLines(mcpStartupCounter), 0, 'reviewed CLI discovery inherited MCP transport access');

  resetAuthoritySurfaces();
  await citeAdmitAndBind({
    label: 'native-mcp-positive',
    objective: mcpOperation,
    operationName: mcpOperation,
    scope: {
      reason: 'the accepted turn selected one configured MCP server',
      authority: 'server_set',
      allowedServerSlugs: [mcpServerName],
      maxTools: 8,
    },
    providerKind: 'native_mcp',
  });
  assert.ok(countLines(mcpStartupCounter) >= 1, 'the real stdio MCP carrier was never opened');
  assert.ok(countLines(mcpListCounter) >= 1, 'the real stdio MCP definition was never observed');
  assert.equal(countLines(mcpBusinessCounter), 0, 'planning invoked the MCP business operation');
  assert.equal(countLines(cliBusinessCounter), 0, 'planning invoked the reviewed CLI body');
  await mcpServers.invalidateConfiguredMcpServers();
  mcpConfig.invalidateMcpServerDiscoveryCache();

  // Tokens are source-bound, process-opaque nominations. Current host state,
  // not candidate JSON, decides whether disclosure can mint a ref.
  resetAuthoritySurfaces();
  const tokenRun = await createPlanning('token-source', cliOperation);
  const tokenSource = liveReadSource({
    reason: 'reviewed CLI token proof',
    authority: 'none',
    allowedServerSlugs: [],
    maxTools: 0,
  }, tokenRun.identity).source;
  const candidates = await tokenSource.search({ query: cliOperation, limit: 8 });
  assert.equal(candidates.length, 1, JSON.stringify(candidates));
  const candidate = candidates[0]!;
  assert.equal(candidate.name, cliOperation);
  assert.ok(candidate.planningAuthority);
  const disclosureCandidate = {
    ...candidate,
    sourceKind: 'authorized_live_read_registry' as const,
  };

  const otherRun = await createPlanning('other-source', cliOperation);
  assert.deepEqual(await semantic.disclosePrimaryModelPlanningCapabilities({
    authority: otherRun.planning.authority,
    candidates: [disclosureCandidate],
  }), {}, 'one accepted source consumed another source\'s token');

  // Reacquiring an unchanged definition reuses its current manifest while the
  // final schema observation advances. The newer same-definition observation
  // remains citable only through a newly issued token for this exact source.
  const otherSource = liveReadSource({
    reason: 'same-definition reacquisition proof',
    authority: 'none',
    allowedServerSlugs: [],
    maxTools: 0,
  }, otherRun.identity).source;
  const reacquired = await otherSource.search({ query: cliOperation, limit: 8 });
  assert.equal(reacquired.length, 1, JSON.stringify(reacquired));
  const reacquiredRefs = await semantic.disclosePrimaryModelPlanningCapabilities({
    authority: otherRun.planning.authority,
    candidates: [{
      ...reacquired[0]!,
      sourceKind: 'authorized_live_read_registry',
    }],
  });
  assert.match(reacquiredRefs[cliOperation] ?? '', /^cap:live:/,
    'an unchanged reacquisition with a newer provider observation lost its current manifest');

  const forged = {
    ...disclosureCandidate,
    planningAuthority: Object.freeze({ scope: 'authorized_live_read_planning_v1' as const }),
  };
  assert.deepEqual(await semantic.disclosePrimaryModelPlanningCapabilities({
    authority: tokenRun.planning.authority,
    candidates: [forged],
  }), {}, 'shape-identical candidate JSON manufactured planning authority');

  const installed = manifestStores.peekCapabilityManifestStore()?.list()
    .filter((entry) => entry.manifest.lifecycle.state === 'current') ?? [];
  assert.equal(installed.length, 1);
  assert.equal(
    manifestStores.peekCapabilityManifestStore()?.revoke(installed[0]!.manifest.manifestId),
    true,
  );
  assert.deepEqual(await semantic.disclosePrimaryModelPlanningCapabilities({
    authority: tokenRun.planning.authority,
    candidates: [disclosureCandidate],
  }), {}, 'a stale source token survived current manifest revalidation');

  // Two genuine reviewed definitions matching one objective are ambiguity,
  // not list-order selection. No capability or body is published.
  resetAuthoritySurfaces();
  const ambiguousRun = await createPlanning('ambiguous', ambiguousObjective);
  const ambiguousSource = liveReadSource({
    reason: 'reviewed CLI ambiguity proof',
    authority: 'none',
    allowedServerSlugs: [],
    maxTools: 0,
  }, ambiguousRun.identity).source;
  assert.deepEqual(await ambiguousSource.search({ query: ambiguousObjective, limit: 8 }), []);
  assert.deepEqual(manifestStores.peekCapabilityManifestStore()?.list(), []);
  assert.deepEqual(catalogs.peekHostCapabilityCatalogFactory()?.snapshot(), []);
  assert.equal(countLines(cliBusinessCounter), 0);
  assert.equal(countLines(mcpBusinessCounter), 0);
});
