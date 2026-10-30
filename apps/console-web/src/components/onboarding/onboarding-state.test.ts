import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as models from '../../lib/onboarding-models';
import { createSignInAttemptOwner, deviceSignInDeadline, deviceSignInPollDelay } from '../../lib/sign-in-attempt';
import * as entry from '../../lib/onboarding-entry';
import * as explorationHome from '../home/exploration-home';
import { buildHomeContentLayout } from '../home/home-content-layout';
import { buildWatchOverview } from '../home/watch-overview-model';

type Element = { type: unknown; props: Record<string, any> };
const element = (type: unknown, props: Record<string, any>, key?: string): Element => ({ type, props: { ...props, key } });
const children = (tree: any): Element[] => Array.isArray(tree) ? tree.flatMap(children)
  : tree && typeof tree === 'object' && tree.props ? [tree, ...children(tree.props.children)] : [];
const words = (node: any): string => Array.isArray(node) ? node.map(words).join('')
  : node && typeof node === 'object' && node.props ? words(node.props.children) : typeof node === 'string' ? node : '';
const query = (data?: any, patch: Record<string, any> = {}) => ({ data, isLoading: false, isError: false,
  isFetching: false, error: null, async refetch() {}, ...patch });
function settings() {
  return { modelRoles: { effectiveBrain: 'api_key', effectiveBrainValue: 'api_key:main',
    roles: { brain: { modelId: 'main' } }, brainBackups: { modelIds: [] }, brainOptions: [
      { id: 'api_key', value: 'api_key:main', modelId: 'main', label: 'Main', available: true },
      { id: 'api_key', value: 'api_key:second', modelId: 'second', label: 'Second', available: true },
    ] } };
}

/** Invoke the actual components with inert ports and React's hook ordering.
 * Effects and rerenders run; no app runtime, vault, browser or model is used. */
function mount(file: string, exported: string, initialProps: Record<string, any>, ports: Record<string, any>, exposeLocal = false) {
  const slots: any[] = [];
  let cursor = 0;
  let changed = false;
  let pending: Array<() => void> = [];
  let props = initialProps;
  let tree: any;
  const same = (a?: any[], b?: any[]) => Boolean(a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i])));
  const memo = (read: () => any, deps?: any[]) => {
    const index = cursor++;
    if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { deps, value: read() };
    return slots[index].value;
  };
  const hooks = {
    useState(value: any) { const index = cursor++; slots[index] ??= { value: typeof value === 'function' ? value() : value };
      return [slots[index].value, (next: any) => { const result = typeof next === 'function' ? next(slots[index].value) : next;
        if (!Object.is(result, slots[index].value)) { slots[index].value = result; changed = true; } }]; },
    useRef(value: any) { const index = cursor++; slots[index] ??= { ref: { current: value } }; return slots[index].ref; },
    useMemo: memo, useCallback: (callback: any, deps?: any[]) => memo(() => callback, deps),
    useEffect(effect: () => any, deps?: any[]) { const index = cursor++;
      if (!slots[index] || !same(slots[index].deps, deps)) { const previous = slots[index]; slots[index] = { deps };
        pending.push(() => { previous?.cleanup?.(); slots[index].cleanup = effect(); }); } },
  };
  const dependencies: Record<string, any> = {
    react: { ...hooks, lazy: () => 'Lazy', Fragment: 'Fragment', Suspense: 'Suspense' }, 'react/jsx-runtime': { jsx: element, jsxs: element }, 'lucide-react': {},
    '@/components/ui/Button': { Button: 'Button' }, '@/components/ui/Field': { Field: 'Field', Input: 'Input', Select: 'Select' },
    '@tanstack/react-query': { useQueryClient: () => ({ invalidateQueries: async () => {}, setQueryData() {} }) },
    ...ports,
  };
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8') + (exposeLocal ? `\nexport { ${exported} };` : ''), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports: Record<string, any> = {};
  runInNewContext(code, { exports, URLSearchParams, window: { scrollTo() {}, open() {} }, require(name: string) {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name];
  } });
  const render = (nextProps = props) => {
    props = nextProps;
    for (let turns = 0; turns < 20; turns++) {
      cursor = 0; changed = false; pending = []; tree = exports[exported](props);
      pending.forEach(effect => effect());
      if (!changed) return tree;
    }
    throw new Error('Unexpected render loop');
  };
  render();
  return { render, nodes: () => children(tree), text: () => words(tree),
    button(label: string) { const node = children(tree).find(node => node.type === 'Button' && words(node).trim() === label);
      assert.ok(node, `Missing button: ${label}`); return node; },
    field(label: string) { const node = children(tree).find(node => node.type === 'Field' && node.props.label === label);
      assert.ok(node, `Missing field: ${label}`); return node.props.children('controlled-field') as Element; },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); },
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

