import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CredentialStoragePrivacyError } from './credential-private-filesystem.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'clem-claude-private-read-'));
process.env.CLEMENTINE_HOME = root;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const claude = await import('./claude-oauth.js');
test.after(() => { claude.__test__.setVaultTokenReaderForTests(null); claude.__test__.setRawCredentialReaderForTests(null); rmSync(root, { recursive: true, force: true }); });

test('a second-read privacy refusal cannot reuse an earlier valid CLI token', async () => {
  let reads = 0;
  claude.__test__.setVaultTokenReaderForTests(() => {
    reads += 1; if (reads > 1) throw new CredentialStoragePrivacyError(); return null;
  });
  claude.__test__.setRawCredentialReaderForTests(() => JSON.stringify({ accessToken: 'sk-ant-oat01-synthetic', expiresAt: Date.now() + 3_600_000 }));
  await assert.rejects(() => claude.loadFreshClaudeAccessToken(), CredentialStoragePrivacyError);
  assert.equal(reads, 2, 'privacy refusal terminates rather than retaining the initial token or probing another source');
});
