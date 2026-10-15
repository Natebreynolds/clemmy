import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { cliConnectionHealth, cliConnectionPresentation } from '../../lib/cli-connection-view.js';
import { connectionSetupChatNavigation } from '../../lib/connection-setup-draft.js';

type Node = { type: any; props: Record<string, any> };
type Slot = { value?: any; deps?: unknown[]; cleanup?: () => void; effect?: () => void | (() => void) };
type Row = { queryKey: unknown[]; options: any; state: { data?: any; status: string; fetchStatus: string; errorUpdateCount: number } };
const job = (id = 'r24-owned-job', status = 'running') => ({ id, status, title: 'Controlled setup', output: '', kind: 'github', action: 'install', command: 'controlled' });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

// A disposable app-scope cache shared by separate actual component mounts.
// Only cache mechanics live here: job acceptance, selection, guards, polling
// and terminal interpretation always execute in the production component.
function createClient() {
  const rows = new Map<string, Row>();
  const defaults = new Map<string, any>();
  const listeners = new Set<(event: any) => void>();
  const emit = (type: string, row: Row) => listeners.forEach(listener => listener({ type, query: row }));
  const cache = (key: unknown[]) => {
    const id = JSON.stringify(key);
    if (!rows.has(id)) rows.set(id, { queryKey: key, options: {}, state: { status: 'pending', fetchStatus: 'idle', errorUpdateCount: 0 } });
    return rows.get(id)!;
  };
  const client = {
    rows, defaults, cache,
    getQueryData(key: unknown[]) { return rows.get(JSON.stringify(key))?.state.data; },
    setQueryData(key: unknown[], update: any) {
      const row = cache(key); row.state.data = typeof update === 'function' ? update(row.state.data) : update;
      row.state.status = 'success'; emit('updated', row); return row.state.data;
    },
    setQueryDefaults(key: unknown[], options: any) { defaults.set(JSON.stringify(key), options); },
    getQueryCache() { return { subscribe(listener: (event: any) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; } }; },
    removeQueries({ queryKey, exact }: { queryKey: unknown[]; exact?: boolean }) {
      for (const [id, row] of [...rows]) {
        if (queryKey.every((part, i) => Object.is(part, row.queryKey[i])) && (!exact || queryKey.length === row.queryKey.length)) {
          rows.delete(id); emit('removed', row);
        }
      }
    },
    clear() { for (const [id, row] of [...rows]) { rows.delete(id); emit('removed', row); } },
  };
  return client;
}
type Client = ReturnType<typeof createClient>;

