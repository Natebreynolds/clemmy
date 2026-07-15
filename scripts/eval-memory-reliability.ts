/**
 * Memory reliability release gate.
 *
 * Runs the LongMemEval-aligned Clementine corpus against an isolated local
 * SQLite/vault home. The command is strict by default: every scenario must pass
 * every trial. It never reads or mutates the user's live memory database.
 *
 * Run: npm run eval:memory
 *      npm run eval:memory -- --k=5
 *      npm run eval:memory -- --json=/tmp/memory-eval.json
 *      npm run eval:memory -- --informational
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

const k = Math.max(1, Number.parseInt(argValue('k') ?? process.env.MEMORY_EVAL_K ?? '3', 10) || 3);
const strict = !process.argv.includes('--informational');
const jsonPath = argValue('json');
const testHome = mkdtempSync(path.join(tmpdir(), 'clementine-memory-eval-'));

process.env.CLEMENTINE_HOME = testHome;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
delete process.env.OPENAI_API_KEY;

const [{ openMemoryDb, resetMemoryDb }, { runEvalSuite }, corpus] = await Promise.all([
  import('../src/memory/db.js'),
  import('../src/runtime/eval/eval-case.js'),
  import('../src/runtime/eval/memory-reliability-corpus.js'),
]);

try {
  mkdirSync(testHome, { recursive: true });
  const reset = (): void => { resetMemoryDb(); openMemoryDb(); };
  const cases = corpus.buildAllMemoryReliabilityEvalCases(reset);
  const report = await runEvalSuite(cases, { k });
  const byDimension = new Map<string, { cases: number; passed: number }>();
  for (const result of report.cases) {
    const dimension = result.label?.replace(/^memory:/, '') ?? 'unknown';
    const value = byDimension.get(dimension) ?? { cases: 0, passed: 0 };
    value.cases += 1;
    value.passed += result.passHatK ? 1 : 0;
    byDimension.set(dimension, value);
  }
  const casePassed = (id: string): number => report.cases.find((result) => result.id === id)?.passHatK ? 1 : 0;
  const rateFor = (...ids: string[]): number => ids.reduce((sum, id) => sum + casePassed(id), 0) / Math.max(1, ids.length);
  const metrics = {
    tailRecallRate: rateFor('memory-direct-tail-token'),
    // The fixture verifies the target is ranked >500. The former prefilter's
    // eligibility is therefore deterministically zero for this same query.
    formerTop500TailEligibilityRate: 0,
    temporalUpdateAccuracy: rateFor(
      'memory-temporal-before-correction',
      'memory-current-after-correction',
      'memory-general-episode-yesterday',
    ),
    abstentionAccuracy: rateFor('memory-unsupported-question-abstains'),
    sourceAttributionAccuracy: rateFor('memory-source-attribution-survives'),
    constraintComplianceRate: rateFor('memory-hard-constraint-policy', 'memory-user-corrects-pinned-policy'),
    storedGraphTraversalRate: rateFor('memory-stored-graph-hop', 'memory-fact-outward-graph-pack'),
    recordedInPersonMeetingRecallRate: rateFor('memory-in-person-meeting-today'),
    meetingClaimLifecycleRate: rateFor('memory-meeting-claim-review-to-recall'),
    knownClaimEvidenceReconciliationRate: rateFor('memory-known-claim-auto-attaches-evidence'),
    factDeduplicationRate: rateFor('memory-exact-fact-reinforcement'),
    reflectionReplaySafetyRate: rateFor('memory-tool-reflection-exactly-once'),
    autoCaptureReplaySafetyRate: rateFor('memory-auto-capture-survives-restart'),
    transientIntakeRejectionRate: rateFor('memory-one-off-request-stays-ephemeral'),
    identityResolutionSafetyRate: rateFor(
      'memory-stable-email-converges-person',
      'memory-ambiguous-people-stay-distinct',
      'memory-user-statement-canonical-person-graph',
    ),
    resourceGroundingPrecisionRate: rateFor('memory-resource-grounding-precision'),
    reviewedMergeIntegrityRate: rateFor('memory-reviewed-merge-preserves-provenance'),
    observationReplaySafetyRate: rateFor('memory-entity-observation-replay-safe'),
    relationshipReplaySafetyRate: rateFor('memory-relationship-evidence-replay-safe'),
  };

  console.log(`\n  Clementine memory reliability — ${cases.length} scenarios × k=${k} trials`);
  console.log('  Isolated database: yes · live memory touched: no · acceptance: 100% pass^k\n');
  console.log('  ' + pad('SCENARIO', 46) + pad('DIMENSION', 28) + pad('PASSES', 10) + 'RESULT');
  console.log('  ' + '-'.repeat(94));
  for (const result of report.cases) {
    console.log('  ' + pad(result.id, 46)
      + pad(result.label?.replace(/^memory:/, '') ?? '', 28)
      + pad(`${result.passes}/${result.trials}`, 10)
      + (result.passHatK ? '✓' : `✗ ${result.firstFailDetail ?? ''}`));
  }
  console.log('  ' + '-'.repeat(94));
  for (const [dimension, value] of byDimension) {
    console.log(`  ${pad(dimension, 31)} ${value.passed}/${value.cases} release scenarios passed`);
  }
  console.log('\n  Acceptance metrics');
  console.log(`  tail recall                         ${percentage(metrics.tailRecallRate)} (former top-500 eligibility ${percentage(metrics.formerTop500TailEligibilityRate)})`);
  console.log(`  temporal update accuracy            ${percentage(metrics.temporalUpdateAccuracy)}`);
  console.log(`  abstention accuracy                  ${percentage(metrics.abstentionAccuracy)}`);
  console.log(`  durable source attribution          ${percentage(metrics.sourceAttributionAccuracy)}`);
  console.log(`  deterministic constraint compliance ${percentage(metrics.constraintComplianceRate)}`);
  console.log(`  stored graph traversal              ${percentage(metrics.storedGraphTraversalRate)}`);
  console.log(`  recorded in-person meeting recall   ${percentage(metrics.recordedInPersonMeetingRecallRate)}`);
  console.log(`  meeting claim review → recall        ${percentage(metrics.meetingClaimLifecycleRate)}`);
  console.log(`  known-claim evidence reconciliation  ${percentage(metrics.knownClaimEvidenceReconciliationRate)}`);
  console.log(`  exact fact deduplication             ${percentage(metrics.factDeduplicationRate)}`);
  console.log(`  tool-reflection replay safety        ${percentage(metrics.reflectionReplaySafetyRate)}`);
  console.log(`  automatic-capture replay safety      ${percentage(metrics.autoCaptureReplaySafetyRate)}`);
  console.log(`  one-off request rejection            ${percentage(metrics.transientIntakeRejectionRate)}`);
  console.log(`  person identity resolution safety    ${percentage(metrics.identityResolutionSafetyRate)}`);
  console.log(`  evidence-grounded resource precision ${percentage(metrics.resourceGroundingPrecisionRate)}`);
  console.log(`  reviewed duplicate merge integrity   ${percentage(metrics.reviewedMergeIntegrityRate)}`);
  console.log(`  entity observation replay safety     ${percentage(metrics.observationReplaySafetyRate)}`);
  console.log(`  relationship replay safety           ${percentage(metrics.relationshipReplaySafetyRate)}`);
  console.log(`\n  pass@k ${percentage(report.passAtKRate)} · pass^k ${percentage(report.passHatKRate)}\n`);

  const output = {
    generatedAt: new Date().toISOString(),
    isolated: true,
    k,
    acceptanceThreshold: 1,
    accepted: report.passHatKRate === 1,
    scenarioCount: cases.length,
    dimensions: Object.fromEntries(byDimension),
    metrics,
    report,
  };
  if (jsonPath) {
    const target = path.resolve(jsonPath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`, 'utf-8');
    console.log(`  JSON report: ${target}\n`);
  }

  if (report.passHatKRate !== 1) {
    console.error(`  Memory release gate ${strict ? 'failed' : 'is below threshold'}: ${percentage(report.passHatKRate)} < 100%.\n`);
    if (strict) process.exitCode = 1;
  } else {
    console.log('  ✓ Memory reliability release gate passed.\n');
  }
} finally {
  resetMemoryDb();
  rmSync(testHome, { recursive: true, force: true });
}
