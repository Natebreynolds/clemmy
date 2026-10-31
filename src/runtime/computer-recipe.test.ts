/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/computer-recipe.test.ts
 *
 * A finished computer task becomes a recipe of the actions that did the work,
 * each named so it can be found again (app, window title, role and label);
 * replay re-finds every target with fresh reads, asks no model, and stops at
 * the first target it cannot find exactly once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractComputerRecipe, parseWindowSnapshot, replayComputerRecipe, type ComputerTraceCall } from './computer-recipe.js';

const ok = (structuredContent: Record<string, unknown>, text = 'ok') => ({ result: { content: [{ type: 'text', text }], structuredContent, isError: false } });
const snapshot = (snapshotId: string, windowId: number, tree: string) => ok({ snapshot_id: snapshotId, window_id: windowId, window_title: 'Notes', app_name: 'Notes', tree_markdown: tree });
const windows = (list: Array<{ id: number; title: string }>) => ok({ windows: list.map((window) => ({ app_name: 'Notes', title: window.title, window_id: window.id, pid: 19529 })) });

// The shape of the live Notes task (10-28): exploring reads around four actions.
const trace: ComputerTraceCall[] = [
  { tool: 'cua-driver__list_apps', args: { session: 't' }, result: ok({ apps: [] }) },
  { tool: 'cua-driver__launch_app', args: { bundle_id: 'com.apple.Notes', session: 't' }, result: ok({ pid: 19529 }) },
  { tool: 'cua-driver__start_session', args: { session: 't' }, result: ok({}) },
  { tool: 'cua-driver__launch_app', args: { bundle_id: 'com.apple.Notes', session: 't' }, result: ok({ pid: 19529 }) },
  { tool: 'cua-driver__list_windows', args: { app: 'Notes', pid: 19529 }, result: windows([{ id: 273, title: 'Notes' }, { id: 272, title: '' }]) },
  { tool: 'cua-driver__get_window_state', args: { pid: 19529, window_id: 273, query: 'button' },
    result: snapshot('s00000001', 273, '- [0] AXWindow "Notes" [id=_NS:8 actions=[raise]]\n  - [1] AXButton [actions=[press]]\n  - [3] AXSheet [actions=[raise]]\n    - [4] AXButton "Continue" [id=_NS:165 actions=[press]]\n') },
  { tool: 'cua-driver__click', args: { pid: 19529, window_id: 273, element_token: 's00000001:4' }, result: ok({}, '✅ Performed AXPress on [4] AXButton "Continue".') },
  { tool: 'cua-driver__get_window_state', args: { pid: 19529, window_id: 273, query: 'New' }, result: snapshot('s00000002', 273, '- [0] AXWindow "Notes"\n') },
  { tool: 'cua-driver__hotkey', args: { pid: 19529, window_id: 273, keys: ['cmd', 'n'] }, result: ok({}) },
  { tool: 'cua-driver__type_text', args: { pid: 19529, window_id: 273, text: 'TEST FIXTURE\n2026-10-28' }, result: ok({}) },
];

test('a finished task keeps only the actions, each named so it can be found again', () => {
  const extracted = extractComputerRecipe(trace);
  assert.equal(extracted.status, 'ready', JSON.stringify(extracted));
  if (extracted.status !== 'ready') return;
  assert.deepEqual(extracted.recipe.steps, [
    { kind: 'launch', bundleId: 'com.apple.Notes' },
    { kind: 'window', app: 'Notes', title: 'Notes' },
    { kind: 'press', role: 'AXButton', label: 'Continue', axId: '_NS:165' },
    { kind: 'hotkey', keys: ['cmd', 'n'] },
    { kind: 'type', text: 'TEST FIXTURE\n2026-10-28' },
  ]);
  assert.equal(JSON.stringify(extracted.recipe).includes('19529'), false, 'no process id is kept');
  assert.equal(JSON.stringify(extracted.recipe).includes('s00000001'), false, 'no element token is kept');
});

test('replay re-finds every target on a later day with new ids, and asks no model', async () => {
  const extracted = extractComputerRecipe(trace);
  assert.equal(extracted.status, 'ready');
  if (extracted.status !== 'ready') return;
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const outcome = await replayComputerRecipe(extracted.recipe, async (tool, args) => {
    calls.push({ tool, args });
    if (tool === 'launch_app') return ok({ pid: 701 });
    if (tool === 'list_windows') return windows([{ id: 12, title: '' }, { id: 15, title: 'Notes' }]);
    if (tool === 'get_window_state') return snapshot('s00000042', 15, '- [0] AXWindow "Notes"\n  - [9] AXButton "Continue" [id=_NS:165 actions=[press]]\n');
    return ok({});
  }, { session: 'replay' });
  assert.deepEqual(outcome, { status: 'done', steps: 5 });
  assert.deepEqual(calls.map((call) => call.tool), ['launch_app', 'list_windows', 'get_window_state', 'click', 'hotkey', 'type_text']);
  assert.equal(calls[3]!.args.element_token, 's00000042:9', 'the fresh token for the same button');
  assert.equal(calls[3]!.args.window_id, 15);
  assert.equal(calls[5]!.args.pid, 701);
});

