import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as homeStarter from '../lib/home-starter';
import * as workflowSetup from '../lib/workflow-setup';
import { MobileDraftStore } from '../lib/file-context';
import * as conversationLead from '../lib/conversation-lead';

type Element = { type: any; props: Record<string, any> };
const element = (type: any, props: Record<string, any>): Element => ({ type, props });
function nodes(tree: any): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return tree && typeof tree === 'object' && tree.props ? [tree, ...nodes(tree.props.children)] : [];
}
const text = (tree: any): string => Array.isArray(tree) ? tree.map(text).join(' ')
  : tree?.props ? text(tree.props.children) : typeof tree === 'string' ? tree : '';
const button = (tree: any, label: string) => nodes(tree).find(node => node.type === 'button' && text(node) === label);
function moduleAt(relative: string, dependencies: Record<string, any>) {
  const code = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, jsxImportSource: 'preact',
  } }).outputText;
  const exports: Record<string, any> = {};
  runInNewContext(code, { exports, window: { location: { search: '' }, setInterval() { return 1; }, clearInterval() {} },
    require(name: string) { assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name]; } });
  return exports;
}
function hookHarness() {
  const stores = new Map<string, any[]>();
  let cells: any[] = []; let cursor = 0;
  const useState = (initial: any) => {
    const index = cursor++;
    if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
    const owner = cells;
    return [cells[index], (next: any) => { owner[index] = typeof next === 'function' ? next(owner[index]) : next; }];
  };
  const effects: Array<() => void> = [];
  return {
    hooks: { useState, useRef: (initial: any) => { const [cell] = useState({ current: initial }); return cell; },
      useCallback: (fn: any) => fn, useEffect: (effect: () => void) => { effects.push(effect); }, useLayoutEffect() {} },
    render(fn: any, props: any, key = 'default'): Element {
      cells = stores.get(key) ?? []; stores.set(key, cells); cursor = 0; effects.length = 0;
      return fn(props);
    },
    effects,
  };
}
const fresh = (data: any) => ({ data, loading: false, refreshing: false, stale: false, updatedAt: 1, error: null, offline: false, async refresh() {} });

