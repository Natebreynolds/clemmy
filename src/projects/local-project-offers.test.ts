/**
 * Run: node scripts/run-tests-isolated.mjs src/projects/local-project-offers.test.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-local-offers-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
after(() => rmSync(HOME, { recursive: true, force: true }));

const { describeLocalProjectOffers, localProjectOffers } = await import('./local-project-offers.js');

function folder(name: string, files: Record<string, string>): string {
  const root = path.join(HOME, name);
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), content, 'utf8');
  }
  mkdirSync(root, { recursive: true });
  return root;
}

test('a folder that says how it is worked in is read for names, in a stable order', () => {
  const root = folder('audits', {
    'AGENTS.md': '# how', 'CLAUDE.md': '# how',
    '.claude/commands/seo-audit.md': '# audit', '.claude/commands/build-brief.md': '# brief',
    '.claude/commands/notes.txt': 'not a command', '.claude/commands/bad name!.md': 'refused by its name',
    '.mcp.json': JSON.stringify({ mcpServers: {
      search: { command: 'npx', args: ['search-server'], env: { SEARCH_PASSWORD: 'fixture-secret-value' } },
      hosting: { command: 'npx' }, 'bad name!': {},
    } }),
  });
  const offers = localProjectOffers(root);
  assert.deepEqual(offers.instructions, ['AGENTS.md', 'CLAUDE.md']);
  assert.deepEqual(offers.commands, [
    { name: 'build-brief', file: '.claude/commands/build-brief.md' },
    { name: 'seo-audit', file: '.claude/commands/seo-audit.md' },
  ]);
  assert.deepEqual(offers.toolServers, ['hosting', 'search']);
  const text = describeLocalProjectOffers(offers).join('\n');
  assert.match(text, /its own instructions, to read before working in it: AGENTS\.md, CLAUDE\.md/);
  assert.match(text, /build-brief \(\.claude\/commands\/build-brief\.md\), seo-audit/);
  assert.match(text, /tool servers it declares: hosting, search\. Declared is not connected/);
  assert.ok(!/fixture-secret-value|SEARCH_PASSWORD|npx|search-server/.test(JSON.stringify(offers) + text),
    'a declared server gives its name and nothing else');
});

test('a folder that says nothing, a missing folder and a broken declaration offer nothing', () => {
  assert.deepEqual(localProjectOffers(folder('plain', { 'README.md': 'x' })), { instructions: [], commands: [], toolServers: [] });
  assert.deepEqual(describeLocalProjectOffers(localProjectOffers(path.join(HOME, 'plain'))), []);
  for (const missing of [null, undefined, '', 'relative/folder', path.join(HOME, 'not-there')]) {
    assert.deepEqual(localProjectOffers(missing), { instructions: [], commands: [], toolServers: [] });
  }
  for (const [name, declaration] of [
    ['broken', '{ not json'], ['list', '[]'], ['no-key', '{"servers":{"a":{}}}'], ['wrong-kind', '{"mcpServers":["a"]}'],
    ['huge', JSON.stringify({ mcpServers: { a: { env: { PAD: 'x'.repeat(300_000) } } } })],
  ] as const) {
    assert.deepEqual(localProjectOffers(folder(name, { '.mcp.json': declaration })).toolServers, [], name);
  }
  assert.deepEqual(localProjectOffers(folder('a-directory-named-like-instructions', { 'AGENTS.md/inside.txt': 'x' })).instructions, []);
});

test('a folder with very many commands is read up to a limit', () => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 60; index += 1) files[`.claude/commands/c${String(index).padStart(2, '0')}.md`] = '#';
  const offers = localProjectOffers(folder('many', files));
  assert.equal(offers.commands.length, 40);
  assert.equal(offers.commands[0]!.name, 'c00');
});