function accountsView(usage: Record<string, any>, providers: any[] = []) {
  let retries = 0; let invalidations = 0;
  const view = mount('../../screens/settings/ModelAccountsCard.tsx', 'ModelAccountsCard', {}, {
    '@/lib/cn': { cn: (...parts: any[]) => parts.filter(Boolean).join(' ') },
    '@clem/chat-engine': { accountCaption: () => 'Loaded usage', accountHeadline: () => 'Loaded balance',
      creditRefusalSentence: () => 'Refusing requests', meterTone: () => 'danger', resetsInText: () => '' },
    '@/components/chat/ActivityFeed': { PROVIDER_DOT: { unknown: '#999' } },
    '@/components/ModelStatusChips': { useUsageMeters: () => ({ meters: [], now: 123, ready: false, loading: false,
      unavailable: false, refreshing: false, retry() { retries++; }, ...usage }) },
    '@/lib/model-roles': { useModelRoles: () => ({ settings: { modelProviders: providers } }) },
    '@/lib/connect': { setCredential() { throw new Error('Render must not save credentials'); } },
    './ClaudeLoginForm': { ClaudeLoginForm: 'ClaudeLoginForm' }, './CodexLoginForm': { CodexLoginForm: 'CodexLoginForm' },
    './XaiLoginForm': { XaiLoginForm: 'XaiLoginForm' }, './JevConnectForm': { JevConnectForm: 'JevConnectForm' },
    './ModelProviderForms': { AddModelForm: 'AddModelForm', ProviderManagePanel: 'ProviderManagePanel' },
    '@tanstack/react-query': { useQueryClient: () => ({ invalidateQueries() { invalidations++; } }) },
  });
  const row = (id: string) => { const node = view.nodes().find(node => node.props.id === id); assert.ok(node, `Missing account ${id}`); return node; };
  return { view, row, retries: () => retries, invalidations: () => invalidations };
}

test('account loading retains built-in and saved-provider management and Add model without declaring disconnected', () => {
  const { view, row, invalidations } = accountsView({ loading: true }, [{ id: 'saved-api', label: 'Saved API', configured: true, modelIds: ['model'] }]);
  assert.match(view.text(), /Checking account usage/);
  assert.doesNotMatch(view.text(), /Not connected/);
  for (const id of ['claude', 'codex', 'xai', 'jev', 'openai', 'saved-api']) {
    assert.equal(row(id).props.statusUnknown, true);
    const rendered = (row(id).type as Function)(row(id).props);
    assert.match(words(rendered), /Manage connection/);
    assert.doesNotMatch(words(rendered), /Loaded balance|Refusing requests/);
  }
  row('claude').props.onToggle(); view.render();
  const rendered = (row('claude').type as Function)(row('claude').props);
  const panel = children(rendered).find(node => typeof node.type === 'function')!;
  assert.equal(panel.props.connected, undefined);
  assert.equal((panel.type as Function)(panel.props).type, 'ClaudeLoginForm', 'opens the existing account-owned sign-in');
  view.button('Add a model').props.onClick(); view.render();
  assert.ok(view.nodes().some(node => node.type === 'AddModelForm'));
  assert.equal(invalidations(), 0, 'opening management performs no account writes');
});

test('failed usage with retained data offers Retry and does not present old balance or false disconnection', () => {
  const stale = { id: 'claude', label: 'Claude', windows: [], outOfCredit: true, uses: ['brain'] };
  const { view, row, retries } = accountsView({ ready: true, unavailable: true, meters: [stale] });
  assert.match(view.text(), /couldn’t be loaded/);
  assert.doesNotMatch(view.text(), /Not connected|refusing|Loaded balance/i);
  assert.equal(row('claude').props.meter, undefined);
  view.button('Retry').props.onClick();
  assert.equal(retries(), 1);
});

