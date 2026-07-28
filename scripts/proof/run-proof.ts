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
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { planBrain, provisionDaemon } from './provision.js';
import {
  exactBrainRouteChecks,
  exactBrainServedChecks,
  exactWorkerRouteChecks,
  exactWorkflowStepRouteChecks,
  fusionBoundedChecks,
  fusionDisabledChecks,
  openHarnessDb,
  summarizeAllSessions,
} from './score.js';
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
import { completeSetRecall } from './scenarios/complete-set-recall.js';
import { longHorizonManifest } from './scenarios/long-horizon-manifest.js';
import { backgroundSteerInFlight } from './scenarios/background-steer-in-flight.js';
import { restartResume } from './scenarios/restart-resume.js';
import { blockedAuthTruth } from './scenarios/blocked-auth-truth.js';
import { capabilityReconnectResume } from './scenarios/capability-reconnect-resume.js';
import { fusionBoundedVerifier } from './scenarios/fusion-bounded-verifier.js';
import { schemaOnDemand } from './scenarios/schema-on-demand.js';
import { cleanTurnIsolation } from './scenarios/clean-turn-isolation.js';
import { socialStudioLifecycle } from './scenarios/social-studio-lifecycle.js';
import type { BrainKind, FusionProofMode, ProofReport, ScenarioDef, ScenarioOutcome } from './types.js';

const DEFAULT_SCENARIOS: ScenarioDef[] = [
  fanoutMultiItem,
  continuityRecall,
  completeSetRecall,
  longToolSelfCorrect,
  approvalParkResume,
  cronReportBack,
  gatedMutation,
  converseFirst,
  clarifyThenExecute,
  workspaceBuild,
  teamAgentHandoff,
  pendingActionGate,
  longHorizonManifest,
  backgroundSteerInFlight,
  restartResume,
  blockedAuthTruth,
  capabilityReconnectResume,
  schemaOnDemand,
  cleanTurnIsolation,
];
const SCENARIO_CATALOG: ScenarioDef[] = [
  ...DEFAULT_SCENARIOS,
  fusionBoundedVerifier,
  socialStudioLifecycle,
];
const ALL_BRAINS: BrainKind[] = ['claude', 'codex', 'glm'];

