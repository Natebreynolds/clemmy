import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCompleteJsonObjects,
  extractJsonCandidate,
  parseStoredToolOutputJson,
  repairToParseableJson,
  isParseableJson,
  conformsToJsonSchemaShape,
  readHostCliEnvelope,
} from './json-repair.js';
import { parseShellToolOutput } from '../../tools/inner-dispatch.js';

test('repair: ```json fenced object is unwrapped and parses', () => {
  const { text, repaired } = repairToParseableJson('```json\n{"done": true}\n```');
  assert.equal(repaired, true);
  assert.deepEqual(JSON.parse(text), { done: true });
});

test('repair: no-language fence is unwrapped', () => {
  const { text } = repairToParseableJson('```\n{"a": 1}\n```');
  assert.deepEqual(JSON.parse(text), { a: 1 });
});

test('repair: prose before AND after a bare object is stripped', () => {
  const { text, repaired } = repairToParseableJson('Here is the result:\n{"verdict":"done"}\nHope that helps!');
  assert.equal(repaired, true);
  assert.deepEqual(JSON.parse(text), { verdict: 'done' });
});

test('repair: already-clean object is returned byte-for-byte (idempotent)', () => {
  const input = '{"a":1}';
  const { text, repaired } = repairToParseableJson(input);
  assert.equal(text, input);
  assert.equal(repaired, false);
});

test('repair: top-level array (fenced + bare) is extracted', () => {
  assert.deepEqual(JSON.parse(repairToParseableJson('```json\n[1,2,3]\n```').text), [1, 2, 3]);
  assert.deepEqual(JSON.parse(repairToParseableJson('result: [1,2]').text), [1, 2]);
});

test('repair: braces inside a string do NOT truncate the object (string-aware scan)', () => {
  const { text } = repairToParseableJson('prefix {"reason":"use } and { inside"} suffix');
  assert.deepEqual(JSON.parse(text), { reason: 'use } and { inside' });
});

test('repair: nested object with trailing prose yields the correct balanced slice', () => {
  const { text } = repairToParseableJson('{"a":{"b":1}} trailing words');
  assert.deepEqual(JSON.parse(text), { a: { b: 1 } });
});

test('repair: empty / prose-only / fence-only returns the original untouched', () => {
  for (const junk of ['', '   ', 'no json here at all', '```\n```']) {
    const { text, repaired } = repairToParseableJson(junk);
    assert.equal(text, junk);
    assert.equal(repaired, false);
  }
});

test('repair: MiniMax-style <think> prefix is stripped before the JSON', () => {
  const { text, repaired } = repairToParseableJson('<think>\nThe user said go.\n</think>\n\n{"ok": true}');
  assert.equal(repaired, true);
  assert.deepEqual(JSON.parse(text), { ok: true });
});

test('repair: <think> block that RESTATES the schema (braces) does not derail extraction', () => {
  // The reasoning contains a decoy {"x": 2}; the real answer is {"a": 1} after </think>.
  const raw = '<think>I should return {"x": 2}? No — the format is {"a": 1}.</think>\n{"a": 1}';
  const { text } = repairToParseableJson(raw);
  assert.deepEqual(JSON.parse(text), { a: 1 });
});

test('repair: <think> prefix + fenced JSON', () => {
  const { text } = repairToParseableJson('<think>reasoning here</think>\n```json\n{"done": false}\n```');
  assert.deepEqual(JSON.parse(text), { done: false });
});

test('repair: truncated/unclosed <think> with no JSON → null (lets the re-ask recover, never crashes)', () => {
  const { text, repaired } = repairToParseableJson('<think>\nI am still reasoning and the output got cut off mid');
  assert.equal(repaired, false);
  assert.equal(text, '<think>\nI am still reasoning and the output got cut off mid');
  assert.equal(extractJsonCandidate(text), null);
});

test('repair: unclosed <think> followed by the real JSON still extracts it', () => {
  const { text } = repairToParseableJson('<think>\nlet me answer {"done": true}');
  assert.deepEqual(JSON.parse(text), { done: true });
});

test('extractJsonCandidate: returns null when nothing recoverable', () => {
  assert.equal(extractJsonCandidate('totally not json'), null);
});

test('isParseableJson basic', () => {
  assert.equal(isParseableJson('{"a":1}'), true);
  assert.equal(isParseableJson('{a:1}'), false);
});

