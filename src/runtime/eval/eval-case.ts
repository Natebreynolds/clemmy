/**
 * eval-case — the reusable EvalCase + pass^k runner (Lane A Phase 2,
 * eval-as-harness).
 *
 * "Eval IS the harness": every other next-level lane (Code Mode gate-parity,
 * idempotency, abstention, procedure-reuse, firehose-suppression) validates by
 * registering an EvalCase and gating its kill-switch deletion on pass^k — NOT a
 * one-shot pass@1. pass@1 hides the demo-to-prod reliability gap; pass^k (ALL k
 * trials pass) is the honest consistency metric the 2026 reliability science
 * (Beyond pass@1) gates on.
 *
 * An EvalCase.run() executes ONE self-contained trial and returns pass/fail with
 * a detail string. Trials MUST be deterministic-by-construction (stub judges,
 * fixed args, isolated state) — any nondeterminism that lowers pass^k should be
 * the AGENT's, never the harness's. A trial that THROWS counts as a failed trial
 * (score 0) — a crash is never a pass. The runner executes cases and trials
 * SEQUENTIALLY (cases may mutate process.env / shared gate state), so it never
 * races itself.
 */

export interface EvalRunOutcome {
  pass: boolean;
  /** One short line: the evidence that passed, or the missing/contradicting signal. */
  detail: string;
}

export interface EvalCase {
  id: string;
  /** Optional category/label for the report (e.g. 'gate', 'idempotency'). */
  label?: string;
  /** Run ONE trial. Self-contained + deterministic-by-construction. A throw is a
   *  failed trial (score 0), never a pass. */
  run: () => Promise<EvalRunOutcome>;
}

export interface CaseResult {
  id: string;
  label?: string;
  trials: number;
  passes: number;
  /** ≥1 trial passed (lenient — what pass@1 averaging would credit). */
  passAtK: boolean;
  /** ALL k trials passed (the honest consistency metric we gate on). */
  passHatK: boolean;
  /** Trials that threw (a crash is counted as a failed trial). */
  crashed: number;
  /** The first non-passing trial's detail (the actionable failure line). */
  firstFailDetail?: string;
}

export interface SuiteReport {
  k: number;
  cases: CaseResult[];
  /** Fraction of cases with ≥1 passing trial. */
  passAtKRate: number;
  /** Fraction of cases where ALL k trials passed — the release gate. */
  passHatKRate: number;
}

/**
 * Run each case k times (default 3), sequentially. A trial that throws is a
 * failed trial. Returns pass@k + pass^k per case and the aggregate rates.
 */
export async function runEvalSuite(cases: EvalCase[], opts?: { k?: number }): Promise<SuiteReport> {
  const k = Math.max(1, opts?.k ?? 3);
  const results: CaseResult[] = [];
  for (const c of cases) {
    let passes = 0;
    let crashed = 0;
    let firstFailDetail: string | undefined;
    for (let i = 0; i < k; i += 1) {
      let outcome: EvalRunOutcome;
      try {
        // eslint-disable-next-line no-await-in-loop
        outcome = await c.run();
      } catch (e) {
        crashed += 1;
        outcome = { pass: false, detail: `trial threw: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (outcome.pass) {
        passes += 1;
      } else if (!firstFailDetail) {
        firstFailDetail = outcome.detail;
      }
    }
    results.push({
      id: c.id,
      label: c.label,
      trials: k,
      passes,
      passAtK: passes >= 1,
      passHatK: passes === k,
      crashed,
      firstFailDetail,
    });
  }
  const n = results.length || 1;
  return {
    k,
    cases: results,
    passAtKRate: results.filter((r) => r.passAtK).length / n,
    passHatKRate: results.filter((r) => r.passHatK).length / n,
  };
}