test('replay stops at a target it cannot find exactly once, and acts on nothing after it', async () => {
  const extracted = extractComputerRecipe(trace);
  if (extracted.status !== 'ready') throw new Error('fixture');
  for (const tree of ['- [0] AXWindow "Notes"\n', '- [2] AXButton "Continue" [id=_NS:9]\n- [3] AXButton "Continue" [id=_NS:10]\n']) {
    const acted: string[] = [];
    const outcome = await replayComputerRecipe(extracted.recipe, async (tool) => {
      acted.push(tool);
      if (tool === 'launch_app') return ok({ pid: 701 });
      if (tool === 'list_windows') return windows([{ id: 15, title: 'Notes' }]);
      if (tool === 'get_window_state') return snapshot('s00000050', 15, tree);
      return ok({});
    }, { session: 'replay' });
    assert.equal(outcome.status, 'needs_clem');
    if (outcome.status === 'needs_clem') assert.equal(outcome.at, 2);
    assert.equal(acted.includes('click') || acted.includes('hotkey') || acted.includes('type_text'), false);
  }
  const byId = await replayComputerRecipe({ version: 1, steps: [
    { kind: 'launch', bundleId: 'com.apple.Notes' }, { kind: 'window', app: 'Notes', title: 'Notes' },
    { kind: 'press', role: 'AXButton', label: 'Continue', axId: '_NS:10' },
  ] }, async (tool) => {
    if (tool === 'launch_app') return ok({ pid: 701 });
    if (tool === 'list_windows') return windows([{ id: 15, title: 'Notes' }]);
    if (tool === 'get_window_state') return snapshot('s00000051', 15, '- [2] AXButton "Continue" [id=_NS:9]\n- [3] AXButton "Continue" [id=_NS:10]\n');
    return ok({});
  }, { session: 'replay' });
  assert.deepEqual(byId, { status: 'done', steps: 3 }, 'two same-named buttons are told apart by their accessibility id');
});

test('a task is not saved as repeatable when it cannot be repeated faithfully', () => {
  const unnamed = extractComputerRecipe([...trace.slice(0, 6),
    { tool: 'cua-driver__click', args: { pid: 19529, window_id: 273, element_token: 's00000001:1' }, result: ok({}) }]);
  assert.deepEqual(unnamed, { status: 'not_repeatable', reason: 'a click targeted an unnamed AXButton, which cannot be found again' });
  const unsupported = extractComputerRecipe([...trace.slice(0, 6),
    { tool: 'cua-driver__drag', args: { pid: 19529, window_id: 273 }, result: ok({}) }]);
  assert.equal(unsupported.status, 'not_repeatable');
  assert.equal(extractComputerRecipe(trace.slice(0, 6)).status, 'not_repeatable', 'a task that only looked has nothing to repeat');
  const refusedAction = extractComputerRecipe([...trace.slice(0, 6),
    { tool: 'cua-driver__click', args: { pid: 19529, window_id: 273, element_token: 's00000001:4' }, result: { result: { content: [], isError: true } } }]);
  assert.equal(refusedAction.status, 'not_repeatable', 'a refused action is not part of what worked');
  assert.deepEqual(parseWindowSnapshot(snapshot('s1', 1, '- [7] AXTextField "Say \\"hi\\"" [id=f1 actions=[confirm]]'))?.elements.get(7),
    { role: 'AXTextField', label: 'Say "hi"', axId: 'f1' });
});

test('the driver\'s command-line answer reads as a result replay understands; anything else is a refusal', async () => {
  const { driverCliResult } = await import('../integrations/computer-replay-driver.js');
  const launched = driverCliResult('{"pid": 701, "name": "Notes"}');
  assert.deepEqual(launched, { result: { isError: false, structuredContent: { pid: 701, name: 'Notes' } } });
  const refused = driverCliResult('Error: no element with token s00000009:4') as { result: { isError: boolean } };
  assert.equal(refused.result.isError, true);
  assert.equal((driverCliResult(null) as { result: { isError: boolean } }).result.isError, true);
  const replayed = await replayComputerRecipe({ version: 1, steps: [{ kind: 'launch', bundleId: 'com.apple.Notes' }, { kind: 'window', app: 'Notes', title: 'Notes' }] },
    async (tool) => driverCliResult(tool === 'launch_app' ? '{"pid": 701}' : '{"windows":[{"app_name":"Notes","title":"Notes","window_id":15}]}'),
    { session: 'replay' });
  assert.deepEqual(replayed, { status: 'done', steps: 2 });
});

