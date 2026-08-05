/**
 * Production adapters for the accepted-turn read resolver (E4.3) — thin,
 * fail-closed bindings over the EXISTING seams: the Composio client for
 * dispatch and connection truth, the session event log for durable receipt
 * rows and evidence, and the connected-account broker's stable identity.
 *
 * Everything here fails CLOSED: any uncertainty (no stable account, no live
 * schema, an unparseable result) declines the lane and the ordinary brain
 * runs unchanged. No provider or operation name appears in control flow.
 */
import { createHash, randomUUID } from 'node:crypto';
import { executeComposioTool } from '../../integrations/composio/client.js';
import { appendEvent, listEvents } from '../harness/eventlog.js';
import type { DurableReceiptRecord, ReceiptResolver } from '../../memory/procedure-receipts.js';
import type { ProcedureScope } from '../../memory/procedure-artifact.js';
import type { AcceptedTurnReadPorts } from './read-lane-chat.js';
import type { BoundReadDispatch } from './read-envelope.js';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * Durable read receipts live as typed session events: the dispatch adapter
 * appends one after a verified provider return, and the resolver reads it
 * back by id — the event log is the existing durable store, not a new one.
 */
export function eventLogReceiptResolver(sessionId: string): ReceiptResolver {
  return {
    resolve(receiptId: string): DurableReceiptRecord | undefined {
      try {
        for (const event of listEvents(sessionId)) {
          if (event.type !== 'read_receipt') continue;
          const data = event.data as { record?: DurableReceiptRecord } | undefined;
          if (data?.record?.receiptId === receiptId) return data.record;
        }
      } catch { /* fail closed */ }
      return undefined;
    },
  };
}

/**
 * Build the production ports for one accepted turn. `identityInputs` are the
 * REAL derived identities (stable account, catalog fingerprints) supplied by
 * the caller from connection truth — absence of any of them declines.
 */
export function buildProductionReadPorts(input: {
  sessionId: string;
  scope: ProcedureScope | undefined;
  /** identifier -> live schema fingerprint from the LOADED catalog. */
  catalogFingerprints: Map<string, string>;
  accountConnected: boolean;
  clock?: () => number;
}): AcceptedTurnReadPorts {
  const receipts = eventLogReceiptResolver(input.sessionId);
  return {
    scope: () => input.scope,
    liveSchemaFingerprint: (identifier) => input.catalogFingerprints.get(identifier),
    accountConnected: () => input.accountConnected,
    receipts,
    async dispatch(bound: BoundReadDispatch) {
      try {
        const raw = await executeComposioTool(bound.identifier, bound.args);
        const summary = typeof raw === 'string' ? raw : JSON.stringify(raw);
        const record: DurableReceiptRecord = {
          receiptId: `readrcpt_${randomUUID()}`,
          at: new Date().toISOString(),
          provider: bound.provider,
          operation: bound.operation,
          effectClass: 'read',
          identifier: bound.identifier,
          schemaFingerprint: bound.schemaFingerprint,
          scope: {
            tenant: bound.tenant,
            workspace: bound.workspace,
            accountIdentity: bound.accountIdentity,
          },
          dispatchOutcome: 'succeeded',
          readEvidenceRef: `evt:${sha256(summary).slice(0, 24)}`,
        };
        appendEvent({
          sessionId: input.sessionId,
          turn: 0,
          role: 'system',
          type: 'read_receipt',
          data: {
            record,
            // Bounded evidence summary — full payloads stay in tool output
            // stores; the receipt row carries the ref and a bounded digesty
            // summary for presentation grounding.
            evidenceSummary: summary.slice(0, 4_000),
          },
        });
        return { receiptId: record.receiptId };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          transient: true,
        };
      }
    },
    async present(evidence: DurableReceiptRecord) {
      // The evidence-grounded draft: the bounded summary stored with the
      // receipt row. The BRIDGE commits the terminal; this is input only.
      try {
        for (const event of listEvents(input.sessionId)) {
          if (event.type !== 'read_receipt') continue;
          const data = event.data as { record?: DurableReceiptRecord; evidenceSummary?: string } | undefined;
          if (data?.record?.receiptId === evidence.receiptId && data.evidenceSummary) {
            return { draft: data.evidenceSummary };
          }
        }
      } catch { /* fall through to the typed failure below */ }
      throw new Error('verified receipt has no stored evidence summary');
    },
    clock: input.clock,
  };
}
