import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertWindowsPrivateFilesystem } from './windows-private-filesystem.js';

const WINDOWS = process.platform === 'win32';
const TEMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-private-ntfs-test-'));
process.env.CLEMENTINE_HOME = TEMP_HOME;
process.env.CLEMMY_TEST_PRIVATE_ACL_DIAGNOSTICS = '1';
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_AUTHORITY_SEAL_KEY = 'a'.repeat(64);
const storage = await import('./harness/result-payload-storage.js');
const staged = await import('../integrations/composio/staged-file-blob-store.js');
const authority = await import('./harness/authority-encrypted-payload-store.js');
test.after(() => rmSync(TEMP_HOME, { recursive: true, force: true }));

function fixture(): string {
  const root = mkdtempSync(path.join(TEMP_HOME, 'fixture-'));
  assertWindowsPrivateFilesystem(root, lstatSync(root, { bigint: true }), 'directory', true);
  return root;
}

function weakenFixtureAcl(target: string): void {
  const script = String.raw`$ErrorActionPreference='Stop'; [Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false,$true); $p=[Console]::In.ReadToEnd(); $a=Get-Acl -LiteralPath $p; $sid=[System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'); $r=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::ReadAndExecute,[System.Security.AccessControl.AccessControlType]::Allow); $a.AddAccessRule($r); Set-Acl -LiteralPath $p -AclObject $a`;
  const command = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(command, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    input: target, encoding: 'utf8', timeout: 10_000, maxBuffer: 4096, windowsHide: true,
  });
  assert.equal(result.status, 0, 'controlled fixture ACL weakening must complete');
}

test('Windows NTFS private directory and open temp retain exact handle identity and readable bytes', { skip: !WINDOWS }, () => {
  const root = fixture();
  const target = path.join(root, 'private & % quote \' 文件');
  const fd = openSync(target, 'wx', 0o600);
  try {
    assertWindowsPrivateFilesystem(target, fstatSync(fd, { bigint: true }), 'file', true);
    writeSync(fd, Buffer.from('controlled private bytes'));
    assertWindowsPrivateFilesystem(target, fstatSync(fd, { bigint: true }), 'file');
  } finally { closeSync(fd); }
  assert.throws(() => assertWindowsPrivateFilesystem(path.join(root, 'invalid " literal 文件'), lstatSync(target, { bigint: true }), 'file', true), /could not be verified/, 'Windows-invalid double quote is data and cannot execute a command');
  assert.equal(readFileSync(target, 'utf8'), 'controlled private bytes');
  assertWindowsPrivateFilesystem(root, lstatSync(root, { bigint: true }), 'directory');
});

test('Windows private ACL checks reject broadened access without repairing retained files', { skip: !WINDOWS }, () => {
  const root = fixture(); const target = path.join(root, 'retained'); writeFileSync(target, 'private');
  assertWindowsPrivateFilesystem(target, lstatSync(target, { bigint: true }), 'file', true);
  weakenFixtureAcl(target);
  assert.throws(() => assertWindowsPrivateFilesystem(target, lstatSync(target, { bigint: true }), 'file'), /could not be verified/);
});

test('Windows ACL hardening rejects mismatched inode, hard-link aliases and directory junctions before mutation', { skip: !WINDOWS }, () => {
  const root = fixture(); const left = path.join(root, 'left'); const right = path.join(root, 'right');
  writeFileSync(left, 'left'); writeFileSync(right, 'right');
  assert.throws(() => assertWindowsPrivateFilesystem(right, lstatSync(left, { bigint: true }), 'file', true), /could not be verified/);
  assert.throws(() => assertWindowsPrivateFilesystem(right, lstatSync(right, { bigint: true }), 'file'), /could not be verified/, 'unprotected right entry was not hardened through a mismatched identity');
  linkSync(left, path.join(root, 'alias'));
  assert.throws(() => assertWindowsPrivateFilesystem(left, lstatSync(left, { bigint: true }), 'file', true), /could not be verified/);
  const outside = path.join(root, 'outside'); mkdirSync(outside);
  const junction = path.join(root, 'junction'); symlinkSync(outside, junction, 'junction');
  assert.throws(() => assertWindowsPrivateFilesystem(junction, lstatSync(junction, { bigint: true }), 'directory', true), /could not be verified/);
  assert.throws(() => assertWindowsPrivateFilesystem(outside, lstatSync(outside, { bigint: true }), 'directory'), /could not be verified/, 'junction refusal did not change its target ACL');
});

