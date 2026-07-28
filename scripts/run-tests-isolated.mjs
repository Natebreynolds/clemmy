#!/usr/bin/env node

/**
 * Run the repository test suite behind a process-wide disposable Clementine
 * home. Individual test files still create narrower fixtures when useful, but
 * static ESM imports execute before a file's top-level environment assignment;
 * without this outer boundary an early config import can accidentally bind a
 * test to ~/.clementine-next and create backups/caches in real user state.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testHome = mkdtempSync(path.join(os.tmpdir(), 'clementine-test-home-'));
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const forwarded = process.argv.slice(2);
const args = forwarded.length > 0
  ? ['--test', ...forwarded]
  : ['--test', 'src/**/*.test.ts', 'apps/**/*.test.ts'];

const testEnv = { ...process.env };
for (const key of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'BROWSER_USE_API_KEY',
  'BYO_MODEL_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'CODEX_API_KEY',
  'CODEX_AUTH_SOURCE_FILE',
  'CODEX_HOME',
  'COMPOSIO_API_KEY',
  'DISCORD_BOT_TOKEN',
  'OPENAI_API_KEY',
  'RECALL_API_KEY',
  'SLACK_APP_TOKEN',
  'SLACK_BOT_TOKEN',
  'WEBHOOK_SECRET',
]) {
  delete testEnv[key];
}

let exitCode = 1;
try {
  const result = spawnSync(tsxBin, args, {
    cwd: repoRoot,
    env: {
      ...testEnv,
      // Isolate every conventional home lookup too. CLEMENTINE_HOME protects
      // Clementine state; HOME/USERPROFILE protect ~/.codex, ~/.claude, and
      // third-party CLIs that do not know about CLEMENTINE_HOME.
      HOME: testHome,
      USERPROFILE: testHome,
      CLEMENTINE_HOME: testHome,
      CLEMMY_TEST_ISOLATED_HOME: '1',
      CLEMMY_TEST_DISABLE_LIVE_MODELS: '1',
      // Unit tests must never warm or download the real local embedding model.
      // Provider-specific tests opt back in explicitly with injected fakes.
      CLEMMY_LOCAL_EMBEDDINGS: 'off',
    },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  exitCode = result.status ?? 1;
} finally {
  rmSync(testHome, { recursive: true, force: true });
}

process.exitCode = exitCode;
