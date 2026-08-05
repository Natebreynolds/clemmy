/**
 * Verified READ settlement for governed Composio dispatches (A-series).
 *
 * Learning is a SETTLEMENT act. This module runs only after the execute
 * wrapper has finished everything that decides what actually happened:
 * canonical failure detection, async job-receipt resolution, retries. It is
 * handed the FINAL settled payload — never the raw wire result — and it will
 * not teach memory anything it cannot back with a durable receipt:
 *
 *   1. the sealed slug taxonomy must prove a READ;
 *   2. the settled payload must carry real returned data;
 *   3. a LIVE schema contract for the identifier must exist to bind to —
 *      no contract, no capability (a capability without a contract cannot
 *      be validated when it is later retrieved);
 *   4. a typed `read_receipt` event is appended to the session log, and the
 *      learner re-resolves it BY ID through the same resolver production
 *      retrieval uses — the durable record is the authority, not the
 *      in-memory object that happened to be at hand.
 */
import { createHash } from 'node:crypto';
import { BASE_DIR } from '../config.js';
import { classifyComposioSlugEffect } from '../integrations/composio/slug-effect.js';
import { getMachineId } from '../runtime/machine-id.js';
import { appendEvent } from '../runtime/harness/eventlog.js';
import { eventLogReceiptResolver } from '../runtime/read-path/read-lane-adapters.js';
import type { DurableReceiptRecord } from '../memory/procedure-receipts.js';
import {
  learnVerifiedReadSettlement,
  settlementCarriesVerifiedData,
  type LearningVerdict,
} from '../memory/verified-read-learning.js';
import { liveComposioSchemaFingerprint } from './composio-schema-cache.js';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

export interface VerifiedComposioSettlementInput {
  toolSlug: string;
  sessionId: string;
  /** The FINAL settled payload — post failure detection, post async resolve. */
  result: unknown;
  /** Exact accepted source when the run context carries it. */
  sourceUserSeq?: number;
  /** Stable account identity (an email, never a rotating connection id). */
  accountIdentity?: string;
}

/**
 * Create the durable receipt and learn from it. Fail-closed at every step;
 * a decline is a normal outcome, never an error surfaced to the tool call.
 */
export function settleVerifiedComposioRead(input: VerifiedComposioSettlementInput): LearningVerdict {
  const toolSlug = input.toolSlug?.trim();
  if (!toolSlug || !input.sessionId) return { learned: false, reason: 'no identifier or session' };
  if (classifyComposioSlugEffect(toolSlug) !== 'read') {
    return { learned: false, reason: 'the sealed taxonomy does not prove a read' };
  }
  if (!settlementCarriesVerifiedData(input.result)) {
    return { learned: false, reason: 'settlement carries no verified returned data' };
  }
  const schemaFingerprint = liveComposioSchemaFingerprint(toolSlug);
  if (!schemaFingerprint) {
    return { learned: false, reason: 'no live schema contract to bind the capability to' };
  }

  const accountIdentity = input.accountIdentity?.trim() ?? '';
  let payloadDigest = '';
  try {
    payloadDigest = sha256(JSON.stringify(input.result)).slice(0, 24);
  } catch {
    return { learned: false, reason: 'settled payload is not serializable evidence' };
  }
  const record: DurableReceiptRecord = {
    receiptId: `rr_${sha256(`${input.sessionId}:${toolSlug}:${payloadDigest}`).slice(0, 24)}`,
    at: new Date().toISOString(),
    provider: (toolSlug.split('_')[0] ?? '').toLowerCase(),
    operation: toolSlug.split('_').slice(1).join('_').toLowerCase() || 'operation',
    effectClass: 'read',
    identifier: toolSlug,
    schemaFingerprint,
    scope: { tenant: getMachineId(), workspace: BASE_DIR, accountIdentity },
    dispatchOutcome: 'succeeded',
    readEvidenceRef: `evt:${payloadDigest}`,
  };
  try {
    appendEvent({
      sessionId: input.sessionId,
      turn: 0,
      role: 'system',
      type: 'read_receipt',
      data: { record },
    });
  } catch {
    // No durable receipt, no learning: an unrecorded settlement is a
    // settlement that never provably happened.
    return { learned: false, reason: 'the durable receipt could not be recorded' };
  }

  return learnVerifiedReadSettlement({
    receiptId: record.receiptId,
    receipts: eventLogReceiptResolver(input.sessionId),
    kind: 'composio',
    sessionId: input.sessionId,
    ...(typeof input.sourceUserSeq === 'number' ? { sourceUserSeq: input.sourceUserSeq } : {}),
  });
}
