import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createSignInAttemptOwner, deviceSignInDeadline, deviceSignInPollDelay } from './sign-in-attempt.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function clock() {
  let now = Date.parse('2026-10-18T18:00:00Z'), serial = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const schedule = ((callback: () => void, delay: number) => { const id = ++serial; timers.set(id, { at: now + delay, callback }); return id; }) as unknown as typeof setTimeout;
  const cancel = ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout;
  return { schedule, cancel, timers, now: () => now,
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].callback(); await tick();
      }
      now = target; await tick();
    },
  };
}

test('attempt replacement aborts and fences old callbacks, and cleanup owns every timer', async () => {
  const time = clock(); const owner = createSignInAttemptOwner(time); const calls: string[] = [];
  const first = owner.begin(); first.later(() => calls.push('first'), 30);
  const second = owner.begin(); assert.equal(first.signal.aborted, true); assert.equal(first.isCurrent(), false);
  first.later(() => calls.push('late-first'), 5); second.later(() => calls.push('second'), 20);
  await time.advance(20); assert.deepEqual(calls, ['second']);
  second.later(() => calls.push('after-close'), 20); owner.stop(); owner.stop();
  assert.equal(second.signal.aborted, true); assert.equal(time.timers.size, 0);
  await time.advance(100); assert.deepEqual(calls, ['second']);
});

test('poll timing is finite, preserves valid provider backoff and has a bounded observation deadline', () => {
  for (const seconds of [NaN, Infinity, -1, 0]) assert.equal(deviceSignInPollDelay(seconds), 5000);
  assert.equal(deviceSignInPollDelay(1), 3000); assert.equal(deviceSignInPollDelay(120), 120000);
  assert.equal(deviceSignInDeadline('not-a-date', 900000, 1000), null);
  assert.equal(deviceSignInDeadline(undefined, 900000, 1000), 901000);
  assert.equal(deviceSignInDeadline('2099-01-01T00:00:00Z', 900000, 1000), 901000);
});

type Node = { type: unknown; props: Record<string, any> };
type Slot = { value?: any; cleanup?: () => void; deps?: unknown[]; effect?: () => (() => void) };
/** Actual production component callbacks and effects run here. Only transport,
 * React scheduling and time are controlled; no app/provider is initialized. */
function mount(kind: 'codex' | 'xai', options: {
  begin?: (signal?: AbortSignal) => Promise<any>;
  poll?: (id: string, signal?: AbortSignal) => Promise<any>;
  local?: (signal?: AbortSignal) => Promise<any>;
} = {}) {
  const time = clock(), slots: Slot[] = [], effects: Array<() => void> = [];
  let cursor = 0, mounted = true, tree: Node, done = 0, retiredSetters = 0;
  const begins: AbortSignal[] = [], polls: Array<{ id: string; signal: AbortSignal }> = [];
  const react = {
    useState(value: any) { const i = cursor++; if (!(i in slots)) slots[i] = { value: typeof value === 'function' ? value() : value };
      return [slots[i].value, (next: any) => { if (!mounted) retiredSetters++; slots[i].value = typeof next === 'function' ? next(slots[i].value) : next; }]; },
    useRef(value: any) { const i = cursor++; if (!(i in slots)) slots[i] = { value: { current: value } }; return slots[i].value; },
    useEffect(effect: () => (() => void), deps: unknown[]) { const i = cursor++; const previous = slots[i];
      if (!previous || deps.some((value, n) => !Object.is(value, previous.deps?.[n]))) {
        slots[i] = { deps, effect }; effects.push(() => { previous?.cleanup?.(); slots[i].cleanup = effect(); }); } },
  };
  const begin = async (signal: AbortSignal) => { begins.push(signal); return options.begin?.(signal) ?? {
    loginId: 'controlled-grant', verificationUri: 'https://example.test/sign-in', userCode: 'CONTROLLED', intervalSeconds: 5,
    expiresAt: new Date(time.now() + 60000).toISOString(),
  }; };
  const poll = async (id: string, signal: AbortSignal) => { polls.push({ id, signal }); return options.poll?.(id, signal) ?? { status: 'pending' }; };
  const exports: Record<string, any> = {};
  const source = readFileSync(new URL(`../screens/settings/${kind === 'codex' ? 'Codex' : 'Xai'}LoginForm.tsx`, import.meta.url), 'utf8');
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, Date: { now: time.now, parse: Date.parse }, setTimeout: time.schedule, clearTimeout: time.cancel,
    require(id: string) {
      if (id === 'react') return react;
      if (id === 'react/jsx-runtime') return { jsx: (type: unknown, props: any) => ({ type, props }), jsxs: (type: unknown, props: any) => ({ type, props }) };
      if (id === '@tanstack/react-query') return { useQueryClient: () => ({}) };
      if (id === 'lucide-react') return new Proxy({}, { get: (_, key) => String(key) });
      if (id === '@/components/ui/Button') return { Button: 'controlled-button' };
      if (id === '@/lib/poll') return { usePoll: () => ({}) };
      if (id === '@/lib/clemmy') return { clemmy: () => ({}) };
      if (id === '@/lib/connect') return { codexDeviceBegin: begin, codexDevicePoll: poll, xaiDeviceBegin: begin, xaiDevicePoll: poll,
        codexReauthLocal: options.local ?? (async () => ({ ok: true })) };
      if (id === '@/lib/settings') return {};
      if (id === '@/lib/sign-in-attempt') return { createSignInAttemptOwner: () => createSignInAttemptOwner(time), deviceSignInPollDelay,
        deviceSignInDeadline: (expiry: string | undefined, ttl: number) => deviceSignInDeadline(expiry, ttl, time.now()) };
      throw new Error(`Unexpected component import: ${id}`);
    },
  });
  const component = kind === 'codex' ? exports.CodexReauth : exports.XaiSignIn;
  const render = () => { cursor = 0; tree = component({ signedIn: false, connected: false, onDone: () => { done++; } }); while (effects.length) effects.shift()!(); };
  const nodes = (value: any): Node[] => Array.isArray(value) ? value.flatMap(node => nodes(node))
    : value && typeof value === 'object' && 'props' in value ? [value, ...nodes(value.props.children)] : [];
  const words = (value: any): string => Array.isArray(value) ? value.map(words).join(' ')
    : value && typeof value === 'object' && 'props' in value ? words(value.props.children) : typeof value === 'string' ? value : '';
  const remote = () => nodes(tree).find(node => node.type === 'controlled-button' && words(node).includes(kind === 'codex' ? 'Sign in on another device' : 'Connect xAI'))!;
  render();
  return { time, begins, polls, render, nodes: () => nodes(tree), words: (value: any = tree) => words(value), remote,
    done: () => done, retiredSetters: () => retiredSetters,
    replayEffects() { for (const slot of slots) if (slot.effect) { slot.cleanup?.(); slot.cleanup = slot.effect(); } },
    unmount() { mounted = false; for (const slot of slots) slot.cleanup?.(); },
  };
}

