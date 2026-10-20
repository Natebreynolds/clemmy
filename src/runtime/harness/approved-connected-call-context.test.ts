import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerApprovedComposioPreparation,withApprovedComposioPreparation,registerApprovedComposioDispatchPermit,
  inspectApprovedComposioDispatchPermit,consumeApprovedComposioDispatchPermit,
  type ApprovedComposioPreparationIdentity,type ApprovedComposioResolvedIdentity } from './approved-connected-call-context.js';
const owner:ApprovedComposioPreparationIdentity={protocol:'approved_composio_sdk_v1',intentId:'intent',sessionId:'session',sourceUserSeq:2,
  acceptedTaskId:'task:session#2',logicalToolCallId:'call',attemptId:'attempt',toolName:'slack_send_message',rawArgumentDigest:'a'.repeat(64),
  preparationArgumentDigest:'a'.repeat(64),effect:'external_write',connectedAccountId:'ca-exact',
  lease:{sessionId:'session',scopeId:'parent',leaseId:'parent-1',runAttemptId:'attempt'}};
const resolved:ApprovedComposioResolvedIdentity={providerOperationId:'SLACK_SEND_MESSAGE',providerOperationVersion:'v1',providerArgumentDigest:'b'.repeat(64),
  providerInputSchemaDigest:'c'.repeat(64),schemaFingerprint:'d'.repeat(32),connectedAccountId:'ca-exact',accountIdentityDigest:'e'.repeat(64),
  providerOwnerIdentityDigest:'f'.repeat(64),effectiveArgumentDigest:'b'.repeat(64),refinementEventId:null,invokePortId:'composio_sdk_v3_execute'};
const child={sessionId:'session',scopeId:'child',leaseId:'child-1',runAttemptId:'attempt',sourceUserSeq:2,acceptedTaskId:'task:session#2',
  logicalToolCallId:'call',parentScopeId:'parent',parentLeaseId:'parent-1'};
test('approved SDK opaque permit retains exact account and child generation and consumes once',()=>{
  const handle=registerApprovedComposioPreparation(owner);
  withApprovedComposioPreparation(handle,()=>{
    // Identity returned by the current scope, never a structural owner copy.
    const {currentApprovedComposioPreparation}=requireContext();
    const preparation=currentApprovedComposioPreparation()!;
    const permit=registerApprovedComposioDispatchPermit(preparation,resolved,'dispatch',child);
    assert.equal(inspectApprovedComposioDispatchPermit(permit)?.lease.leaseId,'child-1');
    assert.equal(inspectApprovedComposioDispatchPermit({} as never),null);
    consumeApprovedComposioDispatchPermit(permit);
    assert.equal(inspectApprovedComposioDispatchPermit(permit),null);
    assert.throws(()=>consumeApprovedComposioDispatchPermit(permit),/consumed/);
  });
});
import * as context from './approved-connected-call-context.js';
function requireContext(){return context;}
test('approved SDK factory refuses foreign accounts, source, attempt and same-scope replacement generations',()=>{
  const handle=registerApprovedComposioPreparation(owner);
  withApprovedComposioPreparation(handle,()=>{
    const prep=context.currentApprovedComposioPreparation()!;
    assert.throws(()=>registerApprovedComposioDispatchPermit({...prep},resolved,'dispatch',child),/changed/);
    assert.throws(()=>registerApprovedComposioDispatchPermit(prep,{...resolved,connectedAccountId:'ca-foreign'},'dispatch',child),/changed/);
    for(const lease of [{...child,sessionId:'foreign'},{...child,sourceUserSeq:3},{...child,acceptedTaskId:'task:foreign#2'},
      {...child,runAttemptId:'foreign'},{...child,logicalToolCallId:'other'},{...child,parentScopeId:'foreign'},
      {...child,parentLeaseId:'rotated'},{...child,scopeId:'parent',leaseId:'rotated'}])
      assert.throws(()=>registerApprovedComposioDispatchPermit(prep,resolved,'dispatch',lease),/changed/);
  });
  assert.throws(()=>withApprovedComposioPreparation({} as never,()=>null),/registered/);
});

