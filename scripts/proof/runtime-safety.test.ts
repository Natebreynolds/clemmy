import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertProofHomeIdentity,
  assertProofTempCapacity,
  awaitProofChildOutputDrain,
  BoundedProofLogCapture,
  captureProofHomeIdentity,
  captureProofStateIdentity,
  createProofForensicReserve,
  persistProofDaemonLogForForensics,
  PROOF_DAEMON_LOG_MAX_BYTES,
  PROOF_FORENSIC_RESERVE_BYTES,
  PROOF_MIN_TEMP_FREE_BYTES,
  PROOF_SCENARIO_LOG_MAX_BYTES,
  proofCleanupFailure,
  proofCredentialFileRedactions,
  proofDaemonStopChecks,
  proofForensicReservePath,
  proofTempCapacityError,
  preflightProofRuntimeSafety,
  redactProofDaemonLog,
  removeProofHome,
  sanitizeProofHomeForForensics,
  trackProofChildOutput,
} from './runtime-safety.js';

test('bounded proof log capture preserves arbitrary UTF-8 chunking and caps both windows', () => {
  assert.equal(PROOF_SCENARIO_LOG_MAX_BYTES, 8 * 1024 * 1024);
  const capture = new BoundedProofLogCapture({
    forensicMaxBytes: 256,
    forensicRedactionOverlapBytes: 64,
    scenarioMaxBytes: 96,
  });
  const exact = 'boot α🙂\nprovider line\n';
  const bytes = Buffer.from(exact, 'utf8');
  for (let offset = 0; offset < bytes.length;) {
    const width = (offset % 5) + 1;
    capture.append(bytes.subarray(offset, Math.min(bytes.length, offset + width)));
    offset += width;
  }
  assert.equal(capture.scenarioLog(), exact, 'split multibyte code points reassemble exactly');
  assert.equal(capture.stats().totalBytes, bytes.length);

  capture.markScenario();
  const overflow = Buffer.from(`${'x'.repeat(300)}🙂TAIL`, 'utf8');
  for (let offset = 0; offset < overflow.length; offset += 7) {
    capture.append(overflow.subarray(offset, Math.min(overflow.length, offset + 7)));
  }
  const evidence = capture.stats();
  assert.equal(evidence.currentScenarioStoredBytes, 96);
  assert.equal(evidence.currentScenarioDroppedBytes, overflow.length - 96);
  assert.equal(evidence.scenarioDroppedBytes, overflow.length - 96);
  assert.equal(evidence.overflowPeriods, 1);
  assert.equal(evidence.overflowed, true);
  assert.ok(evidence.forensicStoredBytes <= 256);
  assert.equal(evidence.forensicDroppedBytes, evidence.totalBytes - evidence.forensicStoredBytes);
  assert.throws(() => capture.scenarioLog(), /per-scenario capture bound.*evidence is incomplete/i);
  const tail = capture.forensicLog();
  assert.ok(Buffer.byteLength(tail, 'utf8') <= 256);
  assert.match(tail, /dropping \d+ bytes/i);
  assert.ok(tail.endsWith('🙂TAIL'));
  assert.doesNotMatch(tail, /�/u, 'bounded byte tails never expose split-code-point replacement text');

  capture.clear();
  assert.equal(capture.scenarioLog(), '');
  assert.deepEqual(capture.stats(), {
    totalBytes: 0,
    forensicMaxBytes: 256,
    forensicStoredBytes: 0,
    forensicDroppedBytes: 0,
    forensicRawMaxBytes: 320,
    forensicRawStoredBytes: 0,
    forensicRawDroppedBytes: 0,
    forensicRedactionOverlapBytes: 64,
    scenarioMaxBytes: 96,
    currentScenarioBytes: 0,
    currentScenarioStoredBytes: 0,
    currentScenarioDroppedBytes: 0,
    scenarioDroppedBytes: 0,
    overflowPeriods: 0,
    overflowed: false,
  });
});

test('scenario marking resets only the semantic window while restart output stays in the forensic tail', () => {
  const capture = new BoundedProofLogCapture({
    forensicMaxBytes: 512,
    forensicRedactionOverlapBytes: 64,
    scenarioMaxBytes: 256,
  });
  capture.append('boot-only\n');
  capture.markScenario();
  capture.append('before-restart\n');
  capture.append('[proof] spawning daemon after restart\n');
  capture.append('after-restart\n');
  assert.equal(
    capture.scenarioLog(),
    'before-restart\n[proof] spawning daemon after restart\nafter-restart\n',
    'a daemon restart does not split one scenario log window',
  );
  capture.markScenario();
  capture.append('next-scenario\n');
  assert.equal(capture.scenarioLog(), 'next-scenario\n');
  assert.equal(
    capture.forensicLog(),
    'boot-only\nbefore-restart\n[proof] spawning daemon after restart\nafter-restart\nnext-scenario\n',
  );
  assert.equal(capture.stats().overflowed, false);
});

test('native safety preflight rejects unsupported platforms and unavailable compilers before use', () => {
  assert.throws(
    () => preflightProofRuntimeSafety({ platform: 'win32' }),
    /supports only macOS\/Linux POSIX runtimes.*win32.*unsupported/i,
  );
  assert.throws(
    () => preflightProofRuntimeSafety({ compilerCandidates: ['/definitely/missing/proof-cc'] }),
    /preflight failed.*requires a system C compiler/i,
  );
  assert.doesNotThrow(() => preflightProofRuntimeSafety());
});

