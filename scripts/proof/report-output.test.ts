import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  evaluateProofSourceStability,
  fingerprintProofSource,
  writeProofReportFiles,
} from './report-output.js';
import type { ProofReport } from './types.js';

function report(startedAt: string, sourceFingerprint: string): ProofReport {
  return {
    startedAt,
    finishedAt: startedAt,
    gitHead: 'a'.repeat(40),
    sourceFingerprint,
    sourceClean: false,
    fusionMode: 'off',
    outcomes: [],
    failures: 0,
  };
}

test('dirty source fingerprint is stable across untracked discovery order and changes with bytes', () => {
  const base = {
    gitHead: 'abc123',
    trackedDiff: Buffer.from('diff --git a/a.ts b/a.ts\n'),
  };
  const first = fingerprintProofSource({
    ...base,
    untrackedFiles: [
      { path: 'scripts/z.ts', contents: Buffer.from('z') },
      { path: 'src/a.ts', contents: Buffer.from('a') },
    ],
  });
  const reordered = fingerprintProofSource({
    ...base,
    untrackedFiles: [
      { path: 'src/a.ts', contents: Buffer.from('a') },
      { path: 'scripts/z.ts', contents: Buffer.from('z') },
    ],
  });
  const changed = fingerprintProofSource({
    ...base,
    untrackedFiles: [{ path: 'src/a.ts', contents: Buffer.from('changed') }],
  });

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(reordered, first);
  assert.notEqual(changed, first);
});

test('finish-time source evidence preserves dirty-dev semantics and fails closed on drift', () => {
  const fingerprint = 'a'.repeat(64);
  const clean = evaluateProofSourceStability({
    sourceFingerprintStart: fingerprint,
    sourceFingerprintEnd: fingerprint,
    sourceCleanAtStart: true,
    sourceCleanAtEnd: true,
  });
  assert.equal(clean.sourceStable, true);
  assert.equal(clean.sourceClean, true);
  assert.equal(clean.check.pass, true);

  const stableDev = evaluateProofSourceStability({
    sourceFingerprintStart: fingerprint,
    sourceFingerprintEnd: fingerprint,
    sourceCleanAtStart: false,
    sourceCleanAtEnd: false,
  });
  assert.equal(stableDev.sourceStable, true);
  assert.equal(stableDev.sourceClean, false, 'a stable dirty run never upgrades to release evidence');

  for (const finish of ['b'.repeat(64), undefined]) {
    const drifted = evaluateProofSourceStability({
      sourceFingerprintStart: fingerprint,
      sourceFingerprintEnd: finish,
      sourceCleanAtStart: true,
      sourceCleanAtEnd: true,
    });
    assert.equal(drifted.sourceStable, false);
    assert.equal(drifted.sourceClean, false);
    assert.equal(drifted.check.pass, false);
  }

  const malformedStart = evaluateProofSourceStability({
    sourceFingerprintStart: 'not-a-fingerprint',
    sourceFingerprintEnd: 'not-a-fingerprint',
    sourceCleanAtStart: true,
    sourceCleanAtEnd: true,
  });
  assert.equal(malformedStart.sourceStable, false);
  assert.equal(malformedStart.sourceClean, false);
});

test('report writer archives each completed run before updating latest', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-proof-reports-'));
  try {
    const legacy = {
      startedAt: '2026-08-08T19:00:00.000Z',
      gitHead: 'legacy-head',
      sourceClean: false,
      outcomes: [],
      failures: 1,
    };
    writeFileSync(path.join(root, 'proof-report.json'), JSON.stringify(legacy), 'utf8');
    const firstReport = report('2026-08-08T20:28:05.148Z', '1'.repeat(64));
    const secondReport = report('2026-08-08T20:43:08.981Z', '2'.repeat(64));
    const first = writeProofReportFiles({ report: firstReport, outputRoot: root });
    const second = writeProofReportFiles({ report: secondReport, outputRoot: root });

    assert.notEqual(first.archivePath, second.archivePath);
    assert.deepEqual(JSON.parse(readFileSync(first.archivePath, 'utf8')), firstReport);
    assert.deepEqual(JSON.parse(readFileSync(second.archivePath, 'utf8')), secondReport);
    assert.deepEqual(JSON.parse(readFileSync(second.latestPath, 'utf8')), secondReport);
    const legacyArchives = readdirSync(path.join(root, 'proof-reports'))
      .filter((name) => name.startsWith('previous-'));
    assert.equal(legacyArchives.length, 1, 'the pre-archive report was preserved exactly once');
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(root, 'proof-reports', legacyArchives[0]!), 'utf8')),
      legacy,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
