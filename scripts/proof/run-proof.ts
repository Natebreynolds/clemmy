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
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { planBrain, provisionDaemon } from './provision.js';
import { exactBrainRouteChecks, openHarnessDb, summarizeAllSessions } from './score.js';
import { fanoutMultiItem } from './scenarios/fanout-multi-item.js';
import { continuityRecall } from './scenarios/continuity-recall.js';
import { longToolSelfCorrect } from './scenarios/long-tool-self-correct.js';
import { approvalParkResume } from './scenarios/approval-park-resume.js';
import { cronReportBack } from './scenarios/cron-report-back.js';
import { gatedMutation } from './scenarios/gated-mutation.js';
import { converseFirst } from './scenarios/converse-first.js';
import { clarifyThenExecute } from './scenarios/clarify-then-execute.js';
import { workspaceBuild } from './scenarios/workspace-build.js';
import { teamAgentHandoff } from './scenarios/team-agent-handoff.js';
import { pendingActionGate } from './scenarios/pending-action-gate.js';
import type { BrainKind, ProofReport, ScenarioDef, ScenarioOutcome } from './types.js';

const ALL_SCENARIOS: ScenarioDef[] = [fanoutMultiItem, continuityRecall, longToolSelfCorrect, approvalParkResume, cronReportBack, gatedMutation, converseFirst, clarifyThenExecute, workspaceBuild, teamAgentHandoff, pendingActionGate];
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

/** Distinct model-family tags ('claude' | 'codex' | 'byo') that actually served
 *  calls in a proof home. Two evidence sources, union'd: the isolated
 *  token-usage NDJSON (definitive when present — appendFileSync, but some lanes
 *  record sparsely on short turns) and the eventlog's model-routing markers
 *  (worker_model_routed provider + the SDK-brain transport tag). "Can't prove"
 *  stays an empty set — for a brain matrix that is a FAIL, not a shrug. */
function servedModelFamilies(home: string): Set<string> {
  const families = new Set<string>();
  const classify = (model: string): void => {
    const m = model.toLowerCase();
    if (!m) return;
    if (m.includes('claude')) families.add('claude');
    else if (/^gpt|^o\d|codex/.test(m)) families.add('codex');
    else families.add('byo');
  };
  try {
    const dir = path.join(home, 'state', 'token-usage');
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ndjson')) continue;
      for (const line of readFileSync(path.join(dir, file), 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        try { classify(String((JSON.parse(line) as { model?: unknown }).model ?? '')); } catch { /* skip */ }
      }
    }
  } catch { /* no usage dir → eventlog below is the only evidence */ }
  try {
    const db = openHarnessDb(home);
    const rows = db.prepare(
      "SELECT data_json FROM events WHERE type IN ('turn_model_routed', 'worker_model_routed', 'reasoning_effort') LIMIT 500",
    ).all() as Array<{ data_json: string }>;
    for (const row of rows) {
      try {
        const data = JSON.parse(row.data_json) as { model?: string; modelId?: string; provider?: string; transport?: string };
        if (data.provider === 'claude' || data.provider === 'codex' || data.provider === 'byo') families.add(data.provider);
        else if ((data.transport ?? '').includes('claude_agent_sdk')) families.add('claude');
        else if (typeof data.model === 'string') classify(data.model);
        else if (typeof data.modelId === 'string') classify(data.modelId);
      } catch { /* skip */ }
    }
    db.close();
  } catch { /* no db → whatever the usage log said stands */ }
  return families;
}

function brainFamilyServed(brain: BrainKind, served: Set<string>): boolean {
  if (brain === 'claude') return served.has('claude');
  if (brain === 'codex') return served.has('codex');
  return served.has('byo'); // glm rides the byo lane
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
      daemon.markLog(); // scope daemon.log() (storm check) to THIS scenario
      try {
        const result = await scenario.run(daemon);
        const checks = [...result.checks];
        if (scenario.routeExpectation === 'exact-brain') {
          if (result.sessionId) checks.push(...exactBrainRouteChecks(daemon.home, result.sessionId, brainKind, result.latency.length));
          else checks.push({ name: 'exact route has a scenario session id', pass: false, detail: 'scenario returned no sessionId' });
        }
        const failed = checks.some((c) => !c.pass);
        anyFailed ||= failed;
        outcomes.push({ ...result, checks, scenario: scenario.name, brain: brainKind, status: failed ? 'FAIL' : 'PASS' });
        console.log(`    ${failed ? '❌ FAIL' : '✅ PASS'} (${checks.filter((c) => c.pass).length}/${checks.length} checks)`);
      } catch (err) {
        anyFailed = true;
        outcomes.push({ scenario: scenario.name, brain: brainKind, status: 'FAIL', checks: [], latency: [], error: err instanceof Error ? err.message : String(err) });
        console.log(`    ❌ FAIL (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    // Brain-served assertion: a "claude" leg's green scoreboard must not be
    // earnable by codex. The graceful brain-fallback is BY DESIGN for users
    // (an invalid Claude token mid-run switched every turn to Codex with zero
    // dead turns — 2026-07-03), but for a BRAIN MATRIX leg it silently
    // invalidates the label. Read the temp home's usage log and FAIL the leg
    // when the requested brain's model family never served a call.
    const served = servedModelFamilies(daemon.home);
    const brainOk = brainFamilyServed(brainKind, served);
    outcomes.push({
      scenario: '(brain-served)',
      brain: brainKind,
      status: brainOk ? 'PASS' : 'FAIL',
      checks: [{
        name: `turns served by the ${brainKind} brain`,
        pass: brainOk,
        detail: `model families in usage log: [${[...served].join(', ') || 'none'}]`,
      }],
      latency: [],
    });
    if (!brainOk) {
      anyFailed = true;
      console.log(`  ❌ brain mismatch — requested ${brainKind}, served by [${[...served].join(', ') || 'none'}] (check model sign-in; the graceful fallback may have switched brains)`);
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
