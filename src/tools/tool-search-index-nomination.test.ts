/**
 * Run: npx tsx src/tools/tool-search-index-nomination.test.ts
 *
 * Discovery must be able to reach a capability the provider's fuzzy search
 * cannot find.
 *
 * Live 2026-08-26, measured against the real account: asked "what's on my
 * calendar tomorrow", the Composio broker returned THIRTEEN candidates and not
 * one read — CREATE_CALENDAR_EVENT, CANCEL_CALENDAR_EVENT,
 * CREATE_CALENDAR_EVENT_ATTACHMENT_UPLOAD_SESSION. Rephrasing to "read calendar
 * events for a date range" returned five reads, every one wrong (DataForSEO
 * SERP tasks, Asana audit logs, GA conversions). `OUTLOOK_GET_CALENDAR_VIEW`
 * was never returned at any ranking.
 *
 * The same query against the local capability index returns it at rank one with
 * effect=read. So for that capability, index nomination is not an optimisation —
 * it is the only path that reaches it at all. Clem then asked which calendar,
 * having been handed a hard constraint naming the exact connection, and on the
 * Salesforce turn reported a five-month-old figure as "I can confirm".
 *
 * Reordering the broker's answer cannot fix this: an earlier attempt balanced
 * effects inside the returned window and passed six tests, because the fixture
 * put the desired read into its own input. This suite therefore drives the REAL
 * provider source — buildAuthorizedToolSearchCandidateSources — with a broker
 * whose fuzzy search returns only writes, exactly as production did.
 *
 * The index is ADVISORY. It may nominate an exact slug; it may not supply
 * schema, capabilityRef, catalog membership, or any authority. Every nomination
 * must survive a live exact lookup before it can become a candidate.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

// Fixture identities use the reserved .invalid TLD. A real address in source
// is a binding-directive violation on a public repo, and the CI hygiene gate
// now fails on personal-email-address — these values are opaque to every
// assertion below, so only their consistency matters.

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-index-nomination-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.COMPOSIO_BACKEND = 'sdk';

const composio = await import('../integrations/composio/client.js');
const providerSources = await import('./tool-search-provider-sources.js');
const capabilityIndex = await import('../memory/capability-index.js');
const schemaCache = await import('./composio-schema-cache.js');
const toolContracts = await import('./tool-contract-store.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const semantic = await import('../runtime/semantic-boundary/admit-and-compile-accepted-source.js');
const toolChoices = await import('../memory/tool-choice-store.js');
const composioTools = await import('./composio-tools.js');
const learningWorker = await import('../memory/learning-worker.js');
const { recordTurnGraphShadow } = await import('../runtime/graph/turn-graph-shadow.js');
const { ToolCallsCounter, withHarnessRunContext } = await import('../runtime/harness/brackets.js');

const CALENDAR_READ = 'OUTLOOK_GET_CALENDAR_VIEW';
const READ_SCHEMA = {
  type: 'object',
  required: ['calendarId'],
  properties: { calendarId: { type: 'string' }, startDateTime: { type: 'string' } },
};
const READ_OUTPUT = {
  type: 'object',
  required: ['value'],
  properties: { value: { type: 'array', items: { type: 'object' } } },
};

/** Exactly what the live broker returned for the calendar question. */
const FUZZY_WRITES = [
  'OUTLOOK_CREATE_CALENDAR_EVENT_ATTACHMENT_UPLOAD_SESSION',
  'OUTLOOK_CALENDAR_CREATE_EVENT',
  'OUTLOOK_CANCEL_CALENDAR_EVENT',
  'OUTLOOK_CANCEL_CALENDAR_GROUP_CALENDAR_EVENT',
  'OUTLOOK_CREATE_CALENDAR',
];

let exactLookups: string[] = [];
let providerToolCalls: Record<string, unknown>[] = [];

type ProviderBehaviour = {
  /** Slugs the exact-slug lookup will resolve. */
  exact?: readonly string[];
  /** Make the exact lookup hang past the aggregate deadline. */
  hang?: boolean;
  connections?: readonly Array<{
    id: string;
    toolkit: string;
    email?: string;
    status?: string;
    createdAt?: string;
  }>;
  exactToolkit?: string;
  exactInputSchema?: Record<string, unknown>;
  exactOutputSchema?: Record<string, unknown> | null;
  exactVersion?: string;
  omitExactOutput?: boolean;
  omitExactVersion?: boolean;
  fuzzyRows?: readonly Record<string, unknown>[];
  connectionDelayMs?: number;
  exactDelayMs?: number;
  fuzzyDelayMs?: number;
  afterFuzzyRequestStarted?: () => void;
  beforeFuzzyReturn?: () => void;
  afterExactRequestStarted?: () => void;
};

