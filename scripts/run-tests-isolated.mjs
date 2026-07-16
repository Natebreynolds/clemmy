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

let exitCode = 1;
try {
  const result = spawnSync(tsxBin, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLEMENTINE_HOME: testHome,
      CLEMMY_TEST_ISOLATED_HOME: '1',
    },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  exitCode = result.status ?? 1;
} finally {
  rmSync(testHome, { recursive: true, force: true });
}

process.exitCode = exitCode;