test('extractCompleteJsonObjects recovers a clipped array prefix and drops its unfinished tail', () => {
  const raw = [
    '[',
    '{"id":"site-1","label":"brace } inside a string"},',
    '{"id":"site-2","nested":{"ok":true}},',
    '{"id":"unfinished"',
  ].join('');
  assert.deepEqual(extractCompleteJsonObjects(raw), [
    { id: 'site-1', label: 'brace } inside a string' },
    { id: 'site-2', nested: { ok: true } },
  ]);
});

test('extractCompleteJsonObjects ignores balanced prose braces that are not JSON', () => {
  assert.deepEqual(
    extractCompleteJsonObjects('log {not json} then {"id":"real"} trailing'),
    [{ id: 'real' }],
  );
});

// --- conformsToJsonSchemaShape (W2: brain-agnostic decision-shape guard) ----

// FAITHFUL to the real wire schema: normalizeZodForCodexStrict forces every
// field into `required`, and nullable/nullish fields (reply, reason) serialize
// as `anyOf` with NO top-level `type` (so the validator must skip type-checking
// them — the key guard against false positives on healthy decisions).
const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    reply: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    summary: { type: 'string' },
    done: { type: 'boolean' },
    nextAction: { type: 'string', enum: ['awaiting_user_input', 'awaiting_approval', 'awaiting_handoff_result', 'completed', 'abandoned'] },
    reason: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['reply', 'summary', 'done', 'nextAction', 'reason'],
};

test('shape: a fully-conforming decision passes (no false positive)', () => {
  const r = conformsToJsonSchemaShape(
    { reply: 'hi', summary: 'replied to greeting', done: true, nextAction: 'completed', reason: null },
    DECISION_SCHEMA,
  );
  assert.deepEqual(r, { ok: true, violations: [] });
});

test('shape: missing required field is flagged', () => {
  const r = conformsToJsonSchemaShape({ summary: 'did a thing', nextAction: 'completed', reason: null }, DECISION_SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.includes('done')), 'flags missing done');
});

test('shape: wrong primitive type is flagged', () => {
  const r = conformsToJsonSchemaShape(
    { summary: 'x', done: 'yes', nextAction: 'completed', reason: null }, DECISION_SCHEMA,
  );
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.includes('done')), 'flags done not boolean');
});

test('shape: invalid enum value is flagged', () => {
  const r = conformsToJsonSchemaShape(
    { summary: 'x', done: false, nextAction: 'keep_going', reason: null }, DECISION_SCHEMA,
  );
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.includes('nextAction')), 'flags bad enum');
});

