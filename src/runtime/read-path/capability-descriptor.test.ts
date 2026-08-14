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
