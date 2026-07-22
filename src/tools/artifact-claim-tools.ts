import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openEventLog } from '../runtime/harness/eventlog.js';
import { resolveUncertainArtifactClaim } from '../runtime/harness/artifact-ledger.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { textResult } from './shared.js';

/**
 * artifact_claim_resolve — the standard lane's permission-bound repair for an
 * unresolved provider-create claim (2026-07-22 Netlify jail).
 *
 * A create that dies mid-flight (interactive CLI crash, timeout past the
 * write boundary) leaves an artifact claim the session can never verify: the
 * loop honestly refuses to re-create ("the outcome is uncertain") but had no
 * way OUT — every retry re-parked forever, even after the model READ the
 * provider and found the truth. This tool records that truth:
 *
 *  - resolution "bind": the resource EXISTS — attach its exact id. Evidence-
 *    gated: the resourceId must literally appear in one of THIS session's
 *    recorded tool outputs (the read-back the retry directive demanded), so a
 *    hallucinated id cannot bind.
 *  - resolution "absent": the provider was listed/read and the resource
 *    provably does not exist — the claim is released so the sanctioned
 *    re-create can proceed. The duplicate-write wall still backstops.
 */
export function registerArtifactClaimTools(server: McpServer): void {
  server.tool(
    'artifact_claim_resolve',
    [
      'Resolve an UNRESOLVED provider-create claim after you have verified the provider state with read-only tools.',
      'Use ONLY during an artifact verification retry. resolution="bind" when the resource exists (pass its exact resourceId, which must appear verbatim in a tool output from this session — read it back first). resolution="absent" when a provider listing proves it was never created.',
      'Never use this to skip verification: bind without a read-back will be refused.',
    ].join(' '),
    {
      artifactId: z.string().min(6).describe('The claim id from the verification-retry directive (e.g. from "artifactId <id>: …").'),
      resolution: z.enum(['bind', 'absent']),
      resourceId: z.string().min(1).nullable().optional().describe('bind only: the exact provider resource id you read back.'),
      uri: z.string().min(4).nullable().optional().describe('bind only: the resource URL if known.'),
    },
    async ({ artifactId, resolution, resourceId, uri }) => {
      const sessionId = getToolOutputContext()?.sessionId;
      if (!sessionId) return textResult('ERROR: artifact_claim_resolve needs a live session context.');
      if (resolution === 'bind') {
        const id = resourceId?.trim();
        if (!id) return textResult('ERROR: resolution="bind" requires resourceId.');
        // Evidence gate: the id must exist verbatim in this session's recorded
        // tool outputs — i.e. the model actually read it back from the provider.
        const seen = openEventLog().prepare(
          "SELECT 1 FROM tool_outputs WHERE session_id = ? AND output_full LIKE '%' || ? || '%' LIMIT 1",
        ).get(sessionId, id);
        if (!seen) {
          return textResult(`ERROR: resourceId "${id}" does not appear in any tool output of this session. Read the resource back from the provider first (list/fetch), then bind with the id exactly as returned.`);
        }
        const out = resolveUncertainArtifactClaim(sessionId, artifactId, { kind: 'bind', resourceId: id, uri: uri ?? undefined });
        return textResult(out.ok
          ? `Claim ${artifactId} bound to ${id} and verified. Continue the task from this existing resource — do NOT create a replacement.`
          : `ERROR: could not bind claim ${artifactId}: ${out.reason}`);
      }
      const out = resolveUncertainArtifactClaim(sessionId, artifactId, { kind: 'absent' });
      return textResult(out.ok
        ? `Claim ${artifactId} released — the resource provably does not exist. You may now create it ONCE with the originally intended parameters.`
        : `ERROR: could not release claim ${artifactId}: ${out.reason}`);
    },
  );
}
