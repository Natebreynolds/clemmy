/**
 * Run:
 *   node scripts/run-tests-isolated.mjs src/journeys/progressive-discovery-large-catalog.competitive.red.test.ts
 *
 * Competitive acceptance for a cold 10,002-operation provider universe.
 *
 * The generated gate deliberately injects only the provider metadata/search
 * boundary. Everything that turns a returned row into a citable ref and then
 * into executable plan authority is production code:
 *
 *   accepted source -> primary planning catalog -> scoped tool_search
 *   -> exact disclosure ledger -> live exact-definition materialization
 *   -> plan_task -> frozen catalog/graph/expected work
 *
 * No graph, resolution proof, manifest, invoke port, historical receipt, or
 * catalog entry is planted for the two selected operations. An advisory index
 * poison is present solely to prove that memory can rank but cannot mint a ref.
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-large-catalog-discovery-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_CODEX_TOOL_SEARCH = 'on';
process.env.CLEMMY_TOOL_JIT = 'on';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.COMPOSIO_API_KEY = 'fixture-large-catalog-key';
process.env.COMPOSIO_USER_ID = 'fixture-large-catalog-user';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-large-catalog-discovery\n', 'utf8');

const eventlog = await import('../runtime/harness/eventlog.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const manifestStores = await import('../runtime/harness/capability-manifest-store.js');
const independentObservations = await import('../runtime/harness/independent-capability-observation.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const adapters = await import('../runtime/harness/production-capability-adapters.js');
const catalogAdapter = await import('../runtime/harness/production-capability-adapter.js');
const semantic = await import('../runtime/semantic-boundary/admit-and-compile-accepted-source.js');
const { buildPlanTaskTool } = await import('../tools/plan-tools.js');
const { buildScopedLocalToolSearch } = await import('../tools/local-runtime-tools.js');
const providerSources = await import('../tools/tool-search-provider-sources.js');
const toolSearchTypes = await import('../tools/tool-search-tool.js');
const schemaCache = await import('../tools/composio-schema-cache.js');
const contracts = await import('../tools/tool-contract-store.js');
const proofCatalog = await import('../runtime/harness/proof-provisioned-catalog.js');
const capabilityIndex = await import('../memory/capability-index.js');
const composio = await import('../integrations/composio/client.js');
const discovery = await import('../runtime/harness/discovery-governor.js');
const brackets = await import('../runtime/harness/brackets.js');
const hostRunner = await import('../runtime/harness/host-turn-runner.js');
const capabilityEnvelopes = await import('../agents/capability-envelope.js');
const originalFetch = globalThis.fetch;

const DISTRACTOR_COUNT = 10_000;
const PERMUTATIONS = 100;
const INITIAL_PLANNING_SURFACE_CEILING = 16 * 1024;
const DISCOVERY_SCHEMA_CEILING = 32 * 1024;
const MAX_RETURNED_REFS_PER_ROLE = 8;

const SOURCE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['location', 'limit'],
  properties: {
    location: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
});

const DESTINATION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['title', 'sheet_json'],
  properties: {
    title: { type: 'string' },
    sheet_json: { type: 'string' },
  },
});

const DISTRACTOR_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['opaque_key'],
  properties: { opaque_key: { type: 'string' } },
});

type Candidate = import('../tools/tool-search-tool.js').ToolSearchBrokerCandidate;
type CandidateSource = import('../tools/tool-search-tool.js').ToolSearchCandidateSource;
type PlanningResult = Awaited<ReturnType<typeof semantic.primePrimaryModelPlanningCatalog>>;
type PlanningContext = Extract<PlanningResult, { ok: true }>['planning'];
type Invokable = {
  name: string;
  description?: string;
  parameters?: unknown;
  invoke: (runContext: unknown, input: string, details?: unknown) => Promise<unknown>;
};

interface GeneratedCatalog {
  seed: number;
  toolkit: string;
  sourceSlug: string;
  destinationSlug: string;
  poisonSlug: string;
  sourceRole: string;
  destinationRole: string;
  objective: string;
  count: number;
  sourcePosition: number;
  destinationPosition: number;
  schemaOf(slug: string): Record<string, unknown> | null;
  isLive(slug: string): boolean;
  boundedCandidates(role: 'source' | 'destination', limit: number): Candidate[];
}

interface PermutationMetrics {
  seed: number;
  initialPlanningBytes: number;
  discoverySchemaBytes: number;
  returnedRefs: [number, number];
  providerSearches: number;
  providerMetadataRows: number;
  exactDefinitionReads: number;
  businessCrossings: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function affineIndex(seed: number, ordinal: number): number {
  // 7,919 is coprime with 10,000, so each seed defines a full deterministic
  // permutation without allocating/shuffling ten thousand objects.
  return ((ordinal * 7_919) + (seed * 1_301)) % DISTRACTOR_COUNT;
}

function generatedCatalog(seed: number): GeneratedCatalog {
  const suffix = sha256(`large-catalog:${seed}`).slice(0, 8).toUpperCase();
  const toolkit = `mega${seed.toString(36).padStart(2, '0')}`;
  const prefix = toolkit.toUpperCase();
  const sourceSlug = `${prefix}_SEARCH_RESTAURANT_RECORDS_BY_CITY_${suffix}`;
  const destinationSlug = `${prefix}_CREATE_NEW_SPREADSHEET_FROM_JSON_ROWS_${suffix}`;
  const poisonSlug = `${prefix}_SEARCH_RESTAURANT_RECORDS_MEMORY_ONLY_${suffix}`;
  const sourceRole = `clause-${seed}-source-read`;
  const destinationRole = `clause-${seed}-destination-write`;
  const sourcePosition = (seed * 7_919 + 977) % (DISTRACTOR_COUNT + 2);
  const destinationPosition = (sourcePosition + 5_003) % (DISTRACTOR_COUNT + 2);
  const objective = `Find ten restaurant records in Santa Clarita using source token ${suffix}, then create one new spreadsheet from those JSON rows.`;
  const distractorSlug = (ordinal: number): string => {
    const index = affineIndex(seed, ordinal);
    const nameSalt = sha256(`${seed}:${index}`).slice(0, 6).toUpperCase();
    return `${prefix}_OPAQUE_OPERATION_${index.toString().padStart(5, '0')}_${nameSalt}`;
  };
  const isDistractor = (slug: string): boolean => {
    const match = new RegExp(`^${prefix}_OPAQUE_OPERATION_(\\d{5})_[A-F0-9]{6}$`).exec(slug);
    if (!match) return false;
    const index = Number(match[1]);
    return Number.isInteger(index) && index >= 0 && index < DISTRACTOR_COUNT;
  };
  return {
    seed,
    toolkit,
    sourceSlug,
    destinationSlug,
    poisonSlug,
    sourceRole,
    destinationRole,
    objective,
    count: DISTRACTOR_COUNT + 2,
    sourcePosition,
    destinationPosition,
    schemaOf(slug) {
      if (slug === sourceSlug) return SOURCE_SCHEMA as Record<string, unknown>;
      if (slug === destinationSlug) return DESTINATION_SCHEMA as Record<string, unknown>;
      return isDistractor(slug) ? DISTRACTOR_SCHEMA as Record<string, unknown> : null;
    },
    isLive(slug) {
      return slug === sourceSlug || slug === destinationSlug || isDistractor(slug);
    },
    boundedCandidates(role, limit) {
      const relevant = role === 'source'
        ? {
            name: sourceSlug,
            summary: 'Search restaurant records by city and return one bounded record collection.',
            schema: SOURCE_SCHEMA,
          }
        : {
            name: destinationSlug,
            summary: 'Create one new spreadsheet from a JSON collection of rows.',
            schema: DESTINATION_SCHEMA,
          };
      const candidates: Candidate[] = [{
        ...relevant,
        carrier: 'work_call',
        score: 1,
        invocation: {
          name: 'composio_execute_tool',
          fixedArgs: { tool_slug: relevant.name },
          payloadField: 'arguments',
        },
      }];
      for (let ordinal = 0; candidates.length < limit; ordinal += 1) {
        const name = distractorSlug(role === 'source' ? ordinal : ordinal + 137);
        candidates.push({
          name,
          summary: `Opaque unrelated live operation ${ordinal}.`,
          schema: DISTRACTOR_SCHEMA,
          carrier: 'work_call',
          score: Math.max(0, 0.4 - ordinal / 100),
          invocation: {
            name: 'composio_execute_tool',
            fixedArgs: { tool_slug: name },
            payloadField: 'arguments',
          },
        });
      }
      return candidates.slice(0, limit);
    },
  };
}

function returnedText(value: unknown): string {
  const text = String(value);
  assert.match(text, /^\{/, `expected intact JSON tool output, received: ${text.slice(0, 300)}`);
  return text;
}

function planDraft(catalog: GeneratedCatalog, sourceRef: string, destinationRef: string) {
  return {
    criteria: [
      'Exactly ten restaurant rows are collected for Santa Clarita.',
      'One new spreadsheet contains all and only those rows.',
    ],
    cardinality: { count: 10, fields: ['name', 'rating', 'address'] },
    destination: { posture: 'create_new' as const, family: catalog.toolkit, handleRequired: true },
    topology: {
      version: 1 as const,
      operations: [{
        id: 'source_read',
        effect: 'read' as const,
        coverage: 'complete_set' as const,
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' as const },
      }, {
        id: 'destination_write',
        effect: 'external_write' as const,
        coverage: null,
        dependsOn: ['source_read'],
        dataFrom: ['source_read'],
        cardinality: { kind: 'once' as const },
      }],
      universes: [],
    },
    bindings: [
      { operationId: 'source_read', role: 'source', capabilityRef: sourceRef, evidence: ['records'] },
      { operationId: 'destination_write', role: 'destination', capabilityRef: destinationRef, evidence: ['receipt'] },
    ],
    deliverables: [{ id: 'restaurant_sheet', kind: catalog.toolkit }],
    evidenceRequirements: ['records', 'receipt'],
  };
}

function wireSurfaceBytes(tools: readonly Invokable[], planning: PlanningContext): number {
  return Buffer.byteLength(JSON.stringify({
    planningCatalog: planning.capabilities,
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters ?? {},
    })),
  }), 'utf8');
}

interface HostInvocationSession {
  invoke(
    tool: Invokable,
    input: unknown,
    callId: string,
    modelRequestBytes: number[],
  ): Promise<unknown>;
  finish(): Promise<void>;
}

function createHostInvocationSession(
  allTools: readonly Invokable[],
  identity: { sessionId: string; sourceUserSeq: number; turn: number },
  deliveredPreambles: string[],
): HostInvocationSession {
  type QueuedInstruction = {
    kind: 'call';
    tool: Invokable;
    input: unknown;
    callId: string;
    modelRequestBytes: number[];
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  } | {
    kind: 'finish';
  };
  let active: Extract<QueuedInstruction, { kind: 'call' }> | null = null;
  const queued: QueuedInstruction[] = [];
  let wake: (() => void) | null = null;
  let finishing = false;
  let emittedCalls = 0;

  const enqueue = (instruction: QueuedInstruction): void => {
    queued.push(instruction);
    const release = wake;
    wake = null;
    release?.();
  };
  const nextInstruction = async (): Promise<QueuedInstruction> => {
    while (queued.length === 0) {
      await new Promise<void>((resolve) => { wake = resolve; });
    }
    return queued.shift()!;
  };
  const resultFor = (rawRequest: unknown, callId: string): unknown => {
    const request = (rawRequest ?? {}) as { input?: unknown };
    const items = Array.isArray(request.input) ? request.input : [];
    const result = [...items].reverse().find((item) => {
      if (!item || typeof item !== 'object') return false;
      const row = item as Record<string, unknown>;
      return row.type === 'function_call_result'
        && (row.callId === callId || row.call_id === callId);
    }) as Record<string, unknown> | undefined;
    assert.ok(result, `real host runner did not project result for ${callId}`);
    const output = result.output;
    if (typeof output === 'string') return output;
    if (Array.isArray(output)) {
      const text = output.find((entry) => entry && typeof entry === 'object'
        && typeof (entry as { text?: unknown }).text === 'string') as { text?: string } | undefined;
      return text?.text ?? JSON.stringify(output);
    }
    if (output && typeof output === 'object'
      && typeof (output as { text?: unknown }).text === 'string') {
      return (output as { text: string }).text;
    }
    return JSON.stringify(output);
  };

  const model = {
    async getResponse(rawRequest: unknown) {
      if (active) {
        const settled = active;
        active = null;
        settled.resolve(resultFor(rawRequest, settled.callId));
      }
      const instruction = await nextInstruction();
      if (instruction.kind === 'call') {
        active = instruction;
        emittedCalls += 1;
        instruction.modelRequestBytes.push(
          Buffer.byteLength(JSON.stringify(rawRequest ?? {}), 'utf8'),
        );
        return {
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
          output: [{
            type: 'function_call',
            callId: instruction.callId,
            name: instruction.tool.name,
            arguments: JSON.stringify(instruction.input),
          }],
          responseId: `${instruction.callId}-request`,
        };
      }
      return {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
        output: [{
          type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'large-catalog-transcript-complete' }],
        }],
        responseId: 'large-catalog-transcript-complete',
      };
    },
    async *getStreamedResponse(request: unknown) {
      const response = await this.getResponse(request);
      const output = response.output ?? [];
      const finishReason = output.some((item) => (item as { type?: string }).type === 'function_call')
        ? 'tool_calls'
        : 'stop';
      yield { type: 'response_started' } as never;
      yield { type: 'model', event: { type: 'finish', finishReason } } as never;
      yield {
        type: 'response_done',
        response: {
          id: response.responseId,
          usage: response.usage,
          output,
        },
      } as never;
    },
  };
  const agent = {
    model,
    instructions: 'Complete the task through the successive configured host controls, then stop.',
    tools: [...allTools],
  };
  const sealed = capabilityEnvelopes.sealAgentCapabilityUniverse({
    sessionId: identity.sessionId,
    universeTools: allTools,
    activeToolNames: allTools.map((entry) => entry.name),
    policyHash: 'competitive-large-catalog-progressive-discovery-v1',
    budget: {
      maxUncachedTokens: 4_096,
      maxModelCalls: 16,
      maxToolCalls: 100,
      maxElapsedMs: 300_000,
    },
  });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  if (!sealed.ok) throw new Error(sealed.errors.join('; '));
  capabilityEnvelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  capabilityEnvelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  const runner = new EventEmitter();
  (runner as unknown as { run: () => never }).run = () => {
    throw new Error('Runner.run must not own competitive host acceptance');
  };
  const outcomePromise = brackets.withHarnessRunContext({
    ...identity,
    counter: new brackets.ToolCallsCounter(100),
    behaviorScopeId: `${identity.sessionId}::large-catalog-transcript`,
    onConversationPreamble: async (request) => {
      deliveredPreambles.push(request.text);
      return {
        status: 'delivered' as const,
        receipt: {
          version: 1 as const,
          deliveryKey: request.deliveryKey,
          eventId: request.eventId,
          eventDigest: request.eventDigest,
          surface: 'channel_message' as const,
          target: `large-catalog-fixture:${request.eventId}`,
        },
      };
    },
  }, () => hostRunner.hostRunRunner(
    runner as never,
    agent as never,
    [{ type: 'message', role: 'user', content: 'Complete the requested task using the configured controls.' }] as never,
    {
      maxTurns: 8,
      hostTurnEngine: 'host_v1',
      context: { sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq },
      toolExecution: { maxFunctionToolConcurrency: 1 },
    } as never,
  ));
  const observedOutcome = outcomePromise.then((outcome) => {
    const authorityDiagnostic = (): unknown => {
      try {
        const db = eventlog.openEventLog();
        return {
          root: db.prepare(`SELECT authority_kind, state, revision, close_reason,
                                  max_logical_calls, max_parallel_calls
                             FROM accepted_turn_call_authorities
                            WHERE session_id = ? AND source_user_seq = ?`)
            .get(identity.sessionId, identity.sourceUserSeq),
          calls: db.prepare(`SELECT logical_tool_call_id, tool_name, state, outcome_kind,
                                    conflict_reason, raw_argument_digest, effective_argument_digest
                               FROM logical_tool_calls
                              WHERE session_id = ? AND source_user_seq = ?
                              ORDER BY opened_at`)
            .all(identity.sessionId, identity.sourceUserSeq),
          dispatches: db.prepare(`SELECT logical_tool_call_id, physical_dispatch_id, relation,
                                         tool_name, state, execution_site
                                    FROM physical_dispatches
                                   WHERE session_id = ? AND source_user_seq = ?
                                   ORDER BY logical_tool_call_id, ordinal`)
            .all(identity.sessionId, identity.sourceUserSeq),
        };
      } catch (error) {
        return { diagnosticError: String(error) };
      }
    };
    if (active) {
      active.reject(new Error(
        `host runner stopped before settling ${active.callId}: ${JSON.stringify({
          terminal: outcome.terminal,
          authority: authorityDiagnostic(),
        })}`,
      ));
      active = null;
    }
    for (const instruction of queued.splice(0)) {
      if (instruction.kind === 'call') {
        instruction.reject(new Error(`host runner stopped before dispatching ${instruction.callId}: ${JSON.stringify(outcome.terminal)}`));
      }
    }
    return outcome;
  }, (error: unknown) => {
    active?.reject(error);
    active = null;
    for (const instruction of queued.splice(0)) {
      if (instruction.kind === 'call') instruction.reject(error);
    }
    throw error;
  });

  return {
    invoke(tool, input, callId, modelRequestBytes) {
      assert.equal(finishing, false, 'cannot append a tool call after finishing the host transcript');
      assert.ok(allTools.includes(tool), `tool ${tool.name} is outside the sealed host transcript`);
      return new Promise<unknown>((resolve, reject) => {
        enqueue({ kind: 'call', tool, input, callId, modelRequestBytes, resolve, reject });
      });
    },
    async finish() {
      assert.equal(finishing, false, 'host transcript may finish only once');
      finishing = true;
      enqueue({ kind: 'finish' });
      const outcome = await observedOutcome;
      assert.equal(outcome.terminal, undefined, JSON.stringify(outcome.terminal));
      assert.ok(emittedCalls > 0, 'host transcript emitted no tool calls');
    },
  };
}

function assertNoCurrentAuthority(identity: { sessionId: string; sourceUserSeq: number }): void {
  assert.equal(eventlog.getTurnGraphEventForSource(identity.sessionId, identity.sourceUserSeq), null);
  assert.deepEqual(catalogs.peekHostCapabilityCatalogFactory()?.snapshot() ?? [], []);
  assert.deepEqual(ports.listProductionCapabilityPorts(), []);
  const events = eventlog.listEvents(identity.sessionId);
  assert.equal(events.some((event) => event.type === 'capability_resolution'), false);
  assert.equal(events.some((event) => event.type === 'capability_discovered'), false);
}

async function preparePermutation(
  catalog: GeneratedCatalog,
  mutation: 'none' | 'removed' | 'renamed' | 'drifted' | 'missing-version' = 'none',
): Promise<{
  identity: { sessionId: string; sourceUserSeq: number; turn: number };
  planning: PlanningContext;
  searchTool: Invokable;
  planTool: Invokable;
  invocation: HostInvocationSession;
  metrics: PermutationMetrics;
  sourceRef: string;
  destinationRef: string;
  deliveredPreambles: string[];
  liveState: Map<string, Record<string, unknown>>;
  readExactDefinitionCount(): number;
}> {
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  manifestStores.installCapabilityManifestStore(manifestStores.createCapabilityManifestStore());
  independentObservations.clearIndependentCapabilityObservations();
  // The production adapter closes over its installed factory. Each permutation
  // models a fresh process/catalog, so its adapter must share that same owner;
  // retaining seed zero's adapter while replacing only the global factory is
  // an unsupported split-brain fixture and eventually prunes the wrong view.
  catalogAdapter.installProductionCapabilityAdapter(null);
  ports.clearProductionCapabilityPorts();
  schemaCache.resetToolSchemaCache();

  const session = eventlog.createSession({
    id: `large-catalog-permutation-${catalog.seed}-${mutation}`,
    kind: 'chat',
    userId: `large-catalog-user-${catalog.seed}`,
  });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: catalog.objective },
  });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };

  // This is intentionally a high-scoring memory/index row with no schema,
  // live definition, manifest, proof, or invoke port. It is advisory poison,
  // not seeded authority. The initial citable catalog must remain empty.
  capabilityIndex.recordCapabilityOperations([{
    identifier: catalog.poisonSlug,
    carrierKind: 'composio',
    carrier: catalog.toolkit,
    displayName: 'Search restaurant records by city',
    description: catalog.objective,
    effectClass: 'read',
    effectProvenance: 'inferred',
    accountIdentity: `connection-${catalog.seed}`,
  }]);

  composio.__test__.setComposioApiKeyOverride('fixture-large-catalog-key');
  composio.__test__.setConnectedAccountsLoader(async () => [{
    id: `connection-${catalog.seed}`,
    status: 'ACTIVE',
    user_id: 'fixture-large-catalog-user',
    toolkit: { slug: catalog.toolkit },
  }]);

  assertNoCurrentAuthority(identity);
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) throw new Error(primed.reason);
  const planning = primed.planning;
  assert.deepEqual(planning.capabilities, [],
    'an advisory index hit without a live host definition cannot become a citable planning ref');

  let providerSearches = 0;
  let providerMetadataRows = 0;
  let exactDefinitionReads = 0;
  const liveState = new Map<string, Record<string, unknown>>([
    [catalog.sourceSlug, SOURCE_SCHEMA as Record<string, unknown>],
    [catalog.destinationSlug, DESTINATION_SCHEMA as Record<string, unknown>],
  ]);
  schemaCache._setToolSchemaLoaderForTests(async (slug) => {
    exactDefinitionReads += 1;
    const schema = liveState.get(slug);
    return schema
      ? {
          inputParameters: schema,
          // This fixture models an exact provider row that authoritatively
          // declares no result-payload schema. Omitting the field would mean
          // the output definition was not observed and must not mint a live
          // capability.
          outputParameters: null,
          providerObservedAt: Date.now(),
          ...(mutation === 'missing-version'
            ? {}
            : { providerOperationVersion: `fixture-${catalog.toolkit}-v1` }),
        }
      : null;
  });

  const emptyExternal: CandidateSource = {
    kind: 'authorized_external_mcp',
    async search() { return []; },
  };
  const boundedLiveProvider: CandidateSource = {
    kind: 'authorized_composio',
    async search({ query, limit }) {
      providerSearches += 1;
      assert.equal(limit, MAX_RETURNED_REFS_PER_ROLE);
      const role = /destination|spreadsheet|json rows/i.test(query) ? 'destination' : 'source';
      const rows = catalog.boundedCandidates(role, limit);
      // Production Composio search deposits the complete provider row in the
      // live schema cache before the planning-disclosure callback runs. This
      // bounded fixture bypasses that adapter, so mirror the same observation:
      // input, operation version, and an explicit provider-owned absence of an
      // output schema. The later exact loader remains independent and is still
      // the freeze-time revalidation read counted below.
      const providerObservedAt = Math.max(0, Date.now() - 1_000);
      for (const row of rows) {
        if (!row.schema || typeof row.schema !== 'object' || Array.isArray(row.schema)) continue;
        schemaCache.rememberToolSchema(
          row.name,
          row.schema,
          providerObservedAt,
          `fixture-${catalog.toolkit}-v1`,
          null,
        );
      }
      providerMetadataRows += rows.length;
      return rows;
    },
  };
  const disclosure = async (
    candidates: readonly import('../tools/tool-search-tool.js').ToolSearchPlanningDisclosureCandidate[],
  ) => {
    await providerSources.stageDisclosedPlanningProviderCandidates({
      ...planning.identity,
      candidates,
    });
    return semantic.disclosePrimaryModelPlanningCapabilities({
      authority: planning.authority,
      candidates,
    });
  };
  const rawSearch = buildScopedLocalToolSearch(
    new Set<string>(),
    'work_call',
    undefined,
    [emptyExternal, boundedLiveProvider],
    disclosure,
  ) as unknown as Invokable;
  const rawPlan = buildPlanTaskTool({ planning }) as unknown as Invokable;
  const searchTool = brackets.wrapToolForHarness(rawSearch as never) as unknown as Invokable;
  const planTool = brackets.wrapToolForHarness(rawPlan as never) as unknown as Invokable;

  const initialPlanningBytes = wireSurfaceBytes([searchTool, planTool], planning);
  assert.ok(initialPlanningBytes <= INITIAL_PLANNING_SURFACE_CEILING,
    `initial planning surface exceeded 16KiB: ${initialPlanningBytes}`);

  discovery.discoveryGovernor.initializeTask({
    sessionId: identity.sessionId,
    sourceUserSeq: identity.sourceUserSeq,
    knownCapability: false,
  });
  discovery.discoveryGovernor.initializeRoles({
    sessionId: identity.sessionId,
    sourceUserSeq: identity.sourceUserSeq,
    brokerCoverage: toolSearchTypes.toolSearchBrokerCoverage([emptyExternal, boundedLiveProvider]),
    requirements: [
      { roleKey: catalog.sourceRole, clauseIndex: 0, text: 'collect restaurant rows', resolved: false },
      { roleKey: catalog.destinationRole, clauseIndex: 1, text: 'create the spreadsheet', resolved: false },
    ],
  });

  const deliveredPreambles: string[] = [];
  const modelRequestBytes: number[] = [];
  const configuredTools = [searchTool, planTool] as const;
  const invocation = createHostInvocationSession(configuredTools, identity, deliveredPreambles);
  const sourceText = returnedText(await invocation.invoke(searchTool, {
    query: 'source role search restaurant records by city',
    role_key: catalog.sourceRole,
    limit: MAX_RETURNED_REFS_PER_ROLE,
  }, `search-source-${catalog.seed}-${mutation}`, modelRequestBytes));
  const destinationOutput = await invocation.invoke(searchTool, {
    query: 'destination role create new spreadsheet from JSON rows',
    role_key: catalog.destinationRole,
    limit: MAX_RETURNED_REFS_PER_ROLE,
  }, `search-destination-${catalog.seed}-${mutation}`, modelRequestBytes);
  if (!String(destinationOutput).startsWith('{')) {
    const sourceRows = (JSON.parse(sourceText) as { results?: unknown[] }).results ?? [];
    throw new Error(`PROGRESSIVE_DISCOVERY_ROLE_BUDGET_RED ${JSON.stringify({
      seed: catalog.seed,
      catalogUniverse: catalog.count,
      exactFirstModelBytes: modelRequestBytes[0] ?? null,
      firstToolSearchBytes: Buffer.byteLength(sourceText, 'utf8'),
      firstReturnedRefs: sourceRows.length,
      providerSearches,
      providerMetadataRows,
      exactDefinitionReads,
      businessCrossings,
      secondRoleOutcome: String(destinationOutput),
    })}`);
  }
  const destinationText = returnedText(destinationOutput);

  type SearchBody = {
    results: Array<{ name: string; capabilityRef?: string; planningRefStatus?: string }>;
    schemas: Record<string, unknown>;
  };
  const sourceBody = JSON.parse(sourceText) as SearchBody;
  const destinationBody = JSON.parse(destinationText) as SearchBody;
  const refsOf = (body: SearchBody): string[] => body.results
    .map((row) => row.capabilityRef)
    .filter((ref): ref is string => typeof ref === 'string' && ref.length > 0);
  const sourceRefs = refsOf(sourceBody);
  const destinationRefs = refsOf(destinationBody);
  const sourceRef = `cap:resolved:${catalog.sourceSlug.toLowerCase()}`;
  const destinationRef = `cap:resolved:${catalog.destinationSlug.toLowerCase()}`;
  assert.ok(sourceRefs.length <= MAX_RETURNED_REFS_PER_ROLE);
  assert.ok(destinationRefs.length <= MAX_RETURNED_REFS_PER_ROLE);
  assert.ok(sourceRefs.includes(sourceRef), `source ref missing for seed ${catalog.seed}`);
  assert.ok(destinationRefs.includes(destinationRef), `destination ref missing for seed ${catalog.seed}`);
  assert.ok(sourceBody.schemas[catalog.sourceSlug], 'the selected source includes its exact input schema');
  assert.ok(destinationBody.schemas[catalog.destinationSlug], 'the selected destination includes its exact input schema');
  const discoverySchemaBytes = Buffer.byteLength(sourceText, 'utf8')
    + Buffer.byteLength(destinationText, 'utf8');
  const exactFirstModelBytes = modelRequestBytes[0] ?? Number.POSITIVE_INFINITY;
  assert.ok(exactFirstModelBytes <= INITIAL_PLANNING_SURFACE_CEILING,
    `exact first host-model request exceeded 16KiB: ${exactFirstModelBytes}`);
  assert.ok(discoverySchemaBytes <= DISCOVERY_SCHEMA_CEILING,
    `two-role discovery exceeded 32KiB: ${discoverySchemaBytes}`);
  assert.deepEqual({ providerSearches, providerMetadataRows }, {
    providerSearches: 2,
    providerMetadataRows: 16,
  }, 'one bounded provider search occurs for each unresolved role');

  // Every returned ref must be backed by this accepted source's exact
  // disclosure record. A predictable `cap:resolved:*` string alone is not a
  // capability and cannot appear in the model-visible result.
  const discovered = eventlog.listEvents(identity.sessionId, { types: ['capability_discovered'] })
    .flatMap((event) => Array.isArray(event.data.capabilities)
      ? event.data.capabilities as Array<Record<string, unknown>>
      : []);
  const disclosedByRef = new Map(discovered.map((row) => [String(row.capabilityRef ?? ''), row]));
  for (const row of [...sourceBody.results, ...destinationBody.results]) {
    if (!row.capabilityRef) continue;
    assert.equal(catalog.isLive(row.name), true, `non-live result acquired a ref: ${row.name}`);
    assert.equal(row.capabilityRef, `cap:resolved:${row.name.toLowerCase()}`);
    const durable = disclosedByRef.get(row.capabilityRef);
    assert.ok(durable, `ref-only result has no exact disclosure row: ${row.capabilityRef}`);
    assert.equal(durable?.identifier, row.name);
    const providerDefinition = durable?.providerDefinition as Record<string, unknown> | undefined;
    assert.equal(providerDefinition?.version, 1);
    assert.match(String(providerDefinition?.providerInputSchemaDigest ?? ''), /^[a-f0-9]{64}$/);
    assert.match(String(providerDefinition?.definitionFingerprint ?? ''), /^[a-f0-9]{64}$/);
    assert.notEqual(providerDefinition?.providerInputSchemaDigest, providerDefinition?.definitionFingerprint,
      'the full definition fingerprint must not alias the provider input-schema digest');
    assert.equal(providerDefinition?.providerOperationVersion, `fixture-${catalog.toolkit}-v1`);
    assert.equal(providerDefinition?.providerOutputSchemaDigest, null);
    assert.equal(providerDefinition?.invokePortId,
      `port:cap:resolved:${row.name.toLowerCase()}:${row.name}`);
    assert.ok(durable?.descriptor && typeof durable.descriptor === 'object');
  }

  assert.deepEqual(factory.snapshot(), [],
    'tool_search disclosure is metadata/staging and publishes no executable catalog entry');
  assert.deepEqual(ports.listProductionCapabilityPorts(), [],
    'search/ref disclosure cannot install an invoke port');
  assert.equal(eventlog.getTurnGraphEventForSource(identity.sessionId, identity.sourceUserSeq), null,
    'search/ref disclosure cannot admit a plan');

  if (mutation === 'removed') {
    liveState.delete(catalog.sourceSlug);
  } else if (mutation === 'renamed') {
    liveState.delete(catalog.sourceSlug);
    liveState.set(`${catalog.sourceSlug}_RENAMED`, SOURCE_SCHEMA as Record<string, unknown>);
  } else if (mutation === 'drifted') {
    liveState.set(catalog.sourceSlug, {
      ...SOURCE_SCHEMA,
      required: ['location', 'limit', 'country_code'],
      properties: {
        ...SOURCE_SCHEMA.properties,
        country_code: { type: 'string', minLength: 2, maxLength: 2 },
      },
    });
  }

  return {
    identity,
    planning,
    searchTool,
    planTool,
    invocation,
    sourceRef,
    destinationRef,
    deliveredPreambles,
    liveState,
    readExactDefinitionCount: () => exactDefinitionReads,
    metrics: {
      seed: catalog.seed,
      initialPlanningBytes: exactFirstModelBytes,
      discoverySchemaBytes,
      returnedRefs: [sourceRefs.length, destinationRefs.length],
      providerSearches,
      providerMetadataRows,
      exactDefinitionReads,
      businessCrossings: 0,
    },
  };
}

let businessCrossings = 0;
adapters.installProductionTransport(async () => {
  businessCrossings += 1;
  throw new Error('competitive discovery test forbids business/provider execution');
});

after(() => {
  schemaCache._setToolSchemaLoaderForTests(null);
  schemaCache.resetToolSchemaCache();
  contracts._clearToolContractsForTests();
  composio.__test__.setConnectedAccountsLoader(null);
  composio.__test__.setComposioApiKeyOverride(null);
  composio.resetComposioClient();
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  independentObservations.clearIndependentCapabilityObservations();
  catalogAdapter.installProductionCapabilityAdapter(null);
  ports.clearProductionCapabilityPorts();
  adapters.installProductionTransport(null);
  eventlog.closeEventLog();
  globalThis.fetch = originalFetch;
  rmSync(HOME, { recursive: true, force: true });
});

test('GATE: 100 cold 10K-catalog permutations stay bounded and freeze only live disclosed refs', {
  timeout: 300_000,
}, async (t) => {
  eventlog.resetEventLog();
  const allMetrics: PermutationMetrics[] = [];
  for (let seed = 0; seed < PERMUTATIONS; seed += 1) {
    const catalog = generatedCatalog(seed);
    assert.equal(catalog.count, 10_002);
    assert.notEqual(catalog.sourcePosition, catalog.destinationPosition);
    const run = await preparePermutation(catalog);
    const planRequestBytes: number[] = [];

    // A memory-only row is deliberately named so its predicted ref looks
    // plausible. plan_task must return a typed denial before any materializer,
    // graph, port, preamble, or provider body is touched.
    const poison = returnedText(await run.invocation.invoke(run.planTool, {
      preamble: 'I’ll collect the restaurant rows and create the new spreadsheet.',
      draft: planDraft(
        catalog,
        `cap:resolved:${catalog.poisonSlug.toLowerCase()}`,
        run.destinationRef,
      ),
    }, `plan-index-poison-${seed}`, planRequestBytes));
    const poisonBody = JSON.parse(poison) as { ok?: boolean; code?: string; detail?: string };
    assert.deepEqual({ ok: poisonBody.ok, code: poisonBody.code }, {
      ok: false,
      code: 'plan_not_admitted',
    });
    assert.match(String(poisonBody.detail ?? ''), /not disclosed/i);
    assert.equal(eventlog.getTurnGraphEventForSource(run.identity.sessionId, run.identity.sourceUserSeq), null);
    assert.deepEqual(catalogs.peekHostCapabilityCatalogFactory()?.snapshot() ?? [], []);
    assert.deepEqual(ports.listProductionCapabilityPorts(), []);
    assert.deepEqual(run.deliveredPreambles, []);
    assert.equal(businessCrossings, 0);

    const admitted = returnedText(await run.invocation.invoke(run.planTool, {
      preamble: 'I’ll collect the restaurant rows and create the new spreadsheet.',
      draft: planDraft(catalog, run.sourceRef, run.destinationRef),
    }, `plan-live-refs-${seed}`, planRequestBytes));
    await run.invocation.finish();
    const admittedBody = JSON.parse(admitted) as { ok?: boolean; code?: string; requirements?: unknown[] };
    assert.equal(admittedBody.ok, true,
      `live disclosed refs did not admit for seed ${seed}: ${admitted}`);
    assert.equal(admittedBody.code, undefined);
    assert.equal(admittedBody.requirements?.length, 2);
    assert.equal(run.deliveredPreambles.length, 1);
    assert.ok(eventlog.getTurnGraphEventForSource(run.identity.sessionId, run.identity.sourceUserSeq));
    assert.deepEqual(
      (catalogs.peekHostCapabilityCatalogFactory()?.snapshot() ?? [])
        .map((entry) => entry.capabilityId)
        .sort(),
      [run.sourceRef, run.destinationRef, 'cap:resolved:host_transform'].sort(),
      'plan admission publishes only the two selected live refs plus the host transform',
    );
    assert.equal(businessCrossings, 0,
      'metadata discovery and plan admission perform zero business/provider execution');
    run.metrics.exactDefinitionReads = run.readExactDefinitionCount();
    assert.equal(run.metrics.exactDefinitionReads, 2,
      'plan freeze re-reads only the two selected exact live definitions');
    run.metrics.businessCrossings = businessCrossings;
    allMetrics.push(run.metrics);
  }

  assert.equal(allMetrics.length, PERMUTATIONS);
  const summary = {
    maxInitialPlanningBytes: Math.max(...allMetrics.map((metric) => metric.initialPlanningBytes)),
    maxDiscoverySchemaBytes: Math.max(...allMetrics.map((metric) => metric.discoverySchemaBytes)),
    maxReturnedRefsPerRole: Math.max(...allMetrics.flatMap((metric) => metric.returnedRefs)),
    totalProviderSearches: allMetrics.reduce((sum, metric) => sum + metric.providerSearches, 0),
    maxProviderMetadataRowsPerTask: Math.max(...allMetrics.map((metric) => metric.providerMetadataRows)),
    exactDefinitionReadsPerTask: [...new Set(allMetrics.map((metric) => metric.exactDefinitionReads))],
    businessCrossings,
    successRate: allMetrics.length / PERMUTATIONS,
  };
  t.diagnostic(`LARGE_CATALOG_METRICS ${JSON.stringify(summary)}`);
  assert.deepEqual(summary, {
    maxInitialPlanningBytes: Math.max(...allMetrics.map((metric) => metric.initialPlanningBytes)),
    maxDiscoverySchemaBytes: Math.max(...allMetrics.map((metric) => metric.discoverySchemaBytes)),
    maxReturnedRefsPerRole: 8,
    totalProviderSearches: 200,
    maxProviderMetadataRowsPerTask: 16,
    exactDefinitionReadsPerTask: [2],
    businessCrossings: 0,
    successRate: 1,
  });
  assert.ok(Math.max(...allMetrics.map((metric) => metric.initialPlanningBytes))
    <= INITIAL_PLANNING_SURFACE_CEILING);
  assert.ok(Math.max(...allMetrics.map((metric) => metric.discoverySchemaBytes))
    <= DISCOVERY_SCHEMA_CEILING);
});

test('GATE: a legacy input-digest disclosure rebuilds full staged identity after restart', {
  timeout: 60_000,
}, async () => {
  const catalog = generatedCatalog(9_901);
  const staged = await preparePermutation(catalog);
  await staged.invocation.finish();

  const selectedRefs = new Set([staged.sourceRef, staged.destinationRef]);
  const currentRows = eventlog.listEvents(staged.identity.sessionId, { types: ['capability_discovered'] })
    .flatMap((event) => Array.isArray(event.data.capabilities)
      ? event.data.capabilities as Array<Record<string, unknown>>
      : [])
    .filter((row) => selectedRefs.has(String(row.capabilityRef ?? '')));
  assert.equal(currentRows.length, 2);
  const legacyRows = currentRows.map((row) => {
    const providerDefinition = row.providerDefinition as Record<string, unknown> | undefined;
    assert.match(String(providerDefinition?.providerInputSchemaDigest ?? ''), /^[a-f0-9]{64}$/);
    const { providerDefinition: _removed, ...legacy } = row;
    return {
      ...legacy,
      schemaFingerprint: providerDefinition!.providerInputSchemaDigest,
    };
  });

  const session = eventlog.createSession({
    id: 'large-catalog-legacy-disclosure-restart',
    kind: 'chat',
    userId: 'large-catalog-legacy-user',
  });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: catalog.objective },
  });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  const planningCandidates = [catalog.sourceSlug, catalog.destinationSlug].map((name) => ({
    name,
    schema: catalog.schemaOf(name)!,
    carrier: 'work_call' as const,
    sourceKind: 'authorized_composio' as const,
  }));
  await providerSources.stageDisclosedPlanningProviderCandidates({
    ...identity,
    candidates: planningCandidates,
  });
  eventlog.appendEvent({
    sessionId: session.id,
    turn: source.turn,
    role: 'system',
    type: 'capability_discovered',
    data: { sourceUserSeq: source.seq, capabilities: legacyRows },
  });

  // Process state is gone, while the provider observation's original TTL and
  // durable contract remain. Replay may use that current evidence to upgrade
  // the legacy input digest, but may not reinterpret it as the full digest.
  schemaCache._clearToolSchemaCacheForTest();
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) throw new Error(primed.reason);
  assert.deepEqual(
    primed.planning.capabilities.map((entry) => entry.id).sort(),
    [staged.sourceRef, staged.destinationRef].sort(),
  );

  const rawPlan = buildPlanTaskTool({ planning: primed.planning }) as unknown as Invokable;
  const planTool = brackets.wrapToolForHarness(rawPlan as never) as unknown as Invokable;
  const deliveredPreambles: string[] = [];
  const callId = 'plan-legacy-disclosure-after-restart';
  const invocation = createHostInvocationSession([planTool], identity, deliveredPreambles);
  const output = returnedText(await invocation.invoke(planTool, {
    preamble: 'I’ll collect the restaurant rows and create the new spreadsheet.',
    draft: planDraft(catalog, staged.sourceRef, staged.destinationRef),
  }, callId, []));
  await invocation.finish();
  const body = JSON.parse(output) as { ok?: boolean; requirements?: unknown[]; detail?: string };
  assert.equal(body.ok, true, output);
  assert.equal(body.requirements?.length, 2);
  assert.equal(deliveredPreambles.length, 1);
  assert.ok(eventlog.getTurnGraphEventForSource(identity.sessionId, identity.sourceUserSeq));
  assert.equal(businessCrossings, 0);
});

test('GATE: removal, rename, schema drift, and missing operation version fail typed before business I/O', {
  timeout: 60_000,
}, async () => {
  for (const [offset, mutation] of [
    [10_001, 'removed'],
    [10_002, 'renamed'],
    [10_003, 'drifted'],
    [10_004, 'missing-version'],
  ] as const) {
    const catalog = generatedCatalog(offset);
    const run = await preparePermutation(catalog, mutation);
    const planRequestBytes: number[] = [];
    const output = returnedText(await run.invocation.invoke(run.planTool, {
      preamble: 'I’ll collect the restaurant rows and create the new spreadsheet.',
      draft: planDraft(catalog, run.sourceRef, run.destinationRef),
    }, `plan-live-${mutation}`, planRequestBytes));
    await run.invocation.finish();
    const body = JSON.parse(output) as { ok?: boolean; code?: string; detail?: string };
    assert.deepEqual({ ok: body.ok, code: body.code }, {
      ok: false,
      code: 'plan_not_admitted',
    }, `${mutation} did not fail through the typed plan boundary: ${output}`);
    assert.match(String(body.detail ?? ''), /changed|frozen host catalog|selected provider capability|published|selected_definition_/i);
    assert.equal(eventlog.getTurnGraphEventForSource(run.identity.sessionId, run.identity.sourceUserSeq), null);
    assert.deepEqual(run.deliveredPreambles, []);
    assert.equal(businessCrossings, 0);
  }
});

test('GATE: an initially live selected Composio ref is revalidated after the first model card', {
  timeout: 60_000,
}, async () => {
  for (const [offset, mutation] of [
    [20_001, 'drifted'],
    [20_002, 'disconnected'],
  ] as const) {
    const catalog = generatedCatalog(offset);
    const staged = await preparePermutation(catalog);
    await staged.invocation.finish();
    const seeded = await proofCatalog.registerProofProvisionedCapabilities(staged.identity, {
      allowedIdentifiers: [catalog.sourceSlug, catalog.destinationSlug],
      expectedSchemaDigests: [
        { identifier: catalog.sourceSlug, schemaDigest: contracts.digestSchema(SOURCE_SCHEMA) },
        { identifier: catalog.destinationSlug, schemaDigest: contracts.digestSchema(DESTINATION_SCHEMA) },
      ],
    });
    assert.equal(seeded.refusal, undefined, JSON.stringify(seeded.refusal));
    assert.ok(catalogs.peekHostCapabilityCatalogFactory()?.get(staged.sourceRef));
    assert.ok(catalogs.peekHostCapabilityCatalogFactory()?.get(staged.destinationRef));

    // A later accepted source receives these as its initial live planning
    // card—there is no staged disclosure on this source to trigger the old
    // selectedStaged-only refresh path.
    const session = eventlog.createSession({
      id: `large-catalog-initial-live-${offset}-${mutation}`,
      kind: 'chat',
      userId: `large-catalog-initial-user-${offset}`,
    });
    const source = eventlog.appendEvent({
      sessionId: session.id,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: catalog.objective },
    });
    const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
    const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
    assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
    if (!primed.ok) throw new Error(primed.reason);
    assert.ok(primed.planning.capabilities.some((entry) => entry.id === staged.sourceRef));
    assert.ok(primed.planning.capabilities.some((entry) => entry.id === staged.destinationRef));

    const planTool = buildPlanTaskTool({ planning: primed.planning }) as unknown as Invokable;
    const exactReadsBefore = staged.readExactDefinitionCount();
    ports.clearProductionCapabilityPorts();
    if (mutation === 'drifted') {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      staged.liveState.set(catalog.sourceSlug, {
        ...SOURCE_SCHEMA,
        required: ['location', 'limit', 'country_code'],
        properties: {
          ...SOURCE_SCHEMA.properties,
          country_code: { type: 'string', minLength: 2, maxLength: 2 },
        },
      });
    } else {
      composio.__test__.setConnectedAccountsLoader(async () => []);
    }

    const deliveredPreambles: string[] = [];
    const businessBefore = businessCrossings;
    const callId = `plan-initial-live-${mutation}`;
    const output = returnedText(await brackets.withHarnessRunContext({
      ...identity,
      counter: new brackets.ToolCallsCounter(10),
      behaviorScopeId: `${identity.sessionId}::${callId}`,
      onConversationPreamble: async (request) => {
        deliveredPreambles.push(request.text);
        return {
          status: 'delivered' as const,
          receipt: {
            version: 1 as const,
            deliveryKey: request.deliveryKey,
            eventId: request.eventId,
            eventDigest: request.eventDigest,
            surface: 'channel_message' as const,
            target: `large-catalog-fixture:${request.eventId}`,
          },
        };
      },
    }, () => planTool.invoke(null, JSON.stringify({
      preamble: 'I’ll collect the restaurant rows and create the new spreadsheet.',
      draft: planDraft(catalog, staged.sourceRef, staged.destinationRef),
    }), { toolCall: { callId } })));
    const body = JSON.parse(output) as { ok?: boolean; code?: string; detail?: string };
    assert.deepEqual({ ok: body.ok, code: body.code }, {
      ok: false,
      code: 'plan_not_admitted',
    }, `${mutation} initial ref did not fail through plan admission: ${output}`);
    assert.match(
      String(body.detail ?? ''),
      mutation === 'drifted'
        ? /selected_definition_schema_drift/
        : /selected_connection_missing_or_changed/,
    );
    assert.equal(eventlog.getTurnGraphEventForSource(identity.sessionId, identity.sourceUserSeq), null);
    assert.deepEqual(ports.listProductionCapabilityPorts(), []);
    assert.deepEqual(deliveredPreambles, []);
    assert.equal(businessCrossings, businessBefore);
    const exactReadDelta = staged.readExactDefinitionCount() - exactReadsBefore;
    if (mutation === 'disconnected') {
      assert.equal(exactReadDelta, 0, 'disconnect refuses before schema metadata I/O');
    } else {
      assert.ok(exactReadDelta > 0 && exactReadDelta <= 2,
        'schema proof reads only the two selected external refs, never the rest of the live card');
    }
  }
});

test('GATE: cold Composio server search finds relevant tail operations without catalog preload', {
  timeout: 60_000,
}, async (t) => {
  schemaCache.resetToolSchemaCache();
  contracts._clearToolContractsForTests();
  composio.resetComposioClient();
  composio.__test__.setComposioApiKeyOverride('fixture-large-catalog-key');
  const toolkit = 'megared';
  const relevant = [
    'MEGARED_ZEPHYRQUARTZ_ARCLIGHT_READ_TAIL',
    'MEGARED_ZEPHYRQUARTZ_ARCLIGHT_WRITE_TAIL',
  ];
  const catalog = Array.from({ length: DISTRACTOR_COUNT }, (_, index) => ({
    slug: `MEGARED_OPAQUE_OPERATION_${index.toString().padStart(5, '0')}`,
    name: `Opaque operation ${index}`,
    description: `Unrelated live provider operation ${index}.`,
    toolkit: { slug: toolkit },
    inputParameters: DISTRACTOR_SCHEMA,
  }));
  catalog.push({
    slug: relevant[0]!,
    name: 'Zephyrquartz arclight source sentinel',
    description: 'Read the zephyrquartz arclight sentinel.',
    toolkit: { slug: toolkit },
    inputParameters: SOURCE_SCHEMA,
  }, {
    slug: relevant[1]!,
    name: 'Zephyrquartz arclight destination sentinel',
    description: 'Write the zephyrquartz arclight sentinel.',
    toolkit: { slug: toolkit },
    inputParameters: DESTINATION_SCHEMA,
  });
  composio.__test__.setConnectedAccountsLoader(async () => [{
    id: 'connection-red',
    status: 'ACTIVE',
    user_id: 'fixture-large-catalog-user',
    toolkit: { slug: toolkit },
  }]);
  let rawListCalls = 0;
  let requestedToolkitLimit = 0;
  let requestedSearch = '';
  let definitionsLoaded = 0;
  composio.__test__.setComposioClient({
    client: { baseURL: 'https://backend.composio.dev' },
    tools: {
      async getRawComposioTools(input: { toolkits?: string[]; search?: string; limit?: number }) {
        rawListCalls += 1;
        requestedToolkitLimit = Number(input.limit ?? 0);
        requestedSearch = String(input.search ?? '');
        assert.deepEqual(input.toolkits, [toolkit]);
        assert.equal(requestedSearch, 'zephyrquartz arclight sentinel');
        // The installed provider owns the 10,002-row index. Its filtered API
        // returns only bounded matches; Clementine never receives or scans the
        // ten-thousand-row toolkit page.
        const queryTokens = requestedSearch.toLowerCase().split(/\s+/).filter(Boolean);
        const page = catalog.filter((entry) => {
          const searchable = `${entry.slug} ${entry.name} ${entry.description}`.toLowerCase();
          return queryTokens.every((token) => searchable.includes(token));
        }).slice(0, requestedToolkitLimit);
        definitionsLoaded += page.length;
        return page;
      },
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://backend.composio.dev/api/v3/tools?')) {
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`large-catalog RED forbids external network: ${url}`);
  }) as typeof fetch;

  const sources = providerSources.buildAuthorizedToolSearchCandidateSources({
    reason: 'competitive large-catalog cold source',
    authority: 'catalog',
    allowedServerSlugs: [],
    toolPatterns: [],
    maxTools: 0,
  } as never);
  const source = sources.find((candidate) => candidate.kind === 'authorized_composio');
  assert.ok(source);
  const startedAt = performance.now();
  const found = await source!.search({
    query: 'zephyrquartz arclight sentinel',
    limit: 8,
  });
  const elapsedMs = performance.now() - startedAt;
  const foundRelevant = found.filter((candidate) => relevant.includes(candidate.name)).map((candidate) => candidate.name);
  const returnedBytes = Buffer.byteLength(JSON.stringify(found), 'utf8');
  const metrics = {
    catalogUniverse: catalog.length,
    distractors: DISTRACTOR_COUNT,
    relevantPositions: relevant.map((slug) => catalog.findIndex((entry) => entry.slug === slug)),
    requestedResultLimit: 8,
    requestedToolkitLimit,
    requestedSearch,
    rawListCalls,
    definitionsLoaded,
    returnedRows: found.length,
    returnedBytes,
    foundRelevant,
    elapsedMs: Number(elapsedMs.toFixed(1)),
  };
  assert.deepEqual(foundRelevant.sort(), [...relevant].sort(),
    `COLD_LARGE_CATALOG_MISS ${JSON.stringify(metrics)}`);
  assert.equal(rawListCalls, 1, `COLD_LARGE_CATALOG_CALLS ${JSON.stringify(metrics)}`);
  assert.ok(definitionsLoaded <= 16,
    `COLD_LARGE_CATALOG_PRELOAD ${JSON.stringify(metrics)}`);
  assert.ok(returnedBytes <= DISCOVERY_SCHEMA_CEILING,
    `COLD_LARGE_CATALOG_BYTES ${JSON.stringify(metrics)}`);
  t.diagnostic(`TAIL_SEARCH_METRICS ${JSON.stringify(metrics)}`);
});
