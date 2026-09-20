import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exactComposioOperationsFromQuery } from './tool-search-provider-sources.js';
import { registerToolSearchTool } from './tool-search-tool.js';

// Pure parsing and injected discovery metadata: no fixture home or resets,
// provider execution, model calls, or external state changes.
const names = ['APIFY_ACTOR_RUN_GET', 'APIFY_GET_DATASET_ITEMS'];
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
