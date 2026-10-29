import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as drafts from '../../lib/composer-drafts.js';
import * as artifact from '../../lib/artifact-discussion.js';
import * as project from '../../lib/project-tools-draft.js';
import * as connections from '../../lib/connection-setup-draft.js';
import * as examples from '../../lib/composer-examples.js';
import * as onboarding from '../../lib/onboarding-entry.js';

type Node = { type: any; props: Record<string, any> };
type Slot = { value?: any; deps?: unknown[]; cleanup?: () => void; effect?: () => void | (() => void) };
type Location = { pathname: string; key: string; state: any };
let stamp = 3_000_000;
const fresh = (): Location => ({ pathname: '/chat', key: `starter-${++stamp}`, state: { newChat: stamp } });
const keyOf = (location: Location) => drafts.newComposerDraftKey(location.pathname, location.key,
  onboarding.explorationDraftStamp(location.pathname, location.state) ?? location.state.newChat);
const equalDeps = (before: unknown[] | undefined, next: unknown[]) => Boolean(before && before.length === next.length && next.every((value, i) => Object.is(value, before[i])));

// Executes the actual Composer, rendered callbacks and effects. Only React's
// host mechanics, a textarea and inert external surfaces are synthetic. Draft
// ownership, examples and route handoffs execute their production helpers.
function mount(initial = fresh(), supplied: Record<string, any> = {}) {
  const slots: Slot[] = [], effects: Array<() => void> = [], frames = new Map<number, () => void>();
  const calls = { sends: 0, transport: 0, focus: 0 };
  const textarea = { style: { height: '' }, scrollHeight: 74, focus() { calls.focus++; } };
  let location = initial, cursor = 0, dirty = false, alive = true, frameId = 0, tree: Node;
  const props = { busy: false, gettingStarted: true, inputRef: { current: textarea },
    onSend() { calls.sends++; }, onStop() {}, ...supplied };
  const react = {
    useState(value: any) {
      const index = cursor++; if (!slots[index]) slots[index] = { value: typeof value === 'function' ? value() : value };
      return [slots[index].value, (next: any) => { const value = typeof next === 'function' ? next(slots[index].value) : next;
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; } }];
    },
    useRef(value: any) { const index = cursor++; if (!slots[index]) slots[index] = { value: { current: value } }; return slots[index].value; },
    useId() { const index = cursor++; if (!slots[index]) slots[index] = { value: `voice-${index}` }; return slots[index].value; },
    useCallback(callback: any, deps: unknown[]) { const index = cursor++, previous = slots[index];
      if (!previous || !equalDeps(previous.deps, deps)) slots[index] = { value: callback, deps }; return slots[index].value; },
    useEffect(effect: () => void | (() => void), deps: unknown[]) {
      const index = cursor++, previous = slots[index];
      if (!previous || !equalDeps(previous.deps, deps)) {
        slots[index] = { ...previous, deps, effect }; effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = effect() ?? undefined; });
      }
    },
    useSyncExternalStore(subscribe: (fn: () => void) => () => void, read: () => unknown) {
      const index = cursor++; if (!slots[index]) slots[index] = { cleanup: subscribe(() => { if (alive) dirty = true; }) }; return read();
    },
  };
  const element = (type: any, props: any, key?: string): Node => ({ type, props: { ...props, key } });
  const blocked = () => { calls.transport++; throw new Error('Unexpected transport in Composer starter control.'); };
  const dependencies: Record<string, any> = {
    react, 'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-router-dom': { useLocation: () => location },
    'lucide-react': new Proxy({}, { get: () => 'svg' }),
    '@/components/chat/ModelPicker': { ModelPicker: 'model-picker' },
    '@/components/ui/Button': { Button: 'button' }, '@/components/chat/FileDock': { useFileDock: () => null },
    '@/lib/chat': { uploadAttachment: blocked }, '@/lib/session-files': { prepareSessionFileContext: blocked },
    '@/lib/use-dictation': { useDictation: () => ({ available: false, listening: false, transcribing: false, error: null, stop() {}, toggle: blocked }) },
    '@/lib/voice-mode': { useVoiceMode: () => ({ enabled: false, phase: 'off' }), voiceMode: new Proxy({}, { get: () => blocked }) },
    '@/lib/cn': { cn: (...values: any[]) => values.filter(Boolean).join(' ') },
    '@/lib/composer-drafts': drafts, '@/lib/artifact-discussion': artifact,
    '@/lib/project-tools-draft': project, '@/lib/connection-setup-draft': connections, '@/lib/composer-examples': examples,
    '@/lib/onboarding-entry': onboarding,
    // A stylesheet import carries no behavior.
    './composer.css': {},
  };
  const source = readFileSync(new URL('./Composer.tsx', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: any = {};
  runInNewContext(code, { exports, require(name: string) { assert.ok(name in dependencies, `Unexpected production dependency: ${name}`); return dependencies[name]; },
    requestAnimationFrame(callback: () => void) { frames.set(++frameId, callback); return frameId; }, cancelAnimationFrame(id: number) { frames.delete(id); },
  });
  const render = () => {
    for (let pass = 0; pass < 20; pass++) {
      cursor = 0; dirty = false; tree = exports.Composer(props); effects.splice(0).forEach(effect => effect()); if (!dirty) return;
    }
    throw new Error('Actual Composer did not settle.');
  };
  const nodes = () => {
    const found: Node[] = []; const visit = (child: any) => {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object' && child.props) { found.push(child); visit(child.props.children); }
    }; visit(tree); return found;
  };
  const text = (child: any): string => Array.isArray(child) ? child.map(text).join(' ')
    : child && typeof child === 'object' ? text(child.props?.children) : child == null || typeof child === 'boolean' ? '' : String(child);
  const buttons = () => nodes().filter(node => node.type === 'button' && examples.COMPOSER_EXAMPLES.some(example => example.label === text(node).trim()));
  const input = () => { const node = nodes().find(node => node.type === 'textarea'); assert.ok(node); return node; };
  render();
  return { calls, textarea, render, buttons, input,
    key: () => keyOf(location),
    choose() { const button = buttons()[0]; assert.ok(button, 'An actual starter button must be rendered.'); return button.props.onClick; },
    type(value: string) { input().props.onChange({ target: { value } }); render(); },
    navigate(next: Location) { location = next; render(); },
    update(next: Record<string, any>) { Object.assign(props, next); render(); },
    flushFrames() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); render(); },
    replayEffects() {
      slots.filter(slot => slot.effect).forEach(slot => slot.cleanup?.());
      slots.forEach(slot => { if (slot.effect) slot.cleanup = slot.effect() ?? undefined; }); render();
    },
    unmount() { alive = false; slots.forEach(slot => slot.cleanup?.()); },
  };
}

