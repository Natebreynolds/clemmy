import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
const home=mkdtempSync(path.join(os.tmpdir(),'clem-approved-action-completion-'));
process.env.CLEMENTINE_HOME=home;
process.env.COMPOSIO_BACKEND='sdk';
mkdirSync(path.join(home,'state'),{recursive:true});
const events=await import('./eventlog.js');
const actions=await import('./pending-actions.js');
const registry=await import('./approval-registry.js');
const resume=await import('./chat-approval-resume.js');
const executor=await import('../../execution/pending-action-executor.js');
const {pendingActionApprovalView}=await import('./pending-action-view.js');
const {loadAcceptedTaskAuthority}=await import('./accepted-task-authority.js');
const {readPendingActionPublicResult}=await import('./pending-action-result-reader.js');
const proof=await import('./approved-action-completion-proof.js');
const receipt=await import('./approved-action-completion-receipt.js');
const {actionBus}=await import('../action-bus.js');
const {recordAcceptedSourceGraph}=await import('./record-accepted-source-graph.js');
const {requireAcceptedTaskAuthority}=await import('./accepted-task-authority.js');
const {requireActionExpectedWorkActivation}=await import('./action-expected-work-boundary.js');
const {ToolCallsCounter,withHarnessRunContext}=await import('./brackets.js');
const {commitTurnOutcome}=await import('./delivery-committer.js');
const {turnOutcomeId}=await import('./turn-outcome.js');
const {authorizeResolvedLogicalCallContract,currentLogicalCall,withPhysicalDispatch,withPhysicalPreparationDispatch}=await import('./attempt-identity.js');
const {settleToolAttempt}=await import('./attempt-settlement.js');

after(()=>{resume._resetChatApprovalResumeForTest();events.closeEventLog();rmSync(home,{recursive:true,force:true});});
beforeEach(()=>resume._resetChatApprovalResumeForTest());

async function controlledAction(interruptAfterSuccess=false, realShell=false) {
  const session=events.createSession({kind:'chat'});
  const action=actions.queuePendingAction({title:'Run the controlled exact call',summary:'Named no-provider fixture.',kind:'shell_command',
    toolName:'run_shell_command',payload:{command:realShell ? "ssh -G -F /dev/null localhost | grep -m1 '^hostname '" : 'echo controlled-exact-result',cwd:home,timeout_ms:20000},sessionId:session.id});
  const card=registry.register({sessionId:session.id,subject:action.title,tool:'request_approval',
    args:{pendingActionId:action.id,pendingAction:pendingActionApprovalView(action)}});
  let calls=0;
  executor._setApprovedCallDispatchForTests(realShell ? null : async()=>{
    calls++;
    if(interruptAfterSuccess) {
      const active=events.getActiveRunAttempt(session.id)!;
      events.requestKill(session.id,'Controlled Stop.',{attemptId:active.attemptId});
    }
    return 'exit_code: 0\nstdout:\ncontrolled-exact-result';
  });
  const row=registry.resolve(card.approvalId,'approved','desktop-chat-card').row!;
  await resume.handleResolvedApprovalForChatResume(row,async()=>assert.fail('no model handoff'));
  const source=events.listEvents(session.id,{types:['user_input_received']}).find(event=>event.data.approvalId===card.approvalId)!;
  const terminal=events.listEvents(session.id,{types:['conversation_completed']}).find(event=>event.data.sourceUserSeq===source.seq);
  return {session,action:actions.getPendingAction(action.id)!,row,source,terminal,calls:()=>calls};
}

