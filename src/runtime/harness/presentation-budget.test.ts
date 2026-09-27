/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/presentation-budget.test.ts
 *
 * One presentation-budget resolver keyed on the EFFECTIVE inner tool. A carrier
 * and the child it dispatches must resolve the same number: when they differ,
 * the carrier digests the child's projection again as if it were raw data.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-presentation-budget-'));
process.env.CLEMENTINE_HOME = home;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(home, 'state'), { recursive: true });

const {
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  PROMPT_INLINE_RECALLABLE_RESULT_CHARS,
  MCP_TRANSPORT_MAX_CHARS,
  inlineResultBudgetForModel,
  presentationBudgetFor,
  retainedReaderMaxChars,
  mcpTransportPresentationMaxChars,
  answererViewBudgetFor,
} = await import('./tool-output-format.js');
const { recordCatalogWindow, recordWindowRejection, effectiveContextWindow } = await import('./model-window-observations.js');
const { withHarnessRunContext, ToolCallsCounter } = await import('./brackets.js');
const { inheritedNestedHarnessContext } = await import('../../tools/inner-dispatch.js');
const { recallSliceChars } = await import('../../tools/recall-tools.js');

after(() => rmSync(home, { recursive: true, force: true }));

const SMALL_WINDOW_MODEL = 'fixture-small-window-model';
const LARGE_WINDOW_MODEL = 'fixture-large-window-model';
recordWindowRejection(SMALL_WINDOW_MODEL, 32_001);
recordCatalogWindow(LARGE_WINDOW_MODEL, 1_000_000, 'fixture');

const carried = (carrier: 'call_tool' | 'work_call', name: string, args: Record<string, unknown>) => ({
  toolName: carrier,
  args: { name, args_json: JSON.stringify(args) },
});

test('a carrier resolves exactly the budget of the inner tool it names', () => {
  for (const routedModelId of [undefined, SMALL_WINDOW_MODEL]) {
    for (const [name, args] of [
      ['space_get', { slug: 'fixture' }],
      ['memory_recall_all', {}],
      ['tool_search', { query: 'fixture' }],
      ['read_file', { path: '/tmp/x' }],
      ['read_file', { path: '/tmp/x', max_chars: 40_000 }],
      ['composio_execute_tool', { tool_slug: 'FIXTURE_READ', arguments: '{}' }],
      ['fixtureserver__fixture_read', {}],
    ] as const) {
      const direct = presentationBudgetFor({ toolName: name, args, routedModelId });
      for (const carrier of ['call_tool', 'work_call'] as const) {
        assert.equal(presentationBudgetFor({ ...carried(carrier, name, args), routedModelId }), direct,
          `${carrier} → ${name} (${routedModelId ?? 'default window'})`);
      }
    }
  }
});

test('Clementine state reads keep the whole-result budget; provider results keep the keyhole', () => {
  assert.equal(presentationBudgetFor({ toolName: 'space_get', args: { slug: 'x' } }), DEFAULT_TOOL_RESULT_MAX_CHARS);
  assert.equal(presentationBudgetFor(carried('call_tool', 'space_get', { slug: 'x' })), DEFAULT_TOOL_RESULT_MAX_CHARS);
  for (const input of [
    { toolName: 'composio_execute_tool', args: { tool_slug: 'X', arguments: '{}' } },
    carried('work_call', 'composio_execute_tool', { tool_slug: 'X', arguments: '{}' }),
    carried('work_call', 'fixtureserver__fixture_read', {}),
    { toolName: 'fixtureserver__space_get', args: { slug: 'x' } },
    { toolName: 'call_tool', args: 'not a carrier envelope' },
    { toolName: 'run_shell_command', args: { command: 'ls' } },
  ]) {
    assert.equal(presentationBudgetFor(input), PROMPT_INLINE_RECALLABLE_RESULT_CHARS, JSON.stringify(input));
  }
  // A local reader's explicit larger preview survives a carrier too.
  assert.equal(presentationBudgetFor(carried('work_call', 'read_file', { path: '/tmp/x', max_chars: 40_000 })), 40_000);
});

test('the whole-result budget scales down for a small window and never up for a large one', () => {
  assert.equal(effectiveContextWindow(SMALL_WINDOW_MODEL), 32_000);
  assert.equal(inlineResultBudgetForModel(SMALL_WINDOW_MODEL), 11_200);
  assert.equal(presentationBudgetFor({ toolName: 'space_get', args: {}, routedModelId: SMALL_WINDOW_MODEL }), 11_200);
  assert.equal(inlineResultBudgetForModel(undefined), DEFAULT_TOOL_RESULT_MAX_CHARS);
  assert.equal(effectiveContextWindow(LARGE_WINDOW_MODEL), 1_000_000);
  for (const large of [LARGE_WINDOW_MODEL, 'fixture-unknown-model']) {
    assert.equal(inlineResultBudgetForModel(large), DEFAULT_TOOL_RESULT_MAX_CHARS, large);
  }
  // Provider results never widen with the window.
  assert.equal(presentationBudgetFor({ toolName: 'fixtureserver__read', routedModelId: SMALL_WINDOW_MODEL }),
    PROMPT_INLINE_RECALLABLE_RESULT_CHARS);
});

