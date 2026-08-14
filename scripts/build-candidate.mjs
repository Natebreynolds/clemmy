import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fingerprintRuntimeSourceFromGit } from '../src/runtime/source-fingerprint.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim();
const fingerprintBefore = fingerprintRuntimeSourceFromGit({ repoRoot, gitHead });

const compiler = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const result = spawnSync(process.execPath, [compiler, '--outDir', 'dist'], {
  cwd: repoRoot,
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const fingerprintAfter = fingerprintRuntimeSourceFromGit({ repoRoot, gitHead });
if (fingerprintAfter !== fingerprintBefore) {
  throw new Error(
    `source changed during candidate build (before ${fingerprintBefore}, after ${fingerprintAfter}); rebuild the stable tree`,
  );
}

const stamp = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'write-build-stamp.mjs')], {
  cwd: repoRoot,
  env: { ...process.env, CLEMENTINE_BUILD_SOURCE_FINGERPRINT: fingerprintBefore },
  stdio: 'inherit',
});
if (stamp.error) throw stamp.error;
if (stamp.status !== 0) process.exit(stamp.status ?? 1);
const fingerprintAfterStamp = fingerprintRuntimeSourceFromGit({ repoRoot, gitHead });
if (fingerprintAfterStamp !== fingerprintBefore) {
  throw new Error(
    `source changed during candidate build stamp (before ${fingerprintBefore}, after ${fingerprintAfterStamp}); rebuild the stable tree`,
  );
}
