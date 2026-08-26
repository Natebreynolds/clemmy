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