test('a transport mirror child presents into the same routed model; a batch item does not inherit it', async () => {
  await withHarnessRunContext({
    sessionId: 'sess-presentation-inherit',
    counter: new ToolCallsCounter(5),
    routedModelId: SMALL_WINDOW_MODEL,
  }, () => {
    assert.equal(inheritedNestedHarnessContext('sess-presentation-inherit', false, 'mirror-call').routedModelId,
      SMALL_WINDOW_MODEL);
    assert.equal(inheritedNestedHarnessContext('sess-presentation-inherit', false, undefined).routedModelId, undefined);
    assert.equal(inheritedNestedHarnessContext('another-session', false, 'mirror-call').routedModelId, undefined);
  });
});

test('retained-output readers own their slice: presentation never clips them, direct or through a carrier', () => {
  for (const routedModelId of [undefined, SMALL_WINDOW_MODEL, LARGE_WINDOW_MODEL]) {
    for (const [name, args] of [
      ['recall_tool_result', { call_id: 'c', max_chars: 60_000 }],
      ['recall_tool_result', { call_id: 'c' }],
      ['tool_output_query', { call_id: 'c' }],
      ['file_query', { query: 'q', call_id: 'c' }],
    ] as const) {
      const direct = presentationBudgetFor({ toolName: name, args, routedModelId });
      assert.ok(direct > retainedReaderMaxChars(routedModelId), `${name} is never re-clipped`);
      assert.ok(direct <= MCP_TRANSPORT_MAX_CHARS, `${name} fits the CLI's MCP wire`);
      assert.equal(presentationBudgetFor({ ...carried('call_tool', name, args), routedModelId }), direct);
    }
  }
  // A foreign tool that merely shares a reader's name is not a reader.
  assert.equal(presentationBudgetFor({ toolName: 'fixtureserver__recall_tool_result', args: { call_id: 'c' } }),
    PROMPT_INLINE_RECALLABLE_RESULT_CHARS);
});

test('a bare recall slice is one inline result for the window; an explicit one is honored up to the ceiling', () => {
  assert.equal(recallSliceChars(undefined, undefined), DEFAULT_TOOL_RESULT_MAX_CHARS);
  assert.equal(recallSliceChars(undefined, SMALL_WINDOW_MODEL), 11_200);
  assert.equal(recallSliceChars(30_000, SMALL_WINDOW_MODEL), 11_200, 'never above what a small window takes');
  assert.equal(recallSliceChars(500_000, undefined), 30_000, 'clamped to the default window ceiling');
  assert.equal(recallSliceChars(500_000, LARGE_WINDOW_MODEL), MCP_TRANSPORT_MAX_CHARS - 2_000,
    'a large window is bounded by what the MCP wire carries whole');
  assert.equal(recallSliceChars(10, undefined), 100);
});

test('the reader bound follows the window, keeps the baseline on a 200k window, and never exceeds the MCP wire', () => {
  assert.equal(retainedReaderMaxChars(undefined), 50_000);
  assert.equal(retainedReaderMaxChars(SMALL_WINDOW_MODEL), 11_200);
  assert.equal(retainedReaderMaxChars(LARGE_WINDOW_MODEL), MCP_TRANSPORT_MAX_CHARS - 2_000);
  // An explicit local read preview may exceed it on the host lane, never on the MCP wire.
  const read = carried('call_tool', 'read_file', { path: '/tmp/x', max_chars: 90_000 });
  assert.equal(presentationBudgetFor(read), 90_000);
  assert.equal(mcpTransportPresentationMaxChars(read), MCP_TRANSPORT_MAX_CHARS);
});

test('a reviewer\'s view of a result uses the answerer\'s budget, never more than its window shows whole', () => {
  // A window-bounded read is bounded for the reviewer exactly as for the answerer.
  assert.equal(answererViewBudgetFor({ toolName: 'space_get', args: {}, routedModelId: SMALL_WINDOW_MODEL }), 11_200);
  // A keyhole result keeps one whole inline result for the same window.
  assert.equal(answererViewBudgetFor({ toolName: 'fixtureserver__read', routedModelId: SMALL_WINDOW_MODEL }), 11_200);
  assert.equal(answererViewBudgetFor({ toolName: 'fixtureserver__read' }), DEFAULT_TOOL_RESULT_MAX_CHARS);
  // An explicit larger local read is what the answerer was shown.
  assert.equal(answererViewBudgetFor({ toolName: 'read_file', args: { path: '/tmp/x', max_chars: 40_000 } }), 40_000);
});
