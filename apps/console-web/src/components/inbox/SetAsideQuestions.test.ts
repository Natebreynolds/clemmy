import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { AttentionPresentationItem } from '../../lib/attention-presentation';
import type { QuestionPresentationItem } from '../../lib/inbox';

const temporary = mkdtempSync(path.join(os.tmpdir(), 'clem-set-aside-render-'));
test.after(() => rmSync(temporary, { recursive: true, force: true }));
const consoleRoot = fileURLToPath(new URL('../../../', import.meta.url));
const output = await build({
  stdin: { contents: `
    import { renderToStaticMarkup } from 'react-dom/server';
    import { MemoryRouter } from 'react-router-dom';
    import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
    import { SetAsideQuestions } from './src/components/inbox/SetAsideQuestions';
    export function render({questions, attention, path = '/inbox?tab=set-aside', error = false, questionError = error, attentionError = error}) {
      const client = new QueryClient({defaultOptions:{queries:{retryOnMount:false}}});
      const queryKey = ['inbox-question-presentations'];
      if (questions || !questionError) client.setQueryData(queryKey, {questions: questions || [], count: questions?.length || 0});
      if (questionError) client.getQueryCache().build(client, {queryKey}).setState({status:'error', error:new Error('Controlled offline state')});
      const attentionKey = ['inbox-attention-presentations'];
      if (attention || !attentionError) client.setQueryData(attentionKey, {items: attention || [], count: attention?.length || 0});
      if (attentionError) client.getQueryCache().build(client, {queryKey: attentionKey}).setState({status:'error', error:new Error('Controlled offline state')});
      const originalFetch = globalThis.fetch;
      globalThis.fetch = () => { throw new Error('Rendering must not request data or restore a question'); };
      try {
        return renderToStaticMarkup(<MemoryRouter initialEntries={[path]}><QueryClientProvider client={client}>
          <SetAsideQuestions />
        </QueryClientProvider></MemoryRouter>);
      } finally { globalThis.fetch = originalFetch; client.clear(); }
    }
  `, resolveDir: consoleRoot, loader: 'tsx', sourcefile: 'set-aside-render-fixture.tsx' },
  tsconfig: path.join(consoleRoot, 'tsconfig.json'), bundle: true, write: false,
  platform: 'node', format: 'cjs', jsx: 'automatic', target: 'node22', logLevel: 'silent',
  loader: { '.png': 'dataurl' },
  define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_CLEM_TOKEN': '""' },
});
const fixtureFile = path.join(temporary, 'render.cjs');
writeFileSync(fixtureFile, output.outputFiles[0].contents);
const { render } = createRequire(import.meta.url)(fixtureFile) as {
  render: (props: { questions?: QuestionPresentationItem[]; attention?: AttentionPresentationItem[]; path?: string; error?: boolean; questionError?: boolean; attentionError?: boolean }) => string;
};
const later: QuestionPresentationItem = {
  id: 'task:controlled-later', source: 'background_task', question: 'Later controlled question', options: ['Send the final draft'],
  context: 'Controlled work context.', askedAt: '2026-10-29T12:00:00Z', urgency: 'normal', agentLabel: 'Research agent',
  sessionId: 'controlled-later', taskId: 'controlled-later', workflowName: null, runId: null, stepId: null,
  answerable: true, unavailableReason: null, action: 'defer', generation: 'exact-generation', mutationToken: 'exact-mutation-token', until: '2026-10-30T09:00:00Z',
};
const dismissed: QuestionPresentationItem = { ...later, id: 'task:controlled-dismissed', question: 'Dismissed controlled question', action: 'dismiss', until: undefined };

test('server-backed saved questions render after reload with Restore and their real context', () => {
  const html = render({ questions: [later, dismissed] });
  assert.match(html, /Later controlled question/);
  assert.match(html, /Dismissed controlled question/);
  assert.match(html, /Restore question: Later controlled question/);
  assert.match(html, /Controlled work context/);
  assert.match(html, /href="\/chat\/harness%3Acontrolled-later"/);
  assert.match(html, /Setting it aside does not answer a question/);
  assert.doesNotMatch(html, /Send the final draft|>Answer<|>Resume<|exact-mutation-token/);
});

test('a direct Later or Dismissed URL shows only its own saved questions', () => {
  const rows = [later, dismissed];
  const laterHtml = render({ questions: rows, path: '/inbox?tab=set-aside&view=later' });
  assert.match(laterHtml, /Later controlled question/);
  assert.doesNotMatch(laterHtml, /Dismissed controlled question/);
  const dismissedHtml = render({ questions: rows, path: '/inbox?tab=set-aside&view=dismissed' });
  assert.match(dismissedHtml, /Dismissed controlled question/);
  assert.doesNotMatch(dismissedHtml, /Later controlled question/);
});

test('an unavailable recovery feed never claims that nothing is set aside', () => {
  const html = render({ error: true });
  assert.match(html, /Set aside is unavailable/);
  assert.match(html, /Your saved choices have not changed/);
  assert.doesNotMatch(html, /Nothing set aside|all caught up/);
});

test('a failed refresh keeps saved questions visible with an explicit stale note', () => {
  const html = render({ questions: [later], error: true });
  assert.match(html, /Couldn’t refresh questions and other requests. Showing their last saved lists/);
  assert.match(html, /Later controlled question/);
  assert.match(html, /Try again/);
});

const request: AttentionPresentationItem = { key: 'calendar:controlled', kind: 'calendar', title: 'Review controlled invitation',
  detail: 'The original invitation remains unanswered.', createdAt: '', notificationId: 'controlled-calendar',
  lifecycle: {canDismiss:true,canDefer:true,effect:'hide_only',dismissLabel:'Dismiss',deferLabel:'Tomorrow',generation:'calendar-generation',explanation:'Hide only'},
  action:'dismiss',generation:'calendar-generation',mutationToken:'calendar-mutation' };

test('reloaded generic requests join questions with recovery and no invented destination or date', () => {
  const html = render({questions:[later],attention:[request]});
  assert.match(html, /Later controlled question/);
  assert.match(html, /Review controlled invitation/);
  assert.match(html, /Restore item: Review controlled invitation/);
  assert.match(html, /original invitation remains unanswered/);
  assert.doesNotMatch(html, /calendar-mutation|calendar-generation|1970|Invalid Date|href="\/tasks"|>Mark as read</);
  const filtered = render({questions:[later],attention:[request],path:'/inbox?tab=set-aside&view=later'});
  assert.match(filtered, /Later controlled question/);
  assert.doesNotMatch(filtered, /Review controlled invitation/);
});

test('one unavailable source retains other requests and never declares the combined store empty', () => {
  for (const attention of [[],[request]]) {
    const html = render({attention,questionError:true});
    assert.match(html, /Couldn’t refresh questions/);
    assert.doesNotMatch(html, /Nothing set aside|Set aside is unavailable/);
    assert.match(html, attention.length ? /Review controlled invitation/ : /No items in the available lists/);
  }
  const html = render({questions:[later],attentionError:true});
  assert.match(html, /Couldn’t refresh other requests/);
  assert.match(html, /Later controlled question/);
  assert.doesNotMatch(html, /Nothing set aside/);
});