test('a window learned from the app\'s own launch answer counts, and a window renamed by what it shows is still found once', async () => {
  const launchedWithWindows = ok({ pid: 79837, windows: [
    { app_name: 'Notes', title: 'TEST FIXTURE folder', window_id: 7516, is_on_screen: true },
    { app_name: 'Notes', title: '', window_id: 8583, is_on_screen: false },
  ] });
  const extracted = extractComputerRecipe([
    { tool: 'cua-driver__launch_app', args: { bundle_id: 'com.apple.Notes' }, result: launchedWithWindows },
    { tool: 'cua-driver__hotkey', args: { pid: 79837, window_id: 7516, keys: ['cmd', 'n'] }, result: ok({}) },
    { tool: 'cua-driver__type_text', args: { pid: 79837, window_id: 7516, text: 'TEST FIXTURE replay note' }, result: ok({}) },
  ]);
  assert.equal(extracted.status, 'ready', JSON.stringify(extracted));
  if (extracted.status !== 'ready') return;
  assert.deepEqual(extracted.recipe.steps[1], { kind: 'window', app: 'Notes', title: 'TEST FIXTURE folder' });
  const replayWith = (list: Array<{ title: string; id: number; onScreen?: boolean }>) => replayComputerRecipe(extracted.recipe, async (tool) => {
    if (tool === 'launch_app') return ok({ pid: 900 });
    if (tool === 'list_windows') return ok({ windows: list.map((window) => ({ app_name: 'Notes', title: window.title, window_id: window.id, is_on_screen: window.onScreen ?? true })) });
    return ok({});
  }, { session: 'replay' });
  assert.deepEqual(await replayWith([{ title: 'Another folder', id: 31 }, { title: '', id: 32, onScreen: false }]), { status: 'done', steps: 4 },
    'the folder changed, the window did not');
  const two = await replayWith([{ title: 'Folder A', id: 31 }, { title: 'Folder B', id: 33 }]);
  assert.equal(two.status, 'needs_clem', 'two titled windows and none named as before: Clem chooses');
});

test('the live shapes repeat: a shortcut aimed through target, typing into the new note\'s unnamed body', async () => {
  const launched = ok({ pid: 79837, windows: [{ app_name: 'Notes', title: 'TEST FIXTURE folder', window_id: 7516, is_on_screen: true }] });
  const extracted = extractComputerRecipe([
    { tool: 'cua-driver__launch_app', args: { bundle_id: 'com.apple.Notes' }, result: launched },
    { tool: 'cua-driver__hotkey', args: { keys: ['cmd', 'n'], target: { kind: 'window', pid: 79837, window_id: 7516 } }, result: { result: { isError: true, content: [] } } },
    { tool: 'cua-driver__hotkey', args: { keys: ['cmd', 'n'], target: { kind: 'window', pid: 79837, window_id: 7516 } }, result: ok({}) },
    { tool: 'cua-driver__get_window_state', args: { pid: 79837, window_id: 7516, query: 'note' },
      result: snapshot('s00000002', 7516, '- [0] AXWindow "Notes"\n    - [16] AXTextArea [id=Note[id=D84D1390-AAAA] actions=[icmactextviewaccessibilityactionmaketodo]]\n') },
    { tool: 'cua-driver__type_text', args: { text: 'TEST FIXTURE replay note', element_token: 's00000002:16' }, result: ok({}) },
  ]);
  assert.equal(extracted.status, 'ready', JSON.stringify(extracted));
  if (extracted.status !== 'ready') return;
  assert.deepEqual(extracted.recipe.steps, [
    { kind: 'launch', bundleId: 'com.apple.Notes' },
    { kind: 'window', app: 'Notes', title: 'TEST FIXTURE folder' },
    { kind: 'hotkey', keys: ['cmd', 'n'] },
    { kind: 'type', text: 'TEST FIXTURE replay note', into: { role: 'AXTextArea', label: '', idClass: 'Note' } },
  ], 'the refused first press is not kept; the note\'s own id is not kept');
  const sent: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const outcome = await replayComputerRecipe(extracted.recipe, async (tool, args) => {
    sent.push({ tool, args });
    if (tool === 'launch_app') return ok({ pid: 900 });
    if (tool === 'list_windows') return ok({ windows: [{ app_name: 'Notes', title: 'Another folder', window_id: 41, is_on_screen: true }] });
    if (tool === 'get_window_state') return snapshot('s00000009', 41, '- [3] AXTextArea [id=Note[id=NEW-NOTE-ID] actions=[x]]\n- [4] AXTextField "Search" [id=search]\n');
    return ok({});
  }, { session: 'replay' });
  assert.deepEqual(outcome, { status: 'done', steps: 4 });
  assert.equal(sent.find((call) => call.tool === 'type_text')!.args.element_token, 's00000009:3', 'typed into the new note\'s body');
  assert.equal(sent.filter((call) => call.tool === 'hotkey').length, 1, 'one new note, not two');
});