test('a real host invocation seals its exact synthetic decision and canonical successful terminal without replay',async()=>{
  const current=await controlledAction();
  assert.equal(current.action.status,'executed',current.action.resultSummary??'');
  const loaded=loadAcceptedTaskAuthority(current.session.id,current.source.seq);
  assert.equal(loaded.status,'ok');if(loaded.status!=='ok')return;
  assert.equal(loaded.authority.state,'terminal');
  assert.equal(loaded.authority.terminalEventId,current.terminal?.id);
  assert.ok(loaded.authority.hostCompletionReceiptId?.startsWith('approved-action-receipt:v1:'));
  assert.equal(events.readValidatedTerminalEvent(loaded.authority.terminalEventId!,current.session.id,current.source.seq).id,current.terminal?.id);
  assert.equal(readPendingActionPublicResult(current.action)?.source,'terminal');
  assert.equal(current.calls(),1);
  await resume.handleResolvedApprovalForChatResume(current.row,async()=>assert.fail('no model handoff'));
  assert.equal(receipt.prepareApprovedActionHostCompletion({sessionId:current.session.id,sourceUserSeq:current.source.seq}).status,'redeemed');
  assert.equal(current.calls(),1);
  assert.equal(events.openEventLog().prepare('SELECT count(*) AS n FROM physical_dispatches WHERE session_id=? AND source_user_seq=?')
    .get(current.session.id,current.source.seq)?.n,1);
});

test('Stop during the exact call cannot publish successful completion or dispatch again',async()=>{
  const current=await controlledAction(true);
  assert.equal(current.calls(),1);
  assert.notEqual((current.terminal?.data.turnOutcome as {status?:string})?.status,'done');
  assert.notEqual(receipt.prepareApprovedActionHostCompletion({sessionId:current.session.id,sourceUserSeq:current.source.seq}).status,'redeemed');
  await resume.handleResolvedApprovalForChatResume(current.row,async()=>assert.fail('no model handoff'));
  assert.equal(current.calls(),1);
});

test('the actual shell tool closes synthetic B for an approved off-machine command without a provider or model',
  {skip:(process.platform==='win32' || spawnSync('ssh',['-V'],{stdio:'ignore'}).status!==0) && 'Mac/Linux controlled ssh fixture'},async()=>{
  const current=await controlledAction(false,true);
  assert.equal(current.action.status,'executed',current.action.resultSummary??'');
  const loaded=loadAcceptedTaskAuthority(current.session.id,current.source.seq);
  assert.equal(loaded.status,'ok');if(loaded.status!=='ok')return;
  assert.equal(loaded.authority.state,'terminal');
  assert.equal(loaded.authority.terminalEventId,current.terminal?.id);
  assert.match(current.action.resultSummary??'',/hostname localhost/);
  assert.equal(readPendingActionPublicResult(current.action)?.source,'terminal');
  const rows=events.openEventLog().prepare('SELECT state FROM physical_dispatches WHERE session_id=? AND source_user_seq=?')
    .all(current.session.id,current.source.seq);
  assert.deepEqual(rows,[{state:'returned'}]);
  await resume.handleResolvedApprovalForChatResume(current.row,async()=>assert.fail('no model handoff'));
  assert.equal(events.openEventLog().prepare('SELECT count(*) n FROM physical_dispatches WHERE session_id=? AND source_user_seq=?')
    .get(current.session.id,current.source.seq)?.n,1);
});

test('receipt rows and pre-dispatch intent are immutable; tampered live settlement cannot be replayed as proof',async()=>{
  const current=await controlledAction();const db=events.openEventLog();
  const identity={sessionId:current.session.id,sourceUserSeq:current.source.seq};
  const before=proof.proveApprovedActionCompletionInTransaction(db,identity);
  assert.throws(()=>db.prepare("UPDATE approved_action_completion_intents_v1 SET intent_json='{}' WHERE session_id=?").run(current.session.id),/immutable/);
  assert.throws(()=>db.prepare("UPDATE approved_action_completion_receipts_v1 SET receipt_json='{}' WHERE session_id=?").run(current.session.id),/immutable/);
  const triggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='logical_call_settlements'").all() as Array<{name:string;sql:string}>;
  for(const trigger of triggers)db.exec(`DROP TRIGGER ${trigger.name}`);
  const old=db.prepare('SELECT semantic_digest FROM logical_call_settlements WHERE session_id=? AND source_user_seq=?').get(identity.sessionId,identity.sourceUserSeq) as {semantic_digest:string};
  db.prepare("UPDATE logical_call_settlements SET semantic_digest=? WHERE session_id=? AND source_user_seq=?")
    .run('f'.repeat(64),identity.sessionId,identity.sourceUserSeq);
  assert.throws(()=>proof.proveApprovedActionCompletionInTransaction(db,identity),/semantic digest/);
  db.prepare('UPDATE logical_call_settlements SET semantic_digest=? WHERE session_id=? AND source_user_seq=?')
    .run(old.semantic_digest,identity.sessionId,identity.sourceUserSeq);
  for(const trigger of triggers)db.exec(trigger.sql);
  assert.equal(proof.proveApprovedActionCompletionInTransaction(db,identity).receipt.resultHandleId,before.receipt.resultHandleId);
});