test('live proof disk guard fails before the safety floor with actionable context', () => {
  const error = proofTempCapacityError({
    tempRoot: '/isolated/tmp',
    availableBytes: PROOF_MIN_TEMP_FREE_BYTES - 1,
  });
  assert.match(error ?? '', /refused to start/i);
  assert.match(error ?? '', /clemmy-proof-\*/i);
  assert.doesNotMatch(proofTempCapacityError({
    tempRoot: '/isolated/tmp',
    availableBytes: Number.NaN,
  }) ?? '', /NaN/);
  assert.equal(proofTempCapacityError({
    tempRoot: '/isolated/tmp',
    availableBytes: PROOF_MIN_TEMP_FREE_BYTES,
  }), null, 'the exact conservative floor is admitted');
});

test('live proof disk guard fails closed when capacity cannot be inspected', () => {
  assert.throws(
    () => assertProofTempCapacity('/isolated/tmp', {
      statfs: () => { throw new Error('statfs unavailable'); },
    }),
    /capacity could not be verified.*statfs unavailable/i,
  );
  assert.throws(
    () => assertProofTempCapacity('/isolated/tmp', {
      statfs: () => ({ bavail: 1, bsize: PROOF_MIN_TEMP_FREE_BYTES - 1 }),
    }),
    /refused to start/i,
  );
  assert.equal(assertProofTempCapacity('/isolated/tmp', {
    statfs: () => ({ bavail: 2n, bsize: BigInt(PROOF_MIN_TEMP_FREE_BYTES / 2) }),
  }), PROOF_MIN_TEMP_FREE_BYTES);
});

