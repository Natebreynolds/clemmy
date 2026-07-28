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
  toolOutputProvesExternalWriteAcknowledgement,
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

test('external-write success requires a clean non-empty provider acknowledgement', () => {
  for (const output of [
    '',
    false,
    0,
    'false',
    'null',
    'banana',
    'Created banana',
    'Email not sent. Message ID: msg_123',
    {},
    [],
    [{ type: 'text', text: '' }],
    'Invalid JSON input',
    'HTTP 401 Unauthorized: provider rejected the request',
    '[provider-dispatch:uncertain]\nThe write may have landed',
    '[provider-dispatch:not-started:constraint]\nNothing was sent',
    'DATA-QUALITY CHECKPOINT — this write was NOT executed yet.',
    { detail: 'Invalid JSON input' },
    { detail: 'banana' },
    { data: false },
    { data: 0 },
    { data: { request: { to: 'lead@example.com' } } },
    { data: { url: 'https://api.example.test/records', method: 'POST' } },
    { request_id: 'req_123' },
    { data: { correlationId: 'corr_123' } },
    { data: { connected_account_id: 'ca_123' } },
    { data: { job_id: 'job_123' } },
    [{ type: 'text', text: JSON.stringify({ request_id: 'req_123' }) }],
    { status: 'queued' },
    { status: 'queued', id: 'job_123' },
    { status_code: 202, id: 'job_123' },
    { status: 202, id: 'job_123' },
    { id: 'req_123', message: 'Service unavailable' },
    { id: 'job_123', message: 'Request accepted for processing' },
    { id: 'err_123', detail: 'Upstream disconnected' },
    { id: 'req_123', message: 'Provider denied the operation' },
    { success: true, status: 'cancelled', id: 'rec_123' },
    { id: 'rec_123', message: 'Update failed' },
    { ok: true, created: false },
    { id: 'rec_123', message: 'Transaction rolled back' },
    { status: 'completed', affectedRows: 0 },
    { id: 'rec-1', message: 'No changes were made' },
    { ok: true, dryRun: true, id: 'rec-1' },
    { success: true, status: 'skipped', id: 'rec-1' },
    { ok: true, noop: true, id: 'rec-1' },
    { ok: true, changed: false, id: 'rec-1' },
    'Created 0 records.',
    'Updated 0 rows.',
    'Sent 0 emails.',
    { status: 'completed', affectedRows: '0' },
    { ok: true, dryRun: 'true', id: 'rec-1' },
    { success: true, createdCount: '1', failedCount: '1' },
    'HTTP 201 Created\n{"status":"failed"}',
    { success: true, statusCode: '500', id: 'rec-1' },
    { success: true, failed: 'true', id: 'rec-1' },
    { success: true, created: 'false', id: 'rec-1' },
    { id: 'dep-1', readyState: 'QUEUED', url: 'https://vercel.example/deploy/dep-1' },
    'Created record rec-1 (not committed).',
    'Created record rec-123; validation failed.',
    'Created record rec-123; commit failed.',
    'Created record rec-123 but changes were discarded.',
    'Created record rec-123 in simulation mode.',
    {
      successful: true,
      error: null,
      data: {
        tasks_error: 1,
        tasks: [{ status_code: 40501, status_message: 'Invalid field' }],
      },
    },
    {
      data: {
        tasks: [{
          id: '07010725-1234-5678-8000-63bcc94a0be3',
          result: null,
          status_code: 40400,
          status_message: 'Not Found.',
        }],
      },
    },
    { successful: true, data: { error: 'provider failed after parsing' } },
    { successful: true, error: { code: 'provider_rejected' }, id: 'echo_123' },
    [{ type: 'text', text: 'FAILED: missing required field' }],
  ]) {
    assert.equal(
      toolOutputProvesExternalWriteAcknowledgement(output),
      false,
      JSON.stringify(output),
    );
  }
  for (const output of [
    'Created record rec_123',
    { ok: true },
    { status: 'completed' },
    { data: { id: 'rec_123' } },
    { data: { documentId: 'doc_123' } },
    { data: { display_url: 'https://docs.google.com/spreadsheets/d/abc/edit' } },
    { content: { sha: 'content-sha', html_url: 'https://github.com/acme/repo/blob/main/a.txt' }, commit: { sha: 'commit-sha', html_url: 'https://github.com/acme/repo/commit/commit-sha' } },
    { sha: 'merge-sha', merged: true, message: 'Pull Request successfully merged' },
    { acknowledged: true, insertedId: 'mongo-id-1' },
    { command: 'UPDATE', rowCount: 1, rows: [] },
    { ref: 'refs/heads/release', node_id: 'REF_kwDOExample', url: 'https://api.github.com/repos/acme/repo/git/refs/heads/release', object: { sha: 'commit-sha' } },
    { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: 'mongo-upsert-1' },
    { changes: 1, lastInsertRowid: 42 },
    { metadata: { uid: '6f716f31-45c4-4bc1-a2ba-abc123' } },
    { Arn: 'arn:aws:sns:us-west-2:123456789012:topic' },
    { data: { gid: '12001234567890' } },
    { changed: true },
    { Location: '/bucket' },
    '```json\n{"id":"rec-123"}\n```',
    'Result:\n{"id":"rec-123"}',
    'Successfully created 3 records.',
    'Updated 4 rows.',
    'Sent 2 emails.',
    'Created branch feature/release.',
    { data: { updatedCells: 4 } },
    { status_code: 204 },
    { status: 204 },
    { statusCode: '201' },
    { statusCode: 201, headers: { location: 'https://api.example.test/records/rec_123' } },
    { data: { clearedRange: 'Sheet1!A1:B2' } },
    { deleted: true },
    { isSuccess: true },
    { successful: true, error: null, data: { status_code: 20000 } },
    { successful: true, error: 'deprecation notice', data: { id: 'rec-1' } },
    'Message sent.',
    'Email sent. Message ID: msg_123',
    'HTTP 204 No Content',
    'HTTP 201 Created\nLocation: https://api.example.test/records/rec-1',
    { ok: true, data: { id: 'msg_123' }, message: { text: 'What we learned from failure' } },
    { successful: true, data: { id: 'urn:li:share:123', text: 'A guide to HTTP 404 error handling' } },
    { successful: true, data: { id: 'msg_123', subject: 'Error handling guide' } },
    [{ type: 'text', text: 'Published post urn:li:share:123' }],
  ]) {
    assert.equal(
      toolOutputProvesExternalWriteAcknowledgement(output),
      true,
      JSON.stringify(output),
    );
  }
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
      {
        seq: 6,
        type: 'external_write',
        data: {
          callId: 'failed-send',
          actionKey: 'email:send',
          targets: ['retry@example.com'],
          correlationFingerprint: 'payload:retry',
        },
      },
      {
        seq: 7,
        type: 'external_write_failed',
        data: {
          callId: 'failed-send',
          actionKey: 'email:send',
          targets: ['retry@example.com'],
          correlationFingerprint: 'payload:retry',
        },
      },
      {
        seq: 8,
        type: 'external_write',
        data: {
          callId: 'corrected-send',
          retryOfCallId: 'failed-send',
          actionKey: 'email:send',
          targets: ['retry@example.com'],
          correlationFingerprint: 'payload:retry',
        },
      },
    ], 5),
    'confirmed',
  );
});

