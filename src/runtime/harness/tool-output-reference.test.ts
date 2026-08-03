/**
 * Layer 1 — the $fromToolOutput resolver: high-stakes values flow by reference
 * from the tool_outputs store, never model-typed. Run:
 *   npx tsx --test src/runtime/harness/tool-output-reference.test.ts
 */
import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-tool-output-ref';
process.env.CLEMENTINE_HOME = TEST_HOME;

const { appendEvent, createSession, resetEventLog, writeToolOutput } = await import('./eventlog.js');
const { resolveToolOutputReferences, extractByPath, hasToolOutputReference } = await import('./tool-output-reference.js');

const S = 'sess-tool-output-ref';

before(() => rmSync(TEST_HOME, { recursive: true, force: true }));
beforeEach(() => { resetEventLog(); createSession({ id: S, kind: 'chat' }); });

function writeTrustedOutput(input: {
  callId: string;
  invocationNonce: string;
  tool: string;
  output: string;
  effect: 'read' | 'compute';
}): void {
  const called = appendEvent({
    sessionId: S,
    turn: 1,
    role: 'agent',
    type: 'tool_called',
    data: { tool: input.tool, callId: input.callId, effect: input.effect },
  });
  writeToolOutput({
    sessionId: S,
    callId: input.callId,
    invocationNonce: input.invocationNonce,
    tool: input.tool,
    output: input.output,
  });
  appendEvent({
    sessionId: S,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    parentEventId: called.id,
    data: { tool: input.tool, callId: input.callId, effect: input.effect, ok: true },
  });
}

// ---------- extractByPath ----------

test('extractByPath handles dot paths and [*] array mapping', () => {
  const doc = { result: { records: [{ Email: 'a@x.co' }, { Email: 'b@x.co' }], total: 2 } };
  assert.deepEqual(extractByPath(doc, 'result.records[*].Email'), ['a@x.co', 'b@x.co']);
  assert.equal(extractByPath(doc, 'result.total'), 2);
  assert.deepEqual(extractByPath(doc, undefined), doc);
  assert.equal(extractByPath(doc, 'result.missing.key'), undefined);
});

// ---------- resolveToolOutputReferences (the incident, prevented) ----------

test('resolves a recipient roster from a prior tool output — values never model-typed', () => {
  const roster = { result: { records: Array.from({ length: 8 }, (_, i) => ({ Email: `person${i}@scorpion.co` })) } };
  writeTrustedOutput({
    callId: 'call_sf',
    invocationNonce: 'roster-read',
    tool: 'salesforce_query',
    output: JSON.stringify(roster),
    effect: 'read',
  });

  const args = {
    subject: '1st Team Meet up!',
    attendees_info: { $fromToolOutput: { callId: 'call_sf', path: 'result.records[*].Email' } },
  };
  const out = resolveToolOutputReferences(S, args);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(
    (out.resolved as { attendees_info: string[] }).attendees_info,
    Array.from({ length: 8 }, (_, i) => `person${i}@scorpion.co`),
    'all 8 real addresses, none fabricated or dropped',
  );
  assert.equal((out.resolved as { subject: string }).subject, '1st Team Meet up!', 'non-reference fields untouched');
  assert.deepEqual(out.references, [{ callId: 'call_sf', path: 'result.records[*].Email', count: 8 }]);
});

test('resolves through a run_shell_command --json wrapper (sf/gh/aws)', () => {
  const payload = JSON.stringify({ result: { records: [{ Email: 'x@co' }, { Email: 'y@co' }] } });
  writeTrustedOutput({
    callId: 'call_shell',
    invocationNonce: 'shell-read',
    tool: 'run_shell_command',
    output: `exit_code: 0\n\nstdout:\n${payload}\nstderr:\n`,
    effect: 'compute',
  });
  const out = resolveToolOutputReferences(S, { to: { $fromToolOutput: { callId: 'call_shell', path: 'result.records[*].Email' } } });
  assert.deepEqual(out.errors, []);
  assert.deepEqual((out.resolved as { to: string[] }).to, ['x@co', 'y@co']);
});

// ---------- fail-closed ----------

test('fail-closed: an unresolvable reference is an error, not a silent empty send', () => {
  writeTrustedOutput({
    callId: 'call_ok',
    invocationNonce: 'empty-read',
    tool: 't',
    output: JSON.stringify({ records: [] }),
    effect: 'read',
  });
  const missing = resolveToolOutputReferences(S, { to: { $fromToolOutput: { callId: 'call_absent' } } });
  assert.equal(missing.errors.length, 1, 'missing call_id errors');
  const badPath = resolveToolOutputReferences(S, { to: { $fromToolOutput: { callId: 'call_ok', path: 'nope[*].Email' } } });
  assert.equal(badPath.errors.length, 1, 'a path that resolves to nothing errors');
  assert.match(badPath.errors[0], /resolved to nothing/i);
});

