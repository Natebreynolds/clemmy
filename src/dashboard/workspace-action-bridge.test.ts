/** Execute the actual injected bridge with controlled native-event surfaces.
 * This verifies the event/capability flow, not browser physical-input attestation.
 * All records are disposable; no provider, model or real browser is invoked. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workspace-button-bridge-'));
const { composeServedWorkspaceView } = await import('./space-routes.js');
const { spaceStore, resolveInSpace } = await import('../spaces/store.js');
const { workspacePressViewRevision } = await import('../spaces/space-action-press-binding.js');

interface EventData { type: string; target: unknown; trusted: boolean; path: unknown[]; stopped: boolean; prevented: boolean; data?: unknown; source?: unknown; ports?: unknown[] }
const events = new WeakMap<object, EventData>();
class NativeEvent {
  constructor(type: string, input: Partial<EventData> = {}) {
    events.set(this, { type, target: null, trusted: false, path: [], stopped: false, prevented: false, ...input });
  }
  get type() { return events.get(this)!.type; }
  get target() { return events.get(this)!.target; }
  get isTrusted() { return events.get(this)!.trusted; }
  composedPath() { return events.get(this)!.path; }
  stopImmediatePropagation() { events.get(this)!.stopped = true; }
  preventDefault() { events.get(this)!.prevented = true; }
}
class NativeEventTarget {
  readonly listeners = new Map<string, Array<(event: NativeEvent) => void>>();
  addEventListener(type: string, listener: (event: NativeEvent) => void) {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
  }
  removeEventListener(type: string, listener: (event: NativeEvent) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== listener));
  }
  dispatchEvent(event: NativeEvent) {
    if (event.target === null) events.get(event)!.target = this;
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event); if (events.get(event)!.stopped) break;
    }
    return !events.get(event)!.prevented;
  }
}
class NativeElement extends NativeEventTarget {
  readonly attributes = new Map<string, string>();
  constructor(readonly tagName: string, readonly parent: NativeElement | null = null) { super(); }
  matches(selector: string) {
    if (selector === 'a') return this.tagName === 'a';
    return this.tagName === 'button' || this.attributes.get('role') === 'button'
      || (this.tagName === 'input' && ['button', 'submit'].includes(this.attributes.get('type') ?? ''));
  }
  closest(selector: string): NativeElement | null { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null; }
  hasAttribute(name: string) { return this.attributes.has(name); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  removeAttribute(name: string) { this.attributes.delete(name); }
}
class NativeMessageEvent extends NativeEvent {
  constructor(input: Partial<EventData>) { super('message', input); }
  get ports() { return events.get(this)!.ports; }
  get data() { return events.get(this)!.data; }
  get source() { return events.get(this)!.source; }
}
class NativePort extends NativeEventTarget {
  readonly sent: Array<Record<string, unknown>> = [];
  postMessage(message: unknown) { this.sent.push(JSON.parse(JSON.stringify(message))); }
  start() {}
}
class NativeCustomEvent extends NativeEvent {
  readonly detail: unknown;
  constructor(type: string, init: { detail: unknown }) { super(type); this.detail = init.detail; }
}
interface BridgeApi {
  action: (actionId: string, args?: Record<string, unknown>) => Promise<unknown>;
  bindAction: (button: NativeElement, actionId: string, args: Record<string, unknown>, handlers?: {
    onResult?: (result: unknown) => void; onError?: (error: Error) => void;
  }) => () => void;
}
let next = 0;
function harness() {
  const slug = `bridge-buttons-${++next}`;
  const rec = spaceStore.save({ id: slug, title: 'Controlled button bridge', actions: [
    { id: 'send', label: 'Send this exact reply', composioSlug: 'SAMPLE_SEND', argsTemplate: {} },
    { id: 'delete', label: 'Delete this exact item', composioSlug: 'SAMPLE_DELETE', argsTemplate: {} },
  ] });
  const html = '<!doctype html><html><head></head><body><p>Controlled buttons.</p></body></html>';
  const file = resolveInSpace(slug, rec.viewEntry); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, html);
  const served = composeServedWorkspaceView(slug, html);
  const start = served.indexOf("<script>(function(){'use strict';\nvar C=");
  assert.notEqual(start, -1);
  const code = served.slice(start + '<script>'.length, served.indexOf('</script>', start));
  const document = new NativeEventTarget();
  const window = new NativeEventTarget() as NativeEventTarget & { clem: BridgeApi; navigation: NativeEventTarget; fetch: typeof fetch };
  window.navigation = new NativeEventTarget();
  const bootstraps: Array<Record<string, unknown>> = [];
  const parent = { postMessage(message: Record<string, unknown>) { bootstraps.push(message); } };
  let random = 0; let timerId = 0;
  const timers = new Map<number, { run: () => void; ms: number }>();
  const context = vm.createContext({ window, document, parent, EventTarget: NativeEventTarget, Event: NativeEvent,
    Element: NativeElement, MessageEvent: NativeMessageEvent, MessagePort: NativePort, CustomEvent: NativeCustomEvent,
    navigator: {}, location: { href: `http://127.0.0.1:8420/console/spaces/${slug}/view/` }, URL, Response,
    crypto: { randomUUID: () => `controlled_${++random}` },
    setInterval: () => ++timerId, clearInterval: () => undefined,
    setTimeout: (fn: () => void, ms: number) => { const id = ++timerId; timers.set(id, { run: fn, ms }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  vm.runInContext(code, context);
  const general = new NativePort(); const privatePort = new NativePort();
  const documentId = bootstraps[0]!.documentId as string;
  window.dispatchEvent(new NativeMessageEvent({ trusted: true, source: parent, ports: [general, privatePort],
    data: { channel: 'clementine.workspace.rpc.v1', version: 1, kind: 'bootstrap_ack', workspaceId: slug, documentId } }));
  const click = (button: NativeElement, trusted = true, child = button) => {
    const event = new NativeEvent('click', { trusted, target: child, path: [child, ...(child !== button ? [button] : []), document, window] });
    document.dispatchEvent(event); return events.get(event)!;
  };
  const respond = (message: Record<string, unknown>, result: unknown) => general.dispatchEvent(new NativeMessageEvent({
    trusted: true, data: { channel: 'clementine.workspace.rpc.v1', version: 1, kind: 'response', workspaceId: slug, id: message.id, ok: true, result },
  }));
  const refuse = (message: Record<string, unknown>, effectState?: string) => general.dispatchEvent(new NativeMessageEvent({ trusted: true,
    data: { channel: 'clementine.workspace.rpc.v1', version: 1, kind: 'response', workspaceId: slug, id: message.id,
      ok: false, error: 'Controlled result needs checking.', ...(effectState ? { effectState } : {}) },
  }));
  const tick = (ms: number) => { for (const [id, timer] of timers) if (timer.ms === ms) { timers.delete(id); timer.run(); } };
  return { slug, rec, file, html, served, code, context, document, window, general, privatePort, documentId, click, respond, refuse, tick,
    viewRevision: workspacePressViewRevision(rec, html) };
}
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('only a genuine declared exact button goes down the private action path; unrelated click and later RPC do not borrow it', async () => {
  const h = harness(); const unrelated = new NativeElement('button');
  h.click(unrelated);
  assert.equal(h.privatePort.sent.length, 0);
  void h.window.clem.action('delete', { id: 'different-item' });
  assert.deepEqual(h.general.sent[0]!.payload, { actionId: 'delete', args: { id: 'different-item' } });
  const button = new NativeElement('button');
  h.window.clem.bindAction(button, 'send', { recipient: 'sample@example.invalid', body: 'Exact sample.' });
  h.click(button, false);
  assert.equal(h.privatePort.sent.length, 0, 'script-created click has no private authority');
  const clicked = h.click(button, true, new NativeElement('span', button));
  assert.equal(clicked.stopped, true, 'the bound button does not also run a legacy bubble handler');
  assert.equal(clicked.prevented, true);
  assert.equal(h.privatePort.sent.length, 1);
  assert.deepEqual(h.privatePort.sent[0], { channel: 'clementine.workspace.gesture.v1', version: 1, kind: 'gesture',
    workspaceId: h.slug, documentId: h.documentId, id: h.privatePort.sent[0]!.id, op: 'action',
    payload: { actionId: 'send', args: { recipient: 'sample@example.invalid', body: 'Exact sample.' }, expectedViewRevision: h.viewRevision } });
  vm.runInContext('Date.now = function(){return -999999999;}', h.context);
  void h.window.clem.action('delete', { id: 'a-later-rpc' });
  assert.deepEqual(h.general.sent[1]!.payload, { actionId: 'delete', args: { id: 'a-later-rpc' } });
  assert.doesNotMatch(h.code, /PRESS_MS|takePress|PRESS_AT/);
  h.respond(h.privatePort.sent[0]!, { ok: true, result: 'controlled' }); await flush();
});

test('binding snapshots arguments, reads only the clicked declaration and keeps one action in flight per button', async () => {
  const h = harness(); const button = new NativeElement('button'); const other = new NativeElement('button');
  const args = { recipient: 'sample@example.invalid', body: 'Originally shown.' };
  const results: unknown[] = [];
  h.window.clem.bindAction(button, 'send', args, { onResult: value => results.push(value) });
  args.body = 'Changed object outside the button.';
  other.setAttribute('data-clem-action', 'delete'); other.setAttribute('data-clem-args', '{"id":"other-item"}');
  h.click(button); h.click(button);
  assert.equal(h.privatePort.sent.length, 1);
  assert.deepEqual(h.privatePort.sent[0]!.payload, { actionId: 'send', args: { recipient: 'sample@example.invalid', body: 'Originally shown.' }, expectedViewRevision: h.viewRevision });
  h.respond(h.privatePort.sent[0]!, { ok: true, result: { controlled: true } }); await flush();
  assert.deepEqual(plain(results), [{ ok: true, result: { controlled: true } }]);
  h.click(other);
  assert.deepEqual(h.privatePort.sent[1]!.payload, { actionId: 'delete', args: { id: 'other-item' }, expectedViewRevision: h.viewRevision });
  h.respond(h.privatePort.sent[1]!, { ok: true, result: {} }); await flush();
});

test('invalid declarations and stale binding cleanups cannot supply authority or erase a replacement binding', () => {
  const h = harness(); const button = new NativeElement('button');
  assert.throws(() => h.window.clem.bindAction(button, 'unknown', {}), /declared action/);
  assert.throws(() => h.window.clem.bindAction(new NativeElement('div'), 'send', {}), /exact button/);
  const removeOld = h.window.clem.bindAction(button, 'send', { body: 'old' });
  const removeCurrent = h.window.clem.bindAction(button, 'delete', { id: 'current' });
  removeOld(); assert.equal(button.getAttribute('data-clem-action'), 'delete');
  removeCurrent(); assert.equal(button.getAttribute('data-clem-action'), null);
  button.setAttribute('data-clem-action', 'send'); button.setAttribute('data-clem-args', 'not-json');
  assert.equal(h.click(button).stopped, false, 'legacy handler remains available for a malformed/unbound declaration');
  assert.equal(h.privatePort.sent.length, 0);
});

test('an old served document keeps its own revision rather than silently inheriting a later saved view', () => {
  const h = harness();
  writeFileSync(h.file, h.html.replace('Controlled buttons.', 'A later document.'));
  assert.notEqual(workspacePressViewRevision(h.rec), h.viewRevision);
  const button = new NativeElement('button');
  h.window.clem.bindAction(button, 'send', { body: 'Old displayed content.' }); h.click(button);
  assert.equal((h.privatePort.sent[0]!.payload as Record<string, unknown>).expectedViewRevision, h.viewRevision);
});

test('legacy fetch and ordinary action helpers never send a caller-supplied press flag or proof', async () => {
  const h = harness();
  const responsePromise = h.window.fetch(`/api/console/spaces/${h.slug}/action`, { method: 'POST', body: JSON.stringify({ actionId: 'send', args: { body: 'Legacy controlled request.' }, press: true, pressToken: 'not-authority' }) });
  await flush();
  assert.equal(h.privatePort.sent.length, 0);
  assert.deepEqual(h.general.sent[0]!.payload, { actionId: 'send', args: { body: 'Legacy controlled request.' } });
  h.respond(h.general.sent[0]!, { pending: true, approvalId: 'apr-controlled' });
  assert.equal((await responsePromise).status, 202);
});

test('a slow private action keeps its original request until a late terminal result, never preparing another occurrence', async () => {
  const h = harness(); const button = new NativeElement('button'); const errors: string[] = []; const results: unknown[] = [];
  h.window.clem.bindAction(button, 'send', { body: 'One controlled send.' }, { onResult: result => results.push(result), onError: error => errors.push(error.message) });
  h.click(button); h.tick(30_000); await flush();
  assert.match(errors[0]!, /not confirmed yet/);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(button.getAttribute('data-clem-action-state'), 'needs-checking');
  h.click(button); assert.equal(h.privatePort.sent.length, 1);
  h.respond(h.privatePort.sent[0]!, { ok: true, result: { controlled: true } }); await flush();
  assert.equal(results.length, 1, 'late terminal result still settles the original pending request');
  assert.equal(button.getAttribute('aria-busy'), null);
  h.click(button); assert.equal(h.privatePort.sent.length, 2, 'only a confirmed success permits an explicit new owner intent');
});

test('unknown effects stay latched, while a proven-before-dispatch refusal allows an explicit reviewed click', async () => {
  for (const effectState of [undefined, 'uncertain', 'not_started']) {
    const h = harness(); const button = new NativeElement('button'); const errors: string[] = [];
    h.window.clem.bindAction(button, 'send', { body: 'Controlled request.' }, { onError: error => errors.push(error.message) });
    h.click(button); h.refuse(h.privatePort.sent[0]!, effectState); await flush();
    assert.equal(errors.length, 1);
    h.click(button);
    assert.equal(h.privatePort.sent.length, effectState === 'not_started' ? 2 : 1);
    assert.equal(button.getAttribute('aria-busy'), 'true', 'new intent or unresolved original remains pending');
  }
});
