import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-browserbase-tests-'));
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const { BrowserbaseService, BrowserbaseServiceError } = await import('./browserbase.js');
const { BrowserbaseClientError } = await import('./browserbase-client.js');
const { BrowserbaseCdpError } = await import('./browserbase-cdp.js');
const project = '10000000-0000-4000-8000-000000000001', sessionId = '20000000-0000-4000-8000-000000000002';
function setup() {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), 'clem-browserbase-service-'));
  let clock = Date.parse('2026-10-02T00:00:00Z'), status: 'RUNNING'|'COMPLETED'|'TIMED_OUT' = 'RUNNING', key = 'private-test-key';
  let creates = 0, releases = 0, operations = 0, views = 0;
  const observed = () => ({ sessionId, projectId: project, status, connectUrl: `wss://connect.browserbase.com/?sessionId=${sessionId}&apiKey=never-public` });
  const api = {
    async create(input: { projectId: string; recording?: boolean; timeoutSeconds?: number }) { creates++; assert.equal(input.recording, false); return observed(); },
    async retrieve(id: string, p: string) { assert.equal(id, sessionId); assert.equal(p, project); return observed(); },
    async release(id: string, p: string) { assert.equal(id, sessionId); assert.equal(p, project); releases++; },
    async liveView(_id: string, options: { targetId?: string } = {}) { views++; return { url: 'https://www.browserbase.com/devtools?token=synthetic-private-view', expiresAt: new Date(clock+60000).toISOString(), ...(options.targetId ? { targetId: options.targetId } : {}) }; },
  };
  const cdp = {
    async execute(_url: string, _session: string, operation: string, args: unknown, options?: { beforeMutation?: () => Promise<void> }) {
      operations++;
      const targetId = (args as { targetId?: string }).targetId ?? (operation === 'open' ? 'new-target' : null);
      if (!['tabs','read'].includes(operation)) await options?.beforeMutation?.();
      return { result: { ok: true }, effect: (['tabs','read'].includes(operation) ? 'none' : 'confirmed') as 'none'|'confirmed', targetId,
        pages: [{ targetId: targetId ?? 'page-a', title: 'Working page', url: 'https://example.com/' }] };
    },
    async humanText(_url: string, _session: string, targetId: string, _text: string, options?: { beforeMutation?: () => Promise<void> }) {
      operations++; await options?.beforeMutation?.(); return { result: { ok: true }, effect: 'confirmed' as const, targetId };
    },
  };
  const options = { baseDir, now: () => clock, getApiKey: async () => key, setApiKey: async (value: string) => { key = value; }, api, cdp, autoMaintenance: false };
  const service = new BrowserbaseService(options);
  return { service, options, api, cdp, baseDir, advance: (ms: number) => { clock += ms; }, changeKey: (value: string) => { key = value; }, setStatus: (value: typeof status) => { status = value; },
    counts: () => ({ creates, releases, operations, views }), close: () => { service.dispose(); rmSync(baseDir, { recursive: true, force: true }); } };
}
test('durable create reservation is written before POST; no duplicate session after unknown outcome or restart', async () => {
  const t = setup(); try {
    await t.service.configure({ projectId: project });
    let calls = 0;
    t.api.create = async () => { calls++; const file = JSON.parse(readFileSync(path.join(t.baseDir,'state/browserbase/resources.json'),'utf8')); assert.equal(file.resources[0].pending.operation, 'create'); throw new BrowserbaseClientError('timeout', true); };
    await assert.rejects(t.service.create({ conversationId: 'task-a', requestId: 'accepted-source-a' }), error => error instanceof BrowserbaseServiceError && error.effect === 'uncertain');
    const first = await t.service.create({ conversationId: 'task-a', requestId: 'accepted-source-a' });
    assert.equal(first.state, 'uncertain'); assert.equal(first.providerSessionId, null); assert.equal(calls, 1);
    const restarted = new BrowserbaseService(t.options);
    const resumed = await restarted.create({ conversationId: 'task-a', requestId: 'accepted-source-a' });
    assert.equal(resumed.id, first.id); assert.ok(resumed.controlVersion > first.controlVersion); assert.equal(calls,1);
    restarted.dispose();
  } finally { t.close(); }
});
test('human takeover waits for in-flight operation, invalidates old proposals and requires fresh observation on return', async () => {
  const t = setup(); try {
    await t.service.configure({ projectId: project }); const resource = await t.service.create({ conversationId:'task-a',requestId:'source' });
    let release!: () => void, entered!: () => void;
    const atBoundary = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const original = t.cdp.execute;
    t.cdp.execute = async (url,id,operation,args,options) => { if (operation === 'navigate') { await options?.beforeMutation?.(); entered(); await wait; } return original(url,id,operation,args,options); };
    const inFlight = t.service.agentOperation(resource.id,'task-a',{ expectedVersion:1,operation:'navigate',args:{targetId:'page-a',url:'https://example.com/'}});
    await atBoundary; let handedOff = false;
    const takeover = t.service.control(resource.id,'task-a',{expectedVersion:1,controller:'human'}).then(value => { handedOff = true; return value; });
    await Promise.resolve(); assert.equal(handedOff,false);
    release(); const result = await inFlight; assert.equal(result.receipt.effect,'confirmed');
    const human = await takeover; assert.equal(human.controller,'human'); assert.equal(human.controlVersion,2);
    await assert.rejects(t.service.agentOperation(resource.id,'task-a',{expectedVersion:2,operation:'tabs',args:{}}), /human_controls_browser/);
    const before = t.counts().operations;
    const agent = await t.service.control(resource.id,'task-a',{expectedVersion:2,controller:'agent'});
    assert.equal(agent.controlVersion,3); assert.equal(t.counts().operations,before+1); assert.equal(agent.pages?.[0]?.targetId,'page-a');
    await assert.rejects(t.service.agentOperation(resource.id,'task-a',{expectedVersion:1,operation:'navigate',args:{targetId:'page-a',url:'https://example.com/'}}), /control_version_changed/);
  } finally { t.close(); }
});
test('an interrupted browser effect remains uncertain and cannot be replayed automatically after restart', async () => {
  const t = setup(); try {
    await t.service.configure({projectId:project}); const r=await t.service.create({conversationId:'task-a',requestId:'source'});
    let mutations=0;
    t.cdp.execute=async (_url,_id,_op,_args,options) => { await options?.beforeMutation?.(); mutations++; throw new BrowserbaseCdpError('connection_closed','uncertain'); };
    await assert.rejects(t.service.agentOperation(r.id,'task-a',{operation:'navigate',args:{targetId:'page-a',url:'https://example.com/'},expectedVersion:1}), error => error instanceof BrowserbaseServiceError && error.effect==='uncertain');
    assert.equal((await t.service.get(r.id,'task-a')).state,'uncertain');
    const restarted=new BrowserbaseService(t.options); const recovered=(await restarted.list('task-a'))[0]!;
    await assert.rejects(restarted.agentOperation(r.id,'task-a',{operation:'navigate',args:{targetId:'page-a',url:'https://example.com/'},expectedVersion:recovered.controlVersion}),/resource_effect_uncertain/);
    assert.equal(mutations,1); restarted.dispose();
  } finally {t.close();}
});
test('release acknowledgment is not terminal proof, later polls cannot duplicate release', async () => {
  const t=setup(); try {
    await t.service.configure({projectId:project}); const r=await t.service.create({conversationId:'task-a',requestId:'source'});
    const pending=await t.service.stop(r.id,'task-a',{expectedVersion:1});
    assert.equal(pending.state,'uncertain'); assert.equal(pending.errorCode,'release_pending'); assert.equal(pending.controller,'human');
    await t.service.stop(r.id,'task-a',{expectedVersion:pending.controlVersion}); await t.service.maintenance(); assert.equal(t.counts().releases,1);
    t.setStatus('COMPLETED'); const ended=await t.service.get(r.id,'task-a'); assert.equal(ended.state,'stopped'); assert.equal(t.counts().releases,1);
  } finally {t.close();}
});
test('idle policy preserves visible human activity and releases exact idle sessions within configured lifetime', async () => {
  const t=setup(); try {
    await t.service.configure({projectId:project,idleSeconds:60,sessionTimeoutSeconds:120}); const r=await t.service.create({conversationId:'task-a',requestId:'source'});
    const human=await t.service.control(r.id,'task-a',{expectedVersion:1,controller:'human'});
    await t.service.view(r.id,'task-a',{viewerLeaseId:randomUUID(),expectedVersion:human.controlVersion,targetId:'page-a'});
    t.advance(59000); await t.service.touch(r.id,'task-a',{expectedVersion:human.controlVersion}); t.advance(59000); await t.service.maintenance(); assert.equal(t.counts().releases,0);
    t.advance(2000); await t.service.maintenance(); assert.equal(t.counts().releases,1);
  } finally {t.close();}
});
test('proven release preflight refusal can retry; uncertain POST outcome cannot', async () => {
  const t=setup(); try {
    await t.service.configure({projectId:project}); const r=await t.service.create({conversationId:'task-a',requestId:'source'});
    const original=t.api.release; t.api.release=async () => { throw new BrowserbaseClientError('identity_mismatch',false); };
    await assert.rejects(t.service.stop(r.id,'task-a',{expectedVersion:1}),error=>error instanceof BrowserbaseServiceError&&error.effect==='none');
    const after=(await t.service.list('task-a'))[0]!; assert.equal(after.state,'active'); assert.equal(after.controller,'human');
    t.api.release=original; await t.service.stop(r.id,'task-a',{expectedVersion:after.controlVersion}); assert.equal(t.counts().releases,1);
    await t.service.stop(r.id,'task-a',{expectedVersion:after.controlVersion+1}); assert.equal(t.counts().releases,1);
  } finally {t.close();}
});
test('explicit owner recovery adopts one exact session without recreating or reusing another task session', async () => {
  const t=setup(); try {
    await t.service.configure({projectId:project}); let creates=0;
    t.api.create=async () => { creates++; throw new BrowserbaseClientError('timeout',true); };
    await assert.rejects(t.service.create({conversationId:'task-a',requestId:'source'})); const unknown=(await t.service.list('task-a'))[0]!;
    const recovered=await t.service.resolveUnknownCreate(unknown.id,'task-a',{expectedVersion:unknown.controlVersion,providerSessionId:sessionId});
    assert.equal(recovered.providerSessionId,sessionId); assert.equal(recovered.controller,'human'); assert.equal(creates,1);
    assert.equal((await t.service.create({conversationId:'task-a',requestId:'source'})).id,unknown.id); assert.equal(creates,1);
    const store=JSON.parse(readFileSync(path.join(t.baseDir,'state/browserbase/resources.json'),'utf8'));assert.equal(store.resources[0].ownerResolution.originalCreateProof,'unknown');
    await assert.rejects(t.service.resolveUnknownCreate(unknown.id,'task-a',{expectedVersion:recovered.controlVersion,providerSessionId:sessionId}),/invalid_recovery/);
  } finally {t.close();}
});
test('public resources and disk metadata never contain key, CDP or viewer URLs; account/task changes cannot rebind', async () => {
  const t=setup(); try {
    await t.service.configure({projectId:project}); const r=await t.service.create({conversationId:'task-a',requestId:'source'});
    const live=await t.service.view(r.id,'task-a',{viewerLeaseId:randomUUID(),expectedVersion:1}); assert.match(live.url,/private-view/);
    const publicJson=JSON.stringify(await t.service.list('task-a')), disk=readFileSync(path.join(t.baseDir,'state/browserbase/resources.json'),'utf8');
    for(const value of [publicJson,disk]) assert.doesNotMatch(value,/never-public|private-test-key|private-view|connectUrl|debuggerFullscreenUrl/);
    assert.doesNotMatch(publicJson,/credentialIdentity|requestKey|pending/);
    await assert.rejects(t.service.get(r.id,'task-b'),/resource_not_found/);
    await assert.rejects(t.service.configure({projectId:project,apiKey:'different'}),/configuration_has_live_resources/);
    t.changeKey('different'); await assert.rejects(t.service.agentOperation(r.id,'task-a',{operation:'tabs',args:{},expectedVersion:1}),/credential_changed/); assert.equal(t.counts().operations,0);
  } finally {t.close();}
});
test('changed request arguments conflict and stale viewer epochs cannot mint interactive capabilities',async()=>{
  const t=setup();try{
    await t.service.configure({projectId:project});const r=await t.service.create({conversationId:'task-a',requestId:'source'});
    await assert.rejects(t.service.create({conversationId:'task-a',requestId:'source',recording:true}),/request_conflict/);assert.equal(t.counts().creates,1);
    const human=await t.service.control(r.id,'task-a',{expectedVersion:1,controller:'human'});
    await assert.rejects(t.service.view(r.id,'task-a',{viewerLeaseId:randomUUID(),expectedVersion:1,targetId:'page-a'}),/control_version_changed/);assert.equal(t.counts().views,0);
    const view=await t.service.view(r.id,'task-a',{viewerLeaseId:randomUUID(),expectedVersion:human.controlVersion,targetId:'page-a'});assert.equal(view.controlVersion,2);assert.equal(view.controller,'human');
    await t.service.detach(r.id,'task-a',{viewerLeaseId:view.viewerLeaseId});
    await t.service.control(r.id,'task-a',{expectedVersion:2,controller:'agent'});
    await assert.rejects(t.service.humanInput(r.id,'task-a',{expectedVersion:2,viewerLeaseId:view.viewerLeaseId,targetId:'page-a',text:'stale device input'}),/control_version_changed/);
  }finally{t.close();}
});
test('human input requires human ownership, exact target and current epoch, with acknowledged result', async () => {
  const t=setup(); try {
    await t.service.configure({projectId:project}); const r=await t.service.create({conversationId:'task-a',requestId:'source'});
    await assert.rejects(t.service.humanInput(r.id,'task-a',{expectedVersion:1,viewerLeaseId:'unknown',targetId:'page-a',text:'hello'}),/agent_controls_browser/);
    const human=await t.service.control(r.id,'task-a',{expectedVersion:1,controller:'human'});
    const view=await t.service.view(r.id,'task-a',{viewerLeaseId:randomUUID(),expectedVersion:human.controlVersion,targetId:'page-a'});
    const typed=await t.service.humanInput(r.id,'task-a',{expectedVersion:human.controlVersion,viewerLeaseId:view.viewerLeaseId,targetId:'page-a',text:'hello'});
    assert.equal(typed.result.ok,true); assert.equal(typed.receipt.targetId,'page-a'); assert.equal(typed.receipt.controlVersion,2); assert.equal(typed.receipt.effect,'confirmed');
    assert.doesNotMatch(JSON.stringify(typed.receipt),/hello|apiKey|connectUrl/);
    await assert.rejects(t.service.humanInput(r.id,'task-a',{expectedVersion:1,viewerLeaseId:view.viewerLeaseId,targetId:'page-a',key:'Enter'}),/control_version_changed/);
    await assert.rejects(t.service.humanInput(r.id,'task-a',{expectedVersion:2,viewerLeaseId:view.viewerLeaseId,targetId:'page-a',key:'arbitrary javascript'}),/invalid_arguments/);
  } finally {t.close();}
});
test('two devices must detach real human viewers before agent control, even across expiry and restart',async()=>{
  const t=setup();try{
    await t.service.configure({projectId:project});const r=await t.service.create({conversationId:'task-a',requestId:'source'});
    const human=await t.service.control(r.id,'task-a',{expectedVersion:1,controller:'human'});
    const a=await t.service.view(r.id,'task-a',{viewerLeaseId:randomUUID(),expectedVersion:human.controlVersion,targetId:'page-a'});
    const b=await t.service.view(r.id,'task-a',{viewerLeaseId:randomUUID(),expectedVersion:human.controlVersion,targetId:'page-a'});
    const before=t.counts().operations;
    const pending=await t.service.control(r.id,'task-a',{expectedVersion:human.controlVersion,controller:'agent'});
    assert.equal(pending.returnPending,true);assert.equal(pending.controller,'human');assert.equal(pending.controlVersion,3);
    t.advance(61000);await assert.rejects(t.service.agentOperation(r.id,'task-a',{expectedVersion:3,operation:'tabs',args:{}}),/control_return_pending/);
    await assert.rejects(t.service.view(r.id,'task-a',{viewerLeaseId:randomUUID(),expectedVersion:3,targetId:'page-a'}),/control_return_pending/);
    const one=await t.service.detach(r.id,'task-a',{viewerLeaseId:a.viewerLeaseId});assert.equal(one.returnPending,true);
    const duplicate=await t.service.detach(r.id,'task-a',{viewerLeaseId:a.viewerLeaseId});assert.equal(duplicate.returnPending,true);assert.equal(t.counts().operations,before);
    const restarted=new BrowserbaseService(t.options);const recovered=(await restarted.list('task-a'))[0]!;
    assert.equal(recovered.returnPending,true);assert.equal(recovered.controller,'human');assert.equal(recovered.controlVersion,4);
    const granted=await restarted.detach(r.id,'task-a',{viewerLeaseId:b.viewerLeaseId});assert.equal(granted.controller,'agent');assert.equal(granted.returnPending,false);assert.equal(granted.controlVersion,5);assert.equal(t.counts().operations,before+1);
    await assert.rejects(restarted.agentOperation(r.id,'task-a',{expectedVersion:3,operation:'tabs',args:{}}),/control_version_changed/);
    restarted.dispose();
  }finally{t.close();}
});
test('unknown human input cannot be redispatched from another device in the same control epoch',async()=>{
  const t=setup();try{
    await t.service.configure({projectId:project});const r=await t.service.create({conversationId:'task-a',requestId:'source'});
    const human=await t.service.control(r.id,'task-a',{expectedVersion:1,controller:'human'});
    const view=await t.service.view(r.id,'task-a',{viewerLeaseId:randomUUID(),expectedVersion:human.controlVersion,targetId:'page-a'});let inputs=0;
    t.cdp.humanText=async (_url,_id,_target,_text,options)=>{await options?.beforeMutation?.();inputs++;throw new BrowserbaseCdpError('connection_closed','uncertain');};
    const input={expectedVersion:2,viewerLeaseId:view.viewerLeaseId,targetId:'page-a',text:'send this once'};
    await assert.rejects(t.service.humanInput(r.id,'task-a',input),error=>error instanceof BrowserbaseServiceError&&error.effect==='uncertain');
    assert.equal((await t.service.get(r.id,'task-a')).state,'uncertain');await assert.rejects(t.service.humanInput(r.id,'task-a',input),/resource_effect_uncertain/);assert.equal(inputs,1);
  }finally{t.close();}
});
test('CAS conflicts before mutation refuse dispatch; persistence failure after provider create stays uncertain',async()=>{
  const t=setup();try{
    await t.service.configure({projectId:project});const r=await t.service.create({conversationId:'task-a',requestId:'source'});
    const restarted=new BrowserbaseService(t.options);let sends=0;
    t.cdp.execute=async (_url,_id,_op,_args,options)=>{await options?.beforeMutation?.();sends++;return{result:{ok:true},effect:'confirmed',targetId:'page-a'};};
    await assert.rejects(t.service.agentOperation(r.id,'task-a',{expectedVersion:1,operation:'navigate',args:{targetId:'page-a',url:'https://example.com/'}}),error=>error instanceof BrowserbaseServiceError&&error.effect==='none');assert.equal(sends,0);restarted.dispose();
  }finally{t.close();}
  const second=setup();try{
    await second.service.configure({projectId:project});second.api.create=async()=>{const file=path.join(second.baseDir,'state/browserbase/resources.json');const value=JSON.parse(readFileSync(file,'utf8'));value.revision++;writeFileSync(file,JSON.stringify(value));return{sessionId,projectId:project,status:'RUNNING',connectUrl: endpointForTest()};};
    await assert.rejects(second.service.create({conversationId:'task-a',requestId:'source'}),error=>error instanceof BrowserbaseServiceError&&error.effect==='uncertain');
    const restarted=new BrowserbaseService(second.options);const unknown=(await restarted.list('task-a'))[0]!;assert.equal(unknown.state,'uncertain');assert.equal(unknown.providerSessionId,null);restarted.dispose();
  }finally{second.close();}
});
function endpointForTest(){return `wss://connect.browserbase.com/?sessionId=${sessionId}&apiKey=not-public`;}
test('known viewer id survives lost responses; tombstones prevent cancelled late mints and immutable retries',async()=>{
  const t=setup();try{
    await t.service.configure({projectId:project});const r=await t.service.create({conversationId:'task-a',requestId:'source'});
    const human=await t.service.control(r.id,'task-a',{expectedVersion:1,controller:'human'});
    const attempted=randomUUID();const args={expectedVersion:human.controlVersion,viewerLeaseId:attempted,targetId:'page-a'};
    await t.service.view(r.id,'task-a',args); // Simulate response lost; caller already knows attempted id.
    await t.service.view(r.id,'task-a',args); // One lease, another short-lived URL, same immutable binding.
    const stored=JSON.parse(readFileSync(path.join(t.baseDir,'state/browserbase/resources.json'),'utf8'));assert.equal(stored.resources[0].viewerLeases.filter((lease:{id:string})=>lease.id===attempted).length,1);
    await assert.rejects(t.service.view(r.id,'task-a',{...args,targetId:'other-page'}),/viewer_request_conflict/);
    const pending=await t.service.control(r.id,'task-a',{expectedVersion:2,controller:'agent'});assert.equal(pending.returnPending,true);
    const recovered=await t.service.detach(r.id,'task-a',{viewerLeaseId:attempted});assert.equal(recovered.controller,'agent');assert.equal(recovered.returnPending,false);
    const cancelled=randomUUID();await t.service.detach(r.id,'task-a',{viewerLeaseId:cancelled});const before=t.counts().views;
    await assert.rejects(t.service.view(r.id,'task-a',{expectedVersion:recovered.controlVersion,viewerLeaseId:cancelled}),/viewer_lease_detached/);assert.equal(t.counts().views,before);
    await t.service.detach(r.id,'task-a',{viewerLeaseId:cancelled});
  }finally{t.close();}
});
test('hung credential lookup is bounded and deduplicated, never dispatching a paid provider or browser call',async()=>{
  const t=setup();try{
    await t.service.configure({projectId:project});let reads=0;
    const bounded=new BrowserbaseService({...t.options,credentialTimeoutMs:5,getApiKey:()=>{reads++;return new Promise<string>(()=>{});}});
    const [status]=await Promise.all([bounded.status(),assert.rejects(bounded.create({conversationId:'task-a',requestId:'source'}),/credential_unavailable/)]);
    assert.equal(status.credentialStatus,'unavailable');assert.equal(status.configured,false);assert.equal(reads,1);assert.equal(t.counts().creates,0);assert.equal(t.counts().operations,0);
    await bounded.status();assert.equal(reads,1);bounded.dispose();
  }finally{t.close();}
});
test('passive unconfigured health polls do not read secrets or infer missing credentials',async()=>{
  const t=setup();try{
    let reads=0;const passive=new BrowserbaseService({...t.options,getApiKey:async()=>{reads++;return 'a-configured-vault-key';}});
    for(let poll=0;poll<5;poll++){
      const status=await passive.status();assert.equal(status.configured,false);assert.equal(status.projectId,null);assert.equal(status.credentialStatus,'not_checked');
    }
    assert.equal(reads,0);assert.equal(t.counts().creates,0);passive.dispose();
  }finally{t.close();}
});
test('last-view detach survives a failed return observation and safely resumes through later read polling',async()=>{
  const t=setup();try{
    await t.service.configure({projectId:project});const r=await t.service.create({conversationId:'task-a',requestId:'source'});
    await t.service.control(r.id,'task-a',{expectedVersion:1,controller:'human'});const lease=randomUUID();
    await t.service.view(r.id,'task-a',{expectedVersion:2,viewerLeaseId:lease,targetId:'page-a'});
    await t.service.control(r.id,'task-a',{expectedVersion:2,controller:'agent'});
    const original=t.cdp.execute;let failed=true,reads=0;
    t.cdp.execute=async(url,id,operation,args,options)=>{assert.equal(operation,'tabs');reads++;if(failed)throw new BrowserbaseCdpError('connection_unavailable','none');return original(url,id,operation,args,options);};
    await assert.rejects(t.service.detach(r.id,'task-a',{viewerLeaseId:lease}),/connection_unavailable/);
    const pending=await t.service.get(r.id,'task-a');assert.equal(pending.returnPending,true);assert.equal(pending.errorCode,'control_return_observation_pending');
    failed=false;const resumed=await t.service.get(r.id,'task-a');assert.equal(resumed.returnPending,false);assert.equal(resumed.controller,'agent');assert.equal(resumed.controlVersion,4);assert.equal(reads,3);assert.equal(t.counts().creates,1);
  }finally{t.close();}
});
