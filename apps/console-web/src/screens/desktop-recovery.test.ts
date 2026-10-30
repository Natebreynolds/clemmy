import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
type Element = { type: unknown; props: Record<string, any> };
const element = (type: unknown, props: Record<string, any>, key?: string): Element => ({ type, props: { ...props, key } });
const children = (tree: any): Element[] => Array.isArray(tree) ? tree.flatMap(children)
  : tree && typeof tree === 'object' && tree.props ? [tree, ...children(tree.props.children)] : [];
const words = (node: any): string => Array.isArray(node) ? node.map(words).join('')
  : node && typeof node === 'object' && node.props ? words(node.props.children) : typeof node === 'string' ? node : '';
const query = (data?: any, patch: Record<string, any> = {}) => ({ data, isLoading: false, isError: false,
  isFetching: false, error: null, async refetch() {}, ...patch });
/** Invoke the actual components with inert ports and React's hook ordering.
 * Effects and rerenders run; no app runtime, vault, browser or model is used. */
function mount(file: string, exported: string, initialProps: Record<string, any>, ports: Record<string, any>, exposeLocal = false) {
  const slots: any[] = [];
  let cursor = 0;
  let changed = false;
  let pending: Array<() => void> = [];
  let props = initialProps;
  let tree: any;
  const same = (a?: any[], b?: any[]) => Boolean(a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i])));
  const memo = (read: () => any, deps?: any[]) => {
    const index = cursor++;
    if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { deps, value: read() };
    return slots[index].value;
  };
  const hooks = {
    useState(value: any) { const index = cursor++; slots[index] ??= { value: typeof value === 'function' ? value() : value };
      return [slots[index].value, (next: any) => { const result = typeof next === 'function' ? next(slots[index].value) : next;
        if (!Object.is(result, slots[index].value)) { slots[index].value = result; changed = true; } }]; },
    useRef(value: any) { const index = cursor++; slots[index] ??= { ref: { current: value } }; return slots[index].ref; },
    useMemo: memo, useCallback: (callback: any, deps?: any[]) => memo(() => callback, deps),
    useEffect(effect: () => any, deps?: any[]) { const index = cursor++;
      if (!slots[index] || !same(slots[index].deps, deps)) { const previous = slots[index]; slots[index] = { deps };
        pending.push(() => { previous?.cleanup?.(); slots[index].cleanup = effect(); }); } },
  };
  const dependencies: Record<string, any> = {
    react: { ...hooks, lazy: () => 'Lazy', Fragment: 'Fragment', Suspense: 'Suspense' }, 'react/jsx-runtime': { jsx: element, jsxs: element }, 'lucide-react': {},
    '@/components/ui/Button': { Button: 'Button' }, '@/components/ui/Field': { Field: 'Field', Input: 'Input', Select: 'Select' },
    '@tanstack/react-query': { useQueryClient: () => ({ invalidateQueries: async () => {}, setQueryData() {} }) },
    ...ports,
  };
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8') + (exposeLocal ? `\nexport { ${exported} };` : ''), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports: Record<string, any> = {};
  runInNewContext(code, { exports, Error, URLSearchParams, document: { getElementById() { return null; } }, window: { scrollTo() {}, open() {} }, require(name: string) {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name];
  } });
  const render = (nextProps = props) => {
    props = nextProps;
    for (let turns = 0; turns < 20; turns++) {
      cursor = 0; changed = false; pending = []; tree = exports[exported](props);
      pending.forEach(effect => effect());
      if (!changed) return tree;
    }
    throw new Error('Unexpected render loop');
  };
  render();
  return { render, nodes: () => children(tree), text: () => words(tree),
    button(label: string) { const node = children(tree).find(node => node.type === 'Button' && words(node).trim() === label);
      assert.ok(node, `Missing button: ${label}`); return node; },
    field(label: string) { const node = children(tree).find(node => node.type === 'Field' && node.props.label === label);
      assert.ok(node, `Missing field: ${label}`); return node.props.children('controlled-field') as Element; },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); },
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

