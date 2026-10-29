import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { MobileDraftStore } from '../lib/file-context';

type Element = { type: unknown; props: Record<string, any> };
const element = (type: unknown, props: Record<string, any>): Element => ({ type, props });
function nodes(tree: any): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return tree && typeof tree === 'object' && tree.props ? [tree, ...nodes(tree.props.children)] : [];
}

function harness(store: MobileDraftStore, send: (...args: any[]) => void) {
  const cells: any[] = [];
  const effects: Array<() => void> = [];
  const cleanups: Array<() => void> = [];
  let cursor = 0;
  let effectsRun = false;
  const useState = (initial: any) => {
    const index = cursor++;
    if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
    return [cells[index], (next: any) => { cells[index] = typeof next === 'function' ? next(cells[index]) : next; }];
  };
  const hooks = { useState, useRef: (initial: any) => { const [ref] = useState({ current: initial }); return ref; },
    useEffect: (run: () => (() => void) | void) => { if (!effectsRun) effects.push(() => { const cleanup = run(); if (cleanup) cleanups.push(cleanup); }); } };
  const code = ts.transpileModule(readFileSync(new URL('./AskCapsule.tsx', import.meta.url), 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, jsxImportSource: 'preact',
  } }).outputText;
  const dependencies: Record<string, any> = {
    'preact/hooks': hooks, 'preact/jsx-runtime': { jsx: element, jsxs: element },
    './Composer': { Composer: 'Composer' }, '../lib/file-context': { mobileDrafts: store },
    '../lib/api': { uploadChatAttachment: () => assert.fail('draft navigation does not upload or send') },
  };
  const exports: Record<string, any> = {};
  runInNewContext(code, { exports, require(name: string) { assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name]; } });
  return {
    render() {
      cursor = 0;
      const tree = exports.AskCapsule({ onAsk: send });
      if (!effectsRun) { effectsRun = true; effects.forEach(run => run()); }
      return nodes(tree).find(node => node.type === 'Composer')!.props;
    },
    unmount() { cleanups.forEach(cleanup => cleanup()); },
  };
}

test('hiding the quick composer for a workflow and returning keeps its exact text and staged files', () => {
  const revoked: string[] = [];
  const store = new MobileDraftStore(url => revoked.push(url));
  const sent: unknown[] = [];
  const first = harness(store, (...args) => sent.push(args));
  let composer = first.render();
  composer.onChange('FRAMEWORK-TEST · Keep this unsent phone draft.');
  const scope = composer.attachmentScope;
  assert.equal(typeof scope, 'string');
  store.patch(scope, { stagedAttachments: [{ id: 'upload-one', name: 'Notes.txt', kind: 'file' }] });
  composer = first.render();
  assert.equal(composer.value, 'FRAMEWORK-TEST · Keep this unsent phone draft.');
  first.unmount();
  const returned = harness(store, (...args) => sent.push(args));
  const restored = returned.render();
  assert.equal(restored.value, composer.value);
  assert.equal(restored.attachmentScope, scope);
  assert.equal(store.read(restored.attachmentScope).stagedAttachments?.[0].id, 'upload-one');
  assert.deepEqual(sent, [], 'navigation does not create or send a chat');
  assert.deepEqual(revoked, []);
  returned.unmount();
});

test('a hidden quick-composer upload can settle in its original scope without entering a conversation draft', () => {
  const store = new MobileDraftStore(() => {});
  const first = harness(store, () => assert.fail('an upload completion must not send'));
  const props = first.render();
  props.onChange('Keep this while I look at Work.');
  store.patch(props.attachmentScope, { stagedAttachments: [{ id: 'upload-local', name: 'Image.png', kind: 'image', uploading: true, previewUrl: 'blob:preview' }] });
  store.patch('chat:separate', { text: 'A different conversation draft' });
  const generation = store.generation;
  first.unmount();
  store.patchInGeneration(props.attachmentScope, generation, { stagedAttachments: [{ id: 'upload-ready', name: 'Image.png', kind: 'image', previewUrl: 'blob:preview', uploading: false }] });
  const returned = harness(store, () => assert.fail('remounting must not send'));
  const restored = returned.render();
  assert.equal(restored.value, 'Keep this while I look at Work.');
  assert.equal(store.read(restored.attachmentScope).stagedAttachments?.[0].id, 'upload-ready');
  assert.equal(store.read('chat:separate').text, 'A different conversation draft');
  returned.unmount();
});

test('confirmed sign-out clears the capsule and old callbacks cannot restore the former account’s draft', () => {
  const store = new MobileDraftStore(() => {});
  const first = harness(store, () => assert.fail('sign-out must not send'));
  const previous = first.render();
  previous.onChange('Old account draft');
  store.clear();
  previous.onChange('Late old callback');
  first.unmount();
  const next = harness(store, () => assert.fail('new login must not send'));
  assert.equal(next.render().value, '');
  next.unmount();
});