test('registered preparation and copyable identities are never physical permits',()=>{
  const handle=registerApprovedComposioPreparation(owner);
  // This module proves nominal separation only; registering a preparation is
  // not a persisted claim, resolved provider token, or permission to do I/O.
  assert.equal(inspectApprovedComposioDispatchPermit(handle as never),null);
  assert.equal(inspectApprovedComposioDispatchPermit({...owner,...resolved,physicalDispatchId:'dispatch'} as never),null);
  assert.equal(inspectApprovedComposioDispatchPermit({preparationArgumentDigest:owner.preparationArgumentDigest} as never),null);
  assert.throws(()=>consumeApprovedComposioDispatchPermit(handle as never),/consumed/);
  withApprovedComposioPreparation(handle,()=>{
    const prep=context.currentApprovedComposioPreparation()!;
    assert.equal(inspectApprovedComposioDispatchPermit(prep as never),null);
    assert.throws(()=>withApprovedComposioPreparation({...prep} as never,()=>null),/registered/);
  });
});

test('identical preparation identities cannot cross independently registered async scopes',async()=>{
  const first=registerApprovedComposioPreparation(owner);
  const second=registerApprovedComposioPreparation(owner);
  assert.equal(context.currentApprovedComposioPreparation(),null);
  await withApprovedComposioPreparation(first,async()=>{
    const firstIdentity=context.currentApprovedComposioPreparation()!;
    await Promise.resolve();
    assert.equal(context.currentApprovedComposioPreparation(),firstIdentity);
    withApprovedComposioPreparation(second,()=>{
      assert.notEqual(context.currentApprovedComposioPreparation(),firstIdentity);
      assert.throws(()=>registerApprovedComposioDispatchPermit(firstIdentity,resolved,'dispatch',child),/changed/);
    });
    assert.equal(context.currentApprovedComposioPreparation(),firstIdentity);
  });
  assert.equal(context.currentApprovedComposioPreparation(),null);
  assert.throws(()=>registerApprovedComposioDispatchPermit(owner,resolved,'dispatch',child),/changed/);
});

test('same-scope permit needs the exact registered bound generation and freezes its retained lease',()=>{
  const boundOwner:ApprovedComposioPreparationIdentity={...owner,lease:{...child}};
  const handle=registerApprovedComposioPreparation(boundOwner);
  withApprovedComposioPreparation(handle,()=>{
    const prep=context.currentApprovedComposioPreparation()!;
    const lease={...child};
    const permit=registerApprovedComposioDispatchPermit(prep,resolved,'dispatch-exact',lease);
    lease.leaseId='replaced-after-registration';
    assert.equal(inspectApprovedComposioDispatchPermit(permit)?.lease.leaseId,child.leaseId);
    assert.equal(Object.isFrozen(inspectApprovedComposioDispatchPermit(permit)?.lease),true);
    assert.throws(()=>registerApprovedComposioDispatchPermit(prep,resolved,'dispatch-foreign',lease),/changed/);
    consumeApprovedComposioDispatchPermit(permit);
    assert.equal(inspectApprovedComposioDispatchPermit(permit),null);
  });
});

test('resolved structural extras cannot replace the registered preparation owner',()=>{
  const handle=registerApprovedComposioPreparation(owner);
  withApprovedComposioPreparation(handle,()=>{
    const prep=context.currentApprovedComposioPreparation()!;
    const withForeignOwner={...resolved,sourceUserSeq:999,effect:'admin',intentId:'foreign-intent'};
    const permit=registerApprovedComposioDispatchPermit(prep,withForeignOwner,'dispatch-whitelist',child);
    const retained=inspectApprovedComposioDispatchPermit(permit)!;
    assert.equal(retained.sourceUserSeq,prep.sourceUserSeq);
    assert.equal(retained.effect,prep.effect);
    assert.equal(retained.intentId,prep.intentId);
    assert.equal(retained.providerArgumentDigest,resolved.providerArgumentDigest);
    consumeApprovedComposioDispatchPermit(permit);
  });
});
