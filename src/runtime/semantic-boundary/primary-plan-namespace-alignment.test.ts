/**
 * Run:
 *   node scripts/run-tests-isolated.mjs \
 *     src/runtime/semantic-boundary/primary-plan-namespace-alignment.test.ts
 *
 * A foreground plan may cite only exact disclosed refs, but exact identity is
 * not semantic fit. Live source 91257 named Outlook while tool_search exposed
 * Slack; plan_task then froze Slack because both operations were structurally
 * single reads. This pins the durable source-to-provider namespace boundary.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-primary-plan-namespace-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.COMPOSIO_BACKEND = 'sdk';

const semantic = await import('./admit-and-compile-accepted-source.js');
const namespaceAlignment = await import('./capability-namespace-alignment.js');
const eventlog = await import('../harness/eventlog.js');
const catalogs = await import('../harness/host-capability-catalog-factory.js');
const brackets = await import('../harness/brackets.js');
const production = await import('../harness/production-capability-adapters.js');
const providerSources = await import('../../tools/tool-search-provider-sources.js');
const schemaCache = await import('../../tools/composio-schema-cache.js');
const composio = await import('../../integrations/composio/client.js');
const { buildPlanTaskTool } = await import('../../tools/plan-tools.js');

const OUTLOOK_OPERATION = 'OUTLOOK_QUERY_EMAILS';
const SLACK_OPERATION = 'SLACK_FETCH_CONVERSATION_HISTORY';
const ACCEPTED_TEXT = 'Read the single most recent message in my Outlook Inbox and return only its subject and received time. This is read-only: do not send, draft, delete, move, mark, or modify anything.';
const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    folder: { type: 'string' },
    top: { type: 'integer' },
  },
};
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    value: { type: 'array', items: { type: 'object' } },
  },
};

type Invokable = {
  invoke: (runContext: unknown, input: string, details?: unknown) => Promise<unknown>;
};

let businessCrossings = 0;
let providerDefinitionRefreshes = 0;

after(() => {
  schemaCache._setToolSchemaLoaderForTests(null);
  schemaCache.resetToolSchemaCache();
  composio.__test__.setConnectedAccountsLoader(null);
  composio.__test__.setComposioApiKeyOverride(null);
  composio.resetComposioClient();
  production.installProductionTransport(null);
  catalogs.installHostCapabilityCatalogFactory(null);
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const GENERATED_NAMESPACES = [
  { version: 1 as const, namespaceId: 'nebula_mail', aliases: ['Nebula Mail', 'nebula'] },
  { version: 1 as const, namespaceId: 'quartz_chat', aliases: ['Quartz Chat', 'quartz'] },
];

test('NEGATIVE: a weekday in a calendar ask is not an explicit toolkit restriction', () => {
  const inventory = [
    ...GENERATED_NAMESPACES,
    { version: 1 as const, namespaceId: 'monday', aliases: ['Monday', 'Monday.com'] },
    { version: 1 as const, namespaceId: 'outlook', aliases: ['Outlook'] },
  ];
  assert.equal(
    namespaceAlignment.explicitCapabilityNamespaceConflict({
      acceptedText: "What's on my calendar Monday",
      namespaceInventory: inventory,
      selectedNamespaceIds: ['outlook'],
    }),
    null,
    'Monday-the-day cannot refuse an Outlook calendar read',
  );
  assert.deepEqual(
    namespaceAlignment.explicitCapabilityNamespaceConflict({
      acceptedText: 'Create a Monday.com board for this project',
      namespaceInventory: inventory,
      selectedNamespaceIds: ['outlook'],
    }),
    {
      requestedNamespaces: ['monday'],
      selectedNamespace: 'outlook',
    },
    'an explicit Monday.com mention still restricts',
  );
});

test('generic namespace guard abstains for neutral asks and admits exactly requested namespace sets', () => {
  assert.equal(namespaceAlignment.explicitCapabilityNamespaceConflict({
    acceptedText: 'Read the newest message from my connected mailbox.',
    namespaceInventory: GENERATED_NAMESPACES,
    selectedNamespaceIds: ['quartz_chat'],
  }), null, 'provider-neutral text does not invent a provider restriction');

  assert.equal(namespaceAlignment.explicitCapabilityNamespaceConflict({
    acceptedText: 'Read the newest Nebula Mail message.',
    namespaceInventory: GENERATED_NAMESPACES,
    selectedNamespaceIds: ['nebula_mail'],
  }), null, 'an exact generated namespace remains admitted for its explicit request');

  assert.equal(namespaceAlignment.explicitCapabilityNamespaceConflict({
    acceptedText: 'Read Nebula Mail, then post its subject to Quartz Chat.',
    namespaceInventory: GENERATED_NAMESPACES,
    selectedNamespaceIds: ['nebula_mail', 'quartz_chat'],
  }), null, 'a request that explicitly names multiple generated namespaces may select all');
});

test('generic namespace guard rejects an extra selected namespace regardless of descriptor order', () => {
  assert.deepEqual(namespaceAlignment.explicitCapabilityNamespaceConflict({
    acceptedText: 'Read the newest Nebula message.',
    namespaceInventory: [...GENERATED_NAMESPACES].reverse(),
    selectedNamespaceIds: ['quartz_chat'],
  }), {
    requestedNamespaces: ['nebula_mail'],
    selectedNamespace: 'quartz_chat',
  });
  assert.deepEqual(namespaceAlignment.explicitCapabilityNamespaceConflict({
    acceptedText: 'Read the newest Nebula message.',
    namespaceInventory: GENERATED_NAMESPACES,
    selectedNamespaceIds: ['nebula_mail', 'quartz_chat'],
  }), {
    requestedNamespaces: ['nebula_mail'],
    selectedNamespace: 'quartz_chat',
  }, 'adding one valid namespace cannot launder an extra selected namespace');
  assert.deepEqual(namespaceAlignment.explicitCapabilityNamespaceConflict({
    acceptedText: 'Read the newest Nebula message.',
    namespaceInventory: GENERATED_NAMESPACES,
    selectedNamespaceIds: ['unresolved_provider_namespace'],
  }), {
    requestedNamespaces: ['nebula_mail'],
    selectedNamespace: 'unresolved_provider_namespace',
  }, 'an explicit provider request cannot be satisfied by an unresolvable selected namespace');
});

test('plan_task refuses the live-shaped Outlook-plus-Slack plan before publication or graph authority', async () => {
  eventlog.resetEventLog();
  schemaCache.resetToolSchemaCache();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  businessCrossings = 0;
  providerDefinitionRefreshes = 0;
  production.installProductionTransport(async () => {
    businessCrossings += 1;
    throw new Error('namespace admission test forbids business execution');
  });
  schemaCache._setToolSchemaLoaderForTests(async () => {
    providerDefinitionRefreshes += 1;
    throw new Error('namespace conflict must refuse before selected-definition refresh');
  });
  composio.resetComposioClient();
  composio.__test__.setComposioApiKeyOverride('namespace-fixture-key');
  composio.__test__.setConnectedAccountsLoader(async () => ([
    {
      id: 'ca_outlook_namespace_fixture',
      status: 'ACTIVE',
      user_id: 'namespace-fixture-user',
      toolkit: { slug: 'outlook' },
    },
    {
      id: 'ca_slack_namespace_fixture',
      status: 'ACTIVE',
      user_id: 'namespace-fixture-user',
      toolkit: { slug: 'slack' },
    },
  ]));

  const session = eventlog.createSession({
    id: 'primary-plan-outlook-slack-namespace-conflict',
    kind: 'chat',
  });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: ACCEPTED_TEXT },
  });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;

  const observedAt = Date.now();
  for (const operation of [OUTLOOK_OPERATION, SLACK_OPERATION]) {
    schemaCache.rememberToolSchema(
      operation,
      INPUT_SCHEMA,
      observedAt,
      `fixture-${operation.toLowerCase()}-v1`,
      OUTPUT_SCHEMA,
    );
  }
  const candidates = [OUTLOOK_OPERATION, SLACK_OPERATION].map((name) => ({
    name,
    carrier: 'work_call' as const,
    sourceKind: 'authorized_composio' as const,
    schema: INPUT_SCHEMA,
  }));
  await providerSources.stageDisclosedPlanningProviderCandidates({
    ...identity,
    candidates,
  });
  const refs = await semantic.disclosePrimaryModelPlanningCapabilities({
    authority: primed.planning.authority,
    candidates,
  });
  assert.equal(refs[OUTLOOK_OPERATION], `cap:resolved:${OUTLOOK_OPERATION.toLowerCase()}`);
  assert.equal(refs[SLACK_OPERATION], `cap:resolved:${SLACK_OPERATION.toLowerCase()}`);
  // Exact staging is allowed to refresh the provider definition. The
  // namespace assertion below is specifically about the later plan-admission
  // refusal, so establish its own counter baseline after disclosure finishes.
  providerDefinitionRefreshes = 0;

  const planTask = buildPlanTaskTool({ planning: primed.planning }) as unknown as Invokable;
  const deliveredPreambles: string[] = [];
  const callId = 'plan-outlook-with-extra-slack';
  const output = String(await brackets.withHarnessRunContext({
    ...identity,
    counter: new brackets.ToolCallsCounter(10),
    behaviorScopeId: `${identity.sessionId}::${callId}`,
    onConversationPreamble: async (request) => {
      deliveredPreambles.push(request.text);
      return { status: 'already_delivered' as const };
    },
  }, () => planTask.invoke(null, JSON.stringify({
    preamble: 'I’m reading the newest Outlook message now.',
    draft: {
      criteria: [
        'Return only the subject and received time of the newest Outlook Inbox message.',
        'Perform no writes or message modifications.',
      ],
      cardinality: { count: 1, fields: ['subject', 'received_time'] },
      destination: null,
      topology: {
        version: 1,
        operations: [
          {
            id: 'read_latest_outlook',
            effect: 'read',
            coverage: 'single',
            dependsOn: [],
            dataFrom: [],
            cardinality: { kind: 'once' },
          },
          {
            id: 'read_unrequested_slack',
            effect: 'read',
            coverage: 'single',
            dependsOn: [],
            dataFrom: [],
            cardinality: { kind: 'once' },
          },
        ],
        universes: [],
      },
      bindings: [
        {
          operationId: 'read_latest_outlook',
          role: 'source',
          capabilityRef: refs[OUTLOOK_OPERATION],
          evidence: ['latest_outlook_message'],
        },
        {
          operationId: 'read_unrequested_slack',
          role: 'source',
          capabilityRef: refs[SLACK_OPERATION],
          evidence: ['unrequested_slack_history'],
        },
      ],
      deliverables: [{ id: 'latest_message', kind: 'message_subject_received_time' }],
      evidenceRequirements: ['latest_outlook_message'],
    },
  }), { toolCall: { callId } })));

  const body = JSON.parse(output) as {
    ok?: boolean;
    code?: string;
    detail?: string;
    admissibleCapabilities?: Array<{ capabilityRef?: string; effect?: string; purpose?: string }>;
  };
  assert.deepEqual({ ok: body.ok, code: body.code }, {
    ok: false,
    code: 'plan_not_admitted',
  }, output);
  assert.equal(
    body.detail,
    'selected_capability_namespace_conflict:requested_namespaces=outlook:selected_namespace=slack',
  );
  assert.deepEqual(
    new Set(body.admissibleCapabilities?.map((entry) => entry.capabilityRef)),
    new Set([refs[OUTLOOK_OPERATION], refs[SLACK_OPERATION]]),
    'a refusal returns the exact bounded citable refs the host already holds',
  );
  assert.ok(body.admissibleCapabilities?.every((entry) => (
    entry.effect === 'read'
    && typeof entry.purpose === 'string'
    && entry.purpose.length > 0
  )));
  assert.equal(eventlog.getTurnGraphEventForSource(identity.sessionId, identity.sourceUserSeq), null);
  assert.equal(eventlog.listEvents(identity.sessionId, {
    types: ['accepted_task_authority_armed', 'conversation_preamble'],
  }).length, 0);
  assert.deepEqual(deliveredPreambles, []);
  assert.deepEqual(catalogs.peekHostCapabilityCatalogFactory()?.snapshot() ?? [], [],
    'a rejected namespace never publishes either selected provider definition');
  assert.equal(providerDefinitionRefreshes, 0,
    'the conflict refuses before selected provider definitions are refreshed');
  assert.equal(businessCrossings, 0);
});
