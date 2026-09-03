import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCompleteJsonObjects,
  extractJsonCandidate,
  parseStoredToolOutputJson,
  repairToParseableJson,
  isParseableJson,
  conformsToJsonSchemaShape,
} from './json-repair.js';

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

test('stored output: genuinely non-JSON text recovers nothing (and must say so honestly)', () => {
  assert.equal(parseStoredToolOutputJson('just some prose, no payload here'), null);
  assert.equal(parseStoredToolOutputJson(''), null);
});