test('a pre-dispatch reservation is ambiguous until its exact call settles successfully', () => {
  const reservation = {
    seq: 6,
    type: 'external_write',
    data: {
      callId: 'reserved-send',
      actionKey: 'email:send',
      targets: ['reserved@example.com'],
      preDispatch: true,
    },
  };
  assert.equal(
    freshExternalWriteEvidenceStatus([reservation], 5),
    'ambiguous',
    'a crash after admission cannot certify completion',
  );
  assert.equal(
    freshExternalWriteEvidenceStatus([
      reservation,
      {
        seq: 7,
        type: 'external_write_succeeded',
        data: {
          callId: 'reserved-send',
          actionKey: 'email:send',
          targets: ['reserved@example.com'],
        },
      },
    ], 5),
    'confirmed',
  );
  assert.equal(
    freshExternalWriteEvidenceStatus([
      reservation,
      {
        seq: 7,
        type: 'external_write_succeeded',
        data: {
          callId: 'another-send',
          actionKey: 'email:send',
          targets: ['reserved@example.com'],
        },
      },
    ], 5),
    'ambiguous',
    'a different call receipt cannot settle the reservation',
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
    correlationFingerprint = 'payload:a',
    callId = `call-${seq}`,
    retryOfCallId?: string,
  ) => ({
    seq,
    type,
    data: {
      callId,
      actionKey: 'email:send',
      shapeKey: 'OUTLOOK_SEND_EMAIL',
      targets: [target],
      correlationFingerprint,
      ...(retryOfCallId ? { retryOfCallId } : {}),
    },
  });

  assert.equal(
    freshExternalWriteEvidenceStatus([
      write(6, 'a@example.com', 'external_write', 'payload:a', 'send-a'),
      write(7, 'a@example.com', 'external_write_orphaned', 'payload:a', 'send-a'),
      write(8, 'b@example.com', 'external_write', 'payload:b'),
    ], 5),
    'ambiguous',
    'a later write to B does not resolve A',
  );
  assert.equal(
    freshExternalWriteEvidenceStatus([
      write(6, 'a@example.com', 'external_write', 'payload:a', 'send-a'),
      write(7, 'a@example.com', 'external_write_orphaned', 'payload:a', 'send-a'),
      write(8, 'a@example.com', 'external_write', 'payload:a', 'send-a-retry', 'send-a'),
    ], 5),
    'ambiguous',
    'an orphan may already have landed, so even an explicit retry edge cannot erase its ambiguity',
  );
  assert.equal(
    freshExternalWriteEvidenceStatus([
      write(6, 'a@example.com', 'external_write', 'payload:a', 'send-a'),
      write(7, 'a@example.com', 'external_write_failed', 'payload:a', 'send-a'),
      write(8, 'a@example.com', 'external_write', 'payload:a', 'send-a-retry', 'send-a'),
    ], 5),
    'confirmed',
    'an explicit corrected retry after a demonstrable failure remains legitimate',
  );
});

