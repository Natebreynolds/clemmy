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

const { createSession, resetEventLog, writeToolOutput } = await import('./eventlog.js');
const { resolveToolOutputReferences, extractByPath, hasToolOutputReference } = await import('./tool-output-reference.js');

const S = 'sess-tool-output-ref';

before(() => rmSync(TEST_HOME, { recursive: true, force: true }));
beforeEach(() => { resetEventLog(); createSession({ id: S, kind: 'chat' }); });

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
  writeToolOutput({ sessionId: S, callId: 'call_sf', tool: 'salesforce_query', output: JSON.stringify(roster) });

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
  writeToolOutput({ sessionId: S, callId: 'call_shell', tool: 'run_shell_command', output: `exit_code: 0\n\nstdout:\n${payload}\nstderr:\n` });
  const out = resolveToolOutputReferences(S, { to: { $fromToolOutput: { callId: 'call_shell', path: 'result.records[*].Email' } } });
  assert.deepEqual(out.errors, []);
  assert.deepEqual((out.resolved as { to: string[] }).to, ['x@co', 'y@co']);
});

// ---------- fail-closed ----------

test('fail-closed: an unresolvable reference is an error, not a silent empty send', () => {
  writeToolOutput({ sessionId: S, callId: 'call_ok', tool: 't', output: JSON.stringify({ records: [] }) });
  const missing = resolveToolOutputReferences(S, { to: { $fromToolOutput: { callId: 'call_absent' } } });
  assert.equal(missing.errors.length, 1, 'missing call_id errors');
  const badPath = resolveToolOutputReferences(S, { to: { $fromToolOutput: { callId: 'call_ok', path: 'nope[*].Email' } } });
  assert.equal(badPath.errors.length, 1, 'a path that resolves to nothing errors');
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
