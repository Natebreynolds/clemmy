import { acceptedTaskIdFor } from '../harness/attempt-identity.js';
import { listEvents } from '../harness/eventlog.js';
import { redeemSuccessfulSettlementResultForHost } from '../harness/result-handle.js';
import { inspectProviderEnvelope } from '../harness/provider-read-evidence.js';
import { recordsAtRecordPath } from '../harness/result-facts.js';
import { resolvedOperationsFor } from '../harness/resolution-ledger.js';
import { loadExpectedWorkContract } from '../harness/expected-work-contract.js';
import type { DurableReceiptRecord } from '../../memory/procedure-receipts.js';
import {
  parseVerifiedReadCapabilityOrigin,
  type VerifiedReadCapabilityOrigin,
} from '../../memory/verified-read-origin.js';
import {
  acceptedPhraseDigest,
  capabilityAliasLearningClaims,
  type CapabilityAliasRow,
} from '../../memory/capability-alias-index.js';

/**
 * Re-resolve a learned-read pointer against both durable records that make it
 * authoritative: the typed learning receipt and the canonical settlement that
 * preceded it. The latter is important for historical rows created before
 * nested provider contradictions were rejected at the learning seam.
 *
 * New receipts should eventually carry logicalToolCallId directly. Legacy
 * receipts do not, so this compatibility verifier uses the nearest canonical
 * settlement for the same accepted source and exact identifier and fails
 * closed when that settlement did not dispatch successfully.
 */
export function canonicalVerifiedReadReceipt(input: {
  origin: VerifiedReadCapabilityOrigin;
  identifier: string;
  accountIdentity?: string;
  schemaFingerprint?: string;
}): DurableReceiptRecord | null {
  const origin = parseVerifiedReadCapabilityOrigin(input.origin);
  const identifier = input.identifier.trim();
  if (!origin || !identifier) return null;
  try {
    const events = listEvents(origin.sessionId);
    const receiptEvents = events.filter((event) => event.type === 'read_receipt'
      && (event.data as { record?: { receiptId?: unknown } }).record?.receiptId === origin.receiptId);
    if (receiptEvents.length !== 1) return null;
    const receiptEvent = receiptEvents[0]!;
    const record = (receiptEvent.data as { record?: DurableReceiptRecord }).record;
    if (!record
      || record.receiptId !== origin.receiptId
      || record.identifier.toLowerCase() !== identifier.toLowerCase()
      || record.effectClass !== 'read'
      || record.dispatchOutcome !== 'succeeded'
      || record.readEvidenceRef !== `evt:${origin.evidenceDigest}`
      || !record.schemaFingerprint
      || record.source?.sessionId !== origin.sessionId
      || record.source.sourceUserSeq !== origin.sourceUserSeq
      || !record.source.attemptId
      || (input.accountIdentity !== undefined
        && (record.scope?.accountIdentity ?? '') !== input.accountIdentity)
      || (input.schemaFingerprint
        && record.schemaFingerprint !== input.schemaFingerprint)) return null;

    const settlements = events.filter((event) => {
      if (event.type !== 'tool_attempt_settled' || event.seq >= receiptEvent.seq) return false;
      const data = event.data as Record<string, unknown>;
      return data.sourceUserSeq === origin.sourceUserSeq
        && typeof data.tool === 'string'
        && data.tool.toLowerCase() === identifier.toLowerCase();
    });
    const settlement = settlements.at(-1);
    if (!settlement) return null;
    const data = settlement.data as Record<string, unknown>;
    return data.acceptedTaskId === acceptedTaskIdFor(origin.sessionId, origin.sourceUserSeq)
      && data.kind === 'succeeded'
      && data.dispatchState === 'dispatched'
      && data.mutating === false
      ? record
      : null;
  } catch {
    return null;
  }
}

export function verifiedReadOriginIsCanonical(input: {
  origin: VerifiedReadCapabilityOrigin;
  identifier: string;
  accountIdentity?: string;
  schemaFingerprint?: string;
}): boolean {
  return canonicalVerifiedReadReceipt(input) !== null;
}

export function verifiedReadOriginMatchesAliasDigest(
  originValue: VerifiedReadCapabilityOrigin,
  aliasDigest: string,
): boolean {
  const origin = parseVerifiedReadCapabilityOrigin(originValue);
  if (!origin || !aliasDigest) return false;
  try {
    const source = listEvents(origin.sessionId, { types: ['user_input_received'] })
      .find((event) => event.seq === origin.sourceUserSeq && typeof event.data.text === 'string');
    return Boolean(source && acceptedPhraseDigest(String(source.data.text)) === aliasDigest);
  } catch {
    return false;
  }
}

