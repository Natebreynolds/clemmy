import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-capability-descriptor-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  _setToolSchemaLoaderForTests,
  rememberToolSchema,
} = await import('../../tools/composio-schema-cache.js');
const {
  attachCapabilityAliasEmbedding,
  daemonAliasScope,
  recordCapabilityAlias,
} = await import('../../memory/capability-alias-index.js');
const {
  _setLocalProviderForTest,
  localEmbeddingSpaceKey,
} = await import('../../memory/embeddings.js');
const {
  renderCapabilityCandidateCard,
  resolveTurnCapabilityCandidates,
} = await import('./capability-candidates.js');

test.after(() => {
  _setLocalProviderForTest(undefined);
  _setToolSchemaLoaderForTests(null);
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function choice(intent: string, identifier: string) {
  return {
    intent,
    description: intent,
    choice: {
      kind: 'composio' as const,
      identifier,
      testedAt: '2026-01-01T00:00:00.000Z',
    },
    fallbacks: [],
    body: '',
    filePath: `/fixture/${identifier}`,
  };
}

test('a mixed find-and-write ask stays unresolved so discovery keeps its search slot', async () => {
  const resolved = await resolveTurnCapabilityCandidates({
    userInput: 'Find the top widgets and put all the info in a workbook.',
    choices: [
      choice('dataforseo keywords for site', 'dataforseo__dataforseo_labs_google_keywords_for_site'),
      choice('google sheets add tab', 'GOOGLESHEETS_ADD_SHEET'),
      choice('slack fetch conversation history', 'SLACK_FETCH_CONVERSATION_HISTORY'),
    ] as never,
    semantic: false,
  });
  const mixed = resolved.requirements.find((requirement) => requirement.effect === 'mixed')
    ?? resolved.requirements[0];
  assert.ok(mixed, 'the compound ask still projects a requirement');
  assert.equal(mixed.resolved, false, 'remembered Slack/Sheets/SEO pins must not close the retrieve');
});

test('a resolved exact capability carries live required keys into the shared brain card', async () => {
  let providerSchemaLoads = 0;
  _setToolSchemaLoaderForTests(async () => {
    providerSchemaLoads += 1;
    return null;
  });
  rememberToolSchema('SOURCEHUB_FETCH_RECORDS', {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'number' },
      optional_cursor: { type: 'string' },
    },
    required: ['query', 'limit'],
  }, Date.now());

  const resolved = await resolveTurnCapabilityCandidates({
    userInput: 'Fetch restaurant records from SourceHub.',
    choices: [choice('sourcehub fetch restaurant records', 'SOURCEHUB_FETCH_RECORDS')] as never,
    semantic: false,
  });
  const descriptor = resolved.candidates.find(
    (candidate) => candidate.identifier === 'SOURCEHUB_FETCH_RECORDS',
  );
  assert.ok(descriptor);
  assert.equal(descriptor.schemaAuthority, 'live');
  assert.deepEqual(descriptor.requiredFields, ['query', 'limit']);
  assert.ok(descriptor.schemaFingerprint);
  assert.equal(providerSchemaLoads, 0,
    'candidate projection must read retained schema authority locally, never fetch synchronously');

  const card = renderCapabilityCandidateCard(resolved);
  assert.match(card, /Live schema requires: query, limit/);
  assert.doesNotMatch(card, /optional_cursor/);
});

test('an exact source binding renders its work_call carrier even when advisory candidates are empty', () => {
  const primary = 'APIFY_ACT_RUN_SYNC_GET_DATASET_ITEMS_GET';
  const fallback = 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS';
  const card = renderCapabilityCandidateCard({
    candidates: [],
    requirements: [],
    matches: [],
    pinnedTools: ['composio_execute_tool'],
    semanticApplied: false,
    sourceStrategyBinding: {
      version: 1,
      primary: {
        capabilityId: `capability:composio:${primary}`,
        schemaFingerprint: 'a'.repeat(64),
      },
      equivalentFallbacks: [{
        capabilityId: `capability:composio:${fallback}`,
        schemaFingerprint: 'b'.repeat(64),
      }],
      topology: 'single_aggregate_read_then_single_artifact_write',
      topologyDigest: 'c'.repeat(64),
      destination: { family: 'workbook', posture: 'create_new' },
      effect: 'external_write',
    },
  });

  assert.match(card, /Host-bound collection source/);
  assert.match(card, new RegExp(`Primary[\\s\\S]*${primary}`));
  assert.match(card, /work_call/);
  assert.match(card, /composio_execute_tool/);
  assert.match(card, new RegExp(`Equivalent fallback 1[\\s\\S]*${fallback}`));
  assert.match(card, /Do not rediscover it/);
});

test('one warm capability stays compact without weakening its advisory boundary', () => {
  const card = renderCapabilityCandidateCard({
    candidates: [{
      kind: 'composio',
      identifier: 'RESTAURANTS_SEARCH',
      intent: 'find restaurants',
      klass: 'capability_only',
      via: 'exact',
      score: 1,
      accountIdentity: 'conn-restaurants',
      schemaAuthority: 'live',
      requiredFields: ['location', 'category', 'limit'],
      roleKey: 'clause-0:read',
    }],
    requirements: [],
    matches: [],
    pinnedTools: [],
    semanticApplied: false,
  } as never);

  assert.ok(Buffer.byteLength(card, 'utf8') <= 512, 'one warm path must fit in a small volatile card');
  assert.match(card, /nothing here is pre-authorized/);
  assert.match(card, /Intent is metadata, never a tool name/);
  assert.match(card, /Live schema requires: location, category, limit/);
  assert.match(card, /use `composio_execute_tool` with exact `tool_slug`/);
});

