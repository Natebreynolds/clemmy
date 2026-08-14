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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { planBrain, provisionDaemon } from './provision.js';
import {
  executeRuntimePlan,
  planRuntimeUnderTest,
  runtimeProvisioningMode,
  sha256Directory,
  type RuntimeUnderTest,
} from './runtime-under-test.js';
import {
  parseProofBenchmarkFlags,
  proofBenchmarkMetadata,
} from './benchmark-comparison.js';
import {
  assertRequiredBrainsSelected,
  parseRequiredBrains,
  unavailableBrainDisposition,
} from './required-brains.js';
import {
  routeSessionsForRouteCheck,
  servedModelSessionIdsForOutcomes,
} from './route-expectation.js';
import { DIRTY_DEV_EVIDENCE_BANNER, decideProofSourceGuard } from './source-guard.js';
import {
  evaluateProofSourceStability,
  fingerprintProofSourceFromGit,
  PROOF_SOURCE_PATHS,
  writeProofReportFiles,
} from './report-output.js';
import {
  assertProofTempCapacity,
  proofDaemonStopChecks,
} from './runtime-safety.js';
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
import { correctionSticks } from './scenarios/correction-sticks.js';
import { agentAutonomyLive } from './scenarios/agent-autonomy-live.js';
import { correctionSupersedesStore } from './scenarios/correction-supersedes-store.js';
import { businessDayLive } from './scenarios/business-day-live.js';
import { growsWithUserLive } from './scenarios/grows-with-user-live.js';
import { longToolSelfCorrect } from './scenarios/long-tool-self-correct.js';
import { approvalParkResume } from './scenarios/approval-park-resume.js';
import { cronReportBack } from './scenarios/cron-report-back.js';
import { gatedMutation } from './scenarios/gated-mutation.js';
import { converseFirst } from './scenarios/converse-first.js';
import { chatSpineGraphDrive } from './scenarios/chat-spine-graph-drive.js';
import { clarifyThenExecute } from './scenarios/clarify-then-execute.js';
import { clarifyThenDecline } from './scenarios/clarify-then-decline.js';
import { workspaceBuild } from './scenarios/workspace-build.js';
import { teamAgentHandoff } from './scenarios/team-agent-handoff.js';
import { teamDelegationRoundtrip } from './scenarios/team-delegation-roundtrip.js';
import { pendingActionGate } from './scenarios/pending-action-gate.js';
import { completeSetRecall } from './scenarios/complete-set-recall.js';
import { longHorizonManifest } from './scenarios/long-horizon-manifest.js';
import { countOnlyDrafts } from './scenarios/count-only-drafts.js';
import { backgroundSteerInFlight } from './scenarios/background-steer-in-flight.js';
import { restartResume } from './scenarios/restart-resume.js';
import { blockedAuthTruth } from './scenarios/blocked-auth-truth.js';
import { capabilityReconnectResume } from './scenarios/capability-reconnect-resume.js';
import { fusionBoundedVerifier } from './scenarios/fusion-bounded-verifier.js';
import { schemaOnDemand } from './scenarios/schema-on-demand.js';
import { cleanTurnIsolation } from './scenarios/clean-turn-isolation.js';
import { graphReshapeLive } from './scenarios/graph-reshape-live.js';
import { socialStudioLifecycle } from './scenarios/social-studio-lifecycle.js';
import { pendingActionExactOnce } from './scenarios/pending-action-exact-once.js';
import { bookkeepingReceiptExactOnce } from './scenarios/bookkeeping-receipt-exact-once.js';
import { workspaceTemporalHistory } from './scenarios/workspace-temporal-history.js';
import { discoveryReuseHorizon } from './scenarios/discovery-reuse-horizon.js';
import { conversationSwitchResumeHorizon } from './scenarios/conversation-switch-resume-horizon.js';
import type { BrainKind, Check, FusionProofMode, ProofReport, ScenarioDef, ScenarioOutcome } from './types.js';