test('successful disconnected snapshot shows actual Connect controls and no unknown-status warning', () => {
  const { view, row } = accountsView({ ready: true });
  assert.match(view.text(), /Not connected/);
  assert.equal(row('codex').props.statusUnknown, false);
  const rendered = (row('codex').type as Function)(row('codex').props);
  assert.match(words(rendered), /Connect/);
  assert.doesNotMatch(words(rendered), /Manage connection|not confirmed/);
  assert.ok(view.button('Add a model'));
});

test('usage hook exposes retry and retained-read failure separately from data readiness', () => {
  let calls = 0;
  const snapshot = { claude: { connected: true } };
  const view = mount('../ModelStatusChips.tsx', 'useUsageMeters', {}, {
    '@clem/chat-engine': { presentUsageMeters: (value: any) => value ? ['retained meter'] : [] },
    '@/lib/cn': {}, '@/lib/model-status': {},
    '@/lib/poll': { usePoll: () => query(snapshot, { isError: true, isFetching: true, refetch() { calls++; } }) },
  });
  const state = view.render();
  assert.equal(state.ready, true); assert.equal(state.unavailable, true); assert.equal(state.refreshing, true);
  state.retry(); assert.equal(calls, 1);
});

test('empty model routing links to the visible account section and preserves the explicit draft return', () => {
  const returnState = { onboardingModelReturn: { version: 1, intent: 'explore', stamp: 456 } };
  const role = { modelId: 'none', provider: 'byo', source: 'default' };
  const roleWords = Object.fromEntries(['brain', 'worker', 'judge'].map(key => [key, { title: key, hint: key }]));
  const view = mount('../../screens/settings/ModelRolesCard.tsx', 'ModelRolesCard', {}, {
    './CompletionReviewControl': {}, './ClaudeLoginForm': {},
    'react-router-dom': { Link: 'Link', useLocation: () => ({ pathname: '/settings', hash: '#models', state: returnState }) },
    '@/lib/cn': { cn: (...parts: any[]) => parts.filter(Boolean).join(' ') },
    '@/lib/model-roles': { useModelRoles: () => ({ mr: { roles: { brain: role, worker: role, judge: role }, bindings: [], available: [] },
      workers: [], judges: [], writers: [], memories: [], brains: [], loading: false, brainValue: 'none' }),
      judgeFallbackChoices: () => [], ROLE_WORDS: roleWords },
    '@clem/chat-engine': { modelScoreLine: () => null, checkerAutomaticText: () => null, modelDisplayName: (id: string) => id },
    '@/lib/memory-work': {}, '@/components/ui/Skeleton': {},
    '@/lib/poll': { usePoll: () => query() }, '@/lib/fusion': {}, '@/lib/inbox': {}, '@/lib/settings': {},
  });
  const accountLink = view.nodes().find(node => node.type === 'Link' && words(node) === 'Model accounts');
  assert.ok(accountLink);
  assert.equal(accountLink.props.to.pathname, '/settings'); assert.equal(accountLink.props.to.hash, '#accounts');
  assert.equal(accountLink.props.state, returnState);
  assert.match(view.text(), /No models listed yet/);
  assert.doesNotMatch(view.text(), /under Connected|No models connected yet/);
});