export interface CanonicalVerifiedReadResultShape {
  /** Tokenized provider field names, kept grouped so separate keys cannot
   * accidentally combine into one requested projection. */
  fieldSignatures: string[][];
  /** Field signatures grouped by the actual records named by recordPath. A
   * projection is proven only when every inspected record carries it. */
  recordFieldSignatures: string[][][];
  recordsInspectedCompletely: boolean;
  /** Bounded URL structure from scalar result fields (host/path words only). */
  locatorTerms: string[];
  /** Canonical result-handle cardinality, not a count guessed from prose. */
  recordCount: number;
}

const MAX_RESULT_SHAPE_DEPTH = 12;
const MAX_RESULT_SHAPE_NODES = 32_768;
const MAX_RESULT_SHAPE_KEYS_PER_OBJECT = 256;
const MAX_RESULT_SHAPE_SIGNATURES = 32_768;

function shapeTerms(value: string): string[] {
  return [...new Set(value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 2)
    .map((term) => term.length > 4 && term.endsWith('s') && !term.endsWith('ss')
      ? term.slice(0, -1)
      : term))];
}

/**
 * Read-only task-shape evidence for a canonical learned source. This is not a
 * second receipt verifier: it first passes the existing verifier, then redeems
 * the exact immutable settlement result and joins its SHA prefix to the
 * receipt's evidence digest. Only structured keys and URL locators escape;
 * arbitrary historical values remain private.
 */
export function canonicalVerifiedReadResultShape(input: {
  origin: VerifiedReadCapabilityOrigin;
  identifier: string;
  aliasDigest: string;
  accountIdentity?: string;
  schemaFingerprint?: string;
}): CanonicalVerifiedReadResultShape | null {
  const origin = parseVerifiedReadCapabilityOrigin(input.origin);
  if (!origin
    || !verifiedReadOriginMatchesAliasDigest(origin, input.aliasDigest)
    || !canonicalVerifiedReadReceipt(input)) return null;
  try {
    const events = listEvents(origin.sessionId);
    const receipt = events.find((event) => event.type === 'read_receipt'
      && (event.data as { record?: { receiptId?: unknown } }).record?.receiptId === origin.receiptId);
    if (!receipt) return null;
    const settlement = events.filter((event) => {
      if (event.type !== 'tool_attempt_settled' || event.seq >= receipt.seq) return false;
      const data = event.data as Record<string, unknown>;
      return data.sourceUserSeq === origin.sourceUserSeq
        && typeof data.tool === 'string'
        && data.tool.toLowerCase() === input.identifier.trim().toLowerCase();
    }).at(-1);
    const logicalToolCallId = settlement?.data.logicalToolCallId;
    if (typeof logicalToolCallId !== 'string' || !logicalToolCallId.trim()) return null;
    const redeemed = redeemSuccessfulSettlementResultForHost({
      sessionId: origin.sessionId,
      sourceUserSeq: origin.sourceUserSeq,
      acceptedTaskId: acceptedTaskIdFor(origin.sessionId, origin.sourceUserSeq),
      logicalToolCallId,
    });
    if (redeemed.status !== 'ok'
      || redeemed.value.outcomeKind !== 'succeeded'
      || redeemed.value.toolName.toLowerCase() !== input.identifier.trim().toLowerCase()
      || !redeemed.value.rawPayloadSha256.startsWith(origin.evidenceDigest)
      || inspectProviderEnvelope(redeemed.value.rawPayload).verdict !== 'clean') return null;

    const loadedContract = loadExpectedWorkContract(origin.sessionId, origin.sourceUserSeq);
    if (loadedContract.status !== 'ok') return null;
    const settledReads = resolvedOperationsFor(origin.sessionId, origin.sourceUserSeq)
      .filter((operation) => operation.logicalToolCallId === logicalToolCallId
        && operation.resolvedTool.toLowerCase() === input.identifier.trim().toLowerCase()
        && operation.effectKind === 'read'
        && operation.outcomeKind === 'succeeded'
        && operation.dispatchState === 'dispatched');
    if (settledReads.length !== 1) return null;
    const sourceOperation = loadedContract.contract.operations
      .find((operation) => operation.id === settledReads[0]!.operationId);
    if (!sourceOperation
      || sourceOperation.effect !== 'read'
      || sourceOperation.coverage !== 'complete_set'
      || sourceOperation.cardinality.kind !== 'once') return null;
    const directConsumers = loadedContract.contract.operations.filter((operation) =>
      operation.dependsOn.includes(sourceOperation.id)
      && operation.dataFrom.includes(sourceOperation.id));
    if (directConsumers.length !== 1
      || !['local_write', 'external_write', 'admin'].includes(directConsumers[0]!.effect)
      || directConsumers[0]!.cardinality.kind !== 'once') return null;

    const rawRecords = recordsAtRecordPath(
      redeemed.value.rawPayload,
      redeemed.value.handle.recordPath,
    );
    const recordsExactlyMaterialized = Boolean(rawRecords
      && rawRecords.length === redeemed.value.handle.recordCount
      && rawRecords.length <= 256);
    const records = recordsExactlyMaterialized ? rawRecords! : [];
    const fieldSignatures: string[][] = [];
    const recordFieldSignatures: string[][][] = [];
    const locatorTerms = new Set<string>();
    const activeObjects = new WeakSet<object>();
    let nodesVisited = 0;
    let signaturesVisited = 0;
    let traversalComplete = recordsExactlyMaterialized;

    const visitRecordValue = (
      value: unknown,
      path: string[],
      depth: number,
      signatures: string[][],
    ): boolean => {
      nodesVisited += 1;
      if (nodesVisited > MAX_RESULT_SHAPE_NODES || depth > MAX_RESULT_SHAPE_DEPTH) return false;
      if (!value || typeof value !== 'object') return true;
      if (activeObjects.has(value)) return false;
      activeObjects.add(value);
      try {
        if (Array.isArray(value)) {
          for (const child of value) {
            if (!visitRecordValue(child, path, depth + 1, signatures)) return false;
          }
          return true;
        }
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.length > MAX_RESULT_SHAPE_KEYS_PER_OBJECT) return false;
        for (const [key, child] of entries) {
          const childPath = [...path, key];
          const usefulScalar = (typeof child === 'string' && child.trim().length > 0)
            || (typeof child === 'number' && Number.isFinite(child))
            || typeof child === 'boolean';
          if (usefulScalar) {
            const terms = shapeTerms(childPath.join(' '));
            if (terms.length > 0) {
              signaturesVisited += 1;
              if (signaturesVisited > MAX_RESULT_SHAPE_SIGNATURES) return false;
              signatures.push(terms);
            }
          }
          if (typeof child === 'string' && child.trim() && /^https?:\/\//i.test(child)
            && child.length <= 2_048) {
            try {
              const url = new URL(child);
              for (const term of shapeTerms(`${url.hostname} ${url.pathname}`)) locatorTerms.add(term);
            } catch { /* malformed locators prove nothing */ }
          }
          if (child && typeof child === 'object'
            && !visitRecordValue(child, childPath, depth + 1, signatures)) return false;
        }
        return true;
      } finally {
        activeObjects.delete(value);
      }
    };

    for (const record of records) {
      const signatures: string[][] = [];
      if (!visitRecordValue(record, [], 0, signatures)) {
        traversalComplete = false;
        break;
      }
      recordFieldSignatures.push(signatures);
      fieldSignatures.push(...signatures);
    }
    return {
      fieldSignatures,
      recordFieldSignatures,
      recordsInspectedCompletely: traversalComplete
        && recordFieldSignatures.length === redeemed.value.handle.recordCount,
      locatorTerms: [...locatorTerms].slice(0, 128),
      recordCount: redeemed.value.handle.recordCount,
    };
  } catch {
    return null;
  }
}

