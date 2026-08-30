/**
 * Run:
 *   node scripts/run-tests-isolated.mjs \
 *     src/journeys/balanced-user-stops-ordinary-channel.acceptance.test.ts
 *
 * NEXT-TAG row 12. Every case enters through the exported accepted-channel
 * runner, shared foreground bridge, primary model, host planner/call carrier,
 * consent reducer, and durable terminal records. Stop classification below is
 * derived only from typed rows/events; assistant prose is never an oracle.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-balanced-user-stops-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.AUTH_MODE = 'codex_oauth';
process.env.MODEL_ROUTING_MODE = 'off';
process.env.OPENAI_MODEL_PRIMARY = 'gpt-5.5';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_CODEX_TOOL_SEARCH = 'on';
process.env.CLEMMY_TOOL_JIT = 'on';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_SEMANTIC_RECALL = 'off';
process.env.CLEMMY_DEBATE_MODE = 'off';
process.env.CLEMMY_BRAIN_FALLOVER = 'off';
process.env.CLEMMY_AUTH_FALLOVER = 'off';
process.env.CLEMMY_PLAN_FIRST = 'off';
process.env.CLEMMY_DYNAMIC_REASONING = 'off';
process.env.CLEMMY_EVAL_AUTO_PROMOTE = 'off';
process.env.COMPOSIO_API_KEY = 'fixture-balanced-user-stops-key';

mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-balanced-user-stops\n');
writeFileSync(path.join(HOME, 'state', 'auth.json'), JSON.stringify({
  source: 'native',
  codexOauth: {
    accessToken: 'fixture-access',
    refreshToken: 'fixture-refresh',
    lastRefresh: new Date().toISOString(),
  },
}));
writeFileSync(path.join(HOME, 'state', 'proactivity-policy.json'), JSON.stringify({
  autoApproveScope: 'strict',
}));

const discord = await import('../channels/discord-harness.js');
const bridge = await import('../runtime/harness/respond-bridge.js');
const runtimeConfig = await import('../runtime/harness/codex-client.js');
const { buildOrchestratorAgent } = await import('../agents/orchestrator.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const manifests = await import('../runtime/harness/capability-manifest.js');
const manifestStores = await import('../runtime/harness/capability-manifest-store.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const productionAdapters = await import('../runtime/harness/production-capability-adapter.js');
const productionPorts = await import('../runtime/harness/production-capability-ports.js');
const productionTransport = await import('../runtime/harness/production-capability-adapters.js');
const independentObservations = await import('../runtime/harness/independent-capability-observation.js');
const externalRisk = await import('../runtime/harness/external-capability-risk-loader.js');
const innerDispatch = await import('../tools/inner-dispatch.js');
const composioSchemas = await import('../tools/composio-schema-cache.js');
const composioClient = await import('../integrations/composio/client.js');
const composioProviderIdentity = await import('../integrations/composio/provider-definition-identity.js');

composioClient.__test__.setComposioApiKeyOverride('fixture-balanced-user-stops-key');

type Manifest = import('../runtime/harness/capability-manifest.js').CapabilityManifestV1;

const INPUT_SCHEMAS = Object.freeze({
  read: Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: { query: { type: 'string' } },
  }),
  create: Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['tab_name', 'records'],
    properties: {
      tab_name: { type: 'string' },
      records: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['item', 'state'],
          properties: { item: { type: 'string' }, state: { type: 'string' } },
        },
      },
    },
  }),
  irreversible: Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['payload'],
    properties: { payload: { type: 'string' } },
  }),
  uncertain: Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['tab_name', 'records'],
    properties: {
      tab_name: { type: 'string' },
      records: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['item', 'state'],
          properties: { item: { type: 'string' }, state: { type: 'string' } },
        },
      },
    },
  }),
});

const ATOMIC_CONTENT = Object.freeze({
  version: 1 as const,
  compiler: Object.freeze({
    version: 1 as const,
    kind: 'tabular_record_set_v1' as const,
    namePointer: '/tab_name',
    recordsPointer: '/records',
    recordsEncoding: 'json_or_value' as const,
    selector: 'a1_grid_v1' as const,
  }),
  resultIdentity: Object.freeze({
    version: 1 as const,
    kind: 'pointer_resource_identity_v1' as const,
    idPointers: Object.freeze(['/resource_id']),
    handlePointers: Object.freeze(['/resource_url']),
    handleTemplate: Object.freeze({
      version: 1 as const,
      kind: 'prefix_suffix_v1' as const,
      prefix: 'https://example.invalid/resources/',
      suffix: '',
    }),
  }),
  evidence: Object.freeze(['receipt', 'content_commit'] as const),
});

const schemaDigest = (schema: unknown): string => {
  const value = externalRisk.canonicalExternalInputSchemaDigestV1(schema);
  assert.ok(value);
  return value;
};

function generatedToken(seed: number): string {
  const alphabet = 'QZXJKVBP';
  return Array.from({ length: 7 }, (_, index) =>
    alphabet[(seed * 3 + index * 5) % alphabet.length]).join('');
}

interface CapabilityFixture {
  key: 'read' | 'create' | 'irreversible' | 'uncertain';
  manifest: Manifest;
  schema: Readonly<Record<string, unknown>>;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
}

function fixtureCapability(
  key: CapabilityFixture['key'],
  seed: number,
): CapabilityFixture {
  const provider = generatedToken(700);
  const operationWord = generatedToken(seed);
  const operationId = `${provider}_${operationWord}`;
  const schema = INPUT_SCHEMAS[key];
  const accountId = `account:${provider.toLowerCase()}`;
  const invokePortId = `port:${operationId}:invoke`;
  const definitionFingerprint = composioProviderIdentity.fingerprintComposioProviderDefinition({
    operationId,
    operationVersion: '1',
    accountId,
    invokePortId,
    inputSchema: schema,
    outputSchema: null,
  });
  assert.ok(definitionFingerprint);
  const write = key !== 'read';
  const family = `family:${generatedToken(seed + 30).toLowerCase()}`;
  const manifest = manifests.attachSemanticContract({
    version: 1,
    manifestId: `cap:${generatedToken(seed + 60).toLowerCase()}:${seed}`,
    providerKind: 'composio',
    operationId,
    providerIdentity: 'composio',
    providerVersion: composioProviderIdentity.COMPOSIO_PROVIDER_SURFACE_VERSION,
    operationVersion: '1',
    definitionFingerprint,
    externalDefinition: {
      version: 1,
      providerInputSchemaDigest: schemaDigest(schema),
      providerOutputSchemaObserved: true,
      semanticName: operationId,
      behaviorHints: {
        readOnly: !write,
        destructive: false,
        idempotent: true,
        openWorld: false,
      },
    },
    effect: write ? 'external_write' : 'read',
    ...(key === 'create' || key === 'uncertain'
      ? {
          operationSemantics: {
            version: 1 as const,
            reversibility: 'reversible' as const,
            atomicInputContent: ATOMIC_CONTENT,
          },
        }
      : key === 'irreversible'
        ? { operationSemantics: { version: 1 as const, reversibility: 'irreversible' as const } }
        : {}),
    ...(write ? { destination: { family, posture: 'create_new' } } : {}),
    accountId,
    idempotency: { required: write, policy: write ? 'key_before_dispatch' : 'none' },
    reconciliation: { supported: write, policy: write ? 'exact_artifact' : 'none' },
    outputContract: { kind: write ? 'created_resource' : 'records' },
    purpose: write ? 'persist_collection' : 'collect_records',
    acceptedInputKinds: write ? ['records'] : ['query'],
    producedOutputKinds: write ? ['created_resource'] : ['records'],
    applicableDeliverableKinds: write ? [family] : ['records'],
    evidenceContract: key === 'create' || key === 'uncertain'
      ? { kinds: ['receipt', 'content_commit'], readbackRequired: false }
      : { kinds: [write ? 'receipt' : 'records'], readbackRequired: false },
    provenance: {
      issuer: 'journey:balanced-user-stops-current-provider',
      issuedAt: '2026-08-27T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    advisoryRoles: write ? ['destination', 'create'] : ['source', 'collection'],
    argumentCompiler: { id: 'journey:closed-json-arguments', version: '1' },
    invokePortId,
    ...(write ? { reconcilePortId: `port:${operationId}:reconcile` } : {}),
  });
  if (key === 'create' || key === 'uncertain') {
    assert.deepEqual(externalRisk.deriveExternalCapabilityCallSignalsV1({
      version: 1,
      inputSchema: schema,
      arguments: { tab_name: 'Accepted rows', records: [{ item: 'alpha', state: 'ready' }] },
    }), {
      status: 'projected',
      resolution: 'not_exposed',
      callSignals: { outboundDelivery: null },
    });
  }
  return {
    key,
    manifest,
    schema,
    args: key === 'read'
      ? { query: 'accepted records' }
      : key === 'create' || key === 'uncertain'
        ? { tab_name: 'Accepted rows', records: [{ item: 'alpha', state: 'ready' }] }
        : { payload: 'publish accepted payload' },
    result: key === 'read'
      ? { records: [{ item: 'alpha', state: 'ready' }], total: 1, has_more: false }
      : key === 'create'
        ? {
            successful: true,
            resource_id: 'generated-resource-1',
            resource_url: 'https://example.invalid/resources/generated-resource-1',
          }
        : { successful: true, delivered: true },
  };
}

const CAPABILITIES = [
  fixtureCapability('read', 11),
  fixtureCapability('create', 12),
  fixtureCapability('irreversible', 13),
  fixtureCapability('uncertain', 14),
] as const;

interface FunctionTool {
  type: 'function';
  name: string;
  description: string;
  strict: boolean;
  parameters: Readonly<Record<string, unknown>>;
  needsApproval: () => Promise<boolean>;
  invoke: (_context: unknown, raw: string) => Promise<unknown>;
}

const bodyCounts = new Map<string, number>();

function installCapabilities(order: readonly CapabilityFixture[]): void {
  const store = manifestStores.createCapabilityManifestStore(order.map((entry) => entry.manifest));
  const factory = catalogs.createHostCapabilityCatalogFactory();
  productionPorts.clearProductionCapabilityPorts();
  const tools = new Map<string, FunctionTool>();
  const observedAt = Date.now();
  const connectedManifest = order.find((entry) => entry.key === 'read')!.manifest;
  composioClient.__test__.setConnectedAccountsLoader(async () => active?.kind === 'credential' ? [] : [{
    id: connectedManifest.accountId,
    status: 'ACTIVE',
    user_id: 'balanced-user-stops-user',
    toolkit: { slug: connectedManifest.operationId.split('_')[0]!.toLowerCase() },
  }]);
  composioSchemas._setToolSchemaLoaderForTests(async (identifier) => {
    const fixture = order.find((candidate) => candidate.manifest.operationId === identifier);
    return fixture
      ? {
          inputParameters: fixture.schema,
          outputParameters: null,
          providerObservedAt: Date.now(),
          providerOperationVersion: fixture.manifest.operationVersion,
        }
      : null;
  });
  for (const fixture of order) {
    const manifest = fixture.manifest;
    const observe = () => ({
      operationId: manifest.operationId,
      accountId: manifest.accountId,
      definitionFingerprint: manifest.definitionFingerprint,
      providerVersion: manifest.providerVersion,
      operationVersion: manifest.operationVersion,
      observedAt: Date.now(),
    });
    const directInvoke = async () => {
      throw new Error('direct catalog port is not the ordinary work_call carrier');
    };
    const reconcile = async () => ({ exists: false });
    composioSchemas.rememberToolSchema(
      manifest.operationId,
      fixture.schema,
      observedAt,
      manifest.operationVersion,
      null,
    );
    const sourceSchemaFingerprint = composioSchemas.liveComposioSchemaFingerprint(
      manifest.operationId,
    );
    assert.ok(sourceSchemaFingerprint);
    factory.register({
      capabilityId: manifest.manifestId,
      toolName: manifest.operationId,
      schemaVersion: manifest.operationVersion,
      schemaDigest: manifest.definitionFingerprint,
      effect: manifest.effect,
      ...(manifest.destination ? { destination: manifest.destination } : {}),
      account: manifest.accountId,
      advisoryRoles: manifest.advisoryRoles,
      manifestDigest: manifests.capabilityManifestDigest(manifest),
      providerKind: manifest.providerKind,
      sourceSchemaFingerprint,
      providerInputSchemaDigest: schemaDigest(fixture.schema),
      liveFingerprint: manifest.definitionFingerprint,
      manifest,
      invoke: directInvoke,
      ...(fixture.key === 'read' ? {} : { reconcile }),
    });
    assert.deepEqual(productionPorts.registerFixtureCapabilityPort(
      productionPorts.productionPortIdentityFromManifest(manifest),
      {
        observe: () => observe(),
        invoke: directInvoke,
        ...(fixture.key === 'read' ? {} : { reconcile }),
      },
    ), { ok: true });
    assert.deepEqual(independentObservations.registerIndependentCapabilityObservation({
      ...observe(),
      origin: 'independent',
      observe,
    }), { ok: true });
  }
  tools.set('composio_execute_tool', {
      type: 'function',
      name: 'composio_execute_tool',
      description: 'Execute one exact connected generated provider operation.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['tool_slug', 'arguments', 'connected_account_id'],
        properties: {
          tool_slug: { type: 'string' },
          arguments: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          connected_account_id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
      needsApproval: async () => false,
      invoke: async (_context, raw) => {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const slug = typeof parsed.tool_slug === 'string' ? parsed.tool_slug : '';
        const fixture = order.find((candidate) => candidate.manifest.operationId === slug);
        assert.ok(fixture, `unexpected generated operation ${slug}`);
        assert.equal(parsed.connected_account_id, fixture.manifest.accountId);
        assert.deepEqual(JSON.parse(String(parsed.arguments ?? '{}')), fixture.args);
        bodyCounts.set(slug, (bodyCounts.get(slug) ?? 0) + 1);
        if (fixture.key === 'uncertain') {
          throw new Error('generated provider connection was lost after the accepted start');
        }
        return fixture.result;
      },
    });
  manifestStores.installCapabilityManifestStore(store);
  catalogs.installHostCapabilityCatalogFactory(factory);
  productionAdapters.installProductionCapabilityAdapter(
    productionAdapters.createProductionCapabilityAdapter({
      store,
      factory,
      observe: {
        composio: (manifest) => ({
          definitionFingerprint: manifest.definitionFingerprint,
          providerVersion: manifest.providerVersion,
          operationVersion: manifest.operationVersion,
          accountId: manifest.accountId,
          observedAt: Date.now(),
        }),
      },
      invokePorts: (manifest) => ({
        invoke: async () => {
          throw new Error(`parallel direct dispatch forbidden: ${manifest.operationId}`);
        },
        ...(manifest.effect === 'read' ? {} : { reconcile: async () => ({ exists: false }) }),
      }),
    }),
  );
  innerDispatch._setInnerDispatchToolsForTests(tools as never);
  productionTransport.installProductionTransport(async () => {
    throw new Error('parallel production transport is forbidden');
  });
}

type CaseKind =
  | 'conversation'
  | 'read'
  | 'create'
  | 'irreversible'
  | 'uncertain'
  | 'credential'
  | 'choice';

interface CorpusCase {
  kind: CaseKind;
  prompt: string;
  fixture?: CapabilityFixture;
}

interface ActiveCase extends CorpusCase {
  rotation: number;
  sessionId: string;
  sourceUserSeq: number | null;
  modelCalls: number;
}

let active: ActiveCase | null = null;

function textMessage(text: string) {
  return {
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
  };
}

function functionCall(callId: string, name: string, args: Record<string, unknown>) {
  return { type: 'function_call', callId, name, arguments: JSON.stringify(args) };
}

function finalMessage(kind: CaseKind) {
  const reply = `Completed generated ${kind} case.`;
  return textMessage(JSON.stringify({
    summary: reply,
    reply,
    done: true,
    nextAction: 'completed',
    reason: null,
  }));
}

function awaitingMessage(kind: 'credential' | 'choice') {
  const reply = kind === 'credential'
    ? 'Connect the generated provider account before I continue?'
    : 'Which generated destination should I use: Destination A or Destination B?';
  return textMessage(JSON.stringify({
    summary: `Waiting for the user to resolve the generated ${kind} stop.`,
    reply,
    done: false,
    nextAction: 'awaiting_user_input',
    reason: kind,
  }));
}

function carriesNoConnections(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'string') {
    if (value.includes('"code":"no_connections"')) return true;
    try {
      return carriesNoConnections(JSON.parse(value), seen);
    } catch {
      return false;
    }
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value as Record<string, unknown>)
    .some((entry) => carriesNoConnections(entry, seen));
}

function planDraft(corpusCase: ActiveCase): Record<string, unknown> {
  const fixture = corpusCase.fixture!;
  const manifest = fixture.manifest;
  const requirementId = `requirement-${corpusCase.kind}-${corpusCase.rotation}`;
  const read = corpusCase.kind === 'read';
  const atomicCreate = corpusCase.kind === 'create' || corpusCase.kind === 'uncertain';
  const sourceRequirementId = `requirement-source-${corpusCase.kind}-${corpusCase.rotation}`;
  return {
    criteria: [`Complete exactly one generated ${corpusCase.kind} operation.`],
    cardinality: { count: 1, fields: [] },
    destination: read ? null : {
      posture: manifest.destination!.posture,
      family: manifest.destination!.family,
      handleRequired: true,
    },
    topology: {
      version: 1,
      operations: [
        ...(atomicCreate ? [{
          id: sourceRequirementId,
          effect: 'read',
          coverage: 'complete_set',
          dependsOn: [],
          dataFrom: [],
          cardinality: { kind: 'once' },
        }] : []),
        {
          id: requirementId,
          effect: read ? 'read' : 'external_write',
          ...(read ? { coverage: 'complete_set' } : { coverage: null }),
          dependsOn: atomicCreate ? [sourceRequirementId] : [],
          dataFrom: atomicCreate ? [sourceRequirementId] : [],
          cardinality: { kind: 'once' },
        },
      ],
      universes: [],
    },
    bindings: [
      ...(atomicCreate ? [{
        operationId: sourceRequirementId,
        role: 'source',
        capabilityRef: CAPABILITIES[0].manifest.manifestId,
        evidence: ['records'],
      }] : []),
      {
        operationId: requirementId,
        role: read ? 'source' : 'destination',
        capabilityRef: manifest.manifestId,
        evidence: atomicCreate
          ? ['receipt', 'content_commit']
          : [read ? 'records' : 'receipt'],
      },
    ],
    deliverables: [{
      id: `deliverable-${corpusCase.kind}-${corpusCase.rotation}`,
      kind: read ? 'records' : manifest.destination!.family,
    }],
    evidenceRequirements: atomicCreate
      ? ['records', 'receipt', 'content_commit']
      : [read ? 'records' : 'receipt'],
  };
}

const scriptedModel = {
  async getResponse(rawRequest: unknown) {
    assert.ok(active);
    active.modelCalls += 1;
    const callIndex = active.modelCalls;
    const request = rawRequest as { tools?: Array<{ name?: string }> };
    const toolNames = (request.tools ?? []).map((entry) => entry.name).filter(Boolean);
    let output: unknown[];
    if (active.kind === 'conversation') {
      assert.equal(callIndex, 1);
      output = [finalMessage(active.kind)];
    } else if (active.kind === 'choice') {
      assert.equal(callIndex, 1);
      output = [awaitingMessage(active.kind)];
    } else if (active.kind === 'credential') {
      if (callIndex === 1) {
        assert.ok(toolNames.includes('tool_search'));
        output = [functionCall(`search-credential-${active.rotation}`, 'tool_search', {
          query: `find generated ${generatedToken(990).toLowerCase()} provider create capability`,
          role_key: 'clause-0:write',
          limit: 8,
          cursor: null,
        })];
      } else {
        assert.equal(carriesNoConnections(rawRequest), true,
          'the primary model must receive the typed no_connections source result');
        output = [awaitingMessage(active.kind)];
      }
    } else if (callIndex === 1) {
      assert.ok(toolNames.includes('plan_task'));
      assert.match(JSON.stringify(rawRequest), new RegExp(active.fixture!.manifest.manifestId));
      output = [functionCall(`plan-${active.kind}-${active.rotation}`, 'plan_task', {
        preamble: `I’ll run the generated ${active.kind} operation now.`,
        draft: planDraft(active),
      })];
    } else if (
      callIndex === 2
      && (active.kind === 'create' || active.kind === 'uncertain')
    ) {
      assert.ok(toolNames.includes('work_call'));
      const fixture = CAPABILITIES[0];
      output = [functionCall(`work-source-${active.kind}-${active.rotation}`, 'work_call', {
        requirement_id: `requirement-source-${active.kind}-${active.rotation}`,
        universe_item_id: null,
        universe_selector: null,
        seal_amendment: null,
        name: 'composio_execute_tool',
        args_json: JSON.stringify({
          tool_slug: fixture.manifest.operationId,
          arguments: JSON.stringify(fixture.args),
          connected_account_id: fixture.manifest.accountId,
        }),
      })];
    } else if (
      callIndex === ((active.kind === 'create' || active.kind === 'uncertain') ? 3 : 2)
    ) {
      assert.ok(toolNames.includes('work_call'));
      const fixture = active.fixture!;
      output = [functionCall(`work-${active.kind}-${active.rotation}`, 'work_call', {
        requirement_id: `requirement-${active.kind}-${active.rotation}`,
        universe_item_id: null,
        universe_selector: null,
        seal_amendment: null,
        name: 'composio_execute_tool',
        args_json: JSON.stringify({
          tool_slug: fixture.manifest.operationId,
          arguments: JSON.stringify(fixture.args),
          connected_account_id: fixture.manifest.accountId,
        }),
      })];
    } else {
      output = [finalMessage(active.kind)];
    }
    return {
      responseId: `balanced-${active.kind}-${active.rotation}-${callIndex}`,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
      output,
    };
  },
  async *getStreamedResponse(request: unknown) {
    const response = await this.getResponse(request);
    const output = Array.isArray(response.output) ? response.output : [];
    yield { type: 'response_started' } as never;
    yield {
      type: 'model',
      event: {
        type: 'finish',
        finishReason: output.some((item) => (item as { type?: string }).type === 'function_call')
          ? 'tool_calls'
          : 'stop',
      },
    } as never;
    yield { type: 'response_done', response } as never;
  },
};

interface Delivery {
  edits: string[];
  errors: string[];
  transport: {
    sendInitial(content: string): Promise<{ edit(content: string): Promise<void> }>;
    sendError(content: string): Promise<void>;
    sendFollowup(content: string): Promise<void>;
  };
}

function delivery(): Delivery {
  const edits: string[] = [];
  const errors: string[] = [];
  return {
    edits,
    errors,
    transport: {
      async sendInitial(content) {
        edits.push(content);
        return { async edit(next) { edits.push(next); } };
      },
      async sendError(content) { errors.push(content); },
      async sendFollowup(content) { edits.push(content); },
    },
  };
}

type StopReason =
  | 'credential_connection_required'
  | 'user_choice_required'
  | 'irreversible_approval_required'
  | 'uncertain_external_effect';

interface NormalizedObservation {
  stopReasons: StopReason[];
  questionCount: number;
  physicalCrossings: number;
  settlements: Array<{ outcome_kind: string; physical_crossing_count: number }>;
  terminalCount: number;
}

function tableExists(name: string): boolean {
  return Boolean(eventlog.openEventLog().prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
}

/** Normalize only authoritative durable shapes. Absence cannot be repaired by
 * matching assistant text; that makes missing typed ownership fail the test. */
