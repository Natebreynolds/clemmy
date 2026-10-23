// Exercise the actual AgentWorkspace question callback with isolated, inert transports.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as engine from '@clem/chat-engine';
import { chatAnswerInput, type ChatMessage } from '../lib/useChat';
import { historyToMessages } from '../features/conversations/chat/conversation-history';

type Element = { type: unknown; props: Record<string, any> };
function mount(messages: ChatMessage[], composerMode: 'plan' | 'normal' = 'normal') {
  let release!: () => void;
  const prepared = new Promise<void>(resolve => { release = resolve; });
  const calls = { sends: [] as any[], agent: 0, project: 0, scope: 0, execute: [] as any[] };
  const chat = { messages, busy: false, composerMode, delegatedTaskTick: 0,
    sessionId: { current: 'controlled-agent-option' }, conversationSessionId: { current: 'controlled-agent-option' },
    send: async (input: any) => { calls.sends.push(JSON.parse(JSON.stringify(input))); },
    executePlan: (ref: any) => { calls.execute.push(ref); }, reset() {}, setComposerMode() {},
    preparePlan() {}, background() {}, sendHeld() {}, stop() {}, retryPending() {}, cancelPending() {},
  };
  const element = (type: unknown, props: Record<string, any>, key?: string): Element => ({ type, props: { ...props, key } });
  const dependencies: Record<string, any> = {
    react: { Fragment: 'fragment', useRef: (value: any) => ({ current: value }), useEffect() {} },
    'react/jsx-runtime': { jsx: element, jsxs: element },
    '@tanstack/react-query': { useQueryClient: () => ({ invalidateQueries() {} }) },
    'react-router-dom': { useNavigate: () => () => {}, useLocation: () => ({ key: 'controlled-agent-route' }) },
    'lucide-react': {}, '@clem/chat-engine': engine,
    '@/lib/useChat': { chatAnswerInput },
    '@/lib/conversation-agent': { useConversationAgent: () => ({ chosen: null, async prepare() {
      calls.agent++; await prepared; return { agentId: 'controlled-agent' };
    } }) },
    '@/lib/conversation-project': { useConversationProject: () => ({ chosen: null, choose() {}, async prepare() {
      calls.project++; await prepared; return { projectId: 'controlled-project' };
    } }) },
    '@/lib/conversation-tasks': { reportOwner: () => null,
      useConversationTasks: () => ({ tasks: [], cards: [], ownedIds: new Set(), refresh() {} }) },
    '@/lib/use-conversation-send-scope': { useConversationSendScope: () => () => ({
      assertCurrent() { calls.scope++; }, isCurrentRoute: () => true,
    }) },
    '@/features/conversations/hooks/keys': { sessionKeys: { lists: () => ['sessions', 'lists'] } },
    '@/features/conversations/lib/chatColumn': { CHAT_THREAD: '', CHAT_COMPOSER_WRAP: '' },
    '@/lib/inbox': {}, '@/lib/last-session': {}, '@/lib/poll': {}, '@/lib/cn': {}, '@/lib/board': {}, '@/lib/agents': {},
    '@/features/conversations/hooks/useSessions': {}, '@/features/conversations/hooks/useSession': {},
    '@/features/conversations/lib/groupSessions': {}, '@/features/conversations/lib/ids': {},
    '@/features/conversations/chat/conversation-history': { historyToMessages },
  };
  for (const [path, name] of [
    ['ui/Button', 'Button'], ['ui/QueryUnavailable', 'QueryUnavailable'], ['ui/Skeleton', 'Skeleton'],
    ['chat/Composer', 'Composer'], ['chat/ChatBubble', 'ChatBubble'], ['chat/AgentPicker', 'AgentPicker'],
    ['chat/ProjectPicker', 'ProjectPicker'], ['chat/ConversationChangeLine', 'ConversationChangeLine'],
    ['chat/ConversationTasks', 'ConversationTasks'], ['chat/RunningTasksDrawer', 'RunningTasksDrawer'],
    ['agents/AgentForm', 'AgentForm'], ['agents/AgentAssignments', 'AgentAssignments'], ['memory/ScopedFacts', 'ScopedFacts'],
  ]) dependencies[`@/components/${path}`] = { [name]: name };
  // Existing McpManager.credentials.test.ts uses this same seam: compile the
  // actual module, expose its private component in memory, and invoke rendered
  // callbacks. No production function is copied or reimplemented.
  const source = readFileSync(new URL('./AgentWorkspace.tsx', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports: Record<string, any> = {};
  runInNewContext(`${code}\nexports.__threadBody = ThreadBody;`, { exports,
    require(name: string) { assert.ok(name in dependencies, `Unexpected production dependency: ${name}`); return dependencies[name]; },
  });
  const tree = exports.__threadBody({ agent: { id: 'controlled-agent', name: 'Controlled agent' }, chat,
    sessionId: 'desktop:controlled-agent-option' });
  const nodes: Element[] = [];
  const visit = (node: any) => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === 'object' && node.props) { nodes.push(node); visit(node.props.children); }
  };
  visit(tree);
  const bubbles = nodes.filter(node => node.type === 'ChatBubble');
  assert.equal(bubbles.length, messages.length);
  return { calls, chat, bubbles, release };
}
const question = (taskMode?: ChatMessage['taskMode']): ChatMessage => ({ id: 'controlled-question',
  role: 'assistant', text: 'Choose Amber or Violet.', status: 'awaiting-reply', ...(taskMode ? { taskMode } : {}) });

