import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-artifact-bundle-home-'));
process.env.CLEMENTINE_HOME = TEST_HOME;

const {
  ARTIFACT_BUNDLE_LIMITS,
  ArtifactBundleError,
  inspectArtifactBundle,
  inspectArtifactBundleArtifactId,
  saveArtifactBundle,
} = await import('./artifact-bundle-core.js');

test.after(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function tempRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'clem-artifact-bundle-'));
}

test('artifact bundle publishes one deterministic content-addressed revision and exact replay is a no-op', () => {
  const rootDir = tempRoot();
  try {
    const input = {
      bundleId: 'sales-portal',
      files: [
        { path: 'server.mjs', content: 'export const port = 3000;\n' },
        { path: 'public/index.html', content: '<!doctype html><h1>Sales</h1>\n' },
        { path: 'public/data/sales.json', content: '{"rows":[]}\n' },
      ],
    };
    const first = saveArtifactBundle(input, { rootDir });
    const second = saveArtifactBundle({ ...input, files: [...input.files].reverse() }, { rootDir });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.revisionDigest, first.revisionDigest);
    assert.equal(second.directory, first.directory);
    assert.equal(lstatSync(first.directory).isDirectory(), true);
    assert.equal(readFileSync(path.join(first.directory, 'public/index.html'), 'utf8'), input.files[1]!.content);
    assert.deepEqual(first.files.map((file) => file.path), [
      'public/data/sales.json',
      'public/index.html',
      'server.mjs',
    ]);
    assert.deepEqual(inspectArtifactBundle(input, { rootDir }), {
      status: 'present_exact',
      result: { ...first, created: false },
    });
    assert.deepEqual(inspectArtifactBundleArtifactId(first.artifactId, { rootDir }), {
      status: 'present_exact',
      result: { ...first, created: false },
    });
    assert.deepEqual(
      readdirSync(path.join(rootDir, 'sales-portal')).filter((name) => name.startsWith('.tmp-')),
      [],
      'successful publication leaves no staging directory',
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('artifact bundle rejects traversal, duplicate/reserved paths, and byte-budget overflow before publishing', () => {
  const rootDir = tempRoot();
  try {
    const invalid: Array<{ bundleId: string; files: Array<{ path: string; content: string }> }> = [
      { bundleId: '../escape', files: [{ path: 'index.html', content: 'x' }] },
      { bundleId: 'safe', files: [{ path: '../escape.txt', content: 'x' }] },
      { bundleId: 'safe', files: [{ path: '/absolute.txt', content: 'x' }] },
      { bundleId: 'safe', files: [{ path: 'windows\\escape.txt', content: 'x' }] },
      { bundleId: 'safe', files: [{ path: '.clementine-bundle.json', content: 'x' }] },
      { bundleId: 'safe', files: [{ path: 'a.txt', content: '1' }, { path: 'a.txt', content: '2' }] },
      {
        bundleId: 'safe',
        files: [{ path: 'large.txt', content: 'x'.repeat(ARTIFACT_BUNDLE_LIMITS.maxFileBytes + 1) }],
      },
    ];
    for (const candidate of invalid) {
      assert.throws(
        () => saveArtifactBundle(candidate, { rootDir }),
        (error: unknown) => error instanceof ArtifactBundleError,
      );
    }
    assert.equal(existsSync(path.join(rootDir, 'safe')), false);
    assert.equal(existsSync(path.join(rootDir, '..', 'escape')), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('artifact bundle refuses an existing corrupt revision instead of repairing or overwriting it', () => {
  const rootDir = tempRoot();
  try {
    const input = {
      bundleId: 'immutable-site',
      files: [{ path: 'index.html', content: '<h1>Original</h1>' }],
    };
    const saved = saveArtifactBundle(input, { rootDir });
    writeFileSync(path.join(saved.directory, 'index.html'), '<h1>Tampered</h1>', 'utf8');

    const inspection = inspectArtifactBundle(input, { rootDir });
    assert.equal(inspection.status, 'mismatch');
    assert.throws(
      () => saveArtifactBundle(input, { rootDir }),
      (error: unknown) => error instanceof ArtifactBundleError && error.code === 'existing_mismatch',
    );
    assert.equal(readFileSync(path.join(saved.directory, 'index.html'), 'utf8'), '<h1>Tampered</h1>');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('artifact bundle publication failure leaves no visible revision or staging residue', () => {
  const rootDir = tempRoot();
  try {
    const input = {
      bundleId: 'crash-safe-site',
      files: [{ path: 'index.html', content: '<h1>Not published</h1>' }],
    };
    assert.throws(
      () => saveArtifactBundle(input, {
        rootDir,
        beforePublish() {
          throw new Error('simulated crash before rename');
        },
      }),
      (error: unknown) => error instanceof ArtifactBundleError
        && error.code === 'filesystem_refusal'
        && /simulated crash/.test(error.message),
    );
    assert.equal(inspectArtifactBundle(input, { rootDir }).status, 'absent');
    const bundleRoot = path.join(rootDir, input.bundleId);
    assert.deepEqual(existsSync(bundleRoot) ? readdirSync(bundleRoot) : [], []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
