#!/usr/bin/env node
// Compare two live A/B labels over whole observations (see compare-core.mjs).
//   node scripts/live-ab/compare.mjs --results <dir> --a A1 --b B5
// Reads <dir>/<label>/summary.json and each pass's proof receipt beside it.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { compareRuns, observationFrom } from './compare-core.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const resultsDir = arg('--results');
if (!resultsDir) throw new Error('--results <dir> is required');

function load(label) {
  const dir = path.join(resultsDir, label);
  const summary = JSON.parse(readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  const observations = summary.tests.map((row) => {
    const receiptPath = path.join(dir, `${row.id}.p${row.pass}.json`);
    const receipt = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')) : null;
    return observationFrom(row, receipt);
  });
  return { summary, observations };
}

const A = load(arg('--a', 'A'));
const B = load(arg('--b', 'B'));
const report = compareRuns(A.observations, B.observations);
const fmt = (s) => `${s.passes - s.failedPasses}/${s.passes} ok · rounds ${s.rounds.median} · repairs ${s.repairs.median} · prompt ${s.promptTokens.median} · wall ${s.wallMs.median} ms (quiet ${s.quietWallMs.passes})`;
console.table(report.results.map((r) => ({
  id: r.id,
  A: r.a ? fmt(r.a) : '-',
  B: r.b ? fmt(r.b) : '-',
  verdict: r.verdict,
  why: [...r.reasons, ...(r.notes ?? [])].join('; '),
})));
for (const r of report.results) {
  for (const side of ['a', 'b']) {
    for (const failure of r[side]?.failures ?? []) console.log(`${r.id} ${side.toUpperCase()} ${failure}`);
  }
}
console.log(JSON.stringify({
  a: A.summary.gitSha, b: B.summary.gitSha,
  regressions: report.regressions, unresolved: report.unresolved, incomparable: report.incomparable,
  verdict: report.verdict,
}, null, 2));
process.exit(report.verdict === 'NO REGRESSION' ? 0 : 1);