test('a foreign attempt Stop sharing the run family does not latch onto completed B',async()=>{
  const current=await controlledAction();const db=events.openEventLog();
  const owner=events.getRunAttemptBySourceUserSeq(current.session.id,current.source.seq)!;
  db.prepare(`INSERT INTO run_attempts(attempt_id,session_id,run_id,started_at,status,finished_at)
    VALUES(?,?,?,?,?,?)`).run('foreign-approval-retry',current.session.id,owner.runId,new Date().toISOString(),'completed',new Date().toISOString());
  events.requestKill(current.session.id,'Controlled unrelated retry Stop.',{attemptId:'foreign-approval-retry'});
  assert.doesNotThrow(()=>proof.proveApprovedActionCompletionInTransaction(db,{sessionId:current.session.id,sourceUserSeq:current.source.seq}));
});

test('Stop after receipt issuance keeps the receipt and publishes a readable cancelled B',async()=>{
  let stopped=false;
  const detach=actionBus.subscribe(event=>{
    if(event.kind!=='harness.event' || event.event.type!=='approved_action_completion_receipt')return;
    const seq=Number(event.event.data.sourceUserSeq);
    const attempt=events.getRunAttemptBySourceUserSeq(event.sessionId,seq)!;
    events.requestKill(event.sessionId,'Controlled receipt-to-terminal Stop.',{attemptId:attempt.attemptId});
    events.finishRunAttempt(attempt,'cancelled');stopped=true;
  });
  let current:Awaited<ReturnType<typeof controlledAction>>;
  try {current=await controlledAction();}finally{detach();}
  assert.equal(stopped,true);
  assert.equal((current!.terminal?.data.turnOutcome as {status?:string})?.status,'cancelled');
  const read=events.readAcceptedTaskTerminalPublication(current!.session.id,current!.source.seq);
  assert.equal(read.status,'published',JSON.stringify(read));
  assert.equal(events.readValidatedTerminalEvent(current!.terminal!.id,current!.session.id,current!.source.seq).id,current!.terminal!.id);
  assert.equal(current!.calls(),1);
});

test('a Stop dated after a completed terminal does not invalidate its historical exact winner',async()=>{
  const current=await controlledAction();const db=events.openEventLog();
  const owner=events.getRunAttemptBySourceUserSeq(current.session.id,current.source.seq)!;
  events.requestKill(current.session.id,'Controlled later Stop.',{attemptId:owner.attemptId});
  db.prepare('UPDATE run_kill_requests SET requested_at=? WHERE session_id=?')
    .run(new Date(Date.parse(current.terminal!.createdAt)+60000).toISOString(),current.session.id);
  const read=events.readAcceptedTaskTerminalPublication(current.session.id,current.source.seq);
  assert.equal(read.status,'published',JSON.stringify(read));
});

