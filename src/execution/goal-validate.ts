/**
 * Goal-contract validation engine (GOAL-CONTRACT-PLAN.md, Phase 1).
 *
 * ONE validation engine, two goal sources (approved chat plans, workflow step
 * contracts). The contract's PARKED successCriteria — the text the user
 * blessed at approval — are what get checked, never the transcript's possibly
 * drifted restatement of the goal. The model saying "done" is a trigger to
 * run this, never the verdict.
 *
 * Strategy per criterion:
 *  1. DETERMINISTIC first: a criterion that names a concrete local file path
 *     is checked with an existence test (reuses the step-output-verify
 *     philosophy: an artifact claim must be a real artifact).
 *  2. JUDGE for the fuzzy residue: all remaining criteria go to ONE
 *     audit-checklist judge call (the objective-judge prompt), asked to
 *     verify each criterion against the assistant's evidence text.
 *
 * Fail-OPEN semantics ported from the legacy /goal loop: a judge error never
 * wedges OR silently passes the goal — it resolves to pass:false with
 * `judgeFailedOpen: true`, so the caller can distinguish "criteria unmet"
 * from "judge unavailable" and escalate after repeated judge failures instead
 * of looping forever.
 *
 * Pure + injectable: the judge and the file-existence check are parameters,
 * so unit tests are deterministic with no model or filesystem dependence.
 */
import { existsSync } from 'node:fs';
import type { GoalEvidence } from '../agents/plan-proposals.js';
import {
  judgeGoalCriteriaStrict,
  judgeObjectiveCompleteStrict,
  type CriterionJudgeVerdict,
  type ObjectiveJudgeVerdict,
} from '../runtime/harness/objective-judge.js';

export interface GoalCriterionVerdict {
  criterion: string;
  pass: boolean;
  method: 'deterministic' | 'judge' | 'skipped';
  detail?: string;
}

/** A concrete corrective instruction for ONE failed criterion — the structured
 *  sibling of the prose `advice`, so the next attempt (or the human) gets an
 *  actionable "fix" rather than only a restatement of the miss. */
export interface GoalFailedDirective {
  criterion: string;
  method: 'deterministic' | 'judge' | 'skipped';
  fix: string;
}

export interface GoalValidationResult {
  /** True only when EVERY criterion passed. */
  pass: boolean;
  perCriterion: GoalCriterionVerdict[];
  /** One-line guidance for the next attempt when validation failed. */
  advice?: string;
  /** True when the judge errored and the fuzzy criteria resolved to
   *  not-passed by fail-open policy (criteria may actually be met). */
  judgeFailedOpen?: boolean;
  /** VERIFICATION scorecard (always populated by validateGoal): the framework's
   *  "objective goals = numeric" signal for run reports + dashboards.
   *  successRatePercent is 0–100 rounded; 100 ⇔ pass. Optional on the type so
   *  existing literals/test fakes stay valid (forward-only). */
  successRatePercent?: number;
  criteriaMet?: number;
  criteriaTotal?: number;
  /** Per-failed-criterion corrective directives, injected into the next
   *  iteration's context so deterministic misses are auto-correctable. */
  failedDirectives?: GoalFailedDirective[];
}

/** Turn one failed criterion into a concrete corrective directive. Deterministic
 *  artifact misses become "create the missing file"; judge-unavailable becomes
 *  "re-validate" (not a confirmed miss); fuzzy misses restate with the judge note. */
function directiveForFailure(c: GoalCriterionVerdict): GoalFailedDirective {
  let fix: string;
  if (c.method === 'deterministic') {
    const localPath = extractLocalPathFromCriterion(c.criterion);
    fix = localPath
      ? `Create the missing artifact at ${localPath}, then re-validate.`
      : `Satisfy the criterion: ${c.criterion}.`;
  } else if (c.method === 'skipped') {
    fix = `Re-validate "${c.criterion}" — the completion judge was unavailable, so this is unverified, not a confirmed miss.`;
  } else {
    fix = `Satisfy: ${c.criterion}.${c.detail ? ` Judge note: ${c.detail}` : ''}`;
  }
  return { criterion: c.criterion, method: c.method, fix };
}

