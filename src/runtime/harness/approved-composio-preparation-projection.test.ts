import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvedComposioPreparationProjection } from './approved-composio-preparation-projection.js';
const account='ca-controlled';
const carrier=(args:unknown)=>({tool_slug:'SLACK_SEND_MESSAGE',arguments:JSON.stringify(args),connected_account_id:account});
test('exact SDK preparation projection uses the existing normalizer and preserves business fields',()=>{
  const input=carrier({channel:'C-CONTROLLED',text:'Controlled update.',connected_account_id:account});
  assert.deepEqual(approvedComposioPreparationProjection(input),{toolSlug:'SLACK_SEND_MESSAGE',connectedAccountId:account,
    args:{channel:'C-CONTROLLED',text:'Controlled update.'}});
  assert.match(String(input.arguments),/connected_account_id/,'the frozen approved raw bytes never change');
  assert.notDeepEqual(approvedComposioPreparationProjection(carrier({channel:'C-OTHER',text:'Controlled update.'}))?.args,
    approvedComposioPreparationProjection(input)?.args,'different provider arguments stay different');
});
test('every present inline account selector must equal the exact explicit account',()=>{
  for(const key of ['connected_account_id','connectedAccountId','connection_id','connectionId']) {
    assert.deepEqual(approvedComposioPreparationProjection(carrier({channel:'C-CONTROLLED',[key]:account}))?.args,{channel:'C-CONTROLLED'});
    assert.equal(approvedComposioPreparationProjection(carrier({channel:'C-CONTROLLED',[key]:'ca-foreign'})),null);
  }
  assert.equal(approvedComposioPreparationProjection(carrier({connected_account_id:account,connectionId:'ca-foreign'})),null);
});
test('aliases, defaults, malformed arguments and sentinel accounts cannot prepare this exact protocol',()=>{
  assert.equal(approvedComposioPreparationProjection(carrier({account_alias:'work',channel:'C-CONTROLLED'})),null);
  for(const connected_account_id of [null,undefined,'','null','none',' ca-controlled '])
    assert.equal(approvedComposioPreparationProjection({...carrier({}),connected_account_id}),null);
  for(const arguments_ of ['[]','null','no-json'])
    assert.equal(approvedComposioPreparationProjection({...carrier({}),arguments:arguments_}),null);
});
test('the sanctioned explicit null no-arguments carrier has an exact empty projection',()=>{
  assert.deepEqual(approvedComposioPreparationProjection({tool_slug:'SLACK_SEND_MESSAGE',arguments:null,connected_account_id:account}),
    {toolSlug:'SLACK_SEND_MESSAGE',connectedAccountId:account,args:{}});
});