test('Stop on a newer attempt for the same B prevents done after the original invocation settled',async()=>{
  let stopped=false;
  const detach=actionBus.subscribe(event=>{
    if(event.kind!=='harness.event' || event.event.type!=='approved_action_completion_receipt')return;
    const seq=Number(event.event.data.sourceUserSeq);
    const old=events.getRunAttemptBySourceUserSeq(event.sessionId,seq)!;
    events.finishRunAttempt(old,'interrupted');
    const retry=events.beginRunAttempt(event.sessionId,{runId:old.runId??'controlled-B-retry'});
    events.recordRunAttemptUserInput(retry,{turn:event.event.turn,role:'user',data:{}},{existingEventSeq:seq,armRunInFlight:false});
    events.requestKill(event.sessionId,'Controlled newer-B Stop.',{sourceUserSeq:seq});
    events.finishRunAttempt(retry,'cancelled');stopped=true;
  });
  let current:Awaited<ReturnType<typeof controlledAction>>;
  try{current=await controlledAction();}finally{detach();}
  assert.equal(stopped,true);
  assert.equal((current!.terminal?.data.turnOutcome as {status?:string})?.status,'cancelled');
  assert.equal(events.readAcceptedTaskTerminalPublication(current!.session.id,current!.source.seq).status,'published');
  assert.equal(current!.calls(),1);
});

/** Execute through the ordinary host kernel, leaving its exact B terminal to
 * the committer so tests can place a Stop at its last two publication edges. */
async function executedBForCommitter() {
  const session=events.createSession({kind:'chat'});
  const action=actions.queuePendingAction({title:'Observe one controlled call',summary:'No-provider publication-race fixture.',
    kind:'shell_command',toolName:'run_shell_command',payload:{command:'echo controlled-exact-result',cwd:home,timeout_ms:20000},sessionId:session.id});
  const card=registry.register({sessionId:session.id,subject:action.title,tool:'request_approval',
    args:{pendingActionId:action.id,pendingAction:pendingActionApprovalView(action)}});
  registry.resolve(card.approvalId,'approved','desktop-chat-card');
  actions.markPendingActionApprovalResolved(action.id,'approved',card.approvalId);
  const attempt=events.beginRunAttempt(session.id,{runId:`approval-resume:${card.approvalId}`});
  const source=events.recordRunAttemptUserInput(attempt,{turn:0,role:'user',data:{text:`Approve ${card.approvalId}.`,
    synthetic:true,source:'approval_resume',approvalId:card.approvalId,decision:'approve'}},{armRunInFlight:true});
  const identity={sessionId:session.id,sourceUserSeq:source.seq,turn:source.turn};
  await recordAcceptedSourceGraph({identity,surface:'approval_resume',acceptedText:String(source.data.text)});
  requireAcceptedTaskAuthority(identity);requireActionExpectedWorkActivation(identity);
  let calls=0;
  executor._setApprovedCallDispatchForTests(async()=>{calls++;return 'exit_code: 0\nstdout:\ncontrolled-exact-result';});
  const execution=await withHarnessRunContext({...identity,runAttemptId:attempt.attemptId,behaviorScopeId:attempt.runId!,counter:new ToolCallsCounter(1)},
    ()=>executor.executeApprovedPendingActionCall(action.id,{sessionId:session.id,sourceUserSeq:source.seq}));
  assert.equal(execution.status,'executed',JSON.stringify(execution));
  return {session,action,attempt,source,identity,calls:()=>calls,
    outcome:{version:2 as const,id:turnOutcomeId(identity),identity,status:'done' as const,resumable:false as const,
      presentation:{kind:'answer' as const,text:'The exact approved command returned its saved result.'}}};
}

test('the committer publishes cancelled when receipt notification settles the exact B attempt as cancelled',async()=>{
  const current=await executedBForCommitter();let stopped=false;
  const detach=actionBus.subscribe(event=>{
    if(event.kind!=='harness.event'||event.event.type!=='approved_action_completion_receipt'||event.sessionId!==current.session.id)return;
    events.requestKill(current.session.id,'Controlled assessment Stop.',{attemptId:current.attempt.attemptId});
    events.finishRunAttempt(current.attempt,'cancelled');stopped=true;
  });
  let result:ReturnType<typeof commitTurnOutcome>;
  try{result=commitTurnOutcome(current.outcome);}finally{detach();}
  assert.equal(stopped,true);assert.equal(result!.presentation.status,'cancelled');
  assert.equal(result!.event.data.hostNotice?.code,'stopped');
  assert.equal(result!.event.data.completionVerdictRef,undefined);
  assert.equal(events.readAcceptedTaskTerminalPublication(current.session.id,current.source.seq).status,'published');
  assert.equal(current.calls(),1);
});

