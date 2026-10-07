import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { htmlToPortableDocx } from './document-docx.js';
import { htmlDocument, renderMarkdown } from './document-produce-core.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-docx-portability-'));
process.env.CLEMENTINE_HOME = home;
const { registerDocumentProduceTools } = await import('./document-produce-tools.js');
test.after(() => rmSync(home, { recursive: true, force: true }));

// Independent existing archive reader; it is not used by the production writer.
const AdmZip = createRequire(import.meta.url)('adm-zip') as new (bytes: Buffer) => {
  test(): boolean; getEntries(): Array<{ entryName: string }>; readAsText(name: string): string;
};
const fixture = '# Report café 日本語 🐕\n\nSummary with **bold**, *italic*, `code` and [link](https://example.test/doc?a=1&b=2).\n\n| Name | Count |\n| --- | --- |\n| Alpha | 2 |\n\n- first bullet\n- second bullet\n\n1. numbered first\n2. numbered second\n\n> quoted text\n\n```\nline one\nline two\n```';

test('portable DOCX is a valid Office package with text, tables, styles, numbering and safe link relationships', () => {
  const bytes = htmlToPortableDocx(htmlDocument(renderMarkdown(fixture)));
  const zip = new AdmZip(bytes);
  assert.equal(zip.test(), true, 'an independent ZIP reader verifies every entry CRC');
  assert.deepEqual(zip.getEntries().map(e => e.entryName).sort(), ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels'].sort());
  const body = zip.readAsText('word/document.xml');
  assert.match(body, /Report café 日本語 🐕/);
  assert.match(body, /<w:pStyle w:val="Heading1"/);
  assert.match(body, /<w:b\/>/); assert.match(body, /<w:i\/>/);
  assert.match(body, /<w:tbl>/); assert.match(body, /Alpha/); assert.match(body, /<w:numPr>/);
  assert.match(body, /line one[\s\S]*<w:br\/>[\s\S]*line two/);
  assert.match(zip.readAsText('word/_rels/document.xml.rels'), /Target="https:\/\/example\.test\/doc\?a=1&amp;b=2"/);
  assert.match(zip.readAsText('word/numbering.xml'), /w:numFmt w:val="bullet"/);
  assert.match(zip.readAsText('word/numbering.xml'), /w:numFmt w:val="decimal"/);
  assert.deepEqual(htmlToPortableDocx(htmlDocument(renderMarkdown(fixture))), bytes, 'identical documents have identical package bytes');
});

test('portable DOCX preserves decoded entities and XML-sensitive text without an active document payload', () => {
  const zip = new AdmZip(htmlToPortableDocx(htmlDocument('<h2>A &amp; B</h2><p>&lt;script&gt; &quot;quoted&quot; &apos; apostrophe</p>')));
  const xml = zip.readAsText('word/document.xml');
  assert.match(xml, /A &amp; B/); assert.match(xml, /&lt;script&gt; &quot;quoted&quot; &apos; apostrophe/);
  assert.doesNotMatch(xml, /<script>/);
  assert.throws(() => htmlToPortableDocx('<p>invalid\u0001</p>'), /XML cannot represent/);
});

test('multi-paragraph and nested list items keep one item number and retain all text', () => {
  const zip = new AdmZip(htmlToPortableDocx('<ol><li><p>First</p><p>Continuation</p><ul><li>Nested</li></ul></li><li>Second</li></ol>'));
  const body = zip.readAsText('word/document.xml');
  assert.equal((body.match(/<w:numPr>/g) ?? []).length, 3, 'continuation paragraphs are not separate numbered items');
  for (const text of ['First', 'Continuation', 'Nested', 'Second']) assert.match(body, new RegExp(text));
  assert.match(body, /<w:ilvl w:val="1"/);
  for (const unsupported of ['<ol reversed><li>Reverse</li></ol>', '<ol type="a"><li>Letter</li></ol>', '<ul>Unlisted text<li>Listed</li></ul>']) {
    assert.throws(() => htmlToPortableDocx(unsupported), /DOCX/);
  }
});

test('unsupported media, CSS layout, unsafe links and ambiguous table structures refuse rather than report a degraded success', () => {
  for (const html of ['<p><img src="https://example.test/private.png"></p>', '<script>anything()</script>', '<p style="position:absolute">Layout</p>', '<a href="javascript:alert(1)">Unsafe</a>', '<table><tr><td colspan="2">Merged</td></tr></table>', '<table><tr><td><div><table><tr><td>Nested</td></tr></table></div></td></tr></table>']) {
    assert.throws(() => htmlToPortableDocx(htmlDocument(html)), /DOCX/);
  }
  assert.throws(() => htmlToPortableDocx('<p>' + 'x'.repeat(8 * 1024 * 1024) + '</p>'), /document limit/);
});

test('block content wrapped by inline markup refuses instead of silently joining paragraphs', () => {
  for (const html of [
    '<a href="https://example.test"><p>Alpha</p><p>Beta</p></a>',
    '<pre><div>Alpha</div><div>Beta</div></pre>',
  ]) assert.throws(() => htmlToPortableDocx(html), /cannot flatten block content.*HTML or PDF/);
  const body = new AdmZip(htmlToPortableDocx('<p><a href="https://example.test">Alpha</a></p><p>Beta</p>')).readAsText('word/document.xml');
  assert.equal((body.match(/<w:p>/g) ?? []).length, 2);
});

test('portable DOCX opens through the Mac native document reader with exact Unicode and table text', { skip: process.platform !== 'darwin' }, () => {
  const target = path.join(home, 'portable café report.docx');
  writeFileSync(target, htmlToPortableDocx(htmlDocument(renderMarkdown(fixture))));
  const result = spawnSync('/usr/bin/textutil', ['-convert', 'txt', '-stdout', target], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Report café 日本語 🐕/);
  assert.match(result.stdout, /Alpha/); assert.match(result.stdout, /second bullet/); assert.match(result.stdout, /line two/);
});

function tool(): (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> {
  let handler: ((args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>) | undefined;
  const server = { tool: (_name: string, _description: string, _schema: unknown, execute: typeof handler) => { handler = execute; } };
  registerDocumentProduceTools(server as never);
  return handler!;
}

test('non-Mac produce_document writes offline DOCX and keeps unsupported HTML as an honest fallback', { skip: process.platform === 'darwin' }, async () => {
  const handler = tool();
  const success = await handler({ content: fixture, format: 'docx', output_name: 'offline report' });
  const result = JSON.parse(success.content[0].text);
  assert.equal(result.format, 'docx'); assert.equal(existsSync(result.filePath), true);
  assert.equal(new AdmZip(readFileSync(result.filePath)).test(), true);
  assert.match(result.rendering_note, /standard document formatting/);
  const fallback = await handler({ content: '<img src="https://example.test/image.png">', content_type: 'html', format: 'docx', output_name: 'unsupported' });
  assert.match(fallback.content[0].text, /conversion failed/);
  assert.match(fallback.content[0].text, /rendered HTML/);
  assert.equal(readdirSync(path.join(home, 'files', 'documents')).filter(name => name.endsWith('.docx')).length, 1, 'refused content cannot leave a claimed DOCX artifact');
});
