import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fragment, type ComponentChildren, type VNode } from 'preact';
import { ConnectionsPage } from './Settings.js';

type Props = Parameters<typeof ConnectionsPage>[0];
const fresh: Props = {
  rows: [], loading: false, error: null, offline: false, stale: false,
  refreshing: false, onRetry: () => undefined,
};
const connected = { id: 'mail', name: 'Work mail', kind: 'composio', state: 'ok' as const, cause: null };

/** These components are stateless: inspect their rendered elements and invoke
 * the actual retry button without a browser, network, or app state. */
function view(props: Partial<Props>) {
  const elements: VNode<Record<string, unknown>>[] = [];
  const words: string[] = [];
  function visit(child: ComponentChildren): void {
    if (child == null || typeof child === 'boolean') return;
    if (Array.isArray(child)) { child.forEach(visit); return; }
    if (typeof child !== 'object') { words.push(String(child)); return; }
    const node = child as VNode<Record<string, unknown>>;
    if (node.type === Fragment) {
      visit(node.props.children);
    } else if (typeof node.type === 'function') {
      const component = node.type as (props: Record<string, unknown>) => ComponentChildren;
      visit(component(node.props));
    } else {
      elements.push(node);
      visit(node.props.children);
    }
  }
  visit(ConnectionsPage({ ...fresh, ...props }));
  return { text: words.join(' '), elements };
}

test('failed first connection read is unavailable with a working Retry, never empty', () => {
  let retries = 0;
  const rendered = view({ rows: undefined, error: 'Request failed', stale: true, onRetry: () => { retries++; } });
  assert.match(rendered.text, /Connection status is unavailable/);
  assert.doesNotMatch(rendered.text, /Nothing connected|Connected/);
  const retry = rendered.elements.find((node) => node.type === 'button');
  assert.ok(retry);
  assert.equal(retry.props.children, 'Retry');
  (retry.props.onClick as () => void)();
  assert.equal(retries, 1);
  assert.ok(rendered.elements.some((node) => node.props.role === 'status'));
});

test('a failed refresh of a previously empty inventory makes no current empty claim', () => {
  const rendered = view({ rows: [], error: 'Request failed', stale: true });
  assert.match(rendered.text, /Connection status is unavailable/);
  assert.doesNotMatch(rendered.text, /Nothing connected|Connect apps on your Mac/);
});

test('a failed refresh preserves known rows while withdrawing current health indicators', () => {
  const rendered = view({ rows: [connected], error: 'Request failed', stale: true });
  assert.match(rendered.text, /Work mail/);
  assert.match(rendered.text, /Showing last known connections/);
  assert.match(rendered.text, /current status has not been verified/);
  assert.match(rendered.text, /Last checked: Connected/);
  assert.equal(rendered.elements.some((node) => String(node.props.class).includes('health-dot')), false);
});

test('offline failures retain historical warnings and offer Retry', () => {
  const rendered = view({
    rows: [{ ...connected, state: 'warn', cause: 'Sign-in expired' }],
    error: 'Offline', offline: true, stale: true,
  });
  assert.match(rendered.text, /Can't reach your Mac right now/);
  assert.match(rendered.text, /Last checked: Sign-in expired/);
  assert.match(rendered.text, /Retry/);
  assert.doesNotMatch(rendered.text, /Nothing connected/);
});

test('retry keeps stale rows labelled until a successful response arrives', () => {
  const rendered = view({ rows: [connected], error: 'Request failed', stale: true, refreshing: true });
  assert.match(rendered.text, /Checking connections/);
  assert.match(rendered.text, /Last checked: Connected/);
  assert.match(rendered.text, /Connection status is unavailable/);
});

test('initial loading is announced without claiming empty or unavailable', () => {
  const rendered = view({ rows: undefined, loading: true, stale: true, refreshing: true });
  assert.ok(rendered.elements.some((node) => node.props.role === 'status' && node.props['aria-label'] === 'Loading connections'));
  assert.doesNotMatch(rendered.text, /Nothing connected|unavailable/);
});

test('successful reads restore current status and permit a verified empty state', () => {
  const rendered = view({ rows: [connected] });
  assert.match(rendered.text, /Work mail Connected/);
  assert.ok(rendered.elements.some((node) => node.props.class === 'health-dot ok'));
  assert.doesNotMatch(rendered.text, /Last checked|unavailable|Retry/);
  assert.match(view({ rows: [] }).text, /Nothing connected yet/);
});

test('missing data without a reported transport error still cannot look empty', () => {
  const rendered = view({ rows: undefined });
  assert.match(rendered.text, /Connection status is unavailable/);
  assert.doesNotMatch(rendered.text, /Nothing connected/);
});
