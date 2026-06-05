/**
 * Run: npx tsx --test src/execution/trace-to-workflow.test.ts
 *
 * Pure reconstruction: a chat session's substantive tool calls → workflow
 * draft. The harness.db reader (draftWorkflowFromSession) is a thin wrapper
 * verified live, not here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  traceToWorkflowDraft,
  isPromotableTool,
  composioSlug,
  type TraceToolCall,
} from './trace-to-workflow.js';

const call = (tool: string, args = '{}', slug?: string): TraceToolCall => ({
  tool, args, slug: slug ?? composioSlug(tool, args), callId: `c-${Math.round(args.length)}-${tool}`,
});

test('isPromotableTool: drops meta/recursion, discovery/plumbing, memory — keeps work tools', () => {
  assert.equal(isPromotableTool('workflow_run'), false);      // reused step-agent blocklist
  assert.equal(isPromotableTool('ask_user_question'), false);
  assert.equal(isPromotableTool('composio_search_tools'), false); // discovery
  assert.equal(isPromotableTool('memory_write'), false);
  assert.equal(isPromotableTool('recall_search'), false);
  assert.equal(isPromotableTool('composio_execute_tool'), true);  // work
  assert.equal(isPromotableTool('run_shell_command'), true);
});

test('composioSlug: extracts the action slug from gateway args', () => {
  assert.equal(composioSlug('composio_execute_tool', '{"tool":"GMAIL_SEND_EMAIL","arguments":{}}'), 'GMAIL_SEND_EMAIL');
  assert.equal(composioSlug('composio_execute_tool', '{"slug":"SALESFORCE_GET_RECORDS"}'), 'SALESFORCE_GET_RECORDS');
  assert.equal(composioSlug('run_shell_command', '{"command":"ls"}'), undefined);
});

test('traceToWorkflowDraft: a composio step locks allowedTools to the slug family + names the slug', () => {
  const draft = traceToWorkflowDraft([
    call('composio_execute_tool', '{"tool":"SALESFORCE_GET_RECORDS","arguments":{"soql":"SELECT ..."}}'),
  ]);
  assert.equal(draft.steps.length, 1);
  assert.deepEqual(draft.steps[0].allowedTools, ['composio_execute_tool']);
  assert.match(draft.steps[0].prompt, /SALESFORCE_GET_RECORDS/);
  assert.equal(draft.steps[0].observed.slug, 'SALESFORCE_GET_RECORDS');
});

test('traceToWorkflowDraft: filters exploration, keeps actions, chains linearly', () => {
  const draft = traceToWorkflowDraft([
    call('composio_search_tools', '{"q":"salesforce"}'),                                   // dropped
    call('composio_execute_tool', '{"tool":"SALESFORCE_GET_RECORDS","arguments":{}}'),      // step 1
    call('workflow_get', '{"name":"x"}'),                                                   // dropped
    call('run_shell_command', '{"command":"python enrich.py"}'),                            // step 2
  ]);
  assert.equal(draft.toolCallCount, 2);
  assert.equal(draft.steps.length, 2);
  assert.equal(draft.steps[0].dependsOn, undefined);
  assert.deepEqual(draft.steps[1].dependsOn, [draft.steps[0].id]); // linear chain
  assert.match(draft.steps[1].prompt, /python enrich\.py/);
  assert.deepEqual(draft.steps[1].allowedTools, ['run_shell_command']);
});

test('traceToWorkflowDraft: coalesces consecutive same-slug calls into one step + flags forEach', () => {
  const draft = traceToWorkflowDraft([
    call('composio_execute_tool', '{"tool":"DATAFORSEO_RANKED_KEYWORDS","arguments":{"target":"a.com"}}'),
    call('composio_execute_tool', '{"tool":"DATAFORSEO_RANKED_KEYWORDS","arguments":{"target":"b.com"}}'),
    call('composio_execute_tool', '{"tool":"DATAFORSEO_RANKED_KEYWORDS","arguments":{"target":"c.com"}}'),
  ]);
  assert.equal(draft.steps.length, 1);          // coalesced
  assert.equal(draft.steps[0].observed.calls, 3);
  assert.match(draft.steps[0].prompt, /ran 3×/);
  assert.match(draft.steps[0].prompt, /forEach/);
});

test('traceToWorkflowDraft: unique step ids even for same tool used non-consecutively', () => {
  const draft = traceToWorkflowDraft([
    call('composio_execute_tool', '{"tool":"GMAIL_SEND_EMAIL","arguments":{}}'),
    call('run_shell_command', '{"command":"sleep 1"}'),
    call('composio_execute_tool', '{"tool":"GMAIL_SEND_EMAIL","arguments":{}}'),
  ]);
  const ids = draft.steps.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length); // all unique
});

test('isPromotableTool: drops execution-tracking scaffolding + request_approval (handled as a gate)', () => {
  assert.equal(isPromotableTool('execution_create'), false);
  assert.equal(isPromotableTool('execution_update_step'), false);
  assert.equal(isPromotableTool('execution_complete'), false);
  assert.equal(isPromotableTool('tool_choice_recall'), false);
  assert.equal(isPromotableTool('request_approval'), false);
});

test('traceToWorkflowDraft: request_approval becomes a GATE on the next step, not its own step', () => {
  const draft = traceToWorkflowDraft([
    call('composio_execute_tool', '{"tool":"SALESFORCE_GET_RECORDS","arguments":{}}'),
    call('request_approval', '{"subject":"Send 10 emails","preview":"Send 10 outreach emails"}'),
    call('composio_execute_tool', '{"tool":"OUTLOOK_OUTLOOK_SEND_EMAIL","arguments":{}}'),
  ]);
  assert.equal(draft.steps.length, 2); // approval is NOT a step
  assert.equal(draft.steps[0].requiresApproval, undefined);
  assert.equal(draft.steps[1].requiresApproval, true);
  assert.equal(draft.steps[1].approvalPreview, 'Send 10 outreach emails');
  assert.match(draft.notes.join(' '), /approval gate from the original run was preserved/i);
});

test('traceToWorkflowDraft: scaffolding between actions is filtered (real-trace shape)', () => {
  // Mirrors a real session: execution-tracking + recall interleaved with 2 real actions.
  const draft = traceToWorkflowDraft([
    call('tool_choice_recall', '{"intent":"airtable"}'),
    call('composio_execute_tool', '{"tool":"AIRTABLE_LIST_RECORDS","arguments":{}}'),
    call('execution_create', '{"title":"x"}'),
    call('execution_update_step', '{"id":"1"}'),
    call('run_shell_command', '{"command":"python enrich.py"}'),
    call('execution_complete', '{"id":"1"}'),
  ]);
  assert.equal(draft.toolCallCount, 2);
  assert.deepEqual(draft.steps.map((s) => s.id), ['airtable-list-records', 'python']);
});

test('traceToWorkflowDraft: request_approval as the LAST call is NOT lost — warns, does not gate the prior step', () => {
  const draft = traceToWorkflowDraft([
    call('composio_execute_tool', '{"tool":"SALESFORCE_GET_RECORDS","arguments":{}}'),
    call('request_approval', '{"preview":"Review the pull"}'),
  ]);
  assert.equal(draft.steps.length, 1);
  assert.equal(draft.steps[0].requiresApproval, undefined); // the action already ran ungated — don't fake a gate
  assert.match(draft.notes.join(' '), /ended with an approval request that had no following action/i);
});

test('traceToWorkflowDraft: distinct no-slug calls do NOT coalesce (separate shell commands stay separate)', () => {
  const draft = traceToWorkflowDraft([
    call('run_shell_command', '{"command":"python a.py"}'),
    call('run_shell_command', '{"command":"python b.py"}'),
  ]);
  assert.equal(draft.steps.length, 2); // not merged
  assert.match(draft.notes.join(' '), /shell command was captured verbatim/i); // secret-leak heads-up
});

test('traceToWorkflowDraft: composio call with an unparsable slug gets an explicit refine prompt, tools still locked', () => {
  const draft = traceToWorkflowDraft([
    { tool: 'composio_execute_tool', args: '{"garbled":true}', callId: 'x' }, // no slug field
  ]);
  assert.equal(draft.steps.length, 1);
  assert.deepEqual(draft.steps[0].allowedTools, ['composio_execute_tool']);
  assert.match(draft.steps[0].prompt, /couldn't be detected/i);
});

test('traceToWorkflowDraft: a session with no actions returns an honest note, no steps', () => {
  const draft = traceToWorkflowDraft([
    call('composio_search_tools', '{}'),
    call('workflow_list', '{}'),
    call('recall_search', '{}'),
  ]);
  assert.equal(draft.steps.length, 0);
  assert.equal(draft.toolCallCount, 0);
  assert.match(draft.notes.join(' '), /No substantive actions/);
});

test('traceToWorkflowDraft: emits review caveats (skeleton / parameterize / data-flow)', () => {
  const draft = traceToWorkflowDraft([call('composio_execute_tool', '{"tool":"X_DO","arguments":{}}')]);
  const notes = draft.notes.join(' ');
  assert.match(notes, /review and sharpen/i);
  assert.match(notes, /\{\{input\.X\}\}/);
  assert.match(notes, /\{\{steps\.<id>\.output\}\}/);
});
