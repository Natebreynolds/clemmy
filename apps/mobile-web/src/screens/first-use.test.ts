import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as chatList from '../lib/chat-list';
import { MobileChatLocationStore } from '../lib/chat-location';

type Element = { type: unknown; props: Record<string, any> };
const element = (type: unknown, props: Record<string, any>): Element => ({ type, props });
function nodes(tree: any): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return tree && typeof tree === 'object' && tree.props ? [tree, ...nodes(tree.props.children)] : [];
}
function moduleAt(relative: string, dependencies: Record<string, any>) {
  const code = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, jsxImportSource: 'preact',
  } }).outputText;
  const exports: Record<string, any> = {};
  runInNewContext(code, { exports, require(name: string) { assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name]; } });
  return exports;
}

test('the login recovery button retries only when its exact retained attempt is supplied', () => {
  let retries = 0;
  const Login = moduleAt('./Login.tsx', {
    'preact/hooks': { useState: (initial: any) => [initial, () => {}], useEffect() {} },
    'preact/jsx-runtime': { jsx: element, jsxs: element },
    '../lib/native-bridge': { inNativeShell: () => false, requestNativeRepair: () => assert.fail('rendering must not reset pairing') },
  }).Login;
  const button = nodes(Login({ pairError: 'Connection interrupted.', onRetryPair: () => retries++ }))
    .find(node => node.type === 'button' && node.props.children === 'Try pairing again');
  assert.ok(button); assert.equal(retries, 0);
  button.props.onClick(); assert.equal(retries, 1);
  const waiting = nodes(Login({ pairError: 'Wait before retrying.', onRetryPair: () => retries++, retryAt: Date.now() + 60_000 }))
    .find(node => node.type === 'button');
  assert.equal(waiting?.props.disabled, true);
  assert.match(waiting?.props.children, /^Try again in /);
  assert.equal(nodes(Login({ pairError: 'The code expired.' })).filter(node => node.type === 'button').length, 0);
});

test('empty chats offer a useful editable start while an empty archive keeps the right context', () => {
  const cells: any[] = [];
  let cursor = 0;
  const useState = (initial: any) => {
    const index = cursor++;
    if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
    return [cells[index], (next: any) => { cells[index] = typeof next === 'function' ? next(cells[index]) : next; }];
  };
  const hooks = { useState, useRef: (initial: any) => { const [cell] = useState({ current: initial }); return cell; }, useEffect() {}, useLayoutEffect() {} };
  const Chats = moduleAt('./Chats.tsx', {
    'preact/hooks': hooks, 'preact/jsx-runtime': { jsx: element, jsxs: element },
    '@clem/chat-engine': { chatHasNews: () => false, chatSeenBaseline: () => ({}), markChatSeen() {} },
    '../lib/back-gesture': { useBackGesture() {} },
    '../lib/api': { listChatSessions: () => assert.fail('rendering does not request work'), patchChatSession: () => assert.fail('starting a draft does not mutate a conversation') },
    '../lib/chat-list': chatList, '../components/ChatStateMark': { ChatStateMark: 'ChatStateMark' },
    '../lib/chat-swipe': {}, '../components/Sheet': { Sheet: 'Sheet' },
    '../lib/native-bridge': { haptic() {} }, './Chat': { Chat: 'Chat' },
    '../components/Approvals': { relativeTime: () => 'now' }, '../components/ScreenNotice': { ScreenNotice: 'ScreenNotice' },
    '../lib/use-screen-data': { useScreenData: () => ({ data: { sessions: [] }, loading: false, error: null, offline: false, refresh() {} }) },
    '../lib/file-context': { newMobileDraftScope: () => 'new:controlled-starter' },
    '../lib/chat-location': { mobileChatLocation: new MobileChatLocationStore() },
  }).Chats;
  const render = () => { cursor = 0; return Chats({}); };
  const button = (tree: any, text: string) => nodes(tree).find(node => node.type === 'button' && node.props.children === text)!;
  let tree = render();
  assert.ok(button(tree, 'Start with a plan'));
  button(tree, 'Show archived').props.onClick(); tree = render();
  assert.ok(nodes(tree).some(node => node.props.children === 'No archived conversations'));
  assert.equal(button(tree, 'Start with a plan'), undefined);
  button(tree, 'Back to conversations').props.onClick(); tree = render();
  button(tree, 'Start with a plan').props.onClick(); tree = render();
  assert.equal(tree.type, 'Chat');
  assert.equal(tree.props.draftScope, 'new:controlled-starter');
  assert.match(tree.props.initialDraft, /Ask me what I want to achieve/);
  assert.equal(tree.props.initialAutoSend, false, 'a suggested start stays editable until the owner sends it');
});
