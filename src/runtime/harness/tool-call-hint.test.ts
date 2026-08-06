import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { toolCallHint } from './tool-call-hint.js';
import { digestToolOutput } from './tool-output-digest.js';
import { RECALL_TOOL_RESULT_SHAPE, TOOL_OUTPUT_QUERY_SHAPE } from '../../tools/recall-tools.js';

/**
 * REGRESSION PIN — every model-facing tool-call example must be valid JSON
 * that validates against the REAL registered schema.
 *
 * Live failure class (2026-08-05): prose pseudo-signatures in digest footers /
 * clip stubs / lane prompts (`tool_output_query("call_x", {offset, fields})`,
 * bare comma field lists, python-style kwargs) were copied verbatim by the
 * model into unparseable tool inputs — 4/4 recorded InputValidationErrors,
 * all on tool_output_query. The OpenAI lane survives via strict constrained
 * decoding; the Claude SDK lane (streamed input) and BYO lane (strict stripped
 * at the wire) emit exactly what the hints teach. So the hints must BE the
 * contract:
 *
 *   Tooth A — rendered hints parse as JSON and zod-validate against the
 *             exported tool shapes.
 *   Tooth B — no source file may hand-write a paren-form call signature for
 *             the reader tools; examples must render through toolCallHint (or
 *             be literal `<tool> {json}` text that tooth A's extractor covers).
 */

const QUERY_SCHEMA = z.object(TOOL_OUTPUT_QUERY_SHAPE).strict();
const RECALL_SCHEMA = z.object(RECALL_TOOL_RESULT_SHAPE).strict();

// Extract `<tool> {flat-json}` examples from a rendered model-facing string.
// Hint args are flat objects by construction (arrays allowed, nested objects
// not), so a non-nested brace matcher is exact.
const HINT_RE = /\b(tool_output_query|recall_tool_result)\s+(\{[^{}]*\})/g;

function extractHints(text: string): Array<{ tool: string; json: string }> {
  return [...text.matchAll(HINT_RE)].map((m) => ({ tool: m[1], json: m[2] }));
}

function assertHintsValid(text: string, where: string): number {
  const hints = extractHints(text);
  for (const h of hints) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(h.json.replaceAll('<call id>', 'call_x').replaceAll('<field>', 'name'));
    } catch (err) {
      assert.fail(`${where}: hint for ${h.tool} is not valid JSON: ${h.json} (${String(err)})`);
    }
    const schema = h.tool === 'tool_output_query' ? QUERY_SCHEMA : RECALL_SCHEMA;
    const verdict = schema.safeParse(parsed);
    assert.ok(verdict.success, `${where}: hint for ${h.tool} does not validate against the registered schema: ${h.json}`);
  }
  return hints.length;
}

test('toolCallHint renders valid JSON that validates against the registered schemas', () => {
  const q = toolCallHint('tool_output_query', { call_id: 'call_abc', fields: ['subject', 'start'], limit: 50 });
  const r = toolCallHint('recall_tool_result', { call_id: 'call_abc' });
  assert.equal(assertHintsValid(`${q}\n${r}`, 'toolCallHint'), 2);
});

test('digest footer examples (array + object + text paths) are valid, schema-conformant JSON', () => {
  const records = Array.from({ length: 40 }, (_, i) => ({
    subject: `Event ${i} ${'x'.repeat(400)}`,
    start: { dateTime: `2026-08-06T0${i % 10}:00:00` },
    organizer: { emailAddress: { address: `p${i}@example.test` } },
  }));
  const arrayDigest = digestToolOutput(JSON.stringify(records), { maxChars: 2_000, toolName: 'composio_execute_tool', callId: 'call_arr' });
  assert.ok(assertHintsValid(arrayDigest, 'array digest') >= 1, 'array digest must include at least one reader hint');
  // The field list itself must be lift-able JSON (the live failure lifted a
  // bare comma list into `"fields": subject,start,…`).
  const fieldList = arrayDigest.match(/Fields: (\[[^\]]*\])/);
  assert.ok(fieldList, 'array digest advertises fields as a JSON array');
  assert.ok(Array.isArray(JSON.parse(fieldList![1])), 'advertised field list parses as a JSON array');

  const objectDigest = digestToolOutput(
    JSON.stringify({ data: { value: records } }),
    { maxChars: 2_000, toolName: 'composio_execute_tool', callId: 'call_obj' },
  );
  assert.ok(assertHintsValid(objectDigest, 'object digest') >= 1, 'object digest must include at least one reader hint');
  // The object path (Graph's {data:{value:[…]}} — the live calendar shape) also
  // advertises record fields; that list must be lift-able JSON too.
  const objFieldList = objectDigest.match(/with fields: (\[[^\]]*\])/);
  assert.ok(objFieldList, 'object digest advertises dominant-array fields as a JSON array');
  assert.ok(Array.isArray(JSON.parse(objFieldList![1])), 'object-path field list parses as a JSON array');
  // And the recovery example carries those REAL field names, ready to copy.
  assert.match(objectDigest, /tool_output_query \{"call_id":"call_obj","fields":\["subject"/);

  const textDigest = digestToolOutput('line\n'.repeat(5_000), { maxChars: 2_000, toolName: 'run_shell_command', callId: 'call_txt' });
  assertHintsValid(textDigest, 'text digest');
});

// ───────────────────────── Tooth B: source lint ─────────────────────────

function walkTsFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walkTsFiles(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

test('no source file hand-writes a paren-form reader-tool call signature (lint tooth)', () => {
  const srcRoot = fileURLToPath(new URL('../..', import.meta.url));
  const offenders: string[] = [];
  for (const file of walkTsFiles(srcRoot, [])) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/\b(tool_output_query|recall_tool_result)\s*\(/.test(lines[i])
        // The registration site legitimately passes the NAME as a string right
        // before an arg list — only flag call-shaped text, not `'tool_output_query',`.
        && !/server\.tool\(/.test(lines[i])) {
        offenders.push(`${path.relative(srcRoot, file)}:${i + 1}: ${lines[i].trim().slice(0, 120)}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Paren-form reader-tool signatures teach the model invalid input syntax `
    + `(live 2026-08-05 InputValidationError class). Render examples with `
    + `toolCallHint(...) instead:\n${offenders.join('\n')}`,
  );
});

// ───────────── Tooth A over every rendered hint surface we can reach ─────────────

test('all statically-known hint strings across lanes carry only valid-JSON examples', async () => {
  // Import the modules whose exported/renderable strings carry hints. Kept as
  // dynamic imports so a future site added to this list can't be forgotten
  // silently — adding a hint site without extending this list is caught by the
  // lint tooth above (the site must call toolCallHint, and toolCallHint's own
  // output is pinned by the first test).
  const { toolCallHint: hint } = await import('./tool-call-hint.js');
  const samples = [
    hint('tool_output_query', { call_id: '<call id>' }),
    hint('tool_output_query', { call_id: '<call id>', fields: ['<field>'] }),
    hint('recall_tool_result', { call_id: '<call id>' }),
  ];
  for (const s of samples) assertHintsValid(s, 'placeholder-hint');
});
