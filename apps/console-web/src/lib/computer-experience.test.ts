import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as navigation from './computer-tasks-navigation';

type Element = { type: unknown; props: Record<string, any> };
const element = (type: unknown, props: Record<string, any>, key?: string): Element => ({ type, props: { ...props, key } });
const children = (node: any): Element[] => Array.isArray(node) ? node.flatMap(children)
  : node && typeof node === 'object' && node.props ? [node, ...children(node.props.children)] : [];
const words = (node: any): string => Array.isArray(node) ? node.map(words).join('')
  : node && typeof node === 'object' && node.props ? words(node.props.children) : typeof node === 'string' ? node : '';
const query = (data?: any, patch: Record<string, any> = {}) => ({ data, isLoading: false, isError: false, refetch: async () => {}, ...patch });
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred<T = any>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Actual components, effects and PendingCommit; only host hooks and external
 * transports are inert. This exercises callbacks before and after rerenders. */
function mount(file: string, exported: string, initialProps: Record<string, any>, ports: Record<string, any>) {
  const slots: any[] = [];
  let cursor = 0, changed = false, alive = true, props = initialProps, tree: any;
  let pending: Array<() => void> = [];
  const same = (a?: any[], b?: any[]) => Boolean(a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i])));
  const memo = (read: () => any, deps?: any[]) => {
    const index = cursor++;
    if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { deps, value: read() };
    return slots[index].value;
  };
  const effect = (run: () => any, deps?: any[]) => {
    const index = cursor++;
    if (!slots[index] || !same(slots[index].deps, deps)) {
      const previous = slots[index]; slots[index] = { deps };
      pending.push(() => { previous?.cleanup?.(); slots[index].cleanup = run(); });
    }
  };
  const hooks = {
    useState(value: any) { const index = cursor++; slots[index] ??= { value: typeof value === 'function' ? value() : value };
      return [slots[index].value, (next: any) => { if (!alive) return;
        const result = typeof next === 'function' ? next(slots[index].value) : next;
        if (!Object.is(result, slots[index].value)) { slots[index].value = result; changed = true; }
      }]; },
    useRef(value: any) { const index = cursor++; slots[index] ??= { ref: { current: value } }; return slots[index].ref; },
    useMemo: memo, useCallback: (callback: any, deps?: any[]) => memo(() => callback, deps),
    useEffect: effect, useLayoutEffect: effect,
    createContext: () => ({ Provider: 'Provider' }), useContext: () => null,
  };
  const dependencies: Record<string, any> = {
    react: { ...hooks, Fragment: 'Fragment' }, 'react/jsx-runtime': { jsx: element, jsxs: element },
    'lucide-react': new Proxy({}, { get: () => 'svg' }),
    '@/components/ui/Button': { Button: 'Button' }, '@/components/ui/Card': { Card: 'Card' },
    '@/components/ui/EmptyState': { EmptyState: 'EmptyState' }, '@/components/ui/QueryUnavailable': { QueryUnavailable: 'QueryUnavailable' },
    '@/lib/computer-tasks-navigation': navigation,
    ...ports,
  };
  function compile(source: string, expose?: string) {
    // Uninvoked nested surfaces are left inert; missing imports used by the
    // component under test still fail at their actual point of use.
    const parsed = ts.createSourceFile('component.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
    for (const statement of parsed.statements) if (ts.isImportDeclaration(statement)) {
      const name = (statement.moduleSpecifier as ts.StringLiteral).text;
      dependencies[name] ??= {};
    }
    const code = ts.transpileModule(source + (expose ? `\nexport { ${expose} };` : ''), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const exports: Record<string, any> = {};
    runInNewContext(code, { exports, Error, URLSearchParams, require: (name: string) => dependencies[name],
      window: { location: { href: 'http://framework.test/console/' } },
    });
    return exports;
  }
  dependencies['@/lib/pending-commit'] = compile(readFileSync(new URL('./pending-commit.ts', import.meta.url), 'utf8'));
  const exports = compile(readFileSync(new URL(file, import.meta.url), 'utf8'), exported);
  const render = (next = props) => {
    props = next;
    for (let turns = 0; turns < 20; turns++) {
      cursor = 0; changed = false; pending = [];
      tree = exports[exported](props); pending.forEach(run => run());
      if (!changed) return tree;
    }
    throw new Error('Unexpected render loop');
  };
  render();
  return { render, nodes: () => children(tree), text: () => words(tree),
    button(label: string) { const node = children(tree).find(node => (node.type === 'Button' || node.type === 'button')
      && (words(node).trim() === label || node.props['aria-label'] === label));
      assert.ok(node, `Missing button: ${label}`); return node; },
    one(type: string) { const node = children(tree).find(node => node.type === type); assert.ok(node, `Missing ${type}`); return node; },
    unmount() { alive = false; slots.forEach(slot => slot?.cleanup?.()); },
  };
}

test('saving the accepted computer task retries the same source and links to its actual destination', async () => {
  const source = { sessionId: 'accepted/root:one', sourceUserSeq: 7 };
  const calls: any[] = [], attempts = [deferred(), deferred()]; let invalidations = 0;
  const view = mount('../components/chat/SaveComputerTask.tsx', 'SaveComputerTask', { source }, {
    'react-router-dom': { Link: 'Link' },
    '@tanstack/react-query': { useQueryClient: () => ({ invalidateQueries: async () => { invalidations++; } }) },
    '@/lib/api': { api: (path: string, options: any) => { calls.push({ path, ...options }); return attempts[calls.length - 1].promise; } },
  });
  const save = view.button('Save to repeat without AI').props.onClick;
  save(); save(); assert.equal(calls.length, 1, 'the pending lock applies before React rerenders');
  attempts[0].reject(new Error('Connection interrupted')); await flush(); view.render();
  assert.match(view.text(), /Connection interrupted/); assert.equal(view.one('p').props.role, 'alert');
  view.button('Retry save').props.onClick(); assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => JSON.parse(call.body)), [source, source]);
  attempts[1].resolve({ task: { name: 'Controlled weekly export' } }); await flush(); view.render();
  assert.equal(invalidations, 1); assert.match(view.text(), /Saved as “Controlled weekly export”/);
  assert.equal(view.one('Link').props.to, '/automate?tab=computer'); view.unmount();
});