test('explicit blank exploration keeps its composer, note and Arrange while confirmed empty introductions yield', () => {
  const now = Date.now();
  let state: any = { onboardingEntry: { version: 1, intent: 'explore', stamp: 123 } };
  let failed = false;
  const loaded = (data: any) => query(data, { dataUpdatedAt: now, isError: failed });
  const preferences = { updatedAt: '1970-01-01T00:00:00.000Z', style: 'dashboard', panes: { order: ['made', 'projects'], hidden: [] },
    quickActions: [], spaceViews: {} };
  const view = mount('../../screens/Home.tsx', 'LiveHome', {}, {
    'react-router-dom': { Link: 'Link', useNavigate: () => () => {},
      useLocation: () => ({ pathname: '/chat', state, key: 'fixture', search: '' }) },
    '@/components/DogMark': { DogMark: 'DogMark' }, '@/components/home/HomeBuilder': { HomeBuilder: 'HomeBuilder' },
    '@/components/home/SpaceTile': { SpaceTile: 'SpaceTile' }, '@/lib/customize-home': {},
    '@/lib/home-layout': { useHomeLayout: () => loaded({ revision: 0, updatedAt: null, tiles: [] }) },
    '@/lib/home-builds': { useHomeBuilds: () => ({ builds: [] }) }, '@/components/home/BuildCard': {},
    '@/components/home/mock/screens': {}, '@/lib/api': {},
    '@/lib/poll': { usePoll: (key: string[]) => loaded(key[0] === 'command-center' ? { needsYou: [], recentCompleted: [] }
      : key[0] === 'needs-you-summary' ? { total: 0 } : key[0] === 'working-now-badge' ? { entries: [], observedAt: '' }
        : key[0] === 'watches' ? { watches: [] } : []) },
    '@/lib/memory': {}, '@/lib/greeting': { timeGreeting: () => 'Welcome', greetingName: () => null },
    '@/lib/home-prefs': { useHomePreferences: () => loaded(preferences), useSaveHomePreferences: () => ({}), visiblePanes: () => ['made', 'projects'] },
    '@/lib/home-data': { useHomeToday: () => loaded({ connected: false }), useSpaceSummaries: () => loaded([]) },
    '@/lib/useChat': { useChat: () => ({ sessionId: { current: null }, conversationSessionId: { current: null } }) },
    '@/lib/composer-drafts': { newComposerDraftKey: () => 'explicit-exploration-draft' },
    '@/lib/use-conversation-send-scope': { useConversationSendScope: () => () => ({}) }, '@/lib/last-session': {},
    '@/lib/activity': {}, '@/lib/activity-presentation': { presentWorkingNow: () => ({ total: 0, running: 0 }) }, '@/lib/spaces': {},
    '@/components/chat/Composer': { Composer: 'Composer' }, '@/lib/use-stuck': { useStuck: () => false },
    '@/lib/cn': { cn: (...parts: any[]) => parts.filter(Boolean).join(' ') }, '@/components/chat/AgentPicker': {},
    '@/lib/conversation-agent': { useConversationAgent: () => ({ chosen: null }) }, '@/components/chat/ProjectPicker': {},
    '@/lib/conversation-project': { useConversationProject: () => ({ chosen: null }) }, '@/components/CollaborativeWorkstate': {},
    '@/components/ModelStatusChips': {}, '@/components/ui/Skeleton': {}, '@/components/home/QuickActions': {},
    '@/components/home/NeedsYouPane': {}, '@/components/home/WhileAwayPane': {}, '@/components/home/TodayPane': {},
    '@/components/home/ProjectsPane': { ProjectsPane: 'ProjectsPane' }, '@/components/home/MadePane': { MadePane: 'MadePane' },
    '@/components/home/MissedRunsCard': { MissedRunsCard: 'MissedRunsCard' },
    '@/components/home/FromClemPane': {}, '@/components/home/HomeWatchOverview': { HomeWatchLine: 'HomeWatchLine' },
    '@/components/home/watch-overview-model': { buildWatchOverview }, '@/components/home/home-content-layout': { buildHomeContentLayout },
    '@/components/home/exploration-home': explorationHome, '@/lib/watches': {},
    '@/lib/from-clem': { useFromClem: () => loaded({ rows: [], covers: {} }), withoutFromClem: (rows: any) => rows },
    '@/components/home/HomeSection': {}, '@/components/projects/DelegatedTaskCard': {},
    '@/components/onboarding/ExplorationNotice': { ExplorationNotice: 'ExplorationNotice' }, '@/lib/onboarding-entry': entry,
    '@/lib/projects': {}, '@/lib/delivered': {}, '@/lib/inbox': {},
    '@/components/home/home-model': { awayCounts: () => ({ updates: 0, attention: 0 }), presenceLine: () => 'Ready when you are.',
      silentImmediatePanes: () => ['needs_you', 'while_away'], staleSuffix: () => '' }, '@/components/home/home-presence.css': {},
  }, true);
  const has = (type: string) => view.nodes().some(node => node.type === type);
  assert.equal(has('Composer'), true); assert.equal(has('ExplorationNotice'), true); assert.ok(view.button('Arrange'));
  for (const type of ['MadePane', 'ProjectsPane', 'HomeWatchLine']) assert.equal(has(type), false);
  assert.equal(view.nodes().some(node => node.props['aria-labelledby'] === 'home-spaces'), false);
  assert.equal(view.nodes().some(node => node.props['aria-label'] === 'Build your Home'), false, 'compaction must not substitute another large first-use introduction');
  failed = true; view.render();
  for (const type of ['MadePane', 'ProjectsPane', 'HomeWatchLine']) assert.equal(has(type), true, `${type} recovery stays visible on read failure`);
  failed = false; state = null; view.render();
  for (const type of ['MadePane', 'ProjectsPane', 'HomeWatchLine']) assert.equal(has(type), true, `${type} remains for returning users`);
  assert.equal(view.nodes().some(node => node.props['aria-labelledby'] === 'home-spaces'), true);
});

