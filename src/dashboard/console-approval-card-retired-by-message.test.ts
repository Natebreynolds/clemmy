/**
 * Owner rule 2026-10-20: approval cards are always dynamic; if a card is not
 * approved and the owner sends a message instead, the card goes away. A card
 * left waiting after the owner moved on could later be tapped and run an
 * action from a request the owner had already moved past.
 *
 * An unrelated message retires the waiting card at acceptance, before any
 * model work: the registry row stops being pending, the stored action can
 * never run on its own, and nothing is dispatched.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import express from 'express';
import Database from 'better-sqlite3';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-card-retired-by-message-'));
Object.assign(process.env, { CLEMENTINE_HOME: fixtureHome, AUTH_MODE: 'claude_oauth',
  CLEMMY_CLAUDE_AGENT_SDK_BRAIN: 'read_only', CLEMMY_DEBATE_MODE: 'off', MCP_AUTO_IMPORT_ENABLED: 'false',
  CLEMMY_TEST_ISOLATED_HOME: '1', CLEMMY_TEST_DISABLE_LIVE_MODELS: '1', EMBEDDINGS_DISABLED: 'true' });
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
writeFileSync(path.join(fixtureHome, 'state', 'claude-auth.json'), JSON.stringify({ accessToken: 'sk-ant-oat01-route-fixture-token',
  refreshToken: 'route-fixture-refresh', expiresAt: Date.now() + 3600000, scopes: ['user:inference'] }));
const { registerConsoleRoutes } = await import('./console-routes.js');
const events = await import('../runtime/harness/eventlog.js');
const registry = await import('../runtime/harness/approval-registry.js');
const pending = await import('../runtime/harness/pending-actions.js');
const { pendingActionApprovalView } = await import('../runtime/harness/pending-action-view.js');
const resumes = await import('../runtime/harness/chat-approval-resume.js');
const lineage = await import('../runtime/harness/accepted-source-session-branch.js');
const jev = await import('../runtime/jev/client.js');
const { _setApprovedCallDispatchForTests } = await import('../execution/pending-action-executor.js');
const { _setBridgeImplsForTests } = await import('../runtime/harness/respond-bridge.js');

after(async () => {
  // Accepted fixture turns finish asynchronously. Keep their disposable event
  // log until every owned attempt settles; deleting it earlier invents a
  // missing-source warning unrelated to the retirement behavior under test.
  const until = Date.now() + 5000;
  const active = () => (events.openEventLog().prepare('SELECT COUNT(*) AS count FROM run_attempts WHERE finished_at IS NULL').get() as {count:number}).count;
  while (active() > 0 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(active(), 0, 'all controlled accepted turns settle before fixture cleanup');
  _setBridgeImplsForTests({}); _setApprovedCallDispatchForTests(null); resumes._resetChatApprovalResumeForTest();
  jev._setTypesafeKeyForTests(undefined); jev._setSystemOneFetchForTests(undefined);
  events.closeEventLog(); rmSync(fixtureHome, { recursive: true, force: true });
});

async function boot() {
  const app = express(); app.use(express.json());
  registerConsoleRoutes(app, () => true, { respond: async () => { throw new Error('No legacy model'); },
    getRuntime: () => ({ listPendingApprovals: () => [] }) } as never, { serveLegacyAtRoot: false });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { post: (endpoint: string, data: unknown) => fetch(`${url}${endpoint}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
    close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test('a message that does not answer a waiting card retires the card and its stored action', async () => {
  resumes._resetChatApprovalResumeForTest();
  const dispatched: unknown[] = [];
  _setApprovedCallDispatchForTests(async (_tool, payload) => { dispatched.push(payload); return 'ok'; });
  _setBridgeImplsForTests({ configure: (async () => ({ ok: true })) as never,
    claudeAgentBrain: (async () => { throw new Error('TEST FIXTURE: no model in this pin'); }) as never });
  resumes.startChatApprovalResume(async () => { throw new Error('No model resume'); });
  const harness = await boot();
  try {
    const session = events.createSession({ kind: 'chat', channel: 'desktop', metadata: { source: 'desktop' } });
    const action = pending.queuePendingAction({ title: 'TEST FIXTURE post one record', summary: 'One fixture POST.',
      kind: 'shell_command', toolName: 'run_shell_command',
      payload: { command: "curl -sS -X POST -d 'x=1' http://127.0.0.1:1/hook", cwd: fixtureHome }, sessionId: session.id });
    const card = registry.register({ sessionId: session.id, subject: action.title, tool: 'request_approval',
      args: { pendingActionId: action.id, pendingAction: pendingActionApprovalView(action) } });
    events.appendEvent({ sessionId: session.id, turn: 0, role: 'system', type: 'approval_parked',
      data: { approvalId: card.approvalId, tool: card.tool, pendingActionId: action.id } });
    assert.equal(registry.get(card.approvalId)?.status, 'pending');

    const accepted = await harness.post('/api/harness/chat', { input: 'TEST FIXTURE: different topic, what is on my calendar tomorrow?',
      sessionId: session.id, clientRequestId: `card-retire-${session.id}` });
    assert.ok([200, 202].includes(accepted.status), String(accepted.status));
    // The parked card keeps its session busy, so the new message may continue
    // in a successor session; the card it left behind is what must go away.
    await accepted.json();

    assert.equal(registry.get(card.approvalId)?.status, 'cancelled', 'the card the owner moved past is retired, not declined or expired');
    assert.equal(pending.getPendingAction(action.id)?.status, 'cancelled');
    const resolution = events.listEvents(session.id, { types: ['approval_resolved'] }).find(row => row.data.reason === 'owner_moved_on')!;
    assert.ok(resolution);
    assert.equal(resolution.data.decision, 'cancelled');
    const acceptedSource = allHumanSources().at(-1)!;
    assert.ok(resolution.seq < acceptedSource.seq, 'durable retirement precedes acceptance of the new human request');
    const staleTap = await harness.post(`/api/console/pending-actions/${action.id}/approve-execute`, { approvalId: card.approvalId });
    assert.equal(staleTap.status, 409);
    assert.equal(registry.get(card.approvalId)?.status, 'cancelled');
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(dispatched.length, 0, 'nothing ran');
  } finally {
    resumes._resetChatApprovalResumeForTest(); _setBridgeImplsForTests({}); _setApprovedCallDispatchForTests(null); await harness.close();
  }
});


function allHumanSources(): Array<{seq:number}> {
  return events.openEventLog().prepare("SELECT seq FROM events WHERE type='user_input_received' AND role='user' ORDER BY seq").all() as Array<{seq:number}>;
}
function session(channelId?:string) {
  return events.createSession({kind:'chat',channel:'desktop',userId:'desktop',metadata:{source:'desktop',ingressProvider:'desktop',
    userId:'desktop',...(channelId?{channelId}:{})}});
}
function waiting(sessionId:string) {
  const action=pending.queuePendingAction({title:'TEST FIXTURE waiting card',summary:'No external fixture execution.',kind:'shell_command',
    toolName:'run_shell_command',payload:{command:'echo controlled',cwd:fixtureHome},sessionId});
  const card=registry.register({sessionId,subject:action.title,tool:'request_approval',args:{pendingActionId:action.id,pendingAction:pendingActionApprovalView(action)}});
  return {action,card};
}
function noModels() {
  _setBridgeImplsForTests({configure:(async()=>({ok:true})) as never,
    claudeAgentBrain:(async()=>{throw new Error('TEST FIXTURE: no model');}) as never});
  jev._setTypesafeKeyForTests(undefined);
}

test('an unread classifier retires all same-conversation ancestor cards while a same-channel foreign session is preserved',async()=>{
  noModels();const harness=await boot();
  try {
    const parent=session('controlled-card-lineage');const continuity={provider:'desktop',scopeId:null,conversationId:'controlled-card-lineage',audienceId:'desktop'};
    const claim=(id:string,n:string)=>lineage.claimSessionForAcceptedSource({kind:'ordinary',entrySessionId:id,durableSourceId:`card-lineage-${n}`,continuity,
      receipt:{requestId:`card-lineage-${n}`,runId:`card-lineage-${n}`,inputHash:n.padStart(64,'0')}});
    claim(parent.id,'1');
    events.appendEvent({sessionId:parent.id,turn:1,role:'user',type:'user_input_received',data:{text:'Controlled earlier request.'}});
    events.updateSession(parent.id,{status:'cancelled'});
    const childId=claim(parent.id,'2').selection.sessionId;
    assert.notEqual(childId,parent.id);assert.deepEqual(lineage.sameConversationAncestorSessionIds({sessionId:childId,principalId:'desktop'}),[parent.id]);
    const oldA=waiting(parent.id),oldB=waiting(parent.id),current=waiting(childId),foreign=waiting(session('controlled-card-lineage').id);
    const result=await harness.post('/api/harness/chat',{sessionId:childId,input:'TEST FIXTURE unrelated new topic.',clientRequestId:`retire-lineage-${childId}`});
    assert.ok([200,202].includes(result.status),String(result.status));await result.json();
    for(const item of [oldA,oldB,current]) {
      assert.equal(registry.get(item.card.approvalId)?.status,'cancelled');assert.equal(pending.getPendingAction(item.action.id)?.status,'cancelled');
    }
    assert.equal(registry.get(foreign.card.approvalId)?.status,'pending');assert.equal(pending.getPendingAction(foreign.action.id)?.status,'approval_requested');
  } finally {_setBridgeImplsForTests({});await harness.close();}
});

test('a failed action-file reconciliation blocks acceptance, and the same request retries only the cancellation before accepting',async()=>{
  noModels();const harness=await boot();const target=waiting(session().id);
  const lock=pending.pendingActionTransitionLockIdentityForTest(target.action.id);const db=new Database(lock.dbPath);
  db.prepare(`INSERT INTO ${lock.table}(lock_key,owner_pid,owner_token,operation,acquired_at) VALUES(?,?,?,?,?)`)
    .run(lock.lockKey,process.pid,'route-fixture-held','held',Date.now());
  const packet={sessionId:target.action.sessionId,input:'TEST FIXTURE new task after the old card.',clientRequestId:`retire-lock-${target.action.id}`};
  const before=allHumanSources().length;
  try {
    const refused=await harness.post('/api/harness/chat',packet);assert.equal(refused.status,503);
    assert.equal((await refused.json()).code,'APPROVAL_RETIREMENT_PENDING');assert.equal(allHumanSources().length,before);
    assert.equal(registry.get(target.card.approvalId)?.status,'cancelled');assert.equal(pending.getPendingAction(target.action.id)?.status,'approval_requested');
    assert.equal(events.listEvents(target.action.sessionId!,{types:['approval_resolved']}).filter(row=>row.data.reason==='owner_moved_on').length,0);
    db.prepare(`DELETE FROM ${lock.table} WHERE lock_key=? AND owner_token='route-fixture-held'`).run(lock.lockKey);
    const retried=await harness.post('/api/harness/chat',packet);assert.ok([200,202].includes(retried.status),String(retried.status));await retried.json();
    assert.equal(allHumanSources().length,before+1);assert.equal(pending.getPendingAction(target.action.id)?.status,'cancelled');
    assert.equal(events.listEvents(target.action.sessionId!,{types:['approval_resolved']}).filter(row=>row.data.reason==='owner_moved_on').length,1);
  } finally {db.prepare(`DELETE FROM ${lock.table} WHERE lock_key=? AND owner_token='route-fixture-held'`).run(lock.lockKey);db.close();_setBridgeImplsForTests({});await harness.close();}
});

test('replaying an already accepted request cannot retire a newer waiting card',async()=>{
  noModels();const harness=await boot();
  try {
    const target=session();const packet={sessionId:target.id,input:'TEST FIXTURE first request.',clientRequestId:`retire-replay-${target.id}`};
    const first=await harness.post('/api/harness/chat',packet);assert.ok([200,202].includes(first.status),String(first.status));
    const accepted=await first.json() as {sessionId:string};const newer=waiting(accepted.sessionId);const count=allHumanSources().length;
    const replay=await harness.post('/api/harness/chat',packet);assert.ok([200,202].includes(replay.status),String(replay.status));await replay.json();
    assert.equal(allHumanSources().length,count);assert.equal(registry.get(newer.card.approvalId)?.status,'pending');assert.equal(pending.getPendingAction(newer.action.id)?.status,'approval_requested');
  } finally {_setBridgeImplsForTests({});await harness.close();}
});

test('exact approve and decline answers retain their original decision semantics rather than retiring the card',async()=>{
  noModels();const harness=await boot();
  try {
    for(const [word,resolution] of [['approve','approved'],['reject','rejected']] as const) {
      const target=waiting(session().id);const result=await harness.post('/api/harness/chat',{sessionId:target.action.sessionId,
        input:`${word} ${target.card.approvalId}`,clientRequestId:`retire-answer-${target.action.id}`});
      assert.equal(result.status,202);await result.json();assert.equal(registry.get(target.card.approvalId)?.resolution,resolution);
      assert.equal(events.listEvents(target.action.sessionId!,{types:['approval_resolved']}).filter(row=>row.data.reason==='owner_moved_on').length,0);
    }
  } finally {_setBridgeImplsForTests({});await harness.close();}
});

test('a sure change answer revises only its exact card and does not retire another waiting card in the conversation',async()=>{
  noModels();const harness=await boot();
  try {
    const parent=session('controlled-change-lineage');const continuity={provider:'desktop',scopeId:null,conversationId:'controlled-change-lineage',audienceId:'desktop'};
    const claim=(id:string,n:string)=>lineage.claimSessionForAcceptedSource({kind:'ordinary',entrySessionId:id,durableSourceId:`card-change-${n}`,continuity,
      receipt:{requestId:`card-change-${n}`,runId:`card-change-${n}`,inputHash:n.padStart(64,'0')}});
    claim(parent.id,'1');events.updateSession(parent.id,{status:'cancelled'});const child=claim(parent.id,'2').selection.sessionId;
    const ancestor=waiting(parent.id),target=waiting(child);
    jev._setTypesafeKeyForTests('ts_fixture');jev._setSystemOneFetchForTests(async()=>({status:200,ok:true,text:async()=>JSON.stringify({
      model:'jev-1.13.0',answers:{reply:{type:'choice',choice:'changes',confidence:.99,probabilities:{changes:.99}}},usage:{input_tokens:5,output_tokens:1}})}));
    const result=await harness.post('/api/harness/chat',{sessionId:child,input:'Make the exact waiting action shorter.',clientRequestId:`retire-change-${target.action.id}`});
    assert.ok([200,202].includes(result.status),String(result.status));await result.json();
    assert.equal(registry.get(target.card.approvalId)?.resolution,'rejected');assert.equal(pending.getPendingAction(target.action.id)?.status,'rejected');
    assert.equal(registry.get(ancestor.card.approvalId)?.status,'pending');
    assert.equal(events.listEvents(child,{types:['approval_resolved']}).filter(row=>row.data.reason==='owner_moved_on').length,0);
  } finally {jev._setTypesafeKeyForTests(undefined);jev._setSystemOneFetchForTests(undefined);_setBridgeImplsForTests({});await harness.close();}
});
