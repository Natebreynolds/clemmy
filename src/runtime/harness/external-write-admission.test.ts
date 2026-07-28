import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-write-admission-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  canonicalExternalWriteActionKey,
  consumeExternalWriteRetryAuthorization,
  externalWriteAdmissionKey,
  externalWriteSemanticFingerprint,
  externalWriteFailureMayHaveLanded,
  externalWriteFailureProvesNoDispatch,
  uncompensatedExternalWriteEvents,
  withExternalWriteAdmissionLock,
} = await import('./external-write-admission.js');
const {
  appendEvent,
  closeEventLog,
  createSession,
  listEvents,
  openEventLog,
} = await import('./eventlog.js');
const ADMISSION_MODULE_URL = pathToFileURL(
  path.join(process.cwd(), 'src/runtime/harness/external-write-admission.ts'),
).href;

test.after(() => {
  closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function authorizeRetry(input: {
  sessionId: string;
  sourceUserSeq?: number;
  actionKey?: string;
  duplicateIdentityKeys?: string[];
  retryOfCallId?: string;
  executionId?: string;
}) {
  return appendEvent({
    sessionId: input.sessionId,
    turn: 0,
    role: 'system',
    type: 'external_write_retry_authorized',
    data: {
      sourceUserSeq: input.sourceUserSeq ?? 41,
      actionKey: input.actionKey ?? 'email:send',
      duplicateIdentityKeys: input.duplicateIdentityKeys ?? ['Bob@Example.com', 'account-7'],
      retryOfCallId: input.retryOfCallId ?? 'call-failed-1',
      executionId: input.executionId ?? 'exec-1',
    },
  });
}

async function waitForFile(file: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForChild(child: ChildProcess): Promise<void> {
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const [code] = await once(child, 'close') as [number | null];
  assert.equal(code, 0, stderr);
}

function admissionChild(
  id: string,
  enteredFile: string,
  releaseFile?: string,
  attemptingFile?: string,
  crashAfterEnter = false,
): ChildProcess {
  const code = `
    import { existsSync, writeFileSync } from 'node:fs';
    const admission = await import(process.env.CLEM_ADMISSION_MODULE_URL);
    if (process.env.CLEM_ATTEMPTING_FILE) {
      writeFileSync(process.env.CLEM_ATTEMPTING_FILE, process.env.CLEM_CHILD_ID);
    }
    await admission.withExternalWriteAdmissionLock(
      admission.externalWriteAdmissionKey('cross-process-session'),
      async () => {
        writeFileSync(process.env.CLEM_ENTERED_FILE, process.env.CLEM_CHILD_ID);
        if (process.env.CLEM_CRASH_AFTER_ENTER === '1') process.exit(0);
        if (process.env.CLEM_RELEASE_FILE) {
          const deadline = Date.now() + 30_000;
          while (!existsSync(process.env.CLEM_RELEASE_FILE)) {
            if (Date.now() >= deadline) process.exit(3);
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
      },
    );
  `;
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLEMENTINE_HOME: TMP_HOME,
      CLEM_ADMISSION_MODULE_URL: ADMISSION_MODULE_URL,
      CLEM_CHILD_ID: id,
      CLEM_ENTERED_FILE: enteredFile,
      ...(releaseFile ? { CLEM_RELEASE_FILE: releaseFile } : {}),
      ...(attemptingFile ? { CLEM_ATTEMPTING_FILE: attemptingFile } : {}),
      ...(crashAfterEnter ? { CLEM_CRASH_AFTER_ENTER: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function consumeRetry(input: {
  sessionId: string;
  sourceUserSeq?: number;
  actionKey: string;
  duplicateIdentityKeys: readonly string[];
}) {
  return withExternalWriteAdmissionLock(
    externalWriteAdmissionKey(input.sessionId),
    async () => consumeExternalWriteRetryAuthorization(input),
  );
}

async function consumeAndReserveRetry(
  input: {
    sessionId: string;
    sourceUserSeq?: number;
    actionKey: string;
    duplicateIdentityKeys: readonly string[];
  },
  callId: string,
) {
  return withExternalWriteAdmissionLock(
    externalWriteAdmissionKey(input.sessionId),
    async () => {
      const retry = consumeExternalWriteRetryAuthorization(input);
      if (!retry) return undefined;
      appendEvent({
        sessionId: input.sessionId,
        turn: 0,
        role: 'system',
        type: 'external_write',
        data: {
          sourceUserSeq: input.sourceUserSeq,
          actionKey: input.actionKey,
          callId,
          canonicalCallId: callId,
          retryOfCallId: retry.retryOfCallId,
          retryAuthorizationSeq: retry.authorizationSeq,
          duplicateIdentityKeys: [...input.duplicateIdentityKeys],
          preDispatch: true,
        },
      });
      return retry;
    },
  );
}

test('equivalent email-send transports share one provider-neutral action key', () => {
  const variants = [
    canonicalExternalWriteActionKey('composio_execute_tool', 'OUTLOOK_OUTLOOK_SEND_EMAIL'),
    canonicalExternalWriteActionKey('mcp__outlook__send_email', 'mcp__outlook__send_email'),
    canonicalExternalWriteActionKey('outlook__send_email', 'outlook__send_email'),
    canonicalExternalWriteActionKey('gmail__sendEmail', 'gmail__sendEmail'),
  ];
  assert.deepEqual([...new Set(variants)], ['email:send']);
  assert.notEqual(
    canonicalExternalWriteActionKey('gmail__reply_to_thread', 'gmail__reply_to_thread'),
    'email:send',
  );
});

test('all irreversible communication families keep one action key across transports', () => {
  const families: Array<{ expected: string; variants: Array<[string, string]> }> = [
    {
      expected: 'social:publish',
      variants: [
        ['composio_execute_tool', 'LINKEDIN_CREATE_LINKED_IN_POST'],
        ['mcp__linkedin__create_linked_in_post', 'mcp__linkedin__create_linked_in_post'],
        ['linkedin__create_linked_in_post', 'create_linked_in_post'],
        ['composio_execute_tool', 'TWITTER_CREATION_OF_A_POST'],
        ['mcp__twitter__creation_of_a_post', 'creation_of_a_post'],
      ],
    },
    {
      expected: 'message:send',
      variants: [
        ['composio_execute_tool', 'TWILIO_CREATE_MESSAGE'],
        ['mcp__twilio__create_message', 'mcp__twilio__create_message'],
        ['twilio__create_message', 'create_message'],
        ['composio_execute_tool', 'TWILIO_SEND_SMS'],
        ['mcp__twilio__send_sms', 'send_sms'],
        ['mcp__slack__chat_post_message', 'chat_post_message'],
      ],
    },
    {
      expected: 'call:outbound',
      variants: [
        ['composio_execute_tool', 'TWILIO_MAKE_OUTBOUND_CALL'],
        ['mcp__twilio__make_outbound_call', 'make_outbound_call'],
        ['mcp__vapi__create_call', 'create_call'],
      ],
    },
    {
      expected: 'invite:send',
      variants: [
        ['composio_execute_tool', 'SLACK_SEND_INVITE'],
        ['mcp__slack__send_invite', 'send_invite'],
        ['mcp__calendar__create_invitation', 'create_invitation'],
      ],
    },
    {
      expected: 'meeting:create',
      variants: [
        ['composio_execute_tool', 'ZOOM_CREATE_MEETING'],
        ['mcp__zoom__create_meeting', 'mcp__zoom__create_meeting'],
        ['mcp__teams__create_meeting', 'create_meeting'],
      ],
    },
    {
      expected: 'calendar:respond_event',
      variants: [
        ['composio_execute_tool', 'GOOGLECALENDAR_RESPOND_TO_EVENT'],
        ['mcp__googlecalendar__respond_to_event', 'respond_to_event'],
        ['calendar__reply_event', 'reply_event'],
      ],
    },
    {
      expected: 'message:send',
      variants: [
        ['composio_execute_tool', 'TWITTER_DM'],
        ['mcp__twitter__dm', 'dm'],
        ['mcp__slack__reply_to_message', 'reply_to_message'],
        ['mcp__whatsapp__forward_message', 'forward_message'],
      ],
    },
  ];

  for (const family of families) {
    const keys = family.variants.map(([toolName, shapeKey]) =>
      canonicalExternalWriteActionKey(toolName, shapeKey)
    );
    assert.deepEqual([...new Set(keys)], [family.expected], `${family.expected}: ${keys.join(', ')}`);
  }
});

test('all write transports share one short admission lock per session', async () => {
  const same = externalWriteAdmissionKey('session');
  assert.equal(
    same,
    externalWriteAdmissionKey('session'),
  );
  assert.notEqual(
    same,
    externalWriteAdmissionKey('other-session'),
  );

  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = withExternalWriteAdmissionLock(same, async () => {
    order.push('first:start');
    await firstHeld;
    order.push('first:end');
  });
  const second = withExternalWriteAdmissionLock(same, async () => {
    order.push('second:start');
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(order, ['first:start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start']);
});

test('admission lock serializes the same session across real Node processes', async () => {
  const firstEntered = path.join(TMP_HOME, 'cross-process-first-entered');
  const firstRelease = path.join(TMP_HOME, 'cross-process-first-release');
  const secondAttempting = path.join(TMP_HOME, 'cross-process-second-attempting');
  const secondEntered = path.join(TMP_HOME, 'cross-process-second-entered');
  const first = admissionChild('first', firstEntered, firstRelease);
  await waitForFile(firstEntered);

  const second = admissionChild('second', secondEntered, undefined, secondAttempting);
  await waitForFile(secondAttempting);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    existsSync(secondEntered),
    false,
    'a process-local mutex is insufficient: process two must stay outside while process one owns admission',
  );

  writeFileSync(firstRelease, 'release');
  await Promise.all([waitForChild(first), waitForChild(second)]);
  assert.equal(existsSync(secondEntered), true);
});

test('admission lock recovers an exact row left by a crashed process', async () => {
  const crashedEntered = path.join(TMP_HOME, 'cross-process-crashed-entered');
  const recoveredEntered = path.join(TMP_HOME, 'cross-process-recovered-entered');
  const crashed = admissionChild('crashed', crashedEntered, undefined, undefined, true);
  await waitForChild(crashed);
  assert.equal(existsSync(crashedEntered), true);

  const recovered = admissionChild('recovered', recoveredEntered);
  await waitForChild(recovered);
  assert.equal(
    existsSync(recoveredEntered),
    true,
    'a dead owner is replaced by owner-token CAS instead of wedging writes forever',
  );
});

test('semantic targetless fingerprint is provider-neutral but content-sensitive', () => {
  const actionKey = 'social:publish';
  const composio = externalWriteSemanticFingerprint(actionKey, {
    tool_slug: 'LINKEDIN_CREATE_POST',
    connected_account_id: 'ca_composio_only',
    arguments: {
      text: 'Clementine 3.0 is ready',
      visibility: 'PUBLIC',
    },
  });
  const native = externalWriteSemanticFingerprint(actionKey, {
    text: 'Clementine 3.0 is ready',
    visibility: 'PUBLIC',
  });
  const encodedWrapper = externalWriteSemanticFingerprint(actionKey, {
    tool_slug: 'LINKEDIN_CREATE_POST',
    connection_id: 'another-routing-only-id',
    payload: JSON.stringify({
      visibility: 'PUBLIC',
      text: 'Clementine 3.0 is ready',
    }),
  });
  const deferredWrapper = externalWriteSemanticFingerprint(actionKey, {
    name: 'composio_execute_tool',
    args_json: JSON.stringify({
      tool_slug: 'LINKEDIN_CREATE_POST',
      arguments: {
        visibility: 'PUBLIC',
        text: 'Clementine 3.0 is ready',
      },
    }),
  });
  const different = externalWriteSemanticFingerprint(actionKey, {
    text: 'Clementine 3.0 ships tomorrow',
    visibility: 'PUBLIC',
  });

  assert.equal(composio, native);
  assert.equal(encodedWrapper, native);
  assert.equal(deferredWrapper, native);
  assert.notEqual(different, native);
});

test('retry authorization consumes only for the exact source, action, and normalized identity set', async () => {
  const session = createSession({ kind: 'chat' });
  const authorization = authorizeRetry({
    sessionId: session.id,
    duplicateIdentityKeys: [' Bob@Example.com ', 'ACCOUNT-7', 'bob@example.com'],
  });

  const consumed = await consumeAndReserveRetry({
    sessionId: session.id,
    sourceUserSeq: 41,
    actionKey: 'email:send',
    duplicateIdentityKeys: ['account-7', 'BOB@example.com'],
  }, 'retry-exact-1');

  assert.deepEqual(consumed, {
    retryOfCallId: 'call-failed-1',
    executionId: 'exec-1',
    authorizationSeq: authorization.seq,
  });
  const [reservation] = listEvents(session.id, { types: ['external_write'] });
  assert.equal(reservation?.data.retryAuthorizationSeq, authorization.seq);
  assert.equal(reservation?.data.retryOfCallId, 'call-failed-1');
  assert.equal(
    listEvents(session.id, { types: ['external_write_retry_consumed'] }).length,
    0,
    'the reservation is the atomic durable consumption record',
  );
});

test('retry authorization is consumed once when concurrent callers contend on the session admission lock', async () => {
  const session = createSession({ kind: 'chat' });
  const authorization = authorizeRetry({ sessionId: session.id });
  const contenders = await Promise.all(
    Array.from({ length: 12 }, (_, index) => consumeAndReserveRetry({
      sessionId: session.id,
      sourceUserSeq: 41,
      actionKey: 'email:send',
      duplicateIdentityKeys: ['account-7', 'bob@example.com'],
    }, `retry-race-${index}`)),
  );

  const winners = contenders.filter((result) => result !== undefined);
  assert.equal(winners.length, 1);
  assert.equal(winners[0]?.authorizationSeq, authorization.seq);
  const rows = listEvents(session.id, { types: ['external_write'] });
  assert.equal(rows.length, 1, 'one durable reservation owns the grant');
  assert.equal(rows[0]?.data.retryAuthorizationSeq, authorization.seq);
  assert.equal(
    await consumeRetry({
      sessionId: session.id,
      sourceUserSeq: 41,
      actionKey: 'email:send',
      duplicateIdentityKeys: ['account-7', 'bob@example.com'],
    }),
    undefined,
  );
});

test('retry authorization is not burned when reservation persistence fails before its claim lands', async () => {
  const session = createSession({ kind: 'chat' });
  const authorization = authorizeRetry({ sessionId: session.id });
  const input = {
    sessionId: session.id,
    sourceUserSeq: 41,
    actionKey: 'email:send',
    duplicateIdentityKeys: ['account-7', 'bob@example.com'],
  };

  const selectedBeforeFailedReservation = await consumeRetry(input);
  assert.equal(selectedBeforeFailedReservation?.authorizationSeq, authorization.seq);
  // Simulate the caller's external_write append throwing. Selection alone must
  // not consume the capability because no durable provider-attempt reservation
  // exists yet.
  assert.equal(
    (await consumeRetry(input))?.authorizationSeq,
    authorization.seq,
  );

  await withExternalWriteAdmissionLock(
    externalWriteAdmissionKey(session.id),
    async () => {
      const selected = consumeExternalWriteRetryAuthorization(input);
      assert.equal(selected?.authorizationSeq, authorization.seq);
      appendEvent({
        sessionId: session.id,
        turn: 0,
        role: 'system',
        type: 'external_write',
        data: {
          sourceUserSeq: 41,
          actionKey: 'email:send',
          callId: 'retry-call-1',
          canonicalCallId: 'retry-call-1',
          retryOfCallId: selected?.retryOfCallId,
          retryAuthorizationSeq: selected?.authorizationSeq,
          duplicateIdentityKeys: input.duplicateIdentityKeys,
          preDispatch: true,
        },
      });
    },
  );
  assert.equal(await consumeRetry(input), undefined);
});

test('wrong source, action, identity, or session cannot consume the retry authorization', async () => {
  const session = createSession({ kind: 'chat' });
  const otherSession = createSession({ kind: 'chat' });
  authorizeRetry({ sessionId: session.id });

  for (const mismatch of [
    {
      sessionId: session.id,
      sourceUserSeq: 42,
      actionKey: 'email:send',
      duplicateIdentityKeys: ['account-7', 'bob@example.com'],
    },
    {
      sessionId: session.id,
      sourceUserSeq: 41,
      actionKey: 'email:reply',
      duplicateIdentityKeys: ['account-7', 'bob@example.com'],
    },
    {
      sessionId: session.id,
      sourceUserSeq: 41,
      actionKey: 'email:send',
      duplicateIdentityKeys: ['bob@example.com'],
    },
    {
      sessionId: session.id,
      sourceUserSeq: 41,
      actionKey: 'email:send',
      duplicateIdentityKeys: ['account-7', 'bob@example.com', 'extra@example.com'],
    },
    {
      sessionId: otherSession.id,
      sourceUserSeq: 41,
      actionKey: 'email:send',
      duplicateIdentityKeys: ['account-7', 'bob@example.com'],
    },
  ]) {
    assert.equal(await consumeRetry(mismatch), undefined);
  }
  assert.equal(
    listEvents(session.id, { types: ['external_write_retry_consumed'] }).length,
    0,
    'refused mismatches do not burn the exact capability',
  );

  assert.ok(await consumeRetry({
    sessionId: session.id,
    sourceUserSeq: 41,
    actionKey: 'email:send',
    duplicateIdentityKeys: ['account-7', 'bob@example.com'],
  }));
});

test('retry authorization and one-shot consumption survive event-log close and reopen', async () => {
  const session = createSession({ kind: 'chat' });
  const authorization = authorizeRetry({
    sessionId: session.id,
    sourceUserSeq: 77,
    actionKey: 'social:publish',
    duplicateIdentityKeys: ['payload:sha256:abc'],
    retryOfCallId: 'post-failed-1',
    executionId: 'exec-social-1',
  });

  closeEventLog();
  openEventLog();
  const consumed = await consumeAndReserveRetry({
    sessionId: session.id,
    sourceUserSeq: 77,
    actionKey: 'social:publish',
    duplicateIdentityKeys: ['PAYLOAD:SHA256:ABC'],
  }, 'post-retry-1');
  assert.equal(consumed?.authorizationSeq, authorization.seq);

  closeEventLog();
  openEventLog();
  assert.equal(
    await consumeRetry({
      sessionId: session.id,
      sourceUserSeq: 77,
      actionKey: 'social:publish',
      duplicateIdentityKeys: ['payload:sha256:abc'],
    }),
    undefined,
    'the durable consumption row prevents reuse after a simulated restart',
  );
  assert.equal(
    listEvents(session.id, { types: ['external_write'] }).filter(
      (event) => event.data.retryAuthorizationSeq === authorization.seq,
    ).length,
    1,
  );
});

test('post-dispatch and broken-response wording is never treated as proven no-effect', () => {
  for (const message of [
    'Invalid response envelope after provider accepted and committed the request',
    'HTTP 504 Gateway Timeout; the final outcome is unknown',
    'The response was dropped after dispatch',
    'The request may have landed even though validation of the response failed',
    'Provider executed the send successfully, but tool result validation failed',
    'Response schema validation failed after execution completed',
  ]) {
    assert.equal(externalWriteFailureMayHaveLanded(message), true, message);
  }
  for (const message of [
    'HTTP 400 validation failed: recipient is required',
    'HTTP 401 unauthorized before dispatch',
    'DNS lookup failed with ENOTFOUND',
  ]) {
    assert.equal(externalWriteFailureMayHaveLanded(message), false, message);
  }
  assert.equal(
    externalWriteFailureProvesNoDispatch(
      '[provider-dispatch:not-started:invalid-args] HTTP 400 validation failed',
    ),
    true,
  );
  assert.equal(
    externalWriteFailureProvesNoDispatch('HTTP 400 validation failed'),
    false,
  );
});

test('failed compensation removes only its exact action, not a same-target sibling', () => {
  const events = [
    {
      seq: 1,
      type: 'external_write',
      data: {
        callId: 'email-a',
        correlationFingerprint: 'payload:a',
        shapeKey: 'OUTLOOK_SEND_EMAIL',
        targets: ['same@example.com'],
      },
    },
    {
      seq: 2,
      type: 'external_write',
      data: {
        callId: 'email-b',
        correlationFingerprint: 'payload:b',
        shapeKey: 'OUTLOOK_SEND_EMAIL',
        targets: ['same@example.com'],
      },
    },
    {
      seq: 3,
      type: 'external_write_failed',
      data: {
        callId: 'email-a',
        correlationFingerprint: 'payload:a',
        shapeKey: 'OUTLOOK_SEND_EMAIL',
        targets: ['same@example.com'],
      },
    },
  ];
  assert.deepEqual(
    uncompensatedExternalWriteEvents(events).map((event) => event.data.callId),
    ['email-b'],
  );
});
