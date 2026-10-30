import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as assistantState from '../lib/memory-assistant-state';
import * as composerDrafts from '../lib/composer-drafts';
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
    react: { ...hooks, useLayoutEffect: hooks.useEffect, lazy: () => 'Lazy', Fragment: 'Fragment', Suspense: 'Suspense' }, 'react/jsx-runtime': { jsx: element, jsxs: element }, 'lucide-react': {},
    '@/components/ui/Button': { Button: 'Button' }, '@/components/ui/Field': { Field: 'Field', Input: 'Input', Select: 'Select' },
    '@tanstack/react-query': { useQueryClient: () => ({ invalidateQueries: async () => {}, setQueryData() {} }) },
    ...ports,
  };
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8') + (exposeLocal ? `\nexport { ${exported} };` : ''), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports: Record<string, any> = {};
  runInNewContext(code, { exports, Error, URLSearchParams, setTimeout, clearTimeout,
    ResizeObserver: class { constructor(private changed: (entries: any[]) => void) {} observe() { this.changed([{ contentRect: { width: 800, height: 540 } }]); } disconnect() {} },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {}, document: { createElement: () => ({ getContext: () => ({}) }), getElementById() { return null; }, addEventListener() {}, removeEventListener() {} }, window: { scrollTo() {}, open() {}, addEventListener() {}, removeEventListener() {} }, require(name: string) {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name];
  } });
  const render = (nextProps = props) => {
    props = nextProps;
    for (let turns = 0; turns < 20; turns++) {
      cursor = 0; changed = false; pending = []; tree = exports[exported](props);
      const graphHost = children(tree).find(node => node.type === 'div' && node.props.ref && String(node.props.className).startsWith('relative overflow-hidden'));
      if (graphHost && !graphHost.props.ref.current) graphHost.props.ref.current = { addEventListener() {}, removeEventListener() {} };
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

const ui = { '@/components/ui/Card': { Card: 'Card' }, '@/components/ui/StatusPill': { StatusPill: 'StatusPill' },
  '@/components/ui/Skeleton': { Skeleton: 'Skeleton' }, '@/components/ui/EmptyState': { EmptyState: 'EmptyState' },
  '@/lib/cn': { cn: (...values: any[]) => values.filter(Boolean).join(' ') } };
const memoryPorts = { ...ui,
  'react-router-dom': { Link: 'Link' }, '@/components/MemoryGraphContainer': {}, '@/lib/poll': { usePoll: () => query() },
  './advanced/ToolRecallSection': {}, '@/lib/memory': { FACT_KINDS: [] }, '@/lib/memory-assurance': {},
  '@/components/memory/HitRow': {}, '@/components/memory/HealthStrip': {}, '@/components/memory/ReviewPane': {},
  '@/components/memory/LearnedPane': {}, '@/components/memory/MemoryDetail': {}, '@/components/memory/work/MemoryWorkPanel': {},
  '@/components/memory/MemoryAssistant': {}, '@/lib/memory-work': {}, './memory-workspace.css': {}, '@clem/chat-engine': {},
  '@/components/memory/ScopeChip': {}, '@/lib/memory-scope': {}, '@/lib/projects': {}, '@/lib/agents': {},
  '@/lib/platform': {}, '@/components/memory/ExactMemoryDetail': {}, '@/lib/memory-fact-links': {},
};
const deferred = () => { let resolve!: (value: any) => void; let reject!: (cause: Error) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('late standing-goal save retains newer typing and owns duplicate clicks across view visibility changes', async () => {
  const pending = deferred(); let calls = 0;
  const props = { qc: { invalidateQueries() {} }, visible: true };
  const view = mount('./Memory.tsx', 'SourcesTab', props, { ...memoryPorts,
    '@/lib/poll': { usePoll: () => query({ files: [], goals: [], pointers: [], profile: {} }) },
    '@/lib/memory': { addGoal(title: string, description: string) { calls++; assert.equal(title, 'Original'); assert.equal(description, 'Original detail'); return pending.promise; } },
  }, true);
  const input = (label: string) => view.nodes().find(node => node.props['aria-label'] === label)!;
  input('Goal title').props.onChange({ target: { value: 'Original' } }); input('Goal description').props.onChange({ target: { value: 'Original detail' } }); view.render();
  view.button('Add').props.onClick(); view.button('Add').props.onClick(); view.render(); assert.equal(calls, 1);
  input('Goal title').props.onChange({ target: { value: 'Newer' } }); view.render({ ...props, visible: false });
  pending.resolve({ ok: true }); await flush(); view.render({ ...props, visible: true });
  assert.equal(input('Goal title').props.value, 'Newer'); assert.equal(input('Goal description').props.value, 'Original detail');
  assert.match(view.text(), /newer draft is still here/);
});

test('standing-goal failure retains its editable draft and exposes recovery', async () => {
  const view = mount('./Memory.tsx', 'SourcesTab', { qc: { invalidateQueries() {} } }, { ...memoryPorts,
    '@/lib/poll': { usePoll: () => query({ files: [], goals: [], pointers: [], profile: {} }) },
    '@/lib/memory': { async addGoal() { throw new Error('Controlled goal failure'); } },
  }, true);
  for (const label of ['Goal title', 'Goal description']) view.nodes().find(node => node.props['aria-label'] === label)!.props.onChange({ target: { value: label } });
  view.render(); view.button('Add').props.onClick(); await flush(); view.render();
  assert.match(view.text(), /Controlled goal failure/);
  assert.equal(view.nodes().find(node => node.props['aria-label'] === 'Goal title')!.props.value, 'Goal title');
});

test('Sources failed reads never claim zero indexed files and all three sources offer Retry', () => {
  const retried: string[] = [];
  const view = mount('./Memory.tsx', 'SourcesTab', { qc: { invalidateQueries() {} } }, { ...memoryPorts,
    '@/lib/poll': { usePoll: (key: string[]) => query(undefined, { isError: true, refetch() { retried.push(key[0]); } }) },
  }, true);
  assert.doesNotMatch(view.text(), /No files indexed yet|\(0 files\)/);
  const recoveries = view.nodes().filter(node => typeof node.type === 'function' && node.type.name === 'CouldNotRead');
  assert.equal(recoveries.length, 3); recoveries.forEach(node => node.props.onRetry());
  assert.deepEqual(retried.sort(), ['context', 'memory-files', 'source-map']);
});

test('Facts editor retains the same draft when hidden for another view or search', () => {
  const view = mount('./Memory.tsx', 'FactsTab', { visible: true, onChanged() {}, onPick() {} }, { ...memoryPorts,
    '@/lib/poll': { usePoll: () => query() },
    '@/lib/memory-scope': { factScopeFromKey: () => ({ kind: 'all' }), scopedFacts: () => ({ supported: true, facts: [] }), factScopeChoices: () => [{ key: 'all', label: 'All' }, { key: 'everywhere', label: 'Everywhere' }] },
    '@/lib/projects': { projectKeys: { list: () => [] } },
  }, true);
  const input = () => view.nodes().find(node => node.props['aria-label'] === 'New fact')!;
  input().props.onChange({ target: { value: 'Keep my draft' } }); view.render({ visible: false, onChanged() {}, onPick() {} });
  assert.equal(view.nodes()[0].props.hidden, true);
  view.render({ visible: true, onChanged() {}, onPick() {} }); assert.equal(input().props.value, 'Keep my draft');
});

test('Memory route retains visited editor identities while navigating between views', () => {
  let params = new URLSearchParams('tab=facts');
  const view = mount('./Memory.tsx', 'MemoryOverview', {}, { ...memoryPorts,
    'react-router-dom': { Link: 'Link', useSearchParams: () => [params, (update: any) => { params = update(params); }] },
    '@tanstack/react-query': { useQueryClient: () => ({ invalidateQueries() {} }), useQuery: () => query() },
    '@/lib/memory-scope': { factScopeFromKey: () => ({ kind: 'all' }), factScopeKey: () => 'all' },
    '@/lib/platform': { isMac: () => false },
  }, true);
  const fact = () => view.nodes().find(node => typeof node.type === 'function' && node.type.name === 'FactsTab')!;
  const firstType = fact().type; assert.equal(fact().props.visible, true);
  view.nodes().find(node => node.type === 'button' && words(node).includes('Sources'))!.props.onClick(); view.render();
  assert.equal(fact().type, firstType); assert.equal(fact().props.key, 'facts-editor'); assert.equal(fact().props.visible, false);
  assert.ok(view.nodes().some(node => typeof node.type === 'function' && node.type.name === 'SourcesTab' && node.props.visible));
});

test('failed readiness and health reads never manufacture zero durable-link metrics', () => {
  const view = mount('./Memory.tsx', 'MemoryReviewTab', {}, { ...memoryPorts,
    '@/lib/poll': { usePoll: () => query(undefined, { isError: true }) },
  }, true);
  assert.equal(view.nodes().some(node => typeof node.type === 'function' && node.type.name === 'GraphTruthCoverage'), false);
  assert.equal(view.nodes().filter(node => typeof node.type === 'function' && node.type.name === 'CouldNotRead').length, 2);
});

test('actual Memory assistant remount binds the same draft and exact saved conversation without sending', () => {
  const owner = assistantState.memoryAssistantOwner(() => 'FRAMEWORK-TEST-assistant-remount');
  const key = `session:${owner.scope}`;
  composerDrafts.writeComposerDraft(key, () => ({ text: 'Keep my unsent question', attachments: [] }));
  let sends = 0; const options: any[] = [];
  const ports = { ...ui, 'react-router-dom': { Link: 'Link' }, '@clem/chat-engine': {},
    '@/components/chat/ChatBubble': {}, '@/components/chat/Composer': { Composer: 'Composer' }, '@/components/chat/ConversationTasks': {},
    '@/lib/composer-drafts': composerDrafts, '@/lib/memory-assistant-state': assistantState,
    '@/lib/conversation-tasks': { useConversationTasks: () => ({ cards: [], tasks: [], ownedIds: new Set() }) },
    '@/lib/inbox': {}, '@/lib/last-session': { unifiedChatSessionId: (id: string) => id },
    '@/lib/useChat': { useChat(value: any) { options.push(value); return { busy: false, messages: [], pendingPost: null,
      sessionId: { current: 'FRAMEWORK-TEST-execution' }, conversationSessionId: { current: 'FRAMEWORK-TEST-conversation' }, send() { sends++; } }; } },
  };
  const first = mount('../components/memory/MemoryAssistant.tsx', 'MemoryAssistant', { open: false, context: null }, ports);
  first.unmount();
  const second = mount('../components/memory/MemoryAssistant.tsx', 'MemoryAssistant', { open: false, context: null }, ports);
  assert.equal(options.at(-1).pendingStorageScope, owner.scope);
  assert.equal(options.at(-1).initialSessionId, 'FRAMEWORK-TEST-execution');
  assert.equal(options.at(-1).conversationSessionId, 'FRAMEWORK-TEST-conversation');
  assert.equal(second.nodes().find(node => node.type === 'Composer')!.props.draftSessionId, owner.scope);
  assert.equal(composerDrafts.readComposerDraft(key).text, 'Keep my unsent question'); assert.equal(sends, 0);
  second.unmount();
});

function graphView(getGraph: () => Promise<any>, getGraphNeighborhood?: (id: string) => Promise<any>) {
  return mount('../components/KnowledgeGraph3D.tsx', 'default', {}, { ...ui,
    'react-force-graph-3d': { default: 'ForceGraph3D' }, three: {},
    '@/lib/sentence-case': { sentence: (text: string) => text }, 'three/examples/jsm/postprocessing/UnrealBloomPass.js': {},
    '@/lib/memory': { getGraph, getGraphNeighborhood },
  });
}
const graphData = { nodes: [{ id: 'fact:A', label: 'A', type: 'fact' }, { id: 'fact:B', label: 'B', type: 'fact' }], edges: [] };
test('graph read failure offers a local retry and recovers without replacing the 3D view', async () => {
  let calls = 0;
  const view = graphView(async () => { if (++calls === 1) throw new Error('Controlled graph outage'); return graphData; });
  await flush(); view.render();
  const retry = view.nodes().find(node => node.type === 'button' && words(node) === 'Retry graph'); assert.ok(retry);
  retry.props.onClick(); view.render(); await flush(); view.render();
  assert.equal(calls, 2); assert.ok(view.nodes().some(node => node.type === 'ForceGraph3D'));
});
for (const outcome of ['success', 'failure']) test(`late neighborhood ${outcome} belongs to its exact selected node`, async () => {
  const a = deferred(); const b = deferred(); const calls: string[] = [];
  const view = graphView(async () => graphData, id => { calls.push(id); return id === 'fact:A' ? a.promise : b.promise; });
  await flush(); view.render();
  const graph = () => view.nodes().find(node => node.type === 'ForceGraph3D')!;
  const expand = () => view.nodes().find(node => node.type === 'button' && /Expand stored|Expanding/.test(words(node)))!;
  graph().props.onNodeClick(graphData.nodes[0]); view.render(); expand().props.onClick(); expand().props.onClick(); view.render();
  assert.deepEqual(calls, ['fact:A']);
  graph().props.onNodeClick(graphData.nodes[1]); view.render(); expand().props.onClick(); view.render();
  if (outcome === 'success') a.resolve({ nodes: [{ id: 'fact:stale', type: 'fact' }], edges: [] }); else a.reject(new Error('Old A failure'));
  await flush(); view.render();
  assert.equal(expand().props.disabled, true); assert.doesNotMatch(view.text(), /Old A failure/);
  assert.equal(graph().props.graphData.nodes.some((node: any) => node.id === 'fact:stale'), false);
  b.resolve({ nodes: [{ id: 'fact:current', type: 'fact' }], edges: [] }); await flush(); view.render();
  assert.equal(graph().props.graphData.nodes.some((node: any) => node.id === 'fact:current'), true);
});

