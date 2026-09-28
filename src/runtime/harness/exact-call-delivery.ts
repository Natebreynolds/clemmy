/** Resolve an ambiguous delivery noun using the current provider schema and
 * complete effective arguments. Never an operation-name permission list.
 * The first conclusion (including no proof) is durable per logical call so
 * approval/restart cannot change the risk terms underneath an existing card. */
import { appendEvent, openEventLog } from './eventlog.js';
import { hasAmbiguousDeliveryAction } from './external-capability-risk.js';
import { exactDeliveryCallBindingDigest, type LoadCatalogManifestExternalRiskAttestationInputV1 } from './external-capability-risk-loader.js';
import { learnOperationDelivery } from './learned-operation-delivery.js';
import { learnedOperationDeliveryVerdict, parseLearnedOperationDeliveryVerdictV1, type LearnedOperationDeliveryVerdictV1 } from './learned-operation-delivery-store.js';

const inFlight = new Map<string, Promise<LearnedOperationDeliveryVerdictV1 | null>>();
const unsuccessful = new Map<string, number>();

export async function exactCallDeliveryProof(input: {
  request: LoadCatalogManifestExternalRiskAttestationInputV1;
  arguments: Record<string, unknown>;
  providerKind: 'composio' | 'native_mcp';
  semanticName: string;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
}): Promise<LearnedOperationDeliveryVerdictV1 | null> {
  const { request } = input;
  if (!hasAmbiguousDeliveryAction(input.semanticName)
    || request.callSignals.outboundDelivery === true
    || request.callSignals.recipientsPresent === true
    || request.callSignals.requestMethod !== null) return null;
  const schema = request.inputSchema as Record<string, unknown> | null;
  // Provider documentation must be in the very schema whose bytes the fresh
  // loader verified. Missing documentation is not filled in by a guessed name.
  if (!schema || typeof schema.description !== 'string' || !schema.description.trim()) return null;
  const digest = exactDeliveryCallBindingDigest(request.binding, schema, input.arguments);
  try {
    const db = openEventLog();
    const previous = db.prepare(`SELECT data_json FROM events
      WHERE session_id = ? AND type = 'exact_call_delivery_basis'
      AND json_extract(data_json, '$.acceptedTaskId') = ?
      AND json_extract(data_json, '$.logicalToolCallId') = ? ORDER BY seq LIMIT 1`)
      .get(input.sessionId, input.acceptedTaskId, input.logicalToolCallId) as { data_json: string } | undefined;
    if (previous) {
      const data = JSON.parse(previous.data_json);
      if (data.version !== 1 || data.sourceUserSeq !== input.sourceUserSeq || data.callBindingDigest !== digest) return null;
      const verdict = parseLearnedOperationDeliveryVerdictV1(data.verdict);
      return verdict?.callBindingDigest === digest ? verdict : null;
    }
    // Old cards predate the conditional learner. Preserve their exact terms.
    const priorApproval = db.prepare(`SELECT seq FROM events
      WHERE session_id = ? AND type = 'approval_requested'
      AND (json_extract(data_json, '$.consentCall.logicalToolCallId') = ?
        OR json_extract(data_json, '$.consentCall.acceptedTaskId') = ?)
      LIMIT 1`).get(input.sessionId, input.logicalToolCallId, input.acceptedTaskId);
    if (priorApproval) return null;

    let verdict = learnedOperationDeliveryVerdict(input.providerKind, request.binding.operationId, digest);
    if (!verdict && (unsuccessful.get(digest) ?? 0) <= Date.now()) {
      let pending = inFlight.get(digest);
      if (!pending && inFlight.size < 2) {
        pending = (async () => {
          await learnOperationDelivery({
            providerKind: input.providerKind,
            operationId: request.binding.operationId,
            semanticName: input.semanticName,
            description: schema.description as string,
            inputSchema: schema,
            exactCall: { bindingDigest: digest, arguments: input.arguments },
          }, { sessionId: input.sessionId });
          return learnedOperationDeliveryVerdict(input.providerKind, request.binding.operationId, digest);
        })();
        inFlight.set(digest, pending);
        void pending.finally(() => inFlight.delete(digest)).catch(() => {});
      }
      verdict = pending ? await pending : null;
      if (!verdict) {
        unsuccessful.set(digest, Date.now() + 10 * 60_000);
        if (unsuccessful.size > 500) unsuccessful.delete(unsuccessful.keys().next().value!);
      }
    }
    // Freeze even a disagreement/unavailable result. Reopening an approval
    // may not reclassify it after another task learns a more permissive fact.
    appendEvent({ sessionId: input.sessionId, turn: 0, role: 'system', type: 'exact_call_delivery_basis', data: {
      version: 1, sourceUserSeq: input.sourceUserSeq, acceptedTaskId: input.acceptedTaskId,
      logicalToolCallId: input.logicalToolCallId, callBindingDigest: digest, verdict,
    } });
    return verdict;
  } catch {
    // Missing durable evidence can never authorize an unreviewed lowering.
    return null;
  }
}