function installBroker(behaviour: ProviderBehaviour = {}): void {
  exactLookups = [];
  providerToolCalls = [];
  const exact = new Set((behaviour.exact ?? [CALENDAR_READ]).map((slug) => slug.toUpperCase()));
  composio.resetComposioClient();
  composio.__test__.setComposioApiKeyOverride('nomination-key');
  composio.__test__.setConnectedAccountsLoader(async () => {
    if (behaviour.connectionDelayMs) {
      await new Promise((resolve) => { setTimeout(resolve, behaviour.connectionDelayMs); });
    }
    return (
      behaviour.connections ?? [{ id: 'ca_outlook_primary', toolkit: 'outlook' }]
    ).map((connection) => ({
      id: connection.id,
      status: connection.status ?? 'ACTIVE',
      user_id: 'fixture-user',
      toolkit: { slug: connection.toolkit },
      ...(connection.createdAt ? { created_at: connection.createdAt } : {}),
      ...(connection.email ? { data: { user_info: { email: connection.email } } } : {}),
    }));
  });
  composio.__test__.setComposioClient({
    tools: {
      async getRawComposioTools(input: Record<string, unknown>) {
        providerToolCalls.push(structuredClone(input));
        const wanted = Array.isArray(input.tools) ? (input.tools as string[]) : [];
        if (wanted.length > 0) {
          // EXACT-SLUG path — this is the selection-grade lookup.
          exactLookups.push(...wanted);
          behaviour.afterExactRequestStarted?.();
          if (behaviour.exactDelayMs) {
            await new Promise((resolve) => { setTimeout(resolve, behaviour.exactDelayMs); });
          }
          if (behaviour.hang) {
            // Outlast the aggregate deadline, then settle so the test process
            // can exit. A truly never-settling promise would leak a handle and
            // mask what the deadline actually did.
            await new Promise((resolve) => { setTimeout(resolve, 6_000); });
          }
          return wanted
            .filter((slug) => exact.has(slug.toUpperCase()))
            .map((slug) => ({
              slug: slug.toUpperCase(),
              name: 'Get exact provider records',
              description: 'Read exact provider records.',
              toolkit: { slug: behaviour.exactToolkit ?? slug.split('_')[0]!.toLowerCase() },
              inputParameters: behaviour.exactInputSchema ?? READ_SCHEMA,
              ...(!behaviour.omitExactOutput
                ? {
                    outputParameters: behaviour.exactOutputSchema === undefined
                      ? READ_OUTPUT
                      : behaviour.exactOutputSchema,
                  }
                : {}),
              ...(!behaviour.omitExactVersion
                ? { version: behaviour.exactVersion ?? 'fixture-outlook-read-v1' }
                : {}),
            }));
        }
        // FUZZY path — writes only, exactly as production returned.
        behaviour.afterFuzzyRequestStarted?.();
        if (behaviour.fuzzyDelayMs) {
          await new Promise((resolve) => { setTimeout(resolve, behaviour.fuzzyDelayMs); });
        }
        behaviour.beforeFuzzyReturn?.();
        return behaviour.fuzzyRows ?? FUZZY_WRITES.map((slug) => ({
          slug,
          name: slug,
          description: 'Calendar mutation.',
          toolkit: { slug: 'outlook' },
          inputParameters: { type: 'object', properties: { subject: { type: 'string' } } },
          outputParameters: { type: 'object', properties: { ok: { type: 'boolean' } } },
          version: 'fixture-outlook-write-v1',
        }));
      },
      async execute() { throw new Error('discovery must never execute'); },
    },
  } as never);
}

function nominate(identifier: string, carrier = 'outlook'): void {
  capabilityIndex.recordCapabilityOperations([{
    identifier,
    carrierKind: 'composio',
    carrier,
    displayName: identifier,
    description: 'read events on a calendar for a day',
    effectClass: 'read',
    effectProvenance: 'inferred',
  }]);
}

async function composioCandidates(query: string, signal?: AbortSignal, deadlineAt?: number) {
  const sources = providerSources.buildAuthorizedToolSearchCandidateSources({
    reason: 'index nomination proof',
    authority: 'catalog',
    allowedServerSlugs: [],
    toolPatterns: [],
    maxTools: 0,
  } as never);
  const source = sources.find((entry) => entry.kind === 'authorized_composio');
  assert.ok(source, 'the composio candidate source must exist');
  return source!.search({ query, limit: 8, signal, deadlineAt });
}

async function learnCanonicalRead(input: {
  sessionId: string;
  phrase: string;
  operation: string;
  accountIdentity: string;
}): Promise<void> {
  const session = eventlog.createSession({
    id: input.sessionId,
    kind: 'chat',
    channel: 'home',
    title: input.phrase.slice(0, 60),
  });
  const attempt = eventlog.beginRunAttempt(session.id, {});
  const source = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: input.phrase, attemptId: attempt.attemptId, source: 'home' },
  }, { armRunInFlight: true });
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn },
  }), 'the canonical read fixture must persist accepted-task authority');
  schemaCache.rememberToolSchema(input.operation, {
    type: 'object',
    properties: {
      folder: { type: 'string' },
      top: { type: 'integer' },
    },
  }, Date.now());
  const output = await withHarnessRunContext({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: source.turn,
    counter: new ToolCallsCounter(100),
  }, () => composioTools.runComposioExecuteForTestInSession(
    input.operation,
    { folder: 'inbox', top: 1 },
    (async () => ({
      successful: true,
      data: { value: [{ subject: 'Fixture', receivedDateTime: '2026-08-27T12:00:00Z' }] },
    })) as never,
    session.id,
    input.accountIdentity,
  ));
  assert.ok(output.length > 0, 'the canonical read fixture must settle with data');
  await learningWorker.drainPendingLearning();
}

function addSearchAliasToCanonicalRead(operation: string, alias: string): void {
  const record = toolChoices.listToolChoices().find((candidate) => (
    candidate.choice?.identifier === operation
    && candidate.choice.verifiedReadOrigin
  ));
  assert.ok(record?.choice?.verifiedReadOrigin,
    `${operation} must have a receipt-backed origin before its search alias is attached`);
  toolChoices.rememberToolChoice({
    intent: record.intent,
    description: record.description,
    choice: { ...record.choice },
    schemaFingerprint: record.choice.schemaFingerprint,
    aliases: [alias],
  });
}

