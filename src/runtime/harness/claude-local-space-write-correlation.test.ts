import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { DispatchLeaseRef } from './dispatch-lease.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-space-write-correlation-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const eventlog = await import('./eventlog.js');
const leases = await import('./dispatch-lease.js');
const correlation = await import('./claude-local-tool-correlation.js');
const { toolCallCorrelationFingerprint } = await import('./tool-correlation.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const SDK_TOOL = 'mcp__clementine-local__call_tool';
const LOCAL_TOOL = 'call_tool';

function writeInput(options: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'space_set_data',
    args_json: {
      slug: 'controlled-space-call-identity',
      source_id: 'controlled-result',
      data_json: '{"records":[{"id":"controlled-record","count":1}]}',
      ...options,
    },
  };
}

function acceptedQuery() {
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop' });
  const attempt = eventlog.beginRunAttempt(session.id);
  const source = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: 'Update only the controlled local Workspace fixture.' },
  });
  const runScopeId = `${session.id}::controlled-query`;
  const dispatchLease = leases.activateDispatchLease({
    sessionId: session.id,
    scopeId: runScopeId,
    runAttemptId: attempt.attemptId,
  });
  assert.equal(leases.isDispatchLeaseCurrent(dispatchLease), true);
  assert.equal(eventlog.getRunAttemptSourceUserEvent({ sessionId: session.id, attemptId: attempt.attemptId })?.seq, source.seq);
  return { sessionId: session.id, sourceUserSeq: source.seq, runScopeId, dispatchLease, attempt };
}

type Query = ReturnType<typeof acceptedQuery>;
type AdmissionOverrides = Partial<Parameters<typeof correlation.recordClaudeLocalPermissionAdmission>[0]>;
type ClaimOverrides = Partial<Parameters<typeof correlation.claimClaudeLocalPermissionAdmission>[0]>;

function admit(query: Query, rawInput = writeInput(), overrides: AdmissionOverrides = {}) {
  return correlation.recordClaudeLocalPermissionAdmission({
    sessionId: query.sessionId,
    sourceUserSeq: query.sourceUserSeq,
    runScopeId: query.runScopeId,
    dispatchLease: query.dispatchLease,
    providerCallId: 'controlled-provider-call',
    sdkToolName: SDK_TOOL,
    input: rawInput,
    directOrchestrator: true,
    ...overrides,
  });
}

function claim(query: Query, rawInput = writeInput(), overrides: ClaimOverrides = {}) {
  return correlation.claimClaudeLocalPermissionAdmission({
    sessionId: query.sessionId,
    sourceUserSeq: query.sourceUserSeq,
    runScopeId: query.runScopeId,
    dispatchLease: query.dispatchLease,
    providerCallId: 'controlled-provider-call',
    toolName: LOCAL_TOOL,
    rawInput,
    directOrchestrator: true,
    ...overrides,
  });
}

function canonicalCalls(query: Query) {
  return eventlog.listEvents(query.sessionId, { types: ['tool_called'] })
    .filter(event => event.data.accounting === 'top_level');
}

test('Space permission claims retain the exact durable source, query lease and provider call once', () => {
  const query = acceptedQuery();
  const input = writeInput();
  const admission = admit(query, input);
  assert.ok(admission);
  const result = claim(query, input);
  assert.ok(result);
  assert.equal(result.admissionEventId, admission.id);
  assert.equal(result.providerCallId, 'controlled-provider-call');
  const calls = canonicalCalls(query);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.id, result.calledEventId);
  assert.equal(calls[0]!.data.callId, result.providerCallId);
  assert.equal(calls[0]!.data.canonicalCallId, result.providerCallId);
  assert.equal(calls[0]!.data.sourceUserSeq, query.sourceUserSeq);
  assert.equal(calls[0]!.data.runScopeId, query.runScopeId);
  assert.equal(calls[0]!.data.spaceWriteTarget, 'space_set_data');
  assert.equal(calls[0]!.data.exactInputDigest, correlation.claudeLocalSpaceWriteInputDigest(LOCAL_TOOL, input));
  assert.equal(admission.data.dispatchLeaseId, query.dispatchLease.leaseId);
  assert.equal(claim(query, input), null, 'a consumed permission cannot initiate another handler');
  assert.equal(canonicalCalls(query).length, 1);
  assert.equal(eventlog.listEvents(query.sessionId, { types: ['tool_returned'] }).length, 0,
    'correlation alone does not execute a tool or manufacture a settled result');
});