for (const kind of ['codex', 'xai'] as const) {
  test(`${kind}: leaving during begin aborts its request and a late reply cannot revive polling`, async () => {
    const pending = deferred<any>(); const view = mount(kind, { begin: () => pending.promise });
    const start = view.remote().props.onClick(); view.unmount();
    assert.equal(view.begins[0].aborted, true);
    pending.resolve({ loginId: 'retired', verificationUri: 'https://example.test', userCode: 'CONTROLLED' }); await start;
    await view.time.advance(900000); assert.equal(view.polls.length, 0); assert.equal(view.time.timers.size, 0);
    assert.equal(view.done(), 0); assert.equal(view.retiredSetters(), 0);
  });
  test(`${kind}: a hung begin or poll has a bounded deadline and late success stays retired`, async () => {
    const start = deferred<any>(); const beginning = mount(kind, { begin: () => start.promise });
    const request = beginning.remote().props.onClick(); await beginning.time.advance(30000); beginning.render();
    assert.equal(beginning.begins[0].aborted, true); assert.match(beginning.words(), /request timed out/); assert.equal(beginning.remote().props.disabled, false);
    start.resolve({ loginId: 'retired', verificationUri: 'https://example.test', userCode: 'CONTROLLED' }); await request;
    assert.equal(beginning.time.timers.size, 0); assert.equal(beginning.polls.length, 0); beginning.unmount();
    const result = deferred<any>(); const polling = mount(kind, { poll: () => result.promise });
    await polling.remote().props.onClick(); await polling.time.advance(60000); polling.render();
    assert.equal(polling.polls.length, 1); assert.equal(polling.polls[0].signal.aborted, true); assert.match(polling.words(), /Code expired/);
    assert.equal(polling.remote().props.disabled, false); result.resolve({ status: 'complete' }); await tick();
    assert.equal(polling.done(), 0); assert.equal(polling.time.timers.size, 0); polling.unmount();
  });
  test(`${kind}: StrictMode-style cleanup retires old work and the remounted effect can start again`, async () => {
    const view = mount(kind); await view.remote().props.onClick(); view.replayEffects();
    assert.equal(view.begins[0].aborted, true); assert.equal(view.time.timers.size, 0);
    await view.remote().props.onClick(); await view.time.advance(5000);
    assert.equal(view.begins.length, 2); assert.equal(view.polls.length, 1); assert.equal(view.begins[1].aborted, false); view.unmount();
  });
  test(`${kind}: leaving during poll fences an already completed grant response`, async () => {
    const pending = deferred<any>(); const view = mount(kind, { poll: () => pending.promise });
    await view.remote().props.onClick(); await view.time.advance(5000);
    assert.equal(view.polls.length, 1); view.unmount(); assert.equal(view.polls[0].signal.aborted, true);
    pending.resolve({ status: 'complete' }); await tick(); await view.time.advance(100000);
    assert.equal(view.done(), 0); assert.equal(view.polls.length, 1); assert.equal(view.time.timers.size, 0); assert.equal(view.retiredSetters(), 0);
  });
  test(`${kind}: a replaced begin cannot show its code or compete with the current grant`, async () => {
    const old = deferred<any>(); let count = 0; const view = mount(kind, { begin: async () => ++count === 1 ? old.promise : {
      loginId: 'current', verificationUri: 'https://example.test/current', userCode: 'CURRENT', intervalSeconds: 5,
    } });
    const click = view.remote().props.onClick; const first = click(); await click();
    old.resolve({ loginId: 'old', verificationUri: 'https://example.test/old', userCode: 'OLD' }); await first;
    await view.time.advance(5000); view.render(); assert.equal(view.begins[0].aborted, true);
    assert.deepEqual(view.polls.map(row => row.id), ['current']); assert.equal(view.words().includes('OLD'), false);
    view.unmount();
  });
  test(`${kind}: malformed expiry never schedules a request and failed polls release the button`, async () => {
    const malformed = mount(kind, { begin: async () => ({ loginId: 'controlled', verificationUri: 'https://example.test', userCode: 'CONTROLLED', expiresAt: 'invalid' }) });
    await malformed.remote().props.onClick(); malformed.render(); assert.match(malformed.words(), /confirm the sign-in code/);
    assert.equal(malformed.remote().props.disabled, false); assert.equal(malformed.time.timers.size, 0); malformed.unmount();
    const failed = mount(kind, { poll: async () => ({ status: 'error', message: 'Controlled sign-in refusal. Try again.' }) });
    await failed.remote().props.onClick(); await failed.time.advance(5000); failed.render();
    assert.match(failed.words(), /Controlled sign-in refusal/); assert.equal(failed.remote().props.disabled, false);
    await failed.time.advance(60000); assert.equal(failed.polls.length, 1); failed.unmount();
  });
  test(`${kind}: network retry expires without another poll and success cleanup cannot outlive the screen`, async () => {
    const failed = mount(kind, { poll: async () => { throw new Error('controlled network failure'); } });
    await failed.remote().props.onClick(); await failed.time.advance(60000); failed.render();
    assert.equal(failed.polls.length, 11); assert.match(failed.words(), /Code expired/); assert.equal(failed.time.timers.size, 0); failed.unmount();
    const success = mount(kind, { poll: async () => ({ status: 'complete' }) });
    await success.remote().props.onClick(); await success.time.advance(5000); assert.equal(success.done(), 1);
    success.unmount(); await success.time.advance(2500); assert.equal(success.time.timers.size, 0); assert.equal(success.retiredSetters(), 0);
  });
}

