/**
 * Workspace read-authority mint.
 *
 * A Workspace data-source refresh is a READ, and reads redeem the shared
 * durable workflow_v1_read_only kernel — the one authority root the Space
 * Composio gate accepts. This seam activates that kernel for the exact
 * declared operation and returns the opaque authority address every
 * refreshSpaceData caller (dashboard route, scheduler, creation smoke,
 * Ask Clem) supplies to the runner.
 *
 * It mints READ authority only. Space ACTIONS keep the stricter
 * workflow_v3_call demand: mutations need an approved compilation with a
 * durable capability binding and (when required) a consumed one-shot human
 * grant, which no refresh-time seam can honestly synthesize.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createSession, getSession } from '../runtime/harness/eventlog.js';
import { acquireWorkflowReadOnlyOperationAuthority } from '../runtime/harness/workflow-read-only-call-kernel.js';
import { isolatedTestContractActive } from '../runtime/harness/isolated-test-contract.js';
import {
  prepareWorkflowStepExternalCatalog,
  type WorkflowStepExternalCatalogDependencies,
} from '../execution/workflow-step-external-catalog.js';
import { workspaceComposioIsProvablyReadOnly } from './space-execution-policy.js';
import type { SpaceSharedDurableComposioAuthority } from './runner.js';

/** Identity charset accepted by the durable activation tables. */
const EXACT_WORKFLOW_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,255}$/;

function exactIdOrDigest(value: string): string {
  const trimmed = value.trim();
  if (EXACT_WORKFLOW_ID_RE.test(trimmed)) return trimmed;
  return `sha:${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 40)}`;
}

export type AcquireSpaceReadAuthorityResult =
  | { ok: true; authority: SpaceSharedDurableComposioAuthority }
  | { ok: false; error: string };

type ExactSpaceReadCatalogPreparer = typeof prepareWorkflowStepExternalCatalog;
let exactSpaceReadCatalogPreparer: ExactSpaceReadCatalogPreparer =
  prepareWorkflowStepExternalCatalog;

/** Isolated-test seam for exercising the real refresh caller with a cold,
 * fixture-owned metadata source. Production code cannot replace the provider
 * preparer. */
export function _setExactSpaceReadCatalogPreparerForTests(
  preparer: ExactSpaceReadCatalogPreparer | null,
): void {
  if (!isolatedTestContractActive()) {
    throw new Error('space read catalog preparer overrides are isolated-test only');
  }
  exactSpaceReadCatalogPreparer = preparer ?? prepareWorkflowStepExternalCatalog;
}

/**
 * Reopen one declared Workspace READ from durable provider metadata before
 * minting its workflow-kernel authority. A cold daemon has no in-memory
 * catalog/observation even when the Workspace declaration and durable
 * manifest are current; relying on a prior chat/workflow to warm those rows
 * made standalone and scheduled refreshes deterministically fail closed.
 *
 * The exact Workspace declaration is the only selector. The shared preparer
 * revalidates its account/schema/definition, publishes the bounded independent
 * observation, and refreshes only that manifest. The read-only authority mint
 * below still independently requires one exact current READ binding, so this
 * seam cannot turn an action/write declaration into refresh authority.
 */