test('Space permission refuses another accepted source even within the same active query lease', () => {
  const query = acceptedQuery();
  assert.ok(admit(query));
  const laterSource = eventlog.appendEvent({ sessionId: query.sessionId, turn: 2, role: 'user',
    type: 'user_input_received', data: { text: 'A separate controlled request.' } });
  assert.equal(leases.isDispatchLeaseCurrent(query.dispatchLease), true,
    'the negative is a source mismatch, not a revoked lease');
  assert.equal(admit(query, writeInput(), { sourceUserSeq: laterSource.seq }), null);
  assert.equal(claim(query, writeInput(), { sourceUserSeq: laterSource.seq }), null);
  assert.equal(canonicalCalls(query).length, 0);
  assert.ok(claim(query), 'a mismatched source did not consume the original permission');
});

test('Space permission compares the supplied attempt with the actual durable lease row', () => {
  const query = acceptedQuery();
  const other = acceptedQuery();
  const forged: DispatchLeaseRef[] = [
    { ...query.dispatchLease, runAttemptId: undefined },
    { ...query.dispatchLease, runAttemptId: other.attempt.attemptId },
    { ...query.dispatchLease, runAttemptId: 'attempt:unretained-controlled-attempt' },
  ];
  assert.ok(admit(query));
  for (const dispatchLease of forged) {
    // The generic current-lease check does not grant ownership of a supplied
    // attempt alias; the Space-specific durable row/source check must reject it.
    assert.equal(leases.isDispatchLeaseCurrent(dispatchLease), true);
    assert.equal(admit(query, writeInput(), { dispatchLease }), null);
    assert.equal(claim(query, writeInput(), { dispatchLease }), null);
  }
  assert.equal(canonicalCalls(query).length, 0);
  assert.ok(claim(query));
});

test('Space permission refuses an attempt-free query lease instead of borrowing either accepted source', () => {
  const query = acceptedQuery();
  const laterSource = eventlog.appendEvent({ sessionId: query.sessionId, turn: 2, role: 'user',
    type: 'user_input_received', data: { text: 'Another controlled request.' } });
  const dispatchLease = leases.activateDispatchLease({ sessionId: query.sessionId,
    scopeId: `${query.runScopeId}:unbound` });
  assert.equal(leases.isDispatchLeaseCurrent(dispatchLease), true);
  for (const sourceUserSeq of [query.sourceUserSeq, laterSource.seq]) {
    assert.equal(admit(query, writeInput(), { dispatchLease, sourceUserSeq }), null);
    assert.equal(claim(query, writeInput(), { dispatchLease, sourceUserSeq }), null);
  }
  assert.equal(canonicalCalls(query).length, 0);
});

test('Space permission refuses wrong session, query scope, provider identity and physical lease without consuming the marker', () => {
  const query = acceptedQuery();
  const other = acceptedQuery();
  const siblingLease = leases.activateDispatchLease({ sessionId: query.sessionId,
    scopeId: `${query.runScopeId}:sibling`, runAttemptId: query.attempt.attemptId });
  assert.ok(admit(query));
  const wrongClaims: ClaimOverrides[] = [
    { sessionId: other.sessionId },
    { runScopeId: `${query.runScopeId}:wrong` },
    { providerCallId: 'controlled-different-provider-call' },
    { providerCallId: undefined },
    { dispatchLease: undefined },
    { dispatchLease: other.dispatchLease },
    { dispatchLease: siblingLease },
    { dispatchLease: { ...query.dispatchLease, sessionId: other.sessionId } },
    { dispatchLease: { ...query.dispatchLease, scopeId: `${query.runScopeId}:missing` } },
    { dispatchLease: { ...query.dispatchLease, leaseId: 'controlled-missing-lease' } },
  ];
  for (const overrides of wrongClaims) assert.equal(claim(query, writeInput(), overrides), null);
  assert.equal(canonicalCalls(query).length, 0);
  assert.ok(claim(query));
});

