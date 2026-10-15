import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { mcpConnectionHelp, mcpConnectionPresentation, mcpServerNameConflict } from '../../lib/mcp-setup-view.js';
import { connectionSetupChatNavigation } from '../../lib/connection-setup-draft.js';
import type { McpServer } from '../../lib/connect.js';

// Execute the actual card and its rendered event callbacks without a DOM,
// browser, real transport or application module initialization. The small hook
// host retains state/refs/effect ownership; it does not reimplement card logic.
type Element = { type: unknown; props: Record<string, any> };
type Slot = { value?: any; deps?: readonly unknown[]; cleanup?: () => void };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const fixture = (patch: Partial<McpServer> = {}): McpServer => ({ name: 'controlled-project-tools', enabled: true,
  state: 'unavailable', declaredEnvKeys: ['CONTROLLED_KEY'], editableEnvKeys: ['CONTROLLED_KEY'], unsetEnvKeys: [], ...patch });

function mount(initial: McpServer, replies: { save?: (name: string, key: string, value: string) => Promise<any>;
  tools?: () => Promise<any> } = {}) {
  const slots: Slot[] = [];
  const effects: Array<() => void> = [];
  const calls = { save: [] as unknown[][], tools: 0, reconnect: 0, toggle: 0, remove: 0, refresh: 0 };
  let cursor = 0, dirty = false, server = initial, tree: Element;
  const element = (type: unknown, props: Record<string, any> | null, key?: string): Element => ({ type, props: { ...props, key } });
  const hooks = {
    useState(value: any) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { value: typeof value === 'function' ? value() : value };
      return [slots[index].value, (next: any) => {
        const value = typeof next === 'function' ? next(slots[index].value) : next;
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; }
      }];
    },
    useRef(value: any) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { value: { current: value } };
      return slots[index].value;
    },
    useId() { const index = cursor++; return `controlled-${index}`; },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const index = cursor++;
      const before = slots[index];
      if (!before || deps.length !== before.deps?.length || deps.some((value, i) => !Object.is(value, before.deps?.[i]))) {
        slots[index] = { ...before, deps };
        effects.push(() => { before?.cleanup?.(); slots[index].cleanup = effect() ?? undefined; });
      }
    },
  };
  const transport = {
    async setMcpCredential(name: string, key: string, value: string) {
      calls.save.push([name, key, value]); return replies.save?.(name, key, value) ?? { ok: true, state: 'connected', unsetEnvKeys: [] };
    },
    async getMcpServerTools() { calls.tools++; return replies.tools?.() ?? { state: 'connected', toolCount: 1, tools: [{ name: 'controlled-read' }] }; },
    async reconnectMcpServer() { calls.reconnect++; },
    async setMcpServerEnabled() { calls.toggle++; },
    async deleteMcpServer() { calls.remove++; },
  };
  const exports: Record<string, any> = {};
  const code = ts.transpileModule(readFileSync(new URL('./McpManager.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const dependencies: Record<string, unknown> = {
    react: hooks,
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-router-dom': { useNavigate: () => () => {} },
    '@tanstack/react-query': { useQueryClient: () => ({}) },
    'lucide-react': new Proxy({}, { get: () => 'svg' }),
    '@/components/ui/Card': { Card: 'section' }, '@/components/ui/Button': { Button: 'button' },
    '@/components/ui/Field': { Field: 'field', Input: 'input', Select: 'select', Textarea: 'textarea' },
    '@/components/ui/StatusPill': { StatusPill: 'status' }, '@/components/ui/Skeleton': { Skeleton: 'skeleton' },
    '@/components/ui/QueryUnavailable': { QueryUnavailable: 'unavailable' }, '@/lib/poll': {},
    '@/lib/connection-setup-draft': { connectionSetupChatNavigation },
    '@/lib/connect': transport, '@/lib/mcp-setup': {},
    '@/lib/mcp-setup-view': { mcpConnectionHelp, mcpConnectionPresentation, mcpServerNameConflict },
    '@/lib/cn': { cn: (...args: unknown[]) => args.filter(Boolean).join(' ') },
  };
  runInNewContext(`${code}\nexports.__card = McpServerCard;`, { exports, require(name: string) {
    assert.ok(name in dependencies, `Unexpected production dependency: ${name}`); return dependencies[name];
  } });
  const render = () => {
    for (let pass = 0; pass < 15; pass++) {
      dirty = false; cursor = 0;
      tree = exports.__card({ server, refresh: async () => { calls.refresh++; } });
      effects.splice(0).forEach(effect => effect());
      if (!dirty) return tree;
    }
    throw new Error('Actual card did not settle within the controlled hook host.');
  };
  const nodes = () => {
    const found: Element[] = [];
    const visit = (child: any) => {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object' && 'props' in child) { found.push(child); visit(child.props.children); }
    };
    visit(tree); return found;
  };
  const childWords = (child: any): string => Array.isArray(child) ? child.map(childWords).join(' ')
    : child && typeof child === 'object' ? childWords(child.props?.children) : child == null || typeof child === 'boolean' ? '' : String(child);
  const words = (child: any = tree): string => childWords(child);
  const button = (label: string) => {
    const found = nodes().find(node => node.type === 'button' && words(node).replace(/\s+/g, ' ').trim() === label);
    assert.ok(found, `Missing actual rendered button: ${label}`); return found;
  };
  const inputs = () => nodes().filter(node => node.type === 'input');
  render();
  return { render, nodes, words, button, inputs, calls,
    change(key: string, value: string) {
      const input = inputs().find(node => node.props.placeholder === key); assert.ok(input);
      input.props.onChange({ target: { value } }); render();
    },
    switchServer(next: McpServer) { server = next; render(); },
  };
}

test('saved wrong key with no missing keys has an explicit empty replacement form; stored values are never rendered', () => {
  const view = mount(fixture({ env: { CONTROLLED_KEY: 'STORED-PRIVATE-SYNTHETIC' } }));
  assert.equal(view.inputs().length, 0);
  view.button('Update access details').props.onClick(); view.render();
  assert.equal(view.inputs().length, 1);
  assert.equal(view.inputs()[0].props.type, 'password'); assert.equal(view.inputs()[0].props.value, '');
  assert.equal(view.inputs()[0].props.autoComplete, 'new-password');
  assert.equal(JSON.stringify(view.nodes()).includes('STORED-PRIVATE-SYNTHETIC'), false);
  assert.equal(view.button('Save & check').props.disabled, true);
  assert.equal(view.calls.save.length, 0);
});

test('actual save callback admits one synchronous replacement and locks all other operations until readiness settles', async () => {
  const pending = deferred<any>(); const view = mount(fixture(), { save: () => pending.promise });
  const retry = view.button('Retry connection').props.onClick;
  const turnOff = view.button('Turn off').props.onClick;
  view.button('Update access details').props.onClick(); view.render(); view.change('CONTROLLED_KEY', 'NEW-PRIVATE-SYNTHETIC');
  const save = view.button('Save & check').props.onClick;
  save(); save(); retry(); turnOff(); view.render();
  assert.equal(view.calls.save.length, 1); assert.deepEqual(view.calls.save[0], ['controlled-project-tools', 'CONTROLLED_KEY', 'NEW-PRIVATE-SYNTHETIC']);
  assert.equal(view.calls.reconnect, 0); assert.equal(view.calls.tools, 0); assert.equal(view.calls.toggle, 0);
  assert.ok(view.nodes().filter(node => node.type === 'button').every(node => node.props.disabled === true));
  pending.resolve({ ok: true, state: 'connected', unsetEnvKeys: [], toolCount: 1 }); await flush(); view.render();
  assert.ok(view.nodes().some(node => node.type === 'status' && view.words(node) === 'Connected'));
  assert.equal(view.inputs()[0].props.value, ''); assert.equal(view.calls.tools, 0, 'current readiness must not trigger a duplicate handshake');
  assert.equal(view.words().includes('NEW-PRIVATE-SYNTHETIC'), false);
});

test('credential readiness responses remain truthful for every non-connected state', async () => {
  for (const [state, label, next] of [
    ['unavailable', 'Connection failed', 'retry'], ['needs_credentials', 'Needs setup', 'remaining'],
    ['connecting', 'Connecting', 'Check connection'], ['disabled', 'Off', 'Enable'], ['unknown', 'Not checked', 'Check connection'],
  ]) {
    const view = mount(fixture({ state: 'connected' }), { save: async () => ({ ok: true, state }) });
    view.button('Update access details').props.onClick(); view.render(); view.change('CONTROLLED_KEY', 'SYNTHETIC-VALUE');
    view.button('Save & check').props.onClick(); await flush(); view.render();
    assert.ok(view.nodes().some(node => node.type === 'status' && view.words(node) === label), state);
    assert.ok(!view.nodes().some(node => node.type === 'status' && view.words(node) === 'Connected'), state);
    assert.ok(view.words().toLowerCase().includes(next.toLowerCase()), state);
  }
});

test('cancel clears an unsaved replacement and reopening never restores it', () => {
  const view = mount(fixture()); view.button('Update access details').props.onClick(); view.render();
  view.change('CONTROLLED_KEY', 'UNSENT-SYNTHETIC'); view.button('Cancel').props.onClick(); view.render();
  assert.equal(view.inputs().length, 0); assert.equal(view.calls.save.length, 0);
  view.button('Update access details').props.onClick(); view.render();
  assert.equal(view.inputs()[0].props.value, '');
});

test('absent edit metadata and inline literals never gain inferred replacement fields; missing-key compatibility remains', async () => {
  for (const patch of [{ editableEnvKeys: undefined }, { editableEnvKeys: [], env: { CONTROLLED_KEY: 'INLINE-SYNTHETIC' } }]) {
    const view = mount(fixture(patch));
    assert.equal(view.inputs().length, 0); assert.equal(view.words().includes('Update access details'), false);
  }
  for (const missing of [['CONTROLLED_KEY'], ['CONTROLLED_KEY', 'SECOND_KEY']]) {
    const view = mount(fixture({ editableEnvKeys: undefined, unsetEnvKeys: missing }), { save: async () => ({ ok: true }) });
    assert.equal(view.inputs().length, missing.length); view.change('CONTROLLED_KEY', 'COMPAT-SYNTHETIC');
    view.button(missing.length === 1 ? 'Save & connect' : 'Save').props.onClick(); await flush(); view.render();
    assert.equal(view.calls.save.length, 1); assert.equal(view.calls.tools, missing.length === 1 ? 1 : 0);
  }
});

test('server switch clears local values and retired save settlement cannot unlock or repaint a newer server operation', async () => {
  const old = deferred<any>(), current = deferred<any>();
  const view = mount(fixture(), { save: name => name === 'controlled-project-tools' ? old.promise : current.promise });
  view.button('Update access details').props.onClick(); view.render(); view.change('CONTROLLED_KEY', 'OLD-SYNTHETIC');
  view.button('Save & check').props.onClick();
  view.switchServer(fixture({ name: 'second-controlled-server', state: 'unknown' }));
  assert.equal(view.inputs().length, 0);
  view.button('Update access details').props.onClick(); view.render(); assert.equal(view.inputs()[0].props.value, '');
  view.change('CONTROLLED_KEY', 'NEWER-SYNTHETIC'); view.button('Save & check').props.onClick(); view.render();
  old.resolve({ ok: true, state: 'connected', unsetEnvKeys: [] }); await flush(); view.render();
  assert.ok(!view.nodes().some(node => node.type === 'status' && view.words(node) === 'Connected'));
  assert.ok(view.nodes().filter(node => node.type === 'button').every(node => node.props.disabled === true));
  current.resolve({ ok: true, state: 'unavailable', unsetEnvKeys: [] }); await flush(); view.render();
  assert.ok(view.nodes().some(node => node.type === 'status' && view.words(node) === 'Connection failed'));
  assert.equal(view.calls.save.length, 2); assert.equal(view.calls.refresh, 1);
});

test('a compatibility response for an existing replacement never checks while a different key is still missing', async () => {
  const view = mount(fixture({ unsetEnvKeys: ['SECOND_KEY'], declaredEnvKeys: ['CONTROLLED_KEY', 'SECOND_KEY'] }), {
    save: async () => ({ ok: true }),
  });
  view.button('Update access details').props.onClick(); view.render(); view.change('CONTROLLED_KEY', 'COMPAT-REPLACEMENT');
  view.button('Save & check').props.onClick(); await flush(); view.render();
  assert.equal(view.calls.save.length, 1); assert.equal(view.calls.tools, 0);
  assert.ok(view.nodes().some(node => node.type === 'status' && view.words(node) === 'Needs setup'));
});

test('an unsuccessful response cannot promote a replacement to Connected or trigger a compatibility check', async () => {
  const view = mount(fixture(), { save: async () => ({ ok: false, state: 'connected' }) });
  view.button('Update access details').props.onClick(); view.render(); view.change('CONTROLLED_KEY', 'NOT-CONFIRMED');
  view.button('Save & check').props.onClick(); await flush(); view.render();
  assert.ok(!view.nodes().some(node => node.type === 'status' && view.words(node) === 'Connected'));
  assert.ok(view.words().includes('could not be confirmed'));
  assert.equal(view.calls.tools, 0); assert.equal(view.calls.refresh, 0);
});

test('a failed save shows a safe recovery message without raw error or false Connected state', async () => {
  const view = mount(fixture({ state: 'connected' }), { save: async () => { throw new Error('PRIVATE-ERROR-SYNTHETIC'); } });
  view.button('Update access details').props.onClick(); view.render(); view.change('CONTROLLED_KEY', 'UNCONFIRMED-SYNTHETIC');
  view.button('Save & check').props.onClick(); await flush(); view.render();
  assert.ok(view.words().includes('Check the connection status'));
  assert.equal(view.words().includes('PRIVATE-ERROR-SYNTHETIC'), false);
  assert.ok(!view.nodes().some(node => node.type === 'status' && view.words(node) === 'Connected'));
  assert.equal(view.calls.save.length, 1); assert.equal(view.calls.tools, 0);
});

test('prototype-looking literal credential names stay empty and only save the exact entered own value', async () => {
  for (const key of ['__proto__', 'constructor', 'toString']) {
    const view = mount(fixture({ declaredEnvKeys: [key], editableEnvKeys: [key] }));
    view.button('Update access details').props.onClick(); view.render();
    assert.equal(view.inputs()[0].props.value, ''); assert.equal(view.button('Save & check').props.disabled, true);
    view.change(key, 'OWN-SYNTHETIC-VALUE'); view.button('Save & check').props.onClick(); await flush(); view.render();
    assert.deepEqual(view.calls.save, [['controlled-project-tools', key, 'OWN-SYNTHETIC-VALUE']]);
    assert.equal(view.inputs()[0].props.value, '');
  }
});
