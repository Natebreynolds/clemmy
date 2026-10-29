/** Run: npx tsx --test apps/console-web/src/lib/needs-you-list.test.ts
 *
 * Needs you reads as one compact list: every kind of decision is the same
 * one-line row, a preview never repeats the title, ordinary questions are quiet,
 * and the order and membership are exactly the feeds' (older approvals last).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attentionDestination, buildNeedsYouItems, needsYouRowView, needsYouAttentionItem, needsYouReport } from './needs-you-list.js';
import type { ApprovalRow, InboxQuestionRow, PlanProposalRow } from './inbox.js';

const longText = 'Clem found that the research steps you ran three times this week share the same inputs. '.repeat(12);

const question = (over: Partial<InboxQuestionRow> = {}): InboxQuestionRow => ({
  id: 'q1', source: 'check_in', question: 'Should I save this research as a workflow?', options: [], context: longText,
  askedAt: '2026-10-01T10:00:00.000Z', urgency: 'normal', agentLabel: 'Clem', sessionId: null, taskId: null,
  workflowName: null, runId: null, stepId: null, answerable: true, unavailableReason: null, ...over,
});
const approval = (id: string, over: Partial<ApprovalRow> = {}): ApprovalRow => ({
  approvalId: id, subject: 'Send a message to the team channel', status: 'pending', requestedAt: '2026-10-01T09:00:00.000Z', ...over,
});
const plan: PlanProposalRow = {
  id: 'p1', proposedAt: '2026-10-01T08:00:00.000Z', status: 'pending', originatingRequest: 'Turn my weekly research into a reusable workflow',
  plan: { objective: 'Save the research steps as a workflow', steps: [{ action: 'Collect the steps' }] },
};

test('a row is one line: long text is cut to a sentence-sized preview, never a wall', () => {
  const view = needsYouRowView({ kind: 'question', id: 'q1', row: question() });
  assert.equal(view.title, 'Should I save this research as a workflow?');
  assert.ok(view.preview && view.preview.length <= 140, view.preview);
  assert.ok(view.preview!.endsWith('…'));
  assert.equal(view.state.tone, 'neutral', 'an ordinary question is not a warning');
  assert.equal(view.context, 'Clem · Check-in');
});

test('a preview never repeats the title', () => {
  const same = needsYouRowView({ kind: 'question', id: 'q2', row: question({ question: 'Pick the next goal step', context: 'Pick the next goal step' }) });
  assert.equal(same.preview, undefined);
  const approvalView = needsYouRowView({ kind: 'approval', id: 'a1', row: approval('a1', { summary: 'Send a message to the team channel' }), aged: false });
  assert.equal(approvalView.preview, undefined);
});

test('order and membership follow the feeds; older approvals sit last; only approvals are batch-decidable', () => {
  const items = buildNeedsYouItems({
    workspaceChoosers: [],
    questions: [question()],
    plans: [plan],
    approvals: [approval('old', { stale: true }), approval('new')],
    trust: [],
    attention: [{ row: { id: 'n1', title: 'Workflow needs attention: weekly-report', body: 'It stopped.', needsYouKey: 'flow:weekly-report' }, collapsedCount: 2, groupIds: ['n1', 'n0', 'nx'] }],
    unlisted: [{ key: 'u1', kind: 'workflow_paused', title: 'Weekly report is paused', detail: 'Waiting for a connection', workflow: 'weekly-report' }],
  });
  assert.deepEqual(items.map((item) => item.id), ['q1', 'p1', 'new', 'n1', 'u1', 'old']);
  const views = items.map(needsYouRowView);
  assert.deepEqual(views.filter((v) => v.checkable).map((v) => v.id), ['new', 'old']);
  assert.equal(views.at(-1)!.aged, true);
  const stopped = views.find((v) => v.id === 'n1')!;
  assert.equal(stopped.state.tone, 'warning', 'a stopped workflow is a real problem');
  assert.match(stopped.context ?? '', /3 reports/);
  assert.equal(views.find((v) => v.id === 'u1')!.href, '/automate?workflow=weekly-report');
});

test('a reference id is never a row preview', () => {
  const view = needsYouRowView({ kind: 'question', id: 'q3', row: question({ context: 'noticing:ntc-mupqxx8k-aa8684' }) });
  assert.equal(view.preview, undefined);
});

test('an attention item links to where it is resolved, by the server key alone', () => {
  assert.deepEqual(attentionDestination('session:sess-desktop-1'), { href: '/chat/sess-desktop-1', label: 'Open the conversation' });
  assert.deepEqual(attentionDestination('flow:weekly report'), { href: '/automate?workflow=weekly%20report', label: 'Open the workflow' });
  assert.equal(attentionDestination('calendar:abc'), undefined);
  assert.equal(attentionDestination(undefined), undefined);
});

test('an approval row is named in words: Clem\'s question, then the subject, never the kind of action', () => {
  const named = (over: Partial<ApprovalRow>) => needsYouRowView({ kind: 'approval', id: 'a', row: approval('a', over), aged: false }).title;
  const kind = { action: 'Workspace source script consent', details: [], unwrapped: false } as unknown as ApprovalRow['presentation'];
  assert.equal(named({ subject: 'Allow the dashboard to refresh every weekday', presentation: kind }), 'Allow the dashboard to refresh every weekday');
  assert.equal(named({ presentation: { ...kind!, ask: 'Can I keep your dashboard up to date?' } as ApprovalRow['presentation'] }), 'Can I keep your dashboard up to date?');
  assert.equal(named({ subject: '', presentation: kind }), 'Workspace source script consent', 'the kind names it only when nothing else does');
});

test('a suggested check-in is decided in place, and a stopped workflow opens by its saved name', () => {
  const proposal = needsYouRowView({ kind: 'unlisted', id: 'proposal:p1',
    row: { key: 'proposal:p1', kind: 'check_in_proposal', title: 'Weekly pipeline check', detail: 'Keep it or turn it down.' } });
  assert.equal(proposal.href, undefined, 'selectable, with Keep it / No thanks in its detail');
  const stopped = needsYouRowView({ kind: 'unlisted', id: 'flow:weekly-digest',
    row: { key: 'flow:weekly-digest', kind: 'workflow_paused', title: 'Weekly Digest stopped after restarting several times',
      detail: 'Open it to resume the run or skip it.', workflow: 'Weekly Digest', workflowSlug: 'weekly-digest' } });
  assert.equal(stopped.href, '/automate?workflow=weekly-digest');
});

test('every kind of ask lands in one of four sections, the same as on the phone', async () => {
  const { needsYouSection, NEEDS_YOU_SECTIONS } = await import('./needs-you-list.js');
  assert.deepEqual(NEEDS_YOU_SECTIONS.map((section) => section.id), ['ok', 'questions', 'stopped', 'suggestions']);
  const unlisted = (kind: 'workflow_binding' | 'workflow_paused' | 'check_in_proposal') =>
    needsYouSection({ kind: 'unlisted', id: kind, row: { key: kind, kind, title: 't', detail: 'd' } });
  assert.equal(unlisted('check_in_proposal'), 'suggestions');
  assert.equal(unlisted('workflow_binding'), 'stopped');
  assert.equal(unlisted('workflow_paused'), 'stopped');
  assert.equal(needsYouSection({ kind: 'workspace', id: 'c', row: {} as never }), 'ok');
  assert.equal(needsYouSection({ kind: 'trust', id: 't', row: {} as never }), 'suggestions');
  assert.equal(needsYouSection({ kind: 'question', id: 'q', row: {} as never }), 'questions');
  assert.equal(needsYouSection({ kind: 'attention', id: 'n', collapsedCount: 0,
    row: { id: 'n', title: 'Pick an account', workflowCapability: { notificationId: 'n', workflow: 'w' } } as never }), 'ok',
    'a stopped workflow that needs an account picked is a choice to make');
});


test('a missing summary leaves summary-only decisions unqualified even when the other feeds loaded', async () => {
  const { needsYouFeedAvailability } = await import('./needs-you-list.js');
  const result = needsYouFeedAvailability({ approvals: false, locations: false, updates: false,
    suggestions: false, plans: false, questions: false, summary: true });
  assert.equal(result.unavailable, false);
  assert.deepEqual(result.failed, ['check-in suggestions and stopped workflows']);
});


test('canonical generic asks fill missing carriers once while preserving rich notification actions', () => {
  const lifecycle = { canDismiss:true,canDefer:true,effect:'hide_only' as const,dismissLabel:'Dismiss',deferLabel:'Tomorrow',generation:'rendered-generation',explanation:'Hide only' };
  const calendar = {key:'calendar:one',kind:'calendar' as const,title:'Review invitation',detail:'Pick an option',createdAt:'',lifecycle};
  const heartbeat = {...calendar,key:'heartbeat:controlled',kind:'notification' as const,title:'Review retained finding'};
  const notification = {id:'notice',title:'Original invitation',needsYouKey:calendar.key,lifecycle};
  const items = buildNeedsYouItems({workspaceChoosers:[],questions:[],plans:[],approvals:[],trust:[],unlisted:[],
    attention:[{row:notification,collapsedCount:0,groupIds:[notification.id]}],attentionItems:[calendar,heartbeat]});
  assert.deepEqual(items.map(item=>[item.kind,item.id]),[['attention','notice'],['generic','heartbeat:controlled']]);
  assert.deepEqual(needsYouAttentionItem(items[0],[calendar,heartbeat]),calendar,'canonical lifecycle and grouping win over the carrier');
  assert.equal(needsYouAttentionItem(items[1],[])?.key,heartbeat.key,'summary-only asks remain actionable');
  assert.equal(needsYouRowView(items[1]).href,undefined,'selecting opens full details before a decision');
  assert.equal(needsYouRowView(items[1]).at,'','missing canonical dates stay absent');
  assert.equal(needsYouAttentionItem({kind:'question',id:'q',row:question()},[calendar]),undefined,'question authority is never replaced');
});

test('a carrier lifecycle remains usable during a failed summary refresh without guessing a generation', () => {
  const lifecycle = { canDismiss:true,canDefer:true,effect:'hide_only' as const,dismissLabel:'Dismiss',deferLabel:'Tomorrow',generation:'exact-carrier-generation',explanation:'Hide only' };
  const item = {kind:'attention' as const,id:'notice',collapsedCount:0,row:{id:'notice',title:'Exact request',needsYouKey:'notification:notice',lifecycle}};
  assert.equal(needsYouAttentionItem(item,[])?.lifecycle.generation,'exact-carrier-generation');
  assert.equal(needsYouAttentionItem({...item,row:{...item.row,lifecycle:undefined}},[]),undefined);
});


test('a workflow notification and its exact summary key render once without merging distinct asks or replacing typed actions',()=>{
  const gate={workflowName:'controlled-flow',displayName:'Controlled flow',reason:'Review before enabling'};
  const row={id:'controlled-notice',title:'Controlled workflow needs a review',needsYouKey:'flow:controlled',workflowEnableGate:gate};
  const common={workspaceChoosers:[],questions:[],plans:[],approvals:[],trust:[],attention:[{row,collapsedCount:0,groupIds:[row.id]}]};
  const items=buildNeedsYouItems({...common,unlisted:[
    {key:'flow:controlled',kind:'workflow_paused',title:row.title,detail:'Paused',workflowSlug:'controlled-flow'},
    {key:'flow:distinct',kind:'workflow_paused',title:row.title,detail:'Paused',workflowSlug:'distinct-flow'},
    {key:'proposal:controlled',kind:'check_in_proposal',title:'Keep this check-in?',detail:'Exact owning decision'},
  ]});
  assert.deepEqual(items.map(item=>[item.kind,item.id]),[['attention',row.id],['unlisted','flow:distinct'],['unlisted','proposal:controlled']]);
  assert.equal(items[0].row,row,'the rich notification retains its owning enable action');
});


test('an old notification link selects its exact retained report and cannot borrow a newer generation', () => {
  const lifecycle = { canDismiss:true,canDefer:true,effect:'hide_only' as const,dismissLabel:'Dismiss',deferLabel:'Tomorrow',generation:'a'.repeat(64),explanation:'Hide only' };
  const latest = {id:'latest',title:'Credit limit',body:'Newest exact source',needsYouKey:'flow:controlled',lifecycle};
  const older = {...latest,id:'older',title:'Permission refused',body:'Older exact source',metadata:{runId:'old-run'}};
  const item = {kind:'attention' as const,id:latest.id,row:latest,reports:[latest,older],collapsedCount:1,groupIds:[latest.id,older.id]};
  assert.equal(needsYouReport(item,'older'),older);
  assert.equal(needsYouReport(item,'missing'),undefined,'an absent child is never replaced with the newest');
  assert.equal(needsYouReport(item,'flow:controlled'),latest,'explicit work navigation can open its leading report');
  const current = {key:'flow:controlled',kind:'workflow' as const,title:'New source',detail:'Changed',createdAt:'',lifecycle:{...lifecycle,generation:'b'.repeat(64)}};
  assert.equal(needsYouAttentionItem(item,[current])?.lifecycle.generation,lifecycle.generation);
});


test('work overview names distinct causes once while preserving all exact report members',()=>{
  const reports=[{id:'credit-new',title:'Review model account',body:'Full credit explanation',needsYouKey:'flow:controlled'},
    {id:'credit-old',title:'Review model account',body:'Full credit explanation',needsYouKey:'flow:controlled'},
    {id:'permission',title:'Review computer access',body:'Full permission explanation',needsYouKey:'flow:controlled'}];
  const item={kind:'attention' as const,id:'credit-new',row:reports[0],reports,collapsedCount:2,groupIds:reports.map(row=>row.id)};
  assert.equal(needsYouRowView(item).preview,'Review model account · Review computer access');
  assert.match(needsYouRowView(item).context??'',/3 reports/);
  assert.equal(needsYouReport(item,'credit-old'),reports[1]);
});