test('fail-closed: reused call ids cannot feed stale longest-wins values into a write', () => {
  writeToolOutput({
    sessionId: S,
    callId: 'dup-read',
    invocationNonce: 'nonce-stale',
    tool: 'salesforce_query',
    output: JSON.stringify({ result: { records: [{ Email: 'stale-dangerous-address@example.com' }] }, padding: 'x'.repeat(5_000) }),
  });
  writeToolOutput({
    sessionId: S,
    callId: 'dup-read',
    invocationNonce: 'nonce-current',
    tool: 'salesforce_query',
    output: JSON.stringify({ result: { records: [{ Email: 'current@example.com' }] } }),
  });
  const out = resolveToolOutputReferences(S, {
    to: { $fromToolOutput: { callId: 'dup-read', path: 'result.records[*].Email' } },
  });
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /not a trusted read\/compute|reused by 2 invocations|stale and current/i);
  assert.equal((out.resolved as { to?: unknown }).to, undefined);
});

test('fail-closed: provider request echoes are not grounded $fromToolOutput values', () => {
  writeTrustedOutput({
    callId: 'echo-read',
    invocationNonce: 'nonce-echo',
    tool: 'salesforce_query',
    output: JSON.stringify({ data: { request_body: { Email: 'model-guessed@example.com' }, records: [] } }),
    effect: 'read',
  });
  const out = resolveToolOutputReferences(S, {
    to: { $fromToolOutput: { callId: 'echo-read', path: 'data.request_body.Email' } },
  });
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /resolved to nothing/i);
});

test('fail-closed: a derived reader call cannot replace the original source authority', () => {
  const providerOutput = JSON.stringify({ records: [{ Email: 'provider-returned@example.com' }] });
  writeTrustedOutput({
    callId: 'original-read',
    invocationNonce: 'nonce-original-read',
    tool: 'provider_search',
    output: providerOutput,
    effect: 'read',
  });
  writeTrustedOutput({
    callId: 'query-rendering',
    invocationNonce: 'nonce-query-rendering',
    tool: 'tool_output_query',
    output: providerOutput,
    effect: 'read',
  });

  const derived = resolveToolOutputReferences(S, {
    to: { $fromToolOutput: { callId: 'query-rendering', path: 'records[*].Email' } },
  });
  assert.equal(derived.errors.length, 1);
  assert.match(derived.errors[0], /not a trusted read\/compute result/);
  assert.equal((derived.resolved as { to?: unknown }).to, undefined);

  const original = resolveToolOutputReferences(S, {
    to: { $fromToolOutput: { callId: 'original-read', path: 'records[*].Email' } },
  });
  assert.deepEqual(original.errors, []);
  assert.deepEqual((original.resolved as { to: string[] }).to, ['provider-returned@example.com']);
});

// ---------- pass-through + detection ----------

test('non-reference args pass through unchanged; detection works', () => {
  const plain = { subject: 'hi', to: ['a@co'], nested: { n: 1 } };
  const out = resolveToolOutputReferences(S, plain);
  assert.deepEqual(out.resolved, plain);
  assert.deepEqual(out.references, []);
  assert.equal(hasToolOutputReference(plain), false);
  assert.equal(hasToolOutputReference({ to: { $fromToolOutput: { callId: 'c' } } }), true);
});

test('capability policy: a reference to a WRITE/SEND output is refused (no laundering)', async () => {
  const { appendEvent } = await import('./eventlog.js');
  // A prior SEND whose output is a confirmation — NOT source authority.
  writeToolOutput({ sessionId: S, callId: 'call_send', tool: 'outlook_send_mail', output: JSON.stringify({ sentTo: ['leaked@x.co'] }) });
  appendEvent({ sessionId: S, turn: 1, role: 'tool', type: 'tool_returned', data: { tool: 'outlook_send_mail', callId: 'call_send', effect: 'external_write' } });

  const out = resolveToolOutputReferences(S, { to: { $fromToolOutput: { callId: 'call_send', path: 'sentTo[*]' } } });
  assert.equal(out.errors.length, 1, 'a reference cannot bind from a send output');
  assert.match(out.errors[0], /not a trusted read\/compute result/);
});