after(() => {
  schemaCache.resetToolSchemaCache();
  capabilityIndex._resetCapabilityIndexForTest();
  eventlog.resetEventLog();
  composio.__test__.setConnectedAccountsLoader(null);
  composio.__test__.setComposioApiKeyOverride(null);
  composio.resetComposioClient();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

async function runCausalPlanningDisclosure(input: {
  toolkit: string;
  operation: string;
  query: string;
  connectionId: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  operationVersion: string;
  connections?: ProviderBehaviour['connections'];
}) {
  schemaCache.resetToolSchemaCache();
  capabilityIndex._resetCapabilityIndexForTest();
  eventlog.resetEventLog();
  const fuzzySlug = `${input.toolkit.toUpperCase()}_CREATE_DISCOVERY_DECOY`;
  installBroker({
    exact: [input.operation],
    connections: input.connections ?? [{ id: input.connectionId, toolkit: input.toolkit }],
    exactToolkit: input.toolkit,
    exactInputSchema: input.inputSchema,
    exactOutputSchema: input.outputSchema,
    exactVersion: input.operationVersion,
    fuzzyRows: [{
      slug: fuzzySlug,
      name: 'Discovery decoy mutation',
      description: 'A provider mutation that does not answer this read request.',
      toolkit: { slug: input.toolkit },
      inputParameters: { type: 'object', properties: { title: { type: 'string' } } },
      outputParameters: { type: 'object', properties: { id: { type: 'string' } } },
      version: `fixture-${input.toolkit}-decoy-v1`,
    }],
  });

  const session = eventlog.createSession({
    id: `nomination-disclosure-${input.toolkit}`,
    kind: 'chat',
  });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: input.query },
  });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq };
  // Prime before the index row exists. That mirrors a fresh planning turn:
  // the later tool_search disclosure, not an initial advisory card, must
  // causally introduce the exact operation.
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) throw new Error(primed.reason);

  nominate(input.operation, input.toolkit);
  const candidates = await composioCandidates(input.query);
  const candidate = candidates.find((entry) => entry.name === input.operation);
  assert.ok(candidate, `${input.operation} must be reached through the exact nomination`);
  assert.deepEqual(candidate?.schema, input.inputSchema);
  const fuzzyCall = providerToolCalls.find((call) => Object.prototype.hasOwnProperty.call(call, 'search'));
  if (fuzzyCall) {
    assert.deepEqual(fuzzyCall, {
      toolkits: [input.toolkit],
      search: input.query,
      limit: 16,
    });
    assert.equal(providerToolCalls.length, 2,
      'unknown discovery uses one fuzzy request plus one exact batch');
  } else {
    assert.equal(providerToolCalls.length, 1,
      'a confident remembered operation skips fuzzy and uses one exact batch');
  }
  const discoveryCallCount = providerToolCalls.length;
  const exactBatch = providerToolCalls.find((call) => Object.prototype.hasOwnProperty.call(call, 'tools')) as {
    tools?: unknown;
    limit?: unknown;
  } | undefined;
  assert.ok(exactBatch, 'the one exact nomination batch must be present');
  assert.ok(Array.isArray(exactBatch.tools) && exactBatch.tools.includes(input.operation),
    'the one exact batch must include the nominated operation');
  assert.equal(exactBatch.limit, exactBatch.tools.length);
  assert.ok(exactBatch.tools.length <= 6, 'the exact batch stays inside the nomination bound');

  const planningCandidate = {
    name: input.operation,
    carrier: 'work_call' as const,
    sourceKind: 'authorized_composio' as const,
    schema: candidate!.schema,
  };
  const routingRegistry = await import('../runtime/semantic-boundary/turn-semantic-port-registry.js');
  routingRegistry.installTurnSemanticModelPort({
    async interpret() { throw new Error('metadata disclosure does not interpret work'); },
    async judgeAccountSelection(call) {
      assert.equal(call.acceptedText, input.query);
      return { verdict: call.mode === 'current_source_default' ? 'default_compatible' : 'entailed',
        proposalDigest: call.proposalDigest, modelIdentity: 'fixture-account-judge' };
    },
  });
  try {
    await providerSources.stageDisclosedPlanningProviderCandidates({
      ...identity,
      candidates: [planningCandidate],
      // These multi-account fixtures explicitly name the tested account in
      // their accepted query; generic singleton fixtures use checked defaults.
      ...((input.connections?.length ?? 1) > 1 ? { accountSelection: {
        toolkit: input.toolkit, identity: input.connectionId, source_quote: input.query,
      } } : {}),
    });
  } finally { routingRegistry.installTurnSemanticModelPort(null); }
  const refs = await semantic.disclosePrimaryModelPlanningCapabilities({
    authority: primed.planning.authority,
    candidates: [planningCandidate],
  });
  assert.equal(refs[input.operation], `cap:resolved:${input.operation.toLowerCase()}`);
  assert.equal(providerToolCalls.length, discoveryCallCount,
    'staging and disclosure consume the exact row already in hand; there is no third lookup');

  assert.deepEqual(schemaCache.getCachedToolSchema(input.operation), input.inputSchema);
  assert.equal(schemaCache.liveComposioOperationVersion(input.operation), input.operationVersion);
  assert.deepEqual(schemaCache.liveComposioOutputSchema(input.operation), input.outputSchema);

  const discovered = eventlog.listEvents(session.id, { types: ['capability_discovered'] });
  const rows = discovered.flatMap((event) => (
    Array.isArray(event.data.capabilities) ? event.data.capabilities : []
  ));
  const row = rows.find((entry) => (
    entry && typeof entry === 'object'
    && (entry as Record<string, unknown>).identifier === input.operation
  )) as Record<string, unknown> | undefined;
  assert.ok(row, 'the exact staged definition must reach the durable disclosure ledger');
  assert.equal(row?.accountIdentity, input.connectionId);
  const definition = row?.providerDefinition as Record<string, unknown> | undefined;
  assert.equal(definition?.providerInputSchemaDigest, toolContracts.digestSchema(input.inputSchema));
  assert.equal(definition?.providerOperationVersion, input.operationVersion);
  assert.equal(
    definition?.providerOutputSchemaDigest,
    input.outputSchema === null ? null : toolContracts.digestSchema(input.outputSchema),
  );
}

test('Outlook and Salesforce nominations causally stage exact planning refs without a third lookup', async () => {
  await runCausalPlanningDisclosure({
    toolkit: 'outlook',
    operation: CALENDAR_READ,
    query: "what's on my calendar tomorrow",
    connectionId: 'ca_outlook_primary',
    inputSchema: READ_SCHEMA,
    outputSchema: READ_OUTPUT,
    operationVersion: 'fixture-outlook-read-v1',
  });
  await runCausalPlanningDisclosure({
    toolkit: 'salesforce',
    operation: 'SALESFORCE_LIST_ACCOUNTS',
    query: 'list my Salesforce accounts',
    connectionId: 'ca_salesforce_primary',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer' }, cursor: { type: 'string' } },
    },
    outputSchema: {
      type: 'object',
      required: ['records'],
      properties: { records: { type: 'array', items: { type: 'object' } } },
    },
    operationVersion: 'fixture-salesforce-accounts-v3',
  });
});