function parseArgs(argv: string[]): {
  brains: BrainKind[];
  scenarios: ScenarioDef[];
  scoreOnly?: string;
  keep: boolean;
  fusionMode: FusionProofMode;
} {
  const brains: BrainKind[] = [];
  const scenarioNames: string[] = [];
  let scoreOnly: string | undefined;
  let keep = false;
  let fusionMode: FusionProofMode = 'off';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--brain') brains.push(...(argv[++i] ?? '').split(',').filter((b): b is BrainKind => ALL_BRAINS.includes(b as BrainKind)));
    else if (a === '--scenario') scenarioNames.push(...(argv[++i] ?? '').split(','));
    else if (a === '--score-only') scoreOnly = argv[++i];
    else if (a === '--keep') keep = true;
    else if (a === '--fusion') {
      const raw = (argv[++i] ?? '').trim().toLowerCase();
      if (raw !== 'high' && raw !== 'all') throw new Error('--fusion requires high or all');
      fusionMode = raw;
    }
  }
  const scenarios = scenarioNames.length
    ? SCENARIO_CATALOG.filter((s) => scenarioNames.includes(s.name))
    : DEFAULT_SCENARIOS;
  const missing = scenarioNames.filter((name) => !scenarios.some((scenario) => scenario.name === name));
  if (missing.length > 0) throw new Error(`Unknown proof scenario(s): ${missing.join(', ')}`);
  return { brains: brains.length ? brains : [...ALL_BRAINS], scenarios, scoreOnly, keep, fusionMode };
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
  const { brains, scenarios, scoreOnly, keep, fusionMode } = parseArgs(process.argv.slice(2));

  if (scoreOnly) {
    const db = openHarnessDb(scoreOnly);
    const all = summarizeAllSessions(db);
    db.close();
    console.log(JSON.stringify(all, null, 2));
    return;
  }

  const startedAt = new Date().toISOString();
  let gitHead = 'unknown';
  let sourceClean = false;
  try {
    gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    const dirty = execFileSync(
      'git',
      ['status', '--porcelain', '--untracked-files=all', '--', 'src', 'apps', 'scripts', 'docs', 'package.json', 'package-lock.json'],
      { encoding: 'utf-8' },
    ).trim();
    sourceClean = dirty.length === 0;
    if (!sourceClean) {
      throw new Error(
        `Live proof requires one reproducible candidate commit. Commit the intended source first (no tag required).\n${dirty.slice(0, 4_000)}`,
      );
    }
  } catch (error) {
    if (error instanceof Error && /reproducible candidate commit/.test(error.message)) throw error;
    // Not a Git checkout is still scoreable, but it is not release evidence.
    throw new Error(`Could not fingerprint proof source: ${error instanceof Error ? error.message : String(error)}`);
  }

  // The daemon deliberately runs the production dist/ entrypoint. Rebuild it
  // from the fingerprinted commit before every live matrix so a green proof can
  // never come from stale generated JS (a source-only Workspace fix was once
  // "validated" against the previous dist and produced the old tool schema).
  console.log(`\n→ building candidate ${gitHead.slice(0, 12)} …`);
  try {
    execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
  } catch (error) {
    throw new Error(`Candidate build failed before live proof: ${error instanceof Error ? error.message : String(error)}`);
  }

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
      daemon = await provisionDaemon(plan, { keepHome: keep, fusionMode });
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
          if (result.sessionId) checks.push(...exactBrainRouteChecks(daemon.home, result.sessionId, brainKind, result.latency.length, plan.expectedBrain));
          else checks.push({ name: 'exact route has a scenario session id', pass: false, detail: 'scenario returned no sessionId' });
        } else if (scenario.routeExpectation === 'exact-workflow-step') {
          if (result.sessionId) checks.push(...exactWorkflowStepRouteChecks(daemon.home, result.sessionId, brainKind, plan.expectedBrain));
          else checks.push({ name: 'exact workflow route has a step session id', pass: false, detail: 'scenario returned no sessionId' });
        }
        if (scenario.workerRouteExpectation) {
          if (result.sessionId) checks.push(...exactWorkerRouteChecks(daemon.home, result.sessionId, plan.expectedWorker));
          else checks.push({ name: 'exact worker route has a scenario session id', pass: false, detail: 'scenario returned no sessionId' });
        }
        if (result.sessionId) {
          checks.push(...(
            fusionMode === 'off'
              ? fusionDisabledChecks(daemon.home, result.sessionId)
              : fusionBoundedChecks(daemon.home, result.sessionId, brainKind, plan.expectedFusionChecker)
          ));
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
    // A route marker alone is not proof of a completed provider call. Bind the
    // whole-leg backstop to only this leg's scenario sessions and exact model.
    const legSessionIds = outcomes
      .filter((outcome) => outcome.brain === brainKind && outcome.sessionId)
      .map((outcome) => outcome.sessionId as string);
    const servedChecks = exactBrainServedChecks(daemon.home, legSessionIds, plan.expectedBrain);
    const brainOk = servedChecks.every((check) => check.pass);
    outcomes.push({
      scenario: '(brain-served)',
      brain: brainKind,
      status: brainOk ? 'PASS' : 'FAIL',
      checks: servedChecks,
      latency: [],
    });
    if (!brainOk) {
      anyFailed = true;
      console.log(`  ❌ exact model proof failed — expected ${plan.expectedBrain.provider}:${plan.expectedBrain.modelId || '(missing)'}`);
    }
    if (anyFailed) console.log(`  (keeping ${daemon.home} for forensics)`);
    await daemon.stop({ keepHome: anyFailed || keep });
  }

  const failures = outcomes.filter((o) => o.status === 'FAIL').length;
  const report: ProofReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    gitHead,
    sourceClean,
    fusionMode,
    outcomes,
    failures,
  };
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
