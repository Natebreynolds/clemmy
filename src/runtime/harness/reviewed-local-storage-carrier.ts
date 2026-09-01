/**
 * Host storage carrier for reviewed Clementine-local mutations whose durable
 * home is the Workspace store (SQLite + data.json).
 *
 * The attested transport leaf executes file-system-only reviewed writes by
 * itself. Writes that need host storage are executed here, on the host's own
 * module instance, and reached from every adapter instance — the host ESM one
 * and the shipped invoke/reconcile artifacts — through the import-free
 * `host-local-write-carrier` seam. Nothing here is a bundle input: the shipped
 * artifacts call the carrier the host bound, they never import it.
 *
 * Selection is by the registry's reviewed execution contract; no tool name is
 * interpreted. Every crossing re-runs the same identity/arguments bar the
 * transport leaf applies (`prepareReviewedLocalToolExecution`) before its
 * first storage lookup.
 */
import type {
  HostLocalWriteCarrier,
  HostLocalWriteReconcileInput,
  HostLocalWriteStorageAdapter,
} from './implementation-artifacts/host-local-write-carrier.js';
import type { AttestedTransportCall, AttestedTransportReconcileResult } from './implementation-artifacts/attested-transport.js';
import {
  observeReviewedLocalTool,
  prepareReviewedLocalToolExecution,
  reviewedLocalExpectedIdentityMatches,
  REVIEWED_LOCAL_ACCOUNT,
} from './reviewed-local-tool-transport.js';

// The Workspace carrier sits inside the SpaceStore module graph, which itself
// reaches this harness at evaluation. Resolving it at call time keeps
// SpaceStore cold-importable (pinned by workspace-set-data-reviewed-adapter)
// instead of re-entering store/finalization while their defaults are in TDZ.
async function workspaceCarrier() {
  return import('../../spaces/workspace-set-data-carrier.js');
}

const workspaceDatasetStorage: HostLocalWriteStorageAdapter = Object.freeze({
  async execute(call: AttestedTransportCall): Promise<unknown> {
    const prepared = prepareReviewedLocalToolExecution(call);
    if (prepared.adapter !== 'workspace_dataset_v1') {
      throw new Error('reviewed local execution is not a Workspace dataset commit');
    }
    const carrier = await workspaceCarrier();
    return carrier.executeReviewedWorkspaceSetData(prepared.args);
  },
  async reconcile(input: HostLocalWriteReconcileInput): Promise<AttestedTransportReconcileResult> {
    const observed = observeReviewedLocalTool(input.operationId);
    if (
      !observed
      || observed.execution.reconciliation !== 'workspace_dataset_v1'
      || !reviewedLocalExpectedIdentityMatches(input, observed)
    ) return { exists: false };
    const carrier = await workspaceCarrier();
    const recovered = carrier.reconcileWorkspaceDatasetArtifact(input.artifactId);
    if (!recovered.exists) return { exists: false };
    return {
      exists: true,
      artifactId: recovered.artifactId,
      handle: recovered.handle,
      contentDigest: recovered.contentDigest,
      receipt: recovered.receipt,
    };
  },
});

export const reviewedLocalStorageCarrier: HostLocalWriteCarrier = Object.freeze({
  select(input: { operationId: string; accountId: string }) {
    if (input.accountId !== REVIEWED_LOCAL_ACCOUNT) return null;
    const observed = observeReviewedLocalTool(input.operationId);
    if (observed?.execution.adapter !== 'workspace_dataset_v1') return null;
    return workspaceDatasetStorage;
  },
});
