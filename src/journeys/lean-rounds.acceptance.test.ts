/**
 * Run: node scripts/run-tests-isolated.mjs src/journeys/lean-rounds.acceptance.test.ts
 *
 * The Lean Rounds instrument. Five requests, each under four Jev arms, run
 * through the exported channel runner -> bridge -> runConversation ->
 * production host (lean-rounds.case.fixture.ts, one fresh isolated home and
 * process per case). The model wire is an evidence-seeking scripted model
 * that may call only names visible on its request, in the catalog index, or
 * disclosed by tool_search (lean-rounds-support.fixture.ts). Surface
 * building, catalog index, carriers, result budgets, readers, provenance,
 * composition and the usage ledger are production.
 *
 * Scenarios:
 *   a  saved-work lookup: a static Workspace saved by space_save, ~10,500
 *      characters, with the answer planted in its middle, past char 4,000;
 *   b  heartbeat edit: add an owner rule to the work-review heartbeat;
 *   c  a provider read whose result crosses the business carrier, with the
 *      answer in the payload's tail;
 *   d  a calendar read with planted events;
 *   e  a no-signal control ("the thing from earlier"): every tool its baseline
 *      round 1 carried stays reachable that round, under the desk owner's
 *      no-signal rule (NO_TARGET_STARTS_LEAN in agents/turn-desk.ts);
 *   f  the calendar read again, after the same request already ran once in
 *      another conversation, so remembered runs and proven operations exist.
 * Jev arms: off with no key; key present but the System One wire hangs until
 * the caller's timeout; key present but it answers HTTP 500; scripted answers.
 *
 * Each case is read back by scripts/score-turn-rounds.mts, the scorer used on
 * the live home, and records rounds, round-1 bytes by provenance layer and by
 * composition bucket, whole-turn request bytes, and the round-1 wire tools.
 *
 * RATCHET: lean-rounds.baseline.json holds the measured baseline. A case
 * fails when it needs more rounds than its baseline, or when round-1 or
 * whole-turn request bytes exceed byteCeiling() (baseline + 1% + 64 bytes,
 * room for dates and ids that vary in length). A case that improves passes
 * and prints the figure to copy into the baseline. Set
 * LEAN_ROUNDS_WRITE_BASELINE=/abs/path.json to write the measured table as a
 * candidate baseline file.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BYTE_TOLERANCE_ABSOLUTE,
  BYTE_TOLERANCE_FRACTION,
  JEV_ARMS,
  byteCeiling,
  formatMetricsTable,
  type BaselineEntry,
  type CaseMetrics,
  type JevArm,
  type ScenarioId,
} from './lean-rounds-support.fixture.js';
import { NO_TARGET_STARTS_LEAN } from '../agents/turn-desk.js';
import { deskDeclarationFor } from '../tools/tool-registry.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CASE_FIXTURE = path.join(repoRoot, 'src/journeys/lean-rounds.case.fixture.ts');
const BASELINE_PATH = path.join(repoRoot, 'src/journeys/lean-rounds.baseline.json');
const SCENARIOS: readonly ScenarioId[] = [
  'a_saved_work_lookup',
  'b_heartbeat_edit',
  'c_provider_carrier_read',
  'd_calendar_read',
  'e_no_signal_control',
  'f_calendar_read_warm',
];
const CONCURRENCY = 4;
const CASE_TIMEOUT_MS = 180_000;

interface CaseOutcome {
  scenario: ScenarioId;
  arm: JevArm;
  metrics: CaseMetrics | null;
  failure: string | null;
}

function runCase(scenario: ScenarioId, arm: JevArm): Promise<CaseOutcome> {
  const home = mkdtempSync(path.join(os.tmpdir(), `clem-lean-rounds-${scenario.slice(0, 1)}-${arm}-`));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CASE_FIXTURE, scenario, arm], {
      cwd: repoRoot,
      env: { ...process.env, CLEMENTINE_HOME: home, CLEMMY_TEST_ISOLATED_HOME: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => child.kill('SIGKILL'), CASE_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      rmSync(home, { recursive: true, force: true });
      const line = stdout.split('\n').find((entry) => entry.startsWith('LEAN_ROUNDS_CASE_RESULT '));
      if (code === 0 && line) {
        resolve({ scenario, arm, metrics: JSON.parse(line.slice('LEAN_ROUNDS_CASE_RESULT '.length)) as CaseMetrics, failure: null });
        return;
      }
      const tail = (text: string) => text.split('\n').filter((entry) => !entry.startsWith('{"level"')).slice(-40).join('\n');
      resolve({ scenario, arm, metrics: null, failure: `exit ${code}\n${tail(stderr)}\n${tail(stdout)}` });
    });
  });
}

async function runAll(): Promise<CaseOutcome[]> {
  const queue = SCENARIOS.flatMap((scenario) => JEV_ARMS.map((arm) => ({ scenario, arm })));
  const outcomes: CaseOutcome[] = [];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      outcomes.push(await runCase(next.scenario, next.arm));
    }
  });
  await Promise.all(workers);
  const order = (outcome: CaseOutcome) => SCENARIOS.indexOf(outcome.scenario) * 10 + JEV_ARMS.indexOf(outcome.arm);
  return outcomes.sort((left, right) => order(left) - order(right));
}

test('Lean Rounds acceptance: rounds and round-1 bytes per scenario and Jev arm, ratcheted', { timeout: 900_000 }, async (t) => {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as {
    tolerance: { fraction: number; absoluteBytes: number };
    cases: Record<string, BaselineEntry>;
  };
  assert.deepEqual(baseline.tolerance, { fraction: BYTE_TOLERANCE_FRACTION, absoluteBytes: BYTE_TOLERANCE_ABSOLUTE },
    'the baseline file states the tolerance the ratchet applies');
  const outcomes = await runAll();
  const rows = outcomes.flatMap((outcome) => (outcome.metrics ? [outcome.metrics] : []));

  console.log(`\nLEAN ROUNDS METRICS\n${formatMetricsTable(rows)}\n`);
  for (const row of rows) {
    console.log(`${row.scenario}/${row.arm} r1 buckets(est. tokens) ${JSON.stringify(row.round1BucketTokens)}`);
    console.log(`${row.scenario}/${row.arm} r1 wire tools ${row.round1WireTools.join(',')}`);
    console.log(`${row.scenario}/${row.arm} r1 on-request tools ${row.round1OnRequestTools.join(',') || '-'}`);
  }
  if (process.env.LEAN_ROUNDS_WRITE_BASELINE) {
    writeFileSync(process.env.LEAN_ROUNDS_WRITE_BASELINE, `${JSON.stringify({
      tolerance: { fraction: BYTE_TOLERANCE_FRACTION, absoluteBytes: BYTE_TOLERANCE_ABSOLUTE },
      cases: Object.fromEntries(rows.map((row) => [`${row.scenario}/${row.arm}`, {
        rounds: row.rounds,
        round1Bytes: row.round1Bytes,
        totalRequestBytes: row.totalRequestBytes,
        round1WireTools: row.round1WireTools,
        round1OnRequestTools: row.round1OnRequestTools,
      }])),
    }, null, 2)}\n`);
  }

  const improvements: string[] = [];
  for (const outcome of outcomes) {
    const key = `${outcome.scenario}/${outcome.arm}`;
    await t.test(key, () => {
      assert.equal(outcome.failure, null, `${key} did not complete:\n${outcome.failure}`);
      const m = outcome.metrics!;
      const base = baseline.cases[key];
      assert.ok(base, `${key}: no baseline entry`);
      assert.ok(m.rounds <= base.rounds, `${key}: rounds ${m.rounds} > baseline ${base.rounds}`);
      assert.ok(m.round1Bytes <= byteCeiling(base.round1Bytes),
        `${key}: round-1 bytes ${m.round1Bytes} > ceiling ${byteCeiling(base.round1Bytes)} (baseline ${base.round1Bytes})`);
      assert.ok(m.totalRequestBytes <= byteCeiling(base.totalRequestBytes),
        `${key}: turn bytes ${m.totalRequestBytes} > ceiling ${byteCeiling(base.totalRequestBytes)} (baseline ${base.totalRequestBytes})`);
      if (m.arm === 'jev_off') assert.equal(m.jevRouterRows, 0, `${key}: Jev off writes no router rows`);
      if (m.rounds < base.rounds
        || m.round1Bytes < base.round1Bytes * (1 - BYTE_TOLERANCE_FRACTION) - BYTE_TOLERANCE_ABSOLUTE
        || m.totalRequestBytes < base.totalRequestBytes * (1 - BYTE_TOLERANCE_FRACTION) - BYTE_TOLERANCE_ABSOLUTE) {
        improvements.push(`${key}: rounds ${base.rounds}->${m.rounds}, round-1 bytes ${base.round1Bytes}->${m.round1Bytes}, turn bytes ${base.totalRequestBytes}->${m.totalRequestBytes}`);
      }
    });
  }
  if (improvements.length) console.log(`IMPROVED; tighten lean-rounds.baseline.json:\n${improvements.join('\n')}`);

  await t.test('Jev off, hanging and failing give one round-1 surface per scenario', () => {
    // The no-Jev floor: an outage must neither change nor stall the surface
    // a user without Jev gets.
    for (const scenario of SCENARIOS) {
      const floor = rows.filter((row) => row.scenario === scenario && row.arm !== 'jev_scripted');
      assert.equal(floor.length, 3, `${scenario}: all three floor arms completed`);
      assert.equal(new Set(floor.map((row) => row.round1WireTools.join(','))).size, 1,
        `${scenario}: round-1 wire tools differ across Jev off / hang / 500`);
      assert.equal(new Set(floor.map((row) => row.round1Bytes)).size, 1,
        `${scenario}: round-1 bytes differ across Jev off / hang / 500`);
    }
  });

  // The no-signal rule is the desk owner's constant. With "no evidence ->
  // full" every baseline round-1 tool rides the control's wire. With "nothing
  // becomes unreachable" each one is on the wire or deferred by a desk
  // declaration and named on the names-only line; its exact-name tool_search
  // schema and its call_tool handler are pinned for every desk-declared tool
  // in src/runtime/harness/turn-desk-reachability.integration.test.ts.
  const controlBaseline = baseline.cases['e_no_signal_control/jev_off'];
  const controlTools = [...(controlBaseline?.round1WireTools ?? []), ...(controlBaseline?.round1OnRequestTools ?? [])];
  if (!NO_TARGET_STARTS_LEAN) {
    await t.test('the no-signal control keeps every baseline round-1 tool under every arm', () => {
      assert.ok(controlTools.length > 0, 'the control baseline names its round-1 tools');
      for (const row of rows.filter((entry) => entry.scenario === 'e_no_signal_control')) {
        assert.deepEqual(controlTools.filter((name) => !row.round1WireTools.includes(name)), [],
          `${row.arm}: the no-signal control lost a round-1 tool`);
      }
    });
  } else {
    await t.test('the no-signal control keeps every baseline round-1 tool reachable under every arm', () => {
      assert.ok(controlTools.length > 0, 'the control baseline names its round-1 tools');
      for (const row of rows.filter((entry) => entry.scenario === 'e_no_signal_control')) {
        const unreachable = controlTools.filter((name) => !row.round1WireTools.includes(name)
          && !(row.round1OnRequestTools.includes(name) && deskDeclarationFor(name) !== null));
        assert.deepEqual(unreachable, [],
          `${row.arm}: a baseline round-1 tool is neither on the wire nor a desk tool named on the names-only line`);
      }
    });
  }
});
