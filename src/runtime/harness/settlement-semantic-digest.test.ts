import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {settlementSemanticDigest} from './settlement-semantic-digest.js';

test('extracted semantic serializer preserves legacy bytes including empty and whitespace status/detail/governor values',()=>{
  for(const providerStatus of [undefined,'',' \n ',200,' 429 '])for(const detail of [undefined,'',' \n ',' exact  detail '])for(const governor of [undefined,'',' \n ',' evidence  detail ']) {
    const outcome={kind:'succeeded' as const,evidence:'structured' as const,...(providerStatus!==undefined?{providerStatus}:{}),
      ...(detail!==undefined?{detail}:{}),directive:{action:'settle' as const,retrySameCandidate:false,eliminatesCandidate:false,opensDiscoveryEpoch:false,requiresReconciliation:false}};
    const input={toolName:'controlled',argumentDigest:'a'.repeat(64),executionKind:'provider_execution' as const,resultHandleId:'result:controlled',outcome,
      recovery:{businessCall:true,mutating:true,...(governor!==undefined?{governorEvidence:{kind:'auth_recovered' as const,detail:governor,onlyIfProgressClaimed:true}}:{})}};
    const status=providerStatus===undefined?undefined:String(providerStatus).replace(/\s+/g,' ').trim().slice(0,64)||undefined;
    const oldDetail=detail?.replace(/\s+/g,' ').trim().slice(0,160)||undefined;
    const legacy={protocolVersion:1,toolName:input.toolName,argumentDigest:input.argumentDigest,executionKind:input.executionKind,resultHandleId:input.resultHandleId,
      outcome:{kind:outcome.kind,evidence:outcome.evidence,providerStatus:status??null,detail:oldDetail??null,directive:outcome.directive},
      recovery:{businessCall:true,mutating:true,requirementId:null,continuesRequirement:false,progressKeyDigest:null,
        governorEvidence:governor!==undefined?{kind:'auth_recovered',detail:governor.replace(/\s+/g,' ').trim().slice(0,256)||null,onlyIfProgressClaimed:true}:null}};
    assert.equal(settlementSemanticDigest(input as Parameters<typeof settlementSemanticDigest>[0]),createHash('sha256').update(JSON.stringify(legacy)).digest('hex'));
  }
});
