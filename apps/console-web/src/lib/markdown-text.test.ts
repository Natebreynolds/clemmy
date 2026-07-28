/** Run: npx tsx --test apps/console-web/src/lib/markdown-text.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripInlineMarkdown } from './markdown-text.js';

test('the live banner leak renders calm: bold, links, backticks, long URLs', () => {
  const raw = 'Both branches complete; no blockers. – **Google Sheet:** [Open sheet](https://docs.google.com/spreadsheets/d/14MvZU-hdrclTRKQxNUTaC6C4jHg2YYXvbrqVvXzmKP8/edit) **ID:** `14MvZU-hdrclTRKQxNUTaC6C4jHg2YYXvbrqVvXzmKP8`';
  const out = stripInlineMarkdown(raw);
  assert.ok(!out.includes('**'), 'no bold markers');
  assert.ok(!out.includes('`'), 'no backticks');
  assert.ok(!out.includes(']('), 'no raw link syntax');
  assert.match(out, /Google Sheet: Open sheet/);
});

test('headings, italics, newlines, and bare long URLs read as one calm line', () => {
  const out = stripInlineMarkdown('## Summary\nSee *this* and https://clementine-rc-48da4d1e-1785191709149.netlify.app now');
  assert.equal(out, 'Summary · See this and clementine-rc-48da4d1e-1785191709149.netlify.app now');
});

test('a truncated preview with an UNCLOSED bold marker still comes out clean', () => {
  // Live leak: the server truncates previews before any client strip runs.
  assert.equal(
    stripInlineMarkdown('HTTP status: 200 - **Resp…'),
    'HTTP status: 200 - Resp…',
  );
});

test('plain text and empty input pass through unchanged', () => {
  assert.equal(stripInlineMarkdown('Ship the Friday scorecard.'), 'Ship the Friday scorecard.');
  assert.equal(stripInlineMarkdown(''), '');
  // Short URLs stay clickable-looking; only walls of URL get shortened.
  assert.equal(stripInlineMarkdown('see https://x.io/a'), 'see https://x.io/a');
});
