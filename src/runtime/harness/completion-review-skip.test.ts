import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationalReviewSkipRecord, conversationalReviewSkipMatches, isConversationalReviewSkip } from './completion-review-skip.js';
import type { ObjectiveJudgeGateInput } from './objective-judge.js';
const gate: ObjectiveJudgeGateInput = {optIn:true,actionIntent:false,meaningfulToolEvidence:false,sourceWorkAttempted:false,settledSourceEffects:0,settledEvidenceAvailable:true,multiResultObjective:false,acceptedExecutionEvidence:false,continuationsUsed:0,maxContinuations:2,nextAction:'completed',promiseShaped:false,claimedCompletedWork:false,openApprovalCard:false};
const input={sourceUserSeq:7,objective:'Hello',reply:'Hello!',gate};

test('only positive conversational evidence can describe an intentional skip',()=>{
 assert(isConversationalReviewSkip(gate));
 for(const changed of [{actionIntent:true},{meaningfulToolEvidence:true},{sourceWorkAttempted:true},{sourceWorkAttempted:undefined},{settledSourceEffects:1},{settledEvidenceAvailable:false},{settledEvidenceAvailable:undefined},{promiseShaped:true},{openApprovalCard:true},{continuationsUsed:1},{nextAction:'awaiting_user_input'},{optIn:false}]) {
  assert.equal(conversationalReviewSkipRecord({...input,gate:{...gate,...changed}}),undefined,JSON.stringify(changed));
 }
});

test('non-action artifact-shaped answers record policy skip without certifying new work',()=>{
 const lookup={...gate,claimedCompletedWork:true};
 const record=conversationalReviewSkipRecord({...input,reply:'/tmp/existing.txt',gate:lookup});
 assert.equal(record?.reason,'non_action_without_new_work');
 assert(conversationalReviewSkipMatches(record,{...input,reply:'/tmp/existing.txt'}));
 for(const changed of [{actionIntent:true},{meaningfulToolEvidence:true},{sourceWorkAttempted:true},{settledSourceEffects:1},{settledEvidenceAvailable:false},{promiseShaped:true},{continuationsUsed:1}]) {
  assert.equal(conversationalReviewSkipRecord({...input,gate:{...lookup,...changed}}),undefined,JSON.stringify(changed));
 }
 assert.equal(conversationalReviewSkipMatches(record,{...input,reply:'/tmp/changed.txt'}),false);
});

test('a skip cannot be carried to another source, objective, or answer',()=>{
 const record=conversationalReviewSkipRecord(input);
 assert(conversationalReviewSkipMatches(record,input));
 for(const changed of [{sourceUserSeq:8},{objective:'Create a file'},{reply:'I created it'}]) assert.equal(conversationalReviewSkipMatches(record,{...input,...changed}),false);
 for(const record of [null,{}, {version:1,gate:{}}, {...conversationalReviewSkipRecord(input),gate:{...gate,sourceWorkAttempted:true}}]) assert.equal(conversationalReviewSkipMatches(record,input),false);
});

test('retained-context action skip is explicit and cannot waive new or unobserved work',()=>{
 const retained={...gate,actionIntent:true,meaningfulToolEvidence:true};
 const record=conversationalReviewSkipRecord({...input,gate:retained});
 assert.equal(record?.reason,'retained_context_without_new_work');
 assert(conversationalReviewSkipMatches(record,input));
 for(const changed of [{sourceWorkAttempted:true},{sourceWorkAttempted:undefined},{multiResultObjective:true},{multiResultObjective:undefined},{acceptedExecutionEvidence:true},{acceptedExecutionEvidence:undefined},{settledEvidenceAvailable:false},{settledSourceEffects:1},{claimedCompletedWork:true},{promiseShaped:true},{continuationsUsed:1}]) {
  assert.equal(conversationalReviewSkipRecord({...input,gate:{...retained,...changed}}),undefined,JSON.stringify(changed));
 }
 assert.equal(conversationalReviewSkipMatches({...record,reason:'conversation_without_work'},input),false);
 assert.equal(conversationalReviewSkipMatches(record,{...input,sourceUserSeq:8}),false);
});
