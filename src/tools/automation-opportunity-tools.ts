import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  automationOpportunitySchema,
  canonicalAutomationOpportunityJson,
  parseAutomationOpportunity,
  type AutomationOpportunityV1,
} from '../execution/automation-opportunity.js';
import {
  createAutomationOpportunityProposal,
  listAutomationOpportunityProposals,
  loadAutomationOpportunityProposal,
  reviseAutomationOpportunityProposal,
  type AutomationOpportunityProposalRecordV1,
  type AutomationOpportunityProposalStatus,
} from '../execution/automation-opportunity-store.js';
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';
import { textResult } from './shared.js';

const PROPOSAL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const MAX_OPPORTUNITY_JSON_BYTES = 256 * 1024;

export interface AutomationOpportunityToolOptions {
  database?: Database.Database;
  acceptedSource?: () => { sessionId: string; sourceUserSeq: number } | undefined;
}

function currentAcceptedSource(
  override?: AutomationOpportunityToolOptions['acceptedSource'],
): { sessionId: string; sourceUserSeq: number } | undefined {
  const supplied = override?.();
  const context = supplied ?? harnessRunContextStorage.getStore();
  if (!context
    || typeof context.sessionId !== 'string'
    || context.sessionId.trim().length === 0
    || !Number.isSafeInteger(context.sourceUserSeq)
    || (context.sourceUserSeq ?? 0) < 1) return undefined;
  return {
    sessionId: context.sessionId,
    sourceUserSeq: context.sourceUserSeq!,
  };
}

function actorRef(source: { sessionId: string; sourceUserSeq: number }): string {
  return `accepted-source:${source.sessionId}#${source.sourceUserSeq}`;
}

/** One accepted source can draft several explicitly keyed opportunities while
 * an exact retry of the same key always addresses the same durable proposal. */
export function automationOpportunityProposalId(input: {
  sessionId: string;
  sourceUserSeq: number;
  proposalKey: string;
}): string {
  if (!PROPOSAL_KEY_RE.test(input.proposalKey)) throw new TypeError('proposalKey is invalid');
  if (!Number.isSafeInteger(input.sourceUserSeq) || input.sourceUserSeq < 1) {
    throw new TypeError('sourceUserSeq is invalid');
  }
  const digest = createHash('sha256')
    .update(`${input.sessionId}\u0000${input.sourceUserSeq}\u0000${input.proposalKey}`, 'utf8')
    .digest('hex');
  return `automation_${digest.slice(0, 32)}`;
}

function parseOpportunityInput(raw: unknown): AutomationOpportunityV1 {
  const parsed = parseAutomationOpportunity(raw);
  if (Buffer.byteLength(canonicalAutomationOpportunityJson(parsed), 'utf8') > MAX_OPPORTUNITY_JSON_BYTES) {
    throw new Error(`opportunity exceeds ${MAX_OPPORTUNITY_JSON_BYTES} canonical bytes`);
  }
  return parsed;
}

function publicRecord(record: AutomationOpportunityProposalRecordV1): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    proposalId: record.proposalId,
    status: record.status,
    revision: record.revision,
    digest: record.digest,
    title: record.opportunity.title,
    objective: record.opportunity.objective,
    lifetime: record.opportunity.lifetime,
    recurrence: record.opportunity.recurrence,
    effectCeiling: record.opportunity.effectCeiling,
    phaseCount: record.opportunity.phases.length,
    capabilityRequirementCount: record.opportunity.capabilityRequirements.length,
    deliverableCount: record.opportunity.deliverables.length,
    datasetFieldCount: record.opportunity.dataset?.schema.fields.length ?? 0,
    missingInputCount: record.opportunity.missingInputs.length,
    missingInputs: record.opportunity.missingInputs.slice(0, 20).map((missing) => ({
      id: missing.id,
      required: missing.required,
      description: missing.description.slice(0, 256),
      blockingPhaseIds: missing.blockingPhaseIds,
    })),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.reviewedAt ? { reviewedAt: record.reviewedAt } : {}),
    ...(record.decidedAt ? { decidedAt: record.decidedAt } : {}),
  };
  return summary;
}

function recordResult(record: AutomationOpportunityProposalRecordV1, message: string) {
  return textResult(JSON.stringify({
    ok: true,
    message,
    proposal: {
      ...publicRecord(record),
      opportunity: record.opportunity,
    },
    executionAuthority: 'none',
    nextBoundary: 'user_review',
  }), { maxChars: MAX_OPPORTUNITY_JSON_BYTES });
}

/**
 * Chat-facing review tools for AutomationOpportunityV1.
 *
 * Intentionally absent: approve, pilot, compile, schedule, run, and Space
 * creation. A model can draft or revise review bytes, but only the canonical
 * approval/pilot/workflow boundaries may grant execution authority.
 */
