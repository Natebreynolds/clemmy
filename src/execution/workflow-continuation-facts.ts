/**
 * What each workflow run the owner started together actually produced, for
 * the brain that continues the held request once they have all finished.
 *
 * Live 2026-10-21: the continuation was handed one run's report prose and
 * per-tool settlement counts ("write_file, succeeded, mutating, 1 call"). The
 * note a child had saved was named nowhere in that, so the brain searched the
 * home folder with the shell for it, found nothing, and still reported it
 * without a path. The run's own workspace already records the step's output
 * with the committed path. This hands those facts over, bounded, per member:
 * no search, no guessing, and the same facts the reviewer reads.
 */
import { readWorkflowRunRecordSnapshot } from './workflow-run-record.js';
import { workflowRunRecordFile } from './workflow-run-report-back.js';
import { readStepOutputArtifact, readWorkspaceManifest } from './workflow-run-workspace.js';

export interface WorkflowMemberStepFacts {
  step: string;
  /** The step's recorded output, as JSON or text, bounded. */
  output: string;
  /** A file the step committed, by the path the host recorded for it. */
  file?: { path: string; result?: string };
}

export interface WorkflowMemberFacts {
  runId: string;
  workflow: string;
  status: string;
  outcome: string;
  /** The run's own report, bounded. */
  detail: string;
  steps: WorkflowMemberStepFacts[];
  /** Everything the run's workspace indexed: who made it, what, how big. */
  artifacts: Array<{ path: string; agent: string; summary: string; bytes: number }>;
}

const DETAIL_MAX_CHARS = 2_000;
const OUTPUT_MAX_CHARS = 800;
const RESULT_MAX_CHARS = 300;
const STEPS_MAX = 12;
const ARTIFACTS_MAX = 20;
const LOCAL_FILE_RECEIPT_PREFIX = 'local-file-receipt:v1:';

function bounded(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value) ?? ''; } catch { return String(value); }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The committed file a step output names: either directly (an object with a
 * recorded path) or through a local-file receipt the workspace artifact
 * resolves to the path the host committed. */
function committedFile(input: { workflow: string; runId: string; step: string; output: unknown }): WorkflowMemberStepFacts['file'] | undefined {
  const direct = record(input.output);
  if (direct && typeof direct.path === 'string' && direct.path.trim()) {
    return { path: direct.path, ...(typeof direct.result === 'string' ? { result: bounded(direct.result, RESULT_MAX_CHARS) } : {}) };
  }
  const receipt = typeof input.output === 'string' ? input.output
    : direct && typeof direct.artifactId === 'string' ? direct.artifactId : '';
  if (!receipt.startsWith(LOCAL_FILE_RECEIPT_PREFIX)) return undefined;
  try {
    const artifact = readStepOutputArtifact({ workflowName: input.workflow, runId: input.runId, stepId: input.step });
    const value = record(artifact.value);
    if (!artifact.found || !value || typeof value.path !== 'string' || !value.path.trim()) return undefined;
    return { path: value.path, ...(typeof value.result === 'string' ? { result: bounded(value.result, RESULT_MAX_CHARS) } : {}) };
  } catch {
    return undefined;
  }
}

/** The facts of each run, in the order given; a run whose record cannot be
 * read is left out rather than guessed. */
export function workflowMemberFactsForContinuation(runIds: readonly string[]): WorkflowMemberFacts[] {
  const facts: WorkflowMemberFacts[] = [];
  for (const runId of runIds) {
    try {
      const file = workflowRunRecordFile(runId);
      const run = file ? readWorkflowRunRecordSnapshot<Record<string, unknown>>(file) : null;
      if (!run || run.id !== runId) continue;
      const workflow = typeof run.workflow === 'string' ? run.workflow : '';
      const reportBack = record(run.reportBack);
      const outputs = record(run.stepOutputs) ?? {};
      const steps: WorkflowMemberStepFacts[] = Object.entries(outputs).slice(0, STEPS_MAX).map(([step, output]) => {
        const committed = workflow ? committedFile({ workflow, runId, step, output }) : undefined;
        return { step, output: bounded(asText(output), OUTPUT_MAX_CHARS), ...(committed ? { file: committed } : {}) };
      });
      const artifacts = workflow
        ? readWorkspaceManifest(workflow, runId).slice(0, ARTIFACTS_MAX).map((entry) => ({
            path: String(entry.path ?? ''), agent: String(entry.agent ?? ''),
            summary: bounded(String(entry.summary ?? ''), RESULT_MAX_CHARS), bytes: Number(entry.bytes ?? 0) || 0,
          }))
        : [];
      facts.push({
        runId, workflow,
        status: typeof run.status === 'string' ? run.status : '',
        outcome: reportBack && typeof reportBack.outcome === 'string' ? reportBack.outcome : '',
        detail: reportBack && typeof reportBack.detail === 'string' ? bounded(reportBack.detail, DETAIL_MAX_CHARS) : '',
        steps, artifacts,
      });
    } catch {
      /* a member whose record cannot be read is left out, never guessed */
    }
  }
  return facts;
}