test('wizard cannot finish or advance while its provider is pending or model choices are unsaved', async () => {
  const finished: boolean[] = [];
  const navigations: any[] = [];
  const view = mount('../../screens/Onboarding.tsx', 'Onboarding', {}, {
    'react-router-dom': { useNavigate: () => (...args: any[]) => navigations.push(args) },
    '@/components/DogMark': { DogMark: 'DogMark' },
    '@/components/onboarding/OnboardingModels': { OnboardingModels: 'OnboardingModels' },
    '@/components/onboarding/OnboardingExtras': { OnboardingJev: 'OnboardingJev', OnboardingVoice: 'OnboardingVoice' },
    '@/components/connect/MobilePanel': { MobilePanel: 'MobilePanel' },
    '@/lib/clemmy': { clemmy: () => ({ onboardingComplete() {} }) },
    '@/lib/poll': { usePoll: () => query(settings()) }, '@/lib/settings': {}, '@/lib/connect': {},
    '@/lib/onboarding-models': models,
    '@/lib/onboarding-finish': { finishOnboarding: async (explore: boolean) => { finished.push(explore); } },
    '@/lib/onboarding-entry': entry,
    './onboarding.css': {},
  });
  const child = () => view.nodes().find(node => node.type === 'OnboardingModels')!;
  child().props.onBusyChange(true); view.render();
  assert.equal(view.button('Start with Clem').props.disabled, true);
  view.button('Start with Clem').props.onClick();
  assert.deepEqual(finished, []);
  child().props.onBusyChange(false); child().props.onDirtyChange(true); view.render();
  assert.equal(view.button('Optional setup').props.disabled, true);
  assert.equal(view.button('Start with Clem').props.disabled, true);
  view.button('Optional setup').props.onClick(); view.render();
  assert.equal(child().props.discardRequest, 0);
  view.button('Discard unsaved choices').props.onClick(); view.render();
  assert.equal(child().props.discardRequest, 1, 'discard delegates only to local model drafts');
  child().props.onDirtyChange(false); view.render();
  assert.equal(view.button('Start with Clem').props.disabled, false);
  view.button('Start with Clem').props.onClick(); await flush();
  assert.deepEqual(finished, [false]);
  assert.equal(navigations[0][0], '/chat');
});

test('wizard no-model completion names the explicit exploration choice', async () => {
  const finished: boolean[] = [];
  const navigations: any[] = [];
  const view = mount('../../screens/Onboarding.tsx', 'Onboarding', {}, {
    'react-router-dom': { useNavigate: () => (...args: any[]) => navigations.push(args) }, '@/components/DogMark': {},
    '@/components/onboarding/OnboardingModels': {}, '@/components/onboarding/OnboardingExtras': {}, '@/components/connect/MobilePanel': {},
    '@/lib/clemmy': { clemmy: () => null }, '@/lib/poll': { usePoll: () => query({}) },
    '@/lib/settings': {}, '@/lib/connect': {}, '@/lib/onboarding-models': models,
    '@/lib/onboarding-finish': { finishOnboarding: async (explore: boolean) => { finished.push(explore); } }, './onboarding.css': {},
    '@/lib/onboarding-entry': entry,
  });
  view.button('Continue without a model').props.onClick(); await flush();
  assert.deepEqual(finished, [true]);
  assert.equal(navigations[0][0], '/chat');
  assert.equal(navigations[0][1].state.onboardingEntry.intent, 'explore');
  assert.equal(navigations[0][1].state.newChat, undefined, 'ChatIndex must choose Today rather than the remembered-chat composer branch');
  assert.equal(navigations[0][1].state.prompt, undefined, 'finishing never sends a request');
});