test('a Stop after projection is caught by the final CAS and retries only B terminal as cancelled',async()=>{
  const current=await executedBForCommitter();
  assert.equal(receipt.prepareApprovedActionHostCompletion(current.identity).status,'redeemed');
  const db=events.openEventLog();const originalPrepare=db.prepare;let stopped=false;
  // Pause only the isolated DB's first public-terminal lookup, immediately
  // before appendTerminalEventOnce enters its own authority transaction.
  db.prepare=function(sql:string){
    const statement=originalPrepare.call(this,sql);
    if(sql.includes("json_extract(data_json, '$.terminalKey') = ?")) {
      const get=statement.get.bind(statement);
      statement.get=(...args:unknown[])=>{
        if(!stopped&&args[0]===current.session.id){stopped=true;events.requestKill(current.session.id,
          'Controlled final-publication Stop.',{attemptId:current.attempt.attemptId});}
        return get(...args);
      };
    }
    return statement;
  } as typeof db.prepare;
  let result:ReturnType<typeof commitTurnOutcome>;
  try{result=commitTurnOutcome(current.outcome);}finally{db.prepare=originalPrepare;}
  assert.equal(stopped,true);assert.equal(result!.presentation.status,'cancelled');
  assert.equal(result!.event.data.hostNotice?.code,'stopped');
  assert.equal(result!.event.data.completionVerdictRef,undefined);
  assert.equal(events.readValidatedTerminalEvent(result!.event.id,current.session.id,current.source.seq).id,result!.event.id);
  assert.equal(current.calls(),1);
  assert.equal(db.prepare('SELECT count(*) n FROM physical_dispatches WHERE session_id=? AND source_user_seq=?')
    .get(current.session.id,current.source.seq)?.n,1);
});

test('the canonical expired-session reaper removes exact-call proof with no orphaned authority',async()=>{
  const current=await controlledAction();const db=events.openEventLog();
  db.prepare("UPDATE sessions SET status='completed',created_at='2020-01-01T00:00:00Z',updated_at='2020-01-01T00:00:00Z' WHERE id=?")
    .run(current.session.id);
  assert.equal(events.reapStaleSessions(14),1);
  assert.equal(events.getSession(current.session.id),null);
  for(const table of ['approved_action_completion_intents_v1','approved_action_completion_receipts_v1','accepted_task_authority'])
    assert.equal(db.prepare(`SELECT count(*) n FROM ${table} WHERE session_id=?`).get(current.session.id)?.n,0);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);
});

/** The provider body is a no-network fixture. Claim/account checks, trusted
 * resolver refinement, physical preparation/dispatch and settlement are real. */
