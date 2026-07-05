/**
 * The CHECKER agent — a second agent that watches the others' work.
 *
 * It reads the shared run workspace (GOAL.md + the manifest + each step's
 * persisted work product) and judges the ACCUMULATED work against the run's
 * success criteria, per criterion, attributing gaps to the steps whose output
 * was the evidence. This is the "agents checking each other in one shared
 * workspace anchored on a goal" piece.
 *
 * WIRE-not-rebuild: it reuses the existing per-criterion judge (validateGoal),
 * grounded in the workspace evidence instead of a single finalOutput — and its
 * judge is injectable, so the whole thing is deterministically testable while
 * defaulting to the real cross-family judge in production.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateGoal, type GoalCriterionVerdict, type GoalValidationResult, type ValidateGoalDeps } from './goal-validate.js';
import { readRunGoal, readWorkspaceManifest, runWorkspaceDir, type WorkspaceArtifact } from './workflow-run-workspace.js';

/** How much of each step's work product the checker reads as evidence — a
 *  bounded sample (progressive disclosure) so the checker itself stays cheap. */
const EVIDENCE_PER_ARTIFACT = 3000;

export interface CheckerReport {
  runId: string;
  pass: boolean;
  perCriterion: GoalCriterionVerdict[];
  metCount: number;
  unmetCount: number;
  /** The step work-products the checker weighed (its evidence). */
  evidenceSteps: string[];
  checkedAt: string;
  summary: string;
}

function stepOutputArtifacts(manifest: WorkspaceArtifact[]): WorkspaceArtifact[] {
  return manifest.filter((a) => a.tool === 'step-output');
}

/** Assemble the checker's evidence from the shared workspace: the goal, plus
 *  each step's summary + a bounded sample of its actual work product. */
export function buildWorkspaceEvidence(
  workflowName: string,
  runId: string,
): { evidenceText: string; evidenceSteps: string[] } {
  const goal = readRunGoal(workflowName, runId);
  // Latest artifact per producing step (a re-pursued step shows its newest work).
  const latest = new Map<string, WorkspaceArtifact>();
  for (const a of stepOutputArtifacts(readWorkspaceManifest(workflowName, runId))) latest.set(a.agent, a);
  const artifacts = Array.from(latest.values());
  const dir = runWorkspaceDir(workflowName, runId);
  const blocks: string[] = [];
  if (goal) blocks.push(goal.trim());
  for (const a of artifacts) {
    let sample = '';
    try {
      const raw = readFileSync(path.join(dir, a.path), 'utf-8');
      sample = raw.length > EVIDENCE_PER_ARTIFACT ? `${raw.slice(0, EVIDENCE_PER_ARTIFACT)}\n…[${raw.length - EVIDENCE_PER_ARTIFACT} more chars]` : raw;
    } catch { sample = a.summary; }
    blocks.push(`### Step "${a.agent}" produced (${a.bytes} bytes): ${a.summary}\n${sample}`);
  }
  return { evidenceText: blocks.join('\n\n'), evidenceSteps: artifacts.map((a) => a.agent) };
}

/**
 * Run the checker: judge the accumulated workspace work against the goal's
 * success criteria, per criterion. `deps.judge` is injectable (defaults to the
 * real judge); a run with no work products yet returns a not-yet-verifiable
 * report rather than a false pass.
 */
export async function checkRunAgainstGoal(args: {
  workflowName: string;
  runId: string;
  objective: string;
  successCriteria?: string[];
  checkedAt: string;
  deps?: ValidateGoalDeps;
}): Promise<CheckerReport> {
  const { evidenceText, evidenceSteps } = buildWorkspaceEvidence(args.workflowName, args.runId);
  if (evidenceSteps.length === 0) {
    return {
      runId: args.runId, pass: false, perCriterion: [], metCount: 0, unmetCount: 0,
      evidenceSteps: [], checkedAt: args.checkedAt,
      summary: `Checker: no work products in the workspace yet — nothing to verify.`,
    };
  }
  const result = await validateGoal(
    { objective: args.objective, successCriteria: args.successCriteria ?? [], evidenceText },
    args.deps ?? {},
  );
  const metCount = result.perCriterion.filter((c) => c.pass).length;
  const unmetCount = result.perCriterion.length - metCount;
  return {
    runId: args.runId,
    pass: result.pass,
    perCriterion: result.perCriterion,
    metCount,
    unmetCount,
    evidenceSteps,
    checkedAt: args.checkedAt,
    summary: renderCheckerSummary(result.pass, metCount, result.perCriterion.length, evidenceSteps.length),
  };
}

function renderCheckerSummary(pass: boolean, met: number, total: number, steps: number): string {
  const bar = total > 0 ? `${met}/${total} criteria met` : 'objective judged';
  const across = `across ${steps} step work-product${steps === 1 ? '' : 's'}`;
  return pass
    ? `Checker: work meets the goal — ${bar} ${across}.`
    : `Checker: work does NOT yet meet the goal — ${bar} ${across}.`;
}

/**
 * Build a checker report from a goal verdict the runner ALREADY computed at
 * completion — so the auto-check on run completion reuses that verdict instead
 * of paying for a second judge call. `evidenceSteps` are the completed step ids.
 */
export function checkerReportFromVerdict(
  runId: string,
  verdict: GoalValidationResult,
  evidenceSteps: string[],
  checkedAt: string,
): CheckerReport {
  const metCount = verdict.perCriterion.filter((c) => c.pass).length;
  return {
    runId,
    pass: verdict.pass,
    perCriterion: verdict.perCriterion,
    metCount,
    unmetCount: verdict.perCriterion.length - metCount,
    evidenceSteps,
    checkedAt,
    summary: renderCheckerSummary(verdict.pass, metCount, verdict.perCriterion.length, evidenceSteps.length),
  };
}

/** Human-readable checker report for chat / the run window. */
export function renderCheckerReport(report: CheckerReport): string {
  const lines = [report.pass ? `✅ ${report.summary}` : `⚠️ ${report.summary}`];
  const unmet = report.perCriterion.filter((c) => !c.pass);
  if (unmet.length > 0) {
    lines.push('', 'Not yet satisfied:', ...unmet.map((c) => `  ✗ ${c.criterion}${c.detail ? ` — ${c.detail}` : ''}`));
  }
  const met = report.perCriterion.filter((c) => c.pass);
  if (met.length > 0) {
    lines.push('', 'Satisfied:', ...met.map((c) => `  ✓ ${c.criterion}`));
  }
  return lines.join('\n');
}
