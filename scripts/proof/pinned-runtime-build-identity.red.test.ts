/**
 * RED PIN — a pinned-runtime proof leg must verify WHO it measured.
 *
 * Invariant: when the proof harness drives a pinned baseline (e.g.
 * --runtime v3.14.0 provisioned by runtime-under-test), the spawned daemon's
 * SELF-REPORTED build must be cross-checked against the pinned
 * RuntimeUnderTest.gitSha, and a mismatch must exist as a failing Check in
 * the evidence. Today provisioning only verifies that daemonEntry exists on
 * disk — a stale or wrong dist can serve a "pinned v3.14" leg undetected and
 * every downstream comparison inherits the mislabeled evidence.
 *
 * Contract pinned here: proof provisioning (provision.ts or
 * runtime-under-test.ts) exports verifyDaemonBuildMatchesPinnedRuntime,
 * a pure unit-testable check builder taking the pinned runtime identity and
 * the daemon's self-reported build, returning a Check that fails on sha
 * mismatch and passes on agreement.
 *
 * Run: npx tsx --test scripts/proof/pinned-runtime-build-identity.red.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Provisioning modules read CLEMENTINE_HOME-adjacent state; isolate before import.
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-pinned-build-identity-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const provision = await import('./provision.js');
const runtimeUnderTest = await import('./runtime-under-test.js');

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

interface CheckLike { name: string; pass: boolean; detail?: string }

type BuildIdentityVerifier = (input: {
  runtime: {
    label: string;
    gitRef: string | null;
    gitSha: string;
    treeRoot: string;
    daemonEntry: string;
    lockSha256: string;
    nodeModulesProvenance: 'primary-tree' | 'npm-ci';
    built: boolean;
    buildAttestation?: {
      version: 1;
      gitSha: string;
      lockSha256: string;
      artifactRoot: string;
      artifactSha256: string;
    };
  };
  reportedBuild: {
    version: string;
    entry: string;
    packaged: boolean;
    gitSha?: string;
    gitDirty?: boolean;
  } | undefined;
  observedArtifactSha256?: string;
}) => CheckLike;

function pinnedRuntimeFixture(sha: string, daemonSha = 'd'.repeat(64)) {
  return {
    label: 'v3.14.0',
    gitRef: 'v3.14.0',
    gitSha: sha,
    treeRoot: '/tmp/clem-benchmark-runtimes/abcdefabcdef',
    daemonEntry: '/tmp/clem-benchmark-runtimes/abcdefabcdef/dist/index.js',
    lockSha256: '0'.repeat(64),
    nodeModulesProvenance: 'npm-ci' as const,
    built: true,
    buildAttestation: {
      version: 1 as const,
      gitSha: sha,
      lockSha256: '0'.repeat(64),
      artifactRoot: 'dist',
      artifactSha256: daemonSha,
    },
  };
}

test('provisioning exposes a failing check when the daemon self-reports a build other than the pinned runtime sha', () => {
  const verifier = [provision, runtimeUnderTest]
    .map((mod) => (mod as Record<string, unknown>).verifyDaemonBuildMatchesPinnedRuntime)
    .find((value) => typeof value === 'function') as BuildIdentityVerifier | undefined;
  assert.equal(
    typeof verifier,
    'function',
    'no build-identity verification seam exists: proof provisioning must export '
    + 'verifyDaemonBuildMatchesPinnedRuntime(pinned runtime, daemon self-reported build) -> Check '
    + 'so a stale/wrong dist can never serve a pinned baseline leg undetected '
    + '(today provisionDaemon only checks that daemonEntry exists on disk)',
  );
  if (typeof verifier !== 'function') return;

  const pinnedSha = 'a'.repeat(40);
  const mismatch = verifier({
    runtime: pinnedRuntimeFixture(pinnedSha),
    observedArtifactSha256: 'd'.repeat(64),
    reportedBuild: {
      version: '3.14.0',
      entry: '/tmp/clem-benchmark-runtimes/abcdefabcdef/dist/index.js',
      packaged: false,
      gitSha: 'b'.repeat(40),
      gitDirty: false,
    },
  });
  assert.equal(
    mismatch.pass,
    false,
    'a daemon self-reporting a different sha than the pinned RuntimeUnderTest.gitSha must produce a FAILING check',
  );

  const agreement = verifier({
    runtime: pinnedRuntimeFixture(pinnedSha),
    observedArtifactSha256: 'd'.repeat(64),
    reportedBuild: {
      version: '3.14.0',
      entry: '/tmp/clem-benchmark-runtimes/abcdefabcdef/dist/index.js',
      packaged: false,
      gitSha: pinnedSha,
      gitDirty: false,
    },
  });
  assert.equal(agreement.pass, true, 'an exact sha agreement passes the identity check');

  const v314WrongCwd = verifier({
    runtime: pinnedRuntimeFixture(pinnedSha),
    observedArtifactSha256: 'd'.repeat(64),
    reportedBuild: {
      version: '3.14.0',
      entry: '/tmp/clem-benchmark-runtimes/abcdefabcdef/dist/index.js',
      packaged: false,
    },
  });
  assert.equal(
    v314WrongCwd.pass,
    true,
    'v3.14 omits git identity when spawned from an isolated cwd; exact artifact attestation certifies it',
  );

  const modernMissing = verifier({
    runtime: { ...pinnedRuntimeFixture(pinnedSha), label: 'v3.15.0' },
    observedArtifactSha256: 'd'.repeat(64),
    reportedBuild: {
      version: '3.15.0',
      entry: '/tmp/clem-benchmark-runtimes/abcdefabcdef/dist/index.js',
      packaged: false,
    },
  });
  assert.equal(modernMissing.pass, false, 'newer daemons may not silently omit their build identity');

  const legacyShort = verifier({
    runtime: pinnedRuntimeFixture(pinnedSha),
    observedArtifactSha256: 'd'.repeat(64),
    reportedBuild: {
      version: '3.14.0',
      entry: '/tmp/clem-benchmark-runtimes/abcdefabcdef/dist/index.js',
      packaged: false,
      gitSha: pinnedSha.slice(0, 7),
      gitDirty: false,
    },
  });
  assert.equal(legacyShort.pass, true, 'v3.14 short-sha self-report is certified by exact artifact bytes');

  const contradictoryShort = verifier({
    runtime: pinnedRuntimeFixture(pinnedSha),
    observedArtifactSha256: 'd'.repeat(64),
    reportedBuild: {
      version: '3.14.0',
      entry: '/tmp/clem-benchmark-runtimes/abcdefabcdef/dist/index.js',
      packaged: false,
      gitSha: 'bbbbbbb',
      gitDirty: false,
    },
  });
  assert.equal(contradictoryShort.pass, false, 'a contradictory legacy short sha fails closed');

  const legacySilent = verifier({
    runtime: pinnedRuntimeFixture(pinnedSha),
    reportedBuild: undefined,
    observedArtifactSha256: 'd'.repeat(64),
  });
  assert.equal(
    legacySilent.pass,
    true,
    'an old pinned runtime can be certified by the measurement-owned exact-byte attestation even when it predates daemon self-reporting',
  );

  const tampered = verifier({
    runtime: pinnedRuntimeFixture(pinnedSha),
    reportedBuild: undefined,
    observedArtifactSha256: 'e'.repeat(64),
  });
  assert.equal(tampered.pass, false, 'spawned bytes that differ from the cache attestation fail closed');
});

test('identity health parsing distinguishes an absent legacy endpoint from broken evidence', () => {
  const parse = runtimeUnderTest.reportedBuildFromHealthResponse;
  assert.equal(parse({ status: 404, bodyText: 'not found' }), undefined);
  assert.throws(() => parse({ status: 500, bodyText: '{}' }), /HTTP 500/);
  assert.throws(() => parse({ status: 200, bodyText: 'not-json' }), /malformed JSON/);
  assert.throws(() => parse({ status: 200, bodyText: '{}' }), /omitted.*build/i);
  assert.deepEqual(
    parse({ status: 200, bodyText: JSON.stringify({ build: { version: '3.14.0', entry: '/x', packaged: false } }) }),
    { version: '3.14.0', entry: '/x', packaged: false },
  );
});

test('a partial modern build identity is never treated as legacy', () => {
  const verifier = runtimeUnderTest.verifyDaemonBuildMatchesPinnedRuntime as BuildIdentityVerifier;
  const pinnedSha = 'a'.repeat(40);
  const partial = verifier({
    runtime: { ...pinnedRuntimeFixture(pinnedSha), label: 'v3.15.0' },
    observedArtifactSha256: 'd'.repeat(64),
    reportedBuild: {
      version: '3.15.0',
      entry: '/tmp/runtime/dist/index.js',
      packaged: false,
      gitDirty: false,
    },
  });
  assert.equal(partial.pass, false);
});
