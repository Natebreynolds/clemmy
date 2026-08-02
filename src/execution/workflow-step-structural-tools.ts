/**
 * Structural channels that every workflow step retains when its work-tool
 * surface is locked to an exact capability set.
 *
 * Keep this module dependency-free. Both the runtime step agent and the
 * compiled-project IR import this same value so there is no duplicated list,
 * dynamic-import test, or opportunity for authority drift.
 */
export const STEP_STRUCTURAL_BASELINE_TOOL_NAMES: readonly string[] = Object.freeze([
  'notify_user',
  'read_file',
  'recall_tool_result',
  'tool_output_query',
  'workflow_step_result',
  'workspace_artifact_query',
]);

export const STEP_STRUCTURAL_BASELINE_TOOLS: ReadonlySet<string> = new Set(
  STEP_STRUCTURAL_BASELINE_TOOL_NAMES,
);

/**
 * Compiled-project nodes are internal graph workers, not public workflow
 * reporters. Their implicit channels therefore stop at durable result return
 * and bounded retrieval of data already owned by the run. In particular,
 * `notify_user` is deliberately absent: the project root lifecycle owns the
 * one public terminal report, so a retried specialist cannot narrate or notify
 * twice. General file access is also authored explicitly rather than smuggled
 * in as structure.
 *
 * Keep the ordinary workflow baseline above unchanged. Existing catalog
 * workflows (including reporting workflows) still retain their legacy report
 * channel; this smaller set applies only after compiled-project admission.
 */
export const PROJECT_STEP_STRUCTURAL_TOOL_NAMES: readonly string[] = Object.freeze([
  'recall_tool_result',
  'tool_output_query',
  'workflow_step_result',
  'workspace_artifact_query',
]);

export const PROJECT_STEP_STRUCTURAL_TOOLS: ReadonlySet<string> = new Set(
  PROJECT_STEP_STRUCTURAL_TOOL_NAMES,
);