test('model wizard aggregates simultaneous provider ownership and discards local primary/backup drafts without saves', () => {
  const busy: boolean[] = []; const dirty: boolean[] = []; let writes = 0;
  const props = { onBusyChange: (value: boolean) => busy.push(value), onDirtyChange: (value: boolean) => dirty.push(value), discardRequest: 0 };
  const view = mount('./OnboardingModels.tsx', 'OnboardingModels', props, {
    '@/lib/poll': { usePoll: () => query(settings()) }, '@/lib/settings': { setActiveBrain() { writes++; }, patchBrainBackups() { writes++; } },
    '@/lib/onboarding-models': models,
    '@/screens/settings/CodexLoginForm': { CodexLoginForm: 'CodexLoginForm' },
    '@/screens/settings/ClaudeLoginForm': { ClaudeLoginForm: 'ClaudeLoginForm' },
    '@/screens/settings/XaiLoginForm': { XaiLoginForm: 'XaiLoginForm' },
    '@/screens/settings/ModelProviderForms': { AddModelForm: 'AddModelForm' },
  });
  const child = (type: string) => view.nodes().find(node => node.type === type)!;
  child('CodexLoginForm').props.onBusyChange(true); child('ClaudeLoginForm').props.onBusyChange(true); view.render();
  assert.equal(busy.at(-1), true);
  child('CodexLoginForm').props.onBusyChange(false); view.render();
  assert.equal(busy.at(-1), true, 'one child finishing cannot release another active sign-in');
  child('ClaudeLoginForm').props.onBusyChange(false); view.render();
  assert.equal(busy.at(-1), false);
  view.field('Main model').props.onChange({ target: { value: 'api_key:second' } }); view.render();
  assert.equal(dirty.at(-1), true);
  view.render({ ...props, discardRequest: 1 });
  assert.equal(dirty.at(-1), false);
  assert.equal(view.field('Main model').props.value, 'api_key:main');
  view.field('Backup 1').props.onChange({ target: { value: 'second' } }); view.render({ ...props, discardRequest: 1 });
  assert.equal(dirty.at(-1), true);
  view.render({ ...props, discardRequest: 2 });
  assert.equal(dirty.at(-1), false);
  assert.equal(view.field('Backup 1').props.value, '');
  assert.equal(writes, 0);
});

for (const [file, exported, path, data, disconnected] of [
  ['CodexLoginForm.tsx', 'CodexLoginForm', '@/lib/connect', { auth: { codexOauthPresent: false } }, 'Not signed in.'],
  ['ClaudeLoginForm.tsx', 'ClaudeLoginForm', '@/lib/settings', { claudeAuth: { configured: false } }, 'Not signed in.'],
  ['XaiLoginForm.tsx', 'XaiLoginForm', '@/lib/connect', { connected: false }, 'Not connected.'],
] as const) test(`${exported} keeps unavailable and loading status distinct from confirmed disconnection`, () => {
  for (const state of ['loading', 'error', 'missing', 'disconnected']) {
    let retries = 0;
    const result = query(state === 'disconnected' ? data : undefined, { isLoading: state === 'loading', isError: state === 'error', refetch: () => { retries++; } });
    const view = mount(`../../screens/settings/${file}`, exported, { embedded: true, onboarding: true }, {
      '@/lib/poll': { usePoll: () => result }, [path]: {}, '@/lib/settings': {}, '@/lib/connect': {},
      '@/lib/clemmy': { clemmy: () => null }, '@/lib/sign-in-attempt': { createSignInAttemptOwner },
    });
    if (state === 'disconnected') assert.ok(view.text().includes(disconnected));
    else { assert.ok(!view.text().includes(disconnected), state);
      if (state === 'loading') assert.match(view.text(), /Checking your/);
      else { assert.match(view.text(), /Could not confirm/); view.button('Try again').props.onClick(); assert.equal(retries, 1); } }
  }
});

