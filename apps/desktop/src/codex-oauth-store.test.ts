import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  CODEX_GRANT_PROVENANCE,
  loadClementineOwnedCodexOAuthTokens,
  persistClementineOwnedCodexOAuthTokens,
  resolveClementineCodexAuthPaths,
} from './codex-oauth-store.js';

function makeHome(t: TestContext): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clementine-codex-oauth-store-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value), 'utf-8');
}

test('desktop Codex auth paths honor CLEMENTINE_HOME and match the daemon state layout', () => {
  const customBase = path.join(os.tmpdir(), 'clem-custom');
  const ignoredHome = path.join(os.tmpdir(), 'ignored-home');
  const custom = resolveClementineCodexAuthPaths(customBase, ignoredHome);
  assert.deepEqual(custom, {
    baseDir: customBase,
    stateDir: path.join(customBase, 'state'),
    authFile: path.join(customBase, 'state', 'auth.json'),
    authDeadFile: path.join(customBase, 'state', 'codex-auth-dead.json'),
  });

  const userHome = path.join(os.tmpdir(), 'example-user');
  const fallback = resolveClementineCodexAuthPaths('', userHome);
  assert.equal(fallback.baseDir, path.join(userHome, '.clementine-next'));
  assert.equal(fallback.authFile, path.join(userHome, '.clementine-next', 'state', 'auth.json'));
});

test('fresh setup ignores an external Codex CLI grant when Clementine has no grant', (t) => {
  const home = makeHome(t);
  const localAuthFile = path.join(home, '.clementine-next', 'state', 'auth.json');
  const cliAuthFile = path.join(home, '.codex', 'auth.json');
  const cliContents = JSON.stringify({
    tokens: {
      access_token: 'cli-access',
      refresh_token: 'cli-refresh',
      account_id: 'cli-account',
    },
  });
  mkdirSync(path.dirname(cliAuthFile), { recursive: true });
  writeFileSync(cliAuthFile, cliContents, 'utf-8');

  assert.equal(loadClementineOwnedCodexOAuthTokens(localAuthFile), null);
  assert.equal(readFileSync(cliAuthFile, 'utf-8'), cliContents, 'CLI auth remains byte-for-byte untouched');
});

test('fresh setup refuses a legacy grant explicitly imported from the Codex CLI', (t) => {
  const home = makeHome(t);
  const localAuthFile = path.join(home, '.clementine-next', 'state', 'auth.json');
  writeJson(localAuthFile, {
    source: 'codex_cli',
    codexOauth: {
      accessToken: 'shared-access',
      refreshToken: 'shared-refresh',
      accountId: 'shared-account',
    },
  });

  assert.equal(loadClementineOwnedCodexOAuthTokens(localAuthFile), null);
});

test('fresh setup fails closed for a legacy grant with no ownership provenance', (t) => {
  const home = makeHome(t);
  const localAuthFile = path.join(home, '.clementine-next', 'state', 'auth.json');
  writeJson(localAuthFile, {
    codexOauth: {
      accessToken: 'unknown-access',
      refreshToken: 'unknown-refresh',
    },
  });

  assert.equal(loadClementineOwnedCodexOAuthTokens(localAuthFile), null);
});

test('fresh setup rejects an old CLI-derived grant that was mislabeled native', (t) => {
  const home = makeHome(t);
  const localAuthFile = path.join(home, '.clementine-next', 'state', 'auth.json');
  writeJson(localAuthFile, {
    source: 'native',
    codexOauth: {
      accessToken: 'old-shared-access',
      refreshToken: 'old-shared-refresh',
    },
  });

  assert.equal(loadClementineOwnedCodexOAuthTokens(localAuthFile), null);
});

test('fresh setup reuses a complete Clementine-owned native grant', (t) => {
  const home = makeHome(t);
  const localAuthFile = path.join(home, '.clementine-next', 'state', 'auth.json');
  writeJson(localAuthFile, {
    source: 'native',
    codexOauth: {
      grantProvenance: CODEX_GRANT_PROVENANCE,
      grantId: 'grant-independent',
      accessToken: 'clementine-access',
      refreshToken: 'clementine-refresh',
      idToken: 'clementine-id',
      accountId: 'clementine-account',
      lastRefresh: '2026-07-14T12:00:00.000Z',
    },
  });

  assert.deepEqual(loadClementineOwnedCodexOAuthTokens(localAuthFile), {
    grantId: 'grant-independent',
    accessToken: 'clementine-access',
    refreshToken: 'clementine-refresh',
    idToken: 'clementine-id',
    accountId: 'clementine-account',
    lastRefresh: '2026-07-14T12:00:00.000Z',
  });
});

