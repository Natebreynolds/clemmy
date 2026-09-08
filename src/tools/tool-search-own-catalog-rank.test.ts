/** Native and provider metadata share query relevance; source membership is
 * not a permanent ranking floor. Exercise model-visible ordering in both lanes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerToolSearchTool, type ToolSearchCandidateSource } from './tool-search-tool.js';
import { AUTHORIZED_LIVE_READ_REGISTRY_PROVENANCE } from '../runtime/harness/live-read-planning-authority.js';

const SRC = new URL('./tool-search-tool.ts', import.meta.url);
async function search(query: string, planning: boolean, sources: ToolSearchCandidateSource[]) {
  let handler!: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  registerToolSearchTool({ tool(_name: string, _description: string, _schema: unknown, callback: typeof handler) { handler = callback; } } as never, {
    allowedNames: new Set(['space_save', 'workflow_get']), candidateSources: sources,
    ...(planning ? { discloseForPlanning: async () => ({ version: 1 as const, refs: {}, blockers: {} }) } : {}),
  });
  return JSON.parse((await handler({ query, limit: 8, cursor: null, role_key: null, account_selection: null })).content[0]!.text);
}
const weakProvider: ToolSearchCandidateSource = { kind: 'authorized_composio', search: async () => [{
  name: 'CRM_EXPORT_CUSTOMERS', summary: 'Export customer records into a report.', carrier: 'work_call', score: 1,
}] };
const acquired: ToolSearchCandidateSource = { kind: AUTHORIZED_LIVE_READ_REGISTRY_PROVENANCE, search: async () => [{
  name: 'local_workspace_inventory', summary: 'Read workspace information from the current local connection.', carrier: 'work_call', score: 0,
}] };

test('relevant native metadata beats weak provider rank in planning and ordinary discovery', async () => {
  for (const planning of [false, true]) {
    const result = await search('create a new Space with a static HTML view', planning, [weakProvider]);
    assert.equal(result.results[0]?.name, 'space_save');
    assert.ok(result.results.some((row: { name: string }) => row.name === 'CRM_EXPORT_CUSTOMERS'),
      'lower relevance changes order, not provider visibility');
  }
});

test('query-bound acquired read retains precedence on planning discovery', async () => {
  const result = await search('create a new Space with a static HTML view', true, [weakProvider, acquired]);
  assert.equal(result.results[0]?.name, 'local_workspace_inventory');
  assert.equal(result.results[0]?.capabilityRef, undefined, 'ranking alone grants no callable authority');
});

test('acquired read precedence does not depend on a planning-membership boost', async () => {
  const result = await search('create a new Space with a static HTML view', false, [weakProvider, acquired]);
  assert.equal(result.results[0]?.name, 'local_workspace_inventory');
});

test('a relevant provider remains visible and can lead without a membership boost', async () => {
  const provider: ToolSearchCandidateSource = { kind: 'authorized_composio', search: async () => [{
    name: 'CONTENT_EXTRACT_ARTICLE', summary: 'Extract article text from a webpage URL.', carrier: 'work_call', score: 0,
  }] };
  for (const planning of [false, true]) {
    const result = await search('extract article text from a webpage URL', planning, [provider]);
    assert.equal(result.results[0]?.name, 'CONTENT_EXTRACT_ARTICLE');
    assert.equal(result.results[0]?.capabilityRef, undefined);
  }
});

// ── the window, not the rank ────────────────────────────────────────────────
// The tier design only decides among candidates that REACH the ranker. The
// per-source truncation runs before scoring, so a broad query that fills the
// window with provider rows evicts an acquired live read whose boost would
// have won. Live 2026-09-03 run 15: "run shell command Salesforce sf CLI query
// prospects" returned 20 provider rows and zero salesforce_sf_soql_query,
// while run 13's "run shell command salesforce sf cli" found it — same sealed
// descriptor, same machine, two extra words.
test('an acquired live read survives a window flooded by provider rows', () => {
  const src = readFileSync(SRC, 'utf8');
  const truncation = src.slice(
    src.indexOf('const sourced = candidates'),
    src.indexOf('.slice(0, TOOL_SEARCH_WINDOW_RESULTS);', src.indexOf('const sourced = candidates')),
  );
  assert.ok(
    truncation.includes('isAcquiredLiveReadCandidate'),
    'acquired candidates must be carried past the per-source truncation, '
    + 'or broker volume decides what the ranker sees',
  );
  // and the bound must still be applied, so a source cannot return unbounded rows
  assert.ok(
    src.includes('].slice(0, TOOL_SEARCH_WINDOW_RESULTS);'),
    'the window must stay bounded',
  );
});