test('actual starter callback fills an editable textarea, focuses and grows it without sending', () => {
  const view = mount(); view.choose()(); view.render(); view.flushFrames();
  assert.equal(view.input().props.value, examples.COMPOSER_EXAMPLES[0].text);
  assert.equal(view.calls.focus, 1); assert.equal(view.textarea.style.height, '74px');
  assert.equal(view.buttons().length, 0); assert.equal(view.calls.sends, 0); assert.equal(view.calls.transport, 0);
  view.type('My own revised goal'); assert.equal(drafts.readComposerDraft(view.key()).text, 'My own revised goal'); view.unmount();
});

test('busy, pending delivery and assigned conversations never offer starter callbacks', () => {
  for (const props of [{ busy: true }, { pendingPost: { input: 'Unconfirmed request' } },
    { sessionId: 'r30-execution' }, { draftSessionId: 'r30-conversation' }]) {
    const view = mount(fresh(), props); assert.equal(view.buttons().length, 0);
    assert.equal(drafts.readComposerDraft(view.key()).text, ''); assert.equal(view.calls.sends, 0); view.unmount();
  }
});

test('a retained starter callback respects later busy or pending delivery on the same route', () => {
  for (const next of [{ busy: true }, { pendingPost: { input: 'Unconfirmed request' } }]) {
    const view = mount(), stale = view.choose(); view.update(next); stale(); view.render(); view.flushFrames();
    assert.equal(view.input().props.value, ''); assert.equal(drafts.readComposerDraft(view.key()).text, '');
    assert.equal(view.calls.focus, 0); assert.equal(view.calls.sends, 0); assert.equal(view.calls.transport, 0); view.unmount();
  }
});

test('a retained starter callback cannot alter a later route or an assigned creation draft', () => {
  const first = fresh(), view = mount(first), stale = view.choose();
  view.navigate(fresh()); view.type('Keep this new route draft'); stale(); view.render();
  assert.equal(view.input().props.value, 'Keep this new route draft'); assert.equal(drafts.readComposerDraft(keyOf(first)).text, '');
  assert.equal(view.calls.focus, 0); assert.equal(view.calls.sends, 0); view.unmount();
  const assigned = mount(), retained = assigned.choose(); drafts.moveComposerDraft(assigned.key(), 'session:r30-owned-starter');
  retained(); assigned.render(); assert.equal(drafts.readComposerDraft('session:r30-owned-starter').text, '');
  assert.equal(assigned.calls.focus, 0); assigned.unmount();
});

test('a retained starter callback preserves text, attached files and selected artifact context', () => {
  const view = mount(), choose = view.choose();
  const attached = { localId: 'r30-attached', name: 'controlled.txt', status: 'ready' as const, id: 'r30-file' };
  const selected = { ref: { sessionId: 'r30-source', fileId: 'r30-artifact', name: 'controlled.html', folder: 'outputs' }, revision: `sha256:${'a'.repeat(64)}` };
  drafts.writeComposerDraft(view.key(), current => ({ ...current, text: 'Keep my words', attachments: [attached], artifact: selected }));
  choose(); view.render(); const kept = drafts.readComposerDraft(view.key());
  assert.equal(kept.text, 'Keep my words'); assert.deepEqual(kept.attachments, [attached]); assert.deepEqual(kept.artifact, selected);
  assert.equal(view.calls.sends, 0); assert.equal(view.calls.transport, 0); view.unmount();
});

