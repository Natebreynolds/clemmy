/**
 * Run: node scripts/run-tests-isolated.mjs \
 *   src/execution/workflow-step-external-catalog.test.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-exact-catalog-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { prepareWorkflowStepExternalCatalog } = await import('./workflow-step-external-catalog.js');
const { provisionExactWorkflowProviderOperations } = await import(
  '../tools/tool-search-provider-sources.js'
);
const { digestSchema } = await import('../tools/tool-contract-store.js');
const {
  attachSemanticContract,
  capabilityManifestDigest,
} = await import('../runtime/harness/capability-manifest.js');
const {
  createCapabilityManifestStore,
  installCapabilityManifestStore,
} = await import('../runtime/harness/capability-manifest-store.js');
const {
  createHostCapabilityCatalogFactory,
  freezeCatalogSnapshotForPlanAdmission,
  freezeCatalogSnapshotForSource,
  installHostCapabilityCatalogFactory,
} = await import('../runtime/harness/host-capability-catalog-factory.js');
const { withAcceptedSourceCatalogManifestScope } = await import(
  '../runtime/harness/accepted-source-catalog-scope.js'
);
const { appendEvent, createSession, resetEventLog } = await import('../runtime/harness/eventlog.js');
const {
  clearIndependentCapabilityObservations,
  independentlyObserveCapability,
  observationIsFresh,
} = await import('../runtime/harness/independent-capability-observation.js');
import type { CapabilityManifestV1 } from '../runtime/harness/capability-manifest.js';
import type { RegisteredHostCapability } from '../runtime/harness/host-capability-catalog-factory.js';
import type { RevalidatedComposioDefinition } from '../integrations/composio/selected-definition-revalidation.js';
import type { TurnGraphIR } from '../runtime/graph/turn-graph-ir.js';

test.after(() => {
  installHostCapabilityCatalogFactory(null);
  installCapabilityManifestStore(null);
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function manifest(operationId: string, effect: 'read' | 'external_write'): CapabilityManifestV1 {
  const inputDigest = digest(`input:${operationId}`);
  const outputDigest = digest(`output:${operationId}`);
  return attachSemanticContract({
    version: 1,
    manifestId: `cap:resolved:${operationId.toLowerCase()}`,
    providerKind: 'composio',
    operationId,
    providerIdentity: 'composio.test',
    providerVersion: 'composio-runtime-v1',
    operationVersion: 'v20260826_00',
    definitionFingerprint: digest(`definition:${operationId}`),
    externalDefinition: {
      version: 1,
      providerInputSchemaDigest: inputDigest,
      providerOutputSchemaObserved: true,
      providerOutputSchemaDigest: outputDigest,
      semanticName: operationId,
      behaviorHints: {
        readOnly: effect === 'read',
        destructive: false,
        idempotent: effect === 'read',
        openWorld: false,
      },
    },
    effect,
    accountId: `account:${operationId.split('_')[0]!.toLowerCase()}`,
    idempotency: effect === 'read'
      ? { required: false, policy: 'none' }
      : { required: true, policy: 'key_before_dispatch' },
    reconciliation: effect === 'read'
      ? { supported: false, policy: 'none' }
      : { supported: true, policy: 'exact_artifact' },
    outputContract: { kind: effect === 'read' ? 'records' : 'updated_resource' },
    evidenceContract: {
      kinds: effect === 'read' ? ['records'] : ['receipt', 'readback'],
      readbackRequired: effect !== 'read',
    },
    provenance: { issuer: 'host:test', issuedAt: '2026-08-31T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: effect === 'read' ? ['source'] : ['destination'],
  });
}

function registered(
  value: CapabilityManifestV1,
  crossings: Map<string, number>,
): RegisteredHostCapability {
  return {
    capabilityId: value.manifestId,
    toolName: value.operationId,
    schemaVersion: value.operationVersion,
    schemaDigest: value.definitionFingerprint,
    effect: value.effect,
    destination: value.destination,
    account: value.accountId,
    advisoryRoles: value.advisoryRoles,
    manifestDigest: capabilityManifestDigest(value),
    providerKind: value.providerKind,
    providerInputSchemaDigest: value.externalDefinition?.providerInputSchemaDigest,
    liveFingerprint: value.definitionFingerprint,
    manifest: value,
    invoke: async () => {
      crossings.set(value.operationId, (crossings.get(value.operationId) ?? 0) + 1);
      return { records: [{ operation: value.operationId }] };
    },
  };
}

function revalidated(value: CapabilityManifestV1): RevalidatedComposioDefinition {
  return {
    identifier: value.operationId,
    schemaDigest: value.externalDefinition!.providerInputSchemaDigest,
    accountIdentity: value.accountId,
    definitionFingerprint: value.definitionFingerprint,
    outputSchemaDigest: value.externalDefinition!.providerOutputSchemaDigest ?? null,
    providerOperationVersion: value.operationVersion,
    invokePortId: value.invokePortId,
    schema: { type: 'object' },
    fingerprint: digest(`source-schema:${value.operationId}`),
    outputSchema: { type: 'object' },
  };
}

function graph(effectCeiling: 'read' | 'external_write'): TurnGraphIR {
  return {
    version: 1,
    identity: {
      sessionId: 'workflow:test',
      turn: 1,
      sourceUserSeq: 1,
      surface: 'workflow',
      inputHash: digest('input'),
    },
    compiler: { version: 'turn-graph-shadow-v2', policyHash: digest('policy'), graphHash: digest('graph') },
    policy: {} as TurnGraphIR['policy'],
    toolAuthority: { explicit: true, excludedToolNames: [] },
    classification: {
      messageIntent: 'action_request',
      confidence: 1,
      route: 'act',
      externalEffectRequested: effectCeiling === 'external_write',
      projectShaped: false,
      projectSignals: [],
      externalEffectKinds: [],
      multiItem: { detected: false, itemCount: 1, explicitParallelRequest: false, collectThenConstruct: false },
    },
    fastPath: 'single_action',
    effectCeiling,
    nodes: [],
    edges: [],
    diagnostics: { warnings: [] },
  };
}

test('restart-empty selected cache provisions every literal workflow read and excludes an unmentioned write', async () => {
  resetEventLog();
  clearIndependentCapabilityObservations();
  const sheets = manifest('GOOGLESHEETS_BATCH_GET', 'read');
  const slack = manifest('SLACK_FETCH_CONVERSATION_HISTORY', 'read');
  const laterDisclosedThreadRead = manifest(
    'SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION',
    'read',
  );
  const unmentionedWrite = manifest('GOOGLESHEETS_VALUES_UPDATE', 'external_write');
  const store = createCapabilityManifestStore([sheets, slack, unmentionedWrite]);
  installCapabilityManifestStore(store);

  const crossings = new Map<string, number>();
  // Cold restart shape: neither selected read is in the process factory. An
  // unrelated operation from another session may still be present and must
  // not leak into this workflow source's frozen catalog.
  const factory = createHostCapabilityCatalogFactory([
    registered(unmentionedWrite, crossings),
  ]);
  installHostCapabilityCatalogFactory(factory);
  assert.equal(factory.get(sheets.manifestId), undefined);
  assert.equal(factory.get(slack.manifestId), undefined);

  const session = createSession({ kind: 'workflow', userId: 'workflow:test' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'immutable workflow step' },
  });

  const prepared = await prepareWorkflowStepExternalCatalog({
    immutablePrompt: [
      'Read the exact ranges with GOOGLESHEETS_BATCH_GET.',
      'Review the channel with SLACK_FETCH_CONVERSATION_HISTORY.',
      'For selected threads use SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION.',
    ].join(' '),
    allowedTools: ['*'],
    acceptedSource: {
      sessionId: session.id,
      sourceUserSeq: source.seq,
      acceptedInput: 'immutable workflow step',
    },
  }, {
    manifestStore: store,
    catalogFactory: factory,
    provisionExactOperations: async ({ operationIds }) => {
      assert.deepEqual(operationIds, [laterDisclosedThreadRead.operationId]);
      assert.equal(store.install(laterDisclosedThreadRead).ok, true);
      return { ok: true };
    },
    revalidate: async (selections) => {
      assert.deepEqual(
        selections.map((entry) => entry.identifier).sort(),
        [
          'GOOGLESHEETS_BATCH_GET',
          'SLACK_FETCH_CONVERSATION_HISTORY',
          'SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION',
        ],
      );
      return {
        ok: true,
        definitions: new Map([
          [sheets.operationId.toLowerCase(), revalidated(sheets)],
          [slack.operationId.toLowerCase(), revalidated(slack)],
          [laterDisclosedThreadRead.operationId.toLowerCase(), revalidated(laterDisclosedThreadRead)],
        ]),
      };
    },
    refresh: (manifestIds) => {
      for (const id of manifestIds) {
        const exact = store.get(id);
        assert.ok(exact);
        factory.register(registered(exact!.manifest, crossings));
      }
    },
    ready: () => true,
  });
  assert.equal(prepared.status, 'ready');
  if (prepared.status !== 'ready') return;
  assert.deepEqual(prepared.operationIds, [
    'GOOGLESHEETS_BATCH_GET',
    'SLACK_FETCH_CONVERSATION_HISTORY',
    'SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION',
  ]);

  const scopedCatalogs = await withAcceptedSourceCatalogManifestScope({
    manifestIds: prepared.manifestIds,
    operationIds: prepared.operationIds,
  }, async () => {
    const initial = freezeCatalogSnapshotForSource({ sessionId: session.id, sourceUserSeq: source.seq });
    const admitted = freezeCatalogSnapshotForPlanAdmission({
      sessionId: session.id,
      sourceUserSeq: source.seq,
    });
    return { initial, admitted };
  });
  assert.equal(scopedCatalogs.initial.ok, true);
  if (!scopedCatalogs.initial.ok) return;
  assert.deepEqual(
    scopedCatalogs.initial.entries.map((entry) => entry.manifest?.operationId).sort(),
    [
      'GOOGLESHEETS_BATCH_GET',
      'SLACK_FETCH_CONVERSATION_HISTORY',
      'SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION',
    ],
  );
  assert.equal(scopedCatalogs.admitted.ok, true);
  if (!scopedCatalogs.admitted.ok) return;
  const frozen = scopedCatalogs.admitted;
  assert.deepEqual(
    frozen.entries.map((entry) => entry.manifest?.operationId).sort(),
    [
      'GOOGLESHEETS_BATCH_GET',
      'SLACK_FETCH_CONVERSATION_HISTORY',
      'SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION',
    ],
  );

  for (const read of [sheets, slack]) {
    const bound = frozen.catalog.bind({
      node: {
        id: `read:${read.operationId}`,
        kind: 'execute',
        effect: {
          kind: 'read', certainty: 'exact', reversibility: 'read_only',
          idempotency: 'not_required', receipt: 'evidence_ref',
        },
        capabilities: [{ kind: 'tool', resolution: 'explicit', names: [read.manifestId] }],
      },
      graph: graph('read'),
      acceptedText: 'immutable workflow step',
    });
    assert.ok(bound, `${read.operationId} must bind from the exact frozen catalog`);
    await bound!.invoke({
      nodeId: `read:${read.operationId}`,
      role: 'source',
      payload: {},
      identity: { sessionId: session.id, sourceUserSeq: source.seq, acceptedTaskId: 'workflow-task' },
      binding: bound!,
    });
  }
  assert.equal(crossings.get('GOOGLESHEETS_BATCH_GET'), 1);
  assert.equal(crossings.get('SLACK_FETCH_CONVERSATION_HISTORY'), 1);

  const refusedWrite = frozen.catalog.bind({
    node: {
      id: 'write:unmentioned',
      kind: 'execute',
      effect: {
        kind: 'external_write', certainty: 'exact', reversibility: 'reversible',
        idempotency: 'required_before_dispatch', receipt: 'durable_effect_receipt',
      },
      capabilities: [{
        kind: 'tool', resolution: 'explicit', names: [unmentionedWrite.manifestId],
      }],
    },
    graph: graph('external_write'),
    acceptedText: 'immutable workflow step',
  });
  assert.equal(refusedWrite, null, 'a cached but unmentioned write must not enter the source catalog');
  assert.equal(crossings.get('GOOGLESHEETS_VALUES_UPDATE') ?? 0, 0);
});

test('Platform49 preflight provisions its missing Slack read and Sheets write without admitting a prohibited write', async () => {
  resetEventLog();
  clearIndependentCapabilityObservations();
  const sheetsRead = manifest('GOOGLESHEETS_BATCH_GET', 'read');
  const sheetsUpdate = manifest('GOOGLESHEETS_BATCH_UPDATE', 'external_write');
  const slackHistory = manifest('SLACK_FETCH_CONVERSATION_HISTORY', 'read');
  const slackUser = manifest('SLACK_RETRIEVE_DETAILED_USER_INFORMATION', 'read');
  const sheetsInsert = manifest('GOOGLESHEETS_INSERT_DIMENSION', 'external_write');
  const prohibitedWrite = manifest('GOOGLESHEETS_VALUES_UPDATE', 'external_write');
  const store = createCapabilityManifestStore([
    sheetsRead,
    sheetsUpdate,
    slackHistory,
    prohibitedWrite,
  ]);
  const crossings = new Map<string, number>();
  const factory = createHostCapabilityCatalogFactory();
  const acceptedInput = 'immutable Platform49 workflow step';
  const session = createSession({ kind: 'workflow', userId: 'workflow:platform49' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: acceptedInput },
  });
  let provisionCalls = 0;
  const allSelected = [
    sheetsRead,
    sheetsUpdate,
    sheetsInsert,
    slackHistory,
    slackUser,
  ];

  const result = await prepareWorkflowStepExternalCatalog({
    immutablePrompt: [
      'Review channel history with SLACK_FETCH_CONVERSATION_HISTORY.',
      'Resolve every author with SLACK_RETRIEVE_DETAILED_USER_INFORMATION.',
      'Read tracker state with GOOGLESHEETS_BATCH_GET.',
      'Do NOT follow up with a copyPaste / PASTE_FORMAT request: the available GOOGLESHEETS_BATCH_UPDATE action writes VALUES ONLY (use it for reviewed tracker row and digest value updates).',
      'Insert the required dimension with GOOGLESHEETS_INSERT_DIMENSION.',
      'Do not call GOOGLESHEETS_VALUES_UPDATE.',
      'Also ignore UNKNOWNAPP_DO_DANGEROUS_THING.',
    ].join(' '),
    // Permission is not positive intent: the negative-only VALUES_UPDATE must
    // remain absent even though the immutable allow-list names it exactly.
    allowedTools: allSelected.map((entry) => entry.operationId).concat(
      prohibitedWrite.operationId,
      'UNKNOWNAPP_DO_DANGEROUS_THING',
    ),
    acceptedSource: {
      sessionId: session.id,
      sourceUserSeq: source.seq,
      acceptedInput,
    },
  }, {
    manifestStore: store,
    catalogFactory: factory,
    provisionExactOperations: async (input) => {
      provisionCalls += 1;
      assert.equal(input.sessionId, session.id);
      assert.equal(input.sourceUserSeq, source.seq);
      assert.equal(input.acceptedInput, acceptedInput);
      assert.deepEqual(input.operationIds, [
        'GOOGLESHEETS_INSERT_DIMENSION',
        'SLACK_RETRIEVE_DETAILED_USER_INFORMATION',
      ]);
      assert.equal(store.install(sheetsInsert).ok, true);
      assert.equal(store.install(slackUser).ok, true);
      return { ok: true };
    },
    revalidate: async (selections) => {
      assert.deepEqual(
        selections.map((selection) => selection.identifier).sort(),
        allSelected.map((entry) => entry.operationId).sort(),
      );
      return {
        ok: true,
        definitions: new Map(allSelected.map((entry) => [
          entry.operationId.toLowerCase(),
          revalidated(entry),
        ])),
      };
    },
    refresh: (manifestIds) => {
      for (const manifestId of manifestIds) {
        const installed = store.get(manifestId);
        assert.ok(installed);
        factory.register(registered(installed!.manifest, crossings));
      }
    },
    ready: () => true,
  });

  assert.equal(provisionCalls, 1);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.deepEqual(result.operationIds, allSelected.map((entry) => entry.operationId).sort());
  assert.equal(result.operationIds.filter((operation) => (
    operation === 'GOOGLESHEETS_BATCH_UPDATE'
  )).length, 1, 'the live explanatory negation must not hide its one positively described action');
  assert.equal(result.operationIds.includes(prohibitedWrite.operationId), false);
  assert.equal(result.operationIds.includes('UNKNOWNAPP_DO_DANGEROUS_THING'), false);
  assert.equal(factory.get(prohibitedWrite.manifestId), undefined);
});

test('exact workflow provisioner binds schema, account, and effect for reads and writes in one bounded set', async () => {
  resetEventLog();
  const acceptedInput = [
    'Use SLACK_RETRIEVE_DETAILED_USER_INFORMATION.',
    'Then use GOOGLESHEETS_INSERT_DIMENSION.',
  ].join(' ');
  const session = createSession({ kind: 'workflow', userId: 'workflow:exact-provider' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: acceptedInput },
  });
  const operationIds = [
    'SLACK_RETRIEVE_DETAILED_USER_INFORMATION',
    'GOOGLESHEETS_INSERT_DIMENSION',
  ];
  const schemas = new Map(operationIds.map((operationId) => [
    operationId,
    { type: 'object', properties: { operation: { const: operationId } } },
  ]));
  let resolutionEntries: Array<{
    identifier: string;
    accountIdentity?: string;
    effectClass: string;
  }> = [];
  let registeredIdentifiers: readonly string[] = [];
  let registeredDigests: readonly { identifier: string; schemaDigest: string }[] = [];

  const provisioned = await provisionExactWorkflowProviderOperations({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedInput,
    operationIds,
    deadlineAt: Date.now() + 10_000,
  }, {
    materializeExact: async ({ requests }) => [
      ...requests.map((request) => ({
        toolkit: request.toolkit,
        slug: request.slug,
        name: request.slug,
        score: 0,
        inputParameters: schemas.get(request.slug)!,
      })),
      // Even a loose provider/test adapter returning an extra mutation cannot
      // widen allowedIdentifiers beyond the immutable requested set.
      {
        toolkit: 'googlesheets',
        slug: 'GOOGLESHEETS_VALUES_UPDATE',
        name: 'GOOGLESHEETS_VALUES_UPDATE',
        score: 0,
        inputParameters: { type: 'object' },
      },
    ],
    freshConnections: async () => [
      {
        slug: 'slack',
        connectionId: 'ca_slack_owner',
        status: 'ACTIVE',
        accountEmail: 'owner@slack.example',
      },
      {
        slug: 'googlesheets',
        connectionId: 'ca_sheets_owner',
        status: 'ACTIVE',
        accountEmail: 'owner@sheets.example',
      },
    ],
    recordResolution: ({ entries }) => {
      resolutionEntries = entries.map((entry) => ({
        identifier: entry.identifier,
        accountIdentity: entry.accountIdentity,
        effectClass: entry.effectClass,
      }));
    },
    registerProof: async (_identity, options) => {
      registeredIdentifiers = options.allowedIdentifiers ?? [];
      registeredDigests = options.expectedSchemaDigests ?? [];
      return {
        registered: (options.allowedIdentifiers ?? []).map((identifier) => `cap:resolved:${identifier.toLowerCase()}`),
      };
    },
  });

  assert.deepEqual(provisioned, { ok: true });
  assert.deepEqual(resolutionEntries.sort((left, right) => left.identifier.localeCompare(right.identifier)), [
    {
      identifier: 'GOOGLESHEETS_INSERT_DIMENSION',
      accountIdentity: 'ca_sheets_owner',
      effectClass: 'write',
    },
    {
      identifier: 'SLACK_RETRIEVE_DETAILED_USER_INFORMATION',
      accountIdentity: 'ca_slack_owner',
      effectClass: 'read',
    },
  ]);
  assert.deepEqual(registeredIdentifiers, [...operationIds].sort());
  assert.deepEqual(registeredDigests, [...operationIds].sort().map((identifier) => ({
    identifier,
    schemaDigest: digestSchema(schemas.get(identifier)!),
  })));
});

test('exact workflow provisioner refuses an ambiguous account before recording or publishing proof', async () => {
  resetEventLog();
  const acceptedInput = 'Use SLACK_RETRIEVE_DETAILED_USER_INFORMATION.';
  const session = createSession({ kind: 'workflow', userId: 'workflow:ambiguous-account' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: acceptedInput },
  });
  let proofRecorded = false;
  let proofPublished = false;
  const result = await provisionExactWorkflowProviderOperations({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedInput,
    operationIds: ['SLACK_RETRIEVE_DETAILED_USER_INFORMATION'],
  }, {
    materializeExact: async () => [{
      toolkit: 'slack',
      slug: 'SLACK_RETRIEVE_DETAILED_USER_INFORMATION',
      name: 'SLACK_RETRIEVE_DETAILED_USER_INFORMATION',
      score: 0,
      inputParameters: { type: 'object' },
    }],
    freshConnections: async () => [
      {
        slug: 'slack', connectionId: 'ca_slack_a', status: 'ACTIVE',
        accountEmail: 'a@example.com',
      },
      {
        slug: 'slack', connectionId: 'ca_slack_b', status: 'ACTIVE',
        accountEmail: 'b@example.com',
      },
    ],
    recordResolution: () => { proofRecorded = true; },
    registerProof: async () => {
      proofPublished = true;
      return { registered: [] };
    },
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'account_selection_required');
  assert.deepEqual(result.choices, ['a@example.com', 'b@example.com']);
  assert.equal(proofRecorded, false);
  assert.equal(proofPublished, false);
});

test('workflow runner persists the accepted source before exact catalog provisioning', () => {
  const source = readFileSync(new URL('./workflow-runner.ts', import.meta.url), 'utf8');
  const anchor = source.indexOf('const message = workflowMessageWithAnsweredInput');
  const acceptedSource = source.indexOf('const sourceUserEvent = recordRunAttemptUserInput', anchor);
  const preparation = source.indexOf('const preparedExternalCatalog = await prepareWorkflowStepExternalCatalog', anchor);
  assert.ok(anchor >= 0 && acceptedSource > anchor && preparation > acceptedSource);
  assert.match(
    source.slice(preparation, preparation + 700),
    /sourceUserSeq:\s*sourceUserEvent\.seq[\s\S]*acceptedInput:\s*message/,
  );
});

test('literal slugs are extracted from backticks, bold, parentheses, list items, and trailing punctuation', async () => {
  // Authored SKILL bodies are markdown: slugs arrive fenced in backticks,
  // bolded, parenthesised, namespaced with a colon, and followed by commas or
  // full stops. Every one of those must reach the exact-operation set, or the
  // frozen catalog silently lacks an operation the step names — the shape of
  // a run that refused the same read fifteen times before an opaque terminal.
  resetEventLog();
  clearIndependentCapabilityObservations();
  const ops = [
    manifest('SLACK_FETCH_CONVERSATION_HISTORY', 'read'),
    manifest('SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION', 'read'),
    manifest('SLACK_RETRIEVE_DETAILED_USER_INFORMATION', 'read'),
    manifest('GOOGLESHEETS_BATCH_GET', 'read'),
    manifest('GOOGLESHEETS_INSERT_DIMENSION', 'external_write'),
    manifest('GOOGLESHEETS_BATCH_UPDATE', 'external_write'),
  ];
  const store = createCapabilityManifestStore(ops);
  const factory = createHostCapabilityCatalogFactory();
  const crossings = new Map<string, number>();
  const result = await prepareWorkflowStepExternalCatalog({
    immutablePrompt: [
      '## step: main',
      '',
      '1. PULL — call `SLACK_FETCH_CONVERSATION_HISTORY` (channel + limit 100).',
      '2. THREADS: for each reply_count>0 use **SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION**.',
      '3. NAMES. Resolve ids via composio:SLACK_RETRIEVE_DETAILED_USER_INFORMATION; fan out.',
      '4. BASELINE. GOOGLESHEETS_BATCH_GET, ranges [\'Log!A1:I500\'].',
      '5. WRITE (GOOGLESHEETS_INSERT_DIMENSION) one row at index 1, then',
      '   the values with `GOOGLESHEETS_BATCH_UPDATE`.',
    ].join('\n'),
    allowedTools: ['*'],
    acceptedSource: {
      sessionId: 'workflow:markdown-slugs',
      sourceUserSeq: 1,
      acceptedInput: 'immutable workflow source',
    },
  }, {
    manifestStore: store,
    catalogFactory: factory,
    provisionExactOperations: async () => {
      assert.fail('every named operation already has a current manifest; nothing to provision');
    },
    revalidate: async () => ({
      ok: true,
      definitions: new Map(ops.map((entry) => [entry.operationId.toLowerCase(), revalidated(entry)])),
    }),
    refresh: (manifestIds) => {
      for (const manifestId of manifestIds) {
        factory.register(registered(store.get(manifestId)!.manifest, crossings));
      }
    },
    ready: () => true,
  });
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.deepEqual(result.operationIds, ops.map((entry) => entry.operationId).sort());
});

test('a literal slug still absent after provisioning refuses naming that operation — never ready with a subset', async () => {
  // The failure shape behind fifteen silent refusals: two named reads were
  // missing, provisioning came back ok having installed only one, and the
  // step must NOT proceed with the operations it happens to have.
  resetEventLog();
  clearIndependentCapabilityObservations();
  const present = manifest('SLACK_FETCH_CONVERSATION_HISTORY', 'read');
  const provisionedRead = manifest('GOOGLESHEETS_BATCH_GET', 'read');
  const store = createCapabilityManifestStore([present]);
  let provisionCalls = 0;
  const result = await prepareWorkflowStepExternalCatalog({
    immutablePrompt: [
      'Pull with `SLACK_FETCH_CONVERSATION_HISTORY`.',
      'Resolve authors with `SLACK_RETRIEVE_DETAILED_USER_INFORMATION`.',
      'Read the tracker with `GOOGLESHEETS_BATCH_GET`.',
    ].join(' '),
    allowedTools: ['*'],
    acceptedSource: {
      sessionId: 'workflow:partial-provision',
      sourceUserSeq: 1,
      acceptedInput: 'immutable workflow source',
    },
  }, {
    manifestStore: store,
    catalogFactory: createHostCapabilityCatalogFactory(),
    provisionExactOperations: async ({ operationIds }) => {
      provisionCalls += 1;
      assert.deepEqual(operationIds, ['GOOGLESHEETS_BATCH_GET', 'SLACK_RETRIEVE_DETAILED_USER_INFORMATION']);
      assert.equal(store.install(provisionedRead).ok, true);
      return { ok: true };
    },
    revalidate: async () => {
      assert.fail('a subset must refuse before revalidation');
    },
  });
  assert.equal(provisionCalls, 1);
  assert.deepEqual(result, {
    status: 'refused',
    reason: 'exact_operation_manifest_missing_after_provision',
    operationId: 'SLACK_RETRIEVE_DETAILED_USER_INFORMATION',
  });
});

test('preflight cannot report ready when exact provisioning returns without installing the manifest', async () => {
  const result = await prepareWorkflowStepExternalCatalog({
    immutablePrompt: 'Use SLACK_RETRIEVE_DETAILED_USER_INFORMATION.',
    allowedTools: ['*'],
    acceptedSource: {
      sessionId: 'workflow:missing-manifest',
      sourceUserSeq: 1,
      acceptedInput: 'immutable workflow source',
    },
  }, {
    manifestStore: createCapabilityManifestStore(),
    catalogFactory: createHostCapabilityCatalogFactory(),
    provisionExactOperations: async () => ({ ok: true }),
    revalidate: async () => {
      assert.fail('an absent exact manifest must refuse before revalidation');
    },
  });
  assert.deepEqual(result, {
    status: 'refused',
    reason: 'exact_operation_manifest_missing_after_provision',
    operationId: 'SLACK_RETRIEVE_DETAILED_USER_INFORMATION',
  });
});

test('cold restart publishes provider-revalidated identity before scoped typed readiness', async () => {
  clearIndependentCapabilityObservations();
  const sheets = manifest('GOOGLESHEETS_BATCH_GET', 'read');
  const store = createCapabilityManifestStore([sheets]);
  const crossings = new Map<string, number>();
  const factory = createHostCapabilityCatalogFactory();
  let observedBeforeRefresh = false;

  const result = await prepareWorkflowStepExternalCatalog({
    immutablePrompt: 'Read the exact ranges with GOOGLESHEETS_BATCH_GET.',
    allowedTools: ['*'],
  }, {
    manifestStore: store,
    catalogFactory: factory,
    revalidate: async () => ({
      ok: true,
      definitions: new Map([
        [sheets.operationId.toLowerCase(), revalidated(sheets)],
      ]),
    }),
    refresh: (manifestIds) => {
      assert.deepEqual(manifestIds, [sheets.manifestId]);
      const observed = independentlyObserveCapability(
        sheets.operationId,
        sheets.accountId,
      );
      observedBeforeRefresh = Boolean(
        observed
        && observed.origin === 'independent'
        && observationIsFresh(observed)
        && observed.definitionFingerprint === sheets.definitionFingerprint
        && observed.providerVersion === sheets.providerVersion
        && observed.operationVersion === sheets.operationVersion
        && observed.accountId === sheets.accountId,
      );
      if (observedBeforeRefresh) factory.register(registered(sheets, crossings));
    },
    ready: () => observedBeforeRefresh,
  });

  assert.equal(observedBeforeRefresh, true,
    'the provider revalidation must seed exact independent readiness before refresh');
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.deepEqual(result.manifestIds, [sheets.manifestId]);
  assert.deepEqual(result.operationIds, [sheets.operationId]);
  assert.equal(result.catalogIdentities.length, 1);
  assert.equal(result.catalogIdentities[0]?.manifestId, sheets.manifestId);
  assert.equal(result.catalogIdentities[0]?.operationId, sheets.operationId);
});

test('rendered workflow data cannot nominate an external operation', async () => {
  const sheets = manifest('GOOGLESHEETS_BATCH_GET', 'read');
  const store = createCapabilityManifestStore([sheets]);
  const result = await prepareWorkflowStepExternalCatalog({
    immutablePrompt: 'Summarize the bound input without using external tools.',
    allowedTools: ['*', 'GOOGLESHEETS_*', 'composio_execute_tool'],
  }, {
    manifestStore: store,
    catalogFactory: createHostCapabilityCatalogFactory(),
    revalidate: async () => {
      assert.fail('no provider metadata call is allowed without an immutable operation literal');
    },
    refresh: () => assert.fail('no catalog refresh is allowed'),
    ready: () => false,
  });
  assert.deepEqual(result, { status: 'none' });
});

test('exact workflow provisioner reports a requested operation that did not register as a refusal, never ok', async () => {
  resetEventLog();
  const acceptedInput = 'Use SLACK_RETRIEVE_DETAILED_USER_INFORMATION.';
  const session = createSession({ kind: 'workflow', userId: 'workflow:exact-provider-unregistered' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: acceptedInput },
  });
  // Live 2026-09-01 (JIT read edge): the proof publisher skipped a manifest the
  // durable store refused, returned an empty registration with no refusal, and
  // the provisioner answered ok — the host re-checked the same empty catalog and
  // the turn died as a no-progress internal error beside a log line saying ok.
  const result = await provisionExactWorkflowProviderOperations({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedInput,
    operationIds: ['SLACK_RETRIEVE_DETAILED_USER_INFORMATION'],
  }, {
    materializeExact: async () => [{
      toolkit: 'slack',
      slug: 'SLACK_RETRIEVE_DETAILED_USER_INFORMATION',
      name: 'SLACK_RETRIEVE_DETAILED_USER_INFORMATION',
      score: 0,
      inputParameters: { type: 'object' },
    }],
    freshConnections: async () => [{
      slug: 'slack', connectionId: 'ca_slack_only', status: 'ACTIVE', accountEmail: 'only@example.com',
    }],
    recordResolution: () => {},
    registerProof: async () => ({ registered: [] }),
  });
  assert.deepEqual(result, {
    ok: false,
    code: 'proof_provisioning_refused',
    identifier: 'SLACK_RETRIEVE_DETAILED_USER_INFORMATION',
    detail: 'not_registered',
  });
});

// Live 2026-09-01: scorpion-facebook-trends' first step listed
// composio_search_tools under allowedTools; the extractor uppercased it into a
// phantom COMPOSIO_SEARCH_TOOLS "operation", provisioning refused it, and the
// run parked on a capability block that named nothing real.
test('lowercase local tool names in allowedTools and platform-plane tokens are not provider operations', async () => {
  resetEventLog();
  clearIndependentCapabilityObservations();
  const store = createCapabilityManifestStore([]);
  const factory = createHostCapabilityCatalogFactory();
  const result = await prepareWorkflowStepExternalCatalog({
    immutablePrompt: 'Find the official page. Use COMPOSIO_SEARCH_TOOLS to discover the exact scrape operation, then scrape it.',
    allowedTools: ['composio_execute_tool', 'composio_search_tools'],
    acceptedSource: {
      sessionId: 'workflow:local-tool-names',
      sourceUserSeq: 1,
      acceptedInput: 'immutable workflow source',
    },
  }, {
    manifestStore: store,
    catalogFactory: factory,
    provisionExactOperations: async () => {
      assert.fail('a local tool name or a platform-plane token must never be provisioned as a provider operation');
    },
    revalidate: async () => ({ ok: true, definitions: new Map() }),
    refresh: () => {},
  });
  assert.equal(result.status, 'none', JSON.stringify(result));
});

test('a label-only operation-version move re-provisions the stored manifest as its recorded successor before observation', async () => {
  resetEventLog();
  clearIndependentCapabilityObservations();
  const stored = manifest('OUTLOOK_LIST_EVENTS', 'read');
  // Same definition (input/output schema digests identical), new provider label.
  const successor: CapabilityManifestV1 = attachSemanticContract({
    ...stored,
    manifestId: `${stored.manifestId}:successor`,
    operationVersion: 'v20260901_03',
    definitionFingerprint: digest('definition:OUTLOOK_LIST_EVENTS:relabeled'),
    delegatedFrom: stored.manifestId,
  });
  const store = createCapabilityManifestStore([stored]);
  installCapabilityManifestStore(store);
  const crossings = new Map<string, number>();
  const factory = createHostCapabilityCatalogFactory([]);
  installHostCapabilityCatalogFactory(factory);

  const session = createSession({ kind: 'workflow', userId: 'workflow:test' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'daily standup' },
  });

  let revalidations = 0;
  let provisioned = 0;
  const prepared = await prepareWorkflowStepExternalCatalog({
    immutablePrompt: "Pull today's calendar with OUTLOOK_LIST_EVENTS.",
    allowedTools: ['*'],
    acceptedSource: { sessionId: session.id, sourceUserSeq: source.seq, acceptedInput: 'daily standup' },
  }, {
    manifestStore: store,
    catalogFactory: factory,
    provisionExactOperations: async ({ operationIds }) => {
      provisioned += 1;
      assert.deepEqual(operationIds, ['OUTLOOK_LIST_EVENTS']);
      // What exact provisioning does for a relabeled definition: install the
      // live definition as the recorded successor of the stored manifest.
      assert.equal(store.supersede(stored.manifestId, successor).ok, true);
      return { ok: true };
    },
    revalidate: async (selections) => {
      revalidations += 1;
      assert.equal(selections.length, 1);
      const selection = selections[0]!;
      if (selection.definitionFingerprint === stored.definitionFingerprint) {
        // The provider reports the new label for byte-identical schemas.
        return {
          ok: true,
          definitions: new Map([[stored.operationId.toLowerCase(), {
            ...revalidated(stored),
            providerOperationVersion: successor.operationVersion,
            definitionFingerprint: successor.definitionFingerprint,
            reboundFrom: {
              providerOperationVersion: stored.operationVersion,
              definitionFingerprint: stored.definitionFingerprint,
            },
          }]]),
        };
      }
      assert.equal(selection.definitionFingerprint, successor.definitionFingerprint, 'the successor is what gets revalidated second');
      return { ok: true, definitions: new Map([[successor.operationId.toLowerCase(), revalidated(successor)]]) };
    },
    refresh: (manifestIds) => {
      for (const id of manifestIds) {
        const exact = store.get(id);
        assert.ok(exact);
        factory.register(registered(exact!.manifest, crossings));
      }
    },
    ready: () => true,
  });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  if (prepared.status !== 'ready') return;
  assert.deepEqual(prepared.operationIds, ['OUTLOOK_LIST_EVENTS']);
  assert.deepEqual(prepared.manifestIds, [successor.manifestId]);
  assert.equal(provisioned, 1);
  assert.equal(revalidations, 2);
  assert.equal(store.get(stored.manifestId)?.manifest.lifecycle.state, 'superseded');
  assert.equal(store.get(successor.manifestId)?.manifest.lifecycle.state, 'current');
});
