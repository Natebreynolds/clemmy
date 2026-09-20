import { openEventLog } from '../runtime/harness/eventlog.js';
import { sourceSettledReadEvidence } from '../runtime/harness/host-completion-work.js';
import type { JudgeEvidenceSource } from '../runtime/harness/judge-evidence-tools.js';

/** Review only this run's settled step reads. Payloads and invocation scope are
 * redeemed lazily by the existing source/call/digest verifier, never reconstructed
 * from step prose or reopened from an arbitrary model-provided path. */
export function workflowRunReadEvidence(runId: string): JudgeEvidenceSource {
  const prefix = `workflow:${runId}:`;
  const sources = openEventLog().prepare(`
    SELECT DISTINCT session_id, source_user_seq
      FROM logical_call_settlements
     WHERE substr(session_id, 1, ?) = ? AND mutating = 0
     ORDER BY session_id, source_user_seq
  `).all(prefix.length, prefix) as Array<{ session_id: string; source_user_seq: number }>;
  const refs = new Map(sources.map(source => [
    `read_receipts/${source.session_id.slice(prefix.length)}/${source.source_user_seq}`,
    { sessionId: source.session_id, sourceUserSeq: source.source_user_seq },
  ]));
  return {
    refKind: 'run-scoped read_receipts refs (open to verify input origin, invocation arguments, and retained read results)',
    refs: () => [...refs.keys()],
    resolve(ref) {
      const source = refs.get(ref);
      if (!source) return undefined;
      const evidence = sourceSettledReadEvidence({ ...source, omitSuccessfulDiscovery: true, includeWriteReceipts: false, includeWorkerResults: false });
      return { text: evidence.summary, value: evidence };
    },
  };
}

/** Put verified execution identities beside outputs; reviewers should not have
 * to guess a tool from an authored step label. Payloads stay behind the refs. */
export function summarizeWorkflowReadExecutions(evidence: JudgeEvidenceSource): string {
  const lines: string[] = [];
  for (const ref of evidence.refs()) {
    const value = evidence.resolve(ref)?.value;
    if (!value || typeof value !== 'object') continue;
    const results = (value as { results?: unknown }).results;
    if (!Array.isArray(results)) continue;
    for (const result of results) {
      if (!result || result.status !== 'verified' || result.outcome !== 'succeeded'
        || typeof result.toolName !== 'string' || typeof result.logicalToolCallId !== 'string') continue;
      lines.push(JSON.stringify({ evidenceRef: ref, tool: result.toolName,
        logicalCallId: result.logicalToolCallId, outcome: 'succeeded' }));
    }
  }
  return lines.length ? [
    'VERIFIED READ EXECUTIONS (run-scoped settled receipts, not authored step labels):',
    ...lines,
    'Open the evidenceRef to verify exact input paths, arguments, and retained results. Execution alone does not prove output accuracy or requested coverage.',
  ].join('\n') : '';
}
