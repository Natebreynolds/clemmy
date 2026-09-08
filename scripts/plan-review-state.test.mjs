import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const ref = { planId: 'plan-review-fixture', revision: 2, digest: 'a'.repeat(64) };
const response = { artifact: { version: 1, ...ref, sessionId: 'session-review', fullText: 'Complete plan including its final paragraph.', readiness: 'ready', missingPrerequisites: [], createdAt: '2026-09-05' }, latest: ref };

// Execute the real component's hooks, async API boundaries, and element handlers.
// Layout and markdown sanitization belong to the browser/shared-renderer tests.
async function mount(surface, api, onExecute) {
  const state = [], effects = [];
  let position = 0, dirty = true, tree;
  const queued = [];
  const harness = {
    useState(initial) {
      const index = position++;
      if (!(index in state)) state[index] = initial;
      return [state[index], value => {
        const next = typeof value === 'function' ? value(state[index]) : value;
        if (!Object.is(next, state[index])) { state[index] = next; dirty = true; }
      }];
    },
    useEffect(callback, deps) {
      const index = position++;
      if (!effects[index] || deps.some((value, i) => !Object.is(value, effects[index].deps[i]))) {
        const previous = effects[index];
        effects[index] = { deps };
        queued.push(() => { previous?.cleanup?.(); effects[index].cleanup = callback(); });
      }
    },
    jsx(type, props) { return { type, props }; },
    api,
  };
  const desktop = surface === 'desktop';
  const compiled = await build({
    entryPoints: [path.join(root, desktop ? 'apps/console-web/src/components/chat/PlanReview.tsx' : 'apps/mobile-web/src/components/PlanReview.tsx')],
    bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', jsxImportSource: desktop ? 'react' : 'preact',
    plugins: [{ name: 'component-boundaries', setup(builder) {
      builder.onResolve({ filter: /^(react|preact\/hooks|react\/jsx-runtime|preact\/jsx-runtime)$/ }, args => ({ path: args.path, namespace: 'hooks' }));
      builder.onLoad({ filter: /.*/, namespace: 'hooks' }, () => ({ contents: 'export const useState = (...a) => globalThis.__review.useState(...a); export const useEffect = (...a) => globalThis.__review.useEffect(...a); export const jsx = (...a) => globalThis.__review.jsx(...a); export const jsxs = jsx; export const Fragment = "fragment";' }));
      builder.onResolve({ filter: /^(?:@\/lib\/api|\.\.\/lib\/api)$/ }, args => ({ path: args.path, namespace: 'api' }));
      builder.onLoad({ filter: /.*/, namespace: 'api' }, () => ({ contents: 'export const api = (...a) => globalThis.__review.api(...a); export const apiGet = api;' }));
      builder.onResolve({ filter: /^(?:@clem\/chat-engine|@\/lib\/task-mode)$/ }, args => ({ path: args.path, namespace: 'mode' }));
      builder.onLoad({ filter: /.*/, namespace: 'mode' }, () => ({ contents: `export * from ${JSON.stringify(path.join(root, 'packages/chat-engine/src/task-mode.ts'))}; export const renderMarkdown = value => value;`, resolveDir: root }));
      builder.onResolve({ filter: /packages\/chat-engine\/src\/markdown$/ }, args => ({ path: args.path, namespace: 'markdown' }));
      builder.onLoad({ filter: /.*/, namespace: 'markdown' }, () => ({ contents: 'export const renderMarkdown = value => value;' }));
    } }],
  });
  const context = { module: { exports: {} }, URLSearchParams, Error, __review: harness };
  vm.runInNewContext(compiled.outputFiles[0].text, context);
  const props = { planRef: ref, sessionId: 'session-review', busy: false, onExecute };
  const flush = async () => {
    for (let attempts = 0; attempts < 30; attempts++) {
      if (dirty) { dirty = false; position = 0; tree = context.module.exports.PlanReview(props); }
      while (queued.length) queued.shift()();
      await new Promise(resolve => setImmediate(resolve));
      if (!dirty && queued.length === 0) return;
    }
    throw new Error('Component state did not settle');
  };
  await flush();
  return { flush, get tree() { return tree; } };
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree && typeof tree === 'object') return text(tree.props?.children);
  return tree == null || typeof tree === 'boolean' ? '' : String(tree);
}
function button(view, label) { return nodes(view.tree).find(node => node.type === 'button' && text(node) === label); }

for (const surface of ['desktop', 'mobile']) {
  test(`${surface} preserves Execute refusal through automatic artifact reload, then explicit Reload clears it`, async () => {
    let requests = 0;
    const calls = [];
    const view = await mount(surface, async () => { requests++; return response; }, async selected => {
      calls.push(selected);
      throw new Error('Retry or cancel the unconfirmed request before sending a different one.');
    });
    assert.equal(button(view, 'Execute plan').props.disabled, false);
    button(view, 'Execute plan').props.onClick();
    await view.flush();
    assert.equal(requests, 2, 'refreshes current revision after the refusal');
    assert.equal(JSON.stringify(calls), JSON.stringify([ref]), 'uses only the reviewed exact revision');
    assert.match(text(nodes(view.tree).find(node => node.props?.role === 'alert')), /Retry or cancel the unconfirmed request/);
    assert.equal(nodes(view.tree).find(node => node.props?.['data-full-plan']).props.dangerouslySetInnerHTML.__html, response.artifact.fullText);
    button(view, 'Reload').props.onClick();
    await view.flush();
    assert.equal(requests, 3);
    assert.equal(nodes(view.tree).some(node => node.props?.role === 'alert'), false);
  });
  test(`${surface} refreshes a successful Execute into a disabled claimed revision`, async () => {
    let accepted = false;
    const view = await mount(surface, async () => ({ ...response, ...(accepted ? { execution: { executionRunId: 'run-exact' } } : {}) }), async () => { accepted = true; });
    button(view, 'Execute plan').props.onClick();
    await view.flush();
    assert.equal(button(view, 'Execute plan').props.disabled, true);
    assert.match(text(view.tree), /Execution requested/);
    assert.doesNotMatch(text(view.tree), /completed/i);
  });
  test(`${surface} a failed artifact load shows unavailable, not a permanent loading status`, async () => {
    const view = await mount(surface, async () => { throw new Error('Offline'); }, async () => {});
    assert.match(text(view.tree), /Plan unavailable/);
    assert.doesNotMatch(text(view.tree), /Loading plan/);
    assert.equal(button(view, 'Execute plan'), undefined);
    assert.match(text(nodes(view.tree).find(node => node.props?.role === 'alert')), /Offline/);
  });
}
