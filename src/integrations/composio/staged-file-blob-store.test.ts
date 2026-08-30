import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createStagedFileBlobWriter,
  materializeStagedFileBlob,
  publishStagedFileBlob,
  snapshotAllowedLocalFile,
  StagedFileBlobError,
  verifyStagedFileMaterialization,
} from './staged-file-blob-store.js';

function fixture(): { root: string; allowed: string; store: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clemmy-staged-file-'));
  const allowed = path.join(root, 'allowed');
  const store = path.join(root, 'store');
  mkdirSync(allowed, { mode: 0o700 });
  return { root, allowed, store };
}

test('local snapshot is allowlisted, content-addressed, exact, and 0600', (t) => {
  const { root, allowed, store } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from('deterministic staged bytes\n', 'utf8');
  const source = path.join(allowed, 'report.txt');
  writeFileSync(source, bytes);

  const snapshot = snapshotAllowedLocalFile({
    sourcePath: source,
    allowRoots: [allowed],
    storeDirectory: store,
  });

  assert.equal(snapshot.sourceBasename, 'report.txt');
  assert.equal(snapshot.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(snapshot.md5, createHash('md5').update(bytes).digest('hex'));
  assert.equal(snapshot.byteCount, bytes.byteLength);
  assert.equal(path.basename(snapshot.blobPath), `sha256-${snapshot.sha256}`);
  assert.deepEqual(readFileSync(snapshot.blobPath), bytes);
  assert.equal(lstatSync(snapshot.blobPath).mode & 0o777, 0o600);
  assert.equal(lstatSync(store).mode & 0o777, 0o700);
  assert.equal(JSON.stringify(snapshot).includes(source), false, 'checkpoint omits the original local path');
});

test('explicit allow roots reject outside paths and symlink escapes', (t) => {
  const { root, allowed, store } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outside = path.join(root, 'outside.txt');
  writeFileSync(outside, 'outside');
  assert.throws(
    () => snapshotAllowedLocalFile({ sourcePath: outside, allowRoots: [allowed], storeDirectory: store }),
    (error: unknown) => error instanceof StagedFileBlobError && error.code === 'source_not_allowed',
  );

  if (process.platform !== 'win32') {
    const escape = path.join(allowed, 'escape.txt');
    symlinkSync(outside, escape);
    assert.throws(
      () => snapshotAllowedLocalFile({ sourcePath: escape, allowRoots: [allowed], storeDirectory: store }),
      (error: unknown) => error instanceof StagedFileBlobError && error.code === 'source_not_allowed',
    );
  }
});

test('credential segments, credential basenames, and hard-link aliases are denied', (t) => {
  const { root, allowed, store } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ssh = path.join(allowed, '.ssh');
  mkdirSync(ssh);
  const privateKey = path.join(ssh, 'id_ed25519');
  writeFileSync(privateKey, 'not-a-real-key');
  assert.throws(
    () => snapshotAllowedLocalFile({ sourcePath: privateKey, allowRoots: [allowed], storeDirectory: store }),
    (error: unknown) => error instanceof StagedFileBlobError && error.code === 'sensitive_source',
  );

  const envFile = path.join(allowed, '.env.production');
  writeFileSync(envFile, 'TOKEN=canary');
  assert.throws(
    () => snapshotAllowedLocalFile({ sourcePath: envFile, allowRoots: [allowed], storeDirectory: store }),
    (error: unknown) => error instanceof StagedFileBlobError && error.code === 'sensitive_source',
  );

  if (process.platform !== 'win32') {
    const original = path.join(allowed, 'original.txt');
    const alias = path.join(allowed, 'alias.txt');
    writeFileSync(original, 'hard-linked');
    linkSync(original, alias);
    assert.throws(
      () => snapshotAllowedLocalFile({ sourcePath: alias, allowRoots: [allowed], storeDirectory: store }),
      (error: unknown) => error instanceof StagedFileBlobError && error.code === 'source_not_regular',
    );
  }
});

test('seal then publish supports durable checkpointing and idempotent content reuse', (t) => {
  const { root, store } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from('provider download bytes');

  const firstWriter = createStagedFileBlobWriter({ storeDirectory: store });
  firstWriter.write(bytes.subarray(0, 8));
  firstWriter.write(bytes.subarray(8));
  const sealed = firstWriter.seal({
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteCount: bytes.byteLength,
  });
  assert.equal(existsSync(sealed.temporaryPath), true, 'fsynced temp survives as a recovery checkpoint');
  const first = publishStagedFileBlob({ storeDirectory: store, sealed });
  assert.equal(existsSync(sealed.temporaryPath), false);
  assert.deepEqual(readFileSync(first.blobPath), bytes);

  const secondWriter = createStagedFileBlobWriter({ storeDirectory: store });
  secondWriter.write(bytes);
  const secondSealed = secondWriter.seal();
  const second = publishStagedFileBlob({ storeDirectory: store, sealed: secondSealed });
  assert.equal(second.blobPath, first.blobPath);
  assert.equal(existsSync(secondSealed.temporaryPath), false, 'duplicate temp is durably removed');
});

test('managed materialization copies to one private 0600 inode and exact replay adopts it', (t) => {
  const { root, allowed, store } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(allowed, 'download.bin');
  const bytes = Buffer.from('one independently materialized file\n', 'utf8');
  writeFileSync(source, bytes, { mode: 0o600 });
  const blob = snapshotAllowedLocalFile({
    sourcePath: source,
    allowRoots: [allowed],
    storeDirectory: store,
  });
  const destinationDirectory = path.join(root, 'materialized', 'plan-owner');
  const destinationName = '000003-acde0123456789ab-download.bin';
  const first = materializeStagedFileBlob({ blob, destinationDirectory, destinationName });
  assert.deepEqual(first, {
    sha256: blob.sha256,
    md5: blob.md5,
    byteCount: blob.byteCount,
    disposition: 'published',
  });
  assert.equal('materializedPath' in first, false);
  const destination = path.join(destinationDirectory, destinationName);
  assert.deepEqual(readFileSync(destination), bytes);
  assert.equal(lstatSync(destinationDirectory).mode & 0o777, 0o700);
  assert.equal(lstatSync(destination).mode & 0o777, 0o600);
  assert.equal(lstatSync(destination).nlink, 1);
  assert.equal(lstatSync(blob.blobPath).nlink, 1, 'blob store source keeps its single-link invariant');
  assert.notEqual(lstatSync(destination).ino, lstatSync(blob.blobPath).ino, 'destination is a byte copy, not a source hard link');

  assert.equal(materializeStagedFileBlob({
    blob,
    destinationDirectory,
    destinationName,
  }).disposition, 'adopted');
  assert.equal(verifyStagedFileMaterialization({
    blob,
    destinationDirectory,
    destinationName,
  }).disposition, 'adopted');
});

test('restart verification reconciles an exact post-link crash alias', (t) => {
  if (process.platform === 'win32') return;
  const { root, allowed, store } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(allowed, 'crash.bin');
  writeFileSync(source, 'crash-safe materialization', { mode: 0o600 });
  const blob = snapshotAllowedLocalFile({
    sourcePath: source,
    allowRoots: [allowed],
    storeDirectory: store,
  });
  const destinationDirectory = path.join(root, 'materialized', 'crash-owner');
  const destinationName = '000005-acde0123456789ab-crash.bin';
  materializeStagedFileBlob({ blob, destinationDirectory, destinationName });
  const destination = path.join(destinationDirectory, destinationName);
  const crashAlias = path.join(destinationDirectory, '.materialize-deadbeef-0000.part');
  const unrelatedOrphan = path.join(destinationDirectory, '.materialize-feedface-0000.part');
  linkSync(destination, crashAlias);
  writeFileSync(unrelatedOrphan, 'unpublished crash temp', { mode: 0o600 });
  assert.equal(lstatSync(destination).nlink, 2, 'fixture represents crash after link and before temp unlink');

  verifyStagedFileMaterialization({ blob, destinationDirectory, destinationName });
  assert.equal(existsSync(crashAlias), false, 'restart removes only the exact final-inode temp alias');
  assert.equal(existsSync(unrelatedOrphan), true, 'restart never adopts or deletes an unrelated temp inode');
  assert.equal(lstatSync(destination).nlink, 1);
  assert.deepEqual(readFileSync(destination), readFileSync(blob.blobPath));
});

test('managed materialization never replaces a conflicting destination', (t) => {
  const { root, allowed, store } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(allowed, 'expected.bin');
  writeFileSync(source, 'expected bytes', { mode: 0o600 });
  const blob = snapshotAllowedLocalFile({
    sourcePath: source,
    allowRoots: [allowed],
    storeDirectory: store,
  });
  const destinationDirectory = path.join(root, 'materialized', 'conflict-owner');
  mkdirSync(destinationDirectory, { recursive: true, mode: 0o700 });
  const destinationName = '000007-acde0123456789ab-expected.bin';
  const destination = path.join(destinationDirectory, destinationName);
  const conflicting = Buffer.from('pre-existing unrelated bytes', 'utf8');
  writeFileSync(destination, conflicting, { mode: 0o600 });

  assert.throws(
    () => materializeStagedFileBlob({ blob, destinationDirectory, destinationName }),
    (error: unknown) => error instanceof StagedFileBlobError && error.code === 'storage_error',
  );
  assert.deepEqual(readFileSync(destination), conflicting);
  assert.equal(lstatSync(destination).nlink, 1);
  assert.equal(lstatSync(blob.blobPath).nlink, 1);
});

function runBlobRaceWriter(input: { store: string; readyFile: string }): Promise<{
  blobPath: string;
  sha256: string;
  md5: string;
  byteCount: number;
}> {
  const fixturePath = fileURLToPath(new URL('./staged-file-blob-store-race.fixture.ts', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', fixturePath], {
      env: {
        ...process.env,
        CLEMMY_STAGED_BLOB_RACE_STORE: input.store,
        CLEMMY_STAGED_BLOB_RACE_READY: input.readyFile,
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
        reject(new Error(`staged blob race writer failed (${code}): ${stderr.slice(0, 240)}`));
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch (error) { reject(error); }
    });
  });
}