test('a replaced accepted source or unmounted save cannot receive a stale completion', async () => {
  const oldSource = { sessionId: 'accepted-old', sourceUserSeq: 2 }, nextSource = { sessionId: 'accepted-new', sourceUserSeq: 4 };
  for (const retired of ['source', 'unmount']) {
    const pending = deferred(); let invalidations = 0;
    const view = mount('../components/chat/SaveComputerTask.tsx', 'SaveComputerTask', { source: oldSource }, {
      'react-router-dom': { Link: 'Link' },
      '@tanstack/react-query': { useQueryClient: () => ({ invalidateQueries: async () => { invalidations++; } }) },
      '@/lib/api': { api: () => pending.promise },
    });
    const oldSave = view.button('Save to repeat without AI').props.onClick;
    oldSave();
    if (retired === 'source') view.render({ source: nextSource }); else view.unmount();
    pending.resolve({ task: { name: 'Old task' } }); await flush();
    assert.equal(invalidations, 0);
    if (retired === 'source') { view.render(); assert.doesNotMatch(view.text(), /Old task|Saved as/); assert.ok(view.button('Save to repeat without AI')); view.unmount(); }
  }
});

test('a retained save callback cannot submit a replaced accepted source', () => {
  const calls: any[] = [];
  const view = mount('../components/chat/SaveComputerTask.tsx', 'SaveComputerTask', { source: { sessionId: 'old', sourceUserSeq: 2 } }, {
    'react-router-dom': { Link: 'Link' }, '@tanstack/react-query': { useQueryClient: () => ({}) },
    '@/lib/api': { api: (...args: any[]) => { calls.push(args); return new Promise(() => {}); } },
  });
  const oldSave = view.button('Save to repeat without AI').props.onClick;
  view.render({ source: { sessionId: 'new', sourceUserSeq: 8 } }); oldSave();
  assert.equal(calls.length, 0); view.unmount();
});