async function providerReadyB(options:{refine?:boolean;preparation?:boolean;extra?:boolean;write?:boolean}={}) {
  const session=events.createSession({kind:'chat'});
  const account='ca-controlled-approval';const tool=options.write?'SLACK_SEND_MESSAGE':'SLACK_FETCH_CONVERSATION_HISTORY';
  const inner={channel:'C-CONTROLLED',...(options.write?{text:'Named no-provider fixture.'}:{limit:2}),
    ...(options.refine?{connected_account_id:account}:{})};
  const payload={tool_slug:tool,arguments:JSON.stringify(inner),connected_account_id:account};
  const action=actions.queuePendingAction({title:options.write?'Send the exact controlled message':'Read the exact controlled channel',summary:'No-network SDK normalization fixture.',
    kind:options.write?'external_send':'other',toolName:'composio_execute_tool',payload,sessionId:session.id});
  const card=registry.register({sessionId:session.id,subject:action.title,tool:'request_approval',
    args:{pendingActionId:action.id,pendingAction:pendingActionApprovalView(action)}});
  registry.resolve(card.approvalId,'approved','desktop-chat-card');
  actions.markPendingActionApprovalResolved(action.id,'approved',card.approvalId);
  const attempt=events.beginRunAttempt(session.id,{runId:`approval-resume:${card.approvalId}`});
  const source=events.recordRunAttemptUserInput(attempt,{turn:0,role:'user',data:{text:`Approve ${card.approvalId}.`,
    synthetic:true,source:'approval_resume',approvalId:card.approvalId,decision:'approve'}},{armRunInFlight:true});
  const identity={sessionId:session.id,sourceUserSeq:source.seq,turn:source.turn};
  await recordAcceptedSourceGraph({identity,surface:'approval_resume',acceptedText:String(source.data.text)});
  requireAcceptedTaskAuthority(identity);requireActionExpectedWorkActivation(identity);
  let businessCalls=0;let preparations=0;let adapterFailure:string|undefined;
  executor._setApprovedCallDispatchForTests(async(name,args,_session,_batch,capability)=>{
    try {
    assert.equal(name,'composio_execute_tool');assert.deepEqual(args,payload);
    assert.equal(capability.pendingActionId,action.id);
    assert.equal((args as typeof payload).connected_account_id,account,'SDK account remains pinned in the approved route');
    const effective={...inner} as Record<string,unknown>;
    if(options.refine)delete effective.connected_account_id;
    authorizeResolvedLogicalCallContract({...identity,tool,effectiveArgs:effective});
    const physical={...identity,tool,args:effective};
    if(options.preparation)await withPhysicalPreparationDispatch(physical,async()=>{preparations++;return {schema:'controlled-current'};});
    const result=await withPhysicalDispatch(physical,async()=>{businessCalls++;return {successful:true,data:{id:'controlled-result'}};});
    if(options.extra)await withPhysicalDispatch(physical,async()=>{businessCalls++;return {successful:true,data:{id:'extra-result'}};});
    settleToolAttempt({...identity,lane:'composio',toolName:tool,callId:currentLogicalCall()!.logicalToolCallId,
      args:effective,businessCall:true,mutating:options.write===true,result,signals:{envelopeSuccessful:true}});
    return result;
    } catch(error) {adapterFailure=error instanceof Error?error.stack:String(error);throw error;}
  });
  const execution=await withHarnessRunContext({...identity,runAttemptId:attempt.attemptId,behaviorScopeId:attempt.runId!,counter:new ToolCallsCounter(1)},
    ()=>executor.executeApprovedPendingActionCall(action.id,{sessionId:session.id,sourceUserSeq:source.seq}));
  if(!options.write)assert.equal(execution.status,'executed',`${adapterFailure??''}\n${JSON.stringify(execution)}`);
  return {session,action,source,identity,businessCalls:()=>businessCalls,preparations:()=>preparations,
    execution,adapterFailure,
    outcome:{version:2 as const,id:turnOutcomeId(identity),identity,status:'done' as const,resumable:false as const,
      presentation:{kind:'answer' as const,text:'The exact approved call returned its saved result.'}}};
}

test('canonical read-only SDK provider-ready refinement closes only its exact approved B and retains the pinned account',async()=>{
  const current=await providerReadyB({refine:true});
  const result=commitTurnOutcome(current.outcome);
  assert.equal(result.presentation.status,'done');
  assert.equal(events.readValidatedTerminalEvent(result.event.id,current.session.id,current.source.seq).id,result.event.id);
  const proven=proof.proveApprovedActionCompletionInTransaction(events.openEventLog(),current.identity);
  assert.notEqual(proven.receipt.admittedArgumentDigest,proven.receipt.executedArgumentDigest);
  assert.ok(proven.receipt.refinementEventId);
  assert.equal(proven.receipt.physicalDispatchIds.length,1);
  assert.equal(current.businessCalls(),1);
});