test('Space permission refuses a revoked or replaced query generation', () => {
  for (const mode of ['revoked', 'replaced'] as const) {
    const query = acceptedQuery();
    assert.ok(admit(query));
    if (mode === 'revoked') leases.revokeDispatchLease(query.dispatchLease);
    else leases.activateDispatchLease({ sessionId: query.sessionId, scopeId: query.dispatchLease.scopeId,
      runAttemptId: query.attempt.attemptId });
    assert.equal(leases.isDispatchLeaseCurrent(query.dispatchLease), false);
    assert.equal(admit(query), null);
    assert.equal(claim(query), null);
    assert.equal(canonicalCalls(query).length, 0);
  }
});

test('Space permission rejects duplicate exact admission markers as ambiguous', () => {
  const query = acceptedQuery();
  const first = admit(query);
  const second = admit(query);
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first.id, second.id);
  assert.equal(claim(query), null);
  assert.equal(canonicalCalls(query).length, 0);
  assert.equal(eventlog.listEvents(query.sessionId, {
    types: [correlation.CLAUDE_LOCAL_PERMISSION_CLAIM_EVENT],
  }).length, 0);
});

test('Space write identity preserves nulls, JSON strings, scalar types and own __proto__ data', () => {
  const cases: Array<{ name: string; original: Record<string, unknown>; changed: Record<string, unknown>; legacyCollision?: boolean }> = [
    { name: 'explicit null', original: writeInput({ expected_revision: null }), changed: writeInput(), legacyCollision: true },
    { name: 'JSON text versus object', original: { name: 'space_set_data', args_json: JSON.stringify((writeInput().args_json)) },
      changed: writeInput(), legacyCollision: true },
    { name: 'string versus number', original: writeInput({ correlation_fixture: '1' }), changed: writeInput({ correlation_fixture: 1 }) },
    { name: 'own __proto__', original: JSON.parse('{"name":"space_set_data","args_json":{"slug":"controlled-space-call-identity","__proto__":{"controlled":true}}}') as Record<string, unknown>,
      changed: { name: 'space_set_data', args_json: { slug: 'controlled-space-call-identity' } } },
  ];
  for (const entry of cases) {
    const query = acceptedQuery();
    const originalDigest = correlation.claudeLocalSpaceWriteInputDigest(LOCAL_TOOL, entry.original);
    assert.match(originalDigest!, /^[a-f0-9]{64}$/u, entry.name);
    assert.notEqual(originalDigest, correlation.claudeLocalSpaceWriteInputDigest(LOCAL_TOOL, entry.changed), entry.name);
    if (entry.legacyCollision) assert.equal(toolCallCorrelationFingerprint(LOCAL_TOOL, entry.original),
      toolCallCorrelationFingerprint(LOCAL_TOOL, entry.changed), 'the added lossless guard must close a legacy fingerprint collision');
    const admission = admit(query, entry.original);
    assert.ok(admission, entry.name);
    assert.equal(claim(query, entry.changed), null, entry.name);
    assert.equal(canonicalCalls(query).length, 0, entry.name);
    assert.ok(claim(query, entry.original), entry.name);
    assert.equal(canonicalCalls(query)[0]!.data.exactInputDigest, originalDigest, entry.name);
  }
});

test('Claude MCP provider identity comes only from the exact own transport metadata field', () => {
  const extra = { _meta: { 'claudecode/toolUseId': 'controlled-provider-call' } };
  assert.equal(correlation.claudeLocalMcpProviderCallId(extra), 'controlled-provider-call');
  for (const invalid of [undefined, {}, { toolUseId: 'controlled-provider-call' },
    Object.create(extra), { _meta: Object.create(extra._meta) }, { _meta: [] },
    ...['', ' padded ', 'line\nbreak', 'control\u007f', 'x'.repeat(513)]
      .map(id => ({ _meta: { 'claudecode/toolUseId': id } })),
    { _meta: { 'claudecode/toolUseId': 1 } },
  ]) assert.equal(correlation.claudeLocalMcpProviderCallId(invalid), undefined);
});
