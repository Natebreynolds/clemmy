import test from 'node:test';
import assert from 'node:assert/strict';
import { watchGuidanceTarget, type GuidanceTargetEnvironment, type GuidanceTargetState } from './app-guidance-target';

function harness(reducedMotion = false) {
  let candidate: HTMLElement | null = null;
  let focused: HTMLElement | null = null;
  let mutation: (() => void) | null = null;
  let disconnects = 0;
  const timers: { run: () => void; delay: number; cancelled: boolean }[] = [];
  const nodes = (native = false, tabindex?: string) => {
    const classes = new Set<string>();
    const attributes = new Map<string, string>(tabindex ? [['tabindex', tabindex]] : []);
    const scrolls: ScrollIntoViewOptions[] = [];
    let focusCount = 0;
    const node = {
      isConnected: true,
      classList: { add: (value: string) => classes.add(value), remove: (value: string) => classes.delete(value) },
      matches: () => native || attributes.has('tabindex'),
      setAttribute: (key: string, value: string) => attributes.set(key, value),
      getAttribute: (key: string) => attributes.get(key) ?? null,
      removeAttribute: (key: string) => attributes.delete(key),
      scrollIntoView: (options: ScrollIntoViewOptions) => scrolls.push(options),
      focus: () => { focused = node as unknown as HTMLElement; focusCount++; },
    };
    return { element: node as unknown as HTMLElement, classes, attributes, scrolls, focusCount: () => focusCount };
  };
  const environment: GuidanceTargetEnvironment = {
    find: () => candidate,
    focused: () => focused,
    reducedMotion: () => reducedMotion,
    observe: check => { mutation = check; return () => { mutation = null; disconnects++; }; },
    schedule: (run, delay) => { const timer = { run, delay, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
  };
  const states: GuidanceTargetState[] = [];
  return {
    environment, states, nodes, timers,
    setCandidate: (next: HTMLElement | null) => { candidate = next; },
    setFocused: (next: HTMLElement | null) => { focused = next; },
    focused: () => focused,
    mutate: () => mutation?.(),
    mutation: () => mutation,
    disconnects: () => disconnects,
    timeout: () => { const timer = timers.find(item => !item.cancelled); assert.ok(timer); timer.cancelled = true; timer.run(); },
    start: () => watchGuidanceTarget('[data-controlled-target]', state => states.push(state), environment),
  };
}

test('missing targets time out truthfully and require an explicit new watch to retry', () => {
  const h = harness();
  const stop = h.start();
  assert.deepEqual(h.states, ['checking']);
  assert.equal(h.timers[0].delay, 8_000);
  const lateMutation = h.mutation()!;
  h.timeout();
  assert.deepEqual(h.states, ['checking', 'unavailable']);
  assert.equal(h.mutation(), null);
  const target = h.nodes(); h.setCandidate(target.element); lateMutation();
  assert.equal(target.focusCount(), 0, 'an expired observer cannot imply readiness later');
  stop();
  const retry = h.start();
  assert.equal(h.states.at(-1), 'ready');
  assert.equal(target.focusCount(), 1);
  retry();
});

test('an asynchronously found control is highlighted and focused, with reduced motion respected', () => {
  const h = harness(true);
  const original = h.nodes(true); h.setFocused(original.element);
  const target = h.nodes();
  const stop = h.start();
  h.setCandidate(target.element); h.mutate();
  assert.deepEqual(h.states, ['checking', 'ready']);
  assert.equal(target.classes.has('clem-guide-target'), true);
  assert.equal(target.attributes.get('tabindex'), '-1');
  assert.deepEqual(target.scrolls, [{ behavior: 'auto', block: 'center' }]);
  assert.equal(h.focused(), target.element);
  assert.equal(h.timers[0].cancelled, true, 'finding the real control cancels the waiting timeout');
  h.mutate();
  assert.equal(target.focusCount(), 1, 'highlight mutations do not repeatedly focus the control');
  stop();
  assert.equal(target.classes.has('clem-guide-target'), false);
  assert.equal(target.attributes.has('tabindex'), false);
  assert.equal(h.focused(), original.element, 'cleanup restores connected original focus only while the guide still owns it');
});

test('a control that disappears returns to checking instead of retaining a stale ready claim', () => {
  const h = harness(); const target = h.nodes(); h.setCandidate(target.element);
  const stop = h.start();
  assert.deepEqual(h.states, ['ready']);
  h.setCandidate(null); h.mutate();
  assert.deepEqual(h.states, ['ready', 'checking']);
  assert.equal(target.classes.has('clem-guide-target'), false);
  assert.equal(target.attributes.has('tabindex'), false);
  h.timeout();
  assert.equal(h.states.at(-1), 'unavailable');
  stop();
});

test('late target loading never steals focus or scroll from a new user interaction', () => {
  const h = harness(); const original = h.nodes(true); const typing = h.nodes(true); const target = h.nodes();
  h.setFocused(original.element); const stop = h.start();
  h.setFocused(typing.element); h.setCandidate(target.element); h.mutate();
  assert.equal(h.states.at(-1), 'ready');
  assert.equal(target.classes.has('clem-guide-target'), true);
  assert.equal(target.focusCount(), 0);
  assert.deepEqual(target.scrolls, []);
  stop(); assert.equal(h.focused(), typing.element);
});

test('route/retry cleanup disables queued callbacks and preserves a control’s own tabindex', () => {
  const h = harness(); const target = h.nodes(false, '0');
  const stop = h.start(); const lateMutation = h.mutation()!; const lateTimeout = h.timers[0].run;
  stop(); h.setCandidate(target.element); lateMutation(); lateTimeout();
  assert.deepEqual(h.states, ['checking']);
  assert.equal(target.focusCount(), 0);
  const ready = h.start();
  assert.equal(target.attributes.get('tabindex'), '0');
  ready();
  assert.equal(target.attributes.get('tabindex'), '0');
  assert.ok(h.disconnects() >= 2);
});
