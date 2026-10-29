import test from 'node:test';
import assert from 'node:assert/strict';
import type { QuestionPresentationItem } from './inbox';
import type { SessionProjectLabel } from './project-labels';
import { mergeSetAsideItems, matchesSetAsideItem, setAsideItemContext, setAsideItemDate, matchesSetAsideQuestion, setAsideQuestionContext, setAsideReturnLabel, setAsideView } from './set-aside-questions';

const question: QuestionPresentationItem = {
  id: 'task:controlled', source: 'background_task', question: 'Which draft should I continue?', options: ['Draft A', 'Draft B'],
  context: 'The outline is saved.', askedAt: '2026-10-29T12:00:00Z', urgency: 'normal', agentLabel: 'Research agent',
  sessionId: 'controlled / session', taskId: 'controlled', workflowName: null, runId: null, stepId: null,
  answerable: true, unavailableReason: null, action: 'defer', generation: 'rendered-generation', mutationToken: 'exact-mutation', until: '2026-10-30T09:00:00Z',
};
const project: SessionProjectLabel = { sessionId: question.sessionId!, projectId: 'project-one', projectName: 'Launch research', agentName: 'Research agent', taskId: 'controlled' };
const all = { view: 'all' as const, search: '', projectId: '' };

test('recovery filters separate later/dismissed and use only known project metadata', () => {
  assert.equal(matchesSetAsideQuestion(question, all), true);
  assert.equal(matchesSetAsideQuestion(question, { ...all, view: 'later' }), true);
  assert.equal(matchesSetAsideQuestion(question, { ...all, view: 'dismissed' }), false);
  assert.equal(matchesSetAsideQuestion({ ...question, action: 'dismiss' }, { ...all, view: 'dismissed' }), true);
  assert.equal(matchesSetAsideQuestion(question, { ...all, projectId: project.projectId }, project), true);
  assert.equal(matchesSetAsideQuestion(question, { ...all, projectId: project.projectId }), false, 'an unknown project is never guessed');
  assert.equal(matchesSetAsideQuestion(question, { ...all, search: 'LAUNCH outline' }, project), true);
  assert.equal(matchesSetAsideQuestion(question, { ...all, search: 'unrelated' }, project), false);
});

test('direct recovery URLs open the selected view and unsupported values fall back to All', () => {
  assert.equal(setAsideView('later'), 'later');
  assert.equal(setAsideView('dismissed'), 'dismissed');
  assert.equal(setAsideView(null), 'all');
  assert.equal(setAsideView('unrecognized'), 'all');
});

test('recovery context opens the exact conversation or workflow without an execution action', () => {
  assert.deepEqual(setAsideQuestionContext(question), { href: '/chat/harness%3Acontrolled%20%2F%20session', label: 'Open conversation' });
  assert.deepEqual(setAsideQuestionContext({ ...question, source: 'workflow', workflowName: 'controlled flow', runId: 'run / one' }), { href: '/automate?workflow=controlled+flow&run=run+%2F+one', label: 'Open workflow run' });
  assert.deepEqual(setAsideQuestionContext({ ...question, sessionId: null }), { href: '/tasks', label: 'View saved work' });
});

test('a missing return time never fabricates a tomorrow promise', () => {
  assert.equal(setAsideReturnLabel({ action: 'dismiss' }), 'Dismissed');
  assert.equal(setAsideReturnLabel({ action: 'defer' }), 'Set aside for later');
  assert.equal(setAsideReturnLabel({ action: 'defer', until: 'invalid' }), 'Set aside for later');
  assert.match(setAsideReturnLabel(question), /^Back /);
});


test('merged recovery preserves separate receipt identities and searches real generic context', () => {
  const row = {key:question.id,kind:'workflow' as const,title:'Controlled workflow request',detail:'Review the retained connection',createdAt:'',
    workflowSlug:'controlled workflow',runId:'run-one',action:'dismiss' as const,generation:'generic-generation',mutationToken:'generic-token',
    lifecycle:{canDismiss:true,canDefer:true,effect:'hide_only' as const,dismissLabel:'Dismiss',deferLabel:'Tomorrow',generation:'generic-generation',explanation:'Hide only'}};
  const merged = mergeSetAsideItems([question],[row]);
  assert.equal(new Set(merged.map(item=>item.key)).size,2,'equal ids from independent stores cannot collide');
  const generic = merged.find(item=>item.target==='attention')!;
  assert.equal(matchesSetAsideItem(generic,{...all,search:'WORKFLOW retained'}),true);
  assert.equal(matchesSetAsideItem(generic,{...all,view:'later'}),false);
  assert.equal(matchesSetAsideItem(generic,{...all,projectId:'unknown'}),false);
  assert.equal(setAsideItemDate(generic),'');
  assert.deepEqual(setAsideItemContext(generic),{href:'/automate?workflow=controlled+workflow&run=run-one',label:'Open workflow run'});
  assert.equal(setAsideItemContext({...generic,target:'attention',row:{...row,workflowSlug:undefined,runId:undefined}}),null);
});
