import { parseHostLocalWriteCommitFacts, readCommittedArtifactContent } from '../runtime/harness/host-local-write-commit.js';
import { isLocalFileRevisionHandle } from '../runtime/harness/local-file-revision.js';

/** Reopen only a receipt retained in this step, verifying current bytes. Never
 * read an arbitrary path supplied by the reviewer or infer content from a digest. */
export function workflowFileEvidence(output: unknown): unknown {
  let value = output;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return output; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
  const receipt = (value as Record<string, unknown>).receipt;
  if (typeof receipt !== 'string') return output;
  const facts = parseHostLocalWriteCommitFacts(`${receipt}\n`);
  if (!facts || !isLocalFileRevisionHandle(facts.handle)) return output;
  const content = readCommittedArtifactContent(facts);
  return {
    stepResult: value,
    committedFileEvidence: {
      verified: content.verified,
      totalBytes: content.totalBytes,
      ...(content.unresolvedReason ? { reason: content.unresolvedReason } : {}),
      parts: content.verified ? content.parts.map(part => {
        try {
          return { role: part.role, byteLength: part.bytes.length, encoding: 'utf-8', content: new TextDecoder('utf-8', { fatal: true }).decode(part.bytes) };
        } catch {
          return { role: part.role, byteLength: part.bytes.length, encoding: 'base64', content: part.bytes.toString('base64') };
        }
      }) : [],
    },
  };
}