test('actual connection navigation seeds once, focuses and stays editable across remounts without sending', () => {
  const navigation = connections.connectionSetupChatNavigation('apps', 'Controlled calendar', ++stamp); assert.ok(navigation);
  const route = { ...navigation, key: `connection-${stamp}` };
  const expected = connections.readConnectionSetupDraft(route.state); assert.ok(expected);
  const first = mount(route); first.flushFrames();
  assert.equal(first.input().props.value, expected.text); assert.equal(first.calls.focus, 1);
  assert.equal(first.textarea.style.height, '74px'); assert.equal(first.calls.sends, 0); assert.equal(first.calls.transport, 0);
  first.type('My edited connection request'); first.unmount();
  const second = mount(route); second.flushFrames(); assert.equal(second.input().props.value, 'My edited connection request');
  assert.equal(second.calls.focus, 0); second.type(''); second.unmount();
  const third = mount(route); third.flushFrames(); assert.equal(third.input().props.value, '');
  assert.equal(third.calls.focus, 0); assert.equal(third.calls.sends, 0); assert.equal(third.calls.transport, 0); third.unmount();
});

test('prepared connection focus survives actual effect cleanup and setup replay exactly once', () => {
  const navigation = connections.connectionSetupChatNavigation('apps', 'Controlled replay app', ++stamp); assert.ok(navigation);
  const view = mount({ ...navigation, key: `replayed-connection-${stamp}` });
  const expected = view.input().props.value; assert.ok(expected.length > 0); assert.equal(view.calls.focus, 0);
  view.replayEffects(); view.flushFrames(); assert.equal(view.input().props.value, expected);
  assert.equal(view.calls.focus, 1); assert.equal(view.textarea.style.height, '74px');
  view.replayEffects(); view.flushFrames(); assert.equal(view.calls.focus, 1);
  assert.equal(view.calls.sends, 0); assert.equal(view.calls.transport, 0); view.unmount();
});

test('connection handoff preserves an existing typed draft and retires focus on route change', () => {
  const navigation = connections.connectionSetupChatNavigation('mcp', 'Controlled tools', ++stamp); assert.ok(navigation);
  const route = { ...navigation, key: `typed-connection-${stamp}` };
  drafts.writeComposerDraft(keyOf(route), current => ({ ...current, text: 'Already drafting' }));
  const typed = mount(route); typed.flushFrames(); assert.equal(typed.input().props.value, 'Already drafting');
  assert.equal(typed.calls.focus, 0); typed.unmount();
  const nextNavigation = connections.connectionSetupChatNavigation('cli', undefined, ++stamp); assert.ok(nextNavigation);
  const leaving = mount({ ...nextNavigation, key: `leaving-${stamp}` });
  leaving.navigate(fresh()); leaving.flushFrames(); assert.equal(leaving.input().props.value, '');
  assert.equal(leaving.calls.focus, 0); assert.equal(leaving.calls.sends, 0); assert.equal(leaving.calls.transport, 0); leaving.unmount();
});

test('an explicit exploration Settings return keeps the actual composer draft, files and selected artifact without a send', () => {
  const navigation = onboarding.onboardingCompletionNavigation(true, ++stamp);
  const first = mount({ pathname: '/chat', key: `explore-first-${stamp}`, state: navigation.state }, { gettingStarted: false });
  first.type('Keep this first request while I connect a model.');
  const attachment = { localId: 'explore-attached', name: 'controlled.txt', status: 'ready' as const, id: 'explore-file' };
  const artifact = { ref: { sessionId: 'controlled-source', fileId: 'controlled-file', name: 'saved.md', folder: 'Controlled' }, revision: `sha256:${'c'.repeat(64)}` };
  drafts.writeComposerDraft(first.key(), current => ({ ...current, attachments: [attachment], artifact }));
  const owner = first.key(); first.unmount();
  const settings = onboarding.onboardingModelAccounts(navigation.state.onboardingEntry);
  const back = onboarding.onboardingDraftReturn(settings.state); assert.ok(back);
  const returned = mount({ pathname: back.pathname, key: `explore-return-${stamp}`, state: back.state }, { gettingStarted: false });
  assert.equal(returned.key(), owner);
  assert.equal(returned.input().props.value, 'Keep this first request while I connect a model.');
  assert.deepEqual(drafts.readComposerDraft(returned.key()).attachments, [attachment]);
  assert.deepEqual(drafts.readComposerDraft(returned.key()).artifact, artifact);
  assert.equal(drafts.composerDraftIsUnassigned(owner), true, 'navigation never invents a conversation assignment');
  assert.equal(returned.calls.sends, 0); assert.equal(returned.calls.transport, 0);
  returned.navigate(fresh()); assert.equal(returned.input().props.value, '', 'intentional New chat releases the exploration draft owner');
  returned.unmount();
});
