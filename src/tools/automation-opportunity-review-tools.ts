import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { registerAutomationOpportunityReviewProjection } from '../execution/automation-opportunity-review-control-plane.js';
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';
import { textResult } from './shared.js';

const DIGEST_RE = /^[a-f0-9]{64}$/;
const EXACT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,255}$/;
const MAX_RESULT_CHARS = 256_000;

export interface AutomationOpportunityReviewToolOptions {
  acceptedSource?: () => { sessionId: string; sourceUserSeq: number } | undefined;
}

function acceptedSource(
  override?: AutomationOpportunityReviewToolOptions['acceptedSource'],
): { sessionId: string; sourceUserSeq: number } | undefined {
  const supplied = override?.();
  const context = supplied ?? harnessRunContextStorage.getStore();
  if (
    !context
    || !EXACT_REF_RE.test(context.sessionId)
    || !Number.isSafeInteger(context.sourceUserSeq)
    || (context.sourceUserSeq ?? 0) < 1
  ) return undefined;
  return { sessionId: context.sessionId, sourceUserSeq: context.sourceUserSeq! };
}

function errorResult(code: string, reason: string) {
  return textResult(JSON.stringify({ ok: false, code, reason }), {
    maxChars: MAX_RESULT_CHARS,
    isError: true,
  });
}

/**
 * Chat-native staging surface for a proposal decision. Calling this tool can
 * create only the durable review projection and its formal approval card. The
 * model cannot supply a decision, resolver, pilot, workflow, schedule, or any
 * execution authority; those fields are deliberately absent from the schema.
 */
export function registerAutomationOpportunityReviewTools(
  server: McpServer,
  options: AutomationOpportunityReviewToolOptions = {},
): void {
  server.tool(
    'automation_opportunity_review_request',
    'Stage one exact automation proposal revision for user review and show its formal decision card. This tool cannot approve, reject, request a pilot, compile, queue, run, schedule, create a Space, or infer recurrence.',
    {
      proposal_id: z.string().regex(EXACT_REF_RE),
      expected_proposal_revision: z.number().int().positive(),
      expected_proposal_digest: z.string().regex(DIGEST_RE),
    },
    async ({ proposal_id, expected_proposal_revision, expected_proposal_digest }) => {
      const source = acceptedSource(options.acceptedSource);
      if (!source) {
        return errorResult(
          'accepted_source_required',
          'An exact accepted chat source must own the proposal review request.',
        );
      }
      let requested: ReturnType<typeof registerAutomationOpportunityReviewProjection>;
      try {
        requested = registerAutomationOpportunityReviewProjection({
          proposalId: proposal_id,
          expectedProposalRevision: expected_proposal_revision,
          expectedProposalDigest: expected_proposal_digest,
          approvalSessionId: source.sessionId,
          requestSourceUserSeq: source.sourceUserSeq,
        });
      } catch (error) {
        return errorResult(
          'review_request_failed',
          error instanceof Error ? error.message : String(error),
        );
      }
      if (!requested.ok) return errorResult(requested.code, requested.reason);
      return textResult(JSON.stringify({
        ok: true,
        projection: requested.projection,
        proposal: {
          proposalId: requested.proposal.proposalId,
          status: requested.proposal.status,
          revision: requested.proposal.revision,
          digest: requested.proposal.digest,
        },
        approval: {
          approvalId: requested.approval.approvalId,
          status: requested.approval.status,
          resolution: requested.approval.resolution,
          expiresAt: requested.approval.expiresAt,
        },
        projectionCreated: requested.projectionCreated,
        approvalCreated: requested.approvalCreated,
        cardCreated: requested.cardCreated,
        executionAuthority: 'none',
        decisionAuthority: requested.projection.status === 'reviewed'
          ? 'formal_human_approval_only'
          : 'resolved_exact_human_decision',
        nextBoundary: requested.projection.status === 'reviewed'
          ? 'formal_human_proposal_decision'
          : 'proposal_decision_complete',
        pilotAuthority: 'none',
        recurrenceAuthority: 'none',
      }), { maxChars: MAX_RESULT_CHARS });
    },
  );
}