test('an override-only approved write without an original owner cannot acquire the SDK bridge or a completion receipt',async()=>{
  const current=await providerReadyB({refine:true,write:true});const db=events.openEventLog();
  assert.equal(current.execution.status,'failed');
  assert.match(current.execution.resultSummary,/Exact approved SDK preparation refused: approved SDK binding: original accepted source is not a real earlier owner/);
  assert.equal(current.adapterFailure,undefined,'the override must not be reached without the original accepted owner');
  assert.equal(current.businessCalls(),0);
  assert.equal(db.prepare('SELECT count(*) n FROM physical_dispatches WHERE session_id=?').get(current.session.id)?.n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM approved_action_provider_bindings_v1 WHERE session_id=?').get(current.session.id)?.n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM approved_action_completion_receipts_v1 WHERE session_id=?').get(current.session.id)?.n,0);
});

test('a missing or foreign refinement mirror cannot close an executed approval B',async()=>{
  const current=await providerReadyB({refine:true});const db=events.openEventLog();
  const refined=db.prepare("SELECT id,data_json FROM events WHERE session_id=? AND type='logical_call_contract_refined'")
    .get(current.session.id) as {id:string;data_json:string};
  db.prepare("UPDATE events SET data_json=json_set(data_json,'$.sourceUserSeq',?) WHERE id=?").run(current.source.seq+1000,refined.id);
  assert.equal(receipt.prepareApprovedActionHostCompletion(current.identity).status,'conflict');
  assert.equal(loadAcceptedTaskAuthority(current.session.id,current.source.seq).status,'ok');
  assert.equal(current.businessCalls(),1);
  db.prepare('UPDATE events SET data_json=? WHERE id=?').run(refined.data_json,refined.id);
  assert.equal(commitTurnOutcome(current.outcome).presentation.status,'done');
  assert.equal(current.businessCalls(),1,'repairing retained proof never repeats execution');
});

test('the real physical preparation API plus one business crossing closes B with the full retained chain',async()=>{
  const current=await providerReadyB({preparation:true});const db=events.openEventLog();
  const result=commitTurnOutcome(current.outcome);assert.equal(result.presentation.status,'done');
  const proven=proof.proveApprovedActionCompletionInTransaction(db,current.identity);
  assert.equal(proven.receipt.physicalDispatchIds.length,2);
  assert.equal(proven.receipt.physicalDispatchId,proven.receipt.physicalDispatchIds[1]);
  assert.deepEqual(db.prepare('SELECT ordinal,relation,state FROM physical_dispatches WHERE session_id=? ORDER BY ordinal')
    .all(current.session.id),[{ordinal:1,relation:'probe',state:'returned'},{ordinal:2,relation:'child',state:'returned'}]);
  assert.equal(current.preparations(),1);assert.equal(current.businessCalls(),1);
  assert.equal(events.readValidatedTerminalEvent(result.event.id,current.session.id,current.source.seq).id,result.event.id);
});

test('an extra business child cannot be hidden behind the preparation receipt shape',async()=>{
  const current=await providerReadyB({preparation:true,extra:true});
  assert.equal(current.preparations(),1);assert.equal(current.businessCalls(),2);
  assert.equal(receipt.prepareApprovedActionHostCompletion(current.identity).status,'conflict');
  assert.equal(events.openEventLog().prepare('SELECT count(*) n FROM approved_action_completion_receipts_v1 WHERE session_id=?')
    .get(current.session.id)?.n,0);
});

test('an uncertain retained preparation cannot redeem an otherwise successful business result',async()=>{
  const current=await providerReadyB({preparation:true});const db=events.openEventLog();
  const triggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='physical_dispatches'").all() as Array<{name:string;sql:string}>;
  for(const trigger of triggers)db.exec(`DROP TRIGGER ${trigger.name}`);
  try{
    db.prepare("UPDATE physical_dispatches SET state='unknown' WHERE session_id=? AND ordinal=1").run(current.session.id);
    assert.equal(receipt.prepareApprovedActionHostCompletion(current.identity).status,'conflict');
    assert.equal(current.businessCalls(),1);
  }finally{
    db.prepare("UPDATE physical_dispatches SET state='returned' WHERE session_id=? AND ordinal=1").run(current.session.id);
    for(const trigger of triggers)db.exec(trigger.sql);
  }
});