// Executes actual components, their hooks/rendered callbacks, and their actual
// query functions/interval contracts. The host supplies synthetic query cache
// mechanics and transports only; it has no DOM, vendor process or application
// initialization. Historical RED uses a pinned unchanged source snapshot.
function mount(component = 'ManagedClis', controls: { start?: () => Promise<any>; read?: (id: string) => Promise<any>; props?: any; client?: Client; deferEffects?: boolean } = {}) {
  const slots: Slot[] = [], effects: Array<() => void> = [];
  const client = controls.client ?? createClient();
  const { rows, cache } = client;
  const observedKeys = new Map<string, string>();
  const calls = { managedPost: 0, installPost: 0, authPost: 0, customPost: 0, managedGet: [] as string[], installGet: [] as string[], invalidations: [] as string[], seeds: [] as string[], retiredSetters: 0 };
  let cursor = 0, dirty = false, mounted = true, tree: Node;
  const unobserveCache = client.getQueryCache().subscribe(event => {
    if (mounted && [...observedKeys.values()].includes(JSON.stringify(event.query.queryKey))) dirty = true;
  });
  let read = controls.read ?? (async () => { throw new Error('PRIVATE-STATUS-ERROR'); });
  const react = {
    useState(value: any) { const index = cursor++; if (!(index in slots)) slots[index] = { value: typeof value === 'function' ? value() : value };
      return [slots[index].value, (next: any) => { if (!mounted) calls.retiredSetters++; const value = typeof next === 'function' ? next(slots[index].value) : next;
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; } }]; },
    useRef(value: any) { const index = cursor++; if (!(index in slots)) slots[index] = { value: { current: value } }; return slots[index].value; },
    useEffect(effect: () => void | (() => void), deps: unknown[]) { const index = cursor++, before = slots[index];
      if (!before || deps.length !== before.deps?.length || deps.some((value, i) => !Object.is(value, before.deps?.[i]))) {
        slots[index] = { ...before, deps, effect }; effects.push(() => { before?.cleanup?.(); slots[index].cleanup = effect() ?? undefined; }); } },
  };
  const fetchRow = async (row: Row) => {
    const queryFn = row.options.queryFn; row.state.fetchStatus = 'fetching';
    try { const data = await queryFn(); row.state.data = data; row.state.status = 'success'; return { data }; }
    catch (error) { row.state.status = 'error'; row.state.errorUpdateCount++; return { error }; }
    finally { row.state.fetchStatus = 'idle'; }
  };
  const qc = { ...client, setQueryData(key: unknown[], data: any) { calls.seeds.push(JSON.stringify(key)); return client.setQueryData(key, data); },
    async invalidateQueries({ queryKey }: any) { calls.invalidations.push(JSON.stringify(queryKey)); } };
  const catalogEntry = { id: 'r24-fixture', command: 'r24-fixture', name: 'Fixture CLI', description: 'Controlled', installed: false, authHeadless: true };
  const connected = { 'r24-fixture': { ...catalogEntry, authHeadless: true } };
  const transport = {
    async startManagedCliJob() { calls.managedPost++; return controls.start?.() ?? { job: job() }; },
    async installCatalogCli() { calls.installPost++; return controls.start?.() ?? { job: job('r24-install') }; },
    async authCatalogCli() { calls.authPost++; return controls.start?.() ?? { job: job('r24-auth') }; },
    async runInstallCommand() { calls.customPost++; return controls.start?.() ?? { job: job('r24-custom') }; },
    async getManagedCliJob(id: string) { calls.managedGet.push(id); return read(id); },
    async getInstallJob(id: string) { calls.installGet.push(id); return read(id); },
  };
  const element = (type: any, props: any, key?: string): Node => ({ type, props: { ...props, key } });
  const dependencies: Record<string, any> = {
    react, 'react/jsx-runtime': { jsx: element, jsxs: element }, 'react-router-dom': { useNavigate: () => () => {} },
    '@tanstack/react-query': { useQueryClient: () => qc, useQuery(options: any) {
      const row = cache(options.queryKey); row.options = options;
      observedKeys.set(options.queryKey[0], JSON.stringify(options.queryKey));
      if (row.state.data === undefined && options.initialData !== undefined) { row.state.data = options.initialData; row.state.status = 'success'; }
      if (options.queryKey[0] === 'cli-catalog') { row.state.data = { results: [catalogEntry] }; row.state.status = 'success'; }
      options.refetchInterval?.({ state: row.state });
      return { data: row.state.data, isError: row.state.status === 'error', isFetching: row.state.fetchStatus === 'fetching', refetch: () => fetchRow(row) };
    } },
    '@/lib/poll': { usePoll(key: unknown[]) { return { data: key[0] === 'managed-clis' ? { github: { installed: false }, composio: { installed: false } }
      : key[0] === 'cli-catalog' ? { connected } : key[0] === 'clis' ? { clis: [] } : {}, isLoading: false }; } },
    '@/lib/connect': transport, '@/lib/platform': { isMac: () => true },
    '@/lib/connection-setup-draft': { connectionSetupChatNavigation },
    '@/lib/cli-connection-view': { cliConnectionHealth, cliConnectionPresentation },
    '@/components/ui/Card': { Card: 'section' }, '@/components/ui/Button': { Button: 'button' }, '@/components/ui/StatusPill': { StatusPill: 'status' },
    'lucide-react': new Proxy({}, { get: () => 'svg' }),
  };
  const source = process.env.CLEM_CLI_OBSERVATION_SOURCE
    ? readFileSync(new URL('../../../../../output/agentic-efficiency-round26/cli-tools-before-navigation.tsx', import.meta.url), 'utf8')
    : readFileSync(new URL('./CliTools.tsx', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: any = {};
  runInNewContext(`${code}\nexports.__components={ManagedClis,CatalogTools,CustomInstall};`, { exports, require(name: string) {
    assert.ok(name in dependencies, `Unexpected production dependency: ${name}`); return dependencies[name];
  }, setTimeout, clearTimeout });
  const props = controls.props ?? { connections: { connected, saved: [], health: {}, authRequired: {} }, unavailable: false };
  const render = (runEffects = true) => { for (let pass = 0; pass < 20; pass++) { dirty = false; cursor = 0; tree = exports.__components[component](props);
    if (!runEffects) return tree; effects.splice(0).forEach(effect => effect()); if (!dirty) return tree; } throw new Error('Component did not settle.'); };
  const nodes = () => { const found: Node[] = []; const visit = (child: any) => {
    if (Array.isArray(child)) child.forEach(visit);
    else if (child && typeof child === 'object' && child.props) { found.push(child);
      if (typeof child.type === 'function' && ['ManagedCard', 'JobStatusRecovery'].includes(child.type.name)) visit(child.type(child.props));
      else visit(child.props.children); }
  }; visit(tree); return found; };
  const text = (child: any): string => Array.isArray(child) ? child.map(text).join(' ')
    : child && typeof child === 'object' ? text(child.props?.children) : child == null || typeof child === 'boolean' ? '' : String(child);
  const words = () => nodes().filter(node => typeof node.type === 'string').map(node => text(node)).join(' ');
  const buttons = (label: string) => nodes().filter(node => node.type === 'button' && text(node).replace(/\s+/g, ' ').trim() === label);
  const button = (label: string) => { const found = buttons(label)[0]; assert.ok(found, `Missing actual button ${label}`); return found; };
  const currentRow = (prefix: string) => { const key = observedKeys.get(prefix); return key ? rows.get(key) : undefined; };
  render(!controls.deferEffects);
  return { calls, client, render, nodes, words, button, buttons,
    setRead(next: typeof read) { read = next; },
    async get(prefix = 'managed-cli-job') { const row = currentRow(prefix); assert.ok(row); const result = await fetchRow(row); if (mounted) render(); return result; },
    queryOptions(prefix = 'managed-cli-job') { return currentRow(prefix)?.options; },
    interval(prefix = 'managed-cli-job') { const row = currentRow(prefix); assert.ok(row); return row.options.refetchInterval({ state: row.state }); },
    replaceCached(prefix: string, value: any) { qc.setQueryData([prefix, value.id], { job: value }); render(); },
    changeSearch(value: string) { const input = nodes().find(node => node.props['aria-label'] === 'Search CLIs'); assert.ok(input); input.props.onChange({ target: { value } }); render(); },
    replayEffects() { slots.forEach(slot => slot.cleanup?.()); slots.forEach(slot => { if (slot.effect) slot.cleanup = slot.effect() ?? undefined; }); },
    unmount() { mounted = false; unobserveCache(); slots.forEach(slot => slot.cleanup?.()); },
  };
}

test('acknowledged job stays visible; first missing status has bounded recovery, safe copy and exact GET-only retry', async () => {
  const view = mount(); const install = view.button('Install').props.onClick;
  install(); install(); await tick(); view.render();
  assert.equal(view.calls.managedPost, 1); assert.ok(view.words().includes('Controlled setup'));
  assert.equal(view.interval(), 1500);
  for (const expected of [5000, 5000, false]) { await view.get(); assert.equal(view.interval(), expected); }
  assert.ok(view.words().includes('Status unavailable; work may still be running'));
  assert.equal(view.words().includes('PRIVATE-STATUS-ERROR'), false);
  assert.ok(view.buttons('Install').every(button => button.props.disabled));
  view.setRead(async id => ({ job: job(id, 'succeeded') }));
  const retry = view.button('Retry status').props.onClick; retry(); retry(); await tick(); view.render();
  assert.equal(view.calls.managedGet.length, 4); assert.ok(view.calls.managedGet.every(id => id === 'r24-owned-job'));
  assert.equal(view.calls.managedPost, 1); assert.equal(view.interval(), false);
  assert.equal(view.words().includes('Status unavailable'), false); assert.ok(view.buttons('Install').every(button => !button.props.disabled));
});

test('later transient loss retains the last running job and successful observation resets its error budget', async () => {
  const view = mount(); view.button('Install').props.onClick(); await tick(); view.render();
  view.setRead(async id => ({ job: { ...job(id), title: 'Last verified running job' } })); await view.get();
  view.setRead(async () => { throw new Error('PRIVATE'); }); await view.get(); assert.equal(view.interval(), 5000);
  assert.ok(view.words().includes('Last verified running job'));
  view.setRead(async id => ({ job: job(id) })); await view.get(); assert.equal(view.interval(), 1500);
  view.setRead(async () => { throw new Error('PRIVATE'); }); await view.get(); assert.equal(view.interval(), 5000);
});

test('wrong job identity and malformed status/title/output cannot settle the current busy action', async () => {
  const view = mount(); view.button('Install').props.onClick(); await tick(); view.render();
  for (const response of [{ job: job('foreign', 'succeeded') }, { job: { ...job(), status: 'other' } },
    { job: { ...job(), title: null } }, { job: { ...job(), output: 3 } }, {}]) {
    view.setRead(async () => response); await view.get();
    assert.ok(view.words().includes('Status unavailable')); assert.ok(view.buttons('Install').every(button => button.props.disabled));
  }
  assert.equal(view.calls.managedPost, 1);
});

test('a verified terminal failure stops polling without inventing success or restarting the job', async () => {
  const view = mount(); view.button('Install').props.onClick(); await tick(); view.render();
  view.setRead(async id => ({ job: job(id, 'failed') })); await view.get();
  assert.equal(view.interval(), false); assert.ok(view.words().includes('failed')); assert.equal(view.calls.managedPost, 1);
  assert.ok(view.buttons('Install').every(button => !button.props.disabled));
});

test('a retired job response cannot finish a newer setup owner', async () => {
  let count = 0; const old = deferred<any>();
  const view = mount('ManagedClis', { start: async () => ({ job: job(`owned-${++count}`) }) });
  view.button('Install').props.onClick(); await tick(); view.render();
  view.setRead(() => old.promise); const reading = view.get();
  view.replaceCached('managed-cli-job', job('owned-1', 'succeeded'));
  view.button('Install').props.onClick(); await tick(); view.render();
  old.resolve({ job: job('owned-1', 'failed') }); await reading; view.render();
  assert.ok(view.buttons('Install').every(button => button.props.disabled)); assert.equal(view.calls.managedPost, 2);
});

test('a retired manual retry cannot lock status recovery for a newly acknowledged job', async () => {
  let count = 0; const old = deferred<any>();
  const view = mount('ManagedClis', { start: async () => ({ job: job(`retry-owner-${++count}`) }) });
  view.button('Install').props.onClick(); await tick(); view.render(); await view.get();
  view.setRead(() => old.promise); view.button('Retry status').props.onClick();
  view.replaceCached('managed-cli-job', job('retry-owner-1', 'succeeded'));
  view.button('Install').props.onClick(); await tick(); view.render();
  view.setRead(async () => { throw new Error('CONTROLLED-NEW-READ-FAILURE'); }); await view.get();
  view.setRead(async id => ({ job: job(id, 'succeeded') })); view.button('Retry status').props.onClick(); await tick(); view.render();
  assert.equal(view.calls.managedGet.filter(id => id === 'retry-owner-2').length, 2);
  assert.equal(view.interval(), false);
  old.resolve({ job: job('retry-owner-1', 'failed') }); await tick(); view.render();
  assert.ok(view.buttons('Install').every(button => !button.props.disabled)); assert.equal(view.calls.managedPost, 2);
});

test('unmount retires late POST acceptance and stale retry callbacks without cancelling or replaying work', async () => {
  const pending = deferred<any>(); const view = mount('ManagedClis', { start: () => pending.promise });
  view.button('Install').props.onClick(); view.unmount(); pending.resolve({ job: job() }); await tick();
  assert.equal(view.calls.seeds.length, 0); assert.equal(view.calls.retiredSetters, 0);
  const active = mount(); active.button('Install').props.onClick(); await tick(); active.render(); await active.get();
  const retry = active.button('Retry status').props.onClick; active.unmount(); retry(); await tick();
  assert.equal(active.calls.managedGet.length, 1); assert.equal(active.calls.retiredSetters, 0);
});

test('catalog install and sign-in each recover their exact GET without repeating the effect POST', async () => {
  for (const lane of ['install', 'auth']) {
    const view = mount('CatalogTools');
    if (lane === 'install') { view.changeSearch('r24'); view.button('Install').props.onClick(); }
    else view.button('Manage sign-in').props.onClick();
    await tick(); view.render();
    const prefix = lane === 'install' ? 'install-job' : 'catalog-auth-job';
    await view.get(prefix); assert.ok(view.words().includes('Status unavailable'));
    view.setRead(async id => ({ job: job(id, 'succeeded') })); view.button('Retry status').props.onClick(); await tick(); view.render();
    assert.equal(view.calls.installPost + view.calls.authPost, 1); assert.equal(view.interval(prefix), false);
    assert.deepEqual(lane === 'install' ? view.calls.installGet : view.calls.managedGet, [lane === 'install' ? 'r24-install' : 'r24-auth', lane === 'install' ? 'r24-install' : 'r24-auth']);
  }
});

test('custom install retains its complete acknowledged job and status retry never repeats its command', async () => {
  const view = mount('CatalogTools');
  const custom = view.nodes().find(node => typeof node.type === 'function' && node.type.name === 'CustomInstall'); assert.ok(custom);
  await Promise.all([custom.props.onInstall('controlled install', 'controlled'), custom.props.onInstall('controlled install', 'controlled')]);
  view.render(); assert.equal(view.calls.customPost, 1); assert.ok(view.words().includes('Controlled setup'));
  await view.get('install-job'); view.setRead(async id => ({ job: job(id, 'succeeded') }));
  view.button('Retry status').props.onClick(); await tick(); view.render();
  assert.deepEqual(view.calls.installGet, ['r24-custom', 'r24-custom']); assert.equal(view.calls.customPost, 1);
});

test('closing before custom submission runs nothing; in-flight submission cannot be closed or update an unmounted form', async () => {
  const pending = deferred<boolean>(); let submissions = 0;
  const view = mount('CustomInstall', { props: { busy: false, onInstall: () => { submissions++; return pending.promise; } } });
  const open = () => { view.button('Have an install command? Paste it to review and run it here.').props.onClick(); view.render(); };
  open();
  const close = () => { const button = view.nodes().find(node => node.props['aria-label'] === 'Close'); assert.ok(button); return button; };
  close().props.onClick(); view.render(); assert.equal(submissions, 0); open();
  const input = view.nodes().find(node => node.props['aria-label'] === 'Install command'); assert.ok(input);
  input.props.onChange({ target: { value: 'controlled install' } }); view.render();
  const oldClose = close().props.onClick, submit = view.button('Install').props.onClick;
  submit(); submit(); oldClose(); view.render();
  assert.equal(submissions, 1); assert.equal(close().props.disabled, true);
  view.unmount(); pending.resolve(true); await tick(); assert.equal(view.calls.retiredSetters, 0);
});

test('acknowledged managed setup survives navigation and job-data GC, with first-render busy and exact fresh observation', async () => {
  const client = createClient();
  const first = mount('ManagedClis', { client, start: async () => ({ job: { ...job('r26-managed'), output: 'PRIVATE-JOB-OUTPUT' } }) });
  first.button('Install').props.onClick(); await tick(); first.render();
  const pointer = client.getQueryData(['cli-setup-owner', 'managed']);
  assert.deepEqual(Object.keys(pointer).sort(), ['action', 'generation', 'id', 'prefix']);
  assert.equal(pointer.id, 'r26-managed'); assert.equal(pointer.prefix, 'managed-cli-job'); assert.equal(pointer.action, 'github:install');
  assert.equal(JSON.stringify(pointer).includes('PRIVATE-JOB-OUTPUT'), false); assert.equal(JSON.stringify(pointer).includes('controlled'), false);
  first.unmount(); client.removeQueries({ queryKey: ['managed-cli-job'] });
  const returned = mount('ManagedClis', { client, deferEffects: true });
  assert.ok(returned.buttons('Install').every(button => button.props.disabled), 'the first render must restore busy before effects');
  returned.button('Install').props.onClick(); await tick();
  assert.equal(returned.calls.managedPost, 0, 'the synchronous callback guard must already know the retained owner');
  returned.render();
  assert.equal(returned.queryOptions().queryKey[1], 'r26-managed'); assert.equal(returned.queryOptions().enabled, true);
  assert.notEqual(returned.queryOptions().gcTime, Infinity, 'full job payload must keep ordinary query GC');
  await returned.get(); assert.ok(returned.words().includes('Status unavailable')); assert.ok(returned.buttons('Install').every(button => button.props.disabled));
  returned.setRead(async id => ({ job: job(id, 'interrupted') })); await returned.get();
  assert.deepEqual(returned.calls.managedGet, ['r26-managed', 'r26-managed']); assert.equal(first.calls.managedPost + returned.calls.managedPost, 1);
  assert.ok(returned.words().includes('interrupted')); assert.ok(returned.buttons('Install').every(button => !button.props.disabled));
  assert.equal(client.getQueryData(['cli-setup-owner', 'managed']), null);
});

test('a cached terminal from a retired mount cannot release a remounted owner before fresh exact GET', async () => {
  const client = createClient(); const first = mount('ManagedClis', { client });
  first.button('Install').props.onClick(); await tick(); first.render(); first.unmount();
  client.setQueryData(['managed-cli-job', 'r24-owned-job'], { job: job('r24-owned-job', 'succeeded') });
  const returned = mount('ManagedClis', { client });
  assert.ok(returned.buttons('Install').every(button => button.props.disabled));
  assert.equal(returned.words().includes('succeeded'), false, 'unverified cached terminal must not be presented as current observation');
  assert.equal(returned.interval(), 1500, 'stale cached terminal must not suppress status recovery');
  for (const response of [{ job: job('foreign', 'succeeded') }, { job: { ...job(), status: 'unknown' } }, { job: { ...job(), output: null } }]) {
    returned.setRead(async () => response); await returned.get();
    assert.ok(returned.buttons('Install').every(button => button.props.disabled)); assert.ok(returned.words().includes('Status unavailable'));
    assert.equal(client.getQueryData(['cli-setup-owner', 'managed'])?.id, 'r24-owned-job');
  }
  returned.setRead(async id => ({ job: job(id, 'succeeded') })); await returned.get();
  assert.ok(returned.buttons('Install').every(button => !button.props.disabled)); assert.equal(returned.calls.managedPost, 0);
});

test('catalog install, catalog sign-in and custom install restore the acknowledged lane without another POST', async () => {
  for (const lane of ['install', 'auth', 'custom']) {
    const client = createClient(); const first = mount('CatalogTools', { client });
    if (lane === 'install') { first.changeSearch('r24'); first.button('Install').props.onClick(); }
    else if (lane === 'auth') first.button('Manage sign-in').props.onClick();
    else {
      const custom = first.nodes().find(node => typeof node.type === 'function' && node.type.name === 'CustomInstall'); assert.ok(custom);
      await custom.props.onInstall('PRIVATE-CUSTOM-COMMAND', 'controlled');
    }
    await tick(); first.render();
    const prefix = lane === 'auth' ? 'catalog-auth-job' : 'install-job';
    const expectedId = `r24-${lane === 'custom' ? 'custom' : lane}`;
    const pointer = client.getQueryData(['cli-setup-owner', 'catalog']);
    assert.equal(pointer.id, expectedId); assert.equal(pointer.prefix, prefix); assert.equal(JSON.stringify(pointer).includes('PRIVATE-CUSTOM-COMMAND'), false);
    first.unmount(); client.removeQueries({ queryKey: [prefix] });
    const returned = mount('CatalogTools', { client, deferEffects: true });
    assert.equal(returned.button('Manage sign-in').props.disabled, true);
    returned.button('Manage sign-in').props.onClick();
    const custom = returned.nodes().find(node => typeof node.type === 'function' && node.type.name === 'CustomInstall'); assert.ok(custom); assert.equal(custom.props.busy, true);
    await custom.props.onInstall('PRIVATE-UNREQUESTED-REPLAY', 'controlled'); await tick(); returned.render();
    assert.equal(returned.calls.installPost + returned.calls.authPost + returned.calls.customPost, 0);
    assert.equal(returned.queryOptions(prefix).queryKey[1], expectedId); assert.equal(returned.queryOptions(prefix).enabled, true);
    await returned.get(prefix); assert.ok(returned.words().includes('Status unavailable')); assert.equal(returned.button('Manage sign-in').props.disabled, true);
    returned.setRead(async id => ({ job: job(id, 'succeeded') })); await returned.get(prefix);
    assert.deepEqual(lane === 'auth' ? returned.calls.managedGet : returned.calls.installGet, [expectedId, expectedId]);
    assert.equal(first.calls.installPost + first.calls.authPost + first.calls.customPost, 1);
    assert.equal(client.getQueryData(['cli-setup-owner', 'catalog']), null); assert.equal(returned.button('Manage sign-in').props.disabled, false);
  }
});

test('clearing the app cache retires a pending exact GET and cannot release a newer owner', async () => {
  const client = createClient(); const pending = deferred<any>(); let count = 0;
  const view = mount('ManagedClis', { client, start: async () => ({ job: job(`r26-clear-${++count}`) }) });
  view.button('Install').props.onClick(); await tick(); view.render();
  view.setRead(() => pending.promise); const oldRead = view.get();
  const staleStart = view.button('Install').props.onClick;
  client.clear(); staleStart(); await tick();
  assert.equal(view.calls.managedPost, 1, 'pre-clear rendered callbacks must be revoked synchronously');
  view.render(); assert.ok(view.buttons('Install').every(button => !button.props.disabled)); assert.equal(view.words().includes('Controlled setup'), false);
  view.button('Install').props.onClick(); await tick(); view.render();
  assert.equal(client.getQueryData(['cli-setup-owner', 'managed'])?.id, 'r26-clear-2');
  pending.resolve({ job: job('r26-clear-1', 'succeeded') }); await oldRead; view.render();
  assert.equal(client.getQueryData(['cli-setup-owner', 'managed'])?.id, 'r26-clear-2'); assert.ok(view.buttons('Install').every(button => button.props.disabled));
  view.setRead(async id => ({ job: job(id, 'succeeded') })); await view.get(); assert.equal(client.getQueryData(['cli-setup-owner', 'managed']), null);
  assert.equal(view.calls.managedPost, 2);
});

test('clearing the app cache before POST acknowledgement fences late acceptance without recreating a pointer', async () => {
  const client = createClient(); const pending = deferred<any>();
  const view = mount('ManagedClis', { client, start: () => pending.promise });
  const original = view.button('Install').props.onClick; original();
  client.clear(); original(); await tick(); assert.equal(view.calls.managedPost, 1);
  pending.resolve({ job: job('r26-cleared-before-ack') }); await tick();
  assert.equal(client.getQueryData(['cli-setup-owner', 'managed']), undefined);
  assert.equal(client.getQueryData(['managed-cli-job', 'r26-cleared-before-ack']), undefined);
  view.render(); assert.ok(view.buttons('Install').every(button => !button.props.disabled));
  assert.equal(view.words().includes('Controlled setup'), false);
});

test('cache clear retires manual GET retry and its stale button without re-POST or pointer resurrection', async () => {
  const client = createClient(); const pending = deferred<any>(); const view = mount('ManagedClis', { client });
  view.button('Install').props.onClick(); await tick(); view.render(); await view.get();
  view.setRead(() => pending.promise); const retry = view.button('Retry status').props.onClick; retry();
  assert.equal(view.calls.managedGet.length, 2); client.clear(); retry(); await tick();
  assert.equal(view.calls.managedGet.length, 2); pending.resolve({ job: job('r24-owned-job', 'succeeded') }); await tick();
  assert.equal(client.getQueryData(['cli-setup-owner', 'managed']), undefined);
  view.render(); assert.ok(view.buttons('Install').every(button => !button.props.disabled)); assert.equal(view.calls.managedPost, 1);
});

test('a late response owned by an unmounted screen cannot clear the replacement screen job', async () => {
  const client = createClient(); const pending = deferred<any>();
  const first = mount('ManagedClis', { client, start: async () => ({ job: job('r26-old-mount') }) });
  first.button('Install').props.onClick(); await tick(); first.render(); first.setRead(() => pending.promise); const oldRead = first.get(); first.unmount();
  const returned = mount('ManagedClis', { client, start: async () => ({ job: job('r26-new-owner') }), read: async id => ({ job: job(id, 'succeeded') }) });
  await returned.get(); returned.button('Install').props.onClick(); await tick(); returned.render();
  pending.resolve({ job: job('r26-old-mount', 'failed') }); await oldRead; returned.render();
  assert.equal(client.getQueryData(['cli-setup-owner', 'managed'])?.id, 'r26-new-owner'); assert.ok(returned.buttons('Install').every(button => button.props.disabled));
  assert.equal(first.calls.retiredSetters, 0); assert.equal(first.calls.managedPost + returned.calls.managedPost, 2);
});

test('acknowledged ownership belongs to its QueryClient and does not disable a different app cache', async () => {
  const a = createClient(), b = createClient(); const first = mount('ManagedClis', { client: a });
  first.button('Install').props.onClick(); await tick(); first.render(); first.unmount();
  const same = mount('ManagedClis', { client: a }); const separate = mount('ManagedClis', { client: b });
  assert.ok(same.buttons('Install').every(button => button.props.disabled)); assert.ok(separate.buttons('Install').every(button => !button.props.disabled));
  separate.button('Install').props.onClick(); await tick(); separate.render(); assert.equal(separate.calls.managedPost, 1);
  b.clear(); same.render(); assert.equal(a.getQueryData(['cli-setup-owner', 'managed'])?.id, 'r24-owned-job');
  assert.ok(same.buttons('Install').every(button => button.props.disabled));
});


test('StrictMode-style effect cleanup and setup retain the remounted exact observation owner', async () => {
  const client = createClient(); const first = mount('ManagedClis', { client });
  first.button('Install').props.onClick(); await tick(); first.render(); first.unmount();
  const returned = mount('ManagedClis', { client }); returned.replayEffects(); returned.render();
  assert.ok(returned.buttons('Install').every(button => button.props.disabled)); assert.equal(returned.interval(), 1500);
  returned.setRead(async id => ({ job: job(id, 'succeeded') })); await returned.get();
  assert.deepEqual(returned.calls.managedGet, ['r24-owned-job']); assert.equal(returned.calls.managedPost, 0);
  assert.ok(returned.buttons('Install').every(button => !button.props.disabled));
});