function runPublicationOrderProbe(store: string): Promise<{
  blobPath: string;
  sha256: string;
  md5: string;
  byteCount: number;
}> {
  const moduleUrl = new URL('./staged-file-blob-store.ts', import.meta.url).href;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';

      const originalLink = fs.linkSync.bind(fs);
      const originalFchmod = fs.fchmodSync.bind(fs);
      let publishedLinkCreated = false;
      fs.linkSync = (...args) => {
        const result = originalLink(...args);
        publishedLinkCreated = true;
        return result;
      };
      fs.fchmodSync = (...args) => {
        if (publishedLinkCreated) {
          throw new Error('publisher mutated inode metadata after publication');
        }
        return originalFchmod(...args);
      };
      syncBuiltinESMExports();

      const blobStore = await import(process.env.CLEMMY_STAGED_BLOB_MODULE_URL);
      const writer = blobStore.createStagedFileBlobWriter({
        storeDirectory: process.env.CLEMMY_STAGED_BLOB_ORDER_STORE,
      });
      writer.write(Buffer.from('publication ordering probe'));
      const published = blobStore.publishStagedFileBlob({
        storeDirectory: process.env.CLEMMY_STAGED_BLOB_ORDER_STORE,
        sealed: writer.seal(),
      });
      process.stdout.write(JSON.stringify(published));
    `], {
      env: {
        ...process.env,
        CLEMMY_STAGED_BLOB_MODULE_URL: moduleUrl,
        CLEMMY_STAGED_BLOB_ORDER_STORE: store,
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
        reject(new Error(`staged blob publication-order probe failed (${code}): ${stderr.slice(0, 240)}`));
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch (error) { reject(error); }
    });
  });
}

function releasePublishedBlobHardLinkFromPeer(
  hardLinkPath: string,
): { ready: Promise<void>; done: Promise<void> } {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import { unlinkSync } from 'node:fs';
    const hardLinkPath = process.env.CLEMMY_TEST_TRANSITIONAL_STAGED_BLOB_LINK;
    if (!hardLinkPath) process.exit(2);
    process.stdout.write('ready\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
    unlinkSync(hardLinkPath);
  `], {
    env: {
      ...process.env,
      CLEMMY_TEST_TRANSITIONAL_STAGED_BLOB_LINK: hardLinkPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (!readySettled && stdout.includes('ready\n')) {
      readySettled = true;
      resolveReady();
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', (error) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(error);
      }
      reject(error);
    });
    child.once('exit', (code) => {
      if (code !== 0) {
        const error = new Error(`transitional staged blob peer failed (${code}): ${stderr.slice(0, 240)}`);
        if (!readySettled) {
          readySettled = true;
          rejectReady(error);
        }
        reject(error);
        return;
      }
      if (!readySettled) {
        readySettled = true;
        rejectReady(new Error('transitional staged blob peer exited before becoming ready'));
      }
      resolve();
    });
  });
  return { ready, done };
}