test('Home waits for all sources, starts an editable request, and restores ordinary content after failed or populated reads', async () => {
  const harness = hookHarness();
  const reads = { home: fresh(null), fromClem: fresh({ rows: [] }), recent: fresh({ sessions: [] }) };
  let readHome!: () => Promise<any>;
  let failReminder = false;
  const noWrite = () => assert.fail('a starter must not send, run, or mutate work');
  const api = { listApprovals: async () => ({ approvals: [] }), listPlanProposals: async () => ({ proposals: [] }),
    listWorkspaceDestinationChoosers: async () => ({ choosers: [] }), listInboxQuestions: async () => ({ questions: [] }),
    listInboxNotifications: async () => ({ notifications: [] }), getReminders: async () => { if (failReminder) throw Error('Reminder read failed'); return { items: [] }; },
    answerInboxQuestion: noWrite, resolveWorkspaceDestinationChooser: noWrite, runWorkflow: noWrite, markInboxNotificationRead: noWrite };
  const Home = moduleAt('./Home.tsx', {
    'preact/hooks': harness.hooks, 'preact/jsx-runtime': { jsx: element, jsxs: element },
    '@clem/chat-engine': { presentWorkingNow: () => ({ entries: [], running: 0, needsYou: 0, stalled: 0, total: 0 }), chatSeenBaseline: () => ({}), chatHasNews: () => false },
    '../lib/api': api, '../lib/greeting': { greetingName: () => '', timeGreeting: () => 'Good morning' },
    '../lib/today': { shouldShowDigest: () => false, todayRows: () => [], todayDigest: () => '' },
    '../components/Approvals': { relativeTime: () => 'now' }, '../components/PushPrompt': { PushPrompt: 'PushPrompt' },
    '../components/ScreenNotice': { ScreenNotice: 'ScreenNotice' }, '../lib/native-bridge': { haptic() {} },
    '../lib/use-screen-data': { useScreenData: (load: any, options: any) => {
      if (options.resourceKey === 'home-from-clem') return reads.fromClem;
      if (options.resourceKey === 'home-recent') return reads.recent;
      readHome = load; return reads.home;
    } },
    '../lib/inbox-presentation': {}, '../lib/home-presentation': {
      homeLead: () => ({ tone: 'clear', headline: 'All clear', detail: 'Nothing needs you and nothing is running.', action: null }),
      homeNeedsYouPane: () => ({ show: false }),
    },
    '../lib/home-prefs': { useHomePreferences: () => ({ prefs: { quickActions: [], panes: { hidden: [] } }, loaded: true, error: null }), phoneVisiblePanes: () => ['needs_you', 'while_away', 'projects'] },
    '../lib/working-now': { useWorkingNow: () => ({ data: { entries: [] }, known: true, error: null, offline: false }) },
    '../lib/conversation-lead': conversationLead,
    '../components/ChatStateMark': {}, '../components/HomeTiles': { HomeTiles: 'HomeTiles' }, '../components/FromClem': { FromClem: 'FromClem' },
    '../components/Glyph': {}, '../components/MissedRuns': { MissedRuns: 'MissedRuns' }, '../lib/home-starter': homeStarter,
  }).Home;
  let prepared = ''; let opened = ''; const props = { name: '', onAsk: noWrite, onPrepareRequest: (draft: string) => { prepared = draft; }, onOpenChat: (session: any) => { opened = session.id; },
    needsYouCount: 0, needsYouCountKnown: true, needsYouCountLive: true, needsYouCountAge: null };
  const render = () => harness.render(Home, props);
  let tree = render();
  assert.equal(button(tree, 'Prepare a weekly brief'), undefined);
  nodes(tree).find(node => node.type === 'HomeTiles')!.props.onEmptyChange(true);
  reads.home = fresh(await readHome()); tree = render();
  assert.equal(nodes(tree).some(node => node.props.class === 'home-business-request'), false, 'missed runs must also finish reading');
  nodes(tree).find(node => node.type === 'MissedRuns')!.props.onEmptyChange(true); tree = render();
  const start = nodes(tree).find(node => node.props.class === 'home-business-request');
  assert.ok(start); assert.equal(nodes(tree).some(node => node.type === 'PushPrompt'), false);
  assert.equal(nodes(tree).find(node => node.type === 'HomeTiles')!.props.hideConfirmedEmpty, true);
  start.props.onClick(); assert.equal(prepared, homeStarter.WEEKLY_BRIEF_REQUEST);
  assert.doesNotMatch(text(tree), /Nothing running right now/);
  failReminder = true; reads.home = fresh(await readHome()); tree = render();
  assert.equal(nodes(tree).some(node => node.props.class === 'home-business-request'), false, 'one failed source cannot certify first use');
  assert.equal(nodes(tree).some(node => node.type === 'PushPrompt'), true);
  failReminder = false; reads.home = fresh(await readHome());
  reads.fromClem = { ...reads.fromClem, stale: true, error: 'Connection interrupted' } as any; tree = render();
  assert.equal(nodes(tree).some(node => node.props.class === 'home-business-request'), false);
  reads.fromClem = fresh({ rows: [{ id: 'real-update', asks: false }] }); tree = render();
  assert.equal(nodes(tree).some(node => node.props.class === 'home-business-request'), false);
  assert.equal(nodes(tree).find(node => node.type === 'FromClem' && node.props.mode === 'updates')!.props.data.rows[0].id, 'real-update');
  const hour = 60 * 60_000; const now = Date.now();
  reads.recent = fresh({ sessions: [
    { id: 'newer-ordinary', kind: 'chat', title: 'Ordinary conversation', updatedAt: now - hour },
    { id: 'fresh-ask', kind: 'chat', title: 'Choose the brief audience', updatedAt: now - 2 * hour, waitingOnYou: { question: 'Who is it for?' } },
    { id: 'old-ask', kind: 'chat', title: 'Three-day-old request', updatedAt: now - 72 * hour, waitingOnYou: { question: 'Old request?' } },
  ] }) as any;
  tree = render();
  const recentRows = nodes(tree).filter(node => node.type === 'button' && node.props.class === 'home-row home-row-tap');
  assert.match(text(recentRows[0]), /Choose the brief audience.*Waiting on your answer/);
  assert.match(text(recentRows[1]), /Ordinary conversation/);
  assert.doesNotMatch(text(tree), /Three-day-old request/);
  recentRows[0].props.onClick(); assert.equal(opened, 'fresh-ask', 'the prioritized request opens its exact conversation');
});

