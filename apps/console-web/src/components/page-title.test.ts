import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('a page is named once: the top bar, never again as a heading or a rail title', () => {
  const page = read('./Page.tsx');
  const shell = read('./AppShell.tsx');
  // The shell hands its title to every page; a Page title that repeats it is
  // not rendered (its subtitle and actions still are).
  assert.match(shell, /<ShellTitleContext\.Provider value=\{title\}>/);
  assert.match(page, /const heading = title && title !== shellTitle \? title : undefined;/);
  assert.match(page, /\{heading && <h2/);
  // Section rails index the page; they do not title it a second time.
  for (const [file, name] of [['../screens/Settings.tsx', 'Settings'], ['../screens/Advanced.tsx', 'Advanced']] as const) {
    assert.doesNotMatch(read(file), new RegExp(`>${name}</h1>`), `${file} repeats "${name}"`);
  }
});