test('Windows staged publication and materialization require current private ACLs', { skip: !WINDOWS }, () => {
  const root = fixture(); const writer = staged.createStagedFileBlobWriter({ storeDirectory: path.join(root, 'store') });
  writer.write(Buffer.from('controlled staged bytes')); const sealed = writer.seal();
  const published = staged.publishStagedFileBlob({ storeDirectory: writer.storeDirectory, sealed });
  staged.materializeStagedFileBlob({ blob: published, destinationDirectory: path.join(root, 'destination'), destinationName: 'copy' });
  assertWindowsPrivateFilesystem(published.blobPath, lstatSync(published.blobPath, { bigint: true }), 'file');
  const weak = staged.createStagedFileBlobWriter({ storeDirectory: writer.storeDirectory }); weak.write(Buffer.from('weak temp'));
  const weakSealed = weak.seal(); weakenFixtureAcl(weakSealed.temporaryPath);
  assert.throws(() => staged.publishStagedFileBlob({ storeDirectory: writer.storeDirectory, sealed: weakSealed }), /sealed temp/);
});

test('Windows oversized result roundtrip rejects later ACL broadening', { skip: !WINDOWS }, () => {
  const rawJson = JSON.stringify({ controlled: 'x'.repeat(storage.RESULT_PAYLOAD_INLINE_MAX_BYTES) });
  const digest = createHash('sha256').update(rawJson).digest('hex'); const byteCount = Buffer.byteLength(rawJson);
  storage.persistSpilledResultPayload({ rawJson, digest, byteCount });
  const metadata = { rawLocation: 'tool_output:test-private-ntfs', rawPayloadJson: '', rawPayloadSha256: digest, rawByteCount: byteCount, rejectionReason: null };
  assert.equal(storage.readDurableResultPayload(metadata).status, 'ok');
  weakenFixtureAcl(storage.resultPayloadFilePath(digest));
  assert.equal(storage.readDurableResultPayload(metadata).status, 'corrupt');
  assert.throws(() => storage.persistSpilledResultPayload({ rawJson, digest, byteCount }), /unsafe existing/);
});

test('Windows encrypted model snapshot roundtrip retains exact binding and refuses later ACL broadening', { skip: !WINDOWS }, (t) => {
  const bytes = Buffer.from('controlled snapshot: café 日本語 🐕\n'.repeat(2_000));
  const bindingDigest = createHash('sha256').update('controlled model snapshot binding').digest('hex');
  const reference = authority.persistAuthorityEncryptedPayload({ payloadKind: 'model_request_snapshot', bindingDigest, bytes });
  const target = authority.authorityEncryptedPayloadFilePath(reference.payloadId);
  assert.equal(readFileSync(target).includes(Buffer.from('controlled snapshot:')), false, 'durable snapshot contains ciphertext rather than private plaintext');
  assertWindowsPrivateFilesystem(target, lstatSync(target, { bigint: true }), 'file');
  assert.deepEqual(authority.readAuthorityEncryptedPayload({ reference, payloadKind: 'model_request_snapshot', bindingDigest }), { status: 'ok', bytes });
  assert.deepEqual(authority.persistAuthorityEncryptedPayload({ payloadKind: 'model_request_snapshot', bindingDigest, bytes }), reference, 'replay adopts exact immutable ciphertext');
  assert.equal(authority.readAuthorityEncryptedPayload({ reference, payloadKind: 'model_request_snapshot', bindingDigest: '0'.repeat(64) }).status, 'binding_mismatch');
  weakenFixtureAcl(target);
  assert.equal(authority.readAuthorityEncryptedPayload({ reference, payloadKind: 'model_request_snapshot', bindingDigest }).status, 'corrupt');
  let refusals = 0;
  authority.setAuthorityEncryptedPayloadPublicationReadObserverForTests(() => {
    refusals += 1;
    if (refusals > 1) throw new Error('weak ACL was incorrectly retried as a publication transition');
  });
  const started = performance.now();
  try {
    assert.throws(() => authority.persistAuthorityEncryptedPayload({ payloadKind: 'model_request_snapshot', bindingDigest, bytes }), (error: unknown) => error instanceof authority.AuthorityEncryptedPayloadError && error.code === 'authority_payload_storage_failed');
  } finally { authority.setAuthorityEncryptedPayloadPublicationReadObserverForTests(null); }
  const elapsed = performance.now() - started;
  assert.equal(refusals, 1, 'retained weak ACL cannot enter the hard-link retry loop');
  assert.ok(elapsed < 60_000, 'one bounded current ACL observation must refuse within its command allowances');
  t.diagnostic(`Windows weak-ACL replay refusal ${Math.ceil(elapsed)} ms; no repeated publication observations`);
});

test('Windows ACL helper cannot be used as a permission bypass on POSIX', { skip: WINDOWS }, () => {
  assert.throws(() => assertWindowsPrivateFilesystem(TEMP_HOME, lstatSync(TEMP_HOME, { bigint: true }), 'directory', true), /another platform/);
});