function attempts() {
  return { createSignInAttemptOwner: () => createSignInAttemptOwner({ schedule: (() => 1) as unknown as typeof setTimeout, cancel: (() => {}) as typeof clearTimeout }),
    deviceSignInDeadline, deviceSignInPollDelay };
}

for (const provider of ['Codex', 'Xai'] as const) test(`${provider} onboarding can stop observing sign-in without polling or disconnecting`, async () => {
  const busy: boolean[] = []; let signal: AbortSignal | undefined; let polls = 0; let disconnects = 0; let refreshes = 0;
  const begin = async (given: AbortSignal) => { signal = given; return { loginId: 'controlled-login', verificationUri: 'https://example.test/sign-in', userCode: 'CONTROLLED', expiresAt: new Date(Date.now() + 60_000).toISOString() }; };
  const view = mount(`../../screens/settings/${provider}LoginForm.tsx`, provider === 'Codex' ? 'CodexReauth' : 'XaiSignIn', {
    signedIn: false, connected: false, allowCancel: true, onBusyChange: (value: boolean) => busy.push(value), onDone: () => { refreshes++; },
  }, {
    '@/lib/poll': {}, '@/lib/clemmy': { clemmy: () => null }, '@/lib/settings': {},
    '@/lib/connect': { codexDeviceBegin: begin, xaiDeviceBegin: begin, codexDevicePoll() { polls++; }, xaiDevicePoll() { polls++; }, xaiDisconnect() { disconnects++; } },
    '@/lib/sign-in-attempt': attempts(),
  });
  await view.button(provider === 'Codex' ? 'Sign in on another device' : 'Connect xAI (Grok)').props.onClick(); view.render();
  assert.equal(busy.at(-1), true);
  view.button('Stop waiting').props.onClick(); view.render();
  assert.equal(signal?.aborted, true);
  assert.equal(busy.at(-1), false);
  assert.equal(polls, 0); assert.equal(disconnects, 0); assert.equal(refreshes, 1);
  assert.match(view.text(), /Stopped waiting here/);
  view.unmount();
});

test('Claude owns the waiting authorization code until its existing Cancel action releases it', async () => {
  const busy: boolean[] = []; let completes = 0;
  const view = mount('../../screens/settings/ClaudeLoginForm.tsx', 'ClaudeLoginForm', { embedded: true, onboarding: true, onBusyChange: (value: boolean) => busy.push(value) }, {
    '@/lib/poll': { usePoll: () => query({ claudeAuth: { configured: false } }) },
    '@/lib/settings': { beginClaudeLogin: async () => ({ flowId: 'controlled-flow', authorizeUrl: 'https://example.test/authorize' }), completeClaudeLogin() { completes++; } },
  });
  await view.button('Sign in to Claude').props.onClick(); view.render();
  assert.equal(busy.at(-1), true);
  view.button('Cancel').props.onClick(); view.render();
  assert.equal(busy.at(-1), false); assert.equal(completes, 0);
});

test('discarding an unsaved onboarding API key clears only local fields and never adds or removes an account', () => {
  const dirty: boolean[] = []; let accountWrites = 0;
  const props = { presentation: 'onboarding', onClose() {}, onDirtyChange: (value: boolean) => dirty.push(value), discardRequest: 0 };
  const view = mount('../../screens/settings/ModelProviderForms.tsx', 'AddModelForm', props, {
    '@/lib/settings': { addModelProvider() { accountWrites++; }, removeModelProvider() { accountWrites++; } },
    '@/lib/model-provider-presets': { PROVIDER_PRESETS: [{ id: 'controlled', label: 'Controlled', baseURL: 'https://example.test', workerModel: 'controlled' }] },
    '@/lib/connect': { keyUrlHost: () => '' }, '@/lib/model-roles': {},
  });
  view.field('API key').props.children[0].props.onChange({ target: { value: 'FRAMEWORK-TEST-key' } }); view.render();
  assert.equal(dirty.at(-1), true);
  view.render({ ...props, discardRequest: 1 });
  assert.equal(dirty.at(-1), false);
  assert.equal(view.field('API key').props.children[0].props.value, '');
  assert.equal(accountWrites, 0);
});

