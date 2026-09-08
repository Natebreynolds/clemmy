import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ToolSearchBrokerCandidate } from './tool-search-tool.js';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-discovery-relevance-'));
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const { registerToolSearchTool } = await import('./tool-search-tool.js');
const { deriveOrchestratorDiscoveryNames } = await import('./tool-registry.js');
const { inspectAuthorizedLocalPlanningDisclosureCandidates } = await import('../runtime/harness/local-planning-capability.js');
const frozen = JSON.parse(readFileSync(new URL('./fixtures/native-space-discovery-c8.json', import.meta.url), 'utf8')) as {
  query: string;
  providerCandidates: Array<{ name: string; summary: string }>;
};
const frozenCandidates: ToolSearchBrokerCandidate[] = frozen.providerCandidates.map((candidate, index, all) => ({
  ...candidate, carrier: 'work_call', score: 1 - index / all.length,
}));
const c9 = JSON.parse(readFileSync(new URL('./fixtures/native-space-discovery-c9.json', import.meta.url), 'utf8')) as {
  cases: Array<{ query: string; providerCandidates: Array<{ name: string; summary: string }> }>;
};

async function search(query: string, candidates = frozenCandidates) {
  let handler!: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  registerToolSearchTool({ tool(_name: string, _description: string, _schema: unknown, callback: typeof handler) { handler = callback; } } as never, {
    allowedNames: deriveOrchestratorDiscoveryNames(),
    dispatchCarrierForName: () => 'work_call',
    candidateSources: [{ kind: 'authorized_composio', search: async () => candidates }],
    async discloseForPlanning(disclosures) {
      return Object.fromEntries(disclosures.flatMap((candidate) => {
        const definitions = inspectAuthorizedLocalPlanningDisclosureCandidates(candidate);
        return definitions?.length ? [[candidate.name, definitions[0]!.capabilityRef]] : [];
      }));
    },
  });
  return JSON.parse((await handler({ query, role_key: 'clause-0:write', limit: 8, account_selection: null, cursor: null })).content[0]!.text);
}

test('the failed live Space query leads with the executable native operation against the frozen provider page', async () => {
  const body = await search(frozen.query);
  assert.equal(body.results[0].name, 'space_save');
  assert.equal(body.results[0].capabilityRef, 'cap:local:space_save:reversible');
  assert.equal(body.results[0].effect, 'local_write');
  assert.deepEqual(body.results[0].invocation, { name: 'space_save', payloadField: null });
  assert.ok(body.schemas.space_save, 'the first page must include the exact native argument schema');
});

test('actual C9 Space creation queries retrieve the native writer using its complete registered metadata', async () => {
  for (const fixture of c9.cases) {
    const candidates: ToolSearchBrokerCandidate[] = fixture.providerCandidates.map((candidate, index, all) => ({
      ...candidate, carrier: 'work_call', score: 1 - index / all.length,
    }));
    const body = await search(fixture.query, candidates);
    assert.equal(body.results[0].name, 'space_save', `${fixture.query}: ${body.results.map((row: { name: string }) => row.name).join(', ')}`);
    assert.equal(body.results[0].capabilityRef, 'cap:local:space_save:reversible');
    assert.ok(body.schemas.space_save);
  }
});

test('native creation remains discoverable across ordinary descriptions of view, title, and phone content', async () => {
  const candidates: ToolSearchBrokerCandidate[] = c9.cases.flatMap(fixture => fixture.providerCandidates)
    .map(candidate => ({ ...candidate, carrier: 'work_call', score: 1 }));
  for (const query of [
    'Create a Workspace with a title and a static HTML view',
    'Build a Space that displays my content on desktop and phone',
    'Save a new workspace with a slug and initial mobile data',
    'Create a native workflow with manual trigger and transform steps',
  ]) {
    const body = await search(query, candidates);
    const expected = query.includes('workflow') ? 'workflow_create' : 'space_save';
    assert.equal(body.results[0].name, expected, `${query}: ${body.results.map((row: { name: string }) => row.name).join(', ')}`);
  }
});

test('ordinary native authoring queries use the same relevance scale as connected operations', async () => {
  for (const [query, expected] of [
    ['create a native workflow definition', 'workflow_create'],
    ['create a Space', 'space_save'],
  ]) {
    const body = await search(query!);
    assert.equal(body.results[0].name, expected, query);
    assert.ok(body.results[0].capabilityRef, query);
  }
});

test('the live Space source-read query exposes the native exact HTML reader', async () => {
  const body = await search('get workspace view html content raw source');
  assert.equal(body.results[0].name, 'space_get_view');
  assert.ok(body.schemas.space_get_view, 'the visible reader must include its exact input schema');
});

test('ordinary provider queries remain relevant without native or provider brand boosts', async () => {
  const candidates: ToolSearchBrokerCandidate[] = [...frozenCandidates, {
    name: 'OUTLOOK_CREATE_DRAFT', summary: 'Create a draft email message in Outlook.',
    carrier: 'work_call', score: 0,
  }];
  for (const [query, expected] of [
    ['create a draft email message in Outlook', 'OUTLOOK_CREATE_DRAFT'],
    ['create a base in Airtable', 'AIRTABLE_CREATE_BASE'],
  ]) {
    const body = await search(query!, candidates);
    assert.equal(body.results[0].name, expected, query);
    assert.equal(body.results[0].capabilityRef, undefined, 'ranking cannot mint provider authority');
  }
});

test('a source rank cannot overcome stronger query relevance or promote a substring match', async () => {
  const body = await search(frozen.query, [...frozenCandidates, {
    name: 'UNRELATED_STATIC_ANALYSIS', summary: 'Analyze a statistic without creating a space.',
    carrier: 'work_call', score: 1_000_000,
  }]);
  assert.equal(body.results[0].name, 'space_save');
});
