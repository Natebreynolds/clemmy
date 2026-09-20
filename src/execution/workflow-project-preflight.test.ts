import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowProjectCreationErrors as errors } from './workflow-project-preflight.js';
const missing = {kind:'project' as const,name:'/repo/output',status:'missing' as const,reason:'not configured',stepIds:['read']};
test('known missing project is actionable before an enabled workflow is saved',()=>{
 const r=errors(true,[missing]);assert.equal(r.length,1);assert.match(r[0]!,/omit the project binding/);assert.match(r[0]!,/\/repo\/output/);
});
test('configured projects and unknown inventory add no new restriction',()=>{
 assert.deepEqual(errors(true,[{...missing,status:'ready'},{...missing,status:'unknown'}]),[]);
});
test('disabled drafts and unrelated tool readiness retain their existing semantics',()=>{
 assert.deepEqual(errors(false,[missing]),[]);
 assert.deepEqual(errors(true,[{...missing,kind:'local_tool'}]),[]);
});