export function registerAutomationOpportunityTools(
  server: McpServer,
  options: AutomationOpportunityToolOptions = {},
): void {
  server.tool(
    'automation_opportunity_propose',
    'Persist an inert, reviewable AutomationOpportunityV1 when durable background, scheduled, partitioned, or item-recoverable work would materially help. This creates no workflow, pilot, schedule, Space, or execution authority.',
    {
      proposal_key: z.string().regex(PROPOSAL_KEY_RE)
        .describe('Stable key for this distinct opportunity within the accepted user turn.'),
      opportunity: automationOpportunitySchema
        .describe('The complete provider-neutral opportunity. Provider and tool names do not belong in this semantic proposal.'),
      note: z.string().trim().min(1).max(8_192).optional(),
    },
    async ({ proposal_key, opportunity: opportunityInput, note }) => {
      const source = currentAcceptedSource(options.acceptedSource);
      if (!source) {
        return textResult(JSON.stringify({
          ok: false,
          code: 'accepted_source_required',
          message: 'An exact accepted chat source must own an automation proposal.',
        }), { isError: true });
      }
      let opportunity: AutomationOpportunityV1;
      try {
        opportunity = parseOpportunityInput(opportunityInput);
      } catch (error) {
        return textResult(JSON.stringify({
          ok: false,
          code: 'invalid_opportunity',
          message: error instanceof Error ? error.message : String(error),
        }), { isError: true });
      }
      const proposalId = automationOpportunityProposalId({
        ...source,
        proposalKey: proposal_key,
      });
      const created = createAutomationOpportunityProposal({
        proposalId,
        opportunity,
        actorRef: actorRef(source),
        ...(note ? { note } : {}),
        ...(options.database ? { database: options.database } : {}),
      });
      if (created.ok) return recordResult(created.record, 'Automation opportunity saved for review.');
      if (created.code === 'already_exists'
        && created.current
        && canonicalAutomationOpportunityJson(created.current.opportunity)
          === canonicalAutomationOpportunityJson(opportunity)) {
        return recordResult(created.current, 'Exact automation opportunity replayed without creating a duplicate.');
      }
      return textResult(JSON.stringify({
        ok: false,
        code: created.code,
        message: created.message,
        ...(created.current ? { current: publicRecord(created.current) } : {}),
      }), { maxChars: MAX_OPPORTUNITY_JSON_BYTES, isError: true });
    },
  );

  server.tool(
    'automation_opportunity_revise',
    'Revise an inert automation opportunity using its exact current revision and digest. Revision does not approve, pilot, compile, schedule, or execute it.',
    {
      proposal_id: z.string().min(1).max(128),
      expected_revision: z.number().int().positive(),
      expected_digest: z.string().regex(DIGEST_RE),
      opportunity: automationOpportunitySchema,
      note: z.string().trim().min(1).max(8_192).optional(),
    },
    async ({ proposal_id, expected_revision, expected_digest, opportunity: opportunityInput, note }) => {
      const source = currentAcceptedSource(options.acceptedSource);
      if (!source) {
        return textResult(JSON.stringify({
          ok: false,
          code: 'accepted_source_required',
          message: 'An exact accepted chat source must own an automation proposal revision.',
        }), { isError: true });
      }
      let opportunity: AutomationOpportunityV1;
      try {
        opportunity = parseOpportunityInput(opportunityInput);
      } catch (error) {
        return textResult(JSON.stringify({
          ok: false,
          code: 'invalid_opportunity',
          message: error instanceof Error ? error.message : String(error),
        }), { isError: true });
      }
      const revised = reviseAutomationOpportunityProposal({
        proposalId: proposal_id,
        opportunity,
        expectedRevision: expected_revision,
        expectedDigest: expected_digest,
        actorRef: actorRef(source),
        ...(note ? { note } : {}),
        ...(options.database ? { database: options.database } : {}),
      });
      if (revised.ok) return recordResult(revised.record, 'Automation opportunity revision saved for review.');
      return textResult(JSON.stringify({
        ok: false,
        code: revised.code,
        message: revised.message,
        ...(revised.current ? { current: publicRecord(revised.current) } : {}),
      }), { maxChars: MAX_OPPORTUNITY_JSON_BYTES, isError: true });
    },
  );

  server.tool(
    'automation_opportunity_get',
    'Read one inert automation opportunity proposal by its exact ID.',
    { proposal_id: z.string().min(1).max(128) },
    async ({ proposal_id }) => {
      const record = loadAutomationOpportunityProposal(proposal_id, options.database);
      return record
        ? recordResult(record, 'Automation opportunity loaded.')
        : textResult(JSON.stringify({ ok: false, code: 'not_found', message: 'Automation opportunity was not found.' }), { isError: true });
    },
  );

  server.tool(
    'automation_opportunity_list',
    'List inert automation opportunity proposals for review. This is read-only and grants no execution authority.',
    {
      status: z.enum(['proposed', 'reviewed', 'approved', 'rejected']).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async ({ status, limit }) => {
      const records = listAutomationOpportunityProposals({
        ...(status ? { status: status as AutomationOpportunityProposalStatus } : {}),
        ...(limit ? { limit } : {}),
        ...(options.database ? { database: options.database } : {}),
      });
      return textResult(JSON.stringify({
        ok: true,
        proposals: records.map(publicRecord),
        executionAuthority: 'none',
      }), { maxChars: MAX_OPPORTUNITY_JSON_BYTES });
    },
  );
}
