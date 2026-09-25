import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from './markdown.js';

test('a pipe table renders as a table inside its own scroller, with alignment', () => {
  const html = renderMarkdown([
    'Five accounts went quiet:',
    '',
    '| Firm | Owner | Quiet for |',
    '| --- | :---: | ---: |',
    '| Pine **Street** | Dana | 34 days |',
    '| North | Priya | 32 days |',
    '',
    'Want me to send them?',
  ].join('\n'));
  assert.match(html, /^<p>Five accounts went quiet:<\/p><div class="md-table"><table><thead><tr><th>Firm<\/th><th class="al-c">Owner<\/th><th class="al-r">Quiet for<\/th><\/tr><\/thead>/);
  assert.match(html, /<td>Pine <strong>Street<\/strong><\/td><td class="al-c">Dana<\/td><td class="al-r">34 days<\/td>/);
  assert.match(html, /<\/table><\/div><p>Want me to send them\?<\/p>$/);
});

test('a short row is padded and an escaped pipe stays inside its cell', () => {
  const html = renderMarkdown('| a | b |\n|---|---|\n| x \\| y |\n');
  assert.match(html, /<td>x \| y<\/td><td><\/td>/);
});

test('a line with a pipe but no rule under it is prose, not a table', () => {
  assert.equal(renderMarkdown('this | that'), '<p>this | that</p>');
});

test('bare links become links and leave sentence punctuation outside', () => {
  const html = renderMarkdown('See https://example.com/a?x=1&y=2. Or (https://example.org/wiki_(x)).');
  assert.match(html, /<a href="https:\/\/example\.com\/a\?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">https:\/\/example\.com\/a\?x=1&amp;y=2<\/a>\./);
  assert.match(html, /<a href="https:\/\/example\.org\/wiki_\(x\)"[^>]*>https:\/\/example\.org\/wiki_\(x\)<\/a>\)\./);
});

test('a written link is linked once, and a URL inside code stays code', () => {
  const html = renderMarkdown('[the report](https://example.com/r) and `https://example.com/raw`');
  assert.equal((html.match(/<a /g) ?? []).length, 1);
  assert.match(html, /<code>https:\/\/example\.com\/raw<\/code>/);
});

test('bold around a bare link does not leak into the href', () => {
  const html = renderMarkdown('**https://example.com/x**');
  assert.match(html, /<strong><a href="https:\/\/example\.com\/x"/);
});

test('markup in a reply is escaped, including inside table cells', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>\n\n| a |\n|---|\n| <script>x</script> |');
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;script&gt;/);
});

test('the phone Workspace route is linked only where the surface serves it', () => {
  const md = '[Open it](/m/?tab=spaces&workspace=daily-brief)';
  assert.match(renderMarkdown(md), /<a href="\/m\/\?tab=spaces&amp;workspace=daily-brief">Open it<\/a>/);
  assert.doesNotMatch(renderMarkdown(md, { workspaceLinks: false }), /<a /);
});
