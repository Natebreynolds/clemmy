/**
 * Run: npx tsx --test src/integrations/cli-catalog/connected-cli-coverage.test.ts
 *
 * A connected, signed-in CLI reaches its vendor's app now: discovery finds the
 * command runner for that vendor, and the app is not reported as missing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-cli-coverage-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { CLI_CATALOG, recordConnectedCli } = await import('./catalog.js');
const { connectedCliCoveringApp, connectedCliRunnerText, usableConnectedClis } = await import('./connected-cli-coverage.js');
const { runsLocalCommandLines } = await import('../../tools/tool-registry.js');
const { catalogEntries, rankCatalogEntriesLexically } = await import('../../agents/tool-catalog.js');

function writeHealth(entries: Record<string, { command: string; authStatus: string; username?: string; installed?: boolean }>): void {
  const now = new Date().toISOString();
  writeFileSync(path.join(TMP_HOME, 'state', 'cli-auth-health.json'), JSON.stringify({
    version: 'v1',
    entries: Object.fromEntries(Object.entries(entries).map(([id, row]) => [id, {
      id, installed: row.installed ?? true, checkedAt: now, ...row,
    }])),
  }));
}

for (const id of ['github', 'railway']) {
  recordConnectedCli(CLI_CATALOG.find((entry) => entry.id === id)!);
}

test('a connected, signed-in CLI covers its vendor app by id, vendor or command', () => {
  writeHealth({
    github: { command: 'gh', authStatus: 'ok', username: 'owner-fixture' },
    railway: { command: 'railway', authStatus: 'ok', username: 'owner@fixture.test' },
  });
  assert.equal(connectedCliCoveringApp('github')?.command, 'gh');
  assert.equal(connectedCliCoveringApp('GitHub')?.command, 'gh');
  assert.equal(connectedCliCoveringApp('gh')?.command, 'gh');
  assert.equal(connectedCliCoveringApp('railway')?.command, 'railway');
  assert.equal(connectedCliCoveringApp('gitlab'), null);
  // Search aliases are not identities: a generic tag never covers an app.
  assert.equal(connectedCliCoveringApp('deploy'), null);
});

test('a CLI whose last probe found it signed out covers nothing', () => {
  writeHealth({
    github: { command: 'gh', authStatus: 'signed_out' },
    railway: { command: 'railway', authStatus: 'ok' },
  });
  assert.equal(connectedCliCoveringApp('github'), null);
  assert.deepEqual(usableConnectedClis().map((cli) => cli.command), ['railway']);
});

test('discovery naming the vendor finds the command runner and says which command to use', () => {
  writeHealth({
    github: { command: 'gh', authStatus: 'ok', username: 'owner-fixture' },
    railway: { command: 'railway', authStatus: 'ok' },
  });
  const text = connectedCliRunnerText();
  assert.match(text, /`gh` \(GitHub CLI, GitHub, signed in as owner-fixture\)/);
  assert.match(text, /`railway` \(Railway CLI, Railway\)/);
  const entries = catalogEntries().map((entry) => ({
    ...entry,
    oneLiner: runsLocalCommandLines(entry.name) ? `${entry.oneLiner}\n${text}` : entry.oneLiner,
  }));
  const runner = entries.find((entry) => runsLocalCommandLines(entry.name));
  assert.ok(runner, 'the registry declares one local command runner');
  const ranked = rankCatalogEntriesLexically('Find the website repository on GitHub and its Railway deployment', entries);
  assert.equal(ranked.sort((a, b) => b.score - a.score)[0]?.name, runner!.name);
});

test('no connected CLI leaves the runner unchanged', () => {
  writeFileSync(path.join(TMP_HOME, 'state', 'connected-clis.json'), JSON.stringify({ version: 'v1', entries: {} }));
  assert.equal(connectedCliRunnerText(), '');
  assert.equal(connectedCliCoveringApp('github'), null);
});