/**
 * Recover alias-specific provenance for rows learned before origin_json was
 * stored. This is deliberately not a procedure-wide fallback: the accepted
 * user bytes must hash to this exact alias row, and the same source must own a
 * canonical receipt + settlement for the row's identifier/account/schema.
 */
export function recoverCanonicalVerifiedReadOriginForAlias(
  row: CapabilityAliasRow,
): VerifiedReadCapabilityOrigin | null {
  for (const claim of capabilityAliasLearningClaims(row)) {
    let events: ReturnType<typeof listEvents>;
    try {
      events = listEvents(claim.sessionId, {
        types: ['user_input_received', 'read_receipt', 'tool_attempt_settled'],
      });
    } catch {
      continue;
    }
    const source = events.find((event) => event.type === 'user_input_received'
      && event.seq === claim.sourceUserSeq
      && typeof event.data.text === 'string');
    if (!source || acceptedPhraseDigest(String(source.data.text)) !== row.aliasDigest) continue;

    const receipts = events
      .filter((event) => event.type === 'read_receipt')
      .sort((left, right) => right.seq - left.seq);
    for (const event of receipts) {
      const record = (event.data as { record?: DurableReceiptRecord }).record;
      const evidenceDigest = /^evt:([a-f0-9]{24})$/.exec(record?.readEvidenceRef ?? '')?.[1];
      if (!record
        || !evidenceDigest
        || record.identifier.toLowerCase() !== row.identifier.toLowerCase()
        || record.schemaFingerprint !== row.schemaFingerprint
        || (record.scope?.accountIdentity ?? '') !== row.accountIdentity
        || record.source?.sessionId !== claim.sessionId
        || record.source.sourceUserSeq !== claim.sourceUserSeq) continue;
      const origin: VerifiedReadCapabilityOrigin = {
        version: 1,
        sessionId: claim.sessionId,
        sourceUserSeq: claim.sourceUserSeq,
        receiptId: record.receiptId,
        evidenceDigest,
      };
      if (canonicalVerifiedReadReceipt({
        origin,
        identifier: row.identifier,
        accountIdentity: row.accountIdentity,
        schemaFingerprint: row.schemaFingerprint ?? undefined,
      })) return origin;
    }
  }
  return null;
}