test('every resolved requirement descriptor carries its own current contract', async () => {
  const schemas: Array<[string, string[]]> = [
    ['SOURCEHUB_FETCH_RECORDS', ['query', 'limit']],
    ['TABLESTORE_CREATE_TABLE', ['title', 'rows']],
    ['MAILRELAY_SEND_MESSAGE', ['recipient', 'link']],
  ];
  for (const [identifier, required] of schemas) {
    rememberToolSchema(identifier, {
      type: 'object',
      properties: Object.fromEntries(required.map((key) => [key, { type: 'string' }])),
      required,
    }, Date.now());
  }

  const resolved = await resolveTurnCapabilityCandidates({
    userInput: 'Collect restaurant records through SourceHub, place the results in a TableStore table, then notify me through MailRelay.',
    limit: 3,
    choices: [
      choice('sourcehub collect restaurant records', 'SOURCEHUB_FETCH_RECORDS'),
      choice('tablestore place results table', 'TABLESTORE_CREATE_TABLE'),
      choice('mailrelay notify with link', 'MAILRELAY_SEND_MESSAGE'),
    ] as never,
    semantic: false,
  });

  assert.deepEqual(
    resolved.requirements.map((requirement) => [
      requirement.roleKey,
      requirement.resolved,
      requirement.resolvedCapabilities[0]?.requiredFields,
    ]),
    [
      ['clause-0:read', true, ['query', 'limit']],
      ['clause-1:write', true, ['title', 'rows']],
      ['clause-2:write', true, ['recipient', 'link']],
    ],
  );
  assert.ok(resolved.requirements.every((requirement) =>
    requirement.resolvedCapabilities[0]?.schemaAuthority === 'live'));
});

test('a semantic read hit cannot rewrite or settle an unknown read/write role', async () => {
  const recorded = recordCapabilityAlias({
    aliasDigest: 'a'.repeat(24),
    intent: 'archivehub list entries',
    kind: 'composio',
    identifier: 'ARCHIVEHUB_LIST_ENTRIES',
    klass: 'capability_only',
    terms: ['archivehub', 'list', 'entries'],
    scope: daemonAliasScope(),
  });
  assert.equal(recorded.stored, true);
  if (!recorded.stored) assert.fail(recorded.reason);
  assert.equal(attachCapabilityAliasEmbedding(
    recorded.row,
    new Float32Array([1, 0]),
    localEmbeddingSpaceKey(),
  ), true);
  _setLocalProviderForTest({
    name: 'local',
    model: 'deterministic-test',
    dim: 2,
    embed: async (inputs: string[]) => inputs.map(() => new Float32Array([1, 0])),
  });

  for (const userInput of [
    'Gather entries through ArchiveHub.', // open-vocabulary read
    'Mirror entries into ArchiveHub.', // open-vocabulary write
  ]) {
    const resolved = await resolveTurnCapabilityCandidates({
      userInput,
      choices: [] as never,
    });
    assert.equal(resolved.candidates[0]?.via, 'semantic', userInput);
    assert.equal(resolved.candidates[0]?.roleKey, 'clause-0:unknown', userInput);
    assert.equal(resolved.requirements[0]?.roleKey, 'clause-0:unknown', userInput);
    assert.equal(resolved.requirements[0]?.resolved, false, userInput);
    assert.deepEqual(resolved.requirements[0]?.resolvedCapabilities, [], userInput);
  }

  const knownRead = await resolveTurnCapabilityCandidates({
    userInput: 'Find entries in ArchiveHub.',
    choices: [] as never,
  });
  assert.equal(knownRead.requirements[0]?.roleKey, 'clause-0:read');
  assert.equal(knownRead.requirements[0]?.resolved, true,
    'semantic evidence may resolve a role whose requested effect is already known');

  const knownWrite = await resolveTurnCapabilityCandidates({
    userInput: 'Create entries in ArchiveHub.',
    choices: [] as never,
  });
  assert.equal(knownWrite.requirements[0]?.roleKey, 'clause-0:write');
  assert.equal(knownWrite.requirements[0]?.resolved, false);
  assert.deepEqual(knownWrite.candidates, [], 'a proven read alias is incompatible with a known write');
});

test('a wrong-effect proven pin can never close a role (live 2026-08-21 calendar lockout)', async () => {
  // "What's on my calendar" (READ clause) lexically matched the remembered
  // OUTLOOK_CALENDAR_CREATE_EVENT WRITE pin at high tier; the closed role
  // then made the governor deny every tool_search (role_not_unresolved) and
  // the turn parked with no read path. Only a positive read/write
  // contradiction disqualifies — unknown effects stay admissible.
  const { effectClassMayCloseRole } = await import('./capability-candidates.js');
  assert.equal(effectClassMayCloseRole('write', 'read'), false, 'a write pin cannot close a read role');
  assert.equal(effectClassMayCloseRole('read', 'write'), false, 'a read pin cannot close a write role');
  assert.equal(effectClassMayCloseRole('read', 'read'), true);
  assert.equal(effectClassMayCloseRole('write', 'write'), true);
  assert.equal(effectClassMayCloseRole(undefined, 'read'), true, 'unknown candidate effect stays admissible');
  assert.equal(effectClassMayCloseRole('unknown', 'read'), true);
  assert.equal(effectClassMayCloseRole('write', 'unknown'), true, 'unknown clause effect is not a contradiction');
  assert.equal(effectClassMayCloseRole('write', 'mixed'), true, 'mixed clauses are already handled by the mixed rule');
});
