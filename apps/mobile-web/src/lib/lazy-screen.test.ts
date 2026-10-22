import assert from 'node:assert/strict';
import { test } from 'node:test';
import { h, type FunctionComponent, type VNode } from 'preact';
import { deferredScreen } from './lazy-screen';

type Props = { selectedId: string; onOpen: (id: string) => void };
const Target: FunctionComponent<Props> = ({ selectedId }) => h('p', null, selectedId);

// Exercise the real Preact lazy component without mounting an authenticated app.
function child(screen: FunctionComponent<Props>, props: Props) {
  const vnode = screen(props) as VNode<Props>;
  assert.equal(typeof vnode.type, 'function');
  return () => (vnode.type as FunctionComponent<Props>)(vnode.props);
}

function suspended(render: () => unknown): Promise<unknown> {
  try { render(); } catch (error) {
    assert.ok(error instanceof Promise, 'an unloaded screen suspends');
    return error;
  }
  assert.fail('expected suspension');
}

test('screen loading starts on first use and shares one in-flight request', async () => {
  let calls = 0;
  let resolve!: (value: { default: typeof Target }) => void;
  const screen = deferredScreen(() => {
    calls++;
    return new Promise<{ default: typeof Target }>(done => { resolve = done; });
  });
  assert.equal(calls, 0);
  const render = child(screen.Component, { selectedId: 'project-1', onOpen: () => {} });
  assert.equal(calls, 0, 'creating the wrapper does not fetch a destination');
  const first = suspended(render);
  assert.equal(suspended(render), first);
  assert.equal(calls, 1);
  resolve({ default: Target });
  await first;
  assert.equal((render() as VNode).type, Target);
  assert.equal(calls, 1);
});

test('a resolved screen receives current deep-link props and original callbacks', async () => {
  const screen = deferredScreen(async () => ({ default: Target }));
  const onOpen = (_id: string) => {};
  await suspended(child(screen.Component, { selectedId: 'project-1', onOpen }));
  const updated = child(screen.Component, { selectedId: 'project-2', onOpen })() as VNode<Props>;
  assert.equal(updated.type, Target);
  assert.equal(updated.props.selectedId, 'project-2');
  assert.equal(updated.props.onOpen, onOpen);
});

test('retry replaces a rejected lazy loader and preserves destination props', async () => {
  let calls = 0;
  const offline = new Error('offline');
  const screen = deferredScreen(async () => {
    if (++calls === 1) throw offline;
    return { default: Target };
  });
  const props = { selectedId: 'space-7', onOpen: (_id: string) => {} };
  const failed = child(screen.Component, props);
  await assert.rejects(suspended(failed), error => error === offline);
  assert.throws(failed, error => error === offline);
  assert.equal(calls, 1, 'a failed Preact lazy loader retains its error');

  const stableWrapper = screen.Component;
  screen.retry();
  assert.equal(screen.Component, stableWrapper, 'the enclosing shell need not reload');
  const retried = child(screen.Component, props);
  await suspended(retried);
  const result = retried() as VNode<Props>;
  assert.equal(calls, 2);
  assert.equal(result.type, Target);
  assert.equal(result.props.selectedId, props.selectedId);
  assert.equal(result.props.onOpen, props.onOpen);
});
