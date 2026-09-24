import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-multiple-exact-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(testHome, 'state'));
writeFileSync(path.join(testHome, 'state/composio-catalog-cache.json'), JSON.stringify({
  at: Date.now(), data: [{ slug: 'apify', name: 'Apify', authMode: 'managed', categories: [] }],
}));
after(() => rmSync(testHome, { recursive: true, force: true }));
const { exactComposioOperationsFromQuery } = await import('./tool-search-provider-sources.js');
const { CandidateSourceUnavailableError, registerToolSearchTool } = await import('./tool-search-tool.js');

// Parsing with a declared toolkit fixture and injected discovery metadata: no live-home resets,
// provider execution, model calls, or external state changes.
const names = ['APIFY_ACTOR_RUN_GET', 'APIFY_GET_DATASET_ITEMS'];
test('a native result cannot hide failure of the separately requested provider', async () => {
  let handler: (...args: any[]) => Promise<any> = async () => { throw new Error('not registered'); };
  registerToolSearchTool({ tool(_n: any, _d: any, _s: any, fn: any) { handler = fn; } } as any, {
    allowedNames: new Set(['space_get']),
    candidateSources: [{ kind: 'authorized_composio', search: async () => {
      throw new CandidateSourceUnavailableError('timed_out', 'Provider discovery exceeded its deadline.');
    } }],
  });
  const result = await handler({ query: `space_get ${names[0]}`, limit: 8, cursor: null, role_key: null, account_selection: null });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.unavailable[0].code, 'timed_out');
  assert.match(parsed.hint, /APIFY_ACTOR_RUN_GET was named but its source did not answer/);
  assert.deepEqual(parsed.results.map((row: { name: string }) => row.name), ['space_get']);
});
test('a native match does not suppress an explicitly requested provider operation', async () => {
  let handler: (...args: any[]) => Promise<any> = async () => { throw new Error('not registered'); };
  let searches = 0;
  registerToolSearchTool({ tool(_n: any, _d: any, _s: any, fn: any) { handler = fn; } } as any, {
    allowedNames: new Set(['space_get']),
    candidateSources: [{ kind: 'authorized_composio', search: async () => {
      searches += 1;
      return [{ name: names[0]!, summary: 'Get actor run', carrier: 'work_call' as const }];
    } }],
  });
  const result = await handler({ query: `space_get ${names[0]}`, limit: 8, cursor: null, role_key: null, account_selection: null });
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(new Set(parsed.results.map((row: { name: string }) => row.name)), new Set(['space_get', names[0]]));
  assert.equal(searches, 1);
});
test('multiple exact native identities survive the local discovery shortcut', async () => {
  const nativeNames = ['space_get', 'workflow_get'];
  let handler: (...args: any[]) => Promise<any> = async () => { throw new Error('not registered'); };
  let providerSearches = 0;
  registerToolSearchTool({ tool(_n: any, _d: any, _s: any, fn: any) { handler = fn; } } as any, {
    allowedNames: new Set(nativeNames),
    candidateSources: [{ kind: 'authorized_composio', search: async () => {
      providerSearches += 1;
      return [];
    } }],
  });
  const result = await handler({ query: nativeNames.join(' '), limit: 8, cursor: null, role_key: null, account_selection: null });
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(new Set(parsed.results.map((row: { name: string }) => row.name)), new Set(nativeNames));
  assert.equal(providerSearches, 0);
});
test('multi-name native discovery does not disclose a policy-excluded operation', async () => {
  let handler: (...args: any[]) => Promise<any> = async () => { throw new Error('not registered'); };
  registerToolSearchTool({ tool(_n: any, _d: any, _s: any, fn: any) { handler = fn; } } as any, {
    allowedNames: new Set(['space_get']),
  });
  const result = await handler({ query: 'space_get workflow_get space_get', limit: 8, cursor: null, role_key: null, account_selection: null });
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(parsed.results.map((row: { name: string }) => row.name), ['space_get']);
});
test('multiple exact provider identities remain separate and deduplicated', () => {
  assert.deepEqual(exactComposioOperationsFromQuery(names.concat(names[0]!).join(' ')), names);
  assert.deepEqual(exactComposioOperationsFromQuery(names.join(' ').toLowerCase()), names);
  assert.deepEqual(exactComposioOperationsFromQuery('salesforce_sf_soql_query'), []);
  assert.deepEqual(exactComposioOperationsFromQuery('search for provider tools'), []);
});

test('both exact identities precede noisy results in a short discovery page', async () => {
  let handler: (...args: any[]) => Promise<any> = async () => { throw new Error('not registered'); };
  registerToolSearchTool({ tool(_n: any, _d: any, _s: any, fn: any) { handler = fn; } } as any, {
    allowedNames: new Set<string>(),
    candidateSources: [{
      kind: 'authorized_composio',
      search: async () => [
        ...Array.from({ length: 12 }, (_, i) => ({
          name: `UNRELATED_${i}`, summary: 'Apify actor run dataset items', carrier: 'work_call' as const, score: 1,
        })),
        ...names.map(name => ({ name, summary: name, carrier: 'work_call' as const, score: 0 })),
      ],
    }],
  });
  const result = await handler({ query: names.join(' '), limit: 8, cursor: null, role_key: null, account_selection: null });
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(new Set(parsed.results.slice(0, 2).map((row: { name: string }) => row.name)), new Set(names));
});
