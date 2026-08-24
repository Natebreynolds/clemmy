import { appendFileSync, readFileSync } from 'node:fs';
import {
  createStagedFileBlobWriter,
  publishStagedFileBlob,
} from './staged-file-blob-store.js';

const storeDirectory = process.env.CLEMMY_STAGED_BLOB_RACE_STORE;
const readyFile = process.env.CLEMMY_STAGED_BLOB_RACE_READY;
if (!storeDirectory || !readyFile) throw new Error('staged blob race paths are required');

appendFileSync(readyFile, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600 });
const waitArray = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 10_000;
while (readFileSync(readyFile, 'utf8').trim().split('\n').filter(Boolean).length < 2) {
  if (Date.now() >= deadline) throw new Error('staged blob race peer did not become ready');
  Atomics.wait(waitArray, 0, 0, 5);
}

const bytes = Buffer.from(`same-staged-blob::${'b'.repeat(4 * 1024 * 1024)}`, 'utf8');
const writer = createStagedFileBlobWriter({ storeDirectory });
writer.write(bytes);
const published = publishStagedFileBlob({ storeDirectory, sealed: writer.seal() });
process.stdout.write(JSON.stringify(published));