test('distinct writes to the same target never erase one another without proven retry identity', () => {
  const attempt = (
    seq: number,
    callId: string,
    type: 'external_write' | 'external_write_failed',
    correlationFingerprint?: string,
    retryOfCallId?: string,
  ) => ({
    seq,
    type,
    data: {
      sourceUserSeq: 5,
      callId,
      actionKey: 'email:send',
      shapeKey: 'OUTLOOK_SEND_EMAIL',
      targets: ['same@example.com'],
      ...(correlationFingerprint ? { correlationFingerprint } : {}),
      ...(retryOfCallId ? { retryOfCallId } : {}),
    },
  });

  assert.equal(
    freshExternalWriteEvidenceStatus([
      attempt(6, 'email-a', 'external_write'),
      attempt(7, 'email-a', 'external_write_failed'),
      attempt(8, 'email-b', 'external_write'),
    ], 5),
    'failed',
    'a distinct provider call to the same recipient is another requested action, not proof that the failed action retried',
  );

  assert.equal(
    freshExternalWriteEvidenceStatus([
      attempt(6, 'email-a', 'external_write', 'payload:a'),
      attempt(7, 'email-a', 'external_write_failed', 'payload:a'),
      attempt(8, 'email-b', 'external_write', 'payload:b'),
    ], 5),
    'failed',
    'different payload identities remain independent even when shape and recipient match',
  );

  assert.equal(
    freshExternalWriteEvidenceStatus([
      attempt(6, 'email-a', 'external_write', 'payload:a'),
      attempt(7, 'email-a', 'external_write_failed', 'payload:a'),
      attempt(8, 'email-retry', 'external_write', 'payload:a', 'email-a'),
    ], 5),
    'confirmed',
    'an explicit retry edge lets a corrected retry supersede its proven failed attempt',
  );

  assert.equal(
    freshExternalWriteEvidenceStatus([
      attempt(6, 'email-a', 'external_write', 'payload:a'),
      attempt(7, 'email-a', 'external_write_failed', 'payload:a'),
      attempt(8, 'email-repeat', 'external_write', 'payload:a'),
    ], 5),
    'failed',
    'an identical payload without explicit retry lineage is a distinct requested action',
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
