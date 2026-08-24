/** Run: node scripts/run-tests-isolated.mjs src/memory/capability-semantic-index.test.ts
 *
 * Vectors for the capability index: storage, resumable backfill, and the rule
 * that matters most — a missing or disabled embedding space must cost
 * REACHABILITY nothing. Retrieval degrades to the lexical result rather than
 * returning fewer capabilities, because a capability that cannot be ranked well
 * must still be findable.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-cap-semantic-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-cap-semantic\n', 'utf8');

const { recordCapabilityOperations, searchCapabilityOperations } = await import('./capability-index.js');
const {
  embedMissingCapabilityOperations,
  retrieveCapabilityOperations,
  semanticCapabilityCandidates,
  capabilityEmbeddingCoverage,
  _setCapabilityEmbedderForTest,
} = await import('./capability-semantic-index.js');

/**
 * A two-concept stand-in for an embedding model: one axis for "reaching out to
 * the web", one for "spreadsheets". It encodes the single property real
 * embeddings are used for here — that "look up restaurants online" lands near
 * "performs a web search" despite sharing no term — so the RANKING LOGIC is
 * pinned deterministically. Model quality is measured on real corpora, not
 * asserted here.
 */
const FAKE_SPACE = 'test:two-concept:2';
function concepts(text: string): Float32Array {
  const lower = text.toLowerCase();
  const web = /web|online|restaurant|search the web|listing/.test(lower) ? 1 : 0;
  const sheet = /spreadsheet|workbook|sheet|row|json/.test(lower) ? 1 : 0;
  // A text matching neither sits between the two axes rather than at the origin,
  // so cosine stays defined.
  return new Float32Array(web === 0 && sheet === 0 ? [0.5, 0.5] : [web, sheet]);
}
const fakeEmbedder = {
  spaceKey: () => FAKE_SPACE,
  embedOne: async (text: string) => concepts(text),
  embedMany: async (texts: string[]) => texts.map(concepts),
};

function seed(): void {
  recordCapabilityOperations([
    {
      identifier: 'WEBINDEX_SEARCH',
      carrierKind: 'composio',
      carrier: 'webindex',
      displayName: 'Search the web',
      description: 'Performs a web search for a query and returns the top results.',
      effectClass: 'read',
      effectProvenance: 'inferred',
    },
    {
      identifier: 'SPREADSHEET_KIT_FROM_JSON',
      carrierKind: 'composio',
      carrier: 'spreadsheet_kit',
      displayName: 'Create spreadsheet from JSON',
      description: 'Create a new spreadsheet workbook from collected rows.',
      effectClass: 'write',
      effectProvenance: 'inferred',
    },
    {
      identifier: 'SPREADSHEET_KIT_BATCH_GET',
      carrierKind: 'composio',
      carrier: 'spreadsheet_kit',
      displayName: 'Read spreadsheet',
      description: 'Read back a spreadsheet workbook by id.',
      effectClass: 'read',
      effectProvenance: 'inferred',
    },
  ]);
}

test('a cold vector store costs reachability nothing', async () => {
  seed();
  assert.deepEqual(capabilityEmbeddingCoverage(), { operations: 3, embedded: 0 });

  // No vectors yet: hybrid must return exactly the lexical answer, not fewer.
  const lexical = searchCapabilityOperations('spreadsheet', { limit: 10 });
  const hybrid = await retrieveCapabilityOperations('spreadsheet', { limit: 10 });
  assert.ok(lexical.length > 0, 'precondition: the lexical arm finds something');
  assert.deepEqual(
    hybrid.map((hit) => hit.identifier),
    lexical.map((hit) => hit.identifier),
    'with no vectors, hybrid IS lexical',
  );
});

test('backfill is bounded, resumable and idempotent', async () => {
  _setCapabilityEmbedderForTest(fakeEmbedder);
  const first = await embedMissingCapabilityOperations({ maxOperations: 2 });
  assert.equal(first.embedded, 2, 'honors maxOperations');
  assert.equal(capabilityEmbeddingCoverage().embedded, 2);

  const second = await embedMissingCapabilityOperations({ maxOperations: 50 });
  assert.equal(second.embedded, 1, 'resumes with only what is missing');
  assert.equal(capabilityEmbeddingCoverage().embedded, 3);

  const third = await embedMissingCapabilityOperations({ maxOperations: 50 });
  assert.equal(third.candidates, 0, 'idempotent: a settled index re-embeds nothing');
  assert.equal(third.embedded, 0);
});

test('effect scoping holds — a read role never sees writes', async () => {
  const reads = await semanticCapabilityCandidates('put rows into a workbook', {
    limit: 10,
    effectClass: 'read',
  });
  assert.ok(reads.length > 0, 'the read space is populated');
  assert.ok(
    !reads.some((hit) => hit.identifier === 'SPREADSHEET_KIT_FROM_JSON'),
    'the write must not appear in a read-scoped shortlist',
  );

  const hybrid = await retrieveCapabilityOperations('put rows into a workbook', {
    limit: 10,
    effectClass: 'read',
  });
  assert.ok(hybrid.every((hit) => hit.effectClass === 'read'), 'hybrid honors the effect scope');
});

test('semantic retrieval reaches a capability the user did not name', async () => {
  // "look up restaurants online" shares no term with any indexed description,
  // so the lexical arm cannot reach the web search. Meaning can.
  const query = 'look up restaurants online';
  assert.equal(
    searchCapabilityOperations(query, { limit: 5, effectClass: 'read' })
      .some((hit) => hit.identifier === 'WEBINDEX_SEARCH'),
    false,
    'precondition: lexical cannot bridge the vocabulary gap',
  );
  const semantic = await semanticCapabilityCandidates(query, { limit: 5, effectClass: 'read' });
  assert.equal(semantic[0]?.identifier, 'WEBINDEX_SEARCH', 'meaning reaches what terms cannot');
});

test('a provider that goes away mid-life leaves the index lexical, not empty', async () => {
  _setCapabilityEmbedderForTest({
    spaceKey: () => FAKE_SPACE,
    embedOne: async () => null,
    embedMany: async () => null,
  });
  const lexical = searchCapabilityOperations('spreadsheet', { limit: 10 });
  const hybrid = await retrieveCapabilityOperations('spreadsheet', { limit: 10 });
  assert.deepEqual(
    hybrid.map((hit) => hit.identifier),
    lexical.map((hit) => hit.identifier),
    'a dead query embedder must not shrink the answer',
  );
  _setCapabilityEmbedderForTest();
});
