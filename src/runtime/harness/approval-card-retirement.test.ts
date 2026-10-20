/** Exact owner-moving-on cancellation; no models, providers or executors. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import Database from 'better-sqlite3';

const home=mkdtempSync(path.join(os.tmpdir(),'clem-card-retirement-'));
Object.assign(process.env,{CLEMENTINE_HOME:home,CLEMMY_TEST_ISOLATED_HOME:'1',CLEMMY_TEST_DISABLE_LIVE_MODELS:'1',
  MCP_AUTO_IMPORT_ENABLED:'false',EMBEDDINGS_DISABLED:'true'});
mkdirSync(path.join(home,'state'),{recursive:true});
const events=await import('./eventlog.js');
const registry=await import('./approval-registry.js');
const pending=await import('./pending-actions.js');
const {pendingActionApprovalView}=await import('./pending-action-view.js');
after(()=>{events.closeEventLog();rmSync(home,{recursive:true,force:true});});

function card(sessionId=events.createSession({kind:'chat',channel:'desktop',userId:'desktop'}).id) {
  const action=pending.queuePendingAction({title:'Controlled waiting action',summary:'No execution in this fixture.',kind:'shell_command',
    toolName:'run_shell_command',payload:{command:'echo controlled',cwd:home,timeout_ms:1000},sessionId});
  const approval=registry.register({sessionId,subject:action.title,tool:'request_approval',
    args:{pendingActionId:action.id,pendingAction:pendingActionApprovalView(action)}});
  return {sessionId,actionId:action.id,approvalId:approval.approvalId,payloadHash:action.payloadHash};
}
const recordFile=(id:string)=>path.join(pending.PENDING_ACTIONS_DIR,`${id}.json`);
const cancellationEvents=(sessionId:string)=>events.listEvents(sessionId,{types:['approval_resolved']})
  .filter(row=>row.data.reason==='owner_moved_on');

test('all waiting formal cards in the supplied proven conversation retire, foreign cards remain untouched',()=>{
  const first=card();const second=card(first.sessionId);const foreign=card();
  const result=registry.retireFormalApprovalsForNewMessage([first.sessionId]);
  assert.deepEqual(new Set(result.retiredApprovalIds),new Set([first.approvalId,second.approvalId]));
  for(const current of [first,second]) {
    assert.equal(registry.get(current.approvalId)?.status,'cancelled');
    assert.equal(pending.getPendingAction(current.actionId)?.status,'cancelled');
    assert.equal(pending.getPendingAction(current.actionId)?.resultSummary,'Not run: you moved on to a new message.');
    assert.equal(registry.resolve(current.approvalId,'approved','desktop-chat-card').ok,false,'a stale tap cannot reopen the retired card');
  }
  assert.equal(cancellationEvents(first.sessionId).length,2);
  assert.ok(cancellationEvents(first.sessionId).every(row=>row.data.decision==='cancelled'&&row.data.resolution==='cancelled_by_system'));
  assert.equal(registry.get(foreign.approvalId)?.status,'pending');assert.equal(pending.getPendingAction(foreign.actionId)?.status,'approval_requested');
  assert.deepEqual(registry.retireFormalApprovalsForNewMessage([first.sessionId]).retiredApprovalIds,[]);
  assert.equal(cancellationEvents(first.sessionId).length,2,'replay adds no duplicate decision event');
});

test('a completed cancellation checkpoint survives action file cleanup and does not block later messages',()=>{
  const current=card();registry.retireFormalApprovalsForNewMessage([current.sessionId]);
  const proof=cancellationEvents(current.sessionId)[0]!;
  assert.deepEqual(proof.data.retirement,{version:1,pendingActionId:current.actionId,payloadHash:current.payloadHash,outcome:'action_cancelled',actionStatus:'cancelled'});
  rmSync(recordFile(current.actionId));
  assert.deepEqual(registry.retireFormalApprovalsForNewMessage([current.sessionId]).retiredApprovalIds,[]);
  assert.equal(cancellationEvents(current.sessionId).length,1);
  assert.equal(registry.reconcileLinkedPendingActionResolution(registry.get(current.approvalId)!),true);
  const next=card(current.sessionId);registry.retireFormalApprovalsForNewMessage([current.sessionId]);
  assert.equal(pending.getPendingAction(next.actionId)?.status,'cancelled');
});

test('a receipt accepted during reply reading prevents retirement of a newer card',()=>{
  const current=card();const requestId=`controlled-retirement-race-${current.actionId}`;
  events.claimHarnessChatRequest({requestId,sessionId:current.sessionId,runId:requestId,inputHash:'a'.repeat(64),sinceSeq:events.getLatestEventSeq(current.sessionId)});
  assert.deepEqual(registry.retireFormalApprovalsForNewMessage([current.sessionId],requestId).retiredApprovalIds,[]);
  assert.equal(registry.get(current.approvalId)?.status,'pending');assert.equal(pending.getPendingAction(current.actionId)?.status,'approval_requested');
  assert.equal(cancellationEvents(current.sessionId).length,0);
});

test('an approval which wins first remains owned and is never cancelled',()=>{
  const current=card();assert.equal(registry.resolve(current.approvalId,'approved','desktop-chat-card').ok,true);
  const before=readFileSync(recordFile(current.actionId));
  assert.deepEqual(registry.retireFormalApprovalsForNewMessage([current.sessionId]).retiredApprovalIds,[]);
  assert.equal(registry.get(current.approvalId)?.resolution,'approved');assert.equal(pending.getPendingAction(current.actionId)?.status,'approved');
  assert.deepEqual(readFileSync(recordFile(current.actionId)),before);assert.equal(cancellationEvents(current.sessionId).length,0);
});

test('acquired and uncertain retained actions stay owned without blocking a new message',()=>{
  for(const status of ['approved','executing','failed'] as const) {
    const current=card();
    pending.markPendingActionApprovalResolved(current.actionId,'approved',current.approvalId,'fixture-owner',
      {by:'policy',evidence:{kind:'policy',scope:'controlled-local-work'}});
    if(status!=='approved') {
      const claim=pending.claimPendingActionExecution(current.actionId,'fixture-executor');assert.equal(claim.claimed,true);
      if(status==='failed') pending.recordPendingActionResult(current.actionId,'failed','Controlled uncertain result.','fixture-executor',claim.claimToken);
    }
    const file=recordFile(current.actionId);const before=readFileSync(file);
    assert.deepEqual(registry.retireFormalApprovalsForNewMessage([current.sessionId]).retiredApprovalIds,[]);
    assert.deepEqual(readFileSync(file),before);assert.equal(registry.get(current.approvalId)?.status,'pending');
    assert.equal(cancellationEvents(current.sessionId).length,0);
  }
});

test('a malformed retained owner refuses retirement without changing the card or action',()=>{
  const current=card();const file=recordFile(current.actionId);const record=pending.getPendingAction(current.actionId)!;
  writeFileSync(file,JSON.stringify({...record,status:'executing',executionClaimTokenHash:'not-a-proof',executionClaimedBy:'fixture'}));
  const before=readFileSync(file);assert.throws(()=>registry.retireFormalApprovalsForNewMessage([current.sessionId]),/owner could not be safely verified/);
  assert.deepEqual(readFileSync(file),before);assert.equal(registry.get(current.approvalId)?.status,'pending');assert.equal(cancellationEvents(current.sessionId).length,0);
});

test('a cancellation race closes the question but checkpoints an exact already-owned action without changing it',()=>{
  const current=card();pending.markPendingActionApprovalResolved(current.actionId,'approved',current.approvalId,'fixture-owner',
    {by:'policy',evidence:{kind:'policy',scope:'controlled-local-work'}});
  const claim=pending.claimPendingActionExecution(current.actionId,'fixture-executor');assert.equal(claim.claimed,true);
  events.openEventLog().prepare("UPDATE pending_approvals SET status='cancelled',resolution='cancelled_by_system',resolver='owner_moved_on',resolved_at=? WHERE approval_id=?")
    .run(new Date().toISOString(),current.approvalId);
  const before=readFileSync(recordFile(current.actionId));registry.retireFormalApprovalsForNewMessage([current.sessionId]);
  assert.deepEqual(readFileSync(recordFile(current.actionId)),before);assert.equal(pending.getPendingAction(current.actionId)?.status,'executing');
  assert.deepEqual(cancellationEvents(current.sessionId)[0]!.data.retirement,{version:1,pendingActionId:current.actionId,payloadHash:current.payloadHash,
    outcome:'already_owned',actionStatus:'executing'});
  rmSync(recordFile(current.actionId));registry.retireFormalApprovalsForNewMessage([current.sessionId]);assert.equal(cancellationEvents(current.sessionId).length,1);
});

test('a legacy null link needs the exact frozen card, not merely the same payload',()=>{
  const current=card();const record=pending.getPendingAction(current.actionId)!;
  writeFileSync(recordFile(current.actionId),JSON.stringify({...record,status:'queued',approvalId:null}));
  registry.retireFormalApprovalsForNewMessage([current.sessionId]);assert.equal(pending.getPendingAction(current.actionId)?.status,'cancelled');
  const other=card(current.sessionId);const before=readFileSync(recordFile(other.actionId));
  pending.recordPendingActionResult(other.actionId,'cancelled','Must not apply.','approval-registry',undefined,
    {sessionId:current.sessionId,approvalId:current.approvalId,payloadHash:other.payloadHash});
  assert.deepEqual(readFileSync(recordFile(other.actionId)),before,'a matching payload cannot borrow another action/card identity');
});

test('a failed registry transaction publishes no cancellation and writes no action file',()=>{
  const current=card();const db=events.openEventLog();const before=readFileSync(recordFile(current.actionId));
  db.exec(`CREATE TRIGGER fixture_refuse_retirement BEFORE UPDATE ON pending_approvals
    WHEN NEW.approval_id='${current.approvalId}' BEGIN SELECT RAISE(ABORT,'controlled retirement rollback'); END;`);
  try {assert.throws(()=>registry.retireFormalApprovalsForNewMessage([current.sessionId]),/controlled retirement rollback/);}
  finally{db.exec('DROP TRIGGER fixture_refuse_retirement');}
  assert.equal(registry.get(current.approvalId)?.status,'pending');assert.deepEqual(readFileSync(recordFile(current.actionId)),before);
  assert.equal(cancellationEvents(current.sessionId).length,0);
});

test('file-lock contention leaves a durable cancelled card, refuses completion, and converges without replay',()=>{
  const current=card();const lock=pending.pendingActionTransitionLockIdentityForTest(current.actionId);const db=new Database(lock.dbPath);
  db.prepare(`INSERT INTO ${lock.table}(lock_key,owner_pid,owner_token,operation,acquired_at) VALUES(?,?,?,?,?)`)
    .run(lock.lockKey,process.pid,'fixture-held','held',Date.now());
  try {
    assert.throws(()=>registry.retireFormalApprovalsForNewMessage([current.sessionId]),/still being saved/);
    assert.equal(registry.get(current.approvalId)?.status,'cancelled');assert.equal(pending.getPendingAction(current.actionId)?.status,'approval_requested');
    assert.equal(cancellationEvents(current.sessionId).length,0,'no completed cancellation is published before file reconciliation');
    assert.equal(registry.resolve(current.approvalId,'approved','desktop-chat-card').ok,false);
  } finally {db.prepare(`DELETE FROM ${lock.table} WHERE lock_key=? AND owner_token='fixture-held'`).run(lock.lockKey);db.close();}
  registry.retireFormalApprovalsForNewMessage([current.sessionId]);assert.equal(pending.getPendingAction(current.actionId)?.status,'cancelled');
  assert.equal(cancellationEvents(current.sessionId).length,1);
});

test('a competing file transition which wins the real lock cannot be overwritten by the guarded cancellation',async()=>{
  const current=card();const main=events.openEventLog();
  // Only the guard is exercised here; the real retirement helper's separate
  // transactional/event behavior is covered above and by the public route pin.
  main.prepare("UPDATE pending_approvals SET status='cancelled',resolution='cancelled_by_system',resolver='owner_moved_on',resolved_at=? WHERE approval_id=?")
    .run(new Date().toISOString(),current.approvalId);
  const lock=pending.pendingActionTransitionLockIdentityForTest(current.actionId);
  const ready=path.join(home,`ready-${current.actionId}`);const go=`${ready}-go`;
  const config={...lock,file:recordFile(current.actionId),ready,go};
  const program=`const fs=require('node:fs');const Database=require(${JSON.stringify(createRequire(import.meta.url).resolve('better-sqlite3'))});const c=${JSON.stringify(config)};
    const d=new Database(c.dbPath);const watchdog=setTimeout(()=>{try{d.prepare('DELETE FROM '+c.table+' WHERE lock_key=? AND owner_token=?').run(c.lockKey,'worker-winner');d.close();}finally{process.exit(2);}},5000);d.prepare('INSERT INTO '+c.table+'(lock_key,owner_pid,owner_token,operation,acquired_at) VALUES(?,?,?,?,?)').run(c.lockKey,process.pid,'worker-winner','fixture-winner',Date.now());fs.writeFileSync(c.ready,'ready');
    const timer=setInterval(()=>{if(!fs.existsSync(c.go))return;clearInterval(timer);setTimeout(()=>{const r=JSON.parse(fs.readFileSync(c.file,'utf8'));r.status='approved';r.approvedBy='human';fs.writeFileSync(c.file+'.winner',JSON.stringify(r));fs.renameSync(c.file+'.winner',c.file);d.prepare('DELETE FROM '+c.table+' WHERE lock_key=? AND owner_token=?').run(c.lockKey,'worker-winner');d.close();clearTimeout(watchdog);},80);},5);`;
  const child=spawn(process.execPath,['-e',program],{stdio:['ignore','ignore','pipe']});let errors='';child.stderr.on('data',chunk=>{errors+=String(chunk);});
  const exited=new Promise<number|null>(resolve=>child.once('close',resolve));
  const until=Date.now()+5000;while(!readFileSafe(ready)&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(readFileSafe(ready),'controlled competing owner acquired the transition lock');writeFileSync(go,'go');
  const started=Date.now();const result=pending.recordPendingActionResult(current.actionId,'cancelled','Must not overwrite.','approval-registry',undefined,
    {sessionId:current.sessionId,approvalId:current.approvalId,payloadHash:current.payloadHash});
  assert.ok(Date.now()-started>=40,'cancellation waited for the actual competing transition lock');
  assert.equal(await exited,0,errors);assert.equal(result?.status,'approved');assert.equal(pending.getPendingAction(current.actionId)?.status,'approved');
  assert.notEqual(pending.getPendingAction(current.actionId)?.resultSummary,'Must not overwrite.');
});

function readFileSafe(file:string):boolean {try{return readFileSync(file,'utf8')==='ready';}catch{return false;}}
