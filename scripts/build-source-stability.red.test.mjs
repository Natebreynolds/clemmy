import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fingerprintRuntimeSourceFromGit } from '../src/runtime/source-fingerprint.ts';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const buildScript = readFileSync(new URL('./build-candidate.mjs', import.meta.url), 'utf8');
const stampScript = readFileSync(new URL('./write-build-stamp.mjs', import.meta.url), 'utf8');

test('candidate builds fail closed if source bytes move while TypeScript compiles', () => {
  assert.equal(pkg.scripts.build, 'node --import tsx scripts/build-candidate.mjs');
  assert.match(buildScript, /fingerprintBefore/);
  assert.match(buildScript, /fingerprintAfter/);
  assert.match(buildScript, /source changed during candidate build/);
  assert.match(stampScript, /CLEMENTINE_BUILD_SOURCE_FINGERPRINT/);
});


test('actual build identity includes tracked and new shared package sources while excluding local output', () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'clem-build-package-identity-'));
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (...args) => execFileSync('git', args, { cwd: repoRoot, env: gitEnv, stdio: 'pipe' });
  try {
    mkdirSync(path.join(repoRoot, 'packages/chat-engine/src'), { recursive: true });
    const engine = path.join(repoRoot, 'packages/chat-engine/src/stream.ts');
    const initial = 'export const replayVersion = 1;\n';
    writeFileSync(engine, initial);
    git('init'); git('add', 'packages');
    git('-c', 'user.name=Build fixture', '-c', 'user.email=build-fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
    const baseline = fingerprintRuntimeSourceFromGit({ repoRoot });
    writeFileSync(engine, 'export const replayVersion = 2;\n');
    assert.notEqual(fingerprintRuntimeSourceFromGit({ repoRoot }), baseline, 'changing an imported shared chat engine must invalidate the build');
    writeFileSync(engine, initial);
    assert.equal(fingerprintRuntimeSourceFromGit({ repoRoot }), baseline);
    mkdirSync(path.join(repoRoot, 'packages/design-tokens'), { recursive: true });
    const tokens = path.join(repoRoot, 'packages/design-tokens/tokens.css');
    writeFileSync(tokens, ':root { --canvas: #fff; }\n');
    assert.notEqual(fingerprintRuntimeSourceFromGit({ repoRoot }), baseline, 'new untracked shared CSS must be included before commit as well');
    rmSync(tokens);
    assert.equal(fingerprintRuntimeSourceFromGit({ repoRoot }), baseline);
    mkdirSync(path.join(repoRoot, 'output'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'output/local-evidence.json'), '{"local":true}');
    assert.equal(fingerprintRuntimeSourceFromGit({ repoRoot }), baseline, 'local evidence is not executable release source');
  } finally { rmSync(repoRoot, { recursive: true, force: true }); }
});
