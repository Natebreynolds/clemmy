/**
 * RED PIN — the daemon's candidate stamp must identify the exact build.
 *
 * Invariant: the build self-report the daemon serves (boot banner and
 * GET /api/console/health attach getBuildInfo() verbatim) must carry a
 * candidate stamp strong enough to pin a proof leg to an exact runtime:
 *
 *   - gitSha: the FULL 40-hex commit sha, from a build-time stamp — a short
 *     dev-only sha resolved via git in process.cwd() disappears in packaged
 *     builds and lies under a wrong cwd, so it cannot certify a candidate;
 *   - gitDirty: whether that build's source tree carried uncommitted changes;
 *   - schemaVersion: the harness.db schema version (MAX(schema_version.version))
 *     — today the schema_version table is surfaced nowhere, so two daemons on
 *     different migration levels are indistinguishable from the outside.
 *
 * Run: npx tsx --test src/runtime/build-candidate-stamp.red.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { getBuildInfo } from './build-info.js';

type StampedBuildInfo = ReturnType<typeof getBuildInfo> & {
  schemaVersion?: number;
};

test('the build self-report carries the full 40-hex commit sha, not a short dev-only sha', () => {
  const build = getBuildInfo() as StampedBuildInfo;
  assert.match(
    build.gitSha ?? '(absent)',
    /^[0-9a-f]{40}$/,
    'candidate identity must be the full 40-hex commit sha from a build-time stamp; '
    + `a short/dev-only git-in-cwd sha cannot pin a packaged or wrong-cwd daemon (got ${JSON.stringify(build.gitSha)})`,
  );
});

test('the build self-report carries the harness schema version', () => {
  const build = getBuildInfo() as StampedBuildInfo;
  assert.equal(
    typeof build.schemaVersion,
    'number',
    'the health/status build payload must report schemaVersion (harness.db MAX(schema_version.version)); '
    + 'today the schema_version table is exported nowhere, so migration level is invisible to proof legs',
  );
});

test('the build self-report names the expected schema and exact source fingerprint', () => {
  const build = getBuildInfo() as StampedBuildInfo & {
    expectedSchemaVersion?: number;
    sourceFingerprint?: string;
  };
  assert.equal(typeof build.expectedSchemaVersion, 'number');
  assert.ok((build.expectedSchemaVersion ?? 0) > 0);
  assert.match(
    build.sourceFingerprint ?? '(absent)',
    /^[a-f0-9]{64}$/,
    'a dirty dev tree needs byte-level source identity; HEAD + dirty=true is not exact enough',
  );
});

test('guard: dev-tree dirtiness stays reported as a boolean', () => {
  const build = getBuildInfo() as StampedBuildInfo;
  assert.equal(
    typeof build.gitDirty,
    'boolean',
    'gitDirty is part of the candidate stamp and must survive the build-time-stamp fix',
  );
});
