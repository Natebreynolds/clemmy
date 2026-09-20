import type { HostLocalWriteCommitFacts } from './host-local-write-commit.js';

/** Only an exact source/call-bound host activation may replace a draft receipt.
 * The caller still reopens and hashes the successor bytes at review/publication. */
export function workflowActivationSuccessor(
  original: HostLocalWriteCommitFacts,
  source: { sessionId: string; sourceUserSeq: number; logicalToolCallId: string },
  events: ReadonlyArray<{ role: string; data: Record<string, unknown> }>,
): HostLocalWriteCommitFacts {
  const matches = events.filter(({ role, data }) => role === 'system'
    && data.sessionId === source.sessionId && data.sourceUserSeq === source.sourceUserSeq
    && data.logicalToolCallId === source.logicalToolCallId
    && data.priorDigest === original.contentDigest);
  if (matches.length !== 1) return original;
  const facts = matches[0]!.data.facts as Partial<HostLocalWriteCommitFacts> | undefined;
  if (!facts || facts.createdId !== original.createdId || facts.handle !== original.handle
    || typeof facts.contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(facts.contentDigest)
    || typeof facts.receipt !== 'string') return original;
  return facts as HostLocalWriteCommitFacts;
}