test('two processes publish one exact content-addressed blob without replacement', async (t) => {
  const { root, store } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const readyFile = path.join(root, 'race-ready');
  writeFileSync(readyFile, '', { mode: 0o600 });
  const [left, right] = await Promise.all([
    runBlobRaceWriter({ store, readyFile }),
    runBlobRaceWriter({ store, readyFile }),
  ]);
  assert.deepEqual(left, right);
  assert.equal(lstatSync(left.blobPath).nlink, 1);
  assert.equal(lstatSync(left.blobPath).mode & 0o777, 0o600);
  assert.equal(readFileSync(left.blobPath).byteLength, left.byteCount);
  assert.equal(createHash('sha256').update(readFileSync(left.blobPath)).digest('hex'), left.sha256);
});

test('publication performs no canonical inode metadata mutation after the no-replace link is visible', async (t) => {
  const { root, store } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const published = await runPublicationOrderProbe(store);
  assert.equal(lstatSync(published.blobPath).nlink, 1);
  assert.equal(lstatSync(published.blobPath).mode & 0o777, 0o600);
  assert.equal(createHash('sha256').update(readFileSync(published.blobPath)).digest('hex'), published.sha256);
});

test('a competing publisher waits out the exact hard-link transition without weakening ordinary reads', async (t) => {
  if (process.platform === 'win32') return;
  const { root, store } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from('causal staged-blob publication transition');

  const firstWriter = createStagedFileBlobWriter({ storeDirectory: store });
  firstWriter.write(bytes);
  const first = publishStagedFileBlob({
    storeDirectory: store,
    sealed: firstWriter.seal(),
  });
  const transientLink = path.join(store, `.staged-${randomUUID()}.part`);
  linkSync(first.blobPath, transientLink);
  assert.equal(lstatSync(first.blobPath).nlink, 2, 'fixture pins post-link/pre-unlink publication');

  const destinationDirectory = path.join(root, 'ordinary-reader');
  assert.throws(
    () => materializeStagedFileBlob({
      blob: first,
      destinationDirectory,
      destinationName: 'ordinary-reader.bin',
    }),
    (error: unknown) => error instanceof StagedFileBlobError
      && error.code === 'invalid_staged_blob',
    'ordinary consumers must keep refusing a multiply-linked canonical blob',
  );

  const secondWriter = createStagedFileBlobWriter({ storeDirectory: store });
  secondWriter.write(bytes);
  const secondSealed = secondWriter.seal();
  const peer = releasePublishedBlobHardLinkFromPeer(transientLink);
  await peer.ready;
  let replay;
  try {
    replay = publishStagedFileBlob({ storeDirectory: store, sealed: secondSealed });
  } finally {
    await peer.done;
    if (existsSync(transientLink)) unlinkSync(transientLink);
  }
  assert.deepEqual(replay!, first);
  assert.equal(existsSync(secondSealed.temporaryPath), false);
  assert.equal(lstatSync(first.blobPath).nlink, 1);
});