for (const restored of [false, true]) test(`AgentWorkspace ${restored ? 'restored' : 'live'} option snapshots originating Plan before preparation`, async () => {
  const messages = restored ? historyToMessages([{ role: 'assistant', text: 'Choose Amber or Violet.', createdAt: '2026-10-23T00:00:00Z',
    taskMode: { version: 1, kind: 'plan' } }]) : [question({ version: 1, kind: 'plan' })];
  const view = mount(messages, 'normal');
  const sent = view.bubbles.at(-1)!.props.onAnswer('Amber');
  assert.equal(view.calls.sends.length, 0, 'send waits for agent/project preparation');
  messages[0].taskMode = { version: 1, kind: 'normal' };
  view.release(); await sent;
  assert.equal(view.calls.sends.length, 1);
  assert.deepEqual(view.calls.sends[0], { text: 'Amber', attachmentIds: [], attachmentNames: [],
    taskMode: { version: 1, kind: 'plan' }, agentId: 'controlled-agent', projectId: 'controlled-project' });
  assert.deepEqual([view.calls.agent, view.calls.project, view.calls.scope], [1, 1, 1]);
});

test('AgentWorkspace generic answers preserve Normal but never infer unknown mode or repeat Execute admission', async () => {
  const ref = { planId: 'plan-controlled', revision: 2, digest: 'c'.repeat(64) };
  for (const mode of [{ version: 1, kind: 'normal' }, undefined, { version: 1, kind: 'execute', executeRef: ref }] as const) {
    const view = mount([question(mode)], 'plan');
    const sent = view.bubbles[0].props.onAnswer('Amber'); view.release(); await sent;
    assert.equal(view.calls.sends.length, 1);
    if (mode?.kind === 'normal') assert.deepEqual(view.calls.sends[0].taskMode, mode);
    else assert.equal(Object.hasOwn(view.calls.sends[0], 'taskMode'), false);
    assert.equal(view.bubbles[0].props.onExecutePlan, view.chat.executePlan, 'dedicated Execute remains its own path');
  }
});

test('AgentWorkspace connection continuation bypasses generic answer preparation and old questions are inactive', async () => {
  const view = mount([question({ version: 1, kind: 'plan' }), { ...question({ version: 1, kind: 'plan' }), id: 'current' }]);
  assert.equal(view.bubbles[0].props.onAnswer, undefined);
  const connectionResume = { connectionRequestId: 'controlled-connection', clientRequestId: 'controlled-request' };
  await view.bubbles[1].props.onAnswer('Continue', connectionResume);
  assert.deepEqual(view.calls.sends, [{ text: 'Continue', connectionResume }]);
  assert.deepEqual([view.calls.agent, view.calls.project, view.calls.scope], [0, 0, 0]);
});
