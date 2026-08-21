import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (args) => execFileSync('git', args, {
  cwd: repoRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
}).trim();

const gitSha = git(['rev-parse', 'HEAD']);
if (!/^[0-9a-f]{40}$/.test(gitSha)) {
  throw new Error(`build stamp requires a full commit sha (got ${JSON.stringify(gitSha)})`);
}
const gitDirty = git(['status', '--porcelain', '--untracked-files=all']).length > 0;
const { HARNESS_SCHEMA_VERSION } = await import('../dist/runtime/harness/schema-version.js');
const sourceFingerprint = process.env.CLEMENTINE_BUILD_SOURCE_FINGERPRINT;
if (!/^[0-9a-f]{64}$/.test(sourceFingerprint ?? '')) {
  throw new Error('write-build-stamp requires CLEMENTINE_BUILD_SOURCE_FINGERPRINT from the stable build wrapper');
}
const targetDir = path.join(repoRoot, 'dist', 'runtime');
mkdirSync(targetDir, { recursive: true });
const artifactManifestPath = path.join(
  repoRoot,
  'dist/runtime/harness/implementation-artifacts/emitted/manifest.json',
);
let implementation = {};
if (existsSync(artifactManifestPath)) {
  const manifest = JSON.parse(readFileSync(artifactManifestPath, 'utf8'));
  implementation = {
    implementationManifestDigest: manifest.manifestDigest,
    artifacts: Object.fromEntries(
      Object.entries(manifest.artifacts ?? {}).map(([kind, entry]) => [kind, entry.sha256]),
    ),
  };
}
writeFileSync(
  path.join(targetDir, 'build-stamp.json'),
  `${JSON.stringify({
    gitSha,
    gitDirty,
    sourceFingerprint,
    expectedSchemaVersion: HARNESS_SCHEMA_VERSION,
    ...implementation,
  })}\n`,
  'utf8',
);
