/** Structured user intent. Text never selects a mode or authorizes Execute. */
export type PlanRevisionRef = { planId: string; revision: number; digest: string };
export type TaskMode =
  | { version: 1; kind: 'normal' | 'plan' }
  | { version: 1; kind: 'execute'; executeRef: PlanRevisionRef };
export type ComposerMode = 'normal' | 'plan';

export function readPlanRevisionRef(value: unknown): PlanRevisionRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.planId !== 'string' || !row.planId.trim()
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1
    || typeof row.digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.digest)) return undefined;
  return { planId: row.planId, revision: Number(row.revision), digest: row.digest };
}

export function readTaskMode(value: unknown): TaskMode | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.version !== 1) return undefined;
  if ((row.kind === 'normal' || row.kind === 'plan') && Object.keys(row).every(key => key === 'version' || key === 'kind')) {
    return { version: 1, kind: row.kind };
  }
  const ref = readPlanRevisionRef(row.executeRef);
  if (row.kind === 'execute' && ref && Object.keys(row.executeRef as object).every(key => ['planId', 'revision', 'digest'].includes(key)) && Object.keys(row).every(key => ['version', 'kind', 'executeRef'].includes(key))) {
    return { version: 1, kind: 'execute', executeRef: ref };
  }
  return undefined;
}

export function snapshotTaskMode(value: TaskMode | undefined): TaskMode | undefined {
  if (value === undefined) return undefined;
  const result = readTaskMode(value);
  if (!result) throw new Error('Invalid task mode. Choose Normal, Plan, or an exact reviewed plan revision.');
  return result;
}

export function sameTaskMode(left: TaskMode | undefined, right: TaskMode | undefined): boolean {
  return JSON.stringify(left ?? { version: 1, kind: 'normal' }) === JSON.stringify(right ?? { version: 1, kind: 'normal' });
}

export function samePlanRevision(left: PlanRevisionRef, right: PlanRevisionRef): boolean {
  return left.planId === right.planId && left.revision === right.revision && left.digest === right.digest;
}

export interface PlanArtifactView extends PlanRevisionRef {
  version: 1;
  sessionId: string;
  fullText: string;
  structuredPlan?: Record<string, unknown>;
  readiness: 'ready' | 'needs_input';
  missingPrerequisites: string[];
  createdAt: string;
}
export interface PlanArtifactResponse {
  artifact: PlanArtifactView;
  latest: PlanRevisionRef;
  execution?: { executionRunId: string; claimId?: string };
}

/** A preview or mismatched artifact can never enable an Execute button. */
export function checkedPlanArtifactResponse(value: unknown, expected: PlanRevisionRef): PlanArtifactResponse {
  const row = value as Partial<PlanArtifactResponse> | null;
  const artifact = row?.artifact;
  const ref = readPlanRevisionRef(artifact);
  const latest = readPlanRevisionRef(row?.latest);
  if (!artifact || artifact.version !== 1 || !ref || !latest || latest.planId !== expected.planId || !samePlanRevision(ref, expected)
    || typeof artifact.fullText !== 'string' || !artifact.fullText.trim()
    || typeof artifact.sessionId !== 'string' || !artifact.sessionId
    || !['ready', 'needs_input'].includes(artifact.readiness)
    || !Array.isArray(artifact.missingPrerequisites)
    || !artifact.missingPrerequisites.every(item => typeof item === 'string')) {
    throw new Error('The complete selected plan revision could not be verified. Reload it before executing.');
  }
  return { artifact, latest, ...(row?.execution ? { execution: row.execution } : {}) };
}

/** Changing the selected revision never authorizes it using a previously loaded body. */
export function canExecuteReviewedPlan(view: PlanArtifactResponse | null, selected: PlanRevisionRef): boolean {
  return Boolean(view && samePlanRevision(view.artifact, selected) && samePlanRevision(view.latest, selected)
    && view.artifact.readiness === 'ready' && view.artifact.missingPrerequisites.length === 0 && !view.execution);
}