function normalizedObservation(input: {
  corpusCase: CorpusCase;
  sessionId: string;
  sourceUserSeq: number;
}): NormalizedObservation {
  const db = eventlog.openEventLog();
  const events = eventlog.listEvents(input.sessionId).filter((event) =>
    event.data.sourceUserSeq === input.sourceUserSeq);
  const questions = events.filter((event) => event.type === 'awaiting_user_input');
  const approvals = tableExists('pending_approvals')
    ? db.prepare("SELECT approval_id FROM pending_approvals WHERE session_id = ? AND status = 'pending'")
      .all(input.sessionId) as Array<{ approval_id: string }>
    : [];
  const dependencies = tableExists('dependency_requests')
    ? db.prepare(`
        SELECT request_id, kind FROM dependency_requests
         WHERE session_id = ? AND source_user_seq = ? AND status = 'open'
      `).all(input.sessionId, input.sourceUserSeq) as Array<{ request_id: string; kind: string }>
    : [];
  const settlements = db.prepare(`
    SELECT outcome_kind, physical_crossing_count FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ?
  `).all(input.sessionId, input.sourceUserSeq) as Array<{
    outcome_kind: string;
    physical_crossing_count: number;
  }>;
  const physical = db.prepare(`
    SELECT COUNT(*) AS n FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND io_claimed_at IS NOT NULL
  `).get(input.sessionId, input.sourceUserSeq) as { n: number };
  const stopReasons: StopReason[] = [];
  if (dependencies.some((row) => row.kind === 'connection_missing')) {
    stopReasons.push('credential_connection_required');
  }
  if (
    input.corpusCase.kind === 'choice'
    && questions.some((event) => event.data.source === 'decision_awaiting')
  ) stopReasons.push('user_choice_required');
  if (approvals.length > 0) stopReasons.push('irreversible_approval_required');
  if (settlements.some((row) => row.outcome_kind === 'uncertain_write')) {
    stopReasons.push('uncertain_external_effect');
  }
  return {
    stopReasons: [...new Set(stopReasons)],
    questionCount: questions.length + approvals.length,
    physicalCrossings: physical.n,
    settlements,
    terminalCount: events.filter((event) => event.type === 'conversation_completed').length,
  };
}

