/**
 * Every repository path a test names must be tracked by git.
 *
 * 2026-09-08: the v3.16.0 tag gate failed in CI on a test that imported
 * scripts/backfill-session-history-index.ts — a file hidden on the release
 * machine by a .git/info/exclude entry. Locally green, remotely impossible.
 * This turns that class into a local failure before any tag is cut.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const tracked = new Set(
  execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean),
);
const testFiles = [...tracked].filter((file) => /\.test\.(ts|mts|mjs|tsx)$/.test(file));
// A quoted repository-relative path under a source directory, with an extension.
const PATH_RE = /['"`]((?:scripts|src|apps|packages)\/[A-Za-z0-9_./-]+\.(?:ts|mts|mjs|js|json|sql|md|yml|yaml))['"`]/g;

// Only a path that EXISTS on this machine but is not tracked is the trap:
// tests also name synthetic paths (src/leak.ts) that exist nowhere.
test('every repository path named by a test that exists on disk is tracked by git', () => {
  const missing: string[] = [];
  for (const file of testFiles) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    for (const match of source.matchAll(PATH_RE)) {
      const ref = path.posix.normalize(match[1]!);
      if (ref.includes('${') || ref.includes('*')) continue;
      if (!tracked.has(ref) && existsSync(path.join(ROOT, ref))) missing.push(`${file} -> ${ref}`);
    }
  }
  assert.deepEqual(missing, [], `paths that exist locally but are not tracked by git, referenced by tests:\n${missing.join('\n')}`);
});
