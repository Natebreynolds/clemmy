/**
 * eval:passk — pass^k consistency runner over the harness eval corpus (Lane A
 * Phase 2, eval-as-harness).
 *
 * Runs each EvalCase k times (default 3) and reports pass@k (≥1 trial passes)
 * AND pass^k (ALL k trials pass) — the honest consistency metric. pass@1
 * averaging hides the demo-to-prod reliability gap; pass^k exposes it.
 *
 * Seeded from the gate benchmark's TRAPS, which already replay the real incident
 * classes through the REAL bracket chain: implicit/unverified-destination = the
 * wrong-site clobber; confirm-first-batch = send-without-approval; grounding =
 * recall-stale payload; goal-fidelity = per-firm-research-skipped; plus
 * execution-wrap, loop-guardrail-runaway, duplicate-target. Every other
 * next-level lane (Code Mode gate-parity, idempotency, abstention, procedure
 * reuse, firehose suppression) registers its own EvalCase here and gates its
 * kill-switch deletion on pass^k.
 *
 * Run: npx tsx scripts/eval-passk.ts            (informational; exits 0)
 *      npx tsx scripts/eval-passk.ts --strict   (exits 1 if pass^k < threshold)
 *      EVAL_PASSK_K=5 npx tsx scripts/eval-passk.ts
 *
 * Default is INFORMATIONAL (prints the readout, exits 0) — per "guardrails
 * inform, rarely block", the hard CI gate (--strict) flips on after two releases.
 */
import { runEvalSuite, type EvalCase } from '../src/runtime/eval/eval-case.js';
import { TRAPS, scoreTrap } from './harness-gate-benchmark.js';

const K = Math.max(1, Number(process.env.EVAL_PASSK_K) || 3);
const STRICT = process.argv.includes('--strict') || (process.env.EVAL_PASSK_STRICT || '').toLowerCase() === 'on';
const THRESHOLD = Number(process.env.EVAL_PASSK_THRESHOLD) || 0.85;

// Gate traps → EvalCases. Switch-controlled trials require ON to prevent the
// violation and OFF to commit it. Always-on safety trials require a valid
// control write to pass and the duplicate to be refused with the adjacent
// policy both ON and OFF. Both contracts are deterministic (stub judges, fixed
// args), and no eval ever asks production idempotency to become disableable.
const cases: EvalCase[] = TRAPS.map((trap) => ({
  id: trap.id,
  label: 'gate',
  run: async () => {
    const s = await scoreTrap(trap);
    if (s.error) return { pass: false, detail: `error: ${s.error}` };
    const pass = s.passed;
    const invariant = trap.contract === 'always-on-invariant';
    return {
      pass,
      detail: pass
        ? invariant
          ? `valid control allowed; duplicate blocked with adjacent policy ON and OFF (${trap.kind})`
          : `ON prevented (${trap.kind}); OFF committed`
        : invariant
          ? `controlAllowed=${s.controlAllowed} onBlocked=${s.prevented} offBlocked=${s.offBlocked} (${trap.kind})`
          : `prevented=${s.prevented} committed=${s.committed} (${trap.kind})`,
    };
  },
}));

function pad(s: string, n: number): string { return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function pct(x: number): string { return `${(x * 100).toFixed(1)}%`; }

const report = await runEvalSuite(cases, { k: K });

console.log(`\n  pass^k eval — ${cases.length} cases × k=${K} trials (pass^k = ALL trials pass)\n`);
console.log('  ' + pad('CASE', 26) + pad('LABEL', 8) + pad('PASSES', 10) + pad('pass@k', 9) + pad('pass^k', 9) + 'NOTE');
console.log('  ' + '-'.repeat(88));
for (const c of report.cases) {
  console.log(
    '  ' + pad(c.id, 26) + pad(c.label || '', 8) + pad(`${c.passes}/${c.trials}`, 10)
    + pad(c.passAtK ? '✓' : '✗', 9) + pad(c.passHatK ? '✓' : '✗', 9) + (c.passHatK ? '' : (c.firstFailDetail || '')),
  );
}
console.log('  ' + '-'.repeat(88));
console.log(`\n  pass@k:  ${pct(report.passAtKRate)}    pass^k:  ${pct(report.passHatKRate)}   (gate threshold ${pct(THRESHOLD)})\n`);

if (report.passHatKRate < THRESHOLD) {
  if (STRICT) {
    console.error(`  ✗ pass^k ${pct(report.passHatKRate)} below threshold ${pct(THRESHOLD)} — failing (strict).\n`);
    process.exit(1);
  }
  console.log(`  ⚠ pass^k below ${pct(THRESHOLD)} (informational — run with --strict to gate CI).\n`);
} else {
  console.log(`  ✓ pass^k ${pct(report.passHatKRate)} ≥ ${pct(THRESHOLD)}.\n`);
}