const task = { id: 'controlled/task one', name: 'Controlled export', steps: 3, createdAt: '2026-10-30T12:00:00Z' };
test('computer task reads distinguish unavailable from empty and retain cached rows through refresh failure', () => {
  let retries = 0;
  const state = query(undefined, { isError: true, refetch: () => { retries++; } });
  const view = mount('../components/automations/ComputerTasks.tsx', 'ComputerTasks', {}, {
    '@tanstack/react-query': { useQuery: () => state, useQueryClient: () => ({}) },
  });
  assert.match(view.one('QueryUnavailable').props.title, /couldn’t load/);
  assert.equal(view.nodes().some(node => node.type === 'EmptyState'), false);
  view.one('QueryUnavailable').props.onRetry(); assert.equal(retries, 1);
  state.data = { tasks: [task] }; view.render();
  assert.match(view.text(), /last loaded list/); assert.match(view.text(), /Controlled export/);
  assert.ok(view.button('Repeat')); assert.ok(view.button('Remove Controlled export'));
  view.button('Retry').props.onClick(); assert.equal(retries, 2); view.unmount();
});

test('failed removal offers an exact retry and keeps actions locked until its refresh settles', async () => {
  const requests: any[] = [], attempts = [deferred(), deferred()], refresh = deferred();
  const view = mount('../components/automations/ComputerTasks.tsx', 'ComputerTasks', {}, {
    '@tanstack/react-query': { useQuery: () => query({ tasks: [task] }), useQueryClient: () => ({ invalidateQueries: () => refresh.promise }) },
    '@/lib/api': { api: (path: string, options: any) => { requests.push({ path, ...options }); return attempts[requests.length - 1].promise; } },
  });
  const remove = view.button('Remove Controlled export').props.onClick, repeat = view.button('Repeat').props.onClick;
  remove(); repeat(); assert.equal(requests.length, 1, 'remove and repeat cannot race before rerender');
  attempts[0].reject(new Error('Delete unavailable')); await flush(); view.render();
  assert.match(view.text(), /Couldn’t remove.*Controlled export.*Delete unavailable/);
  view.button('Retry removal').props.onClick();
  assert.deepEqual(requests.map(row => [row.path, row.method]), Array(2).fill(['/api/console/computer-tasks/controlled%2Ftask%20one', 'DELETE']));
  attempts[1].resolve({ ok: true }); await flush(); view.render();
  assert.equal(view.button('Repeat').props.disabled, true, 'refresh remains part of the captured removal');
  refresh.resolve(undefined); await flush(); view.render();
  assert.match(view.text(), /Removed “Controlled export”/); assert.equal(view.button('Repeat').props.disabled, false); view.unmount();
});

test('a failed repeat reports an unconfirmed outcome without automatically repeating the action', async () => {
  const pending = deferred(); const requests: any[] = [];
  const view = mount('../components/automations/ComputerTasks.tsx', 'ComputerTasks', {}, {
    '@tanstack/react-query': { useQuery: () => query({ tasks: [task] }), useQueryClient: () => ({}) },
    '@/lib/api': { api: (path: string, options: any) => { requests.push({ path, ...options }); return pending.promise; } },
  });
  const repeat = view.button('Repeat').props.onClick; repeat(); repeat();
  assert.deepEqual(requests, [{ path: '/api/console/computer-tasks/controlled%2Ftask%20one/repeat', method: 'POST' }]);
  pending.reject(new Error('Connection interrupted')); await flush(); view.render();
  assert.match(view.text(), /Couldn’t confirm the repeat of “Controlled export”/);
  assert.equal(requests.length, 1); assert.equal(view.nodes().some(node => words(node).trim() === 'Retry removal'), false); view.unmount();
});

