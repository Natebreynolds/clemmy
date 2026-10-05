import { z } from 'zod';
import { parseFactObservation } from '../../memory/fact-observation.js';
import { redeemSuccessfulSettlementResultForHost } from './result-handle.js';
import { judgeEvidenceJsonValue } from './judge-evidence-tools.js';

const readEnvelopeSchema = z.object({
  protocol: z.literal('fact_observation_v1'),
  readCallId: z.string().nullable(),
  observation: z.unknown(),
  provenance: z.string(),
}).strict();

/** Only a successful exact-source memory_read can supply a correction target.
 * Text inside a fact, another tool's output, and a stale session receipt cannot
 * mint this observation. The digest is a version check, not owner consent. */
export function retainedFactObservation(input: {
  sessionId: string; sourceUserSeq: number; acceptedTaskId: string; readCallId: string;
}) {
  const retained = redeemSuccessfulSettlementResultForHost({ ...input, logicalToolCallId: input.readCallId });
  if (retained.status !== 'ok' || retained.value.toolName !== 'memory_read'
    || retained.value.executionSite !== 'host') {
    throw new Error('Reopen the original fact with memory_read in this request before correcting it.');
  }
  const envelope = readEnvelopeSchema.parse(judgeEvidenceJsonValue({
    text: retained.value.rawPayloadJson, value: retained.value.rawPayload,
  }));
  if (envelope.readCallId !== retained.value.logicalToolCallId) {
    throw new Error('The memory observation does not belong to the retained read.');
  }
  return parseFactObservation(envelope.observation);
}