test('an explicitly named mailbox collapses duplicate re-auths and stages the freshest exact account', async () => {
  await runCausalPlanningDisclosure({
    toolkit: 'outlook',
    operation: 'OUTLOOK_SEARCH_MESSAGES',
    query: 'read the newest Inbox message for work@corp.example',
    connectionId: 'ca_outlook_work_new',
    connections: [
      {
        id: 'ca_outlook_work_old',
        toolkit: 'outlook',
        email: 'work@corp.example',
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'ca_outlook_personal',
        toolkit: 'outlook',
        email: 'personal@example.net',
        createdAt: '2026-02-01T00:00:00Z',
      },
      {
        id: 'ca_outlook_work_new',
        toolkit: 'outlook',
        email: 'WORK@CORP.EXAMPLE',
        createdAt: '2026-03-01T00:00:00Z',
      },
    ],
    inputSchema: READ_SCHEMA,
    outputSchema: READ_OUTPUT,
    operationVersion: 'fixture-outlook-search-v2',
  });
});

test('duplicate re-auths for the only mailbox are not treated as account ambiguity', async () => {
  await runCausalPlanningDisclosure({
    toolkit: 'outlook',
    operation: 'OUTLOOK_SEARCH_MESSAGES',
    query: 'read the newest message in my Outlook Inbox',
    connectionId: 'ca_outlook_only_new',
    connections: [
      {
        id: 'ca_outlook_only_old',
        toolkit: 'outlook',
        email: 'only@corp.example',
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'ca_outlook_only_new',
        toolkit: 'outlook',
        email: 'ONLY@CORP.EXAMPLE',
        createdAt: '2026-03-01T00:00:00Z',
      },
    ],
    inputSchema: READ_SCHEMA,
    outputSchema: READ_OUTPUT,
    operationVersion: 'fixture-outlook-search-v3',
  });
});

test('an advertised opaque connection id can be named exactly on the repair turn', async () => {
  await runCausalPlanningDisclosure({
    toolkit: 'outlook',
    operation: 'OUTLOOK_SEARCH_MESSAGES',
    query: 'read the newest Inbox message using ca_outlook_work',
    connectionId: 'ca_outlook_work',
    connections: [
      { id: 'ca_outlook_work', toolkit: 'outlook' },
      { id: 'ca_outlook_personal', toolkit: 'outlook' },
    ],
    inputSchema: READ_SCHEMA,
    outputSchema: READ_OUTPUT,
    operationVersion: 'fixture-outlook-search-v4',
  });
});

test('exact-slug Tool Memory selects my Inbox mailbox, while an explicit current-turn mailbox still wins', async () => {
  const operation = 'OUTLOOK_SEARCH_MESSAGES';
  toolChoices.rememberToolChoice({
    intent: 'outlook.search.messages',
    choice: {
      kind: 'composio',
      identifier: operation,
      accountIdentity: 'work@corp.example',
      testEvidence: 'verified read settlement fixture',
    },
  });
  assert.equal(toolChoices.recallComposioAccountIdentity(operation), 'work@corp.example');

  const connections = [
    { id: 'ca_outlook_work', toolkit: 'outlook', email: 'WORK@CORP.EXAMPLE' },
    { id: 'ca_outlook_personal', toolkit: 'outlook', email: 'personal@example.net' },
  ] as const;
  await runCausalPlanningDisclosure({
    toolkit: 'outlook',
    operation,
    query: 'read the newest message in my Outlook Inbox',
    connectionId: 'ca_outlook_work',
    connections,
    inputSchema: READ_SCHEMA,
    outputSchema: READ_OUTPUT,
    operationVersion: 'fixture-outlook-search-memory-v1',
  });
  await runCausalPlanningDisclosure({
    toolkit: 'outlook',
    operation,
    query: 'read the newest Inbox message for personal@example.net',
    connectionId: 'ca_outlook_personal',
    connections,
    inputSchema: READ_SCHEMA,
    outputSchema: READ_OUTPUT,
    operationVersion: 'fixture-outlook-search-memory-v1',
  });
});

test('the calendar read the fuzzy search cannot find is reached by nomination', async () => {
  schemaCache.resetToolSchemaCache();
  capabilityIndex._resetCapabilityIndexForTest();
  installBroker();
  nominate(CALENDAR_READ);

  const candidates = await composioCandidates("what's on my calendar tomorrow");
  const names = candidates.map((entry) => entry.name);
  assert.ok(names.includes(CALENDAR_READ),
    `the operation that answers the question must be reachable; got ${names.join(', ')}`);

  const read = candidates.find((entry) => entry.name === CALENDAR_READ)!;
  assert.ok(read.schema, 'a candidate must carry the EXACT live schema, never the index row');
  assert.equal(read.invocation?.name, 'composio_execute_tool',
    'a composio business operation stays on the work_call carrier');
  assert.ok(exactLookups.includes(CALENDAR_READ),
    'the nomination must be proven by a live exact lookup, not trusted from the index');
});

test('one named registered Composio slug bypasses fuzzy search and uses one exact batch', async () => {
  schemaCache.resetToolSchemaCache();
  capabilityIndex._resetCapabilityIndexForTest();
  const operation = 'OUTLOOK_QUERY_EMAILS';
  installBroker({ exact: [operation] });

  const candidates = await composioCandidates(`inspect ${operation} for this read`);
  assert.deepEqual(candidates.map((candidate) => candidate.name), [operation]);
  assert.deepEqual(providerToolCalls, [{ tools: [operation], limit: 1 }],
    'an exact registered operation is selection: no fuzzy provider request and one exact batch');
  assert.deepEqual(exactLookups, [operation]);
  assert.deepEqual(schemaCache.getCachedToolSchema(operation), READ_SCHEMA,
    'the exact row still has to deposit the provider-observed schema contract');
});

