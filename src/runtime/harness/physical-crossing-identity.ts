/**
 * Host-derived physical crossing identity.
 *
 * Callers may propose a dispatch id. The host computes the only admissible
 * identity from accepted source, graph, node, logical call, ordinal, and
 * relation. A sealed or caller id that does not match is refused.
 */
import { createHash } from 'node:crypto';

export function derivePhysicalDispatchId(input: {
  sessionId: string;
  sourceUserSeq: number;
  graphId: string;
  nodeId: string;
  logicalCallId: string;
  ordinal: number;
  relation: string;
}): string {
  return `phys:${createHash('sha256').update(JSON.stringify({
    domain: 'physical-dispatch-id',
    version: 1,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    graphId: input.graphId,
    nodeId: input.nodeId,
    logicalCallId: input.logicalCallId,
    ordinal: input.ordinal,
    relation: input.relation,
  }), 'utf8').digest('hex')}`;
}
