/**
 * Execute discovery receipts from a reviewed plan. Metadata only: current
 * catalog/schema must still match, and dispatch/consent stay at the tool edge.
 *
 * Live 2026-09-14: Act after a published Docs write still spent a provider
 * search on the Docs markdown-update operation. The reviewed binding was
 * already on the artifact. Execute ("go") should revalidate that receipt
 * instead of enumerating Firecrawl.
 */
import { acceptedPlanExecution } from './accepted-plan-execution.js';
import { acceptedTaskMode } from './accepted-task-mode.js';
import { getToolOutputContext } from './tool-output-context.js';
import {
  canonicalCatalogIdentityOf,
  isCurrentCallableCatalogEntry,
  peekHostCapabilityCatalogFactory,
} from './host-capability-catalog-factory.js';
import {
  AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
  revalidateLocalPlanningDefinition,
  type AuthorizedLocalPlanningDefinitionV1,
} from './local-planning-capability.js';
import { getCachedToolSchema } from '../../tools/composio-schema-cache.js';
import { digestSchema } from '../../tools/tool-contract-store.js';
import { closedCanonicalJson, SEALED_CALL_CANONICAL_LIMITS } from '../../shared/closed-canonical-json.js';
import type { PlanArtifactV1 } from './plan-artifacts.js';
import type {
  ToolSearchBrokerCandidate,
  ToolSearchCandidateSourceKind,
} from '../../tools/tool-search-tool.js';

export type ReviewedPlanSearchReceipt = ToolSearchBrokerCandidate & {
  sourceKind: ToolSearchCandidateSourceKind;
};

const GENERIC_PLAN_RECEIPT_NAME_TOKENS = new Set([
  'sf', 'cli', 'get', 'list', 'read', 'query', 'run', 'tool', 'call',
]);

const object = (value: unknown): value is Record<string, any> => (
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
);

function equal(left: unknown, right: unknown): boolean {
  return closedCanonicalJson(left, SEALED_CALL_CANONICAL_LIMITS)
    === closedCanonicalJson(right, SEALED_CALL_CANONICAL_LIMITS);
}

function queryExplicitlyNamesTool(query: string, toolName: string): boolean {
  const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, 'i').test(query);
}

/** Exact slug or two distinctive name tokens. Writes may match: these are
 * reviewed operations, not a live-read shortcut. */
export function queryMatchesReviewedPlanTool(query: string, toolName: string): boolean {
  if (queryExplicitlyNamesTool(query, toolName)) return true;
  const haystack = query.toLowerCase();
  const tokens = toolName.toLowerCase().split(/[^a-z0-9]+/).filter((token) => (
    token.length >= 3 && !GENERIC_PLAN_RECEIPT_NAME_TOKENS.has(token)
  ));
  if (tokens.length < 2) return false;
  const hits = tokens.filter((token) => haystack.includes(token)).length;
  return hits >= Math.min(2, tokens.length);
}

export function reviewedPlanReceiptAnswersQuery(
  query: string,
  receipts: ReadonlyArray<Pick<ReviewedPlanSearchReceipt, 'name'>>,
): boolean {
  return receipts.some((receipt) => queryMatchesReviewedPlanTool(query, receipt.name));
}

function operationNameOf(identity: Record<string, any>): string | null {
  if (identity.kind === 'local_registry') {
    const name = identity.definition?.name;
    return typeof name === 'string' && name.trim() ? name : null;
  }
  const operationId = identity.operationId;
  return typeof operationId === 'string' && operationId.trim() ? operationId : null;
}

function sourceKindOf(identity: Record<string, any>): ToolSearchCandidateSourceKind | null {
  if (identity.kind === 'local_registry') return AUTHORIZED_LOCAL_REGISTRY_PROVENANCE;
  if (identity.providerKind === 'composio') return 'authorized_composio';
  if (identity.providerKind === 'native_mcp') return 'authorized_external_mcp';
  return null;
}

async function materializeBinding(
  binding: Record<string, any>,
): Promise<ReviewedPlanSearchReceipt | null> {
  if (!object(binding.identity) || typeof binding.capabilityRef !== 'string') return null;
  const identity = binding.identity;
  const name = operationNameOf(identity);
  const sourceKind = sourceKindOf(identity);
  if (!name || !sourceKind) return null;
  if (identity.kind === 'local_registry') {
    const prior = identity.definition as AuthorizedLocalPlanningDefinitionV1;
    const current = await revalidateLocalPlanningDefinition(prior);
    if (!current.ok) return null;
    const schema = object(binding.inputSchema) ? binding.inputSchema : undefined;
    return {
      name,
      summary: `Reviewed local operation ${name}`,
      ...(schema ? { schema } : {}),
      carrier: prior.carrier === 'call_tool' ? 'call_tool' : 'work_call',
      score: 1,
      sourceKind,
      invocation: { name, payloadField: null },
    };
  }
  const entry = peekHostCapabilityCatalogFactory()?.get(binding.capabilityRef);
  const canonical = entry && isCurrentCallableCatalogEntry(entry)
    ? canonicalCatalogIdentityOf(entry)
    : null;
  const schema = canonical ? getCachedToolSchema(canonical.operationId) : null;
  if (
    !canonical
    || !schema
    || !equal(canonical, identity)
    || digestSchema(JSON.parse(closedCanonicalJson(schema, {
      ...SEALED_CALL_CANONICAL_LIMITS,
      omitUndefinedObjectMembers: true,
    }))) !== canonical.providerInputSchemaDigest
  ) return null;
  return {
    name: canonical.operationId,
    summary: `Reviewed ${canonical.operationId}`,
    schema,
    carrier: 'work_call',
    score: 1,
    sourceKind,
    ...(sourceKind === 'authorized_composio'
      ? {
          invocation: {
            name: 'composio_execute_tool',
            fixedArgs: { tool_slug: canonical.operationId },
            payloadField: 'arguments',
          },
        }
      : {}),
  };
}

export async function materializeReviewedPlanSearchReceipts(
  query: string,
  artifact: PlanArtifactV1,
): Promise<ReviewedPlanSearchReceipt[]> {
  const bindings = artifact.structuredPlan?.preparedBindings;
  if (!Array.isArray(bindings) || artifact.readiness !== 'ready') return [];
  const receipts: ReviewedPlanSearchReceipt[] = [];
  for (const row of bindings) {
    if (!object(row)) continue;
    const binding = row as Record<string, unknown>;
    if (!object(binding.identity)) continue;
    const name = operationNameOf(binding.identity);
    if (!name || !queryMatchesReviewedPlanTool(query, name)) continue;
    const receipt = await materializeBinding(binding);
    if (receipt) receipts.push(receipt);
  }
  return receipts;
}

/** Execute only. A later Act turn must not infer the newest plan. */
export async function reviewedPlanSearchReceiptsForCurrentTurn(
  query: string,
): Promise<ReviewedPlanSearchReceipt[]> {
  const context = getToolOutputContext();
  if (!context?.sessionId || context.sourceUserSeq == null) return [];
  if (acceptedTaskMode(context.sessionId, context.sourceUserSeq)?.kind !== 'execute') return [];
  try {
    const selected = acceptedPlanExecution(context.sessionId, context.sourceUserSeq);
    if (!selected) return [];
    return materializeReviewedPlanSearchReceipts(query, selected.artifact);
  } catch {
    return [];
  }
}
