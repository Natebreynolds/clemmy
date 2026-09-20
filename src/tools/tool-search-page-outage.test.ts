import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CandidateSourceUnavailableError, registerToolSearchTool } from './tool-search-tool.js';

test('deferred pages retain provider failure without rerunning discovery', async () => {
  let handler!: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  let searches = 0;
  registerToolSearchTool({ tool(_name: string, _description: string, _schema: unknown, callback: typeof handler) {
    handler = callback;
  } } as never, {
    allowedNames: new Set(),
    discloseForPlanning: async () => ({ version: 1, refs: {}, blockers: {} }),
    candidateSources: [
      { kind: 'authorized_composio', search: async () => {
        searches++;
        throw new CandidateSourceUnavailableError('timed_out', 'Provider discovery exceeded its deadline.');
      } },
      { kind: 'authorized_external_mcp', search: async () => {
        searches++;
        return ['one', 'two', 'three'].map(name => ({
          name: `local__${name}`, summary: `Read ${name}`, carrier: 'work_call' as const,
        }));
      }, prepareCandidates: async ({ candidates }) => [...candidates] },
    ],
  });
  const query = 'Read available records';
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = JSON.parse((await handler({ query, limit: 1, cursor,
      role_key: null, account_selection: null })).content[0]!.text);
    assert.deepEqual(page.unavailable, [{ source: 'authorized_composio',
      code: 'timed_out', reason: 'Provider discovery exceeded its deadline.' }]);
    cursor = page.next_cursor ?? null;
    pages++;
    assert.ok(pages <= 3);
  } while (cursor);
  assert.equal(pages, 3);
  assert.equal(searches, 2, 'each source is searched only on the initial page');
});