test('forensic reserve is physically written, fsynced, larger than the bounded log, and mode 0600', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-runtime-reserve-'));
  try {
    const file = createProofForensicReserve(home);
    const stats = statSync(file);
    assert.equal(file, proofForensicReservePath(home));
    assert.equal(stats.size, PROOF_FORENSIC_RESERVE_BYTES);
    assert.ok(stats.size > PROOF_DAEMON_LOG_MAX_BYTES);
    if (process.platform !== 'win32') {
      assert.equal(stats.mode & 0o777, 0o600);
      // Writing every block (rather than ftruncate) makes the reserve usable on
      // genuine ENOSPC. st_blocks is in 512-byte units on POSIX.
      if (typeof stats.blocks === 'number') {
        assert.ok(stats.blocks * 512 >= PROOF_FORENSIC_RESERVE_BYTES);
      }
    }
    assert.throws(() => createProofForensicReserve(home), /EEXIST|already exists/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('retained daemon log is bounded and strips isolated credentials', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-runtime-safety-'));
  const accessToken = 'sk-ant-oat01-' + 'proof-access-token-that-must-not-remain';
  const webhookSecret = 'proof-webhook-secret-that-must-not-remain';
  const shortSecret = 'Z9!';
  try {
    createProofForensicReserve(home);
    mkdirSync(path.join(home, 'state'), { recursive: true });
    writeFileSync(
      path.join(home, 'state', 'claude-auth.json'),
      JSON.stringify({ accessToken, recoveryCode: shortSecret }),
      'utf8',
    );
    const capturedSecrets = proofCredentialFileRedactions(home);
    assert.ok(capturedSecrets.includes(shortSecret));
    const noisyPrefix = 'x'.repeat(PROOF_DAEMON_LOG_MAX_BYTES + 512);
    const file = persistProofDaemonLogForForensics({
      home,
      log: `${noisyPrefix}\nBearer ${accessToken}\nsecret=${webhookSecret}`
        + `\nshort=${shortSecret}\nENOSPC crash tail`,
      exactSecrets: [...capturedSecrets, webhookSecret],
    });
    const retained = readFileSync(file, 'utf8');
    assert.match(retained, /daemon log truncated/i);
    assert.match(retained, /ENOSPC.*tail/s);
    assert.doesNotMatch(retained, /proof-access-token|proof-webhook-secret|Z9!/);
    assert.match(retained, /█/u);
    assert.ok(Buffer.byteLength(retained, 'utf8') <= PROOF_DAEMON_LOG_MAX_BYTES);
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('incremental forensic capture persists only its bounded redacted UTF-8-safe tail', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-runtime-capture-tail-'));
  const accessToken = 'sk-ant-oat01-' + 'bounded-capture-access-token';
  const capture = new BoundedProofLogCapture({
    forensicMaxBytes: 256,
    forensicRedactionOverlapBytes: 64,
    scenarioMaxBytes: 1024,
  });
  try {
    createProofForensicReserve(home);
    const payload = Buffer.from(
      `${'prefix🙂'.repeat(80)}\nBearer ${accessToken}\nUTF8_FINAL_🙂`,
      'utf8',
    );
    for (let offset = 0; offset < payload.length; offset += 3) {
      capture.append(payload.subarray(offset, Math.min(payload.length, offset + 3)));
    }
    const boundedTail = capture.forensicLog([accessToken]);
    assert.ok(Buffer.byteLength(boundedTail, 'utf8') <= 256);
    assert.doesNotMatch(boundedTail, /�/u);
    assert.ok(boundedTail.endsWith('UTF8_FINAL_🙂'));

    const file = persistProofDaemonLogForForensics({
      home,
      log: boundedTail,
      exactSecrets: [accessToken],
      maxBytes: 256,
    });
    const retained = readFileSync(file, 'utf8');
    assert.ok(Buffer.byteLength(retained, 'utf8') <= 256);
    assert.match(retained, /daemon log capture retained a bounded tail/i);
    assert.match(retained, /█/u);
    assert.doesNotMatch(retained, /bounded-capture-access-token/);
    assert.ok(retained.endsWith('UTF8_FINAL_🙂'));
    assert.doesNotMatch(retained, /�/u);
  } finally {
    capture.clear();
    rmSync(home, { recursive: true, force: true });
  }
});

test('forensic redaction precedes both raw-ring and final-tail boundaries', () => {
  const secret = 'violet-cipher-7Qx9-nonpattern-key!';
  assert.equal(secret.length, 34);

  const wrapped = new BoundedProofLogCapture({
    forensicMaxBytes: 128,
    forensicRedactionOverlapBytes: 64,
    scenarioMaxBytes: 1024,
  });
  // The 192-byte raw ring starts inside the first secret. Redacting
  // the five complete copies shrinks the snapshot enough that the unmatched
  // first suffix would reach the final file unless the left overlap is removed.
  const wrappedPayload = Buffer.from(`${secret}${secret.repeat(5)}TAIL-END-1234567`, 'utf8');
  assert.equal(wrappedPayload.length, 220);
  for (let offset = 0; offset < wrappedPayload.length; offset += 11) {
    wrapped.append(wrappedPayload.subarray(offset, Math.min(offset + 11, wrappedPayload.length)));
  }
  const wrappedTail = wrapped.forensicLog([secret]);
  assert.ok(wrapped.stats().forensicRawDroppedBytes > 0);
  assert.doesNotMatch(wrappedTail, /violet|cipher|7Qx9|nonpattern|key!/);
  assert.ok(Buffer.byteLength(wrappedTail, 'utf8') <= 128);

  const mixedBoundary = new BoundedProofLogCapture({
    forensicMaxBytes: 128,
    forensicRedactionOverlapBytes: 64,
    scenarioMaxBytes: 1024,
  });
  const boundarySecret = `Z${'a'.repeat(50)}LEAKFRAGMENT!`;
  const expandingSecret = 'abbbbbbb';
  const shrinkingSecret = 'Q1234567890123456789012345678901';
  assert.equal(Buffer.byteLength(boundarySecret, 'utf8'), 64);
  const mixedPayload = `${boundarySecret}${shrinkingSecret.repeat(4)}x`;
  assert.equal(Buffer.byteLength(mixedPayload, 'utf8'), 193);
  mixedBoundary.append(mixedPayload);
  assert.equal(mixedBoundary.stats().forensicRawDroppedBytes, 1);
  const mixedTail = mixedBoundary.forensicLog([
    boundarySecret,
    expandingSecret,
    shrinkingSecret,
  ]);
  assert.doesNotMatch(mixedTail, /LEAKFRAGMENT!/);
  assert.ok(Buffer.byteLength(mixedTail, 'utf8') <= 128);

  const chainedBoundary = new BoundedProofLogCapture({
    forensicMaxBytes: 128,
    forensicRedactionOverlapBytes: 64,
    scenarioMaxBytes: 1024,
  });
  const firstSecret = 'AAAAAAAAAX';
  const adjacentSecret = 'QRSTUVWX';
  const crossBoundarySecret = 'abcXQRST';
  const chainedPayload = `${'p'.repeat(56)}${firstSecret}${adjacentSecret}`
    + `${shrinkingSecret.repeat(3)}${'x'.repeat(23)}`;
  assert.equal(Buffer.byteLength(chainedPayload, 'utf8'), 193);
  chainedBoundary.append(chainedPayload);
  const chainedTail = chainedBoundary.forensicLog([
    firstSecret,
    adjacentSecret,
    crossBoundarySecret,
    shrinkingSecret,
  ]);
  assert.doesNotMatch(
    chainedTail,
    /UVWX/,
    'an overlong boundary match cannot expose an adjacent credential suffix',
  );
  assert.ok(Buffer.byteLength(chainedTail, 'utf8') <= 128);

  const finalTail = new BoundedProofLogCapture({
    forensicMaxBytes: 128,
    forensicRedactionOverlapBytes: 64,
    scenarioMaxBytes: 1024,
  });
  const finalBoundaryPayload = `${'p'.repeat(50)}${secret}${'z'.repeat(100)}`;
  finalTail.append(finalBoundaryPayload);
  assert.equal(finalTail.stats().forensicRawDroppedBytes, 0);
  const finalBounded = finalTail.forensicLog([secret]);
  assert.doesNotMatch(finalBounded, /violet|cipher|7Qx9|nonpattern|key!/);
  assert.ok(Buffer.byteLength(finalBounded, 'utf8') <= 128);

  const partial = new BoundedProofLogCapture({
    forensicMaxBytes: 128,
    forensicRedactionOverlapBytes: 64,
    scenarioMaxBytes: 1024,
  });
  partial.append(`provider wrote ${secret.slice(0, 19)}`);
  assert.match(partial.forensicLog([secret]), /█$/u);
  assert.doesNotMatch(partial.forensicLog([secret]), /violet-cipher/);

  const internalized = new BoundedProofLogCapture({
    forensicMaxBytes: 256,
    forensicRedactionOverlapBytes: 64,
    scenarioMaxBytes: 1024,
  });
  internalized.append(`provider wrote ${secret.slice(0, 24)}`);
  internalized.append('\n[proof] spawning daemon after restart\nhealthy');
  const internalizedTail = internalized.forensicLog([secret]);
  assert.doesNotMatch(internalizedTail, /violet|cipher|7Qx9|nonpa/);
  assert.match(internalizedTail, /spawning daemon after restart/);

  const insufficient = new BoundedProofLogCapture({
    forensicMaxBytes: 128,
    forensicRedactionOverlapBytes: 16,
    scenarioMaxBytes: 1024,
  });
  assert.throws(
    () => insufficient.assertForensicRedactionCoverage([secret]),
    /overlap 16 bytes cannot cover an exact 34-byte secret/i,
  );
  assert.throws(() => insufficient.forensicLog([secret]), /cannot cover/i);

  wrapped.clear();
  mixedBoundary.clear();
  chainedBoundary.clear();
  finalTail.clear();
  partial.clear();
  internalized.clear();
  insufficient.clear();
});

test('exact forensic redaction is idempotent across marker collisions and self-overlap', () => {
  const collisionSecrets = ['REDACTED', '[REDACTED]', '████████'];
  const once = redactProofDaemonLog(
    'plain=REDACTED bracket=[REDACTED] blocks=████████',
    collisionSecrets,
  );
  for (const secret of collisionSecrets) assert.equal(once.includes(secret), false, secret);
  assert.equal(redactProofDaemonLog(once, collisionSecrets), once);
  assert.match(once, /▓/u, 'the preferred block is skipped when it belongs to a secret');

  const shortSecret = 'key1234';
  const shortRedacted = redactProofDaemonLog(`short=${shortSecret}`, [shortSecret]);
  assert.equal(shortRedacted.includes(shortSecret), false, 'short admitted values are never ignored');
  assert.match(shortRedacted, /█/u);

  const periodicSecret = 'orbit-7Q'.repeat(4);
  const periodic = redactProofDaemonLog(
    periodicSecret + periodicSecret.slice(0, 24),
    [periodicSecret],
  );
  assert.doesNotMatch(periodic, /orbit-7Q/);
  assert.equal(redactProofDaemonLog(periodic, [periodicSecret]), periodic);

  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-runtime-marker-collision-'));
  const markerSecret = 'daemon log truncated';
  try {
    createProofForensicReserve(home);
    const file = persistProofDaemonLogForForensics({
      home,
      log: 'x'.repeat(512),
      exactSecrets: [markerSecret],
      maxBytes: 128,
    });
    const retained = readFileSync(file, 'utf8');
    assert.equal(retained.includes(markerSecret), false, 'post-redaction marker text is re-scrubbed');
    assert.ok(Buffer.byteLength(retained, 'utf8') <= 128);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('final marker re-redaction cannot expand either retained log past its byte cap', () => {
  const secret = 'aaaaaaaa';
  const capture = new BoundedProofLogCapture({
    forensicMaxBytes: 128,
    forensicRedactionOverlapBytes: 64,
    scenarioMaxBytes: 1024,
  });
  capture.append('x'.repeat(512));
  const forensic = capture.forensicLog([secret]);
  assert.ok(Buffer.byteLength(forensic, 'utf8') <= 128);
  assert.doesNotMatch(forensic, /�/u);
  assert.ok(forensic.endsWith('x'.repeat(32)), 'the latest diagnostic tail remains available');

  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-runtime-marker-expansion-'));
  try {
    createProofForensicReserve(home);
    const file = persistProofDaemonLogForForensics({
      home,
      log: 'x'.repeat(512),
      exactSecrets: [secret],
      maxBytes: 128,
    });
    const retained = readFileSync(file, 'utf8');
    assert.ok(Buffer.byteLength(retained, 'utf8') <= 128);
    assert.doesNotMatch(retained, /�/u);
    assert.ok(retained.endsWith('x'.repeat(32)), 'the persisted crash tail remains available');
  } finally {
    capture.clear();
    rmSync(home, { recursive: true, force: true });
  }
});

test('captured file credentials still redact a log after restart sanitation', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-runtime-restart-'));
  const accessFile = path.join(home, 'state', 'codex-access-only.json');
  const accessToken = 'header.codex-proof-access-token.signature';
  try {
    createProofForensicReserve(home);
    mkdirSync(path.dirname(accessFile), { recursive: true });
    writeFileSync(accessFile, JSON.stringify({ version: 1, accessToken }), 'utf8');
    const captured = proofCredentialFileRedactions(home);
    rmSync(accessFile, { force: true }); // failed restart sanitizes before stop()
    const file = persistProofDaemonLogForForensics({
      home,
      log: `provider failed after using ${accessToken}`,
      exactSecrets: captured,
    });
    const retained = readFileSync(file, 'utf8');
    assert.doesNotMatch(retained, /codex-proof-access-token/);
    assert.match(retained, /█/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('retained log releases reserve before a constrained write, recovering from injected ENOSPC', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-runtime-enospc-'));
  try {
    createProofForensicReserve(home);
    let reserveReleased = false;
    const constrainedWrite = (file: string, contents: string): void => {
      if (!reserveReleased) {
        const error = new Error('simulated full proof volume') as NodeJS.ErrnoException;
        error.code = 'ENOSPC';
        throw error;
      }
      assert.equal(existsSync(proofForensicReservePath(home)), false);
      writeFileSync(file, contents, { encoding: 'utf8', mode: 0o600 });
    };
    assert.throws(
      () => constrainedWrite(path.join(home, 'would-fail.log'), 'tail'),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOSPC',
      'the injected volume is full while the reserve still occupies its blocks',
    );

    const file = persistProofDaemonLogForForensics({
      home,
      log: 'final ENOSPC diagnostic tail',
      operations: {
        beforeReleaseReserve: (target) => {
          assert.equal(existsSync(proofForensicReservePath(target)), true);
        },
        beforeWriteLog: () => {
          reserveReleased = !existsSync(proofForensicReservePath(home));
          assert.equal(reserveReleased, true, 'native release precedes native log creation');
        },
      },
    });
    assert.equal(reserveReleased, true);
    assert.equal(existsSync(proofForensicReservePath(home)), false);
    assert.equal(readFileSync(file, 'utf8'), 'final ENOSPC diagnostic tail');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('retained log fails closed when its preallocated reserve is missing', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-runtime-missing-reserve-'));
  try {
    assert.throws(
      () => persistProofDaemonLogForForensics({ home, log: 'untrusted evidence' }),
      /forensic reserve is missing/i,
    );
    assert.equal(existsSync(path.join(home, 'proof-daemon.log')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('reserve release cannot follow a proof home swapped to an outside symlink after identity check', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-runtime-release-race-'));
  const pinnedHome = `${home}-pinned`;
  const outside = mkdtempSync(path.join(os.tmpdir(), 'proof-outside-reserve-victim-'));
  const outsideReserve = proofForensicReservePath(outside);
  const outsideLog = path.join(outside, 'proof-daemon.log');
  const identity = captureProofHomeIdentity(home);
  let persistenceError = '';
  try {
    createProofForensicReserve(home);
    writeFileSync(outsideReserve, 'outside reserve must survive', 'utf8');
    try {
      persistProofDaemonLogForForensics({
        home,
        identity,
        log: 'must not escape',
        operations: {
          beforeReleaseReserve: (target) => {
            renameSync(target, pinnedHome);
            symlinkSync(outside, target, 'dir');
          },
        },
      });
      assert.fail('home replacement must fail closed');
    } catch (error) {
      persistenceError = error instanceof Error ? error.message : String(error);
    }

    assert.match(persistenceError, /descriptor-anchored.*release|not a no-follow regular directory|identity changed/i);
    assert.equal(readFileSync(outsideReserve, 'utf8'), 'outside reserve must survive');
    assert.equal(existsSync(outsideLog), false, 'no retained log is written through the outside symlink');
    assert.equal(existsSync(proofForensicReservePath(pinnedHome)), true, 'the pinned reserve was not released ambiguously');

    const cleanup = sanitizeProofHomeForForensics(home, { identity });
    assert.equal(cleanup.status, 'failed');
    assert.equal(cleanup.homeExists, true);
    const checks = proofDaemonStopChecks('claude', {
      retainedHome: true,
      forensicLog: { status: 'failed', error: persistenceError },
      cleanup,
    });
    assert.equal(checks.length, 2);
    assert.equal(checks.every((check) => !check.pass), true, 'log and cleanup uncertainty stay report-visible');
  } finally {
    try { unlinkSync(home); } catch { /* not a symlink */ }
    if (existsSync(pinnedHome) && !existsSync(home)) renameSync(pinnedHome, home);
    rmSync(home, { recursive: true, force: true });
    rmSync(pinnedHome, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('retained log cannot follow a pre-planted symlink to an outside victim', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-runtime-log-link-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'proof-outside-log-victim-'));
  const victim = path.join(outside, 'victim.log');
  const logPath = path.join(home, 'proof-daemon.log');
  try {
    createProofForensicReserve(home);
    writeFileSync(victim, 'outside victim must survive', 'utf8');
    symlinkSync(victim, logPath);
    assert.throws(
      () => persistProofDaemonLogForForensics({ home, log: 'attacker-controlled replacement' }),
      /EEXIST|exist|symbolic|symlink/i,
    );
    assert.equal(readFileSync(victim, 'utf8'), 'outside victim must survive');
    assert.equal(lstatSync(logPath).isSymbolicLink(), true);
  } finally {
    try { unlinkSync(logPath); } catch { /* absent */ }
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('retained log never overwrites a pre-existing in-home file', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-runtime-log-existing-'));
  const logPath = path.join(home, 'proof-daemon.log');
  try {
    createProofForensicReserve(home);
    writeFileSync(logPath, 'existing evidence', 'utf8');
    assert.throws(
      () => persistProofDaemonLogForForensics({ home, log: 'replacement evidence' }),
      /EEXIST|exist/i,
    );
    assert.equal(readFileSync(logPath, 'utf8'), 'existing evidence');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('state identity replacement fails closed and sanitation unlinks only the state symlink', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-runtime-state-swap-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'proof-outside-state-victim-'));
  const outsideCredential = path.join(outside, 'claude-auth.json');
  try {
    mkdirSync(path.join(home, 'state'));
    const identity = captureProofStateIdentity(captureProofHomeIdentity(home));
    writeFileSync(outsideCredential, JSON.stringify({ accessToken: 'outside-secret-must-survive' }), 'utf8');
    rmSync(path.join(home, 'state'), { recursive: true });
    symlinkSync(outside, path.join(home, 'state'), 'dir');

    assert.throws(() => assertProofHomeIdentity(identity), /state directory.*(not.*regular|changed)/i);
    assert.deepEqual(
      proofCredentialFileRedactions(home),
      [],
      'an intermediate state symlink is never followed while capturing redactions',
    );
    const cleanup = sanitizeProofHomeForForensics(home, { identity });
    assert.equal(cleanup.status, 'failed', 'the identity violation remains report-visible');
    assert.equal(existsSync(path.join(home, 'state')), false, 'the in-home symlink itself was unlinked');
    assert.match(readFileSync(outsideCredential, 'utf8'), /outside-secret-must-survive/);
  } finally {
    try { unlinkSync(path.join(home, 'state')); } catch { /* absent */ }
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('credential-file symlinks are neither read nor followed during sanitation', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-runtime-credential-link-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'proof-outside-credential-victim-'));
  const victim = path.join(outside, 'credential.json');
  const linkedCredential = path.join(home, 'state', 'claude-auth.json');
  try {
    mkdirSync(path.dirname(linkedCredential));
    writeFileSync(victim, JSON.stringify({ accessToken: 'outside-credential-must-survive' }), 'utf8');
    symlinkSync(victim, linkedCredential);
    const identity = captureProofStateIdentity(captureProofHomeIdentity(home));

    assert.deepEqual(proofCredentialFileRedactions(home), []);
    const cleanup = sanitizeProofHomeForForensics(home, { identity });
    assert.equal(cleanup.status, 'succeeded');
    assert.equal(existsSync(linkedCredential), false);
    assert.match(readFileSync(victim, 'utf8'), /outside-credential-must-survive/);
  } finally {
    try { unlinkSync(linkedCredential); } catch { /* absent */ }
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('operation-bound helper rejects the legacy arbitrary-root CLI and exposes no source at dispatch', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-runtime-bound-helper-'));
  const outside = mkdtempSync('/var/tmp/clemmy-proof-helper-victim-');
  const credential = path.join(home, 'state', 'claude-auth.json');
  const outsideVictim = path.join(outside, 'must-survive.txt');
  try {
    mkdirSync(path.dirname(credential));
    writeFileSync(credential, '{"accessToken":"remove-only-inside-bound-home"}', 'utf8');
    writeFileSync(outsideVictim, 'outside victim survives', 'utf8');
    const outsideStats = statSync(outside);
    const cleanup = sanitizeProofHomeForForensics(home, {
      identity: captureProofStateIdentity(captureProofHomeIdentity(home)),
      operations: {
        beforeNativeHelperDispatch: (executable, operation) => {
          assert.equal(operation, 'sanitize');
          assert.deepEqual(
            readdirSync(path.dirname(executable)),
            ['proof-fs'],
            'captured source and binding header are unlinked before dispatch',
          );
          const retarget = spawnSync(executable, [
            'remove',
            '/var/tmp',
            path.basename(outside),
            String(outsideStats.dev),
            String(outsideStats.ino),
          ], { encoding: 'utf8' });
          assert.equal(retarget.status, 64);
          assert.match(retarget.stderr, /no command-line authority/i);
        },
      },
    });
    assert.equal(cleanup.status, 'succeeded');
    assert.equal(existsSync(credential), false);
    assert.equal(readFileSync(outsideVictim, 'utf8'), 'outside victim survives');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a stale same-inode helper descriptor from one leg cannot influence the next leg', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-runtime-stale-helper-'));
  const state = path.join(home, 'state');
  const credential = path.join(state, 'claude-auth.json');
  let staleFd: number | undefined;
  let stalePath = '';
  let staleInode = 0;
  let secondPath = '';
  try {
    mkdirSync(state);
    writeFileSync(credential, '{"accessToken":"first-leg"}', 'utf8');
    const identity = captureProofStateIdentity(captureProofHomeIdentity(home));
    const first = sanitizeProofHomeForForensics(home, {
      identity,
      operations: {
        beforeNativeHelperDispatch: (executable) => {
          stalePath = executable;
          chmodSync(executable, 0o700);
          staleFd = openSync(executable, 'r+');
          staleInode = fstatSync(staleFd).ino;
          chmodSync(executable, 0o500);
        },
      },
    });
    assert.equal(first.status, 'succeeded');
    assert.equal(existsSync(stalePath), false, 'the first helper pathname is unlinked after its operation');
    assert.ok(staleFd !== undefined);

    const staleStats = fstatSync(staleFd);
    const overwritten = Buffer.alloc(staleStats.size, 0);
    let offset = 0;
    while (offset < overwritten.length) {
      const count = writeSync(staleFd, overwritten, offset, overwritten.length - offset, offset);
      assert.ok(count > 0);
      offset += count;
    }
    assert.equal(fstatSync(staleFd).ino, staleInode, 'replacement kept the exact stale inode');

    writeFileSync(credential, '{"accessToken":"second-leg"}', 'utf8');
    const second = sanitizeProofHomeForForensics(home, {
      identity,
      operations: {
        beforeNativeHelperDispatch: (executable) => { secondPath = executable; },
      },
    });
    assert.equal(second.status, 'succeeded');
    assert.notEqual(secondPath, stalePath, 'the later leg receives a fresh private executable');
    assert.equal(existsSync(credential), false, 'stale modified bytes cannot fake later sanitation');
  } finally {
    if (staleFd !== undefined) closeSync(staleFd);
    rmSync(home, { recursive: true, force: true });
  }
});

test('same-inode helper replacement at the last explicit pre-dispatch seam fails closed', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-runtime-helper-race-'));
  const credential = path.join(home, 'state', 'claude-auth.json');
  let beforeInode = 0;
  let afterInode = 0;
  try {
    mkdirSync(path.dirname(credential));
    writeFileSync(credential, '{"accessToken":"must-remain-on-helper-tamper"}', 'utf8');
    const cleanup = sanitizeProofHomeForForensics(home, {
      identity: captureProofStateIdentity(captureProofHomeIdentity(home)),
      operations: {
        beforeNativeHelperDispatch: (executable) => {
          beforeInode = lstatSync(executable).ino;
          chmodSync(executable, 0o700);
          writeFileSync(executable, '#!/bin/sh\nexit 0\n', 'utf8');
          chmodSync(executable, 0o500);
          afterInode = lstatSync(executable).ino;
        },
      },
    });
    assert.equal(beforeInode, afterInode, 'the adversary changed bytes without replacing the inode');
    assert.equal(cleanup.status, 'failed');
    assert.equal(existsSync(credential), true, 'unverified helper bytes never receive cleanup authority');
    assert.match((cleanup.errors ?? []).join('; '), /helper bytes changed|verified open executable/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('independent post-success verification rejects a no-op-equivalent sanitation outcome', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-runtime-helper-noop-'));
  const credential = path.join(home, 'state', 'claude-auth.json');
  try {
    mkdirSync(path.dirname(credential));
    writeFileSync(credential, '{"accessToken":"initial"}', 'utf8');
    const cleanup = sanitizeProofHomeForForensics(home, {
      identity: captureProofStateIdentity(captureProofHomeIdentity(home)),
      operations: {
        afterNativeHelperDispatch: (_executable, operation) => {
          assert.equal(operation, 'sanitize');
          writeFileSync(credential, '{"accessToken":"no-op-equivalent-remnant"}', 'utf8');
        },
      },
    });
    assert.equal(cleanup.status, 'failed');
    assert.equal(existsSync(credential), true);
    assert.match((cleanup.errors ?? []).join('; '), /credential path still present/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('native cleanup never builds or dispatches while provider termination is unproven', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-runtime-provider-active-'));
  const credential = path.join(home, 'state', 'claude-auth.json');
  let dispatched = false;
  try {
    mkdirSync(path.dirname(credential));
    writeFileSync(credential, '{"accessToken":"active-provider"}', 'utf8');
    const cleanup = sanitizeProofHomeForForensics(home, {
      identity: captureProofStateIdentity(captureProofHomeIdentity(home)),
      operations: {
        assertProviderTerminated: () => {
          throw new Error('provider termination is unproven');
        },
        beforeNativeHelperDispatch: () => { dispatched = true; },
      },
    });
    assert.equal(cleanup.status, 'failed');
    assert.equal(dispatched, false);
    assert.equal(existsSync(credential), true);
    assert.match((cleanup.errors ?? []).join('; '), /provider termination is unproven/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('sanitation cannot follow state swapped to an outside directory by the cleanup race seam', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-runtime-native-state-race-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'proof-outside-native-state-victim-'));
  const state = path.join(home, 'state');
  const outsideCredential = path.join(outside, 'claude-auth.json');
  try {
    mkdirSync(state);
    writeFileSync(path.join(state, 'claude-auth.json'), '{"accessToken":"in-home"}', 'utf8');
    writeFileSync(outsideCredential, '{"accessToken":"outside-must-survive"}', 'utf8');
    const identity = captureProofStateIdentity(captureProofHomeIdentity(home));
    let raced = false;
    const cleanup = sanitizeProofHomeForForensics(home, {
      identity,
      operations: {
        beforeNativeCleanup: (target, intent) => {
          assert.equal(target, home);
          assert.equal(intent, 'sanitize-and-retain');
          rmSync(state, { recursive: true });
          symlinkSync(outside, state, 'dir');
          raced = true;
        },
      },
    });

    assert.equal(raced, true);
    assert.equal(cleanup.status, 'failed', 'the state identity violation is reported');
    assert.equal(cleanup.homeExists, true, 'sanitize-and-retain disposition remains truthful');
    assert.equal(existsSync(state), false, 'the replacement symlink itself is removed without traversal');
    assert.match(readFileSync(outsideCredential, 'utf8'), /outside-must-survive/);
    assert.match((cleanup.errors ?? []).join('; '), /state.*not.*pinned|state.*regular directory/i);

    const checks = proofDaemonStopChecks('codex', {
      retainedHome: true,
      forensicLog: { status: 'persisted', path: path.join(home, 'proof-daemon.log') },
      cleanup,
    });
    assert.equal(checks.length, 2);
    assert.equal(checks[0]?.pass, true, 'the independent log disposition remains truthful');
    assert.equal(checks[1]?.pass, false, 'the cleanup race remains a failed release check');
  } finally {
    try { unlinkSync(state); } catch { /* absent or regular directory */ }
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('sanitation and recursive deletion failures are verified and reportable', () => {
  const sanitationHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-runtime-cleanup-eacces-'));
  const removalHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-runtime-remove-eacces-'));
  try {
    const credential = path.join(sanitationHome, 'state', 'claude-auth.json');
    mkdirSync(path.dirname(credential));
    writeFileSync(credential, JSON.stringify({ accessToken: 'credential-remains-visible' }), 'utf8');
    const identity = captureProofStateIdentity(captureProofHomeIdentity(sanitationHome));
    const denyRemoval = (): never => {
      const error = new Error('permission denied') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    };
    const sanitation = sanitizeProofHomeForForensics(sanitationHome, {
      identity,
      operations: { beforeNativeCleanup: denyRemoval },
    });
    assert.equal(sanitation.status, 'failed');
    assert.equal(existsSync(credential), true);
    assert.match(proofCleanupFailure('retained proof-home', sanitation) ?? '', /EACCES.*still present/i);

    const removal = removeProofHome(removalHome, {
      identity: captureProofHomeIdentity(removalHome),
      operations: { beforeNativeCleanup: denyRemoval },
    });
    assert.equal(removal.status, 'failed');
    assert.equal(removal.homeExists, true);
    assert.match(proofCleanupFailure('green proof-home', removal) ?? '', /EACCES/i);
  } finally {
    rmSync(sanitationHome, { recursive: true, force: true });
    rmSync(removalHome, { recursive: true, force: true });
  }
});

test('cleanup refuses to become a recursive delete API outside a proof home', () => {
  const outside = mkdtempSync(path.join(os.tmpdir(), 'proof-outside-cleanup-victim-'));
  const victim = path.join(outside, 'keep.txt');
  try {
    writeFileSync(victim, 'keep me', 'utf8');
    const cleanup = removeProofHome(outside);
    assert.equal(cleanup.status, 'failed');
    assert.equal(cleanup.homeExists, true);
    assert.equal(readFileSync(victim, 'utf8'), 'keep me');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('child close/pipe EOF tracking captures a large final stderr tail before snapshot', async () => {
  const marker = 'PROOF_FINAL_STDERR_MARKER';
  const payloadBytes = 4 * 1024 * 1024;
  const child = spawn(process.execPath, ['-e', [
    "const fs = require('node:fs');",
    `fs.writeSync(2, Buffer.alloc(${payloadBytes}, 120));`,
    `fs.writeSync(2, Buffer.from(${JSON.stringify(marker)}));`,
    'process.exit(23);',
  ].join('')], { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  const tracker = trackProofChildOutput(child, (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  await awaitProofChildOutputDrain(tracker, 10_000);
  const captured = Buffer.concat(chunks);
  assert.equal(captured.length, payloadBytes + Buffer.byteLength(marker));
  assert.equal(captured.subarray(-Buffer.byteLength(marker)).toString('utf8'), marker);
  assert.deepEqual(tracker.pending(), []);
});

test('child output keeps draining after bounded capture overflows and retains the final tail', async () => {
  const marker = 'BOUNDED_DRAIN_FINAL_🙂';
  const payloadBytes = 512 * 1024;
  const child = spawn(process.execPath, ['-e', [
    "const fs = require('node:fs');",
    `fs.writeSync(2, Buffer.alloc(${payloadBytes}, 120));`,
    `fs.writeSync(2, Buffer.from(${JSON.stringify(marker)}));`,
    'process.exit(31);',
  ].join('')], { stdio: ['ignore', 'pipe', 'pipe'] });
  const capture = new BoundedProofLogCapture({ forensicMaxBytes: 2048, scenarioMaxBytes: 4096 });
  const tracker = trackProofChildOutput(child, (chunk) => capture.append(chunk));

  await awaitProofChildOutputDrain(tracker, 10_000);
  const evidence = capture.stats();
  assert.equal(evidence.totalBytes, payloadBytes + Buffer.byteLength(marker));
  assert.equal(evidence.forensicStoredBytes, 2048);
  assert.equal(evidence.currentScenarioStoredBytes, 4096);
  assert.equal(evidence.overflowed, true);
  assert.ok(evidence.scenarioDroppedBytes > 0);
  assert.deepEqual(tracker.pending(), []);
  assert.ok(capture.forensicLog().endsWith(marker));
  assert.throws(() => capture.scenarioLog(), /proof log evidence is incomplete/i);
  capture.clear();
});

test('scenario overflow remains sticky red teardown evidence after the next mark', () => {
  const capture = new BoundedProofLogCapture({ forensicMaxBytes: 128, scenarioMaxBytes: 16 });
  capture.append('this scenario exceeds its bound');
  const captureError = capture.overflowError();
  assert.match(captureError ?? '', /evidence is incomplete/i);
  capture.markScenario();
  capture.append('next is fine');
  assert.equal(capture.scenarioLog(), 'next is fine');
  assert.equal(capture.stats().overflowed, true, 'marking cannot erase prior evidence loss');

  const checks = proofDaemonStopChecks('codex', {
    retainedHome: true,
    forensicLog: { status: 'persisted', path: '/tmp/clemmy-proof-x/proof-daemon.log' },
    cleanup: { intent: 'sanitize-and-retain', status: 'succeeded', homeExists: true },
    logCapture: capture.stats(),
    ...(captureError ? { logCaptureError: captureError } : {}),
  });
  const boundedCheck = checks.find((check) => check.name.includes('semantic memory bound'));
  assert.equal(boundedCheck?.pass, false);
  assert.match(boundedCheck?.detail ?? '', /scenarioDropped=\d+.*evidence is incomplete/i);
  capture.clear();
});

test('bounded capture counters become explicit green teardown evidence', () => {
  const capture = new BoundedProofLogCapture({ forensicMaxBytes: 128, scenarioMaxBytes: 256 });
  capture.append('ordinary daemon output\n');
  const [boundedCheck] = proofDaemonStopChecks('glm', {
    retainedHome: false,
    forensicLog: { status: 'not-requested' },
    cleanup: { intent: 'remove', status: 'succeeded', homeExists: false },
    logCapture: capture.stats(),
  });
  assert.equal(boundedCheck?.pass, true);
  assert.match(boundedCheck?.name ?? '', /semantic memory bound/i);
  assert.match(boundedCheck?.detail ?? '', /total=23.*scenarioDropped=0.*overflowPeriods=0/i);
  capture.clear();
});

test('retained-log persistence failures become report-visible failing checks', () => {
  const [failed] = proofDaemonStopChecks('claude', {
    retainedHome: true,
    forensicLog: { status: 'failed', error: 'ENOSPC after reserve release' },
    cleanup: { intent: 'sanitize-and-retain', status: 'succeeded', homeExists: true },
  });
  assert.equal(failed?.pass, false);
  assert.match(failed?.name ?? '', /claude retained daemon log persisted/i);
  assert.match(failed?.detail ?? '', /ENOSPC/);

  assert.deepEqual(proofDaemonStopChecks('codex', {
    retainedHome: false,
    forensicLog: { status: 'not-requested' },
    cleanup: { intent: 'remove', status: 'succeeded', homeExists: false },
  }), []);

  const cleanupChecks = proofDaemonStopChecks('glm', {
    retainedHome: false,
    forensicLog: { status: 'not-requested' },
    cleanup: {
      intent: 'remove',
      status: 'failed',
      homeExists: true,
      errors: ['EACCES: permission denied'],
    },
  });
  assert.equal(cleanupChecks.length, 1);
  assert.equal(cleanupChecks[0]?.pass, false);
  assert.match(cleanupChecks[0]?.name ?? '', /glm proof-home cleanup/i);
  assert.match(cleanupChecks[0]?.detail ?? '', /EACCES/);

  const missingRetainedHome = proofDaemonStopChecks('claude', {
    retainedHome: true,
    forensicLog: { status: 'persisted', path: '/tmp/clemmy-proof-x/proof-daemon.log' },
    cleanup: { intent: 'sanitize-and-retain', status: 'succeeded', homeExists: false },
  });
  assert.equal(missingRetainedHome.length, 2);
  assert.equal(missingRetainedHome[0]?.pass, true, 'the log check remains independently truthful');
  assert.equal(missingRetainedHome[1]?.pass, false);
  assert.match(missingRetainedHome[1]?.detail ?? '', /homeExists=false/);
});
