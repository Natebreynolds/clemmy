/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/host-interactive-consent-grant.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-host-consent-grant-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-host-consent-grant\n');

const eventlog = await import('./eventlog.js');
const approvals = await import('./approval-registry.js');
const consent = await import('./host-interactive-consent.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

const hex = (character: string) => character.repeat(64);
const subject: consent.HostInteractiveConsentSubjectV1 = {
  version: 1,
  sessionId: 'host-consent-grant-session',
  sourceUserSeq: 7,
  acceptedTaskId: 'task:host-consent-grant-session#7',
  logicalToolCallId: 'send-call-1',
  decisionSubjectDigest: hex('a'),
  callDigest: hex('b'),
  coverageDigest: hex('c'),
  riskDigest: hex('d'),
};
const outerArgs = JSON.stringify({
  requirement_id: 'send-1',
  name: 'composio_execute_tool',
  args_json: JSON.stringify({ tool_slug: 'FIXTURE_SEND', arguments: '{"body":"hello"}' }),
});

function register(input: {
  subject?: consent.HostInteractiveConsentSubjectV1;
  resolution?: 'approved' | 'rejected';
  ttlMs?: number;
}) {
  const exactSubject = input.subject ?? subject;
  const resumeKey = consent.hostInteractiveConsentApprovalResumeKey(exactSubject);
  assert.ok(resumeKey);
  const row = approvals.registerResumable({
    sessionId: exactSubject.sessionId,
    subject: 'Confirm exact high-consequence call.',
    tool: 'work_call',
    args: JSON.parse(outerArgs) as Record<string, unknown>,
    resumeKey,
    ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
  }).row;
  const resolution = approvals.resolve(
    row.approvalId,
    input.resolution ?? 'approved',
    'host-consent-test',
  );
  return { row, resolution };
}

test('one resolved approval row redeems only its exact subject and raw payload', () => {
  eventlog.createSession({ id: subject.sessionId, kind: 'chat' });
  const { row, resolution } = register({});
  assert.equal(resolution.ok, true);
  assert.equal(consent.durableHostApprovalResolutionMatches({
    approvalId: row.approvalId,
    persistedSubject: subject,
    outerToolName: 'work_call',
    outerRawArguments: outerArgs,
  }), true);

  assert.equal(consent.durableHostApprovalResolutionMatches({
    approvalId: row.approvalId,
    persistedSubject: subject,
    outerToolName: 'work_call',
    outerRawArguments: JSON.stringify({
      ...JSON.parse(outerArgs),
      args_json: JSON.stringify({ tool_slug: 'FIXTURE_SEND', arguments: '{"body":"edited"}' }),
    }),
  }), false, 'edited arguments cannot reuse the original resolution');

  const otherSubject = { ...subject, logicalToolCallId: 'send-call-2' };
  assert.equal(consent.durableHostApprovalResolutionMatches({
    approvalId: row.approvalId,
    persistedSubject: otherSubject,
    outerToolName: 'work_call',
    outerRawArguments: outerArgs,
  }), false, 'a sibling call subject cannot reuse this approval ID');

  const duplicate = approvals.resolve(row.approvalId, 'approved', 'second-resolver');
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, 'already_resolved');
  assert.equal(consent.durableHostApprovalResolutionMatches({
    approvalId: row.approvalId,
    persistedSubject: subject,
    outerToolName: 'work_call',
    outerRawArguments: outerArgs,
  }), true, 'duplicate resolution cannot alter the first exact approval');
});

test('rejection and expiry never become an exact user grant', () => {
  const rejectedSubject = { ...subject, logicalToolCallId: 'send-rejected' };
  const rejected = register({ subject: rejectedSubject, resolution: 'rejected' });
  assert.equal(rejected.resolution.ok, true);
  assert.equal(consent.durableHostApprovalResolutionMatches({
    approvalId: rejected.row.approvalId,
    persistedSubject: rejectedSubject,
    outerToolName: 'work_call',
    outerRawArguments: outerArgs,
  }), false);

  const expiredSubject = { ...subject, logicalToolCallId: 'send-expired' };
  const expired = register({ subject: expiredSubject, ttlMs: -1 });
  assert.equal(expired.resolution.ok, false);
  assert.equal(expired.resolution.reason, 'expired');
  assert.equal(consent.durableHostApprovalResolutionMatches({
    approvalId: expired.row.approvalId,
    persistedSubject: expiredSubject,
    outerToolName: 'work_call',
    outerRawArguments: outerArgs,
  }), false);
});

test('a reflected host-consent marker is not grant authority and there is no public mint', () => {
  const lookalike = Object.freeze({ version: 1 as const });
  const reflected = Object.freeze(Object.fromEntries(
    Reflect.ownKeys(lookalike).map((key) => [key, Reflect.get(lookalike, key)]),
  )) as consent.HostConsentGrantAdmissionV1;
  const expected: consent.HostConsentGrantAdmissionExpectationV1 = {
    sessionId: subject.sessionId,
    sourceUserSeq: subject.sourceUserSeq,
    acceptedTaskId: subject.acceptedTaskId,
    logicalToolCallId: subject.logicalToolCallId,
    toolName: 'fixture_send',
    argumentDigest: hex('e'),
    effect: 'external_write',
    contractId: 'contract:fixture-send',
    requirementId: 'send-1',
    hostCapabilityBindingDigest: hex('f'),
    authorityDigest: hex('9'),
  };
  assert.equal(consent.consumeHostConsentGrantAdmission({
    admission: lookalike,
    expected,
  }), null);
  assert.equal(consent.consumeHostConsentGrantAdmission({
    admission: reflected,
    expected,
  }), null, 'copying every visible field cannot copy the WeakMap fact');
  assert.equal(
    Object.keys(consent).some((key) => /mint.*consent.*grant/i.test(key)),
    false,
    'the evaluator-private mint is not a module export',
  );
});