test('publish refuses tampered, linked, or weak-permission temp checkpoints', (t) => {
  const { root, store } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const tamperedWriter = createStagedFileBlobWriter({ storeDirectory: store });
  tamperedWriter.write(Buffer.from('expected'));
  const tampered = tamperedWriter.seal();
  writeFileSync(tampered.temporaryPath, 'changed');
  assert.throws(
    () => publishStagedFileBlob({ storeDirectory: store, sealed: tampered }),
    (error: unknown) => error instanceof StagedFileBlobError
      && (error.code === 'digest_mismatch' || error.code === 'invalid_staged_blob'),
  );
  assert.equal(existsSync(path.join(store, `sha256-${tampered.sha256}`)), false);

  const weakWriter = createStagedFileBlobWriter({ storeDirectory: store });
  weakWriter.write(Buffer.from('weak'));
  const weak = weakWriter.seal();
  chmodSync(weak.temporaryPath, 0o644);
  assert.throws(
    () => publishStagedFileBlob({ storeDirectory: store, sealed: weak }),
    (error: unknown) => error instanceof StagedFileBlobError && error.code === 'invalid_staged_blob',
  );
});

test('writer enforces byte limits before publishing partial bytes', (t) => {
  const { root, store } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const writer = createStagedFileBlobWriter({ storeDirectory: store, maxBytes: 4 });
  const temporaryPath = writer.temporaryPath;
  assert.throws(
    () => writer.write(Buffer.from('12345')),
    (error: unknown) => error instanceof StagedFileBlobError && error.code === 'blob_too_large',
  );
  assert.equal(existsSync(temporaryPath), false);
});
