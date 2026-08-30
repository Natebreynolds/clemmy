import { closeEventLog } from '../runtime/harness/eventlog.js';
import {
  redeemAuthoritativeResultPayload,
  type ResultHandleAuthority,
} from '../runtime/harness/result-handle.js';

interface RestartRequest {
  rawLocation: string;
  authority: ResultHandleAuthority;
  expectedSha256: string;
  expectedBytes: number;
}

function parseRequest(encoded: string | undefined): RestartRequest {
  if (!encoded) throw new Error('restart request is missing');
  const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as RestartRequest;
  if (
    !value
    || typeof value.rawLocation !== 'string'
    || !value.rawLocation.trim()
    || typeof value.expectedSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.expectedSha256)
    || !Number.isSafeInteger(value.expectedBytes)
    || value.expectedBytes <= 8_000_000
    || !value.authority
  ) throw new Error('restart request is malformed');
  return value;
}

const request = parseRequest(process.argv[2]);
try {
  const redeemed = redeemAuthoritativeResultPayload({
    kind: 'returned_handle',
    rawLocation: request.rawLocation,
    authority: request.authority,
  });
  if (redeemed.status !== 'ok') {
    throw new Error(`restart redemption failed (${redeemed.status}): ${redeemed.reason}`);
  }
  if (
    redeemed.value.rawPayloadSha256 !== request.expectedSha256
    || redeemed.value.rawByteCount !== request.expectedBytes
  ) throw new Error('restart redemption bytes or digest differ from the retained provider payload');
  process.stdout.write(`${JSON.stringify({
    pid: process.pid,
    status: redeemed.status,
    rawPayloadSha256: redeemed.value.rawPayloadSha256,
    rawByteCount: redeemed.value.rawByteCount,
  })}\n`);
} finally {
  closeEventLog();
}
