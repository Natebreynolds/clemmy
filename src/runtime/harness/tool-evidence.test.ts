import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completionEvidenceToolName,
  hasMeaningfulSuccessfulToolNames,
  isControlOnlyTool,
  isAcceptedExecutionCompletionOutput,
  isReadOnlyCompletionEvidence,
  isToolSurfaceProbeTool,
  objectiveMayRequireMultipleResults,
  objectiveRequiresFreshExternalWrite,
  objectiveRequiresMutatingEvidence,
  freshExternalWriteEvidenceStatus,
  toolOutputLooksSuccessful,
} from './tool-evidence.js';

test('probe-only tool calls count only when the requested deliverable is that probe result', () => {
  for (const name of ['memory_search', 'composio_search_tools', 'clementine-local__tool_choice_recall']) {
    assert.equal(isToolSurfaceProbeTool(name), true);
  }
  assert.equal(hasMeaningfulSuccessfulToolNames(['memory_search', 'composio_search_tools']), false);
  assert.equal(
    hasMeaningfulSuccessfulToolNames(
      ['workspace_roots'],
      'Use local tools to report the configured workspace root paths.',
    ),
    true,
  );
  assert.equal(
    hasMeaningfulSuccessfulToolNames(['memory_recall'], 'What do you remember about my meal plan?'),
    true,
  );
  assert.equal(
    hasMeaningfulSuccessfulToolNames(['skill_list'], 'Which skills are installed?'),
    true,
  );
  assert.equal(
    hasMeaningfulSuccessfulToolNames(['workspace_roots'], 'Inspect the workspace and summarize the project.'),
    false,
  );
  assert.equal(
    hasMeaningfulSuccessfulToolNames(['workspace_roots'], 'Build the app in the workspace root.'),
    false,
  );
  assert.equal(hasMeaningfulSuccessfulToolNames(['memory_search', 'write_file']), true);
});

test('control and read tools cannot certify a mutating objective', () => {
  for (const name of ['ask_user_question', 'request_approval', 'workflow_step_result', 'dispatch_background_task']) {
    assert.equal(isControlOnlyTool(name), true, name);
  }
  assert.equal(isReadOnlyCompletionEvidence('read_file'), true);
  assert.equal(isReadOnlyCompletionEvidence('calendar__getEvent'), true);
  assert.equal(objectiveRequiresMutatingEvidence('Build and save the report'), true);
  assert.equal(
    objectiveRequiresMutatingEvidence('Do not run shell commands. Report the workspace root paths.'),
    false,
  );
  assert.equal(
    objectiveRequiresMutatingEvidence('Without changing files, inspect the workspace status.'),
    false,
  );
  assert.equal(
    objectiveRequiresMutatingEvidence('Do not send email, but write the local report.'),
    true,
  );
  assert.equal(
    objectiveRequiresMutatingEvidence('Do not run shell commands; write the report.'),
    true,
  );
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

test('accepted execution completion is distinguished from a rejected completion attempt', () => {
  assert.equal(
    isAcceptedExecutionCompletionOutput('Execution exec-123 completed. Verified 41 rows and zero mismatches.'),
    true,
  );
  assert.equal(
    isAcceptedExecutionCompletionOutput('Completion not accepted: unmet: verify the public artifact.\nExecution exec-123 remains active.'),
    false,
  );
  assert.equal(isAcceptedExecutionCompletionOutput({ status: 'completed' }), false);
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

test('fresh external-write requirement is destination-aware and ignores prohibitions/data fields', () => {
  for (const objective of [
    'Perform one Google Sheets value write, then read it back.',
    'Update the Airtable record.',
    'Deploy the validated site to Netlify.',
    'Send the email.',
    'Create a page in Notion.',
  ]) {
    assert.equal(objectiveRequiresFreshExternalWrite(objective), true, objective);
  }
  for (const objective of [
    'Build and save a local markdown report.',
    'Create and schedule a daily digest workflow.',
    'Read the Google Sheet and summarize it.',
    'The matrix contains an "email" field. Do not send email or use Outlook.',
    'Do not deploy or publish anything; inspect the Netlify status only.',
  ]) {
    assert.equal(objectiveRequiresFreshExternalWrite(objective), false, objective);
  }
});

test('fresh external-write evidence is bound to the current user sequence and nets failures/orphans', () => {
  const oldWrite = { seq: 4, type: 'external_write' };
  assert.equal(freshExternalWriteEvidenceStatus([oldWrite], 5), 'missing');
  assert.equal(
    freshExternalWriteEvidenceStatus([oldWrite, { seq: 6, type: 'external_write' }], 5),
    'confirmed',
  );
  assert.equal(
    freshExternalWriteEvidenceStatus([
      oldWrite,
      { seq: 6, type: 'external_write' },
      { seq: 7, type: 'external_write_failed' },
    ], 5),
    'failed',
  );
  assert.equal(
    freshExternalWriteEvidenceStatus([
      oldWrite,
      { seq: 6, type: 'external_write' },
      { seq: 7, type: 'external_write_orphaned' },
    ], 5),
    'ambiguous',
  );
  assert.equal(
    freshExternalWriteEvidenceStatus([
      oldWrite,
      { seq: 6, type: 'external_write' },
      { seq: 7, type: 'external_write_failed' },
      { seq: 8, type: 'external_write' },
    ], 5),
    'confirmed',
  );
});
