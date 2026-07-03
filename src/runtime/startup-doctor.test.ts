/**
 * Run: npx tsx --test src/runtime/startup-doctor.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStartupDoctor, parseNodeModuleVersionMismatch } from './startup-doctor.js';

test('parseNodeModuleVersionMismatch extracts built and required ABI values', () => {
  const parsed = parseNodeModuleVersionMismatch(
    'was compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 131.',
  );
  assert.deepEqual(parsed, { builtFor: '127', required: '131' });
});

test('buildStartupDoctor flags native ABI mismatches with a rebuild command', () => {
  const doctor = buildStartupDoctor({
    now: '2026-07-03T10:00:00.000Z',
    runtime: { node: '22.15.0', nodeModuleVersion: '127' },
    packageJson: {
      name: 'clemmy',
      version: '0.0.0-test',
      engines: { node: '>=22.15.0' },
      dependencies: { 'better-sqlite3': '^12.11.1' },
    },
    desktopPackageJson: null,
    nativeDependencies: ['better-sqlite3'],
    loadNativeDependency: () => ({
      ok: false,
      resolvedPath: '/tmp/node_modules/better-sqlite3/index.js',
      version: '12.11.1',
      error: new Error('NODE_MODULE_VERSION 127 but this Node requires NODE_MODULE_VERSION 131'),
    }),
  });

  assert.equal(doctor.status, 'error');
  assert.equal(doctor.nativeDependencies[0]?.status, 'error');
  assert.equal(doctor.issues[0]?.id, 'native-better-sqlite3-abi');
  assert.equal(doctor.issues[0]?.command, 'npm rebuild better-sqlite3');
});

test('buildStartupDoctor flags unsupported Node versions before startup surprises', () => {
  const doctor = buildStartupDoctor({
    runtime: { node: '20.19.0', nodeModuleVersion: '115' },
    packageJson: {
      name: 'clemmy',
      version: '0.0.0-test',
      engines: { node: '>=22.15.0' },
      dependencies: { 'better-sqlite3': '^12.11.1' },
    },
    desktopPackageJson: null,
    nativeDependencies: ['better-sqlite3'],
    loadNativeDependency: () => ({ ok: true, version: '12.11.1' }),
  });

  assert.equal(doctor.status, 'error');
  assert.equal(doctor.issues[0]?.id, 'node-version-floor');
});
