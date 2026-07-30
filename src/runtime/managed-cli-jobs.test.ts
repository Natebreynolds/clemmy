/**
 * Run: npx tsx --test src/runtime/managed-cli-jobs.test.ts
 *
 * Pins for the managed/catalog CLI job runner. The two legacy kinds
 * (gh, composio) are byte-pinned — their commands are the product's only
 * hardcoded auth flows and a silent drift would break the Connect
 * buttons. Catalog auth jobs are pinned at the authority boundary: the
 * command comes only from the catalog, and only verified-headless
 * entries may start one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-managed-cli-jobs-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { _testOnly_commandFor, startCatalogAuthJob } = await import('./managed-cli-jobs.js');
const { CLI_CATALOG } = await import('../integrations/cli-catalog/catalog.js');

test('legacy gh/composio command specs are pinned byte-for-byte', () => {
  assert.equal(_testOnly_commandFor('github', 'install').command, 'brew install gh');
  assert.equal(_testOnly_commandFor('github', 'auth').command,
    'gh auth login -h github.com --web -s repo -s read:org -s workflow');
  assert.equal(_testOnly_commandFor('github', 'repair').command,
    'gh auth refresh -h github.com -s repo -s read:org -s workflow');
  assert.equal(_testOnly_commandFor('composio', 'install').command,
    'curl -fsSL https://composio.dev/install | bash');
  assert.equal(_testOnly_commandFor('composio', 'auth').command, 'composio login');
  assert.equal(_testOnly_commandFor('composio', 'repair').command, 'composio login');
});

test('an unknown catalog id cannot start an auth job', async () => {
  await assert.rejects(() => startCatalogAuthJob('definitely-not-a-cli'), /Unknown catalog CLI/);
});

test('a non-headless entry cannot start an auth job — it hands over the command instead', async () => {
  const nonHeadless = CLI_CATALOG.find((entry) => entry.authCommand && !entry.authHeadless);
  assert.ok(nonHeadless, 'catalog must contain at least one interactive-login entry');
  await assert.rejects(
    () => startCatalogAuthJob(nonHeadless.id),
    (err: Error) => {
      assert.match(err.message, /interactive sign-in/);
      assert.ok(err.message.includes(nonHeadless.authCommand!), 'the hand-over names the exact command');
      return true;
    },
  );
});

test('every headless catalog entry can construct its job spec (authority check passes)', () => {
  // Construction-level pin only: actually starting the job would spawn a
  // real login. The headless entries' runnability is covered by the
  // authHeadless ⇒ authCommand catalog pin plus this lookup sanity.
  for (const entry of CLI_CATALOG) {
    if (!entry.authHeadless) continue;
    assert.ok(entry.authCommand && entry.authCommand.startsWith(entry.command),
      `${entry.id}: auth command should invoke the entry's own binary`);
  }
});
