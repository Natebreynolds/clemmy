import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Fragment, h, type ComponentChildren, type VNode } from 'preact';
import type { ProjectLocalToolServer } from '@clem/chat-engine';

(globalThis as { React?: unknown }).React = { createElement: h, Fragment };
const fetches: unknown[] = [];
mock.method(globalThis, 'fetch', (...args: unknown[]) => { fetches.push(args); throw new Error('Presentation must not connect'); });
const { ProjectToolServerStatus } = await import('./Project.js');
test.after(() => { mock.restoreAll(); });

function view(server: ProjectLocalToolServer) {
  const elements: VNode<Record<string, unknown>>[] = [];
  const words: string[] = [];
  const visit = (child: ComponentChildren): void => {
    if (child == null || typeof child === 'boolean') return;
    if (Array.isArray(child)) { child.forEach(visit); return; }
    if (typeof child !== 'object') { words.push(String(child)); return; }
    const node = child as VNode<Record<string, unknown>>;
    elements.push(node);
    visit(node.props.children);
  };
  visit(ProjectToolServerStatus({ server }));
  return { text: words.join(' ').replace(/\s+/g, ' ').trim(), elements };
}

test('actual phone renderer distinguishes each readiness state with the shared human label', () => {
  for (const [state, label, connected, warning] of [
    ['unconfigured', 'Setup needed', false, false], ['disabled', 'Turned off', false, false],
    ['needs_credentials', 'Access details needed', false, true], ['connecting', 'Connecting', false, false],
    ['connected', 'Connected in Clem', true, false], ['unavailable', 'Connection needs attention', false, true],
    ['not_checked', 'Not checked', false, false],
  ] as const) {
    const result = view({ name: 'fixture-service', connected, state });
    assert.equal(result.text, `fixture-service ${label}`);
    const item = result.elements[0]!;
    assert.equal(item.props.role, 'listitem');
    assert.equal(String(item.props.class).includes('is-connected'), connected);
    assert.equal(String(item.props.class).includes('is-missing'), warning);
    assert.ok(item.props.title);
    assert.doesNotMatch(result.text, /needs_credentials|not_checked|unconfigured/);
  }
  assert.deepEqual(fetches, [], 'rendering never performs a connection probe');
});

test('legacy or contrary markers remain unchecked and omit unqualified tool counts', () => {
  for (const server of [{ name: 'legacy', connected: true, toolCount: 4 },
    { name: 'contrary', connected: false, state: 'connected' as const, toolCount: 4 }]) {
    const result = view(server);
    assert.match(result.text, /Not checked$/);
    assert.doesNotMatch(result.text, /4 tools|Connected in Clem/);
    assert.equal(String(result.elements[0]!.props.class).includes('is-connected'), false);
  }
  assert.match(view({ name: 'fixture', connected: true, state: 'connected', toolCount: 2 }).text, /Connected in Clem · 2 tools$/);
});

test('long tool identities remain complete with wrapping and the actual project row mounts this renderer', () => {
  const name = 'fixture-service-with-a-long-complete-project-tool-identity'.repeat(2);
  const result = view({ name, connected: false, state: 'connecting' });
  assert.ok(result.text.startsWith(name));
  assert.deepEqual(result.elements[0]!.props.style, { flexWrap: 'wrap' });
  assert.ok(result.elements.some(node => (node.props.style as { overflowWrap?: string } | undefined)?.overflowWrap === 'anywhere'));
  const source = readFileSync(new URL('./Project.tsx', import.meta.url), 'utf8');
  assert.match(source, /<ProjectToolServerStatus key=\{server\.name\} server=\{server\} \/>/);
  assert.match(source, /\{PROJECT_LOCAL_TOOL_SERVERS_HINT\}/);
  assert.match(String(view({ name: 'fixture', connected: true, state: 'connected' }).elements[0]!.props.title), /service and account/);
});