test('shape: a completely different object (wrong shape) is flagged', () => {
  const r = conformsToJsonSchemaShape({ answer: 'the capital is Paris' }, DECISION_SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(r.violations.length >= 3, 'flags the missing required fields');
});

test('shape: present-but-null nullable field is NOT flagged (conservative)', () => {
  const r = conformsToJsonSchemaShape(
    { reply: null, summary: 'x', done: true, nextAction: 'completed', reason: null }, DECISION_SCHEMA,
  );
  assert.equal(r.ok, true);
});

test('shape: no schema / non-object schema → always passes (never false-positive)', () => {
  assert.equal(conformsToJsonSchemaShape({ anything: 1 }, undefined).ok, true);
  assert.equal(conformsToJsonSchemaShape('not even an object', { type: 'string' }).ok, true);
});

test('shape: nested object/array property types are skipped (only top-level primitives checked)', () => {
  const schema = { type: 'object', properties: { items: { type: 'array' }, meta: { type: 'object' } }, required: ['items'] };
  // items present (wrong-ish but array/object types are not cheaply validated) → passes
  assert.equal(conformsToJsonSchemaShape({ items: [1, 2], meta: { a: 1 } }, schema).ok, true);
  // items missing → required catches it
  assert.equal(conformsToJsonSchemaShape({ meta: {} }, schema).ok, false);
});

test('shape: a non-object value against an object schema is flagged', () => {
  const r = conformsToJsonSchemaShape(['not', 'an', 'object'], DECISION_SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(r.violations.includes('expected a JSON object'));
});

// ── parseStoredToolOutputJson ────────────────────────────────────────────────

test('stored host CLI results expose complete stdout JSON to every structured reader', () => {
  const payload = { status: 0, result: { records: [{ Name: 'Fictional Acorn', Contacts: { records: [{ Email: 'acorn@example.test' }] } }] } };
  const result = { version: 1, status: 'exited', operationId: 'salesforce_sf_soql_query', executableRealpath: '/usr/local/lib/sf/bin/sf', argv: ['data', 'query', '--json'], exitCode: 0, signal: null, stdout: JSON.stringify(payload), stderr: '', stdoutTruncated: false };
  for (const envelope of [result, { result, complete: true }]) {
    assert.deepEqual(parseStoredToolOutputJson(JSON.stringify(envelope))?.value, payload);
  }
  for (const envelope of [
    { result: { ...result, stdoutTruncated: true }, complete: true },
    { result, complete: false },
    { result: { ...result, exitCode: 1 }, complete: true },
    { result: { ...result, stdout: '{malformed' }, complete: true },
    { stdout: JSON.stringify(payload) },
  ]) {
    assert.deepEqual(parseStoredToolOutputJson(JSON.stringify(envelope))?.value, envelope,
      'partial, failed, malformed, or ordinary user objects do not become complete CLI data');
  }
});
// A parked tool output is the provider payload PLUS whatever prose the harness
// appended on the way in. Every shape below is verbatim from platform-49 run 6
// (2026-09-03, Sonnet 5), where a bare JSON.parse made tool_output_query tell
// the model its own valid JSON "is not JSON — use recall_tool_result". The
// model obeyed, came back for the next handle, got the same falsehood, and the
// no-progress governor ended the run with every byte it needed already read.

test('stored output: a composio route note appended after the payload still parses', () => {
  // composio-tools.ts appends `\n\n[account-route] …` to the JSON body.
  const raw = '{\n  "data": {\n    "ok": true\n  },\n  "successful": true\n}\n\n'
    + '[account-route] Using the exact account frozen by the accepted host plan (ca_W4NIppleAWBr).';
  assert.throws(() => JSON.parse(raw), 'precondition: the stored string is NOT bare JSON');

  const got = parseStoredToolOutputJson(raw);
  assert.ok(got, 'the payload is JSON and must be recovered');
  assert.equal(got.via, 'embedded');
  assert.deepEqual(got.value, { data: { ok: true }, successful: true });
});

test('stored output: a recall_tool_result preamble before the payload still parses', () => {
  // recall_tool_result's own output is parked too, and it leads with a header.
  const raw = 'Recalled chars 0–28503 of 28503 (28543 total bytes) • tool=composio_execute_tool'
    + ' • recorded at 2026-09-03T03:04:38.128Z\n\n{"data":{"rows":[1,2]},"successful":true}';
  assert.throws(() => JSON.parse(raw), 'precondition: the stored string is NOT bare JSON');

  const got = parseStoredToolOutputJson(raw);
  assert.ok(got, 'a leading preamble must not hide the payload');
  assert.deepEqual(got.value, { data: { rows: [1, 2] }, successful: true });
});

test('stored output: bare JSON is returned exactly, unchanged', () => {
  const got = parseStoredToolOutputJson('{"a":1}');
  assert.ok(got);
  assert.equal(got.via, 'exact');
  assert.deepEqual(got.value, { a: 1 });
});

test('stored output: the shell-wrapper precedence is unchanged', () => {
  // Pre-existing behavior: a run_shell_command envelope around --json output
  // resolves through the shell step, not the new embedded step.
  const raw = 'exit_code: 0\nstdout: {"records":[{"id":"a"}]}\nstderr:';
  const got = parseStoredToolOutputJson(raw, {
    shell: () => ({ stdout: '{"records":[{"id":"a"}]}', stdout_json: { records: [{ id: 'a' }] } }),
  });
  assert.ok(got);
  assert.equal(got.via, 'shell_stdout', 'the shell path must still win for shell-shaped output');
  assert.deepEqual(got.value, { records: [{ id: 'a' }] });
});

test('stored output: a host document with a pseudo-call before its data is queryable', () => {
  // Regression: a Space read leads with a view pointer written as a
  // pseudo-call (`{slug:"…"}` is not JSON); recovery stopped at that first
  // opener and the whole document was declared text.
  const dataset = { rows: [{ plot: 'Plot 7', note: 'valve replaced' }, { plot: 'Plot 8', note: 'pruned' }] };
  const raw = [
    'Workspace "Orchard board" (orchard-board) — active, v1.',
    '[status] static snapshot',
    'View source: space_get_view({slug:"orchard-board",grep:null,around:null}) returns the saved HTML.',
    `Dataset (complete JSON): ${JSON.stringify(dataset)}`,
    'No notes yet.',
  ].join('\n');
  assert.equal(extractJsonCandidate(raw), null,
    'precondition: the shared model-output parser keeps its first-candidate rule unchanged');
  const got = parseStoredToolOutputJson(raw);
  assert.ok(got, 'the dataset after the pseudo-call must be recovered');
  assert.equal(got.via, 'embedded');
  assert.deepEqual(got.value, dataset);
});

test('stored output: the largest complete value wins over a small JSON hint beside it', () => {
  // A reader's own header can carry a copyable `{"call_id":…}` hint before the
  // payload; the hint must never be mistaken for the data.
  const payload = { records: [{ id: 'a', name: 'First' }, { id: 'b', name: 'Second' }] };
  const raw = 'Recalled chars 0–120 of 120 • (continue with recall_tool_result {"call_id":"call_1","offset":120})\n\n'
    + JSON.stringify(payload);
  const got = parseStoredToolOutputJson(raw);
  assert.ok(got);
  assert.deepEqual(got.value, payload);
});

test('stored output: successive-opener recovery is bounded', () => {
  // Many small parseable values before the payload: the scan stops after a
  // bounded number of attempts instead of walking every bracket in the text.
  const payload = { records: Array.from({ length: 5 }, (_, i) => ({ id: i })) };
  const noise = Array.from({ length: 20 }, (_, i) => `item ${i}: [${i}]`).join('\n');
  assert.equal(parseStoredToolOutputJson(`${noise}\n${JSON.stringify(payload)}`), null,
    'the payload lies beyond the attempt bound, and a bracketed number is never a payload');
  const near = parseStoredToolOutputJson(`item: [1]\nitem: [2]\n${JSON.stringify(payload)}`);
  assert.deepEqual(near?.value, payload, 'within the bound the largest value wins');
});

test('stored output: a markdown citation is prose, not a payload', () => {
  const raw = [
    '[Jump to content](#bodyContent)',
    '# Willamette Valley',
    'The valley runs north to south through Oregon.[[1]](https://en.example.org/wiki/Willamette#cite_note-1)',
    'Its soils favour orchards.[[2]](https://en.example.org/wiki/Willamette#cite_note-2)',
  ].join('\n');
  assert.equal(parseStoredToolOutputJson(raw), null);
});

test('stored output: a fenced example in scraped documentation is not the result', () => {
  const raw = [
    '[Skip to main](#main)',
    '## Create a contact',
    'Send a POST with the contact body:',
    '```json',
    '{"email":"jane@example.com","name":"Jane"}',
    '```',
    'The response echoes the created contact.',
  ].join('\n');
  assert.equal(parseStoredToolOutputJson(raw), null);
});

test('stored output: a bracketed number in prose is not a payload', () => {
  assert.equal(parseStoredToolOutputJson('See [the docs](x) for details. Build [42] passed.'), null);
});

test('stored output: a complete but invalid JSON document stays text, never a fragment of itself', () => {
  // A NaN (the default of some serializers) makes the document not JSON, and
  // no value inside it is the whole result.
  const raw = '{"meta":{"source":"export","page":1},"rows":[{"id":1,"v":NaN},{"id":2,"v":0.5}]}';
  assert.equal(parseStoredToolOutputJson(raw), null);
  assert.equal(parseStoredToolOutputJson(`Export follows.\n${raw}\nDone.`), null);
});

test('stored output: a shell array cut short by an invalid row keeps its honest partial prefix', () => {
  const raw = [
    'exit_code: 0',
    'stdout:',
    '[{"id":1,"score":0.9},{"id":2,"score":0.5},{"id":3,"score":0.4},{"id":4,"score":NaN}]',
  ].join('\n');
  const got = parseStoredToolOutputJson(raw, { shell: parseShellToolOutput });
  assert.ok(got);
  assert.equal(got.via, 'shell_objects');
  assert.equal(got.partialArrayPrefix, true);
  assert.deepEqual(got.value, [{ id: 1, score: 0.9 }, { id: 2, score: 0.5 }, { id: 3, score: 0.4 }]);
});

test('stored output: a shell array with an invalid row in the middle keeps only the rows before it', () => {
  // The rows after an invalid one are not the array's prefix: offering them
  // as one would drop a row silently and misstate every later position.
  const shell = (stdout: string) => ['exit_code: 0', 'stdout:', stdout].join('\n');
  const middle = parseStoredToolOutputJson(shell('[{"a":1},{"a":NaN},{"a":3}]'), { shell: parseShellToolOutput });
  assert.ok(middle);
  assert.equal(middle.via, 'shell_objects');
  assert.equal(middle.partialArrayPrefix, true);
  assert.deepEqual(middle.value, [{ a: 1 }]);

  const nonObject = parseStoredToolOutputJson(shell('Fetched rows.\n[{"a":1}, 7, {"a":3}, {"a":NaN}]'), { shell: parseShellToolOutput });
  assert.ok(nonObject);
  assert.deepEqual(nonObject.value, [{ a: 1 }], 'a non-object element ends the prefix too');

  // An invalid first row leaves no prefix, and a nested array inside that row
  // is never taken for the array itself.
  const firstInvalid = parseStoredToolOutputJson(
    shell('[{"a":NaN,"tags":[{"t":"x"}]},{"a":2}]'), { shell: parseShellToolOutput },
  );
  assert.equal(firstInvalid, null, JSON.stringify(firstInvalid));
});

test('stored output: a host document read with prose, tags and a view pointer before its dataset is queryable', () => {
  const dataset = {
    meta: { title: 'Orchard yields', revision: 3 },
    rows: [{ plot: 'Plot 7', kg: 410 }, { plot: 'Plot 8', kg: 385 }],
  };
  const raw = [
    'Workspace "Orchard yields" (orchard-yields) — active, v1.',
    'Success criteria: • Every plot listed [see note] • Renders on phone',
    'View source: space_get_view({slug:"orchard-yields",grep:null,around:null}) returns the saved HTML.',
    'For a root data edit, use space_save with replacement_data_json and this expected_revision.',
    'Snapshot revision: 9959404df21542d5',
    'Content mode: static_snapshot.',
    `Dataset (complete JSON): ${JSON.stringify(dataset)}`,
    'Notes: none [yet].',
  ].join('\n');
  const got = parseStoredToolOutputJson(raw);
  assert.ok(got, 'the dataset after the host prose must be recovered');
  assert.equal(got.via, 'embedded');
  assert.deepEqual(got.value, dataset);
});

test('stored output: a record inside a clipped array is never taken for the payload', () => {
  // The successive-opener scan must not present one complete element of a
  // clipped array as the whole result.
  const raw = 'Rows follow:\n[\n{"id":"a","amount":5},\n{"id":"b","amount":7},\n{"id":"partial"';
  assert.equal(parseStoredToolOutputJson(raw), null);
});

test('stored output: genuinely non-JSON text recovers nothing (and must say so honestly)', () => {
  assert.equal(parseStoredToolOutputJson('just some prose, no payload here'), null);
  assert.equal(parseStoredToolOutputJson(''), null);
});

const HOST_CLI_ENVELOPE = {
  version: 1,
  status: 'exited',
  operationId: 'vendor_tool_read',
  executableRealpath: '/usr/local/bin/vendor',
  argv: ['read', '--json'],
  exitCode: 0,
  signal: null,
  stdout: '{"status":0,"result":{"records":[{"Id":"1"}],"totalSize":1}}',
  stderr: ' ›   Warning: update available\n',
  stdoutTruncated: false,
  stderrTruncated: false,
};

test('host CLI envelope: a clean JSON run reads as its payload, bare or kernel-wrapped', () => {
  const bare = readHostCliEnvelope(HOST_CLI_ENVELOPE);
  assert.equal(bare?.kind, 'clean');
  if (bare?.kind === 'clean') {
    assert.equal(bare.operationId, 'vendor_tool_read');
    assert.deepEqual(bare.stdoutJson, { status: 0, result: { records: [{ Id: '1' }], totalSize: 1 } });
  }
  const wrapped = readHostCliEnvelope({ complete: true, result: HOST_CLI_ENVELOPE });
  assert.equal(wrapped?.kind, 'clean');
  // An incomplete kernel wrapper is not a finished envelope.
  assert.equal(readHostCliEnvelope({ complete: false, result: HOST_CLI_ENVELOPE }), null);
  // The stored-output reader keeps unwrapping the same shape the same way.
  const stored = parseStoredToolOutputJson(JSON.stringify({ complete: true, result: HOST_CLI_ENVELOPE }));
  assert.equal(stored?.via, 'host_cli_stdout');
  assert.deepEqual(stored?.value, { status: 0, result: { records: [{ Id: '1' }], totalSize: 1 } });
});

test('host CLI envelope: a failed or non-JSON run is reported as what it was, never unwrapped', () => {
  const failed = readHostCliEnvelope({ ...HOST_CLI_ENVELOPE, status: 'nonzero_exit', exitCode: 1, stderr: 'ERROR: no default org' });
  assert.deepEqual(failed, {
    kind: 'failed', operationId: 'vendor_tool_read', status: 'nonzero_exit', exitCode: 1, stderr: 'ERROR: no default org',
  });
  const text = readHostCliEnvelope({ ...HOST_CLI_ENVELOPE, stdout: 'plain text' });
  assert.equal(text?.kind, 'clean_text');
  const cut = readHostCliEnvelope({ ...HOST_CLI_ENVELOPE, stdoutTruncated: true });
  assert.equal(cut?.kind, 'clean_text');
  if (cut?.kind === 'clean_text') assert.equal(cut.stdoutTruncated, true);
  // The stored-output reader leaves those values untouched.
  const storedFailed = parseStoredToolOutputJson(JSON.stringify({ ...HOST_CLI_ENVELOPE, exitCode: 1, status: 'nonzero_exit' }));
  assert.equal(storedFailed?.via, 'exact');
  // Ordinary provider payloads are not envelopes.
  assert.equal(readHostCliEnvelope({ complete: true, result: { data: { value: [] } } }), null);
  assert.equal(readHostCliEnvelope('{"status":0}'), null);
  assert.equal(readHostCliEnvelope(null), null);
});

test('stored output: a bracketed number in shell prose is not the shell payload', () => {
  // The shell parser's first stdout candidate can be a count or a citation in
  // the prose before the data. Only stdout that is exactly JSON is taken
  // whole; a candidate beside prose must be record-shaped like any other.
  const shell = (stdout: string) => ['exit_code: 0', 'stdout:', stdout].join('\n');
  const counted = parseStoredToolOutputJson(shell('Fetched [2] rows.\n[{"id":1},{"id":2}]'), { shell: parseShellToolOutput });
  assert.ok(counted);
  assert.deepEqual(counted.value, [{ id: 1 }, { id: 2 }]);
  assert.notEqual(counted.partialArrayPrefix, true, 'a whole array is not labelled a prefix');

  const cited = parseStoredToolOutputJson(shell('See [[1]] note.\nNo data today.'), { shell: parseShellToolOutput });
  assert.equal(cited, null);

  const scalar = parseStoredToolOutputJson(shell('42'), { shell: parseShellToolOutput });
  assert.ok(scalar);
  assert.equal(scalar.via, 'shell_stdout', 'stdout that is exactly JSON is taken whole, whatever its shape');
  assert.equal(scalar.value, 42);
});

test('stored output: an array inside an invalid shell document is never taken for the whole result', () => {
  const shell = (stdout: string) => ['exit_code: 0', 'stdout:', stdout].join('\n');
  // The envelope closes but does not parse (NaN): the array inside it is part
  // of an invalid document, not the payload, whole or partial.
  const invalid = parseStoredToolOutputJson(
    shell('{"items":[{"id":1},{"id":2}],"total":NaN}'), { shell: parseShellToolOutput });
  assert.equal(invalid, null, JSON.stringify(invalid));
  // A clipped envelope never closes: the rows written so far are an honest prefix.
  const clipped = parseStoredToolOutputJson(
    shell('{"items":[{"id":1},{"id":2},{"id":3,"na'), { shell: parseShellToolOutput });
  assert.deepEqual(clipped?.value, [{ id: 1 }, { id: 2 }]);
  assert.equal(clipped?.partialArrayPrefix, true);
  // A top-level array after prose that closes is the whole array.
  const whole = parseStoredToolOutputJson(
    shell('Fetched rows.\n[{"id":1},{"id":2}]'), { shell: parseShellToolOutput });
  assert.deepEqual(whole?.value, [{ id: 1 }, { id: 2 }]);
  assert.notEqual(whole?.partialArrayPrefix, true);
});
