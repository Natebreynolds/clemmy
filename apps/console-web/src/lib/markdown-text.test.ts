/** Run: npx tsx --test apps/console-web/src/lib/markdown-text.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripInlineMarkdown } from './markdown-text.js';

test('the live banner leak renders calm: bold, links, backticks, long URLs', () => {
  const raw = 'Both branches complete; no blockers. – **Google Sheet:** [Open sheet](https://sheets.example.test/workbooks/synthetic-sheet-fixture/edit) **ID:** `synthetic-sheet-fixture`';
  const out = stripInlineMarkdown(raw);
  assert.ok(!out.includes('**'), 'no bold markers');
  assert.ok(!out.includes('`'), 'no backticks');
  assert.ok(!out.includes(']('), 'no raw link syntax');
  assert.match(out, /Google Sheet: Open sheet/);
});

test('headings, italics, newlines, and bare long URLs read as one calm line', () => {
  const out = stripInlineMarkdown('## Summary\nSee *this* and https://workspace-preview.example.test/builds/synthetic-fixture now');
  assert.equal(out, 'Summary · See this and workspace-preview.example.test now');
});

test('a truncated preview with an UNCLOSED bold marker still comes out clean', () => {
  // Live leak: the server truncates previews before any client strip runs.
  assert.equal(
    stripInlineMarkdown('HTTP status: 200 - **Resp…'),
    'HTTP status: 200 - Resp…',
  );
});

test('a truncated preview with an UNCLOSED link still comes out clean', () => {
  // Live leak (2026-07-30): the focus store clamps titles by raw character
  // count, so a markdown link can arrive cut mid-URL. The complete-pair regex
  // can never match it, and the raw syntax reached the Working Together card.
  assert.equal(
    stripInlineMarkdown('All three pieces are live. Sheet — [Platform 4.9 — Slack Channel Review](https://docs.google'),
    'All three pieces are live. Sheet — Platform 4.9 — Slack Channel Review',
  );
  // Cut even earlier: inside the label, before the closing bracket.
  assert.equal(
    stripInlineMarkdown('Sheet — [Platform 4.9 — Slack Chan'),
    'Sheet — Platform 4.9 — Slack Chan',
  );
});

test('plain text and empty input pass through unchanged', () => {
  assert.equal(stripInlineMarkdown('Ship the Friday scorecard.'), 'Ship the Friday scorecard.');
  assert.equal(stripInlineMarkdown(''), '');
  // Short URLs stay clickable-looking; only walls of URL get shortened.
  assert.equal(stripInlineMarkdown('see https://x.io/a'), 'see https://x.io/a');
});
