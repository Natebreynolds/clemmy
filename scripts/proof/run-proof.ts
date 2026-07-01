/**
 * Live proof harness — orchestrator.
 *
 *   npm run proof                      # all brains × all scenarios
 *   npm run proof:claude               # one brain
 *   tsx scripts/proof/run-proof.ts --brain claude --scenario fanout-multi-item
 *   tsx scripts/proof/run-proof.ts --score-only /path/to/home   # offline scorer (CI-testable)
 *
 * Boots a REAL daemon per brain against an isolated CLEMENTINE_HOME, drives
 * benign scenarios over the console API, scores from the eventlog, and prints
 * a brain × scenario scoreboard with latency. Exit code = number of FAILs
 * (SKIPs don't count) — usable as a pre-release gate next to test:smoke.
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { planBrain, provisionDaemon } from './provision.js';
import { openHarnessDb, summarizeAllSessions } from './score.js';
import { fanoutMultiItem } from './scenarios/fanout-multi-item.js';
import { continuityRecall } from './scenarios/continuity-recall.js';
import type { BrainKind, ProofReport, ScenarioDef, ScenarioOutcome } from './types.js';

const ALL_SCENARIOS: ScenarioDef[] = [fanoutMultiItem, continuityRecall];
const ALL_BRAINS: BrainKind[] = ['claude', 'codex', 'glm'];

function parseArgs(argv: string[]): { brains: BrainKind[]; scenarios: ScenarioDef[]; scoreOnly?: string; keep: boolean } {
  const brains: BrainKind[] = [];
  const scenarioNames: string[] = [];
  let scoreOnly: string | undefined;
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--brain') brains.push(...(argv[++i] ?? '').split(',').filter((b): b is BrainKind => ALL_BRAINS.includes(b as BrainKind)));
    else if (a === '--scenario') scenarioNames.push(...(argv[++i] ?? '').split(','));
    else if (a === '--score-only') scoreOnly = argv[++i];
    else if (a === '--keep') keep = true;
  }
  const scenarios = scenarioNames.length
    ? ALL_SCENARIOS.filter((s) => scenarioNames.includes(s.name))
    : ALL_SCENARIOS;
  return { brains: brains.length ? brains : [...ALL_BRAINS], scenarios, scoreOnly, keep };
}

function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return ms >= 10_000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 1000).toFixed(1)}s`;
}

function printScoreboard(outcomes: ScenarioOutcome[]): void {
  console.log('\n═══ PROOF SCOREBOARD ═══');
  for (const o of outcomes) {
    const icon = o.status === 'PASS' ? '✅' : o.status === 'SKIP' ? '⏭️ ' : '❌';
    const wall = o.latency.reduce((a, l) => a + l.wallMs, 0);
    const ttft = o.latency[0]?.ttftMs;
    console.log(`${icon} ${o.brain.padEnd(6)} × ${o.scenario.padEnd(22)} wall=${fmtMs(wall)} ttft=${fmtMs(ttft)}${o.error ? `  (${o.error})` : ''}`);
    for (const c of o.checks.filter((c) => !c.pass)) {
      console.log(`     ✗ ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    }
  }
}

async function main(): Promise<void> {
  const { brains, scenarios, scoreOnly, keep } = parseArgs(process.argv.slice(2));

  if (scoreOnly) {
    const db = openHarnessDb(scoreOnly);
    const all = summarizeAllSessions(db);
    db.close();
    console.log(JSON.stringify(all, null, 2));
    return;
  }

  const startedAt = new Date().toISOString();
  let gitHead = 'unknown';
  try { gitHead = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim(); } catch { /* fine */ }

  const outcomes: ScenarioOutcome[] = [];
  for (const brainKind of brains) {
    const plan = planBrain(brainKind);
    if (plan.skipReason) {
      for (const s of scenarios) {
        outcomes.push({ scenario: s.name, brain: brainKind, status: 'SKIP', checks: [], latency: [], error: plan.skipReason });
      }
      console.log(`⏭️  ${brainKind}: SKIP (${plan.skipReason})`);
      continue;
    }
    console.log(`\n→ provisioning daemon for brain=${brainKind} …`);
    let daemon;
    try {
      daemon = await provisionDaemon(plan, { keepHome: keep });
    } catch (err) {
      for (const s of scenarios) {
        outcomes.push({ scenario: s.name, brain: brainKind, status: 'FAIL', checks: [], latency: [], error: `provision: ${err instanceof Error ? err.message : String(err)}` });
      }
      continue;
    }
    console.log(`  daemon up on :${daemon.port} home=${daemon.home}`);
    let anyFailed = false;
    for (const scenario of scenarios) {
      console.log(`  ▶ ${scenario.name} …`);
      try {
        const result = await scenario.run(daemon);
        const failed = result.checks.some((c) => !c.pass);
        anyFailed ||= failed;
        outcomes.push({ ...result, scenario: scenario.name, brain: brainKind, status: failed ? 'FAIL' : 'PASS' });
        console.log(`    ${failed ? '❌ FAIL' : '✅ PASS'} (${result.checks.filter((c) => c.pass).length}/${result.checks.length} checks)`);
      } catch (err) {
        anyFailed = true;
        outcomes.push({ scenario: scenario.name, brain: brainKind, status: 'FAIL', checks: [], latency: [], error: err instanceof Error ? err.message : String(err) });
        console.log(`    ❌ FAIL (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    if (anyFailed) console.log(`  (keeping ${daemon.home} for forensics)`);
    await daemon.stop({ keepHome: anyFailed || keep });
  }

  const failures = outcomes.filter((o) => o.status === 'FAIL').length;
  const report: ProofReport = { startedAt, finishedAt: new Date().toISOString(), gitHead, outcomes, failures };
  const reportPath = path.resolve('proof-report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  printScoreboard(outcomes);
  console.log(`\nreport: ${reportPath}`);
  console.log(failures === 0 ? '✅ proof green' : `❌ ${failures} failure(s)`);
  process.exit(failures);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