function nearestRankP95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

after(async () => {
  innerDispatch._setInnerDispatchToolsForTests(null);
  composioClient.__test__.setConnectedAccountsLoader(null);
  composioClient.__test__.setComposioApiKeyOverride(null);
  composioClient.resetComposioClient();
  composioSchemas._setToolSchemaLoaderForTests(null);
  productionPorts.clearProductionCapabilityPorts();
  productionAdapters.installProductionCapabilityAdapter(null);
  productionTransport.installProductionTransport(null);
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  bridge._setBridgeImplsForTests({});
  runtimeConfig.resetHarnessRuntimeConfig();
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

test('balanced ordinary-channel corpus has only real typed user stops', { timeout: 120_000 }, async (t) => {
  eventlog.resetEventLog();
  runtimeConfig.resetHarnessRuntimeConfig();
  const configured = await runtimeConfig.configureHarnessRuntime();
  assert.equal(configured.ok, true, configured.ok ? '' : configured.reason);
  bridge._setBridgeImplsForTests({
    buildAgent: async (options) => buildOrchestratorAgent({
      ...options,
      model: scriptedModel as never,
    }),
  });

  const cases: CorpusCase[] = [
    { kind: 'conversation', prompt: 'Explain why circles are round.' },
    {
      kind: 'choice',
      prompt: `Create one resource using either ${CAPABILITIES[1].manifest.operationId} or ${CAPABILITIES[3].manifest.operationId}; both destinations are equally valid and I must choose.`,
    },
    {
      kind: 'read',
      prompt: `Read the accepted records with ${CAPABILITIES[0].manifest.operationId}.`,
      fixture: CAPABILITIES[0],
    },
    {
      kind: 'create',
      prompt: `Create one new generated resource with ${CAPABILITIES[1].manifest.operationId} from the supplied rows.`,
      fixture: CAPABILITIES[1],
    },
    {
      kind: 'irreversible',
      prompt: `Publish the accepted payload once with ${CAPABILITIES[2].manifest.operationId}.`,
      fixture: CAPABILITIES[2],
    },
    {
      kind: 'uncertain',
      prompt: `Create one generated resource with ${CAPABILITIES[3].manifest.operationId}; report an uncertain provider outcome exactly.`,
      fixture: CAPABILITIES[3],
    },
    {
      kind: 'credential',
      prompt: `Create one resource with unavailable ${generatedToken(990).toLowerCase()} credentials.`,
    },
  ];
  const questionCounts: number[] = [];
  const observations: Array<{ rotation: number; kind: CaseKind; observation: NormalizedObservation }> = [];

  for (let rotation = 0; rotation < CAPABILITIES.length; rotation += 1) {
    const ordered = [
      ...CAPABILITIES.slice(rotation),
      ...CAPABILITIES.slice(0, rotation),
    ];
    installCapabilities(ordered);
    for (const corpusCase of cases) {
      const sessionId = `balanced-${rotation}-${corpusCase.kind}`;
      eventlog.createSession({ id: sessionId, kind: 'chat', userId: `user-${rotation}` });
      const delivered = delivery();
      let accepted: { seq: number } | null = null;
      active = {
        ...corpusCase,
        rotation,
        sessionId,
        sourceUserSeq: null,
        modelCalls: 0,
      };
      if (corpusCase.kind === 'credential') {
        // A prior successful provider read leaves an intentionally durable
        // last-good connection snapshot. Reset the fixture client identity so
        // this member proves a fresh, current empty registry and the real
        // authorized provider source emits CandidateSourceUnavailableError
        // (`no_connections`) rather than inheriting a stale account.
        composioClient.resetComposioClient();
      }
      const bodyBefore = new Map(bodyCounts);
      await discord.runDiscordHarnessConversation({
        prompt: corpusCase.prompt,
        rawPrompt: corpusCase.prompt,
        channelId: `channel-${rotation}-${corpusCase.kind}`,
        userId: `user-${rotation}-${corpusCase.kind}`,
        guildId: 'balanced-user-stops-guild',
        transport: delivered.transport,
        durableRequest: {
          sessionId,
          runId: `request-${rotation}-${corpusCase.kind}`,
          onSourceAccepted(source: { seq: number }) {
            accepted = { seq: source.seq };
            if (active) active.sourceUserSeq = source.seq;
          },
        },
      });
      assert.ok(accepted, `${corpusCase.kind}: accepted source`);
      assert.deepEqual(delivered.errors, [], `${corpusCase.kind}: channel errors`);
      const observation = normalizedObservation({
        corpusCase,
        sessionId,
        sourceUserSeq: accepted!.seq,
      });
      observations.push({ rotation, kind: corpusCase.kind, observation });
      questionCounts.push(observation.questionCount);
      if (corpusCase.kind === 'credential') {
        const searchOutput = eventlog.getToolOutput(sessionId, `search-credential-${rotation}`);
        assert.ok(searchOutput, 'credential: durable tool_search result');
        const searchResult = JSON.parse(searchOutput.output) as {
          unavailable?: Array<{ source?: string; code?: string }>;
          brokerCoverage?: string;
        };
        assert.equal(searchResult.brokerCoverage, 'authorized_external_v1');
        assert.equal(searchResult.unavailable?.some((entry) => (
          entry.source === 'authorized_composio' && entry.code === 'no_connections'
        )), true, JSON.stringify(searchResult.unavailable));
      }

      const expectedStops: StopReason[] = corpusCase.kind === 'credential'
        ? ['credential_connection_required']
        : corpusCase.kind === 'choice'
          ? ['user_choice_required']
          : corpusCase.kind === 'irreversible'
            ? ['irreversible_approval_required']
            : corpusCase.kind === 'uncertain'
              ? ['uncertain_external_effect']
              : [];
      assert.deepEqual(observation.stopReasons, expectedStops, JSON.stringify({
        rotation,
        kind: corpusCase.kind,
        observation,
        events: eventlog.listEvents(sessionId).map((event) => ({ type: event.type, data: event.data })),
      }));
      assert.equal(observation.stopReasons.length, expectedStops.length, `${corpusCase.kind}: stop cardinality`);
      const expectedQuestions = corpusCase.kind === 'credential'
        || corpusCase.kind === 'choice'
        || corpusCase.kind === 'irreversible'
        ? 1
        : 0;
      assert.equal(observation.questionCount, expectedQuestions, `${corpusCase.kind}: question cardinality`);
      if (corpusCase.kind === 'conversation' || corpusCase.kind === 'credential' || corpusCase.kind === 'choice') {
        assert.equal(observation.physicalCrossings, 0, `${corpusCase.kind}: zero provider crossing`);
      }
      if (corpusCase.kind === 'read' || corpusCase.kind === 'create' || corpusCase.kind === 'uncertain') {
        assert.equal(
          (bodyCounts.get(corpusCase.fixture!.manifest.operationId) ?? 0)
            - (bodyBefore.get(corpusCase.fixture!.manifest.operationId) ?? 0),
          1,
          JSON.stringify({
            kind: corpusCase.kind,
            rotation,
            modelCalls: active?.modelCalls,
            planOutput: eventlog.getToolOutput(sessionId, `plan-${corpusCase.kind}-${rotation}`),
            workOutput: eventlog.getToolOutput(sessionId, `work-${corpusCase.kind}-${rotation}`),
            catalogRows: catalogs.peekHostCapabilityCatalogFactory()?.snapshot()
              .filter((entry) => entry.toolName === corpusCase.fixture!.manifest.operationId)
              .map((entry) => ({
                capabilityId: entry.capabilityId,
                current: catalogs.isCurrentCallableCatalogEntry(entry),
                manifestDigest: entry.manifestDigest,
              })),
            events: eventlog.listEvents(sessionId).map((event) => ({
              type: event.type,
              data: event.data,
            })),
          }),
        );
        if (corpusCase.kind !== 'uncertain') assert.equal(observation.stopReasons.length, 0);
      }
      if (corpusCase.kind === 'irreversible') {
        assert.equal(bodyCounts.get(corpusCase.fixture!.manifest.operationId) ?? 0, 0);
        assert.equal(observation.physicalCrossings, 0);
      }
      assert.equal(observation.terminalCount, 1, `${corpusCase.kind}: one durable terminal`);
    }
  }
  active = null;
  t.diagnostic(`balanced stop observations: ${JSON.stringify(observations)}`);
  assert.equal(nearestRankP95(questionCounts) <= 1, true, JSON.stringify(questionCounts));
});