test('onboarding provider save owns pending state and an explicit discard cannot disconnect its saved account', async () => {
  let resolveSave!: () => void;
  const saved = new Promise<void>(resolve => { resolveSave = resolve; });
  const busy: boolean[] = []; const dirty: boolean[] = []; const accountWrites: any[] = [];
  let removals = 0;
  const props = { presentation: 'onboarding', onClose() {}, onBusyChange: (value: boolean) => busy.push(value),
    onDirtyChange: (value: boolean) => dirty.push(value), discardRequest: 0 };
  const view = mount('../../screens/settings/ModelProviderForms.tsx', 'AddModelForm', props, {
    '@/lib/settings': { async addModelProvider(input: any) { accountWrites.push(input); await saved; }, removeModelProvider() { removals++; } },
    '@/lib/model-provider-presets': { PROVIDER_PRESETS: [{ id: 'controlled', label: 'Controlled', baseURL: 'https://example.test', workerModel: 'controlled' }] },
    '@/lib/connect': { keyUrlHost: () => '' }, '@/lib/model-roles': {},
  });
  view.field('Provider').props.onChange({ target: { value: 'controlled' } }); view.render();
  view.field('API key').props.children[0].props.onChange({ target: { value: 'FRAMEWORK-TEST-key' } }); view.render();
  assert.equal(dirty.at(-1), true);
  view.button('Connect').props.onClick(); view.render();
  assert.equal(busy.at(-1), true);
  assert.equal(view.nodes().find(node => node.type === 'fieldset')?.props.disabled, true, 'the captured request cannot be edited mid-save');
  assert.equal(view.button('Close').props.disabled, true);
  assert.equal(accountWrites.length, 1);
  assert.equal(accountWrites[0].baseURL, 'https://example.test');
  assert.deepEqual(Array.from(accountWrites[0].modelIds), ['controlled']);
  resolveSave(); await flush(); view.render();
  assert.equal(busy.at(-1), false); assert.equal(dirty.at(-1), false);
  view.render({ ...props, discardRequest: 1 });
  assert.match(view.text(), /Connected Controlled/);
  assert.equal(accountWrites.length, 1); assert.equal(removals, 0);
});

test('exploration note is explicit, dismisses once, and scopes its model-account return to the originating entry', () => {
  const start = entry.onboardingCompletionNavigation(true, 303_050_101);
  let location: any = { pathname: '/chat', hash: '', state: start.state };
  const ports = { 'react-router-dom': { useLocation: () => location, Link: 'Link' }, '@/lib/onboarding-entry': entry };
  const view = mount('./ExplorationNotice.tsx', 'ExplorationNotice', {}, ports);
  assert.match(view.text(), /Explore at your own pace/);
  const connect = view.nodes().find(node => node.type === 'Link')!;
  assert.equal(connect.props.to.pathname, '/settings'); assert.equal(connect.props.to.hash, '#accounts');
  location = { pathname: '/settings', hash: '#accounts', state: connect.props.state };
  const back = mount('./ExplorationNotice.tsx', 'OnboardingModelReturn', {}, ports);
  const link = back.nodes().find(node => node.type === 'Link')!;
  assert.equal(link.props.to, '/chat');
  assert.equal(link.props.state.onboardingEntry.stamp, start.state.onboardingEntry.stamp);
  location = { ...location, hash: '#profile' }; back.render(); assert.equal(back.text(), '');
  location = { pathname: '/settings', hash: '#accounts', state: null }; back.render(); assert.equal(back.text(), '');
  location = { pathname: '/projects', hash: '', state: connect.props.state }; back.render(); assert.equal(back.text(), '');
  location = { pathname: '/chat', hash: '', state: start.state }; view.render();
  const dismiss = view.nodes().find(node => node.props['aria-label'] === 'Dismiss exploration note')!;
  dismiss.props.onClick(); view.render(); assert.equal(view.text(), '');
  assert.equal(mount('./ExplorationNotice.tsx', 'ExplorationNotice', {}, ports).text(), '', 'dismissal survives remount');
  location = { ...location, state: entry.onboardingCompletionNavigation(false, 303_050_102).state };
  assert.equal(mount('./ExplorationNotice.tsx', 'ExplorationNotice', {}, ports).text(), '', 'ready completion has no exploration prompt');
  location = { ...location, state: null };
  assert.equal(mount('./ExplorationNotice.tsx', 'ExplorationNotice', {}, ports).text(), '', 'returning users have no first-use prompt');
});