test('confident Tool Memory takes one exact batch fast path and never starts fuzzy search', async () => {
  schemaCache.resetToolSchemaCache();
  capabilityIndex._resetCapabilityIndexForTest();
  const operation = 'OUTLOOK_QUERY_EMAILS';
  const query = 'quasar read the newest message in my Outlook Inbox';
  eventlog.resetEventLog();
  await learnCanonicalRead({
    sessionId: 'canonical-quasar-outlook-memory',
    phrase: query,
    operation,
    accountIdentity: 'owner@example.invalid',
  });
  addSearchAliasToCanonicalRead(operation, query);
  assert.ok(toolChoices.recallComposioForSearch(query, { limit: 6 })
    .some((match) => match.slug === operation), 'fixture must causally hit strict Tool Memory recall');
  installBroker({ exact: [operation] });

  const candidates = await composioCandidates(query, undefined, Date.now() + 2_000);
  assert.ok(candidates.some((candidate) => candidate.name === operation));
  assert.equal(providerToolCalls.length, 1,
    'known memory does one exact revalidation batch and skips unknown discovery');
  assert.ok(providerToolCalls.every((call) => Array.isArray(call.tools)),
    'no fuzzy search may start on the remembered fast path');
});

test('generic Outlook Inbox recall ignores a stronger Slack history and exact-revalidates the canonical Outlook read', async () => {
  schemaCache.resetToolSchemaCache();
  capabilityIndex._resetCapabilityIndexForTest();
  eventlog.resetEventLog();
  const outlookOperation = 'OUTLOOK_QUERY_EMAILS';
  const slackOperation = 'SLACK_FETCH_CONVERSATION_HISTORY';
  const query = 'Read the single most recent message in my Outlook Inbox and return only its subject and received time. This is read-only: do not send, draft, delete, move, mark, or modify anything.';

  await learnCanonicalRead({
    sessionId: 'canonical-outlook-inbox-memory',
    phrase: query,
    operation: outlookOperation,
    accountIdentity: 'owner@example.invalid',
  });
  addSearchAliasToCanonicalRead(outlookOperation, query);
  await learnCanonicalRead({
    sessionId: 'canonical-slack-message-memory',
    phrase: 'Read the single most recent message in my Slack Inbox and return only its subject and received time.',
    operation: slackOperation,
    accountIdentity: 'owner@example.invalid',
  });
  addSearchAliasToCanonicalRead(
    slackOperation,
    'single most recent message inbox subject received time',
  );
  for (let i = 0; i < 12; i += 1) {
    toolChoices.updateToolChoiceOutcomeForIdentifier(slackOperation, 'success');
  }

  const recalled = toolChoices.recallComposioForSearch(query, { limit: 6 });
  assert.ok(recalled.some((match) => match.slug === outlookOperation),
    'the live-shaped generic Inbox query must retrieve its learned Outlook operation');
  assert.ok(recalled.some((match) => match.slug === slackOperation),
    'the fixture must include the competing cross-toolkit memory row seen live');
  installBroker({ exact: [outlookOperation, slackOperation] });

  const candidates = await composioCandidates(query, undefined, Date.now() + 2_000);
  assert.deepEqual(candidates.map((candidate) => candidate.name), [outlookOperation]);
  assert.deepEqual(providerToolCalls, [{ tools: [outlookOperation], limit: 1 }],
    'a named Outlook request must do one exact Outlook revalidation and never nominate Slack');
});

test('a lexically matching memory row without a successful receipt remains a fuzzy hint', async () => {
  schemaCache.resetToolSchemaCache();
  capabilityIndex._resetCapabilityIndexForTest();
  const operation = 'OUTLOOK_GET_NEBULA_CONTACTS';
  const query = 'nebula inspect Outlook contacts';
  toolChoices.rememberToolChoice({
    intent: 'nebula inspect Outlook contacts',
    choice: {
      kind: 'composio',
      identifier: operation,
      testEvidence: 'manual note fixture',
    },
  });
  assert.ok(toolChoices.recallComposioForSearch(query, { limit: 6 })
    .some((match) => match.slug === operation), 'fixture must be a lexical memory hit');
  installBroker({ exact: [operation] });

  await composioCandidates(query);
  assert.ok(providerToolCalls.some((call) => Object.prototype.hasOwnProperty.call(call, 'search')),
    'an unproven memory hit must fall through to live fuzzy discovery');
  assert.ok(!exactLookups.includes(operation),
    'weak memory must not turn its remembered slug into exact selection');
});

test('generic fuzzy search and exact index nomination begin concurrently', async () => {
  schemaCache.resetToolSchemaCache();
  capabilityIndex._resetCapabilityIndexForTest();
  let exactStarted = false;
  let fuzzyObservedExact = false;
  installBroker({
    exact: [CALENDAR_READ],
    fuzzyDelayMs: 200,
    afterExactRequestStarted: () => { exactStarted = true; },
    beforeFuzzyReturn: () => { fuzzyObservedExact = exactStarted; },
  });
  nominate(CALENDAR_READ);

  const names = (await composioCandidates("what's on my calendar tomorrow"))
    .map((candidate) => candidate.name);
  assert.equal(fuzzyObservedExact, true,
    'the exact nomination must start while fuzzy search is still in flight');
  assert.ok(names.includes(CALENDAR_READ));
});

test('the nomination absolute deadline includes the fresh connection snapshot', async () => {
  schemaCache.resetToolSchemaCache();
  capabilityIndex._resetCapabilityIndexForTest();
  const realNow = Date.now;
  let now = 2_100_000_000_000;
  Date.now = () => now;
  try {
    installBroker({
      exact: [CALENDAR_READ],
      afterFuzzyRequestStarted: () => { now += 4_001; },
    });
    nominate(CALENDAR_READ);

    const names = (await composioCandidates("what's on my calendar tomorrow"))
      .map((candidate) => candidate.name);
    assert.ok(!names.includes(CALENDAR_READ),
      'a fresh connection lookup that consumes the budget leaves no authority for a late exact row');
    assert.ok(!exactLookups.includes(CALENDAR_READ),
      'the exact provider batch must not start after the absolute deadline');
    assert.equal(schemaCache.liveComposioSchemaFingerprint(CALENDAR_READ), undefined);
  } finally {
    Date.now = realNow;
    composio.resetComposioClient();
  }
});

