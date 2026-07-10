import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completionEvidenceToolName,
  hasMeaningfulSuccessfulToolNames,
  isControlOnlyTool,
  isReadOnlyCompletionEvidence,
  isToolSurfaceProbeTool,
  objectiveMayRequireMultipleResults,
  objectiveRequiresMutatingEvidence,
  toolOutputLooksSuccessful,
} from './tool-evidence.js';

test('probe-only tool calls are not completion evidence', () => {
  for (const name of ['memory_search', 'composio_search_tools', 'clementine-local__tool_choice_recall']) {
    assert.equal(isToolSurfaceProbeTool(name), true);
  }
  assert.equal(hasMeaningfulSuccessfulToolNames(['memory_search', 'composio_search_tools']), false);
  assert.equal(hasMeaningfulSuccessfulToolNames(['memory_search', 'write_file']), true);
});

test('control and read tools cannot certify a mutating objective', () => {
  for (const name of ['ask_user_question', 'request_approval', 'workflow_step_result', 'dispatch_background_task']) {
    assert.equal(isControlOnlyTool(name), true, name);
  }
  assert.equal(isReadOnlyCompletionEvidence('read_file'), true);
  assert.equal(isReadOnlyCompletionEvidence('calendar__getEvent'), true);
  assert.equal(objectiveRequiresMutatingEvidence('Build and save the report'), true);
  assert.equal(hasMeaningfulSuccessfulToolNames(['ask_user_question'], 'send the email'), false);
  assert.equal(hasMeaningfulSuccessfulToolNames(['read_file'], 'build the app'), false);
  assert.equal(hasMeaningfulSuccessfulToolNames(['read_file', 'write_file'], 'build the app'), true);
  assert.equal(hasMeaningfulSuccessfulToolNames(['read_file'], 'summarize this file'), true);
});

test('multiplexer evidence keeps the concrete action slug', () => {
  assert.equal(
    completionEvidenceToolName('composio_execute_tool', { tool_slug: 'GMAIL_SEND_EMAIL' }),
    'GMAIL_SEND_EMAIL',
  );
  assert.equal(
    completionEvidenceToolName('composio_execute_tool', { tool_slug: 'GMAIL_FETCH_EMAILS' }),
    'GMAIL_FETCH_EMAILS',
  );
  assert.equal(hasMeaningfulSuccessfulToolNames(['GMAIL_FETCH_EMAILS'], 'send the email'), false);
  assert.equal(hasMeaningfulSuccessfulToolNames(['GMAIL_SEND_EMAIL'], 'send the email'), true);
  assert.equal(
    completionEvidenceToolName('call_tool', { name: 'task_hygiene', args_json: '{}' }),
    'task_hygiene',
  );
});

test('failed tool outputs are never successful evidence', () => {
  assert.equal(toolOutputLooksSuccessful('ERROR: timed out'), false);
  assert.equal(toolOutputLooksSuccessful('FAILED: permission denied'), false);
  assert.equal(
    toolOutputLooksSuccessful('\u26a0\uFE0F composio_execute_tool FAILED (slug=OUTLOOK_GET_EVENTS): entity mismatch'),
    false,
  );
  assert.equal(toolOutputLooksSuccessful('GMAIL NOT CONNECTED (slug=GMAIL_SEND_EMAIL): no account'), false);
  assert.equal(toolOutputLooksSuccessful('An error occurred while running the tool. Please try again.'), false);
  assert.equal(toolOutputLooksSuccessful('{"error":"arg_validation","detail":"name is required"}'), false);
  assert.equal(toolOutputLooksSuccessful('{"successful":false,"data":{}}'), false);
  assert.equal(toolOutputLooksSuccessful({ ok: false, error: 'permission denied' }), false);
  assert.equal(toolOutputLooksSuccessful({ data: { http_error: '403 Forbidden' } }), false);
  assert.equal(toolOutputLooksSuccessful({ data: { status_code: 404 } }), false);
  assert.equal(toolOutputLooksSuccessful('saved proof/report.md'), true);
  assert.equal(
    toolOutputLooksSuccessful({ successful: true, error: 'deprecation notice', data: { status_code: 20000 } }),
    true,
  );
  assert.equal(toolOutputLooksSuccessful('{"error":null,"data":{"rows":[]}}'), true);
  assert.equal(toolOutputLooksSuccessful('saved proof/report.md', false), false);
});

test('multi-result objectives retain completeness verification after one successful mutation', () => {
  for (const objective of [
    'send the emails',
    'send 3 emails',
    'update both reports',
    'create the brief and send it',
    '- create the draft\n- publish the post',
  ]) {
    assert.equal(objectiveMayRequireMultipleResults(objective), true, objective);
  }
  for (const objective of ['send the email', 'create a report', 'update this file']) {
    assert.equal(objectiveMayRequireMultipleResults(objective), false, objective);
  }
});