const ui = {
  '@/components/Page': { Page: 'Page' }, '@/components/ui/Card': { Card: 'Card' },
  '@/components/ui/Switch': { Switch: 'Switch' }, '@/components/ui/Skeleton': { Skeleton: 'Skeleton' },
  '@/components/ui/QueryUnavailable': { QueryUnavailable: 'QueryUnavailable' },
  '@/components/ui/EmptyState': { EmptyState: 'EmptyState' }, '@/components/ui/StatusPill': { StatusPill: 'StatusPill' },
  '@/lib/cn': { cn: (...parts: any[]) => parts.filter(Boolean).join(' ') },
};
const deferred = () => { let resolve!: (value: any) => void; let reject!: (cause: Error) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const named = (view: ReturnType<typeof mount>, name: string) => view.nodes().filter(node => typeof node.type === 'function' && node.type.name === name);

for (const outcome of ['success', 'failure']) test(`late trace-A ${outcome} cannot appear or release pending work under trace B`, async () => {
  const a = deferred(); const b = deferred(); const requested: string[] = [];
  const view = mount('./advanced/TraceLabView.tsx', 'TraceLabView', {}, {
    ...ui, 'react-router-dom': { useNavigate: () => () => { throw new Error('Preview must not navigate or send'); } },
    '@/lib/editable-chat-draft': {},
    '@/lib/poll': { usePoll: (key: any[]) => key[0] === 'traces' ? query({ traces: [{ sessionId: 'A' }, { sessionId: 'B' }] }) : query({ sessionId: key[1] }) },
    '@/lib/traces': { getReplayPreview: (id: string) => { requested.push(id); return id === 'A' ? a.promise : b.promise; } },
  });
  const pendingA = named(view, 'TraceDetailPanel')[0].props.onReplay();
  void named(view, 'TraceDetailPanel')[0].props.onReplay();
  assert.deepEqual(requested, ['A'], 'a second click before rerender must not duplicate the read');
  named(view, 'TraceRow').find(row => row.props.trace.sessionId === 'B')!.props.onSelect(); view.render();
  const pendingB = named(view, 'TraceDetailPanel')[0].props.onReplay(); view.render();
  assert.equal(named(view, 'TraceDetailPanel')[0].props.busy, true);
  if (outcome === 'success') a.resolve({ replay: { prompt: 'A prompt' } }); else a.reject(new Error('Old trace A failure'));
  await pendingA; view.render();
  assert.equal(named(view, 'TraceDetailPanel')[0].props.replay, null);
  assert.equal(named(view, 'TraceDetailPanel')[0].props.busy, true, 'A cannot release B’s pending read');
  assert.equal(named(view, 'TraceDetailPanel')[0].props.replayError, null, 'A’s failure cannot attach to B');
  b.resolve({ replay: { prompt: 'B prompt' } }); await pendingB; view.render();
  assert.equal(named(view, 'TraceDetailPanel')[0].props.replay.prompt, 'B prompt');
  assert.equal(named(view, 'TraceDetailPanel')[0].props.busy, false);
  assert.equal(named(view, 'TraceDetailPanel')[0].props.replayError, null);
});

test('replay failure is recoverable on its exact selected trace', async () => {
  let fail = true;
  const view = mount('./advanced/TraceLabView.tsx', 'TraceLabView', {}, {
    ...ui, 'react-router-dom': {}, '@/lib/editable-chat-draft': {},
    '@/lib/poll': { usePoll: (key: any[]) => key[0] === 'traces' ? query({ traces: [{ sessionId: 'A' }] }) : query({ sessionId: 'A' }) },
    '@/lib/traces': { async getReplayPreview() { if (fail) throw new Error('Controlled preview outage'); return { replay: { prompt: 'Recovered' } }; } },
  });
  await named(view, 'TraceDetailPanel')[0].props.onReplay(); view.render();
  assert.match(named(view, 'TraceDetailPanel')[0].props.replayError, /Controlled preview outage/);
  fail = false; await named(view, 'TraceDetailPanel')[0].props.onReplay(); view.render();
  assert.equal(named(view, 'TraceDetailPanel')[0].props.replay.prompt, 'Recovered');
  assert.equal(named(view, 'TraceDetailPanel')[0].props.replayError, null);
});

const advancedPorts = {
  ...ui, 'react-router-dom': {}, '@/lib/nav': {}, '@/lib/settings': {}, '@/lib/advanced': { fmtNum: () => '—' },
  './advanced/AutonomyForm': {}, './advanced/DiagnosticsView': {}, './advanced/EvolutionView': {},
  './advanced/ObservabilityView': {}, './advanced/TraceLabView': {}, './advanced/DeveloperFlags': {},
  './advanced/ToolRecallSection': {}, './WorkflowCanvas': {},
};
for (const component of ['Usage', 'Tools']) test(`${component} failure offers Retry without a false empty result`, () => {
  let retried = 0;
  const view = mount('./Advanced.tsx', component, {}, { ...advancedPorts,
    '@/lib/poll': { usePoll: () => query(undefined, { isError: true, refetch() { retried++; } }) },
  }, true);
  const recovery = view.nodes().find(node => node.type === 'QueryUnavailable'); assert.ok(recovery);
  assert.equal(view.nodes().some(node => node.type === 'EmptyState'), false);
  recovery.props.onRetry(); assert.equal(retried, 1);
});

test('usage retains loaded totals on refresh failure and reveals every source/model when requested', () => {
  const bySource = Array.from({ length: 12 }, (_, i) => ({ source: `Source ${i}`, tokens: i, calls: 1 }));
  const byModel = Object.fromEntries(bySource.map((_, i) => [`Model ${i}`, { tokens: i, calls: 1 }]));
  const view = mount('./Advanced.tsx', 'Usage', {}, { ...advancedPorts,
    '@/lib/poll': { usePoll: () => query({ bySource, byModel }, { isError: true }) },
  }, true);
  assert.match(view.nodes().find(node => node.type === 'QueryUnavailable')!.props.description, /last loaded/);
  assert.doesNotMatch(view.text(), /Source 11/);
  view.button('Show all 12 sources and 12 models').props.onClick(); view.render();
  assert.match(view.text(), /Source 11/); assert.match(view.text(), /Model 11/);
});

test('developer flags fail into recovery rather than an endless skeleton', () => {
  const view = mount('./advanced/DeveloperFlags.tsx', 'DeveloperFlags', {}, { ...ui,
    '@/lib/poll': { usePoll: () => query(undefined, { isError: true }) }, '@/lib/settings': {},
  });
  assert.ok(view.nodes().some(node => node.type === 'QueryUnavailable'));
  assert.equal(view.nodes().some(node => node.type === 'Skeleton'), false);
});

test('failed notification destinations do not claim a phone is not set up', () => {
  let retried = 0;
  const view = mount('./settings/NotificationsEditor.tsx', 'NotificationsEditor', {}, { ...ui,
    '@/lib/poll': { usePoll: (key: string[]) => query(undefined, { isError: key[0] === 'notif-destinations', refetch() { retried++; } }) }, '@/lib/notifications': {},
  });
  assert.doesNotMatch(view.text(), /Not set up yet/);
  const recovery = view.nodes().find(node => node.type === 'QueryUnavailable'); assert.ok(recovery);
  recovery.props.onRetry(); assert.equal(retried, 1);
});

test('notification action owns duplicate clicks, reports its failure visibly and can retry', async () => {
  const pending = deferred(); let calls = 0;
  const view = mount('./settings/NotificationsEditor.tsx', 'NotificationsEditor', {}, { ...ui,
    '@/lib/poll': { usePoll: (key: string[]) => query(key[0] === 'notif-destinations' ? { destinations: [{ id: 'phone', type: 'apns', name: 'Fixture phone', enabled: true }] } : undefined) },
    '@/lib/notifications': { testDestination() { calls++; return calls === 1 ? pending.promise : Promise.resolve(); } },
  });
  const button = () => view.nodes().find(node => node.props['aria-label'] === 'Send a test to Fixture phone')!;
  button().props.onClick(); button().props.onClick(); view.render();
  assert.equal(calls, 1); assert.equal(button().props.disabled, true);
  pending.reject(new Error('Controlled delivery outage')); await flush(); view.render();
  assert.match(view.text(), /Test Fixture phone could not be confirmed: Controlled delivery outage/);
  assert.equal(button().props.disabled, false);
  button().props.onClick(); await flush(); view.render(); assert.equal(calls, 2);
});

test('code-folder read and folder-browser errors stay recoverable and do not masquerade as empty', () => {
  const view = mount('../components/connect/ProjectsPanel.tsx', 'ProjectsPanel', {}, { ...ui,
    '@/lib/poll': { usePoll: (key: string[]) => query(undefined, { isError: key[0] === 'projects' || key[0] === 'browse' }) }, '@/lib/connect': {},
  });
  assert.doesNotMatch(view.text(), /No folders added yet/);
  view.button('Browse').props.onClick(); view.render();
  assert.doesNotMatch(view.text(), /No subfolders here/);
  assert.ok(view.nodes().some(node => node.type === 'QueryUnavailable' && /Folders couldn’t/.test(node.props.title)));
});

test('failed folder add keeps the entered path, blocks duplicate Enter and offers another attempt', async () => {
  const pending = deferred(); let calls = 0;
  const view = mount('../components/connect/ProjectsPanel.tsx', 'ProjectsPanel', {}, { ...ui,
    '@/lib/poll': { usePoll: () => query({ workspaceDirs: [], projects: [], runs: [] }) },
    '@/lib/connect': { addWorkspace(path: string) { assert.equal(path, '/FRAMEWORK-TEST'); calls++; return pending.promise; } },
  });
  const input = () => view.nodes().find(node => node.props['aria-label'] === 'Workspace path')!;
  input().props.onChange({ target: { value: '/FRAMEWORK-TEST' } }); view.render();
  input().props.onKeyDown({ key: 'Enter' }); input().props.onKeyDown({ key: 'Enter' }); view.render();
  assert.equal(calls, 1); assert.equal(input().props.disabled, true);
  pending.reject(new Error('Controlled permission failure')); await flush(); view.render();
  assert.equal(input().props.value, '/FRAMEWORK-TEST'); assert.equal(input().props.disabled, false);
  assert.match(view.text(), /Controlled permission failure/);
});

test('local section links preserve the route, search, scoped return state and current location', () => {
  const state = { onboardingModelReturn: { version: 1, intent: 'explore', stamp: 123 } };
  const items = [{ id: 'accounts', label: 'Model accounts' }, { id: 'profile', label: 'Profile' }];
  const view = mount('../components/HashSectionNavigation.tsx', 'HashSectionNavigation', { label: 'Settings sections', items, defaultId: 'accounts' }, {
    ...ui, 'react-router-dom': { Link: 'Link', useLocation: () => ({ pathname: '/settings', search: '?sample=1', hash: '#profile', state }) },
  });
  assert.equal(view.nodes().find(node => node.type === 'nav')!.props['aria-label'], 'Settings sections');
  const links = view.nodes().filter(node => node.type === 'Link');
  assert.equal(links[1].props['aria-current'], 'location');
  assert.equal(links[0].props.to.pathname, '/settings'); assert.equal(links[0].props.to.hash, '#accounts');
  assert.equal(links[0].props.to.search, '?sample=1'); assert.equal(links[0].props.state, state);
  assert.equal(links[1].props.state.onboardingModelReturn, undefined, 'leaving model setup intentionally releases its scoped Back to draft action');
});

test('telemetry pause freezes only the view while receiving events for Resume', () => {
  let handlers: any;
  const view = mount('./advanced/ObservabilityView.tsx', 'ObservabilityView', {}, { ...ui,
    '@/lib/sentence-case': { sentence: (value: string) => value },
    '@/lib/telemetry': { OPERATIONAL_SOURCES: ['tool'], subscribeTelemetry(value: any) { handlers = value; return () => {}; } },
  });
  const event = (id: string) => ({ eventId: id, source: 'tool', type: id, severity: 'info', ts: new Date().toISOString() });
  const action = (label: string) => children(view.nodes().find(node => node.type === 'Page')!.props.actions)
    .find(node => node.type === 'button' && words(node).includes(label))!;
  handlers.onStatus('open'); handlers.onEvent(event('before-pause')); view.render();
  assert.match(view.text(), /before-pause/);
  action('Pause view').props.onClick(); view.render();
  handlers.onEvent(event('during-pause')); view.render();
  assert.match(view.text(), /before-pause/); assert.doesNotMatch(view.text(), /during-pause/);
  assert.match(view.text(), /Incoming events continue/);
  action('Resume view').props.onClick(); view.render();
  assert.match(view.text(), /during-pause/);
});

test('share export is closed by default while every selected-item control remains available inside', () => {
  const view = mount('../components/connect/ShareCartridge.tsx', 'ShareCartridge', {}, { ...ui,
    '@/lib/poll': { usePoll: () => query({ workflows: [{ name: 'Flow' }], workspaces: [{ slug: 'space', title: 'Space' }], skills: ['Skill'], mcpServers: ['Server'] }) },
    '@/lib/plugin-export': {}, '@/lib/bootstrap': { getAuthToken: () => null },
  });
  const disclosure = view.nodes().find(node => node.type === 'details'); assert.ok(disclosure);
  assert.equal(disclosure.props.open, undefined);
  assert.match(words(disclosure), /Share what Clem built/);
  assert.equal(view.nodes().filter(node => node.type === 'input' && node.props.type === 'checkbox').length, 4);
  assert.ok(view.button('Make the cartridge'));
});

test('computer access action failures retain the previous choice and become a visible retryable error', async () => {
  let calls = 0;
  const view = mount('./settings/ComputerAccessCard.tsx', 'ComputerAccessCard', {}, { ...ui, 'react-router-dom': { Link: 'Link' },
    '@/lib/poll': { usePoll: () => query({ access: { choice: 'standard', platform: 'fixture' } }) },
    '@/lib/settings': { async setComputerAccess() { calls++; throw new Error('Controlled access failure'); } },
  });
  const full = () => view.nodes().find(node => node.props.role === 'radio' && words(node).includes('Full access'))!;
  full().props.onClick(); full().props.onClick(); await flush(); view.render();
  assert.equal(calls, 1); assert.match(view.text(), /Controlled access failure/);
  assert.equal(full().props['aria-checked'], false); assert.equal(full().props.disabled, false);
});

test('failed autonomy save keeps the draft, disables its fieldset while pending and does not say Saved', async () => {
  const pending = deferred(); let calls = 0;
  const view = mount('./advanced/AutonomyForm.tsx', 'AutonomyForm', {}, { ...ui,
    '@/lib/poll': { usePoll: () => query({ proactivity: { policy: { enabled: false, mode: 'balanced' } } }) },
    '@/lib/settings': { patchPolicy() { calls++; return pending.promise; } },
  });
  view.button('Save').props.onClick(); view.button('Save').props.onClick(); view.render();
  assert.equal(calls, 1); assert.equal(view.nodes().find(node => node.type === 'fieldset')!.props.disabled, true);
  pending.reject(new Error('Controlled policy failure')); await flush(); view.render();
  assert.match(view.text(), /Controlled policy failure/);
  assert.doesNotMatch(view.text(), /Saved/);
  assert.equal(view.nodes().find(node => node.type === 'fieldset')!.props.disabled, false);
});