test('a pending, failed, or superseded missed-run read never certifies an empty Home', async () => {
  const harness = hookHarness();
  let resolve!: (value: any) => void; let reject!: (error: Error) => void;
  const MissedRuns = moduleAt('../components/MissedRuns.tsx', {
    './missed-runs.css': {}, 'preact/hooks': harness.hooks, 'preact/jsx-runtime': { jsx: element, jsxs: element },
    '../lib/api': {}, '../lib/native-bridge': {}, '../lib/workflow-widget': {},
    '../lib/missed-runs': { getMissedRuns: () => new Promise((yes, no) => { resolve = yes; reject = no; }) },
  }).MissedRuns;
  const statuses: boolean[] = []; const props = { onEmptyChange: (empty: boolean) => statuses.push(empty) };
  harness.render(MissedRuns, props); harness.effects[0]();
  assert.equal(statuses.length, 0, 'no callback while the first read is pending');
  reject(Error('Unavailable')); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(statuses, [false]);
  harness.render(MissedRuns, props); const cleanup = harness.effects[0]() as unknown as () => void;
  cleanup(); resolve({ notices: [] }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(statuses, [false, false], 'an unmounted reader invalidates its certificate and a late response cannot enable the starter');
  harness.render(MissedRuns, props); harness.effects[0]();
  resolve({ notices: [] }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(statuses, [false, false, true]);
});

test('HomeTiles removes only a confirmed empty scaffold and reappears for pins, unknown data, and failed refresh', () => {
  const harness = hookHarness();
  let layout = fresh({ layout: { revision: 1, tiles: [] } }); let spaces = fresh({ workspaces: [] });
  const HomeTiles = moduleAt('../components/HomeTiles.tsx', {
    'preact/hooks': harness.hooks, 'preact/jsx-runtime': { jsx: element, jsxs: element },
    '../lib/api': {}, '../lib/use-screen-data': { useScreenData: (_load: any, options: any) => options.resourceKey === 'home-layout' ? layout : spaces },
    '../lib/native-bridge': { haptic() {} }, '../lib/home-starter': homeStarter,
  }).HomeTiles;
  let empty: boolean | undefined; const props = { hideConfirmedEmpty: true, onEmptyChange: (value: boolean) => { empty = value; } };
  const render = () => { const tree = harness.render(HomeTiles, props); harness.effects.forEach(effect => effect()); return tree; };
  assert.equal(render(), null); assert.equal(empty, true);
  layout = fresh(null); assert.ok(render()); assert.equal(empty, false);
  layout = { ...fresh({ layout: { revision: 1, tiles: [] } }), stale: true, error: 'Read failed' } as any;
  assert.match(text(render()), /Pinned Spaces could not be loaded/); assert.equal(empty, false);
  layout = fresh({ layout: { revision: 2, tiles: [{ spaceId: 'exact-space' }] } }) as any;
  spaces = fresh({ workspaces: [{ id: 'exact-space', title: 'Owner brief', status: 'active' }] }) as any;
  assert.match(text(render()), /Owner brief/); assert.equal(empty, false);
});

test('Finish setup targets the exact scoped conversation and preserves unfinished files, draft, and retry authority without a POST', () => {
  const harness = hookHarness(); const drafts = new MobileDraftStore();
  const noWrite = () => assert.fail('navigation does not create a session, save setup, or run work');
  const workflow = { name: 'saved-exact', description: 'Weekly brief', enabled: false, resourceGaps: ['owner-account', 'brief-folder'] };
  const info = { name: 'saved-exact', slug: 'exact-canonical', description: 'Weekly brief', enabled: false,
    inputs: [{ key: 'recipient', description: 'Who receives the brief?', required: true }], steps: [] };
  let detail = fresh({ kind: 'ready', info, widgetRow: null });
  const Workflows = moduleAt('./Workflows.tsx', {
    'preact/hooks': harness.hooks, 'preact/jsx-runtime': { jsx: element, jsxs: element },
    '@clem/chat-engine': { workflowDisplayName: (name: string) => name, workflowCaption: () => '', workflowConversationSessionId: (slug: string) => `workflow:${slug}`, renderMarkdown: (value: string) => value },
    '../lib/api': { runWorkflow: noWrite }, '../lib/workflow-status': { workflowRowStatus: () => ({ key: 'off', label: 'Off' }) },
    '../lib/back-gesture': { useBackGesture() {} }, '../components/ChatBackButton': { ChatBackButton: 'Back' },
    '../lib/mobile-navigation': { useMobileDetailHeader() {} }, '../components/RunControl': { RunControl: 'RunControl' },
    '../components/ScreenNotice': { ScreenNotice: 'ScreenNotice' }, '../lib/native-bridge': { haptic() {} }, '../lib/run-rows': {},
    '../components/Approvals': { relativeTime: () => 'now' },
    '../lib/use-screen-data': { useScreenData: (_load: any, options: any) => options?.resourceKey?.startsWith('workflow:') ? detail
      : options?.resourceKey === 'workflow-list' ? fresh({ workflows: [workflow] }) : fresh({ runs: [] }) },
    '../lib/workflow-run-detail': {}, '../lib/schedule-label': { whenLabel: () => 'On demand' },
    '../lib/pending-commit': { usePendingCommit: () => ({ begin: noWrite }) }, '../lib/workflow-run-receipt': {},
    './Chat': { Chat: 'Chat' }, '../components/EmptyState': { EmptyState: 'EmptyState' },
    '../lib/widget-bridge': { widgetWorkflowAvailable: () => false }, '../lib/workflow-widget': { workflowWidgetTarget: () => null },
    '../lib/file-context': { mobileDrafts: drafts }, '../lib/workflow-setup': workflowSetup,
  }).Workflows;
  let list = harness.render(Workflows, { onAsk: noWrite }, 'list');
  nodes(list).find(node => node.props.class === 'workflow-row')!.props.onClick();
  list = harness.render(Workflows, { onAsk: noWrite }, 'list');
  const render = () => harness.render(list.type, list.props, 'detail');
  const scope = 'chat:workflow:exact-canonical';
  const files = [{ id: 'waiting-file', name: 'My report', kind: 'file' as const }];
  const failed = { messageId: 'retained-retry', text: 'My existing draft', attachmentIds: ['waiting-file'] };
  drafts.patch(scope, { text: 'My existing draft', stagedAttachments: files, failed });
  drafts.patch('capsule:ask', { text: 'An unrelated capsule draft' });
  let tree = render();
  assert.equal(button(tree, 'Finish setup with Clem')!.props.disabled, false);
  assert.equal(button(tree, 'Automation disabled')!.props.disabled, true);
  detail = { ...detail, refreshing: true }; tree = render();
  assert.equal(button(tree, 'Finish setup with Clem')!.props.disabled, true);
  button(tree, 'Finish setup with Clem')!.props.onClick();
  assert.equal(drafts.read(scope).text, 'My existing draft', 'an in-flight definition cannot supply setup context');
  detail = { ...detail, refreshing: false, stale: true, error: 'Refresh failed' } as any; tree = render();
  assert.equal(button(tree, 'Finish setup with Clem')!.props.disabled, true);
  detail = fresh({ kind: 'ready', info, widgetRow: null }); tree = render();
  button(tree, 'Finish setup with Clem')!.props.onClick(); tree = render();
  assert.equal(tree.type, 'Chat'); assert.equal(tree.props.sessionId, 'workflow:exact-canonical');
  assert.equal(tree.props.initialAutoSend, false);
  assert.match(drafts.read(scope).text, /^My existing draft\n\nHelp me finish setting up/);
  assert.match(drafts.read(scope).text, /recipient: Who receives the brief\?/);
  assert.match(drafts.read(scope).text, /owner-account\n- brief-folder/);
  assert.equal(drafts.read(scope).stagedAttachments, files); assert.equal(drafts.read(scope).failed, failed);
  assert.equal(drafts.read('capsule:ask').text, 'An unrelated capsule draft');
  tree.props.onBack(); tree = render(); button(tree, 'Finish setup with Clem')!.props.onClick();
  assert.equal((drafts.read(scope).text.match(/Help me finish setting up/g) ?? []).length, 1);
});
