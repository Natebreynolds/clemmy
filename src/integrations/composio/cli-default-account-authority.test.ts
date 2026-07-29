/**
 * Run: npx tsx --test src/integrations/composio/cli-default-account-authority.test.ts
 *
 * Durable operator authority for the Composio CLI's provider-side default
 * account. A grant is toolkit-scoped and generation-bound: changing or
 * revoking it invalidates every older approval snapshot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-cli-default-authority-'));
process.env.CLEMENTINE_HOME = TEST_HOME;

const {
  grantComposioCliDefaultAccountAuthority,
  getComposioCliDefaultAccountAuthority,
  listComposioCliDefaultAccountAuthorities,
  revokeComposioCliDefaultAccountAuthority,
  verifyComposioCliDefaultAccountAuthority,
} = await import('./cli-default-account-authority.js');

test.after(() => rmSync(TEST_HOME, { recursive: true, force: true }));

test('operator grant is durable, toolkit-scoped, and never acts as a connected-account selector', async () => {
  const grant = await grantComposioCliDefaultAccountAuthority({
    toolkit: 'instagram',
    label: 'Brand account currently selected by the Composio CLI',
    grantedBy: 'console',
  });

  assert.equal(grant.kind, 'composio_cli_default_account');
  assert.equal(grant.toolkit, 'instagram');
  assert.equal(grant.label, 'Brand account currently selected by the Composio CLI');
  assert.ok(grant.grantId);
  assert.equal('connectedAccountId' in grant, false);
  assert.deepEqual(getComposioCliDefaultAccountAuthority('instagram'), grant);
  assert.deepEqual(listComposioCliDefaultAccountAuthorities(), [grant]);
  assert.equal(verifyComposioCliDefaultAccountAuthority(grant).ok, true);
  assert.equal(getComposioCliDefaultAccountAuthority('gmail'), null);
});

test('authority change and revocation invalidate older snapshots', async () => {
  const first = await grantComposioCliDefaultAccountAuthority({
    toolkit: 'linkedin',
    label: 'Company page A',
    grantedBy: 'console',
  });
  const changed = await grantComposioCliDefaultAccountAuthority({
    toolkit: 'linkedin',
    label: 'Company page B',
    grantedBy: 'console',
  });

  assert.notEqual(changed.grantId, first.grantId, 'an operator change rotates the authority generation');
  assert.equal(verifyComposioCliDefaultAccountAuthority(first).ok, false);
  assert.equal(verifyComposioCliDefaultAccountAuthority(changed).ok, true);

  assert.equal(await revokeComposioCliDefaultAccountAuthority('linkedin'), true);
  assert.equal(verifyComposioCliDefaultAccountAuthority(changed).ok, false);
  assert.equal(getComposioCliDefaultAccountAuthority('linkedin'), null);
});

test('wildcards, malformed toolkit slugs, and empty labels cannot create broad hidden authority', async () => {
  await assert.rejects(
    () => grantComposioCliDefaultAccountAuthority({
      toolkit: '*',
      label: 'all accounts',
      grantedBy: 'console',
    }),
    /toolkit/i,
  );
  await assert.rejects(
    () => grantComposioCliDefaultAccountAuthority({
      toolkit: 'instagram,linkedin',
      label: 'two accounts',
      grantedBy: 'console',
    }),
    /toolkit/i,
  );
  await assert.rejects(
    () => grantComposioCliDefaultAccountAuthority({
      toolkit: 'instagram',
      label: ' ',
      grantedBy: 'console',
    }),
    /label/i,
  );
});