test('fresh setup does not reuse an incomplete native grant', (t) => {
  const home = makeHome(t);
  const localAuthFile = path.join(home, '.clementine-next', 'state', 'auth.json');
  writeJson(localAuthFile, {
    source: 'native',
    codexOauth: {
      grantProvenance: CODEX_GRANT_PROVENANCE,
      grantId: 'grant-incomplete',
      accessToken: 'access-without-refresh',
    },
  });

  assert.equal(loadClementineOwnedCodexOAuthTokens(localAuthFile), null);
});

test('a DEAD-latched grant is never reused by desktop setup', (t) => {
  const home = makeHome(t);
  const localAuthFile = path.join(home, '.clementine-next', 'state', 'auth.json');
  const deadFile = path.join(home, '.clementine-next', 'state', 'codex-auth-dead.json');
  writeJson(localAuthFile, {
    source: 'native',
    codexOauth: {
      grantProvenance: CODEX_GRANT_PROVENANCE,
      grantId: 'grant-revoked',
      accessToken: 'still-fresh-but-revoked',
      refreshToken: 'revoked-refresh',
    },
  });
  writeJson(deadFile, { reason: 'token_revoked', since: '2026-07-14T12:00:00.000Z', grantId: 'grant-revoked' });

  assert.equal(loadClementineOwnedCodexOAuthTokens(localAuthFile, deadFile), null);
  assert.equal(existsSync(deadFile), true, 'a read must not clear the terminal latch');
});

test('desktop setup ignores a stale DEAD latch from a replaced grant generation', (t) => {
  const home = makeHome(t);
  const localAuthFile = path.join(home, '.clementine-next', 'state', 'auth.json');
  const deadFile = path.join(home, '.clementine-next', 'state', 'codex-auth-dead.json');
  writeJson(localAuthFile, {
    source: 'native',
    codexOauth: {
      grantProvenance: CODEX_GRANT_PROVENANCE,
      grantId: 'grant-fresh',
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
      lastRefresh: '2026-07-14T12:00:00.000Z',
    },
  });
  writeJson(deadFile, {
    reason: 'late token_revoked from old process',
    since: '2026-07-14T08:58:46.430Z',
    grantId: 'grant-old',
  });

  assert.equal(loadClementineOwnedCodexOAuthTokens(localAuthFile, deadFile)?.grantId, 'grant-fresh');
  assert.equal(existsSync(deadFile), true, 'read-only setup does not mutate the stale marker');
});

test('successful desktop re-auth persists a native grant and clears the revoked latch', async (t) => {
  const home = makeHome(t);
  const localAuthFile = path.join(home, '.clementine-next', 'state', 'auth.json');
  const deadFile = path.join(home, '.clementine-next', 'state', 'codex-auth-dead.json');
  writeJson(deadFile, { reason: 'refresh token revoked' });

  await persistClementineOwnedCodexOAuthTokens(localAuthFile, deadFile, {
    grantId: 'grant-fresh',
    accessToken: 'fresh-access',
    refreshToken: 'fresh-refresh',
    accountId: 'fresh-account',
    lastRefresh: '2026-07-14T12:00:00.000Z',
  });

  assert.deepEqual(loadClementineOwnedCodexOAuthTokens(localAuthFile), {
    grantId: 'grant-fresh',
    accessToken: 'fresh-access',
    refreshToken: 'fresh-refresh',
    idToken: undefined,
    accountId: 'fresh-account',
    lastRefresh: '2026-07-14T12:00:00.000Z',
  });
  assert.equal(existsSync(deadFile), false);
});

test('a failed token write does not clear the revoked latch', async (t) => {
  const home = makeHome(t);
  const blockedParent = path.join(home, 'not-a-directory');
  const localAuthFile = path.join(blockedParent, 'auth.json');
  const deadFile = path.join(home, 'codex-auth-dead.json');
  writeFileSync(blockedParent, 'file blocks mkdir', 'utf-8');
  writeJson(deadFile, { reason: 'refresh token revoked' });

  await assert.rejects(persistClementineOwnedCodexOAuthTokens(localAuthFile, deadFile, {
    grantId: 'grant-write-fails',
    accessToken: 'fresh-access',
    refreshToken: 'fresh-refresh',
    lastRefresh: '2026-07-14T12:00:00.000Z',
  }));
  assert.equal(existsSync(deadFile), true);
});
