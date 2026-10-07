import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { assertWindowsPrivateFilesystem } from '../windows-private-filesystem.js';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-result-payload-storage-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const storage = await import('./result-payload-storage.js');

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

function payload(label: string) {
  const value = {
    successful: true,
    data: { records: [{ id: label, blob: `${label}::${'x'.repeat(storage.RESULT_PAYLOAD_INLINE_MAX_BYTES + 64)}` }] },
    meta: { complete: true },
  };
  const rawJson = JSON.stringify(value);
  const digest = createHash('sha256').update(rawJson).digest('hex');
  return {
    value,
    rawJson,
    digest,
    byteCount: Buffer.byteLength(rawJson, 'utf8'),
  };
}

function metadata(value: ReturnType<typeof payload>): storage.DurableResultPayloadMetadata {
  return {
    rawLocation: 'tool_output:test-only-opaque-location',
    rawPayloadJson: storage.RESULT_PAYLOAD_SPILL_SENTINEL,
    rawPayloadSha256: value.digest,
    rawByteCount: value.byteCount,
    rejectionReason: null,
  };
}

test('spill paths reject traversal and every fixed directory component rejects symlinks', () => {
  assert.throws(
    () => storage.resultPayloadFilePath('../outside'),
    /canonical SHA-256/,
  );

  const candidate = payload('directory-symlink');
  const nonCanonical = ` ${candidate.rawJson}`;
  assert.throws(
    () => storage.persistSpilledResultPayload({
      rawJson: nonCanonical,
      digest: createHash('sha256').update(nonCanonical).digest('hex'),
      byteCount: Buffer.byteLength(nonCanonical, 'utf8'),
    }),
    /canonical oversized JSON bytes/,
  );
  const outside = mkdtempSync(path.join(os.tmpdir(), 'clem-result-payload-outside-'));
  const payloadRoot = path.join(TMP_HOME, 'state', 'result-payloads');
  symlinkSync(outside, payloadRoot, 'dir');
  try {
    assert.throws(
      () => storage.persistSpilledResultPayload(candidate),
      /not a real directory/,
    );
    assert.deepEqual(readdirSync(outside), [], 'authoritative bytes never followed the directory symlink');
  } finally {
    unlinkSync(payloadRoot);
    rmSync(outside, { recursive: true, force: true });
  }
});

test('oversized canonical JSON is atomically stored privately and identical bytes dedupe', () => {
  const candidate = payload('dedupe');
  storage.persistSpilledResultPayload(candidate);
  const target = storage.resultPayloadFilePath(candidate.digest);
  const first = lstatSync(target);
  assert.equal(first.isFile(), true);
  assert.equal(first.isSymbolicLink(), false);
  if (process.platform === 'win32') assertWindowsPrivateFilesystem(target, lstatSync(target, { bigint: true }), 'file');
  else assert.equal(first.mode & 0o777, 0o600);
  assert.equal(first.size, candidate.byteCount);
  assert.equal(path.basename(target), `${candidate.digest}.json`);

  storage.persistSpilledResultPayload(candidate);
  const files = readdirSync(storage.RESULT_PAYLOAD_SPILL_DIRECTORY);
  assert.deepEqual(files, [`${candidate.digest}.json`]);
  assert.equal(
    files.some((name) => name.endsWith('.tmp')),
    false,
    'the fsync+rename publish leaves no scratch payload behind',
  );
  assert.deepEqual(storage.readDurableResultPayload(metadata(candidate)), {
    status: 'ok',
    rawJson: candidate.rawJson,
    value: candidate.value,
    storage: 'spill',
  });
});

test('missing, tampered, wrong, weak-permissioned, and symlinked spill files fail closed', () => {
  const missing = payload('missing');
  storage.persistSpilledResultPayload(missing);
  unlinkSync(storage.resultPayloadFilePath(missing.digest));
  assert.equal(storage.readDurableResultPayload(metadata(missing)).status, 'missing');

  const tampered = payload('tampered');
  storage.persistSpilledResultPayload(tampered);
  writeFileSync(storage.resultPayloadFilePath(tampered.digest), `${tampered.rawJson}x`, { mode: 0o600 });
  assert.equal(storage.readDurableResultPayload(metadata(tampered)).status, 'corrupt');

  const wrong = payload('wrong-target');
  const other = payload('wrong-source');
  storage.persistSpilledResultPayload(wrong);
  storage.persistSpilledResultPayload(other);
  copyFileSync(
    storage.resultPayloadFilePath(other.digest),
    storage.resultPayloadFilePath(wrong.digest),
  );
  if (process.platform === 'win32') assertWindowsPrivateFilesystem(storage.resultPayloadFilePath(wrong.digest), lstatSync(storage.resultPayloadFilePath(wrong.digest), { bigint: true }), 'file', true);
  else chmodSync(storage.resultPayloadFilePath(wrong.digest), 0o600);
  assert.equal(storage.readDurableResultPayload(metadata(wrong)).status, 'corrupt');

  const weak = payload('weak-mode');
  storage.persistSpilledResultPayload(weak);
  if (process.platform === 'win32') {
    const program = String.raw`$ErrorActionPreference='Stop'; [Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false,$true); $p=[Console]::In.ReadToEnd(); $a=Get-Acl -LiteralPath $p; $s=[System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'); $r=[System.Security.AccessControl.FileSystemAccessRule]::new($s,[System.Security.AccessControl.FileSystemRights]::Read,[System.Security.AccessControl.AccessControlType]::Allow); $a.AddAccessRule($r); Set-Acl -LiteralPath $p -AclObject $a`;
    const result = spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')], { input: storage.resultPayloadFilePath(weak.digest), encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 4096 });
    assert.equal(result.status, 0, 'controlled fixture ACL weakening must complete');
  } else chmodSync(storage.resultPayloadFilePath(weak.digest), 0o644);
  assert.equal(storage.readDurableResultPayload(metadata(weak)).status, 'corrupt');

  const linked = payload('symlink-file');
  storage.persistSpilledResultPayload(linked);
  const linkedTarget = storage.resultPayloadFilePath(linked.digest);
  const real = `${linkedTarget}.saved`;
  renameSync(linkedTarget, real);
  symlinkSync(real, linkedTarget);
  try {
    assert.equal(storage.readDurableResultPayload(metadata(linked)).status, 'corrupt');
    assert.throws(
      () => storage.persistSpilledResultPayload(linked),
      /refusing unsafe existing result payload/,
    );
  } finally {
    unlinkSync(linkedTarget);
    renameSync(real, linkedTarget);
  }
});

test('the empty off-row sentinel cannot collide with any serializable inline JSON value', () => {
  for (const value of [null, '', 0, false, [], {}, { value: undefined }]) {
    const canonical = JSON.stringify(value);
    assert.notEqual(canonical, storage.RESULT_PAYLOAD_SPILL_SENTINEL);
    assert.ok(canonical === undefined || Buffer.byteLength(canonical, 'utf8') > 0);
  }
  assert.equal(
    storage.readDurableResultPayload({
      rawLocation: 'tool_output:invalid-inline-sentinel',
      rawPayloadJson: storage.RESULT_PAYLOAD_SPILL_SENTINEL,
      rawPayloadSha256: createHash('sha256').update('').digest('hex'),
      rawByteCount: 0,
      rejectionReason: null,
    }).status,
    'corrupt',
  );
});
