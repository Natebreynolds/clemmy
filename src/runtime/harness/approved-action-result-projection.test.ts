/** Controlled host/executor and semantic stand-ins only; no live providers. */
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(),'clem-approved-result-'));
Object.assign(process.env,{ CLEMENTINE_HOME:home, CLEMMY_TEST_ISOLATED_HOME:'1', CLEMMY_TEST_DISABLE_LIVE_MODELS:'1',
  MCP_AUTO_IMPORT_ENABLED:'false', EMBEDDINGS_DISABLED:'true', OPENAI_AGENTS_DISABLE_TRACING:'1' });
mkdirSync(path.join(home,'state'),{recursive:true});
const events = await import('./eventlog.js');
const actions = await import('./pending-actions.js');
const registry = await import('./approval-registry.js');
const { pendingActionApprovalView } = await import('./pending-action-view.js');
const { handleResolvedApprovalForChatResume, _resetChatApprovalResumeForTest } = await import('./chat-approval-resume.js');
const { _setApprovedCallDispatchForTests } = await import('../../execution/pending-action-executor.js');
const { installTurnSemanticModelPort } = await import('../semantic-boundary/turn-semantic-port-registry.js');
const { modelUsageAttributionStorage, standaloneModelAccountingJobBinding, standaloneModelAccountingJobFromContext,
  recordModelUsage, readUsageEventsForDate } = await import('../usage-log.js');
const projection = await import('./approved-action-result-projection.js');
const { readInstallQuiescence } = await import('../../dashboard/install-quiescence.js');
const { peekTurnSemanticModelPort } = await import('../semantic-boundary/turn-semantic-port-registry.js');
const { Runner } = await import('@openai/agents');
const { configuredBrainSemanticPort, completeViaConfiguredBrain } = await import('../semantic-boundary/configured-brain-semantic-port.js');
const { controlledApprovedProjectionSdkResult }=await import('../semantic-boundary/approved-action-result-projection-fixture.test.js');
const { completedModelResponseBinding }=await import('./model-response-binding.js');
const { closeOperationalTelemetryDb }=await import('../operational-telemetry.js');
const runnerRun=Runner.prototype.run;
import type { TurnSemanticModelPort } from '../semantic-boundary/turn-semantic-model-port.js';

