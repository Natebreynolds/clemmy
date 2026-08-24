import { appendFileSync, readFileSync } from 'node:fs';
import {
  persistAuthorityEncryptedPayload,
} from './authority-encrypted-payload-store.js';

const readyFile = process.env.CLEMMY_AUTHORITY_PAYLOAD_RACE_READY;
if (!readyFile) throw new Error('race ready file is required');
appendFileSync(readyFile, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600 });
const waitArray = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 10_000;
while (readFileSync(readyFile, 'utf8').trim().split('\n').filter(Boolean).length < 2) {
  if (Date.now() >= deadline) throw new Error('race peer did not become ready');
  Atomics.wait(waitArray, 0, 0, 5);
}

const reference = persistAuthorityEncryptedPayload({
  payloadKind: 'physical_return',
  bindingDigest: '9'.repeat(64),
  bytes: Buffer.from(`race-payload::${'r'.repeat(4 * 1024 * 1024)}`, 'utf8'),
});
process.stdout.write(JSON.stringify(reference));