test('xAI backoff never accelerates polling or turns a malformed delay into a hot loop', async () => {
  let count = 0; const view = mount('xai', { poll: async () => ({ status: 'slow_down', intervalSeconds: ++count === 1 ? 20 : -1 }) });
  await view.remote().props.onClick(); await view.time.advance(5000); assert.equal(view.polls.length, 1);
  await view.time.advance(19999); assert.equal(view.polls.length, 1);
  await view.time.advance(1); assert.equal(view.polls.length, 2);
  await view.time.advance(19999); assert.equal(view.polls.length, 2);
  await view.time.advance(1); assert.equal(view.polls.length, 3); view.unmount();
});

test('Codex local completion cannot update or refresh an unmounted screen', async () => {
  const pending = deferred<any>(); const view = mount('codex', { local: () => pending.promise });
  const local = view.nodes().find(node => node.type === 'controlled-button' && view.words(node).trim() === 'Sign in')!;
  const run = local.props.onClick(); view.unmount(); pending.resolve({ ok: true }); await run;
  assert.equal(view.done(), 0); assert.equal(view.time.timers.size, 0); assert.equal(view.retiredSetters(), 0);
});

test('auth transport wrappers forward cancellation without changing endpoint or POST payload', async () => {
  const calls: Array<{ path: string; init: RequestInit }> = []; const exports: Record<string, any> = {};
  const source = readFileSync(new URL('./connect.ts', import.meta.url), 'utf8');
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, require(id: string) {
      if (id === './api') return { api: async (path: string, init: RequestInit) => { calls.push({ path, init }); return {}; } };
      if (id === './bootstrap') return { getAuthToken: () => '' };
      throw new Error(`Unexpected transport import: ${id}`);
    },
  });
  const signal = new AbortController().signal;
  await exports.codexReauthLocal(signal); await exports.codexDeviceBegin(signal); await exports.codexDevicePoll('controlled-grant', signal);
  await exports.xaiDeviceBegin(signal); await exports.xaiDevicePoll('controlled-grant', signal);
  assert.deepEqual(calls.map(row => row.path), ['/api/console/auth/codex-login', '/api/console/auth/codex-device/begin', '/api/console/auth/codex-device/poll', '/api/console/auth/xai-device/begin', '/api/console/auth/xai-device/poll']);
  for (const row of calls) { assert.equal(row.init.method, 'POST'); assert.equal(row.init.signal, signal); }
  for (const row of calls.filter(row => row.path.endsWith('/poll'))) assert.deepEqual(JSON.parse(String(row.init.body)), { loginId: 'controlled-grant' });
});
