/**
 * Run: npx tsx --test src/integrations/composio/file-pipeline.test.ts
 * File pipeline (2026-07-21): the Composio client is initialized with the
 * SDK's file support ON (downloads land in our staging dir with a local
 * filePath in the result; uploads accept local paths) — previously "move
 * this attachment to Drive" had NO working path. Plus staging hygiene.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-file-pipeline-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });
process.env.COMPOSIO_API_KEY = 'ck_test_file_pipeline';

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { getComposio, composioFilesDir } = await import('./client.js');
const { pruneComposioFilesDir } = await import('./files-prune.js');

test.after(() => rmSync(TMP, { recursive: true, force: true }));
afterEach(() => { delete process.env.CLEMMY_COMPOSIO_FILES; });

test('the client enables the SDK file pipeline: staging download dir + upload allowlist + credential protection', () => {
  const client = getComposio();
  assert.ok(client, 'client builds with an api key');
  // The SDK copies these into its internal config; read them back from the
  // instance (private field access via cast — a config regression here is the
  // whole feature silently dying, worth pinning).
  const config = (client as unknown as { config?: Record<string, unknown> }).config ?? {};
  assert.equal(config.dangerouslyAllowAutoUploadDownloadFiles, true, 'file support ON — without it every file tool degrades to raw S3 urls');
  assert.equal(config.fileDownloadDir, composioFilesDir(), 'downloads land in OUR staging dir (BASE_DIR/files)');
  const uploadDirs = config.fileUploadDirs as string[] | undefined;
  assert.ok(Array.isArray(uploadDirs) && uploadDirs.includes(composioFilesDir()), 'staged downloads are re-uploadable (the download→upload chain)');
  assert.ok(uploadDirs!.some((d) => d === os.homedir()), 'user-file uploads allowed under home (SDK credential denylist still applies)');
  assert.notEqual(config.sensitiveFileUploadProtection, false, 'credential-path protection stays ON');
  assert.ok(existsSync(composioFilesDir()), 'staging dir created at init');
});

test('staging hygiene: files past the TTL prune; fresh files stay', () => {
  const dir = composioFilesDir();
  mkdirSync(dir, { recursive: true });
  const oldFile = path.join(dir, 'old-attachment.pdf');
  const freshFile = path.join(dir, 'fresh-attachment.pdf');
  writeFileSync(oldFile, 'x');
  writeFileSync(freshFile, 'y');
  const tenDaysAgo = (Date.now() - 10 * 24 * 60 * 60_000) / 1000;
  utimesSync(oldFile, tenDaysAgo, tenDaysAgo);
  const { pruned } = pruneComposioFilesDir();
  assert.equal(pruned, 1);
  assert.equal(existsSync(oldFile), false, 'stale staging pruned');
  assert.equal(existsSync(freshFile), true, 'fresh handoffs untouched');
});
