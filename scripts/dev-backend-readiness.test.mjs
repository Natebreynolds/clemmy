import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertBuiltBackendReady, BACKEND_RUNTIME_DEPENDENCIES, captureBackendRuntimeDependencyDigests } from './lib/dev-backend-readiness.mjs';

const root = mkdtempSync(path.join(os.tmpdir(), 'clem-backend-readiness-test-'));
const sourceFingerprint = 'a'.repeat(64);
const gitHead = 'b'.repeat(40);
const schemaVersion = 427;
const options = { repoRoot: root, sourceFingerprint, gitHead, schemaVersion };
const stampPath = path.join(root, 'dist/runtime/build-stamp.json');
function write(relative, contents) {
  const file = path.join(root, relative); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, contents);
}
function fresh() {
  rmSync(path.join(root, 'dist'), { recursive: true, force: true });
  write('package.json', JSON.stringify({ name: 'clemmy', type: 'module' }));
  for (const [relative, exports] of Object.entries(BACKEND_RUNTIME_DEPENDENCIES)) {
    write(relative, exports.map(name => `export function ${name}() { throw new Error('readiness must never call the provider'); }`).join('\n'));
  }
  stamp();
}
function stamp(extra = {}) {
  write('dist/runtime/build-stamp.json', JSON.stringify({ sourceFingerprint, gitSha: gitHead,
    expectedSchemaVersion: schemaVersion, backendRuntimeDependencies: captureBackendRuntimeDependencyDigests(root), ...extra }));
}
test.after(() => rmSync(root, { recursive: true, force: true }));

test('a clean worktree cannot claim backend readiness before the exact package dependencies are built', () => {
  assert.throws(() => assertBuiltBackendReady(options), /stamp missing/);
  fresh();
  assert.equal(assertBuiltBackendReady(options).sourceFingerprint, sourceFingerprint, 'the real CJS require probe loads ESM exports without invoking any provider function');
  rmSync(path.join(root, 'dist/integrations/composio/client.js'));
  assert.throws(() => assertBuiltBackendReady(options), /dependency missing/);
});

test('stale source, absent digests and changed compiled dependencies are refused', () => {
  fresh(); stamp({ sourceFingerprint: 'c'.repeat(64) });
  assert.throws(() => assertBuiltBackendReady(options), /does not match the exact source/);
  stamp({ backendRuntimeDependencies: {} });
  assert.throws(() => assertBuiltBackendReady(options), /unstamped or changed/);
  stamp();
  write('dist/integrations/composio/client.js', 'export const changed = true;');
  assert.throws(() => assertBuiltBackendReady(options), /unstamped or changed/);
});

test('a matching stamp cannot hide missing exports or an ESM graph createRequire cannot load', () => {
  fresh();
  write('dist/integrations/composio/client.js', 'export function isComposioEnabled() {}'); stamp();
  assert.throws(() => assertBuiltBackendReady(options), /lacks export peekConnectedToolkits/);
  fresh();
  const relative = 'dist/integrations/composio/client.js';
  write(relative, 'await Promise.resolve();\n' + readFileSync(path.join(root, relative), 'utf8')); stamp();
  assert.throws(() => assertBuiltBackendReady(options), /cannot load/);
});

test('dev launch builds backend before source attestation and checks dependency identity again after startup', () => {
  const devUp = readFileSync(new URL('./dev-up.sh', import.meta.url), 'utf8');
  const stampScript = readFileSync(new URL('./write-build-stamp.mjs', import.meta.url), 'utf8');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(devUp.indexOf('npm run build)') > devUp.indexOf('emitting implementation artifacts'));
  assert.ok(devUp.indexOf('npm run build)') < devUp.indexOf('EXPECTED_RUNTIME_JSON='));
  assert.ok(devUp.indexOf('assertBuiltBackendReady({') < devUp.indexOf('src/index.ts daemon start'));
  assert.equal((devUp.match(/assertBuiltBackendReady\(\{/g) ?? []).length, 2);
  assert.match(stampScript, /backendRuntimeDependencies: captureBackendRuntimeDependencyDigests\(repoRoot\)/);
  assert.equal(pkg.scripts.prebuild, 'npm run clean:dist');
  assert.equal(pkg.scripts.build, 'node --import tsx scripts/build-candidate.mjs');
});