export async function prepareAndAcquireSpaceReadAuthority(
  input: {
    slug: string;
    sourceId: string;
    toolSlug: string;
    args: Record<string, unknown>;
    /** Provenance only; it never widens what the activation may execute. */
    cause: string;
  },
  dependencies: WorkflowStepExternalCatalogDependencies = {},
): Promise<AcquireSpaceReadAuthorityResult> {
  const operationId = input.toolSlug.trim().toUpperCase();
  if (!operationId) return { ok: false, error: 'workspace read operation is blank' };
  // Preserve the hot-path semantics: when the exact current catalog already
  // proves this operation is a read, mint directly without another metadata
  // round trip. Cold processes take the bounded revalidation path below.
  if (workspaceComposioIsProvablyReadOnly(operationId)) {
    return acquireSpaceReadAuthority({ ...input, toolSlug: operationId });
  }
  let prepared: Awaited<ReturnType<typeof prepareWorkflowStepExternalCatalog>>;
  try {
    prepared = await exactSpaceReadCatalogPreparer({
      immutablePrompt: '',
      allowedTools: [operationId],
    }, dependencies);
  } catch (error) {
    return {
      ok: false,
      error: `workspace read catalog preparation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (prepared.status !== 'ready') {
    return {
      ok: false,
      error: prepared.status === 'none'
        ? `no durable current manifest is available for "${operationId}"`
        : [
            `exact read catalog preparation was refused (${prepared.reason})`,
            prepared.operationId,
            prepared.detail,
          ].filter(Boolean).join(':'),
    };
  }
  if (
    prepared.manifestIds.length !== 1
    || prepared.operationIds.length !== 1
    || prepared.operationIds[0] !== operationId
  ) {
    return {
      ok: false,
      error: `exact read catalog preparation did not resolve one manifest for "${operationId}"`,
    };
  }
  if (!workspaceComposioIsProvablyReadOnly(operationId)) {
    return {
      ok: false,
      error: `prepared Workspace operation "${operationId}" is not provably read-only`,
    };
  }
  return acquireSpaceReadAuthority({ ...input, toolSlug: operationId });
}

type ReviewedCliReadAcquirer = (input: {
  ownerId: string;
  nodeId: string;
  operationId: string;
  expectedEffect: 'read';
  deadlineAt: number;
}) => Promise<{ status: 'present' | 'acquired' | 'unavailable'; detail?: string }>;

const productionReviewedCliReadAcquirer: ReviewedCliReadAcquirer = async (input) => {
  const { ensureLiveReadCapabilityForOperation } = await import(
    '../execution/workflow-live-call-compiler.js'
  );
  return ensureLiveReadCapabilityForOperation(input);
};
let reviewedCliReadAcquirer: ReviewedCliReadAcquirer = productionReviewedCliReadAcquirer;

export function _setReviewedCliReadAcquirerForTests(
  acquirer: ReviewedCliReadAcquirer | null,
): void {
  if (!isolatedTestContractActive()) {
    throw new Error('space reviewed read acquirer overrides are isolated-test only');
  }
  reviewedCliReadAcquirer = acquirer ?? productionReviewedCliReadAcquirer;
}

/** A reviewed CLI read is a local binary; connecting it is fast or fails fast. */
const REVIEWED_CLI_READ_ACQUIRE_BUDGET_MS = 30_000;

/**
 * A Space data source whose frozen command line is a reviewed CLI read runs as
 * that operation: the same just-in-time live-read acquisition a workflow step
 * uses installs the reviewed carrier's current catalog entry when it is not
 * present yet, and the same read-only kernel activation carries the call.
 * There is no second executor for command lines.
 */
export async function prepareAndAcquireSpaceReviewedCliReadAuthority(input: {
  slug: string;
  sourceId: string;
  operationId: string;
  args: Record<string, unknown>;
  cause: string;
}): Promise<AcquireSpaceReadAuthorityResult> {
  const operationId = input.operationId.trim();
  if (!operationId) return { ok: false, error: 'workspace reviewed read operation is blank' };
  let acquisition: Awaited<ReturnType<ReviewedCliReadAcquirer>>;
  try {
    acquisition = await reviewedCliReadAcquirer({
      ownerId: `workspace:${input.slug}`,
      nodeId: `source:${input.sourceId}`,
      operationId,
      expectedEffect: 'read',
      deadlineAt: Date.now() + REVIEWED_CLI_READ_ACQUIRE_BUDGET_MS,
    });
  } catch (error) {
    return {
      ok: false,
      error: `reviewed read "${operationId}" could not be prepared: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (acquisition.status === 'unavailable') {
    return {
      ok: false,
      error: `reviewed read "${operationId}" is not available on this machine${
        acquisition.detail ? `: ${acquisition.detail}` : ''
      }`,
    };
  }
  return acquireSpaceReadAuthority({ ...input, toolSlug: operationId });
}

export function acquireSpaceReadAuthority(input: {
  slug: string;
  sourceId: string;
  toolSlug: string;
  args: Record<string, unknown>;
  /** Provenance only; it never widens what the activation may execute. */
  cause: string;
}): AcquireSpaceReadAuthorityResult {
  const sessionId = exactIdOrDigest(`workspace:${input.slug}`);
  try {
    if (!getSession(sessionId)) {
      createSession({
        id: sessionId,
        kind: 'workflow',
        title: `Workspace ${input.slug} durable reads`,
      });
    }
  } catch (error) {
    return {
      ok: false,
      error: `workspace read-authority session is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  // Every refresh is its own run occurrence: a fresh durable activation whose
  // one exact call the kernel executes (or replays) exactly once.
  const occurrence = `refresh:${exactIdOrDigest(input.cause)}:${randomUUID()}`;
  const acquired = acquireWorkflowReadOnlyOperationAuthority({
    sessionId,
    workflowId: exactIdOrDigest(`workspace-refresh:${input.slug}`),
    runId: occurrence,
    runOccurrenceId: occurrence,
    nodeId: exactIdOrDigest(`source:${input.sourceId}`),
    requirementId: exactIdOrDigest(`workspace:${input.slug}:source:${input.sourceId}`),
    logicalCapabilityId: exactIdOrDigest(`workspace.read:${input.toolSlug}`),
    operationId: input.toolSlug,
    args: input.args,
  });
  if (acquired.status !== 'armed') return { ok: false, error: acquired.reason };
  return {
    ok: true,
    authority: {
      version: 1,
      kernel: 'workflow_v1_read_only',
      activationId: acquired.activationId,
      invocationPlan: acquired.invocationPlan,
    },
  };
}