beforeEach(async () => {
  projection.stopApprovedActionResultProjectionDrain();
  await projection.waitForApprovedActionResultProjectionDrain();
  _resetChatApprovalResumeForTest();
  installTurnSemanticModelPort(null);
  Runner.prototype.run=runnerRun;
  _setApprovedCallDispatchForTests(null);
  events.resetEventLog();
  events.openEventLog();
});
after(async () => {
  projection.stopApprovedActionResultProjectionDrain();
  await projection.waitForApprovedActionResultProjectionDrain();
  _resetChatApprovalResumeForTest(); _setApprovedCallDispatchForTests(null); installTurnSemanticModelPort(null);
  Runner.prototype.run=runnerRun;
  events.closeEventLog(); closeOperationalTelemetryDb(); rmSync(home,{recursive:true,force:true});
});
async function until(check:()=>boolean) {
  const deadline=Date.now()+5_000;
  while(!check() && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(check(),'controlled boundary reached');
}
async function completedAction(raw='HTTP/1.1 200 OK\ncontrolled result') {
  const session=events.createSession({kind:'chat',channel:'desktop'});
  const original=events.appendEvent({sessionId:session.id,turn:1,role:'user',type:'user_input_received',
    data:{text:'Run this exact controlled approved request.'}});
  const action=actions.queuePendingAction({title:'Run the controlled approved request',summary:'One exact controlled POST.',
    kind:'shell_command',toolName:'run_shell_command',payload:{command:"curl -X POST -d 'x=1' http://127.0.0.1:1/controlled",cwd:'/tmp'},
    sessionId:session.id,sourceUserSeq:original.seq});
  const card=registry.register({sessionId:session.id,subject:action.title,tool:'request_approval',
    args:{pendingActionId:action.id,pendingAction:pendingActionApprovalView(action)}});
  events.appendEvent({sessionId:session.id,turn:1,role:'system',type:'approval_parked',
    data:{approvalId:card.approvalId,tool:'request_approval',pendingActionId:action.id}});
  let dispatches=0;
  _setApprovedCallDispatchForTests(async()=>{dispatches++;return raw;});
  const resolved=registry.resolve(card.approvalId,'approved','desktop-chat-card').row!;
  assert.equal(await handleResolvedApprovalForChatResume(resolved,async()=>{throw new Error('No hidden model/human turn');}),true);
  const record=actions.getPendingAction(action.id)!;
  assert.equal(record.status,'executed'); assert.equal(dispatches,1);
  const source=events.listEvents(session.id,{types:['user_input_received']})
    .find(event=>event.data.source==='approval_resume' && event.data.approvalId===card.approvalId)!;
  const terminal=events.listEvents(session.id,{types:['conversation_completed']})
    .find(event=>event.data.sourceUserSeq===source.seq)!;
  assert.ok(terminal); assert.equal(terminal.data.hostNotice && (terminal.data.hostNotice as {code:string}).code,'approved_action_completed');
  return {session,original,record,source,terminal,dispatches:()=>dispatches};
}
const jobFor=(source:number)=>events.openEventLog().prepare(`SELECT * FROM ${projection.APPROVED_ACTION_RESULT_PROJECTION_JOBS_TABLE} WHERE source_user_seq=?`).get(source) as Record<string,unknown>|undefined;

/** Real semantic/model-response adapters over inert network/Runner stand-ins.
 * Unlike a self-described port return, this has the original nominal SDK
 * response and its settled physical-attempt receipt in the exact job scope. */
function installAuthoredPort(message:string, inspect?:()=>void) {
  let calls=0;
  Runner.prototype.run=(async()=>{
    calls++;inspect?.();
    const raw={message,choices:null};
    const value=await controlledApprovedProjectionSdkResult(raw);
    const response=value.rawResponses[0]!;
    const physical=completedModelResponseBinding(response)!;
    recordModelUsage({sessionId:'unknown',model:'controlled-projection-model',cacheDialect:'none',
      trace:{modelCallId:physical.modelCallId},responseId:response.responseId,inputTokens:11,cachedInputTokens:0,outputTokens:7});
    return value;
  }) as unknown as typeof runnerRun;
  installTurnSemanticModelPort(configuredBrainSemanticPort(completeViaConfiguredBrain));
  return ()=>calls;
}

test('successful real-host action closes before a separately accounted card-only projection, once',async()=>{
  const item=await completedAction();
  assert.match(String(item.terminal.data.reply),/^The approved action completed\./);
  const before=JSON.stringify(item.terminal.data),summary=item.record.resultSummary;
  const {readPendingActionPublicResult}=await import('./pending-action-result-reader.js');
  const immediate=readPendingActionPublicResult(item.record);
  assert.equal(immediate?.source,'terminal');
  assert.match(immediate!.text,/^The approved action completed\./);
  const row=jobFor(item.source.seq)!; assert.equal(row.status,'queued');
  const {measureAcceptedTask}=await import('../../../scripts/session-comparison.js');
  const baseline=measureAcceptedTask(home,item.session.id,item.original.seq);
  const binding=projection.normalizeApprovedActionResultProjectionBinding(JSON.parse(String(row.binding_json)))!;
  assert.equal(binding.originalSourceUserSeq,item.original.seq); assert.equal(binding.sourceUserSeq,item.source.seq);
  assert.equal(binding.terminalEventId,item.terminal.id); assert.ok(binding.completionReceiptId);
  for(const changed of [{version:2},{attemptId:'foreign',extra:true},{rawByteCount:65_537},{originalSourceUserSeq:item.source.seq},
    {sourceDigest:'invalid'},{retainedWorkNeedsVerification:'yes'}]) {
    assert.equal(projection.normalizeApprovedActionResultProjectionBinding({...binding,...changed}),null);
  }
  const calls=installAuthoredPort('The approved request completed and returned the controlled result.',()=>{
    const usage=modelUsageAttributionStorage.getStore();
    assert.equal(usage?.sessionId,''); assert.equal(usage?.sourceUserSeq,0); assert.equal(usage?.attemptId,undefined);
    const token=standaloneModelAccountingJobFromContext(usage)!;
    const owner=standaloneModelAccountingJobBinding(token)!;
    assert.equal(owner.operation,'approval_result_projection'); assert.equal(owner.operationId,row.projection_id);
    assert.equal(owner.revisionDigest,row.evidence_digest);
    assert.equal(events.openEventLog().prepare(`SELECT usage_job_id FROM ${projection.APPROVED_ACTION_RESULT_PROJECTION_JOBS_TABLE} WHERE projection_id=?`)
      .get(row.projection_id) && jobFor(item.source.seq)?.usage_job_id,owner.usageJobId,'job attribution retained before semantic invocation');
  });
  projection.startApprovedActionResultProjectionDrain();
  await projection.waitForApprovedActionResultProjectionDrain();
  assert.equal(calls(),1); assert.equal(jobFor(item.source.seq)?.status,'published');
  const result=projection.readApprovedActionResultProjection(item.record,item.terminal);
  assert.equal(result?.text,'The approved request completed and returned the controlled result.');
  assert.equal(result?.textDigest,projection.projectionTextDigest(result!.text));
  for(let i=0;i<3;i++) {
    const publicResult=readPendingActionPublicResult(item.record);
    assert.equal(publicResult?.source,'authored_projection');
    assert.equal(publicResult!.text,result!.text);
    assert.deepEqual(publicResult!.terminal,{eventId:item.terminal.id,sourceUserSeq:item.source.seq});
    const {text:_,...receipt}=result!;
    assert.deepEqual(publicResult!.source==='authored_projection' && publicResult!.projection,receipt);
    assert.equal(projection.readApprovedActionResultProjectionStatus(item.record,item.terminal)?.status,'published');
  }
  projection.kickApprovedActionResultProjectionDrain(); await projection.waitForApprovedActionResultProjectionDrain();
  assert.equal(calls(),1); assert.equal(item.dispatches(),1);
  assert.equal(JSON.stringify(events.readValidatedTerminalEvent(item.terminal.id,item.session.id,item.source.seq).data),before);
  assert.equal(actions.getPendingAction(item.record.id)?.resultSummary,summary);
  const count=events.listEvents(item.session.id,{types:['user_input_received']}).length;
  assert.equal(count,2,'original human A and exact synthetic B only');
  const {readAcceptedTaskApprovalProjectionParticipants}=await import('../../../scripts/lib/accepted-task-approval-projection-participants.js');
  const {selectAcceptedTaskApprovalProjectionUsage}=await import('../../../scripts/lib/accepted-task-approval-projection-usage.js');
  const participants=readAcceptedTaskApprovalProjectionParticipants(home,[{sessionId:item.session.id,sourceUserSeq:item.original.seq}]);
  assert.equal(participants.jobs.length,1,JSON.stringify(participants.issues));
  assert.equal(participants.jobs[0]!.projectionId,row.projection_id);
  assert.equal(participants.jobs[0]!.parentAcceptedSource,`${item.session.id}:${item.original.seq}`);
  assert.equal(participants.jobs[0]!.executionAcceptedSource,`${item.session.id}:${item.source.seq}`);
  assert.equal(participants.jobs[0]!.terminalEventId,item.terminal.id);
  assert.equal(participants.jobs[0]!.authoredResponseBound,true,JSON.stringify(participants.issues));
  const usage=readUsageEventsForDate().filter(event=>event.source===jobFor(item.source.seq)?.usage_job_id);
  assert.equal(usage.length,1,'the real recorder, not a hand-authored usage row');
  const selected=selectAcceptedTaskApprovalProjectionUsage({...participants,usage,
    acceptedSources:new Set([`${item.session.id}:${item.original.seq}`])});
  assert.deepEqual(selected.exactIndices,[0],JSON.stringify(selected.issues));
  const measured=measureAcceptedTask(home,item.session.id,item.original.seq);
  assert.equal(measured.postTerminalProjectionExactUsageRecords,baseline.postTerminalProjectionExactUsageRecords+1,
    JSON.stringify(measured.postTerminalProjectionUsageIssues));
  assert.deepEqual(measured.sourceUserSeqs,baseline.sourceUserSeqs);
  assert.equal(measured.attemptCount,baseline.attemptCount);
  assert.equal(measured.taskWallMs,baseline.taskWallMs);
  assert.equal(measured.terminalStatus,baseline.terminalStatus,'optional wording never completes A');
  assert.throws(()=>events.openEventLog().prepare(`UPDATE ${projection.APPROVED_ACTION_RESULT_PROJECTION_RESULTS_TABLE} SET text='changed'`).run(),/immutable/);
  assert.throws(()=>events.openEventLog().prepare(`UPDATE ${projection.APPROVED_ACTION_RESULT_PROJECTION_JOBS_TABLE} SET status='queued'`).run(),/immutable|replay/);
});

test('foreign/stale card or terminal and changed executor evidence cannot adopt published words',async()=>{
  const item=await completedAction();
  installAuthoredPort('The exact action completed.');
  projection.startApprovedActionResultProjectionDrain(); await projection.waitForApprovedActionResultProjectionDrain();
  assert.ok(projection.readApprovedActionResultProjection(item.record,item.terminal));
  for(const changed of [{id:'pa-foreign'}, {approvalId:'apr-foreign'}, {payloadHash:'a'.repeat(16)}, {updatedAt:new Date(0).toISOString()},
    {resultSummary:'changed'}, {sessionId:'foreign'}, {status:'failed'}]) {
    assert.equal(projection.readApprovedActionResultProjection({...item.record,...changed},item.terminal),null);
  }
  assert.equal(projection.readApprovedActionResultProjection(item.record,{...item.terminal,id:'foreign'}),null);
});

test('a Stop after claim discards late words and protects inventory until the actual promise settles',async()=>{
  const item=await completedAction(); let calls=0; let resolve!: (value:unknown)=>void;
  installTurnSemanticModelPort({voiceApprovedActionResultProjection:async input=>{
    calls++;try{return await new Promise(done=>{resolve=value=>done({...value as object,evidenceDigest:input.evidenceDigest,modelIdentity:'controlled'});});}
    finally{input.onRequestSettled?.();}
  }} as TurnSemanticModelPort);
  projection.startApprovedActionResultProjectionDrain(); await until(()=>calls===1);
  assert.ok(readInstallQuiescence().currentWork.items.some(owner=>owner.kind==='projection'));
  projection.stopApprovedActionResultProjectionDrain(); await projection.waitForApprovedActionResultProjectionDrain();
  assert.equal(jobFor(item.source.seq)?.status,'unknown');
  assert.ok(readInstallQuiescence().currentWork.items.some(owner=>owner.kind==='projection'));
  resolve({message:'Late words must never publish.'}); await until(()=>!!jobFor(item.source.seq)?.transport_closed_at);
  assert.equal(projection.readApprovedActionResultProjection(item.record,item.terminal),null);
  assert.equal(readInstallQuiescence().currentWork.items.some(owner=>owner.kind==='projection'),false);
  projection.startApprovedActionResultProjectionDrain(); await projection.waitForApprovedActionResultProjectionDrain();
  assert.equal(calls,1); assert.equal(item.dispatches(),1);
});

test('an exact durable Stop before claim causes zero semantic calls and leaves success unchanged',async()=>{
  const item=await completedAction(); let calls=0;
  installTurnSemanticModelPort({voiceApprovedActionResultProjection:async()=>{calls++;throw new Error('Must not run');}} as TurnSemanticModelPort);
  events.requestKill(item.session.id,'Controlled exact decision Stop.',{sourceUserSeq:item.source.seq});
  projection.startApprovedActionResultProjectionDrain(); await projection.waitForApprovedActionResultProjectionDrain();
  assert.equal(calls,0); assert.equal(jobFor(item.source.seq)?.status,'cancelled');
  assert.equal(actions.getPendingAction(item.record.id)?.status,'executed'); assert.equal(item.dispatches(),1);
});

test('large retained result stays neutral before optional proof/hash/model work',async()=>{
  let calls=0;
  installTurnSemanticModelPort({voiceApprovedActionResultProjection:async()=>{calls++;throw new Error('Must not run');}} as TurnSemanticModelPort);
  const item=await completedAction('x'.repeat(70_000));
  assert.equal(jobFor(item.source.seq),undefined);
  projection.startApprovedActionResultProjectionDrain(); await projection.waitForApprovedActionResultProjectionDrain();
  assert.equal(calls,0); assert.equal(item.dispatches(),1);
  assert.match(String(item.terminal.data.reply),/^The approved action completed\./);
});

test('failed or unbound semantic output keeps canonical neutral evidence, with no retry',async()=>{
  const item=await completedAction(); let calls=0;
  installTurnSemanticModelPort({voiceApprovedActionResultProjection:async input=>{calls++;input.onRequestSettled?.();return {message:'Not bound.',evidenceDigest:'a'.repeat(64),modelIdentity:'controlled'};}} as TurnSemanticModelPort);
  projection.startApprovedActionResultProjectionDrain(); await projection.waitForApprovedActionResultProjectionDrain();
  assert.equal(calls,1); assert.equal(jobFor(item.source.seq)?.status,'failed');
  assert.equal(projection.readApprovedActionResultProjection(item.record,item.terminal),null);
  projection.stopApprovedActionResultProjectionDrain(); projection.startApprovedActionResultProjectionDrain();
  await projection.waitForApprovedActionResultProjectionDrain(); assert.equal(calls,1);
  assert.equal(peekTurnSemanticModelPort()?.voiceApprovedActionResultProjection!==undefined,true);
});