test('Automations follows a direct computer link and preserves run selection and browser history across tabs', () => {
  const history = ['tab=computer&workflow=controlled&run=run-exact&guide=kept']; let at = 0;
  const view = mount('../screens/Automate.tsx', 'Automate', {}, {
    'react-router-dom': { Link: 'Link', useNavigate: () => () => {}, useSearchParams: () => [new URLSearchParams(history[at]), (next: URLSearchParams) => { history.splice(++at); history.push(next.toString()); }] },
    '@tanstack/react-query': { useQueryClient: () => ({}) },
    '@/lib/poll': { usePoll: () => query() }, '@/lib/workflow-changes': { useWorkflowChanges() {} },
    '@/lib/automation-editor': { searchWorkflows: (rows: any[]) => rows }, '@/lib/cn': { cn: (...values: string[]) => values.filter(Boolean).join(' ') },
    '@/components/automations/ComputerTasks': { ComputerTasks: 'ComputerTasks' },
  });
  assert.ok(view.one('ComputerTasks'));
  view.button('Skills').props.onClick(); view.render();
  assert.equal(new URLSearchParams(history[at]).get('tab'), 'skills');
  view.button('Workflows').props.onClick(); view.render();
  assert.equal(new URLSearchParams(history[at]).has('tab'), false);
  for (const search of history) {
    const params = new URLSearchParams(search);
    assert.equal(params.get('workflow'), 'controlled'); assert.equal(params.get('run'), 'run-exact'); assert.equal(params.get('guide'), 'kept');
  }
  at = 0; view.render(); assert.ok(view.one('ComputerTasks'), 'Back uses the URL rather than stale component state');
  at = 2; view.render(); assert.equal(view.nodes().some(node => node.type === 'ComputerTasks'), false, 'Forward restores Workflows');
  assert.equal(navigation.automationTab('unknown'), 'workflows'); view.unmount();
});

test('the agent computer signal belongs to its exact conversation and retired callbacks cannot close the new one', () => {
  const view = mount('../screens/AgentWorkspace.tsx', 'AgentWorkspaceForId', { id: 'controlled-agent', sessionId: 'desktop:one' }, {
    '@tanstack/react-query': { useQueryClient: () => ({}) }, 'react-router-dom': { useNavigate: () => () => {}, Link: 'Link' },
    '@/lib/poll': { usePoll: (key: string[]) => query(key[1] === 'one' ? { id: 'controlled-agent', name: 'Controlled agent' } : {}) },
    '@/features/conversations/lib/ids': { rawId: (id: string) => id.replace(/^desktop:/, '') },
    '@/components/chat/CloudBrowserDock': { CloudBrowserWorkspace: 'CloudBrowserWorkspace' },
    '@/components/chat/ComputerDock': { ComputerWorkspace: 'ComputerWorkspace' },
    '@/components/chat/FileDock': { FileDockWorkspace: 'FileDockWorkspace' },
  });
  const signal = () => view.nodes().find(node => node.props.onComputerActive)?.props.onComputerActive as (value: boolean) => void;
  const first = signal(); assert.equal(view.one('ComputerWorkspace').props.active, false);
  first(true); view.render(); assert.equal(view.one('ComputerWorkspace').props.active, true);
  assert.equal(signal(), first, 'unrelated rerenders keep signal identity stable');
  view.render({ id: 'controlled-agent', sessionId: 'desktop:two' });
  assert.equal(view.one('ComputerWorkspace').props.conversationId, 'two'); assert.equal(view.one('ComputerWorkspace').props.active, false);
  signal()(true); view.render(); assert.equal(view.one('ComputerWorkspace').props.active, true);
  first(false); view.render(); assert.equal(view.one('ComputerWorkspace').props.active, true, 'an old thread cleanup cannot retire the new thread');
  first(true); view.render(); assert.equal(view.one('ComputerWorkspace').props.active, true); view.unmount();
});

test('the existing computer panel honors manual close until the next task and closes when changing chats', () => {
  const props = { conversationId: 'controlled-chat-one', active: false, children: 'Conversation' };
  const view = mount('../components/chat/ComputerDock.tsx', 'ComputerWorkspace', props, {
    'react-router-dom': { Link: 'Link' },
    '@/lib/poll': { usePoll: () => query({ screenViewAvailable: true }) },
    '@/lib/computer-driver': { computerDriverIsConnected: () => true },
    '@/lib/computer-screen-cycle': { startComputerScreenCycle: () => ({ stop() {}, loaded() {}, failed() {} }) },
  });
  const control = () => view.one('Provider').props.value;
  assert.equal(control().open, false);
  view.render({ ...props, active: true }); assert.equal(control().open, true);
  control().close(); view.render(); assert.equal(control().open, false);
  view.render(); assert.equal(control().open, false, 'a rerender during the same task cannot reopen it');
  view.render(props); view.render({ ...props, active: true }); assert.equal(control().open, true, 'a later computer task may open it again');
  view.render({ ...props, conversationId: 'controlled-chat-two' }); assert.equal(control().open, false); view.unmount();
});
