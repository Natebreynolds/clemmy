/**
 * Run: npx tsx --test src/tools/extract-structured.test.ts
 * extract_structured (2026-07-21, capability #3): schema-guided extraction
 * with deterministic validation — required fields verified, never invented.
 * The model call is injected; these tests pin the CONTRACT around it.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-extract-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { registerExtractStructuredTools, focusSource } = await import('./extract-structured-tools.js');
const { rememberToolSchema, resetToolSchemaCache } = await import('./composio-schema-cache.js');

test.after(() => rmSync(TMP, { recursive: true, force: true }));
afterEach(() => resetToolSchemaCache());

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
function capture(extractor: (schemaJson: string, fields: string, source: string, priorFailure?: string) => Promise<string>): ToolHandler {
  let handler: ToolHandler | undefined;
  const fake = { tool: (_n: string, _d: string, _s: unknown, h: ToolHandler) => { handler = h; } };
  (registerExtractStructuredTools as (s: unknown, e?: unknown) => void)(fake, extractor);
  return handler!;
}
const textOf = (r: { content: Array<{ text: string }> }): string => r.content[0].text;

const CONTACT_SCHEMA = JSON.stringify({
  type: 'object',
  required: ['name', 'email'],
  properties: {
    name: { type: 'string', description: 'Full name of the contact' },
    email: { type: 'string', description: 'Email address' },
    company: { type: 'string' },
  },
});

test('a clean extraction validates and returns the payload', async () => {
  const handler = capture(async () => '{"name":"Amy Chen","email":"amy@firm.example","company":"Firm LLC"}');
  const out = JSON.parse(textOf(await handler({ schema: CONTACT_SCHEMA, text: 'From: Amy Chen <amy@firm.example> at Firm LLC' })));
  assert.equal(out.validated, true);
  assert.deepEqual(out.extracted, { name: 'Amy Chen', email: 'amy@firm.example', company: 'Firm LLC' });
});

test('a missing REQUIRED field triggers ONE corrective retry carrying the exact failure', async () => {
  const attempts: Array<string | undefined> = [];
  const handler = capture(async (_s, _f, _src, priorFailure) => {
    attempts.push(priorFailure);
    return attempts.length === 1
      ? '{"name":"Amy Chen"}' // forgot email
      : '{"name":"Amy Chen","email":"amy@firm.example"}';
  });
  const out = JSON.parse(textOf(await handler({ schema: CONTACT_SCHEMA, text: 'Amy Chen — amy@firm.example' })));
  assert.equal(out.validated, true);
  assert.equal(attempts.length, 2);
  assert.match(attempts[1] ?? '', /missing required field.*email/, 'the retry knows exactly what failed');
});

test('a source that genuinely lacks the field FAILS HONESTLY — never invented', async () => {
  const handler = capture(async () => '{"name":"Amy Chen"}'); // email truly absent, both attempts
  const out = textOf(await handler({ schema: CONTACT_SCHEMA, text: 'Spoke to Amy Chen at the conference.' }));
  assert.match(out, /^ERROR:/);
  assert.match(out, /missing required field.*email/);
  assert.match(out, /NEVER invent/, 'the corrective forbids fabrication');
});

test('fenced/prose-wrapped model output is JSON-repaired instead of failing', async () => {
  const handler = capture(async () => 'Here is the result:\n```json\n{"name":"Amy","email":"a@x.example"}\n```');
  const out = JSON.parse(textOf(await handler({ schema: CONTACT_SCHEMA, text: 'x' })));
  assert.equal(out.validated, true);
  assert.equal(out.note, 'model output needed JSON repair');
});

test('tool_slug pulls the cached Composio action schema; uncached slug gets a corrective', async () => {
  rememberToolSchema('SALESFORCE_CREATE_CONTACT', { type: 'object', required: ['LastName'], properties: { LastName: { type: 'string' }, Email: { type: 'string' } } });
  const handler = capture(async () => '{"LastName":"Chen","Email":"amy@firm.example"}');
  const out = JSON.parse(textOf(await handler({ tool_slug: 'SALESFORCE_CREATE_CONTACT', text: 'Amy Chen amy@firm.example' })));
  assert.equal(out.validated, true);
  assert.equal(out.extracted.LastName, 'Chen');
  const miss = textOf(await handler({ tool_slug: 'NEVER_CACHED_ACTION', text: 'x' }));
  assert.match(miss, /no cached schema/);
  assert.match(miss, /composio_search_tools/, 'the corrective teaches the self-healing path');
});

test('focusSource: an oversized document narrows to schema-relevant passages', () => {
  const doc = [
    ...Array.from({ length: 200 }, (_, i) => `## Filler ${i}\n\nUnrelated boilerplate paragraph ${i} about weather and logistics and scheduling.`),
    '## Client Details\n\nThe client contact is Amy Chen, email amy@firm.example, company Firm LLC.',
  ].join('\n\n');
  const schema = JSON.parse(CONTACT_SCHEMA) as { properties: Record<string, unknown> };
  const focused = focusSource(doc, schema);
  assert.ok(focused.length <= 25_000, 'capped');
  assert.match(focused, /amy@firm\.example/, 'the relevant passage survives the narrowing');
});
