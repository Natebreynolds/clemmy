/** Host-only file storage adapter. The shipped transport never imports the
 * computer-tool graph or a second copy of the revision store. */
import { observeReviewedLocalTool, reviewedLocalToolArgumentsMatch, type PreparedReviewedLocalToolExecution } from './reviewed-local-tool-transport.js';
import { parseHostLocalWriteCommitFacts, readCommittedArtifactContent } from './host-local-write-commit.js';
import { isLocalFileRevisionHandle } from './local-file-revision.js';
import { currentDispatchLease } from './dispatch-lease.js';

const PREFIX = 'local-file-receipt:v1:';

export async function executeReviewedLocalFile(
  args: Extract<PreparedReviewedLocalToolExecution, { adapter: 'local_file_revision_v1' }>['args'],
  recoveryOnly = false,
) {
  const { executeLocalFileWrite } = await import('../../tools/computer-tools.js');
  const lease = currentDispatchLease();
  const operationKey = lease?.sourceUserSeq && lease.acceptedTaskId && lease.logicalToolCallId
    ? JSON.stringify({ sessionId: lease.sessionId, sourceUserSeq: lease.sourceUserSeq,
      acceptedTaskId: lease.acceptedTaskId, logicalToolCallId: lease.logicalToolCallId }) : undefined;
  const result = await executeLocalFileWrite(args, { preserveCreateConflict: true, operationKey, recoveryOnly });
  const facts = parseHostLocalWriteCommitFacts(result);
  if (!facts || !isLocalFileRevisionHandle(facts.handle)
    || !readCommittedArtifactContent(facts).verified) {
    throw new Error(`Local file revision did not return a verified revision receipt: ${result}`);
  }
  return {
    artifactId: PREFIX + Buffer.from(facts.receipt, 'utf8').toString('base64url'),
    handle: facts.handle,
    contentDigest: facts.contentDigest,
    receipt: facts.receipt,
    // Stable payload for both original execution and receipt-only recovery.
    result: `Committed file at ${args.path} (${args.content.length} chars).\n${facts.receipt}`,
  };
}

export function reconcileReviewedLocalFile(artifactId: string) {
  if (!artifactId.startsWith(PREFIX) || artifactId.length > 4_000) return { exists: false };
  const encoded = artifactId.slice(PREFIX.length);
  const receipt = Buffer.from(encoded, 'base64url').toString('utf8');
  if (Buffer.from(receipt, 'utf8').toString('base64url') !== encoded) return { exists: false };
  const facts = parseHostLocalWriteCommitFacts(`${receipt}\n`);
  if (!facts || !isLocalFileRevisionHandle(facts.handle)
    || !readCommittedArtifactContent(facts).verified) return { exists: false };
  return { exists: true, artifactId, handle: facts.handle,
    contentDigest: facts.contentDigest, receipt: facts.receipt };
}

/** Host recovery validates the same reviewed argument contract before reading. */
export async function recoverReviewedLocalFile(operationId: string, args: Record<string, unknown>) {
  const observed = observeReviewedLocalTool(operationId);
  if (observed?.execution.adapter !== 'local_file_revision_v1'
    || !reviewedLocalToolArgumentsMatch(observed, args)) throw new Error('File recovery contract differs.');
  return executeReviewedLocalFile(args as Extract<PreparedReviewedLocalToolExecution,
    { adapter: 'local_file_revision_v1' }>['args'], true);
}
