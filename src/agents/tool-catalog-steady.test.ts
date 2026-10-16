/**
 * Run: node scripts/run-tests-isolated.mjs src/agents/tool-catalog-steady.test.ts
 *
 * A tool is carried into a later request only when it worked: it succeeded in
 * this request or the one before it. A promotion does not stick merely for
 * having happened (live 2026-10-16: a web read that returned 404 rode a chat's
 * tool block, and when its schema stopped being accepted every later request
 * in that chat failed). The turn's own policy still decides what is shown.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-tool-carry-'));

const { steadySessionPromotions, _resetSteadySessionPromotionsForTests, TOOL_SEARCH_ALWAYS_LOADED } = await import('./tool-catalog.js');
const { recordToolHit, forgetToolHit, getHotSet, liveHotSetSources, _resetHotSetForTest } = await import('./tool-hotset.js');

beforeEach(() => { _resetSteadySessionPromotionsForTests(); _resetHotSetForTest(); });
const all = () => true;

test('a promotion is this turn\'s only; the turn\'s policy decides what is shown', () => {
  const kernel = [...TOOL_SEARCH_ALWAYS_LOADED][0]!;
  assert.deepEqual([...steadySessionPromotions('sess-a', new Set([kernel, 'http_read']), all)], [kernel, 'http_read']);
  assert.deepEqual([...steadySessionPromotions('sess-a', new Set([kernel]), all)], [kernel],
    'a tool promoted last turn is not re-added for having been promoted');
  assert.deepEqual([...steadySessionPromotions('sess-a', new Set(['http_read', 'workflow_list']), (name) => name !== 'workflow_list')],
    ['http_read'], 'a tool this turn does not allow is not shown');
});

test('a tool that succeeded rides into the next request; a failure or a turn without use drops it', () => {
  const live = (source: number) => liveHotSetSources('sess-carry', source) ?? undefined;
  live(100);
  recordToolHit('sess-carry', 'http_read', 100);
  recordToolHit('sess-carry', 'space_get', 100);
  assert.deepEqual(getHotSet('sess-carry', live(100)).sort(), ['http_read', 'space_get']);
  assert.deepEqual(getHotSet('sess-carry', live(200)).sort(), ['http_read', 'space_get'], 'carried into the next request');
  forgetToolHit('sess-carry', 'http_read');
  assert.deepEqual(getHotSet('sess-carry', live(200)), ['space_get'], 'a failed call drops the tool');
  assert.deepEqual(getHotSet('sess-carry', live(300)), [], 'unused for a request, it is no longer carried');
});