/** Compute the numeric scorecard + structured directives from per-criterion
 *  verdicts. Pure; folded into every validateGoal return so callers always have
 *  a percentage and an actionable fix-list. */
export function scoreGoalVerdicts(perCriterion: GoalCriterionVerdict[]): {
  successRatePercent: number;
  criteriaMet: number;
  criteriaTotal: number;
  failedDirectives: GoalFailedDirective[];
} {
  const criteriaTotal = perCriterion.length;
  const criteriaMet = perCriterion.filter((c) => c.pass).length;
  const successRatePercent = criteriaTotal === 0 ? 0 : Math.round((criteriaMet / criteriaTotal) * 100);
  const failedDirectives = perCriterion.filter((c) => !c.pass).map(directiveForFailure);
  return { successRatePercent, criteriaMet, criteriaTotal, failedDirectives };
}

export interface ValidateGoalInput {
  objective: string;
  successCriteria: string[];
  /** The assistant's completion evidence — typically the final reply text
   *  plus any harness-collected artifact notes. */
  evidenceText: string;
}

export interface ValidateGoalDeps {
  /** Injectable judge; defaults to judgeObjectiveCompleteStrict (THROWS on
   *  infra failure → validateGoal resolves to pass:false + judgeFailedOpen).
   *  Pass a throwing fake in tests to exercise the fail-open path. */
  judge?: (objective: string, evidenceText: string) => Promise<ObjectiveJudgeVerdict>;
  /** Injectable PER-CRITERION judge (one call, one verdict per criterion);
   *  defaults to judgeGoalCriteriaStrict. When only `judge` is injected (test
   *  fakes), the legacy whole-checklist path runs instead — an injected fake
   *  must never be silently bypassed by a real model call. */
  judgeCriteria?: (objective: string, criteria: string[], evidenceText: string) => Promise<CriterionJudgeVerdict[]>;
  fileExists?: (p: string) => boolean;
}

/**
 * A criterion that names a concrete local artifact path we can test directly.
 * Conservative: absolute paths and home-relative paths with an extension or a
 * known artifact directory shape. A URL is NOT deterministic (can't verify
 * remote state offline) — it goes to the judge with everything else.
 */