test('an aborted exact-slug search cannot cache or return its late provider row', async () => {
  schemaCache.resetToolSchemaCache();
  capabilityIndex._resetCapabilityIndexForTest();
  const operation = 'OUTLOOK_QUERY_EMAILS_ABORTED';
  installBroker({ exact: [operation], exactDelayMs: 200 });
  const abort = new AbortController();
  const pending = composioCandidates(`inspect ${operation}`, abort.signal);
  setTimeout(() => abort.abort(), 20);

  const candidates = await pending;
  assert.deepEqual(candidates, []);
  assert.deepEqual(exactLookups, [operation], 'the bounded exact request began before cancellation');
  await new Promise((resolve) => { setTimeout(resolve, 250); });
  assert.equal(schemaCache.liveComposioSchemaFingerprint(operation), undefined,
    'settlement after cancellation must not warm planning schema authority');
});

test('the writes the broker did return are still offered', async () => {
  schemaCache.resetToolSchemaCache();
  capabilityIndex._resetCapabilityIndexForTest();
  installBroker();
  nominate(CALENDAR_READ);

  const names = (await composioCandidates("what's on my calendar tomorrow")).map((entry) => entry.name);
  assert.ok(names.some((name) => FUZZY_WRITES.includes(name)),
    'nomination adds reach; it must not hide the mutations a caller may legitimately want');
});

test('a nomination whose exact lookup fails never becomes a candidate', async () => {
  schemaCache.resetToolSchemaCache();
  capabilityIndex._resetCapabilityIndexForTest();
  // The index remembers a slug the provider no longer serves — renamed,
  // withdrawn, or never real. The index cannot vouch for it.
  installBroker({ exact: [] });
  nominate('OUTLOOK_GET_CALENDAR_VIEW_RETIRED');

  const names = (await composioCandidates("what's on my calendar tomorrow")).map((entry) => entry.name);
  assert.ok(!names.includes('OUTLOOK_GET_CALENDAR_VIEW_RETIRED'),
    'a stale index row must not manufacture a capability');
  assert.ok(names.every((name) => FUZZY_WRITES.includes(name)),
    `only genuinely live rows survive; got ${names.join(', ')}`);
});

test('a nomination for a toolkit that is not connected is never fetched', async () => {
  schemaCache.resetToolSchemaCache();
  capabilityIndex._resetCapabilityIndexForTest();
  installBroker();
  // Indexed from some earlier account or install; that connection is gone.
  nominate('SALESFORCE_LIST_ACCOUNTS', 'salesforce');

  const names = (await composioCandidates('list my accounts')).map((entry) => entry.name);
  assert.ok(!names.includes('SALESFORCE_LIST_ACCOUNTS'),
    'a disconnected toolkit must not be reachable through memory');
  assert.ok(!exactLookups.includes('SALESFORCE_LIST_ACCOUNTS'),
    'a disconnected nomination must not even cost a provider call');
});

test('a nomination whose carrier disagrees with its slug is refused', async () => {
  schemaCache.resetToolSchemaCache();
  capabilityIndex._resetCapabilityIndexForTest();
  installBroker();
  // The index says this outlook-shaped slug belongs to a different toolkit.
  nominate(CALENDAR_READ, 'salesforce');

  const names = (await composioCandidates("what's on my calendar tomorrow")).map((entry) => entry.name);
  assert.ok(!names.includes(CALENDAR_READ),
    'an index row whose carrier does not match the slug is not trustworthy enough to fetch');
});

test('a provider row whose toolkit disagrees with the nominated carrier is refused', async () => {
  schemaCache.resetToolSchemaCache();
  capabilityIndex._resetCapabilityIndexForTest();
  const operation = 'OUTLOOK_GET_CALENDAR_VIEW_WRONG_TOOLKIT';
  installBroker({ exact: [operation], exactToolkit: 'salesforce' });
  nominate(operation, 'outlook');

  const names = (await composioCandidates('calendar view wrong toolkit')).map((entry) => entry.name);
  assert.ok(!names.includes(operation));
  assert.equal(schemaCache.liveComposioSchemaFingerprint(operation), undefined,
    'the slug cannot be used to invent the toolkit identity omitted by the provider row');
  assert.ok(exactLookups.includes(operation), 'the hostile fact was rejected after exact provider observation');
});

test('missing exact operation version or output definition never warms planning authority', async () => {
  for (const variant of [
    { operation: 'OUTLOOK_GET_CALENDAR_VIEW_NO_VERSION', omitExactVersion: true },
    { operation: 'OUTLOOK_GET_CALENDAR_VIEW_NO_OUTPUT', omitExactOutput: true },
  ] as const) {
    schemaCache.resetToolSchemaCache();
    capabilityIndex._resetCapabilityIndexForTest();
    installBroker({ exact: [variant.operation], ...variant });
    nominate(variant.operation);

    const names = (await composioCandidates(variant.operation)).map((entry) => entry.name);
    assert.ok(!names.includes(variant.operation), `${variant.operation} must remain unavailable`);
    assert.equal(schemaCache.liveComposioSchemaFingerprint(variant.operation), undefined);
    assert.equal(schemaCache.liveComposioOperationVersion(variant.operation), undefined);
    assert.equal(schemaCache.liveComposioOutputSchema(variant.operation), undefined);
  }
});

test('an ambiguous connected account never fetches or deposits an indexed operation', async () => {
  schemaCache.resetToolSchemaCache();
  capabilityIndex._resetCapabilityIndexForTest();
  const operation = 'OUTLOOK_GET_CALENDAR_VIEW_AMBIGUOUS_ACCOUNT';
  installBroker({
    exact: [operation],
    connections: [
      { id: 'ca_outlook_work', toolkit: 'outlook' },
      { id: 'ca_outlook_personal', toolkit: 'outlook' },
    ],
  });
  nominate(operation);

  const names = (await composioCandidates('calendar view ambiguous account')).map((entry) => entry.name);
  assert.ok(!names.includes(operation));
  assert.ok(!exactLookups.includes(operation), 'account selection is required before exact materialization');
  assert.equal(schemaCache.liveComposioSchemaFingerprint(operation), undefined);
});

