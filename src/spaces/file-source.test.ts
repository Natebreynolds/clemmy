/**
 * Run: node scripts/run-tests-isolated.mjs src/spaces/file-source.test.ts
 *
 * A Workspace source can be a local file the host reads on every refresh,
 * with no model and no process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-file-source-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { parseDelimitedRows, readWorkspaceFileSource } = await import('./file-source.js');
const spaces = await import('./store.js');
const { refreshSpaceData } = await import('./runner.js');

const FIXTURES = mkdtempSync(path.join(os.tmpdir(), 'clem-file-source-data-'));

test('CSV rows keep quoted commas, quotes and line breaks, across CRLF and a BOM', () => {
  const rows = parseDelimitedRows('﻿title,price\r\n"Sapiens: A Brief History, Vol 1",£54.23\r\n"He said ""hi""\nthen left",£1\r\n\r\n', ',');
  assert.deepEqual(rows, [['title', 'price'], ['Sapiens: A Brief History, Vol 1', '£54.23'], ['He said "hi"\nthen left', '£1']]);
});

test('a CSV becomes rows keyed by its header, JSON its document, other text { text }', () => {
  const csv = path.join(FIXTURES, 'books.csv');
  writeFileSync(csv, 'title,price,star_rating\nA Light in the Attic,£51.77,Three\nSoumission,£50.10,One\n');
  assert.deepEqual(readWorkspaceFileSource('books', csv), { ok: true, data: [
    { title: 'A Light in the Attic', price: '£51.77', star_rating: 'Three' },
    { title: 'Soumission', price: '£50.10', star_rating: 'One' },
  ] });
  const json = path.join(FIXTURES, 'stats.json');
  writeFileSync(json, '{"count":2}');
  assert.deepEqual(readWorkspaceFileSource('stats', json), { ok: true, data: { count: 2 } });
  const notes = path.join(FIXTURES, 'notes.md');
  writeFileSync(notes, '# Notes');
  assert.deepEqual(readWorkspaceFileSource('notes', notes), { ok: true, data: { text: '# Notes' } });
});

test('credentials, Clementine state, relative paths and missing files are refused with a reason', () => {
  const secret = path.join(FIXTURES, '.env');
  writeFileSync(secret, 'TOKEN=x');
  const refused = readWorkspaceFileSource('env', secret);
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.error, /credentials or Clementine's own state/);
  const internal = path.join(TMP_HOME, 'state', 'harness-notes.json');
  writeFileSync(internal, '{}');
  assert.equal(readWorkspaceFileSource('internal', internal).ok, false);
  const relative = readWorkspaceFileSource('rel', 'books.csv');
  assert.match(relative.ok ? '' : relative.error, /absolute or ~\/ path/);
  const missing = readWorkspaceFileSource('gone', path.join(FIXTURES, 'gone.csv'));
  assert.equal(missing.ok ? '' : missing.code, 'provider_error');
});

test('a refresh reads the file into the Space with no model, and picks up a change to the file', async () => {
  const csv = path.join(FIXTURES, 'shelf.csv');
  writeFileSync(csv, 'title,price\nThirst,£17.27\n');
  spaces.spaceStore.save({
    id: 'framework-test-file-shelf',
    title: 'FRAMEWORK-TEST file shelf',
    status: 'active',
    viewEntry: 'view/index.html',
    viewContent: '<!doctype html><title>Shelf</title>',
    dataSources: [{ id: 'books', filePath: csv }],
    actions: [],
  });
  const first = await refreshSpaceData('framework-test-file-shelf');
  assert.equal(first[0]?.ok, true, JSON.stringify(first));
  const read = () => (JSON.parse(readFileSync(spaces.resolveInSpace('framework-test-file-shelf', 'data.json'), 'utf8')) as Record<string, unknown>).books;
  assert.deepEqual(read(), [{ title: 'Thirst', price: '£17.27' }]);
  writeFileSync(csv, 'title,price\nThirst,£17.27\nSet Me Free,£17.46\n');
  const second = await refreshSpaceData('framework-test-file-shelf');
  assert.equal(second[0]?.ok, true, JSON.stringify(second));
  assert.equal((read() as unknown[]).length, 2);
});

test('space_save accepts a file source end to end and the Space holds the file rows', async () => {
  // The store-level test missed the save path's own declaration check (live
  // 2026-10-17: "declares nothing to read" eleven times in one build).
  const { registerSpaceTools } = await import('../tools/space-tools.js');
  type Handler = (input: Record<string, unknown>) => Promise<unknown>;
  const handlers: Record<string, Handler> = {};
  registerSpaceTools({ tool(name: string, _d: string, _p: unknown, h: Handler) { handlers[name] = h; } } as never);
  const csv = path.join(FIXTURES, 'saved-shelf.csv');
  writeFileSync(csv, 'title,price,star_rating\nThirst,£17.27,Five\nSoumission,£50.10,One\n');
  const result = await handlers.space_save!({
    slug: 'framework-test-file-saved-shelf',
    title: 'FRAMEWORK-TEST file saved shelf',
    view_html: '<!doctype html><html><body><div class="clem-app" id="app"></div><script>async function render(){const d=await clem.data();document.getElementById("app").textContent=(d.books||[]).length+" books";}clem.onData(render);render();</script></body></html>',
    data_sources: [{ id: 'books', file_path: csv }],
  });
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '';
  assert.doesNotMatch(text, /NOT saved|declares nothing to read/, text.slice(0, 600));
  assert.equal(spaces.spaceStore.get('framework-test-file-saved-shelf')?.dataSources[0]?.filePath, csv);
  const refreshed = await refreshSpaceData('framework-test-file-saved-shelf', 'books', { allowPaused: true });
  assert.equal(refreshed[0]?.ok, true, JSON.stringify(refreshed));
  const data = JSON.parse(readFileSync(spaces.resolveInSpace('framework-test-file-saved-shelf', 'data.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(data.books, [{ title: 'Thirst', price: '£17.27', star_rating: 'Five' }, { title: 'Soumission', price: '£50.10', star_rating: 'One' }]);
});

test('a refresh that landed returns the host file commit receipt for the Space dataset, so the review can verify it', async () => {
  // Live 10-20: "Refresh my R45 nine space" ended "needs a look" with
  // completion_review_artifact_drift although the review passed — the settled
  // refresh owed a file receipt it never produced.
  const { registerSpaceTools } = await import('../tools/space-tools.js');
  const { parseHostLocalWriteCommitFacts } = await import('../runtime/harness/host-local-write-commit.js');
  const { createHash } = await import('node:crypto');
  type Handler = (input: Record<string, unknown>) => Promise<unknown>;
  const handlers: Record<string, Handler> = {};
  registerSpaceTools({ tool(name: string, _d: string, _p: unknown, h: Handler) { handlers[name] = h; } } as never);
  const slug = 'framework-test-file-refresh-receipt';
  const csv = path.join(FIXTURES, 'refresh-receipt.csv');
  writeFileSync(csv, 'title,price\nThirst,£17.27\n');
  const saved = await handlers.space_save!({
    slug,
    title: 'FRAMEWORK-TEST refresh receipt',
    view_html: '<!doctype html><html><body><div class="clem-app" id="app"></div><script>async function render(){const d=await clem.data();document.getElementById("app").textContent=(d.books||[]).length+" books";}clem.onData(render);render();</script></body></html>',
    data_sources: [{ id: 'books', file_path: csv }],
  });
  const savedText = (saved as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '';
  assert.doesNotMatch(savedText, /NOT saved|declares nothing to read|Error/, savedText.slice(0, 400));
  writeFileSync(csv, 'title,price\nThirst,£17.27\nSoumission,£50.10\n');
  const out = (await handlers.space_refresh!({ slug, source_id: 'books' }) as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '';
  const facts = parseHostLocalWriteCommitFacts(out);
  assert.ok(facts, out.slice(0, 300));
  assert.equal(facts!.createdId, slug);
  assert.match(facts!.handle, /framework-test-file-refresh-receipt\/data\.json$/);
  const current = createHash('sha256').update(readFileSync(spaces.resolveInSpace(slug, 'data.json'))).digest('hex');
  assert.equal(facts!.contentDigest, current, 'the receipt names the dataset as it is now');
  assert.match(out, /Refreshed "framework-test-file-refresh-receipt"/);
  assert.match(out, /books: ok \(2 rows\)/);

  // Nothing landed: no receipt, the plain report as before.
  const { unlinkSync } = await import('node:fs');
  unlinkSync(csv);
  const failed = (await handlers.space_refresh!({ slug, source_id: 'books' }) as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '';
  assert.equal(parseHostLocalWriteCommitFacts(failed), null);
  assert.match(failed, /Refresh failed for/);
});
