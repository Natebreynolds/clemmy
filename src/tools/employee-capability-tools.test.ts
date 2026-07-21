/**
 * Run: npx tsx --test src/tools/employee-capability-tools.test.ts
 * Capability wave 2 (2026-07-21): produce_document (template merge + real
 * files), file_query (deterministic retrieval), time_slots (interval algebra).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-capability2-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { mergeTemplate, renderMarkdown, htmlDocument } = await import('./document-produce-core.js');
const { registerDocumentProduceTools } = await import('./document-produce-tools.js');
const { chunkText, scoreChunks } = await import('./file-query-core.js');
const { registerFileQueryTools } = await import('./file-query-tools.js');
const { parseBusy, mergeIntervals, computeFreeSlots, registerTimeSlotsTools } = await import('./time-slots-tools.js');

test.after(() => rmSync(TMP, { recursive: true, force: true }));

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
function capture(register: (s: never, b?: never) => void, backends?: unknown): ToolHandler {
  let handler: ToolHandler | undefined;
  const fake = { tool: (_n: string, _d: string, _s: unknown, h: ToolHandler) => { handler = h; } };
  (register as (s: unknown, b?: unknown) => void)(fake, backends);
  return handler!;
}
const textOf = (r: { content: Array<{ text: string }> }): string => r.content[0].text;

// ── produce_document ─────────────────────────────────────────────────

test('template merge fills vars; an UNFILLED placeholder is a hard error (no letter ships with {{client_name}})', async () => {
  const merged = mergeTemplate('Dear {{client_name}}, your total is {{amount}}.', { client_name: 'Amy Chen', amount: '$1,200' });
  assert.equal(merged.content, 'Dear Amy Chen, your total is $1,200.');
  assert.deepEqual(merged.missing, []);

  const handler = capture(registerDocumentProduceTools as never);
  const out = await handler({ content: 'Dear {{client_name}},\n\nThanks.', format: 'html', template_vars: '{}' });
  assert.match(textOf(out), /unfilled template placeholder/);
  assert.match(textOf(out), /\{\{client_name\}\}/);
});

test('markdown renders the business subset: headings, lists, tables, emphasis; HTML output is a real staged file', async () => {
  const html = renderMarkdown('# Report\n\nSummary with **bold** and *italic*.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- one\n- two\n\n1. first');
  assert.match(html, /<h1>Report<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead>/);
  assert.match(html, /<ul>[\s\S]*<li>one<\/li>/);
  assert.match(html, /<ol>[\s\S]*<li>first<\/li>/);
  assert.match(htmlDocument('<p>x</p>', { title: 'T<t>' }), /<title>T&lt;t&gt;<\/title>/, 'title escaped');

  const handler = capture(registerDocumentProduceTools as never);
  const out = await handler({ content: '# Letter\n\nBody.', format: 'html', title: 'Letter' });
  const parsed = JSON.parse(textOf(out));
  assert.ok(existsSync(parsed.filePath));
  assert.match(readFileSync(parsed.filePath, 'utf-8'), /<h1>Letter<\/h1>/);
});

test('pdf/docx conversion routes through the backend and reports an honest fallback on failure', async () => {
  const calls: string[] = [];
  const handler = capture(registerDocumentProduceTools as never, {
    chromePdf: (htmlPath: string, pdfPath: string) => { calls.push('pdf'); writeFileSync(pdfPath, '%PDF-fake'); return { ok: true }; },
    textutilDocx: () => ({ ok: false, error: 'textutil unavailable in test' }),
  } as never);
  const pdfOut = JSON.parse(textOf(await handler({ content: '# Doc', format: 'pdf' })));
  assert.deepEqual(calls, ['pdf']);
  assert.ok(existsSync(pdfOut.filePath) && pdfOut.filePath.endsWith('.pdf'));
  const docxOut = textOf(await handler({ content: '# Doc', format: 'docx' }));
  assert.match(docxOut, /DOCX conversion failed/);
  assert.match(docxOut, /rendered HTML is at .*\.html/, 'fallback artifact offered, not a dead end');
});

// ── file_query ───────────────────────────────────────────────────────

test('chunking is heading-aware; retrieval finds the termination clause in a big document', () => {
  const doc = [
    '# Agreement',
    ...Array.from({ length: 60 }, (_, i) => `## Section ${i + 1}\n\nGeneric obligations paragraph ${i + 1} about deliverables and schedules and invoices.`),
    '## Section 61 — Termination\n\nEither party may terminate this agreement with thirty (30) days written notice. Termination fees are waived when notice is given before renewal.',
    ...Array.from({ length: 20 }, (_, i) => `## Section ${62 + i}\n\nMore boilerplate ${i}.`),
  ].join('\n\n');
  const chunks = chunkText(doc);
  assert.ok(chunks.length > 10, 'a big doc chunks into many pieces');
  const hits = scoreChunks(chunks, 'termination notice period', 3);
  assert.ok(hits.length > 0);
  assert.match(hits[0].text, /thirty \(30\) days written notice/, 'the right passage ranks first');
  assert.match(hits[0].heading ?? '', /Termination/, 'human-readable location attached');
});

test('file_query tool reads a text file and returns ranked passages; corrective on no match', async () => {
  const handler = capture(registerFileQueryTools as never);
  const file = path.join(TMP, 'contract.md');
  writeFileSync(file, '# Contract\n\n## Refunds\n\nRefunds are processed within 14 days of a written request.\n\n## Other\n\nNothing here.');
  const out = JSON.parse(textOf(await handler({ query: 'refund processing time', file })));
  assert.equal(out.hits[0].heading, 'Refunds');
  assert.match(out.hits[0].text, /14 days/);
  const miss = JSON.parse(textOf(await handler({ query: 'zebra migration', file })));
  assert.deepEqual(miss.hits, []);
  assert.match(miss.note, /lexical/);
});

// ── time_slots ───────────────────────────────────────────────────────

test('mutual availability: overlapping busy calendars leave exactly the true gaps', () => {
  // Tuesday 2026-07-21 (a weekday), local time.
  const day = '2026-07-21';
  const busy = parseBusy(JSON.stringify({
    amy: [{ start: `${day}T09:00:00`, end: `${day}T10:30:00` }, { start: `${day}T13:00:00`, end: `${day}T14:00:00` }],
    bo: [{ start: `${day}T10:00:00`, end: `${day}T11:00:00` }, { start: `${day}T15:30:00`, end: `${day}T17:00:00` }],
  }));
  assert.equal(mergeIntervals(busy).length, 3, '09:00-11:00 merges across attendees');
  const slots = computeFreeSlots({
    busy,
    windowStart: Date.parse(`${day}T00:00:00`),
    windowEnd: Date.parse(`${day}T23:59:00`),
    durationMs: 60 * 60_000,
    workStartMinutes: 9 * 60,
    workEndMinutes: 17 * 60,
    weekdaysOnly: true,
    maxSlots: 8,
  });
  const asLocal = slots.map((s) => [new Date(s.start).toTimeString().slice(0, 5), new Date(s.end).toTimeString().slice(0, 5)]);
  assert.deepEqual(asLocal, [['11:00', '13:00'], ['14:00', '15:30']], 'exact mutual gaps, nothing hallucinated');
});

test('weekends are skipped by default; too-short gaps never surface; the tool returns ISO slots', async () => {
  const handler = capture(registerTimeSlotsTools as never);
  const out = JSON.parse(textOf(await handler({
    busy: JSON.stringify([{ start: '2026-07-25T09:00:00', end: '2026-07-25T09:30:00' }]), // Saturday
    window_start: '2026-07-25T00:00:00',
    window_end: '2026-07-26T23:59:00', // Sat+Sun only
    duration_minutes: 30,
  })));
  assert.deepEqual(out.slots, [], 'weekend-only window with weekdays_only default → no slots');
  assert.match(out.note, /Widen the window/);

  const gaps = computeFreeSlots({
    busy: parseBusy(JSON.stringify([
      { start: '2026-07-21T09:00:00', end: '2026-07-21T12:45:00' },
      { start: '2026-07-21T13:00:00', end: '2026-07-21T17:00:00' },
    ])),
    windowStart: Date.parse('2026-07-21T00:00:00'),
    windowEnd: Date.parse('2026-07-21T23:59:00'),
    durationMs: 30 * 60_000,
    workStartMinutes: 9 * 60,
    workEndMinutes: 17 * 60,
    weekdaysOnly: true,
    maxSlots: 8,
  });
  assert.deepEqual(gaps, [], 'a 15-minute gap never surfaces for a 30-minute meeting');
});
