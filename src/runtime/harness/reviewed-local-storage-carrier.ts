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
import type { BrowserOperationRunner } from '../../integrations/browser-operation.js';
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

const localFileStorage: HostLocalWriteStorageAdapter = Object.freeze({
  async execute(call: AttestedTransportCall): Promise<unknown> {
    const prepared = prepareReviewedLocalToolExecution(call);
    if (prepared.adapter !== 'local_file_revision_v1') throw new Error('Not a reviewed file revision');
    const carrier = await import('./local-file-workflow-carrier.js');
    return carrier.executeReviewedLocalFile(prepared.args);
  },
  async reconcile(input: HostLocalWriteReconcileInput): Promise<AttestedTransportReconcileResult> {
    const observed = observeReviewedLocalTool(input.operationId);
    if (!observed || observed.execution.reconciliation !== 'local_file_revision_v1'
      || !reviewedLocalExpectedIdentityMatches(input, observed)) return { exists: false };
    const carrier = await import('./local-file-workflow-carrier.js');
    return carrier.reconcileReviewedLocalFile(input.artifactId);
  },
});

const localFileReadStorage: HostLocalWriteStorageAdapter = Object.freeze({
  async execute(call: AttestedTransportCall): Promise<unknown> {
    const prepared = prepareReviewedLocalToolExecution(call);
    if (prepared.adapter !== 'local_file_read_v1') throw new Error('Not a reviewed file read');
    const { executeLocalFileRead } = await import('../../tools/computer-tools.js');
    const { InvalidArgumentsPreDispatchResult } = await import('./attempt-settlement.js');
    const result = await executeLocalFileRead(prepared.args, undefined, undefined, { failOnReadError: true, completeOutput: true });
    if (result instanceof InvalidArgumentsPreDispatchResult) throw new Error(String(result));
    return { result: { data: { path: prepared.args.path, content: result } }, complete: true };
  },
  async reconcile(): Promise<AttestedTransportReconcileResult> { return { exists: false }; },
});

const workspaceScriptStorage: HostLocalWriteStorageAdapter = Object.freeze({
  async execute(call: AttestedTransportCall): Promise<unknown> {
    const prepared = prepareReviewedLocalToolExecution(call);
    if (prepared.adapter !== 'workspace_script_v1') throw new Error('Not a saved source script');
    const carrier = await import('../../spaces/workspace-script-carrier.js');
    // Validation parses values but must not reorder the sealed call object.
    return carrier.executeReviewedWorkspaceScript(call.args as typeof prepared.args);
  },
  // Without a committed kernel receipt, a script may already have caused
  // effects. Never probe its output or rerun it to manufacture reconciliation.
  async reconcile(): Promise<AttestedTransportReconcileResult> { return { exists: false }; },
});

export function createReviewedBrowserStorageAdapter(runner?: BrowserOperationRunner): HostLocalWriteStorageAdapter {
  return Object.freeze({
  async execute(call: AttestedTransportCall): Promise<unknown> {
    const prepared = prepareReviewedLocalToolExecution(call);
    if (prepared.adapter !== 'browser_operation_v1') throw new Error('Not a reviewed browser operation');
    const { executeBrowserOperation, browserOperationProvesNoMutation } = await import('../../integrations/browser-operation.js');
    const { currentToolAbortSignal } = await import('../tool-abort-context.js');
    const result = await executeBrowserOperation(prepared.operation, prepared.args, { signal: currentToolAbortSignal(), runner });
    // Preserve structured uncertainty rather than manufacture a successful effect receipt.
    if (result.ok !== true) {
      if (browserOperationProvesNoMutation(result)) {
        const { hostPreDispatchRefusal } = await import('./host-pre-dispatch-refusal.js');
        throw hostPreDispatchRefusal(JSON.stringify(result));
      }
      throw Object.assign(new Error(JSON.stringify(result)), { browserReceipt: result.receipt });
    }
    return result;
  },
  async reconcile(): Promise<AttestedTransportReconcileResult> { return { exists: false }; },
  });
}
const browserStorage = createReviewedBrowserStorageAdapter();

export const reviewedLocalStorageCarrier: HostLocalWriteCarrier = Object.freeze({
  select(input: { operationId: string; accountId: string }) {
    if (input.accountId !== REVIEWED_LOCAL_ACCOUNT) return null;
    const observed = observeReviewedLocalTool(input.operationId);
    if (observed?.execution.adapter === 'browser_operation_v1') return browserStorage;
    if (observed?.execution.adapter === 'workspace_script_v1') return workspaceScriptStorage;
    if (observed?.execution.adapter === 'local_file_read_v1') return localFileReadStorage;
    if (observed?.execution.adapter === 'local_file_revision_v1') return localFileStorage;
    if (observed?.execution.adapter !== 'workspace_dataset_v1') return null;
    return workspaceDatasetStorage;
  },
});
