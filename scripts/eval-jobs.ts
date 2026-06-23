/**
 * eval:jobs — golden JOB-run evals (Lane A trust-layer P2).
 *
 * The gate benchmark (eval:passk over TRAPS) certifies GATES fire. This
 * certifies a JOB was done CORRECTLY: each fixture in src/runtime/eval/fixtures/
 * is a replayable recording of an end-to-end run, asserted DETERMINISTICALLY for
 * zero external writes · convergence · honest-partial-on-failure · figures
 * grounded to captured tool output. pass^k (ALL k trials pass) is the gate.
 *
 * Run: npx tsx scripts/eval-jobs.ts            (informational; exits 0)
 *      npx tsx scripts/eval-jobs.ts --strict   (exits 1 if pass^k < threshold)
 *      EVAL_JOBS_K=5 npx tsx scripts/eval-jobs.ts
 *
 * Default INFORMATIONAL per "guardrails inform, rarely block" — the hard CI gate
 * (--strict) flips on after two releases (same posture as eval:passk).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { JobFixture } from '../src/runtime/eval/job-case.js';

// Isolate the event log to a temp home BEFORE importing eventlog-backed modules,
// so replay never touches a real harness.db (mirrors harness-gate-benchmark.ts).
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-eval-jobs-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

const { runEvalSuite } = await import('../src/runtime/eval/eval-case.js');
const { buildJobCases } = await import('../src/runtime/eval/job-case.js');

const K = Math.max(1, Number(process.env.EVAL_JOBS_K) || 3);
const STRICT = process.argv.includes('--strict') || (process.env.EVAL_JOBS_STRICT || '').toLowerCase() === 'on';
const THRESHOLD = Number(process.env.EVAL_JOBS_THRESHOLD) || 0.85;

const FIXTURE_DIR = fileURLToPath(new URL('../src/runtime/eval/fixtures/', import.meta.url));
const fixtures: JobFixture[] = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(path.join(FIXTURE_DIR, f), 'utf8')) as JobFixture);

function pad(s: string, n: number): string { return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function pct(x: number): string { return `${(x * 100).toFixed(1)}%`; }

const cases = buildJobCases(fixtures);
const report = await runEvalSuite(cases, { k: K });

console.log(`\n  job evals — ${cases.length} golden runs × k=${K} trials (pass^k = ALL trials pass)\n`);
console.log('  ' + pad('JOB', 34) + pad('PASSES', 10) + pad('pass@k', 9) + pad('pass^k', 9) + 'NOTE');
console.log('  ' + '-'.repeat(92));
for (const c of report.cases) {
  console.log(
    '  ' + pad(c.id, 34) + pad(`${c.passes}/${c.trials}`, 10)
    + pad(c.passAtK ? '✓' : '✗', 9) + pad(c.passHatK ? '✓' : '✗', 9)
    + (c.passHatK ? '' : (c.firstFailDetail || '')),
  );
}
console.log('  ' + '-'.repeat(92));
console.log(`\n  pass@k:  ${pct(report.passAtKRate)}    pass^k:  ${pct(report.passHatKRate)}   (gate threshold ${pct(THRESHOLD)})\n`);

try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }

if (report.passHatKRate < THRESHOLD) {
  if (STRICT) {
    console.error(`  ✗ job pass^k ${pct(report.passHatKRate)} below ${pct(THRESHOLD)} — failing (strict).\n`);
    process.exit(1);
  }
  console.log(`  ⚠ job pass^k below ${pct(THRESHOLD)} (informational — run with --strict to gate CI).\n`);
} else {
  console.log(`  ✓ job pass^k ${pct(report.passHatKRate)} ≥ ${pct(THRESHOLD)}.\n`);
}