test('typed source selection reaches the best indexed operation on the first five-row discovery page', async () => {
  const { registerToolSearchTool } = await import('./tool-search-tool.js');
  const registry = await import('../runtime/semantic-boundary/turn-semantic-port-registry.js');
  const resolution = await import('../runtime/harness/capability-resolution.js');
  const operation = 'OUTLOOK_CREATE_DRAFT';
  const query = 'outlook create draft email message';
  const accepted = 'Save those exact three drafts in the Outlook Drafts folder for my work mailbox.';
  const accountSelection = { toolkit: 'outlook', identity: 'operator@work.invalid', source_quote: accepted };
  const variants = [
    'OUTLOOK_CREATE_ME_MESSAGE_REPLY_ALL_DRAFT', 'OUTLOOK_CREATE_FORWARD_DRAFT',
    'OUTLOOK_CREATE_REPLY_ALL_DRAFT', 'OUTLOOK_CREATE_ME_REPLY_ALL_DRAFT',
    'OUTLOOK_CREATE_USER_MAIL_FOLDER_MESSAGE_REPLY_DRAFT',
  ];
  try {
    for (const includeDesiredInFuzzy of [false, true]) {
      schemaCache.resetToolSchemaCache();
      capabilityIndex._resetCapabilityIndexForTest();
      eventlog.resetEventLog();
      const candidateRows = variants.map(slug => ({
        slug, name: slug.replaceAll('_', ' '), toolkit: { slug: 'outlook' },
        description: 'Create an Outlook email message reply draft to an existing message.',
        inputParameters: { type: 'object', required: ['message_id'], properties: { message_id: { type: 'string' } } },
        outputParameters: READ_OUTPUT, version: 'fixture-reply-v1',
      }));
      if (includeDesiredInFuzzy) candidateRows.push({
        slug: operation, name: 'Create draft', toolkit: { slug: 'outlook' },
        description: 'Create a standalone Outlook draft.',
        inputParameters: { type: 'object', required: ['message_id'], properties: { message_id: { type: 'string' } } },
        outputParameters: READ_OUTPUT, version: 'fixture-draft-v1',
      });
      installBroker({
        exact: [operation, ...variants], fuzzyRows: candidateRows,
        connections: [
          { id: 'ca_work', toolkit: 'outlook', email: 'operator@work.invalid' },
          { id: 'ca_personal', toolkit: 'outlook', email: 'operator@personal.invalid' },
        ],
      });
      capabilityIndex.recordCapabilityOperations([
        { identifier: operation, displayName: 'Create draft email message',
          description: 'Create a new Outlook draft email message with subject and body.' },
        ...variants.map(identifier => ({ identifier, displayName: identifier,
          description: 'Reply to an existing message.' })),
      ].map(row => ({ ...row, carrierKind: 'composio' as const, carrier: 'outlook',
        effectClass: 'write' as const, effectProvenance: 'declared' as const })));
      assert.equal(capabilityIndex.searchCapabilityOperations(query)[0]?.identifier, operation,
        'the fixture reproduces the independently observed best local-index match');
      const session = eventlog.createSession({ id: `typed-nomination-first-page-${includeDesiredInFuzzy}`, kind: 'chat', userId: 'fixture-owner' });
      const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: accepted } });
      const identity = { sessionId: session.id, sourceUserSeq: source.seq };
      const continuationText = 'Save one more draft in that same mailbox.';
      let judgeCalls = 0;
      registry.installTurnSemanticModelPort({
        async interpret() { throw new Error('discovery must not invent a work plan'); },
        async judgeAccountSelection(call) {
          judgeCalls++;
          assert.equal(call.acceptedText, call.sourceUserSeq === source.seq ? accepted : continuationText,
            'full accepted source, not the short query');
          assert.equal(call.accountIdentity, accountSelection.identity);
          return { verdict: 'entailed', proposalDigest: call.proposalDigest, modelIdentity: 'fixture-judge' };
        },
      });
      const sources = providerSources.buildAuthorizedToolSearchCandidateSources({
        authority: 'none', reason: 'isolated Composio discovery', maxTools: 0,
      } as never, identity).filter(entry => entry.kind === 'authorized_composio');
      let handler!: (input: unknown) => Promise<{ content: Array<{ text: string }> }>;
      registerToolSearchTool({ tool(_name: string, _description: string, _schema: unknown, callback: typeof handler) { handler = callback; } } as never, {
        dispatchCarrier: 'work_call', candidateSources: sources,
        async discloseForPlanning(candidates, control) {
          const staged = await providerSources.stageDisclosedPlanningProviderCandidates({
            ...identity, candidates, ...control,
          });
          return { version: 1, refs: {}, blockers: staged.blockers };
        },
      });
      const response = await handler({ query, account_selection: accountSelection, limit: 5, cursor: null, role_key: null });
      const body = JSON.parse(response.content[0]!.text);
      assert.equal(body.results[0]?.name, operation,
        'live indexed base operation must lead the first page even if fuzzy omitted it or ranked it after five variants');
      assert.ok(body.results.every((row: { name: string }) => row.name.startsWith('OUTLOOK_')),
        'relevant provider rows occupy the first page without unrelated local create tools');
      assert.equal(body.results[0]?.planningRefStatus, 'materialization_unavailable',
        'this fixture intentionally publishes no authority from ranking alone');
      assert.ok(exactLookups.includes(operation), 'the advisory row must be exactly revalidated');
      assert.ok(providerToolCalls.filter(call => Array.isArray(call.tools)).every(call => (call.tools as string[]).length <= 6));
      assert.equal(judgeCalls, 1, 'source acquisition and final staging share one checked routing judgment');
      const proven = resolution.provenCapabilityEntriesForTurn(identity).find(entry => entry.identifier === operation);
      assert.equal(proven?.accountIdentity, 'ca_work');
      assert.equal(proven?.sourceAccountRouting?.sourceQuote, accepted);

      const continuation = eventlog.appendEvent({ sessionId: session.id, turn: 2, role: 'user',
        type: 'user_input_received', data: { text: continuationText } });
      const followupProvider = providerSources.buildAuthorizedToolSearchCandidateSources({
        authority: 'none', reason: 'isolated continuation', maxTools: 0,
      } as never, { sessionId: session.id, sourceUserSeq: continuation.seq })
        .find(entry => entry.kind === 'authorized_composio')!;
      const followup = await followupProvider.search({ query, limit: 5 });
      assert.equal(followup[0]?.name, operation,
        'a checked continuing route unlocks the index without a repeated nomination or account phrase');
      assert.equal(judgeCalls, 2, 'the current continuation is checked once against the earlier selected route');
    }
  } finally { registry.installTurnSemanticModelPort(null); }
});