const LOCAL_PATH_RE = /(?:^|[\s"'`(])((?:~|\.{1,2})?\/(?:[\w .@-]+\/)*[\w .@-]+\.[A-Za-z0-9]{1,8})(?:[\s"'`).,]|$)/;

export function extractLocalPathFromCriterion(criterion: string): string | null {
  const m = LOCAL_PATH_RE.exec(criterion);
  if (!m) return null;
  const raw = m[1].trim();
  if (raw.startsWith('~')) {
    const home = process.env.HOME ?? '';
    return home ? raw.replace(/^~/, home) : raw;
  }
  return raw;
}

/** Build per-criterion GoalEvidence rows from a validation result. */
export function toGoalEvidence(result: GoalValidationResult, attempt: number, at: string): GoalEvidence[] {
  return result.perCriterion.map((c) => ({
    at,
    attempt,
    criterion: c.criterion,
    pass: c.pass,
    method: c.method,
    detail: c.detail,
  }));
}

// STRICT variant on purpose: judgeObjectiveComplete fails open to done:true
// (right for the chat continuation gate, fatal here — a dead judge must never
// auto-satisfy a goal). The strict variant throws; validateGoal's catch turns
// that into pass:false + judgeFailedOpen.
function defaultJudge(objective: string, evidenceText: string): Promise<ObjectiveJudgeVerdict> {
  return judgeObjectiveCompleteStrict(objective, evidenceText);
}

/**
 * Validate a goal contract's parked criteria against the assistant's evidence.
 * Deterministic checks run first and are authoritative for their criteria;
 * the remaining criteria are judged in ONE call against the parked text.
 */
export async function validateGoal(
  input: ValidateGoalInput,
  deps: ValidateGoalDeps = {},
): Promise<GoalValidationResult> {
  const fileExists = deps.fileExists ?? existsSync;
  const judge = deps.judge ?? defaultJudge;
  const criteria = (input.successCriteria ?? []).map((c) => c.trim()).filter((c) => c.length > 0);

  // No criteria declared → fall back to judging the objective itself, so a
  // criteria-less goal still gets the audit-checklist treatment.
  if (criteria.length === 0) {
    try {
      const verdict = await judge(input.objective, input.evidenceText);
      const perCriterion: GoalCriterionVerdict[] = [{ criterion: input.objective, pass: verdict.done, method: 'judge', detail: verdict.reason }];
      return {
        pass: verdict.done,
        perCriterion,
        advice: verdict.done ? undefined : verdict.reason,
        ...scoreGoalVerdicts(perCriterion),
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const perCriterion: GoalCriterionVerdict[] = [{ criterion: input.objective, pass: false, method: 'skipped', detail: `judge unavailable: ${detail}` }];
      return {
        pass: false,
        judgeFailedOpen: true,
        perCriterion,
        advice: 'completion judge unavailable — retry validation or escalate',
        ...scoreGoalVerdicts(perCriterion),
      };
    }
  }

  const perCriterion: GoalCriterionVerdict[] = [];
  const fuzzy: string[] = [];

  for (const criterion of criteria) {
    const localPath = extractLocalPathFromCriterion(criterion);
    if (localPath) {
      const exists = fileExists(localPath);
      perCriterion.push({
        criterion,
        pass: exists,
        method: 'deterministic',
        detail: exists ? `file exists: ${localPath}` : `file missing: ${localPath}`,
      });
    } else {
      fuzzy.push(criterion);
    }
  }

  let judgeFailedOpen = false;
  if (fuzzy.length > 0) {
    // ONE judge call for all fuzzy criteria. With the per-criterion judge the
    // call returns an individual MET/UNMET per parked criterion (real
    // granularity for successRatePercent + failedDirectives); the legacy
    // whole-checklist call remains for single criteria and injected `judge`
    // fakes (a test fake must never be bypassed by a real model call).
    const judgeCriteria = deps.judgeCriteria ?? (deps.judge ? null : judgeGoalCriteriaStrict);
    try {
      if (judgeCriteria && fuzzy.length > 1) {
        const verdicts = await judgeCriteria(input.objective, fuzzy, input.evidenceText);
        fuzzy.forEach((criterion, i) => {
          const v = verdicts[i];
          perCriterion.push({ criterion, pass: v?.pass === true, method: 'judge', detail: v?.note });
        });
      } else {
        const checklistObjective = [
          input.objective,
          '',
          'The objective is complete ONLY when ALL of these success criteria are met:',
          ...fuzzy.map((c, i) => `${i + 1}. ${c}`),
        ].join('\n');
        const verdict = await judge(checklistObjective, input.evidenceText);
        for (const criterion of fuzzy) {
          perCriterion.push({ criterion, pass: verdict.done, method: 'judge', detail: verdict.reason });
        }
      }
    } catch (err) {
      judgeFailedOpen = true;
      const detail = err instanceof Error ? err.message : String(err);
      for (const criterion of fuzzy) {
        perCriterion.push({ criterion, pass: false, method: 'skipped', detail: `judge unavailable: ${detail}` });
      }
    }
  }

  const failures = perCriterion.filter((c) => !c.pass);
  const pass = failures.length === 0;
  const advice = pass
    ? undefined
    : judgeFailedOpen
      ? 'completion judge unavailable — retry validation or escalate'
      : `unmet: ${failures.map((f) => `${f.criterion}${f.detail ? ` (${f.detail})` : ''}`).slice(0, 3).join('; ')}`;

  return { pass, perCriterion, advice, ...(judgeFailedOpen ? { judgeFailedOpen } : {}), ...scoreGoalVerdicts(perCriterion) };
}
