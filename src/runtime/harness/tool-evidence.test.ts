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
  freshExternalWriteEvidenceIsVerified,
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
  for (const objective of [
    'return up to three real suggestions',
    'return at most 10 records',
    'find no more than 5 matching items',
    'make one real call and return a maximum of 3 results',
    'make one real call; do not write files, create tasks, or save memories',
  ]) {
    assert.equal(objectiveMayRequireMultipleResults(objective), false, `upper bound is not a quota: ${objective}`);
  }
  assert.equal(
    objectiveMayRequireMultipleResults('return up to three suggestions from each of four sites'),
    true,
    'required multiplicity outside the optional result bound remains visible',
  );
  assert.equal(
    objectiveMayRequireMultipleResults('do not create files, but send two emails'),
    true,
    'a positive deliverable after a negated clause remains visible',
  );
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

test('overlapping request evidence is isolated by its durable source user sequence', () => {
  assert.equal(
    freshExternalWriteEvidenceStatus([
      {
        seq: 12,
        type: 'external_write',
        data: {
          sourceUserSeq: 10,
          callId: 'request-a',
          shapeKey: 'OUTLOOK_SEND_EMAIL',
          targets: ['a@example.com'],
        },
      },
      {
        seq: 13,
        type: 'external_write_failed',
        data: {
          sourceUserSeq: 11,
          callId: 'request-b',
          shapeKey: 'OUTLOOK_SEND_EMAIL',
          targets: ['b@example.com'],
        },
      },
    ], 10),
    'confirmed',
    'request B cannot poison request A even when their event sequences overlap',
  );
  assert.equal(
    freshExternalWriteEvidenceStatus([
      {
        seq: 12,
        type: 'external_write',
        data: {
          sourceUserSeq: 10,
          callId: 'request-a',
          shapeKey: 'OUTLOOK_SEND_EMAIL',
          targets: ['a@example.com'],
        },
      },
      {
        seq: 13,
        type: 'external_write',
        data: {
          sourceUserSeq: 11,
          callId: 'request-b',
          shapeKey: 'OUTLOOK_SEND_EMAIL',
          targets: ['b@example.com'],
        },
      },
    ], 11),
    'confirmed',
    'request B still sees its own receipt',
  );
});

test('fresh external-write evidence never lets one successful target mask a different failed or orphaned target', () => {
  const write = (
    seq: number,
    target: string,
    type: 'external_write' | 'external_write_failed' | 'external_write_orphaned' = 'external_write',
  ) => ({
    seq,
    type,
    data: { shapeKey: 'OUTLOOK_SEND_EMAIL', targets: [target] },
  });

  assert.equal(
    freshExternalWriteEvidenceStatus([
      write(6, 'a@example.com'),
      write(7, 'b@example.com'),
      write(8, 'b@example.com', 'external_write_orphaned'),
    ], 5),
    'ambiguous',
    'a confirmed A cannot hide B whose outcome is uncertain',
  );
  assert.equal(
    freshExternalWriteEvidenceStatus([
      write(6, 'a@example.com'),
      write(7, 'b@example.com'),
      write(8, 'b@example.com', 'external_write_failed'),
    ], 5),
    'failed',
    'a confirmed A cannot hide B whose write failed',
  );
});

test('fresh external-write evidence resolves a retry only for the same logical identity', () => {
  const write = (
    seq: number,
    target: string,
    type: 'external_write' | 'external_write_failed' | 'external_write_orphaned' = 'external_write',
  ) => ({
    seq,
    type,
    data: { shapeKey: 'OUTLOOK_SEND_EMAIL', targets: [target] },
  });

  assert.equal(
    freshExternalWriteEvidenceStatus([
      write(6, 'a@example.com'),
      write(7, 'a@example.com', 'external_write_orphaned'),
      write(8, 'b@example.com'),
    ], 5),
    'ambiguous',
    'a later write to B does not resolve A',
  );
  assert.equal(
    freshExternalWriteEvidenceStatus([
      write(6, 'a@example.com'),
      write(7, 'a@example.com', 'external_write_orphaned'),
      write(8, 'a@example.com'),
    ], 5),
    'confirmed',
    'a later reconciled retry of A becomes A’s current outcome',
  );
  assert.equal(
    freshExternalWriteEvidenceStatus([
      write(6, 'a@example.com'),
      write(7, 'a@example.com', 'external_write_failed'),
      write(8, 'a@example.com'),
    ], 5),
    'confirmed',
    'a corrected retry after a demonstrable failure remains legitimate',
  );
});

test('same-shape writes without concrete targets remain independent by call id', () => {
  const write = (
    seq: number,
    callId: string,
    type: 'external_write' | 'external_write_failed' | 'external_write_orphaned' = 'external_write',
  ) => ({
    seq,
    type,
    data: { callId, shapeKey: 'AIRTABLE_CREATE_RECORD', targets: [] },
  });

  assert.equal(
    freshExternalWriteEvidenceStatus([
      write(6, 'create-a'),
      write(7, 'create-b'),
      write(8, 'create-a', 'external_write_orphaned'),
      write(9, 'create-c'),
    ], 5),
    'ambiguous',
    'an unrelated same-shape create cannot resolve an unknown-target orphan',
  );
  assert.equal(
    freshExternalWriteEvidenceStatus([
      write(6, 'create-a'),
      write(7, 'create-a', 'external_write_failed'),
      write(8, 'create-b'),
    ], 5),
    'failed',
    'a distinct call id cannot masquerade as a retry when no target identity exists',
  );
});

test('accepted execution completion can fill missing evidence but never override explicit failure or ambiguity', () => {
  assert.equal(freshExternalWriteEvidenceIsVerified('confirmed', false), true);
  assert.equal(freshExternalWriteEvidenceIsVerified('missing', true), true);
  assert.equal(freshExternalWriteEvidenceIsVerified('missing', false), false);
  assert.equal(
    freshExternalWriteEvidenceIsVerified('failed', true),
    false,
    'an accepted controller summary cannot erase a current failed write',
  );
  assert.equal(
    freshExternalWriteEvidenceIsVerified('ambiguous', true),
    false,
    'an accepted controller summary cannot erase a maybe-landed write',
  );
});