test('an unsupported source nomination cannot unlock indexed metadata acquisition', async () => {
  const registry = await import('../runtime/semantic-boundary/turn-semantic-port-registry.js');
  const operation = 'OUTLOOK_CREATE_DRAFT_UNSUPPORTED_SELECTION';
  schemaCache.resetToolSchemaCache();
  capabilityIndex._resetCapabilityIndexForTest();
  eventlog.resetEventLog();
  installBroker({ exact: [operation], connections: [
    { id: 'ca_work', toolkit: 'outlook', email: 'operator@work.invalid' },
    { id: 'ca_personal', toolkit: 'outlook', email: 'operator@personal.invalid' },
  ] });
  nominate(operation);
  const session = eventlog.createSession({ id: 'unsupported-nomination', kind: 'chat', userId: 'fixture-owner' });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Create a draft in my personal mailbox.' } });
  let judgeCalls = 0;
  registry.installTurnSemanticModelPort({
    async interpret() { throw new Error('unexpected interpretation'); },
    async judgeAccountSelection(call) {
      judgeCalls++;
      return { verdict: 'conflict', proposalDigest: call.proposalDigest, modelIdentity: 'fixture-judge' };
    },
  });
  try {
    const provider = providerSources.buildAuthorizedToolSearchCandidateSources({ authority: 'none', maxTools: 0 } as never,
      { sessionId: session.id, sourceUserSeq: source.seq }).find(entry => entry.kind === 'authorized_composio')!;
    const rows = await provider.search({ query: 'calendar create draft', limit: 5, accountSelection: {
      toolkit: 'outlook', identity: 'operator@work.invalid', source_quote: 'Create a draft in my personal mailbox.',
    } });
    assert.equal(judgeCalls, 1);
    assert.ok(!rows.some(row => row.name === operation));
    assert.ok(!exactLookups.includes(operation));
    assert.equal(schemaCache.liveComposioSchemaFingerprint(operation), undefined);
  } finally { registry.installTurnSemanticModelPort(null); }
});

test('an aborted planning stage cannot deposit a late connection resolution', async () => {
  schemaCache.resetToolSchemaCache();
  capabilityIndex._resetCapabilityIndexForTest();
  eventlog.resetEventLog();
  const operation = 'OUTLOOK_QUERY_EMAILS_STAGE_ABORTED';
  installBroker({ connectionDelayMs: 150 });
  const session = eventlog.createSession({ id: 'nomination-stage-abort', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: `inspect ${operation}` },
  });
  const abort = new AbortController();
  const pending = providerSources.stageDisclosedPlanningProviderCandidates({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    candidates: [{
      name: operation,
      carrier: 'work_call',
      sourceKind: 'authorized_composio',
      schema: READ_SCHEMA,
    }],
    signal: abort.signal,
  });
  setTimeout(() => abort.abort(), 20);

  const staged = await pending;
  assert.deepEqual(staged.blockers, {});
  await new Promise((resolve) => { setTimeout(resolve, 180); });
  assert.equal(eventlog.listEvents(session.id, { types: ['capability_resolution'] }).length, 0,
    'a late connection snapshot cannot stage rows after its caller has timed out');
});

test('a stale request-start observation cannot become a nominated planning capability', async () => {
  schemaCache.resetToolSchemaCache();
  capabilityIndex._resetCapabilityIndexForTest();
  const operation = 'OUTLOOK_GET_CALENDAR_VIEW_STALE_OBSERVATION';
  const realNow = Date.now;
  let now = 2_000_000_000_000;
  Date.now = () => now;
  try {
    installBroker({
      exact: [operation],
      afterExactRequestStarted: () => { now += 31 * 60_000; },
    });
    nominate(operation);
    const names = (await composioCandidates('calendar view stale observation')).map((entry) => entry.name);
    assert.ok(!names.includes(operation));
    assert.equal(schemaCache.liveComposioSchemaFingerprint(operation), undefined,
      'the exact lookup keeps its request-start time instead of being restamped at response time');
  } finally {
    Date.now = realNow;
    composio.resetComposioClient();
  }
});

test('a hung exact lookup degrades to the fuzzy answer within the deadline', async () => {
  schemaCache.resetToolSchemaCache();
  capabilityIndex._resetCapabilityIndexForTest();
  installBroker({ hang: true });
  nominate(CALENDAR_READ);

  const started = Date.now();
  const names = (await composioCandidates("what's on my calendar tomorrow")).map((entry) => entry.name);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 15_000, `nomination must be bounded; took ${elapsed}ms`);
  assert.ok(!names.includes(CALENDAR_READ),
    'an unproven nomination is never published as a capability');
});

test('a remembered calendar read cannot hide the write phase of a mixed meeting request', async () => {
  schemaCache.resetToolSchemaCache();
  capabilityIndex._resetCapabilityIndexForTest();
  eventlog.resetEventLog();
  const query = 'Check whether 7:30 PM is free in Outlook, then create the meeting and send the invite.';
  await learnCanonicalRead({
    sessionId: 'canonical-mixed-calendar-memory',
    phrase: query,
    operation: CALENDAR_READ,
    accountIdentity: 'owner@example.invalid',
  });
  addSearchAliasToCanonicalRead(CALENDAR_READ, query);
  nominate(CALENDAR_READ);
  installBroker({ exact: [CALENDAR_READ] });

  const candidates = await composioCandidates(query, undefined, Date.now() + 2_000);
  const names = candidates.map((candidate) => candidate.name);
  assert.ok(names.includes(CALENDAR_READ), 'the proven availability read remains reachable');
  assert.ok(names.includes('OUTLOOK_CALENDAR_CREATE_EVENT'),
    `the requested write phase must remain visible before plan freeze; got ${names.join(', ')}`);
  assert.ok(providerToolCalls.some((call) => Object.prototype.hasOwnProperty.call(call, 'search')),
    'mixed work must perform bounded live discovery instead of returning one remembered read');
});
