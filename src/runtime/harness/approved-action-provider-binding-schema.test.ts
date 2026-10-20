/** Offline database guards only. No tool, model, transport or live-home access. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import { applyHarnessMigrations, applyHarnessMigrationsThroughVersionForTests } from './eventlog-schema.js';
import { assertApprovedActionCompletionReceipt } from './approved-action-completion-proof.js';

const NOW = '2026-10-19T00:00:00.000Z';
const hex = (letter: string): string => letter.repeat(64);
const digest = (value: unknown): string => createHash('sha256').update(closedCanonicalJson(value)).digest('hex');
const shaBytes = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
type Json = Record<string, unknown>;

function fixture(version = 97) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  applyHarnessMigrationsThroughVersionForTests(db, version);
  db.prepare("INSERT INTO sessions(id,kind,status,metadata_json,created_at,updated_at) VALUES('owned','chat','active','{}',?,?)").run(NOW,NOW);
  const event = (id: string, type: string, data: Json, role = 'system') => Number(db.prepare(
    "INSERT INTO events(id,session_id,turn,role,type,data_json,created_at) VALUES(?,'owned',7,?,?,?,?)",
  ).run(id,role,type,closedCanonicalJson(data),NOW).lastInsertRowid);
  const original = event('original','user_input_received',{ text:'Controlled schema-only request.' },'user');
  const source = event('decision','user_input_received',{ synthetic:true,source:'approval_resume',approvalId:'card',decision:'approve' },'user');
  event('graph','turn_graph_compiled',{ graphHash:hex('a'),graphId:'graph',sourceUserSeq:source });
  const task = `task:owned#${source}`;
  db.prepare(`INSERT INTO accepted_task_resolutions(session_id,source_user_seq,accepted_task_id,graph_event_id,graph_id,graph_hash,
    compiler_version,route,work_kind,effect_ceiling,external_effect_requested,opened_at)
    VALUES('owned',?,?,'graph','graph',?,'fixture','act','execute','external_write',1,?)`).run(source,task,hex('a'),NOW);
  db.prepare(`INSERT INTO accepted_task_authority(session_id,source_user_seq,accepted_task_id,authority_protocol,graph_event_id,
    graph_id,graph_hash,state,armed_at,updated_at,expected_work_required)
    VALUES('owned',?,?,1,'graph','graph',?,'armed',?,?,1)`).run(source,task,hex('a'),NOW,NOW);
  // The current logical ledger's FK targets the separate accepted call root.
  // This schema-only fixture supplies its genuine graph shape, not a host_v1
  // alias or a fabricated provider/grounding authority.
  db.prepare(`INSERT INTO accepted_turn_call_authorities(session_id,source_user_seq,accepted_task_id,authority_protocol,
    authority_kind,source_event_id,source_event_digest,source_turn,engine_version,surface_version,surface_digest,effect_ceiling,
    effect_bounds_json,binding_revision_digest,graph_event_id,graph_hash,authority_digest,opened_at)
    VALUES('owned',?,?,1,'turn_graph','decision',?,7,'fixture','turn_graph_ir_v1',?,'external_write','[]',?,'graph',?,?,?)`)
    .run(source,task,hex('4'),hex('5'),hex('a'),hex('a'),hex('6'),NOW);
  db.prepare(`INSERT INTO run_attempts(attempt_id,session_id,run_id,started_at,status,source_user_seq)
    VALUES('attempt','owned','run',?,'active',?)`).run(NOW,source);
  const payload = { tool_slug:'SLACK_SEND_MESSAGE',arguments:'{"channel":"CONTROLLED","text":"Schema fixture only."}',connected_account_id:'ca-controlled' };
  const args = { pendingActionId:'action',pendingAction:{ id:'action',payloadHash:'0123456789abcdef',toolName:'composio_execute_tool',payload,executionAuthority:null } };
  db.prepare(`INSERT INTO pending_approvals(approval_id,session_id,requested_at,expires_at,subject,tool,args_json,status,resolution)
    VALUES('card','owned',?,?,'Controlled schema fixture','request_approval',?,'resolved','approved')`).run(NOW,NOW,closedCanonicalJson(args));
  const intent: Json = { version:1,scope:'exact_approved_call',sessionId:'owned',sourceUserSeq:source,sourceEventId:'decision',turn:7,
    acceptedTaskId:task,graphEventId:'graph',graphId:'graph',graphHash:hex('a'),originalSourceUserSeq:original,approvalId:'card',
    pendingActionId:'action',payloadHash:'0123456789abcdef',executionAuthorityDigest:digest(null),approvalSnapshotDigest:digest(args),
    claimHash:hex('b'),attemptId:'attempt',logicalToolCallId:'logical',toolName:'slack_send_message',argumentDigest:hex('c'),
    effect:'external_write',observedSchemaFingerprint:null,providerDispatchProtocol:'approved_composio_sdk_v1' };
  const saveIntent = (body: Json = intent) => {
    event('intent-event','approved_action_completion_intent',{sourceUserSeq:source,intentId:'intent',intent:body});
    db.prepare('INSERT INTO approved_action_completion_intents_v1 VALUES(?,?,?,?,?,?)')
      .run('intent','owned',source,closedCanonicalJson(body),'intent-event',NOW);
  };
  const savePhysical = (refined = false, providerArgumentDigest = hex('d')) => {
    db.prepare(`INSERT INTO logical_tool_calls(session_id,source_user_seq,accepted_task_id,logical_tool_call_id,tool_name,
      argument_digest,raw_argument_digest,opened_at) VALUES('owned',?,?,'logical','slack_send_message',?,?,?)`).run(source,task,hex('c'),hex('c'),NOW);
    if(refined) {
      event('refinement','logical_call_contract_refined',{sourceUserSeq:source,acceptedTaskId:task,logicalToolCallId:'logical',
        tool:'slack_send_message',rawArgumentDigest:hex('c'),effectiveArgumentDigest:hex('7')});
      db.prepare(`UPDATE logical_tool_calls SET argument_digest=?,effective_argument_digest=?,refined_at=?,refinement_event_id='refinement'
        WHERE session_id='owned' AND source_user_seq=? AND logical_tool_call_id='logical'`).run(hex('7'),hex('7'),NOW,source);
    }
    db.prepare(`INSERT INTO run_dispatch_leases(scope_id,session_id,lease_id,run_attempt_id,activated_at,source_user_seq,accepted_task_id,
      logical_tool_call_id,recovery_effect,recovery_business_call,recovery_tool_name,recovery_argument_digest,recovery_argument_cipher)
      VALUES('lease-scope','owned','lease','attempt',?, ?,?,'logical','external_write',1,'slack_send_message',?,'sealed-schema-fixture')`).run(NOW,source,task,hex('c'));
    event('start-event','provider_dispatch_started',{sourceUserSeq:source,logicalToolCallId:'logical'});
    db.prepare(`INSERT INTO physical_dispatches(session_id,source_user_seq,accepted_task_id,logical_tool_call_id,physical_dispatch_id,
      ordinal,relation,tool_name,argument_digest,provider_argument_digest,started_at,start_event_id,lease_scope_id,lease_id)
      VALUES('owned',?,?,'logical','physical',1,'primary','slack_send_message',?,?,?,'start-event','lease-scope','lease')`).run(source,task,hex(refined?'7':'c'),providerArgumentDigest,NOW);
  };
  const body: Json = { version:1,protocol:'approved_composio_sdk_v1',intentId:'intent',sessionId:'owned',sourceUserSeq:source,acceptedTaskId:task,
    originalSourceUserSeq:original,approvalId:'card',pendingActionId:'action',payloadHash:'0123456789abcdef',approvalSnapshotDigest:digest(args),
    claimHash:hex('b'),logicalToolCallId:'logical',attemptId:'attempt',toolName:'slack_send_message',rawArgumentDigest:hex('c'),
    effectiveArgumentDigest:hex('c'),refinementEventId:null,providerOperationId:'SLACK_SEND_MESSAGE',providerOperationVersion:'20261019_00',
    providerArgumentDigest:hex('d'),providerInputSchemaDigest:hex('e'),schemaFingerprint:'f'.repeat(32),connectedAccountId:'ca-controlled',
    accountIdentityDigest:hex('1'),providerOwnerIdentityDigest:hex('2'),invokePortId:'composio_sdk_v3_execute',effect:'external_write',
    physicalDispatchId:'physical',leaseScopeId:'lease-scope',leaseId:'lease' };
  const saveBinding = (binding: Json = body, mirrorBinding: Json = binding) => {
    const bindingId = `approved-composio-binding:v1:${digest(binding)}`;
    event('binding-event','approved_action_provider_bound',{sourceUserSeq:source,bindingId,binding:mirrorBinding});
    db.prepare(`INSERT INTO approved_action_provider_bindings_v1
      (binding_id,intent_id,session_id,source_user_seq,logical_tool_call_id,physical_dispatch_id,binding_json,binding_event_id,prepared_at)
      VALUES(?,'intent','owned',?,'logical','physical',?,'binding-event',?)`).run(bindingId,source,closedCanonicalJson(binding),NOW);
    return bindingId;
  };
  const saveReceipt = (extra: Json = {}) => {
    const receipt = { version:1,scope:'exact_approved_call',intentId:'intent',sessionId:'owned',sourceUserSeq:source,
      logicalToolCallId:'logical',physicalDispatchId:'physical',...extra };
    event('receipt-event','approved_action_completion_receipt',{receiptId:'receipt',receipt});
    db.prepare('INSERT INTO approved_action_completion_receipts_v1 VALUES(?,?,?,?,?,?,?)')
      .run('receipt','owned',source,'intent',closedCanonicalJson(receipt),'receipt-event',NOW);
  };
  return {db,event,source,original,intent,body,saveIntent,savePhysical,saveBinding,saveReceipt};
}

test('real 95→97 and 96→97 migrations retain historical bytes and the exact memory schema', () => {
  for (const version of [95,96]) {
    const f = fixture(version);
    try {
      // These rows rehearse byte preservation, not a fabricated canonical completion.
      if (version===96) { const legacy={...f.intent};delete legacy.providerDispatchProtocol;f.saveIntent(legacy);f.saveReceipt(); }
      const tables = ['sessions','events','run_attempts','accepted_task_authority','durable_memory_intake_receipts',
        ...(version===96?['approved_action_completion_intents_v1','approved_action_completion_receipts_v1']:[])];
      const before = tables.map(t=>f.db.prepare(`SELECT * FROM ${t}`).all());
      const memory = f.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='durable_memory_intake_receipts' ORDER BY type,name").all();
      applyHarnessMigrations(f.db);
      assert.deepEqual(tables.map(t=>f.db.prepare(`SELECT * FROM ${t}`).all()),before);
      assert.deepEqual(f.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='durable_memory_intake_receipts' ORDER BY type,name").all(),memory);
      assert.equal(f.db.prepare('SELECT max(version) v FROM schema_version').get()?.v,97);
      assert.deepEqual(f.db.prepare('SELECT * FROM approved_action_provider_bindings_v1').all(),[]);
      assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
      applyHarnessMigrations(f.db);
      assert.deepEqual(tables.map(t=>f.db.prepare(`SELECT * FROM ${t}`).all()),before);
    } finally {f.db.close();}
  }
});

test('a genuine committed schema96 canonical receipt migrates unchanged and reopens through the actual terminal reader', () => {
  const base=new URL('./fixtures/approved-action-v96/',import.meta.url);
  const manifest=JSON.parse(readFileSync(new URL('manifest.json',base),'utf8'));
  assert.equal(manifest.exactSource,'2d73a173ece57ee559266d70b3c9da5b1eaaf08c');
  assert.equal(manifest.sourceClean,true);assert.equal(manifest.schema,96);
  assert.equal(manifest.canonicalBeforeMigration,true);assert.equal(manifest.modelCalls,0);assert.equal(manifest.providerCalls,0);
  const compressed=readFileSync(new URL('receipt.db.gz',base));
  assert.equal(shaBytes(compressed),'454c4feb6cf10112a05bbfa41f612f3a854bda5d25afb784632c809e713d0791');
  const bytes=gunzipSync(compressed);
  assert.equal(shaBytes(bytes),'4e8ec6f25aa4e6059c2779cb57bf7fdbbfaee418112d59e9ceeb29a66abdbb60');
  assert.equal(manifest.dbSha256,shaBytes(bytes));
  const home=mkdtempSync(path.join(os.tmpdir(),'clem-genuine-v96-reopen-'));
  const historical=path.join(home,'schema96.db');writeFileSync(historical,bytes);
  const db=new Database(historical);
  try {
    db.pragma('foreign_keys=ON');assert.equal(db.prepare('SELECT max(version) v FROM schema_version').get()?.v,96);
    const authority=()=>db.prepare('SELECT * FROM accepted_task_authority WHERE session_id=? AND source_user_seq=?')
      .get(manifest.sessionId,manifest.sourceUserSeq) as {session_id:string;source_user_seq:number;host_completion_receipt_id:string|null;host_completion_event_id:string|null};
    assert.equal(authority().host_completion_receipt_id,manifest.receiptId);
    assertApprovedActionCompletionReceipt(db,authority());
    const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='schema_version' ORDER BY name").all() as {name:string}[]).map(row=>row.name);
    const snapshot=()=>tables.map(table=>({table,rows:db.prepare(`SELECT * FROM "${table.replaceAll('"','""')}"`).all()}));
    const before=snapshot();
    const intentBefore=db.prepare('SELECT * FROM approved_action_completion_intents_v1').all();
    const receiptBefore=db.prepare('SELECT * FROM approved_action_completion_receipts_v1').all();
    assert.equal(intentBefore.length,1);assert.equal(receiptBefore.length,1);
    assert.equal((intentBefore[0] as {intent_id:string}).intent_id,manifest.intentId);
    assert.equal((receiptBefore[0] as {receipt_id:string}).receipt_id,manifest.receiptId);
    applyHarnessMigrations(db);
    assert.equal(db.prepare('SELECT max(version) v FROM schema_version').get()?.v,97);
    assert.deepEqual(snapshot(),before,'all populated schema96 rows, including original intent/receipt JSON, remain byte-identical');
    assert.deepEqual(db.prepare('SELECT * FROM approved_action_provider_bindings_v1').all(),[]);
    assertApprovedActionCompletionReceipt(db,authority());assert.deepEqual(db.pragma('foreign_key_check'),[]);
    mkdirSync(path.join(home,'state'),{recursive:true});writeFileSync(path.join(home,'state','harness.db'),db.serialize());
    const program=`const e=await import('./src/runtime/harness/eventlog.ts');try{const row=e.readValidatedTerminalEvent(${JSON.stringify(manifest.terminalEventId)},${JSON.stringify(manifest.sessionId)},${manifest.sourceUserSeq});if(row.id!==${JSON.stringify(manifest.terminalEventId)})throw new Error('wrong terminal');process.stdout.write('canonical-v96-terminal-reopened');}finally{e.closeEventLog();}`;
    const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',program],{
      cwd:process.cwd(),env:{...process.env,CLEMENTINE_HOME:home,CLEMMY_TEST_ISOLATED_HOME:'1',CLEMMY_TEST_DISABLE_LIVE_MODELS:'1',
        MCP_AUTO_IMPORT_ENABLED:'false',EMBEDDINGS_DISABLED:'true',OPENAI_AGENTS_DISABLE_TRACING:'1'},encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024,
    });
    assert.equal(child.status,0,`${child.error?.name??''}\n${child.stderr}`);
    assert.match(child.stdout,/canonical-v96-terminal-reopened/);
  } finally {db.close();rmSync(home,{recursive:true,force:true});}
});

test('v97 refuses an unsanctioned lookalike atomically without stamping or rewriting v96', () => {
  const f=fixture(96);
  try {
    f.db.exec('CREATE TABLE approved_action_provider_bindings_v1(untrusted TEXT)');
    const before=f.db.serialize();
    assert.throws(()=>applyHarnessMigrations(f.db),/v97 refuses preexisting unsanctioned/);
    assert.deepEqual(f.db.serialize(),before);
    assert.equal(f.db.prepare('SELECT max(version) v FROM schema_version').get()?.v,96);
  } finally {f.db.close();}
});

test('new supported write intents require the protocol, and other scopes cannot claim it', () => {
  for (const change of [ {providerDispatchProtocol:undefined}, {providerDispatchProtocol:null}, {providerDispatchProtocol:'other'},
    {effect:'read'}, {scope:'unrelated'} ]) {
    const f=fixture();
    try {
      const body={...f.intent,...change};if(body.providerDispatchProtocol===undefined)delete body.providerDispatchProtocol;
      assert.throws(()=>f.saveIntent(body),/exact declared provider protocol/);
    }
    finally {f.db.close();}
  }
  const f=fixture();try {f.saveIntent();assert.equal(f.db.prepare('SELECT count(*) n FROM approved_action_completion_intents_v1').get()?.n,1);}finally{f.db.close();}
});

test('the exact unclaimed SDK provider binding is immutable and its future receipt must name its digest', () => {
  const f=fixture();
  try {
    f.saveIntent();f.savePhysical();const id=f.saveBinding();
    assert.throws(()=>f.db.prepare("UPDATE approved_action_provider_bindings_v1 SET prepared_at='changed'").run(),/immutable/);
    assert.throws(()=>f.db.prepare('DELETE FROM approved_action_provider_bindings_v1').run(),/immutable/);
    assert.throws(()=>f.saveReceipt(),/requires its exact provider binding/);
    f.db.prepare("DELETE FROM events WHERE id='receipt-event'").run();
    f.saveReceipt({providerBindingId:id,providerBindingDigest:digest(f.body)});
    assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
    f.db.prepare("DELETE FROM sessions WHERE id='owned'").run();
    assert.equal(f.db.prepare('SELECT count(*) n FROM approved_action_provider_bindings_v1').get()?.n,0);
    assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
  } finally {f.db.close();}
});

test('binding guards reject changed identity/account/effect/digest/lease and foreign event mirrors', () => {
  const changes: Json[] = [{connectedAccountId:'ca-foreign'},{claimHash:hex('3')},{originalSourceUserSeq:999},{attemptId:'foreign'},
    {leaseId:'foreign'},{effect:'read'},{effectiveArgumentDigest:hex('3')},{providerOperationId:'SLACK_OTHER'},
    {invokePortId:'other'},{unexpected:'extra'},{refinementEventId:'missing'}];
  for(const change of changes) {
    const f=fixture();try {f.saveIntent();f.savePhysical();assert.throws(()=>f.saveBinding({...f.body,...change}),/not exact unclaimed owned/);}
    finally{f.db.close();}
  }
  const f=fixture();try {f.saveIntent();f.savePhysical();assert.throws(()=>f.saveBinding(f.body,{...f.body,connectedAccountId:'other'}),/not exact unclaimed owned/);}finally{f.db.close();}
});

test('a physical dispatch with a different provider argument digest cannot obtain an otherwise exact binding', () => {
  const f=fixture();
  try {
    f.saveIntent();f.savePhysical(false,hex('3'));
    const physical=f.db.prepare('SELECT argument_digest,provider_argument_digest FROM physical_dispatches').get() as {
      argument_digest:string;provider_argument_digest:string;
    };
    assert.equal(physical.argument_digest,f.body.effectiveArgumentDigest,'logical/effective identity is otherwise exact');
    assert.notEqual(physical.provider_argument_digest,f.body.providerArgumentDigest,'the provider boundary records different argument bytes');
    assert.throws(()=>f.saveBinding(),/not exact unclaimed owned/);
    assert.equal(f.db.prepare('SELECT count(*) n FROM approved_action_provider_bindings_v1').get()?.n,0);
  } finally {f.db.close();}
});

test('an exact retained raw-to-effective refinement precedes the bound SDK crossing', () => {
  const f=fixture();
  try {
    f.saveIntent();f.savePhysical(true);
    const body={...f.body,effectiveArgumentDigest:hex('7'),refinementEventId:'refinement'};
    f.saveBinding(body);
    assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
  } finally {f.db.close();}
});

test('claimed physical I/O, revoked leases and cancelled attempts cannot obtain a provider binding', () => {
  for(const sql of ["UPDATE physical_dispatches SET io_claimed_at='claimed'", "UPDATE run_dispatch_leases SET revoked_at='stopped'",
    "UPDATE run_attempts SET status='cancelled',finished_at='stopped'",
    "INSERT INTO run_kill_requests(session_id,scope_key,attempt_id,requested_at) VALUES('owned','attempt:attempt','attempt','stopped')",
    "INSERT INTO kill_switches(session_id,requested_at) VALUES('owned','stopped')"]) {
    const f=fixture();try {f.saveIntent();f.savePhysical();f.db.exec(sql);assert.throws(()=>f.saveBinding(),/not exact unclaimed owned/);}
    finally{f.db.close();}
  }
});

test('failed binding persistence rolls back its start and event in the caller transaction', () => {
  const f=fixture();
  try {
    f.saveIntent();
    const before=f.db.serialize();
    assert.throws(()=>f.db.transaction(()=>{f.savePhysical();f.saveBinding({...f.body,claimHash:hex('3')});}).immediate(),/not exact unclaimed owned/);
    assert.deepEqual(f.db.serialize(),before);
  } finally {f.db.close();}
});