const DEFAULT_SCENARIOS: ScenarioDef[] = [
  fanoutMultiItem,
  continuityRecall,
  correctionSticks,
  completeSetRecall,
  longToolSelfCorrect,
  approvalParkResume,
  cronReportBack,
  gatedMutation,
  converseFirst,
  chatSpineGraphDrive,
  clarifyThenExecute,
  workspaceBuild,
  teamAgentHandoff,
  teamDelegationRoundtrip,
  pendingActionGate,
  longHorizonManifest,
  countOnlyDrafts,
  backgroundSteerInFlight,
  restartResume,
  blockedAuthTruth,
  capabilityReconnectResume,
  schemaOnDemand,
  cleanTurnIsolation,
  graphReshapeLive,
  agentAutonomyLive,
];
const SCENARIO_CATALOG: ScenarioDef[] = [
  ...DEFAULT_SCENARIOS,
  clarifyThenDecline,
  fusionBoundedVerifier,
  socialStudioLifecycle,
  pendingActionExactOnce,
  bookkeepingReceiptExactOnce,
  workspaceTemporalHistory,
  correctionSupersedesStore,
  businessDayLive,
  growsWithUserLive,
  discoveryReuseHorizon,
  conversationSwitchResumeHorizon,
];
const ALL_BRAINS: BrainKind[] = ['claude', 'codex', 'glm'];
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv: string[]): {
  brains: BrainKind[];
  scenarios: ScenarioDef[];
  scoreOnly?: string;
  keep: boolean;
  fusionMode: FusionProofMode;
  allowDirtyDev: boolean;
  requiredBrains: BrainKind[];
  benchmarkRequest: ReturnType<typeof parseProofBenchmarkFlags>;
  runtimeRef?: string;
} {
  const benchmarkRequest = parseProofBenchmarkFlags(argv);
  const brains: BrainKind[] = [];
  const scenarioNames: string[] = [];
  let scoreOnly: string | undefined;
  let keep = false;
  let fusionMode: FusionProofMode = 'off';
  let allowDirtyDev = false;
  let runtimeRef: string | undefined;
  const requiredBrains: BrainKind[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--brain') brains.push(...(argv[++i] ?? '').split(',').filter((b): b is BrainKind => ALL_BRAINS.includes(b as BrainKind)));
    else if (a === '--scenario') scenarioNames.push(...(argv[++i] ?? '').split(','));
    else if (a === '--score-only') scoreOnly = argv[++i];
    else if (a === '--keep') keep = true;
    else if (a === '--allow-dirty-dev') allowDirtyDev = true;
    else if (a === '--require-brains') requiredBrains.push(...parseRequiredBrains(argv[++i]));
    else if (a === '--runtime') {
      runtimeRef = (argv[++i] ?? '').trim();
      if (!runtimeRef) throw new Error('--runtime requires a git ref (e.g. v3.14.0)');
    }
    else if (a === '--benchmark-cohort' || a === '--benchmark-sample') i += 1;
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
  const selectedBrains = brains.length ? [...new Set(brains)] : [...ALL_BRAINS];
  const uniqueRequiredBrains = [...new Set(requiredBrains)];
  assertRequiredBrainsSelected(selectedBrains, uniqueRequiredBrains);
  return {
    brains: selectedBrains,
    scenarios,
    scoreOnly,
    keep,
    fusionMode,
    allowDirtyDev,
    requiredBrains: uniqueRequiredBrains,
    benchmarkRequest,
    ...(runtimeRef ? { runtimeRef } : {}),
  };
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
  const {
    brains,
    scenarios,
    scoreOnly,
    keep,
    fusionMode,
    allowDirtyDev,
    requiredBrains,
    benchmarkRequest,
    runtimeRef,
  } = parseArgs(process.argv.slice(2));

  if (scoreOnly) {
    if (benchmarkRequest) throw new Error('benchmark metadata is unavailable in --score-only mode');
    const db = openHarnessDb(scoreOnly);
    const all = summarizeAllSessions(db);
    db.close();
    console.log(JSON.stringify(all, null, 2));
    return;
  }

  const startedAt = new Date().toISOString();
  let gitHead = 'unknown';
  let sourceFingerprint = '';
  let sourceClean = false;
  try {
    gitHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    }).trim();
    const dirty = execFileSync(
      'git',
      ['status', '--porcelain', '--untracked-files=all', '--', ...PROOF_SOURCE_PATHS],
      { cwd: REPO_ROOT, encoding: 'utf-8' },
    ).trim();
    const sourceDecision = decideProofSourceGuard(dirty, allowDirtyDev);
    if (!sourceDecision.allowed) throw new Error(sourceDecision.error);
    sourceClean = sourceDecision.sourceClean;
    if (sourceDecision.devEvidence) console.warn(`\n${sourceDecision.warning}`);
    sourceFingerprint = fingerprintProofSourceFromGit({
      repoRoot: REPO_ROOT,
      gitHead,
      sourcePaths: PROOF_SOURCE_PATHS,
    });
  } catch (error) {
    if (error instanceof Error && /reproducible candidate commit/.test(error.message)) throw error;
    // Not a Git checkout is still scoreable, but it is not release evidence.
    throw new Error(`Could not fingerprint proof source: ${error instanceof Error ? error.message : String(error)}`);
  }

  // The daemon deliberately runs the production dist/ entrypoint. Rebuild it
  // from the fingerprinted commit before every live matrix so a green proof can
  // never come from stale generated JS (a source-only Workspace fix was once
  // "validated" against the previous dist and produced the old tool schema).
  console.log(sourceClean
    ? `\n→ building candidate ${gitHead.slice(0, 12)} …`
    : `\n→ building dirty working tree at ${gitHead.slice(0, 12)} …`);
  let pinnedRuntime: RuntimeUnderTest | undefined;
  const provisioningMode = runtimeProvisioningMode({ runtimeRef, sourceClean });
  if (provisioningMode === 'explicit-ref') {
    // Pinned baseline leg: the DAEMON under test comes from a worktree built
    // at its own ref; the measurement stack (scenarios, scoring, shim) always
    // runs from the current tree so ONE stack drives both versions. The
    // current-tree build is skipped — its dist is not what runs.
    console.log(`\n→ provisioning pinned runtime ${runtimeRef} …`);
    const plan = planRuntimeUnderTest({ repoRoot: REPO_ROOT, ref: runtimeRef });
    const runtime = executeRuntimePlan(plan, { log: (line) => console.log(line) });
    if (!runtime.built) throw new Error(`pinned runtime ${runtimeRef} did not produce ${runtime.daemonEntry}`);
    console.log(`→ pinned runtime ready: ${runtime.gitSha.slice(0, 12)} (${runtime.nodeModulesProvenance}) at ${runtime.daemonEntry}`);
    pinnedRuntime = runtime;
  } else if (provisioningMode === 'clean-candidate-worktree') {
    // A release-grade candidate gets the same independent npm-ci + artifact
    // attestation as a pinned baseline. Existing primary-tree node_modules are
    // development convenience, never dependency provenance.
    console.log(`\n→ provisioning clean candidate runtime ${gitHead.slice(0, 12)} …`);
    const plan = planRuntimeUnderTest({
      repoRoot: REPO_ROOT,
      ref: gitHead,
      label: 'candidate-clean-tree',
    });
    const runtime = executeRuntimePlan(plan, { log: (line) => console.log(line) });
    if (!runtime.built || !runtime.buildAttestation) {
      throw new Error(`clean candidate did not produce an attested runtime at ${runtime.daemonEntry}`);
    }
    pinnedRuntime = runtime;
  } else {
    try {
      execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
    } catch (error) {
      throw new Error(`Candidate build failed before live proof: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const runtimeFingerprintStart = pinnedRuntime?.buildAttestation?.artifactSha256
    ?? sha256Directory(path.join(REPO_ROOT, 'dist'));

  const outcomes: ScenarioOutcome[] = [];
  const runtimeChecks: Check[] = [];
  for (const brainKind of brains) {
    const plan = planBrain(brainKind);
    if (plan.skipReason) {
      const unavailable = unavailableBrainDisposition(brainKind, plan.skipReason, requiredBrains);
      for (const s of scenarios) {
        outcomes.push({
          scenario: s.name,
          brain: brainKind,
          status: unavailable.status,
          checks: [],
          latency: [],
          error: unavailable.error,
        });
      }
      console.log(unavailable.status === 'FAIL'
        ? `❌ ${brainKind}: FAIL (${unavailable.error})`
        : `⏭️  ${brainKind}: SKIP (${unavailable.error})`);
      continue;
    }
    console.log(`\n→ provisioning daemon for brain=${brainKind} …`);
    let daemon;
    try {
      daemon = await provisionDaemon(plan, {
        keepHome: keep,
        fusionMode,
        requireWorkerProvider: scenarios.some((scenario) => scenario.workerRouteExpectation),
        ...(pinnedRuntime
          ? { daemonEntry: pinnedRuntime.daemonEntry, expectedRuntime: pinnedRuntime }
          : {}),
      });
    } catch (err) {
      for (const s of scenarios) {
        outcomes.push({ scenario: s.name, brain: brainKind, status: 'FAIL', checks: [], latency: [], error: `provision: ${err instanceof Error ? err.message : String(err)}` });
      }
      continue;
    }
    console.log(`  daemon up on :${daemon.port} home=${daemon.home}`);
    let anyFailed = false;
    try {
      for (const scenario of scenarios) {
        console.log(`  ▶ ${scenario.name} …`);
        try {
          // A leg can consume disk after provisioning. Fail closed again before
          // every scenario so the first paid/provider-capable action never starts
          // against an already unsafe volume.
          assertProofTempCapacity(daemon.home);
          daemon.markLog(); // scope daemon.log() (storm check) to THIS scenario
          const result = await scenario.run(daemon, { brain: brainKind });
          const checks = [...result.checks];
          if (scenario.routeExpectation === 'exact-brain') {
            const routeSessions = routeSessionsForRouteCheck(scenario, {
              sessionId: result.sessionId,
              routeSessions: result.routeSessions,
              latencySampleCount: result.latency.length,
            });
            if (routeSessions.length > 0) {
              for (const route of routeSessions) {
                checks.push(...exactBrainRouteChecks(
                  daemon.home,
                  route.sessionId,
                  brainKind,
                  route.expectedModelTurns,
                  plan.expectedBrain,
                ).map((check) => ({ ...check, name: `${route.sessionId}: ${check.name}` })));
                // A route marker proves intent before dispatch. Require completed
                // exact-model usage in EACH routed session so a green warm leg
                // cannot hide a cold leg that never reached the configured brain.
                checks.push(...exactBrainServedChecks(
                  daemon.home,
                  [route.sessionId],
                  plan.expectedBrain,
                ).map((check) => ({ ...check, name: `${route.sessionId}: ${check.name}` })));
              }
            } else checks.push({ name: 'exact route has a scenario session id', pass: false, detail: 'scenario returned no sessionId or routeSessions' });
          } else if (scenario.routeExpectation === 'exact-workflow-step') {
            if (result.sessionId) checks.push(...exactWorkflowStepRouteChecks(daemon.home, result.sessionId, brainKind, plan.expectedBrain));
            else checks.push({ name: 'exact workflow route has a step session id', pass: false, detail: 'scenario returned no sessionId' });
          }
          if (scenario.workerRouteExpectation) {
            if (result.sessionId) checks.push(...exactWorkerRouteChecks(daemon.home, result.sessionId, plan.expectedWorker));
            else checks.push({ name: 'exact worker route has a scenario session id', pass: false, detail: 'scenario returned no sessionId' });
          }
          const fusionSessionIds = [...new Set([
            ...(result.routeSessions ?? []).map((route) => route.sessionId),
            ...(result.sessionId ? [result.sessionId] : []),
          ])];
          for (const fusionSessionId of fusionSessionIds) {
            checks.push(...(
              fusionMode === 'off'
                ? fusionDisabledChecks(daemon.home, fusionSessionId)
                : fusionBoundedChecks(daemon.home, fusionSessionId, brainKind, plan.expectedFusionChecker)
            ).map((check) => ({ ...check, name: `${fusionSessionId}: ${check.name}` })));
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
      const legSessionIds = servedModelSessionIdsForOutcomes(
        outcomes.filter((outcome) => outcome.brain === brainKind),
      );
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
    } catch (error) {
      anyFailed = true;
      const detail = error instanceof Error ? error.message : String(error);
      outcomes.push({
        scenario: '(brain-runner)',
        brain: brainKind,
        status: 'FAIL',
        checks: [],
        latency: [],
        error: detail,
      });
      console.log(`  ❌ brain runner failed (${detail})`);
    } finally {
      if (anyFailed) console.log(`  (keeping ${daemon.home} for forensics)`);
      try {
        runtimeChecks.push(...(daemon.runtimeChecks?.() ?? []));
        const stopResult = await daemon.stop({ keepHome: anyFailed || keep });
        const stopChecks = proofDaemonStopChecks(brainKind, stopResult);
        runtimeChecks.push(...stopChecks);
        for (const check of stopChecks.filter((candidate) => !candidate.pass)) {
          console.log(`  ❌ ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
        }
      } catch (error) {
        // `stop()` is designed to return failures, but keep this final guard so a
        // teardown regression cannot erase the otherwise-complete proof report.
        runtimeChecks.push({
          name: `${brainKind} daemon teardown completed with reportable evidence`,
          pass: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  let gitHeadEnd: string | undefined;
  let sourceFingerprintEnd: string | undefined;
  let sourceCleanAtEnd = false;
  try {
    gitHeadEnd = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    }).trim();
    sourceFingerprintEnd = fingerprintProofSourceFromGit({
      repoRoot: REPO_ROOT,
      gitHead: gitHeadEnd,
      sourcePaths: PROOF_SOURCE_PATHS,
    });
    sourceCleanAtEnd = execFileSync(
      'git',
      ['status', '--porcelain', '--untracked-files=all', '--', ...PROOF_SOURCE_PATHS],
      { cwd: REPO_ROOT, encoding: 'utf-8' },
    ).trim().length === 0;
  } catch { /* the pure stability decision below fails closed */ }
  const sourceStability = evaluateProofSourceStability({
    sourceFingerprintStart: sourceFingerprint,
    sourceFingerprintEnd,
    sourceCleanAtStart: sourceClean,
    sourceCleanAtEnd,
  });
  sourceClean = sourceStability.sourceClean;
  let runtimeFingerprintEnd: string | undefined;
  try {
    runtimeFingerprintEnd = pinnedRuntime
      ? sha256Directory(path.join(pinnedRuntime.treeRoot, 'dist'))
      : sha256Directory(path.join(REPO_ROOT, 'dist'));
  } catch { /* fail closed below */ }
  const runtimeArtifactStable: Check = {
    name: 'runtime artifact remained byte-identical through live execution',
    pass: runtimeFingerprintEnd === runtimeFingerprintStart,
    detail: `start=${runtimeFingerprintStart} end=${runtimeFingerprintEnd ?? '(unavailable)'}`,
  };
  const reportChecks = [sourceStability.check, runtimeArtifactStable, ...runtimeChecks];
  const failures = outcomes.filter((o) => o.status === 'FAIL').length
    + reportChecks.filter((check) => !check.pass).length;
  const benchmark = benchmarkRequest
    ? proofBenchmarkMetadata(benchmarkRequest, {
        fusionMode,
        scenarios: scenarios.map((scenario) => ({
          name: scenario.name,
          inputs: scenario.benchmarkWorkload,
        })),
      })
    : undefined;
  const report: ProofReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    gitHead,
    ...(gitHeadEnd ? { gitHeadEnd } : {}),
    sourceFingerprint,
    ...(sourceStability.sourceFingerprintEnd
      ? { sourceFingerprintEnd: sourceStability.sourceFingerprintEnd }
      : {}),
    sourceStable: sourceStability.sourceStable,
    sourceClean,
    runtimeFingerprint: runtimeFingerprintStart,
    runtimeGitSha: pinnedRuntime?.gitSha ?? gitHead,
    runtimeLabel: pinnedRuntime?.label ?? 'working-tree',
    fusionMode,
    ...(benchmark ? { benchmark } : {}),
    reportChecks,
    outcomes,
    failures,
  };
  const reportPaths = writeProofReportFiles({ report, outputRoot: REPO_ROOT });
  printScoreboard(outcomes);
  for (const check of reportChecks.filter((candidate) => !candidate.pass)) {
    console.log(`❌ report × ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
  }
  console.log(`\nreport: ${reportPaths.latestPath}`);
  console.log(`archive: ${reportPaths.archivePath}`);
  if (!sourceClean) console.warn(`\n${DIRTY_DEV_EVIDENCE_BANNER}`);
  console.log(failures === 0 ? '✅ proof green' : `❌ ${failures} failure(s)`);
  process.exit(failures);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
