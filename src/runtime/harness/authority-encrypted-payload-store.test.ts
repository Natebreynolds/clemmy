import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-authority-payload-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_AUTHORITY_SEAL_KEY = 'a'.repeat(64);

const store = await import('./authority-encrypted-payload-store.js');
const RECLAMATION_DB = new Database(':memory:');
RECLAMATION_DB.exec(`
  CREATE TABLE staged_transfer_plans (
    manifest_payload_id TEXT NOT NULL UNIQUE
  );
  CREATE TABLE physical_dispatch_return_checkpoints (
    payload_id TEXT NOT NULL UNIQUE
  );
  CREATE TABLE staged_transfer_secret_payloads (
    payload_id TEXT NOT NULL UNIQUE
  );
`);

test.after(() => {
  RECLAMATION_DB.close();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('many-file manifest beyond the row-seal ceiling remains ciphertext-only and round-trips exactly', () => {
  const signedNeedle = 'https://object.example/private?X-Amz-Credential=DO_NOT_PERSIST';
  const manifest = Buffer.from(JSON.stringify({
    files: Array.from({ length: 700 }, (_, index) => ({
      pointer: `/attachments/${index}`,
      signedUrl: `${signedNeedle}-${index}`,
      digest: String(index).padStart(64, '0'),
    })),
  }), 'utf8');
  assert.ok(manifest.byteLength > 32_000);
  const bindingDigest = 'b'.repeat(64);
  const reference = store.persistAuthorityEncryptedPayload({
    payloadKind: 'staged_transfer_manifest',
    bindingDigest,
    bytes: manifest,
  });

  assert.ok(reference.chunkCount > 1);
  const durableBytes = readFileSync(store.authorityEncryptedPayloadFilePath(reference.payloadId));
  assert.equal(durableBytes.includes(signedNeedle), false, 'signed URLs never enter plaintext durable bytes');
  assert.equal(durableBytes.includes('DO_NOT_PERSIST'), false);
  assert.deepEqual(
    store.readAuthorityEncryptedPayload({
      reference,
      payloadKind: 'staged_transfer_manifest',
      bindingDigest,
    }),
    { status: 'ok', bytes: manifest },
  );
});

test('a huge provider return is chunked above 32 KiB and exact binding is mandatory', () => {
  const bytes = Buffer.from(JSON.stringify({
    successful: true,
    data: { blob: 'z'.repeat(2 * 1024 * 1024) },
  }), 'utf8');
  const bindingDigest = 'c'.repeat(64);
  const reference = store.persistAuthorityEncryptedPayload({
    payloadKind: 'physical_return',
    bindingDigest,
    bytes,
  });
  assert.ok(reference.plaintextBytes > 32_000);
  assert.ok(reference.chunkCount > 100);
  assert.equal(
    store.readAuthorityEncryptedPayload({
      reference,
      payloadKind: 'physical_return',
      bindingDigest: 'd'.repeat(64),
    }).status,
    'binding_mismatch',
  );
  const opened = store.readAuthorityEncryptedPayload({
    reference,
    payloadKind: 'physical_return',
    bindingDigest,
  });
  assert.equal(opened.status, 'ok');
  if (opened.status === 'ok') assert.deepEqual(opened.bytes, bytes);
});

test('tamper and weak permissions fail closed without returning partial plaintext', () => {
  const bindingDigest = 'e'.repeat(64);
  const first = store.persistAuthorityEncryptedPayload({
    payloadKind: 'staged_signed_url',
    bindingDigest,
    bytes: Buffer.from('https://signed.example/one?secret=yes'),
  });
  const firstPath = store.authorityEncryptedPayloadFilePath(first.payloadId);
  const tampered = readFileSync(firstPath);
  tampered[tampered.byteLength - 4] ^= 1;
  writeFileSync(firstPath, tampered, { mode: 0o600 });
  assert.equal(
    store.readAuthorityEncryptedPayload({
      reference: first,
      payloadKind: 'staged_signed_url',
      bindingDigest,
    }).status,
    'corrupt',
  );

  const second = store.persistAuthorityEncryptedPayload({
    payloadKind: 'staged_signed_url',
    bindingDigest: 'f'.repeat(64),
    bytes: Buffer.from('https://signed.example/two?secret=yes'),
  });
  chmodSync(store.authorityEncryptedPayloadFilePath(second.payloadId), 0o644);
  assert.equal(
    store.readAuthorityEncryptedPayload({
      reference: second,
      payloadKind: 'staged_signed_url',
      bindingDigest: 'f'.repeat(64),
    }).status,
    'corrupt',
  );
});

test('oversized payloads refuse before any durable write', () => {
  assert.throws(
    () => store.persistAuthorityEncryptedPayload({
      payloadKind: 'physical_return',
      bindingDigest: '1'.repeat(64),
      bytes: Buffer.alloc(store.AUTHORITY_ENCRYPTED_PAYLOAD_MAX_PLAINTEXT_BYTES + 1),
    }),
    (error: unknown) => error instanceof store.AuthorityEncryptedPayloadError
      && error.code === 'authority_payload_too_large',
  );
});

function runRaceWriter(readyFile: string): Promise<store.AuthorityEncryptedPayloadReference> {
  const fixture = fileURLToPath(new URL('./authority-encrypted-payload-store-race.fixture.ts', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
      env: {
        ...process.env,
        CLEMENTINE_HOME: TMP_HOME,
        CLEMMY_TEST_ISOLATED_HOME: '1',
        CLEMMY_AUTHORITY_SEAL_KEY: 'a'.repeat(64),
        CLEMMY_AUTHORITY_PAYLOAD_RACE_READY: readyFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`authority payload race writer failed (${code}): ${stderr.slice(0, 240)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as store.AuthorityEncryptedPayloadReference);
      } catch (error) {
        reject(error);
      }
    });
  });
}

test('two processes publishing the same payload adopt one no-replace ciphertext reference', async () => {
  const readyFile = path.join(TMP_HOME, 'race-ready');
  writeFileSync(readyFile, '', { mode: 0o600 });
  const [left, right] = await Promise.all([
    runRaceWriter(readyFile),
    runRaceWriter(readyFile),
  ]);
  assert.deepEqual(left, right, 'both processes return the winning ciphertext metadata');
  for (const reference of [left, right]) {
    const opened = store.readAuthorityEncryptedPayload({
      reference,
      payloadKind: 'physical_return',
      bindingDigest: '9'.repeat(64),
    });
    assert.equal(opened.status, 'ok');
    if (opened.status === 'ok') {
      assert.equal(opened.bytes.byteLength, Buffer.byteLength(`race-payload::${'r'.repeat(4 * 1024 * 1024)}`));
    }
  }
});

const RECLAIM_NOW_MS = Date.now();

function makeOld(filePath: string): void {
  const old = new Date(
    RECLAIM_NOW_MS - store.AUTHORITY_ENCRYPTED_PAYLOAD_ORPHAN_HORIZON_MS - 60_000,
  );
  utimesSync(filePath, old, old);
}

function sweep(db: Database.Database = RECLAMATION_DB) {
  return store.reclaimOrphanedAuthorityEncryptedPayloads({
    db,
    nowMs: RECLAIM_NOW_MS,
    orphanHorizonMs: store.AUTHORITY_ENCRYPTED_PAYLOAD_ORPHAN_HORIZON_MS,
    scanLimit: store.AUTHORITY_ENCRYPTED_PAYLOAD_RECLAIM_MAX_SCAN_LIMIT,
  });
}

test('aged manifest, physical-return, and signed-URL payloads with exact DB references are retained', () => {
  const manifest = store.persistAuthorityEncryptedPayload({
    payloadKind: 'staged_transfer_manifest',
    bindingDigest: '2'.repeat(64),
    bytes: Buffer.from('ciphertext owner fixture: manifest'),
  });
  const checkpoint = store.persistAuthorityEncryptedPayload({
    payloadKind: 'physical_return',
    bindingDigest: '3'.repeat(64),
    bytes: Buffer.from('ciphertext owner fixture: checkpoint'),
  });
  const signedUrl = store.persistAuthorityEncryptedPayload({
    payloadKind: 'staged_signed_url',
    bindingDigest: '4'.repeat(64),
    bytes: Buffer.from('ciphertext owner fixture: signed URL'),
  });
  const manifestPath = store.authorityEncryptedPayloadFilePath(manifest.payloadId);
  const checkpointPath = store.authorityEncryptedPayloadFilePath(checkpoint.payloadId);
  const signedUrlPath = store.authorityEncryptedPayloadFilePath(signedUrl.payloadId);
  makeOld(manifestPath);
  makeOld(checkpointPath);
  makeOld(signedUrlPath);
  RECLAMATION_DB.prepare(`INSERT INTO staged_transfer_plans (manifest_payload_id) VALUES (?)`)
    .run(manifest.payloadId);
  RECLAMATION_DB.prepare(`INSERT INTO physical_dispatch_return_checkpoints (payload_id) VALUES (?)`)
    .run(checkpoint.payloadId);
  RECLAMATION_DB.prepare(`INSERT INTO staged_transfer_secret_payloads (payload_id) VALUES (?)`)
    .run(signedUrl.payloadId);

  const result = sweep();
  assert.equal(result.referenceSchemaAvailable, true);
  assert.ok(result.retainedReferenced >= 3);
  assert.equal(existsSync(manifestPath), true);
  assert.equal(existsSync(checkpointPath), true);
  assert.equal(existsSync(signedUrlPath), true);
});

test('a fresh unreferenced encrypted payload is retained until the full horizon passes', () => {
  const fresh = store.persistAuthorityEncryptedPayload({
    payloadKind: 'staged_signed_url',
    bindingDigest: '4'.repeat(64),
    bytes: Buffer.from('fresh sealed authority fixture'),
  });
  const freshPath = store.authorityEncryptedPayloadFilePath(fresh.payloadId);
  const result = sweep();
  assert.ok(result.retainedFresh >= 1);
  assert.equal(existsSync(freshPath), true);
});

test('an old payload with no owner in either exact table is reclaimed', () => {
  const orphan = store.persistAuthorityEncryptedPayload({
    payloadKind: 'physical_return',
    bindingDigest: '5'.repeat(64),
    bytes: Buffer.from('old orphan sealed authority fixture'),
  });
  const orphanPath = store.authorityEncryptedPayloadFilePath(orphan.payloadId);
  makeOld(orphanPath);

  const result = sweep();
  assert.ok(result.deletedPayloadFiles >= 1);
  assert.equal(existsSync(orphanPath), false);
});

test('missing reference schema is not treated as proof that an aged payload is orphaned', () => {
  const orphan = store.persistAuthorityEncryptedPayload({
    payloadKind: 'physical_return',
    bindingDigest: '6'.repeat(64),
    bytes: Buffer.from('schema-unavailable sealed authority fixture'),
  });
  const orphanPath = store.authorityEncryptedPayloadFilePath(orphan.payloadId);
  makeOld(orphanPath);
  const emptyDb = new Database(':memory:');
  try {
    const result = sweep(emptyDb);
    assert.equal(result.referenceSchemaAvailable, false);
    assert.equal(result.deletedPayloadFiles, 0);
    assert.equal(existsSync(orphanPath), true);
  } finally {
    emptyDb.close();
  }
});

test('unsafe and symlinked canonical-looking entries are ignored', () => {
  const weakPath = path.join(
    store.AUTHORITY_ENCRYPTED_PAYLOAD_DIRECTORY,
    `${'7'.repeat(64)}.sealed.json`,
  );
  writeFileSync(weakPath, 'opaque', { mode: 0o600 });
  chmodSync(weakPath, 0o644);
  makeOld(weakPath);

  let symlinkPath: string | null = null;
  if (process.platform !== 'win32') {
    const target = path.join(TMP_HOME, 'outside-authority-payload');
    writeFileSync(target, 'opaque', { mode: 0o600 });
    symlinkPath = path.join(
      store.AUTHORITY_ENCRYPTED_PAYLOAD_DIRECTORY,
      `${'8'.repeat(64)}.sealed.json`,
    );
    symlinkSync(target, symlinkPath);
  }

  const result = sweep();
  assert.ok(result.ignoredUnsafe >= (symlinkPath === null ? 1 : 2));
  assert.equal(existsSync(weakPath), true);
  if (symlinkPath !== null) assert.equal(existsSync(symlinkPath), true);
});

test('only horizon-aged safe temp files are cleaned and scanning is bounded', () => {
  const oldTemp = path.join(
    store.AUTHORITY_ENCRYPTED_PAYLOAD_DIRECTORY,
    `.${'9'.repeat(64)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const freshTemp = path.join(
    store.AUTHORITY_ENCRYPTED_PAYLOAD_DIRECTORY,
    `.${'a'.repeat(64)}.${process.pid}.${randomUUID()}.tmp`,
  );
  writeFileSync(oldTemp, 'opaque', { mode: 0o600 });
  writeFileSync(freshTemp, 'opaque', { mode: 0o600 });
  makeOld(oldTemp);

  const result = sweep();
  assert.ok(result.deletedTempFiles >= 1);
  assert.equal(existsSync(oldTemp), false);
  assert.equal(existsSync(freshTemp), true);

  const bounded = store.reclaimOrphanedAuthorityEncryptedPayloads({
    db: RECLAMATION_DB,
    nowMs: RECLAIM_NOW_MS,
    orphanHorizonMs: store.AUTHORITY_ENCRYPTED_PAYLOAD_ORPHAN_HORIZON_MS,
    scanLimit: 1,
  });
  assert.ok(bounded.scannedEntries <= 1);
});
