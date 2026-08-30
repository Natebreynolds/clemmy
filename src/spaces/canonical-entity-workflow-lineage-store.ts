import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { BASE_DIR } from '../config.js';
import {
  canonicalEntityJson,
  canonicalEntitySha256,
} from '../execution/canonical-entity-resolution.js';
import type {
  CanonicalEntityWorkflowLineageCompositorV1,
  CanonicalEntityWorkflowLineageReceiptV1,
  CanonicalEntityWorkflowProjectionClaim,
  CanonicalEntityWorkflowProjectionRequestV1,
} from './canonical-entity-workflow-finalizer.js';

const MAX_RECEIPT_BYTES = 512_000;
const DIGEST_RE = /^[a-f0-9]{64}$/;

function directory(): string {
  return path.join(BASE_DIR, 'state', 'canonical-entities', 'workflow-lineage');
}

function receiptPath(receiptId: string): string {
  return path.join(directory(), `${canonicalEntitySha256({ version: 1, receiptId })}.json`);
}

function fsyncPath(target: string): void {
  const descriptor = openSync(target, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

export function canonicalEntityWorkflowLineageReceiptDigest(input: {
  version: 1;
  receiptId: string;
  request: CanonicalEntityWorkflowProjectionRequestV1;
}): string {
  return canonicalEntitySha256(input);
}

export type PutCanonicalEntityWorkflowLineageReceiptResultV1 =
  | { ok: true; inserted: boolean; receipt: CanonicalEntityWorkflowLineageReceiptV1 }
  | { ok: false; kind: 'conflict' | 'storage_error'; reason: string };

export function putCanonicalEntityWorkflowLineageReceipt(input: {
  receiptId: string;
  request: CanonicalEntityWorkflowProjectionRequestV1;
}): PutCanonicalEntityWorkflowLineageReceiptResultV1 {
  const receipt: CanonicalEntityWorkflowLineageReceiptV1 = {
    version: 1,
    receiptId: input.receiptId,
    request: input.request,
    receiptDigest: canonicalEntityWorkflowLineageReceiptDigest({
      version: 1,
      receiptId: input.receiptId,
      request: input.request,
    }),
  };
  let bytes: string;
  try {
    bytes = canonicalEntityJson(receipt);
  } catch (error) {
    return { ok: false, kind: 'conflict', reason: error instanceof Error ? error.message : String(error) };
  }
  if (Buffer.byteLength(bytes, 'utf8') > MAX_RECEIPT_BYTES) {
    return { ok: false, kind: 'conflict', reason: 'canonical workflow lineage receipt exceeds its byte ceiling' };
  }
  const target = receiptPath(receipt.receiptId);
  try {
    mkdirSync(directory(), { recursive: true });
    if (existsSync(target)) {
      const retained = readFileSync(target, 'utf8');
      return retained === bytes
        ? { ok: true, inserted: false, receipt }
        : { ok: false, kind: 'conflict', reason: 'lineage receipt identity is already bound to different bytes' };
    }
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    // A terminal claim may be published immediately after this function
    // returns. Flush the inode before linking it into the authoritative name,
    // then flush the directory after the link/unlink mutation so that claim
    // can never durably outrun its receipt across a power loss.
    fsyncPath(temporary);
    try {
      linkSync(temporary, target);
    } catch (error) {
      const retained = existsSync(target) ? readFileSync(target, 'utf8') : null;
      if (retained !== bytes) throw error;
      fsyncPath(target);
      fsyncPath(directory());
      return { ok: true, inserted: false, receipt };
    } finally {
      try { unlinkSync(temporary); } catch { /* orphan temp is non-authoritative */ }
    }
    fsyncPath(target);
    fsyncPath(directory());
    return { ok: true, inserted: true, receipt };
  } catch (error) {
    return { ok: false, kind: 'storage_error', reason: error instanceof Error ? error.message : String(error) };
  }
}

export function loadCanonicalEntityWorkflowLineageReceipt(
  receiptId: string,
): CanonicalEntityWorkflowLineageReceiptV1 | null {
  try {
    const bytes = readFileSync(receiptPath(receiptId), 'utf8');
    if (Buffer.byteLength(bytes, 'utf8') > MAX_RECEIPT_BYTES) return null;
    const receipt = JSON.parse(bytes) as CanonicalEntityWorkflowLineageReceiptV1;
    if (
      receipt?.version !== 1
      || receipt.receiptId !== receiptId
      || !DIGEST_RE.test(receipt.receiptDigest)
      || canonicalEntityJson(receipt) !== bytes
      || canonicalEntityWorkflowLineageReceiptDigest({
        version: 1,
        receiptId: receipt.receiptId,
        request: receipt.request,
      }) !== receipt.receiptDigest
    ) return null;
    return receipt;
  } catch {
    return null;
  }
}

/** Production resolver for content-addressed, raw-body-free lineage receipts. */
export const durableCanonicalEntityWorkflowLineageCompositor: CanonicalEntityWorkflowLineageCompositorV1 = {
  resolve(claim: CanonicalEntityWorkflowProjectionClaim) {
    const receipt = loadCanonicalEntityWorkflowLineageReceipt(claim.receiptId);
    if (!receipt) return { status: 'blocked', kind: 'missing' };
    if (
      receipt.receiptDigest !== claim.receiptDigest
      || canonicalEntityJson(receipt.request.identity) !== canonicalEntityJson(claim.identity)
      || receipt.request.expectedBindingDigest !== claim.bindingDigest
    ) return { status: 'blocked', kind: 'stale' };
    return { status: 'ready', receipt };
  },
};
